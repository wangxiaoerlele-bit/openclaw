import type { CliDeps } from "../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent/run.js";
import type { CronJob } from "../cron/types.js";
import { CommandLane } from "../process/lanes.js";
import { isLowSignalExecutionUpdate } from "./commitment.js";
import type { TaskRecord, TaskRunResult, TaskRunResultStatus } from "./types.js";

const TASK_STATUS_RE = /^TASK_STATUS:\s*(.+)$/im;
const TASK_UPDATE_RE = /^TASK_UPDATE:\s*(.+)$/im;
const TASK_BLOCKER_RE = /^TASK_BLOCKER:\s*(.+)$/im;

function normalizeStatus(raw?: string): TaskRunResultStatus | null {
  const normalized = raw?.trim().toLowerCase();
  if (
    normalized === "progress" ||
    normalized === "waiting_external" ||
    normalized === "waiting_approval" ||
    normalized === "completed" ||
    normalized === "failed"
  ) {
    return normalized;
  }
  return null;
}

function parseEvidence(text?: string): string[] {
  if (!text) {
    return [];
  }
  const markerIndex = text.search(/^TASK_EVIDENCE:\s*$/im);
  if (markerIndex < 0) {
    return [];
  }
  const lines = text
    .slice(markerIndex)
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
  return lines.slice(0, 5);
}

function parseTaskWorkerOutput(text?: string): {
  status: TaskRunResultStatus | null;
  update?: string;
  blocker?: string;
  evidence: string[];
} {
  const raw = text?.trim();
  if (!raw) {
    return { status: null, evidence: [] };
  }
  const status = normalizeStatus(raw.match(TASK_STATUS_RE)?.[1]);
  const update = raw.match(TASK_UPDATE_RE)?.[1]?.trim();
  const blocker = raw.match(TASK_BLOCKER_RE)?.[1]?.trim();
  return {
    status,
    update,
    blocker,
    evidence: parseEvidence(raw),
  };
}

function buildTaskWorkerMessage(task: TaskRecord): string {
  const acceptance = task.acceptance.map((item) => `- ${item}`).join("\n");
  const evidence = task.evidence
    .slice(-5)
    .map((item) => `- ${item.text}`)
    .join("\n");
  return [
    "Continue this durable task. This is execution time, not a planning-only check-in.",
    "",
    `Task ID: ${task.taskId}`,
    `Title: ${task.title}`,
    `Goal: ${task.goal}`,
    `Current status: ${task.status}`,
    "",
    "Acceptance criteria:",
    acceptance || "- Produce concrete progress, a clear blocker, or completion evidence.",
    "",
    task.blocker ? `Current blocker: ${task.blocker}` : "Current blocker: none",
    evidence ? `Recent evidence:\n${evidence}` : "Recent evidence: none yet",
    "",
    "Rules:",
    "- Do one concrete step before you answer unless the task is blocked or completed.",
    "- Use tools when needed.",
    '- Do not answer with empty promises like "I will keep working".',
    "- End your response with this exact machine-readable footer:",
    "TASK_STATUS: progress|waiting_external|waiting_approval|completed|failed",
    "TASK_UPDATE: <one factual sentence>",
    "TASK_BLOCKER: <short blocker or none>",
    "TASK_EVIDENCE:",
    "- <fact or artifact>",
  ].join("\n");
}

export async function runTaskWorkerTurn(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  task: TaskRecord;
}): Promise<TaskRunResult> {
  const now = Date.now();
  const job: CronJob = {
    id: `task-${params.task.taskId}`,
    agentId: params.task.agentId,
    sessionKey: params.task.workerSessionKey,
    name: `Task ${params.task.title}`,
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "agentTurn",
      message: buildTaskWorkerMessage(params.task),
      deliver: false,
      lightContext: true,
    },
    delivery: { mode: "none" },
    state: {},
  };

  const result = await runCronIsolatedAgentTurn({
    cfg: params.cfg,
    deps: params.deps,
    job,
    message: buildTaskWorkerMessage(params.task),
    sessionKey: params.task.workerSessionKey,
    agentId: params.task.agentId,
    lane: CommandLane.Task,
  });

  const parsed = parseTaskWorkerOutput(result.outputText);
  const sideEffects = result.successfulMutatingToolCalls ?? 0;
  const parsedStatus = parsed.status;

  if (parsedStatus) {
    return {
      status: parsedStatus,
      update: parsed.update,
      blocker: parsed.blocker,
      evidence: parsed.evidence,
      sideEffects,
      rawOutput: result.outputText,
    };
  }

  const fallbackUpdate = result.outputText?.trim();
  if (!fallbackUpdate) {
    return { status: "progress", update: undefined, blocker: undefined, evidence: [], sideEffects };
  }
  if (sideEffects === 0 && isLowSignalExecutionUpdate(fallbackUpdate)) {
    return {
      status: "progress",
      update: fallbackUpdate,
      blocker: undefined,
      evidence: [],
      sideEffects,
    };
  }
  return {
    status: "progress",
    update: fallbackUpdate,
    blocker: undefined,
    evidence: [],
    sideEffects,
    rawOutput: result.outputText,
  };
}
