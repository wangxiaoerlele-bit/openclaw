import fs from "node:fs";
import path from "node:path";
import { PERSONAL_MEMORY_RUNTIME_STATE_FILE } from "./gc.js";

export const PERSONAL_MEMORY_RUNTIME_SHARE_BUNDLE_FILE = path.join(
  "archive",
  "runtime-memory-share.json",
);
export const PERSONAL_MEMORY_RUNTIME_AUTO_SYNC_AUDIT_FILE = path.join(
  "archive",
  "runtime-memory-auto-sync.audit.jsonl",
);

type RuntimeRecord = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt?: string;
};

export type PersonalMemoryRuntimeShareConflictStrategy = "latest" | "current" | "incoming";

type RuntimeStateV1 = {
  version: 1;
  working: RuntimeRecord[];
  episodic: RuntimeRecord[];
};

type BundleV1 = {
  version: 1;
  exportedAt: string;
  source: { cwd: string; personalContextDir: string };
  runtime: RuntimeStateV1;
};

export type PersonalMemoryRuntimeShareExportResult = {
  personalContextDir: string;
  runtimeFilePath: string;
  bundleFilePath: string;
  dryRun: boolean;
  runtimeExists: boolean;
  exportedWorking: number;
  exportedEpisodic: number;
};

export type PersonalMemoryRuntimeShareSyncResult = {
  personalContextDir: string;
  runtimeFilePath: string;
  bundleFilePath: string;
  dryRun: boolean;
  bundleExists: boolean;
  beforeWorking: number;
  beforeEpisodic: number;
  afterWorking: number;
  afterEpisodic: number;
  exportedWorking: number;
  exportedEpisodic: number;
  conflictTotal: number;
  incomingWon: number;
  currentWon: number;
};

export type PersonalMemoryRuntimeShareImportResult = {
  personalContextDir: string;
  runtimeFilePath: string;
  bundleFilePath: string;
  dryRun: boolean;
  bundleExists: boolean;
  beforeWorking: number;
  beforeEpisodic: number;
  afterWorking: number;
  afterEpisodic: number;
  importedWorking: number;
  importedEpisodic: number;
  conflictTotal: number;
  incomingWon: number;
  currentWon: number;
};

type MergeConflictAudit = {
  id: string;
  layer: "working" | "episodic";
  winner: "current" | "incoming";
  currentTs: string;
  incomingTs: string;
  currentTitle?: string;
  incomingTitle?: string;
};

function parseIsoMs(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function sortRuntimeRecords(records: RuntimeRecord[]): RuntimeRecord[] {
  return records.toSorted((a, b) => {
    const byUpdated =
      parseIsoMs(b.updatedAt ?? b.createdAt) - parseIsoMs(a.updatedAt ?? a.createdAt);
    if (byUpdated !== 0) {
      return byUpdated;
    }
    return a.id.localeCompare(b.id);
  });
}

function sanitizeRuntimeRecord(record: unknown): RuntimeRecord | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  const v = record as Record<string, unknown>;
  if (
    typeof v.id !== "string" ||
    typeof v.title !== "string" ||
    typeof v.content !== "string" ||
    typeof v.createdAt !== "string"
  ) {
    return undefined;
  }
  const tags = Array.isArray(v.tags)
    ? v.tags.filter((item): item is string => typeof item === "string")
    : undefined;
  const metadata =
    v.metadata && typeof v.metadata === "object" && !Array.isArray(v.metadata)
      ? { ...(v.metadata as Record<string, unknown>) }
      : undefined;
  return {
    ...v,
    id: v.id,
    title: v.title,
    content: v.content,
    createdAt: v.createdAt,
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : undefined,
    layer: v.layer === "working" ? "working" : "episodic",
    source: typeof v.source === "string" ? v.source : "runtime",
    tags,
    metadata,
  };
}

function readRuntimeState(runtimeFilePath: string): { exists: boolean; state: RuntimeStateV1 } {
  if (!fs.existsSync(runtimeFilePath)) {
    return { exists: false, state: { version: 1, working: [], episodic: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(runtimeFilePath, "utf8")) as Record<string, unknown>;
  const working = Array.isArray(raw.working)
    ? (raw.working.map(sanitizeRuntimeRecord).filter(Boolean) as RuntimeRecord[])
    : [];
  const episodic = Array.isArray(raw.episodic)
    ? (raw.episodic.map(sanitizeRuntimeRecord).filter(Boolean) as RuntimeRecord[])
    : [];
  return {
    exists: true,
    state: {
      version: 1,
      working,
      episodic,
    },
  };
}

function resolveBundlePath(personalContextDir: string, bundleFile: string): string {
  const base = path.resolve(personalContextDir);
  const full = path.resolve(base, bundleFile);
  const rel = path.relative(base, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`runtime share bundle file must stay within personal-context: ${bundleFile}`);
  }
  return full;
}

function resolveAuditPath(personalContextDir: string, auditFile: string): string {
  const base = path.resolve(personalContextDir);
  const full = path.resolve(base, auditFile);
  const rel = path.relative(base, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`runtime share audit file must stay within personal-context: ${auditFile}`);
  }
  return full;
}

