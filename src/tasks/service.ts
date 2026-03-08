import { randomUUID } from "node:crypto";
import type { CliDeps } from "../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildTaskTitle } from "./commitment.js";
import {
  TASK_LEASE_TTL_MS,
  TASK_NO_PROGRESS_LIMIT,
  TASK_NO_PROGRESS_RETRY_MS,
  TASK_RUN_AGAIN_MS,
  TASK_USER_UPDATE_MIN_INTERVAL_MS,
} from "./constants.js";
import { setActiveTaskRuntime } from "./runtime.js";
import { loadTaskStore, resolveTaskStorePath, saveTaskStore, withTaskStoreLock } from "./store.js";
import type {
  TaskCreateInput,
  TaskCreateResult,
  TaskRecord,
  TaskRunResult,
  TaskStatus,
  TaskStoreFile,
} from "./types.js";
import { runTaskWorkerTurn } from "./worker.js";

type TaskServiceDeps = {
  loadConfig: () => OpenClawConfig;
  deps: CliDeps;
  storePath?: string;
  nowMs?: () => number;
};

function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function uniqueEvidence(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

export class TaskService {
  private readonly loadConfig: () => OpenClawConfig;
  private readonly deps: CliDeps;
  private readonly storePath: string;
  private readonly nowMs: () => number;
  private readonly ownerId = `task-service:${randomUUID()}`;
  private readonly log = createSubsystemLogger("tasks");
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private running = false;

  constructor(params: TaskServiceDeps) {
    this.loadConfig = params.loadConfig;
    this.deps = params.deps;
    this.storePath = resolveTaskStorePath(params.storePath);
    this.nowMs = params.nowMs ?? (() => Date.now());
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    setActiveTaskRuntime(this);
    await this.withStore(async (store) => {
      const now = this.nowMs();
      for (const task of store.tasks) {
        if (task.status === "running") {
          task.status = "queued";
          task.nextWakeAtMs = now;
        }
        task.lease = undefined;
        task.updatedAtMs = now;
      }
    });
    this.armTimer();
    this.log.info(`started store=${this.storePath}`);
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    setActiveTaskRuntime(null);
  }

  async create(input: TaskCreateInput): Promise<TaskCreateResult> {
    const created = await this.withStore(async (store) => {
      const now = this.nowMs();
      const activeBefore = store.tasks.filter(
        (task) => task.agentId === input.agentId && !isTerminalStatus(task.status),
      );
      const queuePosition = activeBefore.length + 1;
      const task: TaskRecord = {
        taskId: randomUUID(),
        agentId: input.agentId,
        originSessionKey: input.originSessionKey,
        originMessageId: input.originMessageId,
        title: input.title?.trim() || buildTaskTitle(input.goal),
        goal: input.goal.trim(),
        acceptance: uniqueEvidence(input.acceptance),
        status: "queued",
        workerSessionKey: `task:${input.agentId}:${randomUUID()}`,
        nextWakeAtMs: now,
        blocker: undefined,
        evidence: [],
        stats: {
          runCount: 0,
          sideEffectCount: 0,
          noProgressCount: 0,
        },
        createdAtMs: now,
        updatedAtMs: now,
      };
      store.tasks.push(task);
      return {
        task,
        queuePosition,
        startedImmediately: queuePosition === 1,
      } satisfies TaskCreateResult;
    });
    this.armTimer();
    return created;
  }

  async wake(taskId: string): Promise<void> {
    await this.withStore(async (store) => {
      const task = store.tasks.find((item) => item.taskId === taskId);
      if (!task || isTerminalStatus(task.status)) {
        return;
      }
      task.status = "queued";
      task.blocker = undefined;
      task.nextWakeAtMs = this.nowMs();
      task.updatedAtMs = this.nowMs();
    });
    this.armTimer();
  }

  private async withStore<T>(fn: (store: TaskStoreFile) => Promise<T> | T): Promise<T> {
    return await withTaskStoreLock(this.storePath, async () => {
      const store = await loadTaskStore(this.storePath);
      const result = await fn(store);
      await saveTaskStore(this.storePath, store);
      return result;
    });
  }

  private armTimer(): void {
    if (!this.started) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.runDueTasks();
    void this.withStore(async (store) => {
      const now = this.nowMs();
      const nextWake = this.findNextWake(store, now);
      if (nextWake == null) {
        return;
      }
      const delayMs = Math.max(0, nextWake - now);
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.runDueTasks();
      }, delayMs);
      this.timer.unref?.();
    });
  }

  private findNextWake(store: TaskStoreFile, now: number): number | null {
    let nextWake: number | null = null;
    const earliestByAgent = this.earliestNonTerminalByAgent(store);
    for (const task of store.tasks) {
      if (earliestByAgent.get(task.agentId)?.taskId !== task.taskId) {
        continue;
      }
      if (isTerminalStatus(task.status)) {
        continue;
      }
      const wakeAt = task.nextWakeAtMs ?? now;
      if (nextWake == null || wakeAt < nextWake) {
        nextWake = wakeAt;
      }
    }
    return nextWake;
  }

  private earliestNonTerminalByAgent(store: TaskStoreFile): Map<string, TaskRecord> {
    const result = new Map<string, TaskRecord>();
    const sorted = [...store.tasks].toSorted((a, b) => a.createdAtMs - b.createdAtMs);
    for (const task of sorted) {
      if (isTerminalStatus(task.status) || result.has(task.agentId)) {
        continue;
      }
      result.set(task.agentId, task);
    }
    return result;
  }

  private async runDueTasks(): Promise<void> {
    if (!this.started || this.running) {
      return;
    }
    this.running = true;
    try {
      while (this.started) {
        const claimed = await this.claimNextDueTask();
        if (!claimed) {
          break;
        }
        const result = await runTaskWorkerTurn({
          cfg: this.loadConfig(),
          deps: this.deps,
          task: claimed,
        }).catch((err) => ({
          status: "failed" as const,
          update: "Task worker run failed.",
          blocker: String(err),
          evidence: [],
          sideEffects: 0,
        }));
        await this.finishTaskTurn(claimed.taskId, result);
      }
    } finally {
      this.running = false;
      this.armTimer();
    }
  }

  private async claimNextDueTask(): Promise<TaskRecord | null> {
    return await this.withStore(async (store) => {
      const now = this.nowMs();
      const earliestByAgent = this.earliestNonTerminalByAgent(store);
      for (const task of store.tasks) {
        if (earliestByAgent.get(task.agentId)?.taskId !== task.taskId) {
          continue;
        }
        if (task.status !== "queued" && task.status !== "running") {
          continue;
        }
        if (typeof task.nextWakeAtMs === "number" && task.nextWakeAtMs > now) {
          continue;
        }
        if (task.lease && task.lease.expiresAtMs > now) {
          continue;
        }
        task.status = "running";
        task.lease = {
          owner: this.ownerId,
          acquiredAtMs: now,
          expiresAtMs: now + TASK_LEASE_TTL_MS,
        };
        task.updatedAtMs = now;
        return { ...task, evidence: [...task.evidence] };
      }
      return null;
    });
  }

  private async finishTaskTurn(taskId: string, result: TaskRunResult): Promise<void> {
    await this.withStore(async (store) => {
      const task = store.tasks.find((item) => item.taskId === taskId);
      if (!task) {
        return;
      }
      const now = this.nowMs();
      task.lease = undefined;
      task.updatedAtMs = now;
      task.stats.runCount += 1;
      const newEvidence = uniqueEvidence(result.evidence);
      const hasEvidence = newEvidence.length > 0;
      for (const item of newEvidence) {
        task.evidence.push({
          ts: now,
          text: item,
          kind: result.sideEffects > 0 ? "side_effect" : "fact",
        });
      }
      if (result.sideEffects > 0) {
        task.stats.sideEffectCount += result.sideEffects;
      }

      const hasConcreteProgress =
        result.sideEffects > 0 ||
        hasEvidence ||
        (result.status !== "progress" && result.status !== "failed");

      if (result.status === "completed") {
        task.status = "completed";
        task.blocker = undefined;
        task.nextWakeAtMs = undefined;
        task.lastActionAtMs = now;
        task.stats.noProgressCount = 0;
        this.reportTaskUpdate(task, "completed", result.update ?? "任务已完成。");
        return;
      }

      if (result.status === "failed") {
        task.status = "failed";
        task.blocker = result.blocker ?? result.update ?? "Task worker failed.";
        task.nextWakeAtMs = undefined;
        task.lastActionAtMs = now;
        task.stats.noProgressCount = 0;
        this.reportTaskUpdate(task, "failed", task.blocker);
        return;
      }

      if (result.status === "waiting_external" || result.status === "waiting_approval") {
        task.status = result.status;
        task.blocker = result.blocker ?? result.update ?? "任务等待外部条件。";
        task.nextWakeAtMs = undefined;
        task.lastActionAtMs = now;
        task.stats.noProgressCount = 0;
        this.reportTaskUpdate(
          task,
          result.status,
          result.update ?? task.blocker ?? "任务进入等待状态。",
        );
        return;
      }

      if (hasConcreteProgress) {
        task.status = "running";
        task.blocker = undefined;
        task.nextWakeAtMs = now + TASK_RUN_AGAIN_MS;
        task.lastActionAtMs = now;
        task.stats.noProgressCount = 0;
        if (result.update?.trim()) {
          this.reportTaskUpdate(task, "progress", result.update);
        }
        return;
      }

      task.stats.noProgressCount += 1;
      if (task.stats.noProgressCount >= TASK_NO_PROGRESS_LIMIT) {
        task.status = "waiting_external";
        task.blocker =
          result.blocker?.trim() ||
          "任务连续多轮没有产生可验证的新进展，已暂停并等待新的外部触发。";
        task.nextWakeAtMs = undefined;
        this.reportTaskUpdate(task, "waiting_external", task.blocker);
        return;
      }

      task.status = "running";
      task.nextWakeAtMs = now + TASK_NO_PROGRESS_RETRY_MS;
    });
  }

  private reportTaskUpdate(
    task: TaskRecord,
    kind: "progress" | "waiting_external" | "waiting_approval" | "completed" | "failed",
    summary?: string,
  ): void {
    const now = this.nowMs();
    if (
      kind === "progress" &&
      typeof task.lastUserVisibleUpdateAtMs === "number" &&
      now - task.lastUserVisibleUpdateAtMs < TASK_USER_UPDATE_MIN_INTERVAL_MS
    ) {
      return;
    }
    const label =
      kind === "completed"
        ? "完成"
        : kind === "failed"
          ? "失败"
          : kind === "waiting_external"
            ? "阻塞"
            : kind === "waiting_approval"
              ? "待审批"
              : "进展";
    const lines = [
      `[持续任务${label}] ${task.title}`,
      `状态：${kind}`,
      summary?.trim() ? `更新：${summary.trim()}` : undefined,
    ].filter(Boolean);
    enqueueSystemEvent(lines.join("\n"), {
      sessionKey: task.originSessionKey,
      contextKey: `task:${task.taskId}`,
    });
    requestHeartbeatNow({
      reason: `task:${task.taskId}:${kind}`,
      agentId: task.agentId,
      sessionKey: task.originSessionKey,
    });
    task.lastUserVisibleUpdateAtMs = now;
  }
}
