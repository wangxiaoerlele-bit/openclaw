import fs from "node:fs";
import path from "node:path";
import { PERSONAL_MEMORY_RUNTIME_STATE_FILE } from "./gc.js";

export const PERSONAL_MEMORY_RUNTIME_EPISODIC_ARCHIVE_FILE = path.join(
  "archive",
  "runtime-episodic.archive.jsonl",
);

type RuntimeRecord = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt?: string;
};

type RuntimeState = {
  version?: number;
  working?: unknown[];
  episodic?: unknown[];
};

export type PersonalMemoryRuntimeArchiveEntry = {
  id: string;
  archivedAt: string;
  record: RuntimeRecord;
};

export type PersonalMemoryRuntimeArchiveResult = {
  personalContextDir: string;
  dryRun: boolean;
  runtimeFilePath: string;
  archiveFilePath: string;
  runtimeExists: boolean;
  beforeEpisodic: number;
  afterEpisodic: number;
  candidates: number;
  archivedAdded: number;
  archiveDuplicates: number;
  archiveBefore: number;
  archiveAfter: number;
};

function parseIsoMs(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

function sanitizeRuntimeRecord(value: unknown): RuntimeRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== "string" ||
    typeof v.title !== "string" ||
    typeof v.content !== "string" ||
    typeof v.createdAt !== "string"
  ) {
    return undefined;
  }
  return {
    ...v,
    id: v.id,
    createdAt: v.createdAt,
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : undefined,
  };
}

function readRuntimeState(runtimeFilePath: string): { exists: boolean; state: RuntimeState } {
  if (!fs.existsSync(runtimeFilePath)) {
    return { exists: false, state: { version: 1, working: [], episodic: [] } };
  }
  const parsed = JSON.parse(fs.readFileSync(runtimeFilePath, "utf8")) as RuntimeState;
  return { exists: true, state: parsed };
}

function readArchiveIds(archiveFilePath: string): Set<string> {
  if (!fs.existsSync(archiveFilePath)) {
    return new Set();
  }
  const ids = new Set<string>();
  const lines = fs
    .readFileSync(archiveFilePath, "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Partial<PersonalMemoryRuntimeArchiveEntry>;
      if (typeof parsed.id === "string" && parsed.id) {
        ids.add(parsed.id);
      }
    } catch {
      // Ignore malformed historical lines; archive is best-effort append-only.
    }
  }
  return ids;
}

function writeRuntimeState(runtimeFilePath: string, state: RuntimeState): void {
  fs.mkdirSync(path.dirname(runtimeFilePath), { recursive: true });
  const tmp = `${runtimeFilePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, runtimeFilePath);
}

function appendArchiveEntries(
  archiveFilePath: string,
  entries: PersonalMemoryRuntimeArchiveEntry[],
): void {
  if (entries.length === 0) {
    return;
  }
  fs.mkdirSync(path.dirname(archiveFilePath), { recursive: true });
  const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");
  fs.appendFileSync(archiveFilePath, `${payload}\n`, "utf8");
}

export function archivePersonalMemoryRuntimeEpisodic(params: {
  personalContextDir: string;
  retainDays?: number;
  dryRun?: boolean;
  now?: () => Date;
}): PersonalMemoryRuntimeArchiveResult {
  const personalContextDir = path.resolve(params.personalContextDir);
  const runtimeFilePath = path.join(personalContextDir, PERSONAL_MEMORY_RUNTIME_STATE_FILE);
  const archiveFilePath = path.join(
    personalContextDir,
    PERSONAL_MEMORY_RUNTIME_EPISODIC_ARCHIVE_FILE,
  );
  const retainDays = Math.max(1, params.retainDays ?? 30);
  const now = params.now ?? (() => new Date());
  const nowMs = now().getTime();
  const retainMs = retainDays * 24 * 3600 * 1000;

  const { exists, state } = readRuntimeState(runtimeFilePath);
  const episodic = Array.isArray(state.episodic)
    ? (state.episodic.map(sanitizeRuntimeRecord).filter(Boolean) as RuntimeRecord[])
    : [];
  const working = Array.isArray(state.working) ? state.working : [];
  const beforeEpisodic = episodic.length;

  const remaining: RuntimeRecord[] = [];
  const candidates: RuntimeRecord[] = [];
  for (const record of episodic) {
    const ts = parseIsoMs(record.updatedAt) ?? parseIsoMs(record.createdAt);
    if (ts && nowMs - ts > retainMs) {
      candidates.push(record);
    } else {
      remaining.push(record);
    }
  }

  const archiveBeforeIds = readArchiveIds(archiveFilePath);
  const archiveBefore = archiveBeforeIds.size;
  const seenIds = new Set<string>(archiveBeforeIds);
  const archivedAt = now().toISOString();
  const entriesToAppend: PersonalMemoryRuntimeArchiveEntry[] = [];
  let archiveDuplicates = 0;
  for (const record of candidates) {
    if (seenIds.has(record.id)) {
      archiveDuplicates += 1;
      continue;
    }
    seenIds.add(record.id);
    entriesToAppend.push({
      id: record.id,
      archivedAt,
      record,
    });
  }

  if (!params.dryRun) {
    if (exists) {
      writeRuntimeState(runtimeFilePath, {
        version: state.version === 1 ? 1 : 1,
        working,
        episodic: remaining,
      });
    }
    appendArchiveEntries(archiveFilePath, entriesToAppend);
  }

  return {
    personalContextDir,
    dryRun: params.dryRun === true,
    runtimeFilePath,
    archiveFilePath,
    runtimeExists: exists,
    beforeEpisodic,
    afterEpisodic: remaining.length,
    candidates: candidates.length,
    archivedAdded: entriesToAppend.length,
    archiveDuplicates,
    archiveBefore,
    archiveAfter: archiveBefore + entriesToAppend.length,
  };
}