function writeBundle(bundleFilePath: string, payload: BundleV1) {
  fs.mkdirSync(path.dirname(bundleFilePath), { recursive: true });
  const tmp = `${bundleFilePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, bundleFilePath);
}

function writeRuntimeState(runtimeFilePath: string, state: RuntimeStateV1) {
  fs.mkdirSync(path.dirname(runtimeFilePath), { recursive: true });
  const tmp = `${runtimeFilePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, runtimeFilePath);
}

function appendAuditJsonl(filePath: string, rows: unknown[]) {
  if (rows.length === 0) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = rows.map((row) => JSON.stringify(row)).join("\n");
  fs.appendFileSync(filePath, `${text}\n`, "utf8");
}

function readBundle(bundleFilePath: string): { exists: boolean; bundle: BundleV1 } {
  if (!fs.existsSync(bundleFilePath)) {
    return {
      exists: false,
      bundle: {
        version: 1,
        exportedAt: new Date().toISOString(),
        source: { cwd: "", personalContextDir: "" },
        runtime: { version: 1, working: [], episodic: [] },
      },
    };
  }
  const raw = JSON.parse(fs.readFileSync(bundleFilePath, "utf8")) as Record<string, unknown>;
  if (typeof raw.version === "number" && raw.version !== 1) {
    throw new Error(`unsupported runtime share bundle version: ${raw.version}`);
  }
  const runtime =
    raw.runtime && typeof raw.runtime === "object" && !Array.isArray(raw.runtime)
      ? (raw.runtime as Record<string, unknown>)
      : {};
  return {
    exists: true,
    bundle: {
      version: 1,
      exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : new Date().toISOString(),
      source:
        raw.source && typeof raw.source === "object" && !Array.isArray(raw.source)
          ? {
              cwd:
                typeof (raw.source as Record<string, unknown>).cwd === "string"
                  ? ((raw.source as Record<string, unknown>).cwd as string)
                  : "",
              personalContextDir:
                typeof (raw.source as Record<string, unknown>).personalContextDir === "string"
                  ? ((raw.source as Record<string, unknown>).personalContextDir as string)
                  : "",
            }
          : { cwd: "", personalContextDir: "" },
      runtime: {
        version: 1,
        working: Array.isArray(runtime.working)
          ? (runtime.working.map(sanitizeRuntimeRecord).filter(Boolean) as RuntimeRecord[])
          : [],
        episodic: Array.isArray(runtime.episodic)
          ? (runtime.episodic.map(sanitizeRuntimeRecord).filter(Boolean) as RuntimeRecord[])
          : [],
      },
    },
  };
}

function mergeRuntimeRecords(
  current: RuntimeRecord[],
  incoming: RuntimeRecord[],
  layer: "working" | "episodic",
  strategy: PersonalMemoryRuntimeShareConflictStrategy = "latest",
): { merged: RuntimeRecord[]; conflicts: MergeConflictAudit[] } {
  const byId = new Map<string, RuntimeRecord>();
  const conflicts: MergeConflictAudit[] = [];
  for (const record of current) {
    byId.set(record.id, record);
  }
  for (const record of incoming) {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      continue;
    }
    const existingTs = parseIsoMs(existing.updatedAt ?? existing.createdAt);
    const incomingTs = parseIsoMs(record.updatedAt ?? record.createdAt);
    const incomingWins =
      strategy === "incoming" ? true : strategy === "current" ? false : incomingTs >= existingTs;
    if (incomingWins) {
      byId.set(record.id, record);
      conflicts.push({
        id: record.id,
        layer,
        winner: "incoming",
        currentTs: existing.updatedAt ?? existing.createdAt,
        incomingTs: record.updatedAt ?? record.createdAt,
        currentTitle: typeof existing.title === "string" ? existing.title : undefined,
        incomingTitle: typeof record.title === "string" ? record.title : undefined,
      });
    } else {
      conflicts.push({
        id: record.id,
        layer,
        winner: "current",
        currentTs: existing.updatedAt ?? existing.createdAt,
        incomingTs: record.updatedAt ?? record.createdAt,
        currentTitle: typeof existing.title === "string" ? existing.title : undefined,
        incomingTitle: typeof record.title === "string" ? record.title : undefined,
      });
    }
  }
  return { merged: sortRuntimeRecords([...byId.values()]), conflicts };
}

