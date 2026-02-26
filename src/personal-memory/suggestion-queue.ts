import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyPersonalMemorySuggestion } from "./apply-suggestion.js";
import type { PersonalMemoryChannel, PersonalMemoryWriteSuggestion } from "./types.js";

export const PERSONAL_MEMORY_SUGGESTION_QUEUE_FILE = ".personal-memory.suggestions.json";

type QueueStatus = "pending" | "applied" | "dismissed";

export type PersonalMemorySuggestionQueueItem = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: QueueStatus;
  fingerprint: string;
  source: {
    runId?: string;
    sessionKey?: string;
    channel?: PersonalMemoryChannel;
  };
  suggestion: PersonalMemoryWriteSuggestion;
  appliedResult?: {
    date?: string;
    title?: string;
    alreadyExists?: boolean;
    applied?: boolean;
  };
};

type QueueFileV1 = {
  version: 1;
  items: PersonalMemorySuggestionQueueItem[];
};

export class PersonalMemorySuggestionQueueError extends Error {
  constructor(
    public readonly code:
      | "QUEUE_NOT_FOUND"
      | "QUEUE_ITEM_NOT_FOUND"
      | "QUEUE_INVALID"
      | "QUEUE_WRITE_FAILED"
      | "SUGGESTION_NOT_APPLICABLE",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PersonalMemorySuggestionQueueError";
  }
}

