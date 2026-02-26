import path from "node:path";
import { emitAgentEvent } from "../infra/agent-events.js";
import { runPersonalMemoryGc } from "./gc.js";
import { archivePersonalMemoryRuntimeEpisodic } from "./runtime-archive.js";
import {
  exportPersonalMemoryRuntimeBundle,
  importPersonalMemoryRuntimeBundle,
  syncPersonalMemoryRuntimeBundle,
} from "./runtime-share.js";
import {
  buildPersonalMemoryPreSessionContext,
  suggestPostSessionMemoryWrite,
} from "./session-flow.js";
import {
  resolvePersonalMemoryChannelPolicy,
  resolvePersonalMemoryRuntimeGcPolicy,
  resolvePersonalMemoryRuntimeSyncPolicy,
} from "./settings.js";
import { FileBackedPersonalMemoryStore } from "./store.js";
import { enqueuePersonalMemorySuggestion } from "./suggestion-queue.js";
import type {
  PersonalMemoryChannel,
  PersonalMemoryPostSessionInput,
  PersonalMemoryPreSessionContext,
  PersonalMemoryTaskKind,
  PersonalMemoryWriteSuggestion,
} from "./types.js";

type LoggerLike = {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

type PersonalMemoryPreHookRequest = {
  runId: string;
  sessionKey: string;
  messageText: string;
  bodyForAgent: string;
  personalContextDir?: string;
  channel: PersonalMemoryChannel;
  logger?: LoggerLike;
  taskKind?: PersonalMemoryTaskKind;
  promptLabel?: string;
};

type PersonalMemoryPreHookResult = {
  bodyForAgent: string;
  pre?: PersonalMemoryPreSessionContext;
};

type PersonalMemoryPostHookRequest = {
  runId: string;
  sessionKey: string;
  input: PersonalMemoryPostSessionInput;
  personalContextDir?: string;
  logger?: LoggerLike;
};

export type PersonalMemoryPostHookResult = {
  suggestion: PersonalMemoryWriteSuggestion;
  queueId?: string;
  commitCommand?: string;
};

const storeByDir = new Map<string, FileBackedPersonalMemoryStore>();
const autoGcLastRunAtByDir = new Map<string, number>();
const autoSyncLastRunAtByDirAndPhase = new Map<string, number>();

function getOrCreateStore(personalContextDir: string): FileBackedPersonalMemoryStore {
  const resolved = path.resolve(personalContextDir);
  const existing = storeByDir.get(resolved);
  if (existing) {
    return existing;
  }
  const store = new FileBackedPersonalMemoryStore({ personalContextDir: resolved });
  storeByDir.set(resolved, store);
  return store;
}

function maybeRunPersonalMemoryAutoGc(params: {
  personalContextDir?: string;
  logger?: LoggerLike;
}) {
  if (!params.personalContextDir) {
    return;
  }
  const dir = path.resolve(params.personalContextDir);
  const policy = resolvePersonalMemoryRuntimeGcPolicy(dir);
  if (!policy.enabled || !policy.runOnPostHook) {
    return;
  }
  const nowMs = Date.now();
  const minIntervalMs = policy.minIntervalMinutes * 60 * 1000;
  const last = autoGcLastRunAtByDir.get(dir) ?? 0;
  if (nowMs - last < minIntervalMs) {
    return;
  }
  try {
    let archivedCount = 0;
    if ((policy.archiveRuntimeEpisodicDays ?? 0) > 0) {
      const archive = archivePersonalMemoryRuntimeEpisodic({
        personalContextDir: dir,
        retainDays: policy.archiveRuntimeEpisodicDays,
      });
      archivedCount = archive.archivedAdded;
    }
    const result = runPersonalMemoryGc({
      personalContextDir: dir,
      policy,
    });
    autoGcLastRunAtByDir.set(dir, nowMs);
    const runtimeRemoved =
      result.runtime.beforeWorking -
      result.runtime.afterWorking +
      (result.runtime.beforeEpisodic - result.runtime.afterEpisodic);
    const queueRemoved = result.suggestions.removed;
    const line = `personal-memory auto-gc: runtimeArchived=${archivedCount} runtimeRemoved=${runtimeRemoved} queueRemoved=${queueRemoved}`;
    if (archivedCount > 0 || runtimeRemoved > 0 || queueRemoved > 0) {
      params.logger?.info?.(line);
    } else {
      params.logger?.debug?.(line);
    }
  } catch (err) {
    params.logger?.warn?.(
      `personal-memory auto-gc failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function maybeRunPersonalMemoryAutoSync(params: {
  personalContextDir?: string;
  logger?: LoggerLike;
  phase: "pre" | "post";
  channel?: PersonalMemoryChannel;
}) {
  if (!params.personalContextDir) {
    return;
  }
  const dir = path.resolve(params.personalContextDir);
  const policy = resolvePersonalMemoryRuntimeSyncPolicy(dir);
  const enabledForPhase = params.phase === "pre" ? policy.runOnPreHook : policy.runOnPostHook;
  if (!policy.enabled || !enabledForPhase) {
    return;
  }
  if (policy.channels && policy.channels.length > 0 && params.channel) {
    if (!policy.channels.includes(params.channel)) {
      return;
    }
  }
  const mode =
    params.phase === "pre" ? (policy.preMode ?? policy.mode) : (policy.postMode ?? policy.mode);
  const nowMs = Date.now();
  const phaseMinIntervalMinutes =
    params.phase === "pre"
      ? (policy.preMinIntervalMinutes ?? policy.minIntervalMinutes)
      : (policy.postMinIntervalMinutes ?? policy.minIntervalMinutes);
  const minIntervalMs = phaseMinIntervalMinutes * 60 * 1000;
  const throttleKey = `${dir}::${params.phase}`;
  const last = autoSyncLastRunAtByDirAndPhase.get(throttleKey) ?? 0;
  if (nowMs - last < minIntervalMs) {
    return;
  }
  try {
    if (mode === "sync") {
      const result = syncPersonalMemoryRuntimeBundle({
        personalContextDir: dir,
        bundleFile: policy.bundleFile,
        includeWorking: policy.includeWorking,
        maxEpisodic: policy.maxEpisodic,
        conflictStrategy: policy.conflictStrategy,
        auditConflicts: policy.auditConflicts,
        auditFile: policy.auditFile,
      });
      autoSyncLastRunAtByDirAndPhase.set(throttleKey, nowMs);
      params.logger?.info?.(
        `personal-memory auto-sync: phase=${params.phase} mode=sync strategy=${policy.conflictStrategy} bundle=${path.basename(result.bundleFilePath)} working=${result.exportedWorking} episodic=${result.exportedEpisodic} beforeWorking=${result.beforeWorking} beforeEpisodic=${result.beforeEpisodic} conflicts=${result.conflictTotal}`,
      );
    } else if (mode === "import") {
      const result = importPersonalMemoryRuntimeBundle({
        personalContextDir: dir,
        bundleFile: policy.bundleFile,
        includeWorking: policy.includeWorking,
        maxEpisodic: policy.maxEpisodic,
        conflictStrategy: policy.conflictStrategy,
        auditConflicts: policy.auditConflicts,
        auditFile: policy.auditFile,
      });
      autoSyncLastRunAtByDirAndPhase.set(throttleKey, nowMs);
      params.logger?.info?.(
        `personal-memory auto-sync: phase=${params.phase} mode=import strategy=${policy.conflictStrategy} bundle=${path.basename(result.bundleFilePath)} working=${result.afterWorking} episodic=${result.afterEpisodic} beforeWorking=${result.beforeWorking} beforeEpisodic=${result.beforeEpisodic} conflicts=${result.conflictTotal}`,
      );
    } else {
      const result = exportPersonalMemoryRuntimeBundle({
        personalContextDir: dir,
        bundleFile: policy.bundleFile,
        includeWorking: policy.includeWorking,
        maxEpisodic: policy.maxEpisodic,
      });
      autoSyncLastRunAtByDirAndPhase.set(throttleKey, nowMs);
      params.logger?.info?.(
        `personal-memory auto-sync: phase=${params.phase} mode=export bundle=${path.basename(result.bundleFilePath)} working=${result.exportedWorking} episodic=${result.exportedEpisodic}`,
      );
    }
  } catch (err) {
    params.logger?.warn?.(
      `personal-memory auto-sync failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function inferPersonalMemoryTaskKindFromText(text: string): PersonalMemoryTaskKind {
  const t = text.trim().toLowerCase();
  if (!t) {
    return "unknown";
  }
  if (/(复盘|决策|方案|取舍|为什么这样做|review|tradeoff|decision)/i.test(text)) {
    return "decision-review";
  }
  if (/(规划|计划|roadmap|优先级|下一步|本周)/i.test(text)) {
    return "planning";
  }
  if (/(项目|代码|仓库|bug|实现|重构|接口|模块|方案设计)/i.test(text)) {
    return "project-discussion";
  }
  return "daily-qa";
}

export function inferPersonalMemoryUserConfirmedFromText(text: string): boolean {
  const raw = text.trim();
  if (!raw) {
    return false;
  }

  // Require explicit confirmation phrases so ordinary planning messages do not become L2.
  if (
    /(我确认|确认采用|确认使用|就按这个方案|按这个方案执行|就这么定|定了|决定采用|决定使用|同意这个方案|批准执行)/.test(
      raw,
    )
  ) {
    return true;
  }

  return /\b(i confirm|confirmed|let'?s go with|go with this plan|approve this|approved|we decide to use|we decided to use)\b/i.test(
    raw,
  );
}

function workingRecordId(sessionKey: string): string {
  return `working:session:${sessionKey}`;
}

function truncateForMemory(text: string, max = 800): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}...`;
}

function visibleSearchHits(pre: PersonalMemoryPreSessionContext) {
  const selectedIds = new Set(pre.selection.selected.map((record) => record.id));
  return (pre.search?.hits ?? []).filter((hit) => !selectedIds.has(hit.id)).slice(0, 2);
}

function renderMemoryPromptEnvelope(pre: PersonalMemoryPreSessionContext): string {
  const searchHits = visibleSearchHits(pre);
  if (pre.snippets.length === 0 && searchHits.length === 0) {
    return "";
  }
  const header = [
    "[Personal Memory Context]",
    `profile=${pre.selection.profile}`,
    `selected=${pre.selection.selected.length}`,
    `usedChars=${pre.selection.usedChars}`,
    `searchHits=${searchHits.length}`,
  ].join(" ");
  const blocks: string[] = [];
  if (pre.snippets.length > 0) {
    blocks.push(pre.snippets.join("\n\n---\n\n"));
  }
  if (searchHits.length > 0) {
    const searchBlock = [
      "[Personal Memory Search Hits]",
      ...searchHits.map(
        (hit, idx) =>
          `${idx + 1}. [${hit.layer}] ${hit.title} (score=${hit.score})\n${hit.snippet}`,
      ),
    ].join("\n\n");
    blocks.push(searchBlock);
  }
  return `${header}\n\n${blocks.join("\n\n---\n\n")}`;
}

export async function maybeBuildPersonalMemoryPromptForChat(params: {
  runId: string;
  sessionKey: string;
  messageText: string;
  bodyForAgent: string;
  personalContextDir?: string;
  channel: PersonalMemoryChannel;
  logger?: LoggerLike;
}): Promise<{ bodyForAgent: string; pre?: PersonalMemoryPreSessionContext }> {
  return runPersonalMemoryPreHook(params);
}

export async function runPersonalMemoryPreHook(
  params: PersonalMemoryPreHookRequest,
): Promise<PersonalMemoryPreHookResult> {
  if (!params.personalContextDir) {
    return { bodyForAgent: params.bodyForAgent };
  }
  try {
    maybeRunPersonalMemoryAutoSync({
      personalContextDir: params.personalContextDir,
      logger: params.logger,
      phase: "pre",
      channel: params.channel,
    });
    const policy = resolvePersonalMemoryChannelPolicy({
      personalContextDir: params.personalContextDir,
      channel: params.channel,
    });
    if (!policy.enabled || !policy.preHookEnabled) {
      params.logger?.debug?.(
        `personal-memory pre skipped: channel=${params.channel} enabled=${String(policy.enabled)} preHook=${String(policy.preHookEnabled)}`,
      );
      return { bodyForAgent: params.bodyForAgent };
    }
    const store = getOrCreateStore(params.personalContextDir);
    const request = {
      channel: params.channel,
      taskKind: params.taskKind ?? inferPersonalMemoryTaskKindFromText(params.messageText),
      queryText: params.messageText,
      budget: policy.budget,
      search: {
        enabled: policy.search.enabled,
        mode: policy.search.mode,
        limit: policy.search.limit,
        layers: policy.search.layers,
        cache: policy.search.cacheEnabled,
        rerank: {
          enabled: policy.search.rerankEnabled,
          topK: policy.search.rerankTopK,
          strategy: policy.search.rerankStrategy,
        },
        backend: policy.search.backend,
        sqliteVecFile: policy.search.sqliteVecFile,
        sqliteVecExtensionPath: policy.search.sqliteVecExtensionPath,
      },
    } as const;
    const pre = await buildPersonalMemoryPreSessionContext(store, request);
    store.upsertWorkingRecord({
      id: workingRecordId(params.sessionKey),
      title: `会话进行中：${params.sessionKey}`,
      content: truncateForMemory(params.messageText),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: ["runtime", "working", params.channel, request.taskKind],
      metadata: {
        runId: params.runId,
        channel: params.channel,
        sessionKey: params.sessionKey,
        taskKind: request.taskKind,
      },
    });
    const memoryBlock = renderMemoryPromptEnvelope(pre);
    if (!memoryBlock) {
      return { bodyForAgent: params.bodyForAgent, pre };
    }
    emitAgentEvent({
      runId: params.runId,
      stream: "personal-memory",
      sessionKey: params.sessionKey,
      data: {
        phase: "pre",
        profile: pre.selection.profile,
        selectedCount: pre.selection.selected.length,
        droppedCount: pre.selection.dropped.length,
        usedChars: pre.selection.usedChars,
        searchHits: visibleSearchHits(pre).length,
      },
    });
    params.logger?.debug?.(
      `personal-memory pre: runId=${params.runId} selected=${pre.selection.selected.length} usedChars=${pre.selection.usedChars} profile=${pre.selection.profile}`,
    );
    return {
      bodyForAgent: `${memoryBlock}\n\n[${params.promptLabel ?? "Current User Message"}]\n${params.bodyForAgent}`,
      pre,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitAgentEvent({
      runId: params.runId,
      stream: "personal-memory",
      sessionKey: params.sessionKey,
      data: { phase: "pre_error", error: msg },
    });
    params.logger?.warn?.(`personal-memory pre failed: ${msg}`);
    return { bodyForAgent: params.bodyForAgent };
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildMemoryAddDecisionCommandFromSuggestion(
  suggestion: PersonalMemoryWriteSuggestion,
): string | undefined {
  if (suggestion.level !== "L2" || suggestion.target !== "decision-log" || !suggestion.structured) {
    return undefined;
  }
  const s = suggestion.structured;
  const required = ["title", "background", "decision", "reason"] as const;
  for (const key of required) {
    if (!s[key]?.trim()) {
      return undefined;
    }
  }
  const parts = [
    "pnpm memory:add-decision",
    "--date",
    shellQuote(s.date || new Date().toISOString().slice(0, 10)),
    "--title",
    shellQuote(s.title),
    "--background",
    shellQuote(s.background),
    "--decision",
    shellQuote(s.decision),
    "--reason",
    shellQuote(s.reason),
  ];
  if (s.next?.trim()) {
    parts.push("--next", shellQuote(s.next));
  }
  if (s.links?.trim()) {
    parts.push("--links", shellQuote(s.links));
  }
  return parts.join(" ");
}

export function emitPersonalMemoryPostSuggestion(params: {
  runId: string;
  sessionKey: string;
  input: PersonalMemoryPostSessionInput;
  personalContextDir?: string;
  logger?: LoggerLike;
}): PersonalMemoryWriteSuggestion {
  return runPersonalMemoryPostHook(params).suggestion;
}

export function emitPersonalMemoryPostSuggestionDetailed(params: {
  runId: string;
  sessionKey: string;
  input: PersonalMemoryPostSessionInput;
  personalContextDir?: string;
  logger?: LoggerLike;
}): PersonalMemoryPostHookResult {
  return runPersonalMemoryPostHook(params);
}

export function runPersonalMemoryPostHook(
  params: PersonalMemoryPostHookRequest,
): PersonalMemoryPostHookResult {
  let policy: ReturnType<typeof resolvePersonalMemoryChannelPolicy> | undefined;
  if (params.personalContextDir) {
    try {
      policy = resolvePersonalMemoryChannelPolicy({
        personalContextDir: params.personalContextDir,
        channel: params.input.channel,
      });
    } catch (err) {
      params.logger?.warn?.(
        `personal-memory settings failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      policy = undefined;
    }
  }
  if (params.personalContextDir) {
    try {
      const store = getOrCreateStore(params.personalContextDir);
      store.removeWorkingRecord(workingRecordId(params.sessionKey));
      if (
        (policy?.enabled ?? true) &&
        (policy?.postHookEnabled ?? true) &&
        params.input.summary.trim() &&
        params.input.taskKind !== "daily-qa"
      ) {
        store.appendEpisodicRecord({
          id: `episodic:runtime:${params.sessionKey}:${params.runId}`,
          title: `${params.input.taskKind} @ ${params.sessionKey}`,
          content: truncateForMemory(params.input.summary, 2000),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: ["runtime", "episodic", params.input.channel, params.input.taskKind],
          metadata: {
            runId: params.runId,
            sessionKey: params.sessionKey,
            channel: params.input.channel,
            taskKind: params.input.taskKind,
          },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      params.logger?.warn?.(`personal-memory runtime record failed: ${msg}`);
    }
  }
  if (policy && (!policy.enabled || !policy.postHookEnabled)) {
    const reason = !policy.enabled ? "channel disabled" : "post-hook disabled";
    const suggestion: PersonalMemoryWriteSuggestion = {
      level: "L0",
      reason: `personal-memory ${reason}; skipped post-session suggestion`,
    };
    params.logger?.debug?.(`personal-memory post skipped: ${reason}`);
    return { suggestion };
  }
  const suggestion = suggestPostSessionMemoryWrite(params.input);
  const commitCommand = buildMemoryAddDecisionCommandFromSuggestion(suggestion);
  let queueId: string | undefined;
  if (params.personalContextDir && suggestion.level !== "L0") {
    try {
      const queued = enqueuePersonalMemorySuggestion({
        personalContextDir: params.personalContextDir,
        suggestion,
        source: {
          runId: params.runId,
          sessionKey: params.sessionKey,
          channel: params.input.channel,
        },
      });
      queueId = queued.item.id;
    } catch (err) {
      params.logger?.warn?.(
        `personal-memory suggestion queue failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  emitAgentEvent({
    runId: params.runId,
    stream: "personal-memory",
    sessionKey: params.sessionKey,
    data: {
      phase: "post",
      level: suggestion.level,
      target: suggestion.target,
      reason: suggestion.reason,
      title: suggestion.title,
      commitCommand,
      queueId,
      suggestion,
    },
  });
  const line = `personal-memory post: runId=${params.runId} level=${suggestion.level} target=${suggestion.target ?? "-"} reason=${suggestion.reason}`;
  if (suggestion.level === "L0") {
    params.logger?.debug?.(line);
  } else {
    params.logger?.info?.(line);
  }
  if (commitCommand) {
    params.logger?.info?.(`personal-memory commit suggestion (L2): ${commitCommand}`);
  }
  if (queueId) {
    params.logger?.info?.(`personal-memory queued suggestion: ${queueId}`);
  }
  maybeRunPersonalMemoryAutoGc({
    personalContextDir: params.personalContextDir,
    logger: params.logger,
  });
  maybeRunPersonalMemoryAutoSync({
    personalContextDir: params.personalContextDir,
    logger: params.logger,
    phase: "post",
    channel: params.input.channel,
  });
  return { suggestion, queueId, commitCommand };
}