export function exportPersonalMemoryRuntimeBundle(params: {
  personalContextDir: string;
  bundleFile?: string;
  includeWorking?: boolean;
  maxEpisodic?: number;
  dryRun?: boolean;
  now?: () => Date;
}): PersonalMemoryRuntimeShareExportResult {
  const personalContextDir = path.resolve(params.personalContextDir);
  const runtimeFilePath = path.join(personalContextDir, PERSONAL_MEMORY_RUNTIME_STATE_FILE);
  const bundleFilePath = resolveBundlePath(
    personalContextDir,
    params.bundleFile ?? PERSONAL_MEMORY_RUNTIME_SHARE_BUNDLE_FILE,
  );
  const { exists, state } = readRuntimeState(runtimeFilePath);
  const maxEpisodic = Math.max(1, params.maxEpisodic ?? 200);
  const runtime: RuntimeStateV1 = {
    version: 1,
    working: params.includeWorking ? sortRuntimeRecords(state.working) : [],
    episodic: sortRuntimeRecords(state.episodic).slice(0, maxEpisodic),
  };
  const payload: BundleV1 = {
    version: 1,
    exportedAt: (params.now ?? (() => new Date()))().toISOString(),
    source: { cwd: process.cwd(), personalContextDir },
    runtime,
  };
  if (!params.dryRun) {
    writeBundle(bundleFilePath, payload);
  }
  return {
    personalContextDir,
    runtimeFilePath,
    bundleFilePath,
    dryRun: params.dryRun === true,
    runtimeExists: exists,
    exportedWorking: runtime.working.length,
    exportedEpisodic: runtime.episodic.length,
  };
}

export function syncPersonalMemoryRuntimeBundle(params: {
  personalContextDir: string;
  bundleFile?: string;
  includeWorking?: boolean;
  maxEpisodic?: number;
  conflictStrategy?: PersonalMemoryRuntimeShareConflictStrategy;
  auditConflicts?: boolean;
  auditFile?: string;
  dryRun?: boolean;
  now?: () => Date;
}): PersonalMemoryRuntimeShareSyncResult {
  const personalContextDir = path.resolve(params.personalContextDir);
  const runtimeFilePath = path.join(personalContextDir, PERSONAL_MEMORY_RUNTIME_STATE_FILE);
  const bundleFilePath = resolveBundlePath(
    personalContextDir,
    params.bundleFile ?? PERSONAL_MEMORY_RUNTIME_SHARE_BUNDLE_FILE,
  );
  const { state: current } = readRuntimeState(runtimeFilePath);
  const { exists: bundleExists, bundle } = readBundle(bundleFilePath);
  const maxEpisodic = Math.max(1, params.maxEpisodic ?? 200);
  const conflictStrategy = params.conflictStrategy ?? "latest";
  const workingMerge = params.includeWorking
    ? mergeRuntimeRecords(current.working, bundle.runtime.working, "working", conflictStrategy)
    : { merged: current.working, conflicts: [] as MergeConflictAudit[] };
  const episodicMerge = mergeRuntimeRecords(
    current.episodic,
    bundle.runtime.episodic,
    "episodic",
    conflictStrategy,
  );
  const nextRuntime: RuntimeStateV1 = {
    version: 1,
    working: workingMerge.merged,
    episodic: episodicMerge.merged.slice(0, maxEpisodic),
  };
  const nextBundle: BundleV1 = {
    version: 1,
    exportedAt: (params.now ?? (() => new Date()))().toISOString(),
    source: { cwd: process.cwd(), personalContextDir },
    runtime: {
      version: 1,
      working: params.includeWorking ? sortRuntimeRecords(nextRuntime.working) : [],
      episodic: sortRuntimeRecords(nextRuntime.episodic).slice(0, maxEpisodic),
    },
  };
  const conflicts = [...workingMerge.conflicts, ...episodicMerge.conflicts];
  if (!params.dryRun) {
    writeRuntimeState(runtimeFilePath, nextRuntime);
    writeBundle(bundleFilePath, nextBundle);
    if (params.auditConflicts && conflicts.length > 0) {
      const auditFilePath = resolveAuditPath(
        personalContextDir,
        params.auditFile ?? PERSONAL_MEMORY_RUNTIME_AUTO_SYNC_AUDIT_FILE,
      );
      appendAuditJsonl(
        auditFilePath,
        conflicts.map((conflict) => ({
          type: "runtime-auto-sync-conflict",
          at: (params.now ?? (() => new Date()))().toISOString(),
          mode: "sync",
          strategy: conflictStrategy,
          bundleFile: bundleFilePath,
          runtimeFile: runtimeFilePath,
          ...conflict,
        })),
      );
    }
  }
  return {
    personalContextDir,
    runtimeFilePath,
    bundleFilePath,
    dryRun: params.dryRun === true,
    bundleExists,
    beforeWorking: current.working.length,
    beforeEpisodic: current.episodic.length,
    afterWorking: nextRuntime.working.length,
    afterEpisodic: nextRuntime.episodic.length,
    exportedWorking: nextBundle.runtime.working.length,
    exportedEpisodic: nextBundle.runtime.episodic.length,
    conflictTotal: conflicts.length,
    incomingWon: conflicts.filter((c) => c.winner === "incoming").length,
    currentWon: conflicts.filter((c) => c.winner === "current").length,
  };
}