function queueFilePath(personalContextDir: string): string {
  return path.join(path.resolve(personalContextDir), PERSONAL_MEMORY_SUGGESTION_QUEUE_FILE);
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

function normalizeSuggestionForFingerprint(suggestion: PersonalMemoryWriteSuggestion): unknown {
  if (
    suggestion.level === "L2" &&
    suggestion.target === "decision-log" &&
    suggestion.structured &&
    typeof suggestion.structured === "object"
  ) {
    const s = suggestion.structured;
    return {
      level: suggestion.level,
      target: suggestion.target,
      date: s.date?.trim() ?? "",
      title: s.title?.trim() ?? "",
    };
  }
  return {
    level: suggestion.level,
    target: suggestion.target ?? "",
    title: suggestion.title ?? "",
    reason: suggestion.reason,
    content: suggestion.content ?? "",
  };
}

function suggestionFingerprint(suggestion: PersonalMemoryWriteSuggestion): string {
  const normalized = normalizeSuggestionForFingerprint(suggestion);
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

function sanitizeQueueItem(item: unknown): PersonalMemorySuggestionQueueItem | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const v = item as Record<string, unknown>;
  if (
    typeof v.id !== "string" ||
    typeof v.createdAt !== "string" ||
    typeof v.updatedAt !== "string" ||
    (v.status !== "pending" && v.status !== "applied" && v.status !== "dismissed") ||
    typeof v.fingerprint !== "string" ||
    !v.suggestion ||
    typeof v.suggestion !== "object"
  ) {
    return undefined;
  }
  const sourceRaw =
    v.source && typeof v.source === "object" && !Array.isArray(v.source)
      ? (v.source as Record<string, unknown>)
      : {};
  const source = {
    runId: typeof sourceRaw.runId === "string" ? sourceRaw.runId : undefined,
    sessionKey: typeof sourceRaw.sessionKey === "string" ? sourceRaw.sessionKey : undefined,
    channel:
      typeof sourceRaw.channel === "string"
        ? (sourceRaw.channel as PersonalMemoryChannel)
        : undefined,
  };
  const appliedResultRaw =
    v.appliedResult && typeof v.appliedResult === "object" && !Array.isArray(v.appliedResult)
      ? (v.appliedResult as Record<string, unknown>)
      : undefined;
  return {
    id: v.id,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    status: v.status,
    fingerprint: v.fingerprint,
    source,
    suggestion: v.suggestion as PersonalMemoryWriteSuggestion,
    appliedResult: appliedResultRaw
      ? {
          date: typeof appliedResultRaw.date === "string" ? appliedResultRaw.date : undefined,
          title: typeof appliedResultRaw.title === "string" ? appliedResultRaw.title : undefined,
          alreadyExists:
            typeof appliedResultRaw.alreadyExists === "boolean"
              ? appliedResultRaw.alreadyExists
              : undefined,
          applied:
            typeof appliedResultRaw.applied === "boolean" ? appliedResultRaw.applied : undefined,
        }
      : undefined,
  };
}

function timestampOrZero(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function sortQueueItems(
  items: PersonalMemorySuggestionQueueItem[],
): PersonalMemorySuggestionQueueItem[] {
  return items.toSorted((a, b) => {
    const byUpdated = timestampOrZero(b.updatedAt) - timestampOrZero(a.updatedAt);
    if (byUpdated !== 0) {
      return byUpdated;
    }
    const byCreated = timestampOrZero(b.createdAt) - timestampOrZero(a.createdAt);
    if (byCreated !== 0) {
      return byCreated;
    }
    return a.id.localeCompare(b.id);
  });
}

function readQueue(personalContextDir: string): QueueFileV1 {
  const filePath = queueFilePath(personalContextDir);
  if (!fs.existsSync(filePath)) {
    return { version: 1, items: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<QueueFileV1>;
    if (raw.version !== 1 || !Array.isArray(raw.items)) {
      throw new Error("invalid queue file shape");
    }
    return {
      version: 1,
      items: sortQueueItems(
        raw.items.map(sanitizeQueueItem).filter(Boolean) as PersonalMemorySuggestionQueueItem[],
      ),
    };
  } catch (err) {
    throw new PersonalMemorySuggestionQueueError(
      "QUEUE_INVALID",
      `invalid suggestion queue file: ${filePath}`,
      { cause: err },
    );
  }
}

function writeQueue(personalContextDir: string, payload: QueueFileV1) {
  const filePath = queueFilePath(personalContextDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    throw new PersonalMemorySuggestionQueueError(
      "QUEUE_WRITE_FAILED",
      `failed to write ${filePath}`,
      {
        cause: err,
      },
    );
  }
}

export function enqueuePersonalMemorySuggestion(params: {
  personalContextDir: string;
  suggestion: PersonalMemoryWriteSuggestion;
  source?: { runId?: string; sessionKey?: string; channel?: PersonalMemoryChannel };
  now?: () => Date;
}): { queued: boolean; item: PersonalMemorySuggestionQueueItem } {
  if (params.suggestion.level === "L0") {
    throw new PersonalMemorySuggestionQueueError(
      "SUGGESTION_NOT_APPLICABLE",
      "L0 suggestions are not queued",
    );
  }
  const queue = readQueue(params.personalContextDir);
  const ts = nowIso(params.now);
  const fingerprint = suggestionFingerprint(params.suggestion);
  const existing = queue.items.find(
    (item) =>
      item.fingerprint === fingerprint && (item.status === "pending" || item.status === "applied"),
  );
  if (existing) {
    const nextExisting: PersonalMemorySuggestionQueueItem = {
      ...existing,
      updatedAt: ts,
      source: { ...existing.source, ...params.source },
    };
    queue.items = sortQueueItems(
      queue.items.map((item) => (item.id === existing.id ? nextExisting : item)),
    );
    writeQueue(params.personalContextDir, queue);
    return { queued: false, item: nextExisting };
  }
  const item: PersonalMemorySuggestionQueueItem = {
    id: `pms_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    createdAt: ts,
    updatedAt: ts,
    status: "pending",
    fingerprint,
    source: {
      runId: params.source?.runId,
      sessionKey: params.source?.sessionKey,
      channel: params.source?.channel,
    },
    suggestion: params.suggestion,
  };
  queue.items = sortQueueItems([item, ...queue.items]);
  writeQueue(params.personalContextDir, queue);
  return { queued: true, item };
}

export function listPersonalMemorySuggestions(params: {
  personalContextDir: string;
  status?: QueueStatus | "all";
  limit?: number;
}): { filePath: string; items: PersonalMemorySuggestionQueueItem[] } {
  const queue = readQueue(params.personalContextDir);
  const status = params.status ?? "pending";
  const filtered =
    status === "all" ? queue.items : queue.items.filter((item) => item.status === status);
  const limit = Math.max(1, Math.min(200, params.limit ?? 50));
  return {
    filePath: queueFilePath(params.personalContextDir),
    items: filtered.slice(0, limit),
  };
}

export function dismissPersonalMemorySuggestion(params: {
  personalContextDir: string;
  id: string;
  now?: () => Date;
}): PersonalMemorySuggestionQueueItem {
  const queue = readQueue(params.personalContextDir);
  const idx = queue.items.findIndex((item) => item.id === params.id);
  if (idx < 0) {
    throw new PersonalMemorySuggestionQueueError(
      "QUEUE_ITEM_NOT_FOUND",
      `suggestion not found: ${params.id}`,
    );
  }
  const current = queue.items[idx];
  const next: PersonalMemorySuggestionQueueItem = {
    ...current,
    status: "dismissed",
    updatedAt: nowIso(params.now),
  };
  queue.items[idx] = next;
  queue.items = sortQueueItems(queue.items);
  writeQueue(params.personalContextDir, queue);
  return next;
}

export function applyQueuedPersonalMemorySuggestion(params: {
  personalContextDir: string;
  id: string;
  dryRun?: boolean;
  now?: () => Date;
}) {
  const queue = readQueue(params.personalContextDir);
  const idx = queue.items.findIndex((item) => item.id === params.id);
  if (idx < 0) {
    throw new PersonalMemorySuggestionQueueError(
      "QUEUE_ITEM_NOT_FOUND",
      `suggestion not found: ${params.id}`,
    );
  }
  const item = queue.items[idx];
  const applyResult = applyPersonalMemorySuggestion({
    personalContextDir: params.personalContextDir,
    suggestion: item.suggestion,
    dryRun: params.dryRun,
  });
  if (!params.dryRun) {
    queue.items[idx] = {
      ...item,
      status: "applied",
      updatedAt: nowIso(params.now),
      appliedResult: {
        date: applyResult.date,
        title: applyResult.title,
        alreadyExists: applyResult.alreadyExists,
        applied: applyResult.applied,
      },
    };
    queue.items = sortQueueItems(queue.items);
    writeQueue(params.personalContextDir, queue);
  }
  const nextItem = queue.items.find((queued) => queued.id === item.id) ?? item;
  return {
    item: nextItem,
    applyResult,
  };
}

export function prunePersonalMemorySuggestionQueue(params: {
  personalContextDir: string;
  keepPending?: number;
  retainAppliedDays?: number;
  retainDismissedDays?: number;
  dryRun?: boolean;
  now?: () => Date;
}): { filePath: string; before: number; after: number; removed: number } {
  const queue = readQueue(params.personalContextDir);
  const before = queue.items.length;
  const nowMs = (params.now ?? (() => new Date()))().getTime();
  const retainAppliedMs = Math.max(1, params.retainAppliedDays ?? 30) * 24 * 3600 * 1000;
  const retainDismissedMs = Math.max(1, params.retainDismissedDays ?? 14) * 24 * 3600 * 1000;
  const keepPending = Math.max(1, params.keepPending ?? 200);

  let pendingSeen = 0;
  queue.items = sortQueueItems(
    queue.items.filter((item) => {
      const updatedMs = Number.isFinite(Date.parse(item.updatedAt))
        ? Date.parse(item.updatedAt)
        : nowMs;
      if (item.status === "pending") {
        pendingSeen += 1;
        return pendingSeen <= keepPending;
      }
      if (item.status === "applied") {
        return nowMs - updatedMs <= retainAppliedMs;
      }
      return nowMs - updatedMs <= retainDismissedMs;
    }),
  );

  if (!params.dryRun) {
    writeQueue(params.personalContextDir, queue);
  }
  return {
    filePath: queueFilePath(params.personalContextDir),
    before,
    after: queue.items.length,
    removed: before - queue.items.length,
  };
}