export function importPersonalMemoryRuntimeBundle(params: {
  personalContextDir: string;
  bundleFile?: string;
  includeWorking?: boolean;
  maxEpisodic?: number;
  conflictStrategy?: PersonalMemoryRuntimeShareConflictStrategy;
  auditConflicts?: boolean;
  auditFile?: string;
  dryRun?: boolean;
}): PersonalMemoryRuntimeShareImportResult {
  const personalContextDir = path.resolve(params.personalContextDir);
  const runtimeFilePath = path.join(personalContextDir, PERSONAL_MEMORY_RUNTIME_STATE_FILE);
  const bundleFilePath = resolveBundlePath(
    personalContextDir,
    params.bundleFile ?? PERSONAL_MEMORY_RUNTIME_SHARE_BUNDLE_FILE,
  );
  const { state: current } = readRuntimeState(runtimeFilePath);
  const { exists: bundleExists, bundle } = readBundle(bundleFilePath);
  const maxEpisodic = Math.max(1, params.maxEpisodic ?? 200);
  const conflictStrategy = params.conflictStrategy ?? "latest";
  const workingMerge = params.includeWorking
    ? mergeRuntimeRecords(current.working, bundle.runtime.working, "working", conflictStrategy)
    : { merged: current.working, conflicts: [] as MergeConflictAudit[] };
  const episodicMerge = mergeRuntimeRecords(
    current.episodic,
    bundle.runtime.episodic,
    "episodic",
    conflictStrategy,
  );
  const nextRuntime: RuntimeStateV1 = {
    version: 1,
    working: workingMerge.merged,
    episodic: episodicMerge.merged.slice(0, maxEpisodic),
  };
  const conflicts = [...workingMerge.conflicts, ...episodicMerge.conflicts];
  if (!params.dryRun) {
    writeRuntimeState(runtimeFilePath, nextRuntime);
    if (params.auditConflicts && conflicts.length > 0) {
      const auditFilePath = resolveAuditPath(
        personalContextDir,
        params.auditFile ?? PERSONAL_MEMORY_RUNTIME_AUTO_SYNC_AUDIT_FILE,
      );
      appendAuditJsonl(
        auditFilePath,
        conflicts.map((conflict) => ({
          type: "runtime-auto-sync-conflict",
          at: new Date().toISOString(),
          mode: "import",
          strategy: conflictStrategy,
          bundleFile: bundleFilePath,
          runtimeFile: runtimeFilePath,
          ...conflict,
        })),
      );
    }
  }
  return {
    personalContextDir,
    runtimeFilePath,
    bundleFilePath,
    dryRun: params.dryRun === true,
    bundleExists,
    beforeWorking: current.working.length,
    beforeEpisodic: current.episodic.length,
    afterWorking: nextRuntime.working.length,
    afterEpisodic: nextRuntime.episodic.length,
    importedWorking: params.includeWorking ? nextRuntime.working.length : 0,
    importedEpisodic: nextRuntime.episodic.length,
    conflictTotal: conflicts.length,
    incomingWon: conflicts.filter((c) => c.winner === "incoming").length,
    currentWon: conflicts.filter((c) => c.winner === "current").length,
  };
}
