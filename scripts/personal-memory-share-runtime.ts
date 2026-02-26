#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { PERSONAL_MEMORY_RUNTIME_STATE_FILE } from "../src/personal-memory/gc.ts";
import { resolvePersonalContextDir } from "./personal-context-memory.ts";

type RuntimeRecord = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt?: string;
};

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

type MergeConflictAudit = {
  id: string;
  layer: "working" | "episodic";
  winner: "current" | "incoming";
  currentTs: string;
  incomingTs: string;
  currentTitle?: string;
  incomingTitle?: string;
};

type MergeRuntimeRecordsResult = {
  merged: RuntimeRecord[];
  conflicts: MergeConflictAudit[];
};

type Args = {
  command: "export" | "import" | "sync";
  dir: string;
  file: string;
  auditFile: string;
  includeWorking: boolean;
  maxEpisodic: number;
  conflictStrategy: "latest" | "current" | "incoming";
  dryRun: boolean;
  json: boolean;
};

function usage(): string {
  return [
    "Usage: node --import tsx scripts/personal-memory-share-runtime.ts <export|import|sync> [options]",
    "",
    "Export/import/sync runtime personal-memory state across workspaces (MVP).",
    "",
    "Options:",
    "  --dir <dir>            Memory directory (default: personal-context)",
    "  --file <path>          Bundle file path within current workspace",
    "                        (default: personal-context/archive/runtime-memory-share.json)",
    "  --audit-file <path>    Conflict audit JSONL path within current workspace",
    "                        (default: personal-context/archive/runtime-memory-share.audit.jsonl)",
    "  --include-working      Include working-layer runtime entries (default: episodic only)",
    "  --max-episodic <n>     Max episodic entries to keep on import (default: 200)",
    "  --conflict-strategy <latest|current|incoming>",
    "                        Conflict winner when ids collide during import/sync (default: latest)",
    "  --dry-run              Preview import/sync only; do not write runtime state or bundle",
    "  --json                 Output JSON",
    "  -h, --help             Show help",
  ].join("\n");
}

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return n;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "export",
    dir: "personal-context",
    file: path.join("personal-context", "archive", "runtime-memory-share.json"),
    auditFile: path.join("personal-context", "archive", "runtime-memory-share.audit.jsonl"),
    includeWorking: false,
    maxEpisodic: 200,
    conflictStrategy: "latest",
    dryRun: false,
    json: false,
  };
  let commandSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (!commandSeen && (arg === "export" || arg === "import" || arg === "sync")) {
      args.command = arg;
      commandSeen = true;
      continue;
    }
    switch (arg) {
      case "--dir":
        if (!next) {
          throw new Error("--dir requires a value");
        }
        args.dir = next;
        i += 1;
        break;
      case "--file":
        if (!next) {
          throw new Error("--file requires a value");
        }
        args.file = next;
        i += 1;
        break;
      case "--audit-file":
        if (!next) {
          throw new Error("--audit-file requires a value");
        }
        args.auditFile = next;
        i += 1;
        break;
      case "--include-working":
        args.includeWorking = true;
        break;
      case "--max-episodic":
        if (!next) {
          throw new Error("--max-episodic requires a value");
        }
        args.maxEpisodic = parsePositiveInt(next, "--max-episodic");
        i += 1;
        break;
      case "--conflict-strategy":
        if (!next) {
          throw new Error("--conflict-strategy requires a value");
        }
        if (next !== "latest" && next !== "current" && next !== "incoming") {
          throw new Error("--conflict-strategy must be latest | current | incoming");
        }
        args.conflictStrategy = next;
        i += 1;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!commandSeen) {
    throw new Error("missing command: export | import | sync");
  }
  return args;
}

function resolveWorkspaceFilePath(cwd: string, fileArg: string): string {
  const cwdReal = fs.realpathSync(cwd);
  const resolved = path.resolve(cwd, fileArg);
  const parent = path.dirname(resolved);
  let probeDir = parent;
  while (!fs.existsSync(probeDir)) {
    const next = path.dirname(probeDir);
    if (next === probeDir) {
      break;
    }
    probeDir = next;
  }
  const probeReal = fs.realpathSync(probeDir);
  const rel = path.relative(cwdReal, probeReal);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`bundle file must stay within current workspace: ${resolved}`);
  }
  return resolved;
}

function parseIsoMs(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
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

function sanitizeRuntimeState(raw: unknown): RuntimeStateV1 {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const working = Array.isArray(value.working)
    ? value.working.map(sanitizeRuntimeRecord).filter(Boolean)
    : [];
  const episodic = Array.isArray(value.episodic)
    ? value.episodic.map(sanitizeRuntimeRecord).filter(Boolean)
    : [];
  return {
    version: 1,
    working: working as RuntimeRecord[],
    episodic: episodic as RuntimeRecord[],
  };
}

function readRuntimeState(runtimeFile: string): RuntimeStateV1 {
  if (!fs.existsSync(runtimeFile)) {
    return { version: 1, working: [], episodic: [] };
  }
  const parsed = JSON.parse(fs.readFileSync(runtimeFile, "utf8")) as unknown;
  return sanitizeRuntimeState(parsed);
}

function writeRuntimeState(runtimeFile: string, state: RuntimeStateV1): void {
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
  const tmp = `${runtimeFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, runtimeFile);
}

function writeBundle(bundleFile: string, payload: BundleV1): void {
  fs.mkdirSync(path.dirname(bundleFile), { recursive: true });
  fs.writeFileSync(bundleFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function appendAuditJsonl(filePath: string, rows: unknown[]): void {
  if (rows.length === 0) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = rows.map((row) => JSON.stringify(row)).join("\n");
  fs.appendFileSync(filePath, `${text}\n`, "utf8");
}

function readBundle(bundleFile: string): BundleV1 {
  const raw = JSON.parse(fs.readFileSync(bundleFile, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`invalid bundle file: ${bundleFile}`);
  }
  const parsed = raw as Record<string, unknown>;
  if (parsed.version !== 1) {
    throw new Error(`unsupported bundle version: ${String(parsed.version)}`);
  }
  const runtime = sanitizeRuntimeState(parsed.runtime);
  return {
    version: 1,
    exportedAt:
      typeof parsed.exportedAt === "string" ? parsed.exportedAt : new Date().toISOString(),
    source:
      parsed.source && typeof parsed.source === "object" && !Array.isArray(parsed.source)
        ? {
            cwd:
              typeof (parsed.source as Record<string, unknown>).cwd === "string"
                ? ((parsed.source as Record<string, unknown>).cwd as string)
                : "",
            personalContextDir:
              typeof (parsed.source as Record<string, unknown>).personalContextDir === "string"
                ? ((parsed.source as Record<string, unknown>).personalContextDir as string)
                : "",
          }
        : { cwd: "", personalContextDir: "" },
    runtime,
  };
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

function mergeRuntimeRecords(
  current: RuntimeRecord[],
  incoming: RuntimeRecord[],
  layer: "working" | "episodic",
  conflictStrategy: "latest" | "current" | "incoming",
): MergeRuntimeRecordsResult {
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
      conflictStrategy === "incoming"
        ? true
        : conflictStrategy === "current"
          ? false
          : incomingTs >= existingTs;
    if (incomingWins) {
      conflicts.push({
        id: record.id,
        layer,
        winner: "incoming",
        currentTs: existing.updatedAt ?? existing.createdAt,
        incomingTs: record.updatedAt ?? record.createdAt,
        currentTitle: typeof existing.title === "string" ? existing.title : undefined,
        incomingTitle: typeof record.title === "string" ? record.title : undefined,
      });
      byId.set(record.id, record);
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

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    console.error(usage());
    process.exit(2);
    return;
  }

  let personalContextDir: string;
  let bundleFile: string;
  let auditFile: string;
  try {
    personalContextDir = resolvePersonalContextDir(process.cwd(), args.dir);
    bundleFile = resolveWorkspaceFilePath(process.cwd(), args.file);
    auditFile = resolveWorkspaceFilePath(process.cwd(), args.auditFile);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const runtimeFile = path.join(personalContextDir, PERSONAL_MEMORY_RUNTIME_STATE_FILE);

  try {
    if (args.command === "export") {
      const current = readRuntimeState(runtimeFile);
      const runtime: RuntimeStateV1 = {
        version: 1,
        working: args.includeWorking ? sortRuntimeRecords(current.working) : [],
        episodic: sortRuntimeRecords(current.episodic),
      };
      const payload: BundleV1 = {
        version: 1,
        exportedAt: new Date().toISOString(),
        source: { cwd: process.cwd(), personalContextDir },
        runtime,
      };
      if (!args.dryRun) {
        writeBundle(bundleFile, payload);
      }
      const out = {
        command: "export",
        dryRun: args.dryRun,
        bundleFile,
        runtimeFile,
        exportedWorking: runtime.working.length,
        exportedEpisodic: runtime.episodic.length,
      };
      if (args.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`Exported runtime memory bundle: ${bundleFile}`);
        console.log(
          `working=${out.exportedWorking} episodic=${out.exportedEpisodic} dryRun=${String(out.dryRun)}`,
        );
      }
      return;
    }

    if (args.command === "import" && !fs.existsSync(bundleFile)) {
      throw new Error(`bundle file not found: ${bundleFile}`);
    }
    const bundle = fs.existsSync(bundleFile)
      ? readBundle(bundleFile)
      : {
          version: 1 as const,
          exportedAt: new Date().toISOString(),
          source: { cwd: "", personalContextDir: "" },
          runtime: { version: 1 as const, working: [], episodic: [] },
        };
    const current = readRuntimeState(runtimeFile);
    const workingMerge = args.includeWorking
      ? mergeRuntimeRecords(
          current.working,
          bundle.runtime.working,
          "working",
          args.conflictStrategy,
        )
      : { merged: current.working, conflicts: [] };
    const episodicMerge = mergeRuntimeRecords(
      current.episodic,
      bundle.runtime.episodic,
      "episodic",
      args.conflictStrategy,
    );
    const mergedWorking = workingMerge.merged;
    const mergedEpisodic = episodicMerge.merged.slice(0, args.maxEpisodic);
    const conflicts = [...workingMerge.conflicts, ...episodicMerge.conflicts];
    const next: RuntimeStateV1 = {
      version: 1,
      working: mergedWorking,
      episodic: mergedEpisodic,
    };
    const syncBundlePayload: BundleV1 = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: { cwd: process.cwd(), personalContextDir },
      runtime: {
        version: 1,
        working: args.includeWorking ? sortRuntimeRecords(next.working) : [],
        episodic: sortRuntimeRecords(next.episodic),
      },
    };
    if (!args.dryRun) {
      writeRuntimeState(runtimeFile, next);
      if (args.command === "sync") {
        writeBundle(bundleFile, syncBundlePayload);
      }
      appendAuditJsonl(
        auditFile,
        conflicts.map((conflict) => ({
          type: "runtime-share-conflict",
          at: new Date().toISOString(),
          command: args.command,
          bundleFile,
          runtimeFile,
          ...conflict,
        })),
      );
    }
    const out = {
      command: args.command,
      dryRun: args.dryRun,
      bundleFile,
      runtimeFile,
      auditFile,
      importedFromBundle: {
        working: bundle.runtime.working.length,
        episodic: bundle.runtime.episodic.length,
      },
      before: {
        working: current.working.length,
        episodic: current.episodic.length,
      },
      after: {
        working: next.working.length,
        episodic: next.episodic.length,
      },
      exportedToBundle:
        args.command === "sync"
          ? {
              working: syncBundlePayload.runtime.working.length,
              episodic: syncBundlePayload.runtime.episodic.length,
            }
          : undefined,
      conflicts: {
        total: conflicts.length,
        incomingWon: conflicts.filter((c) => c.winner === "incoming").length,
        currentWon: conflicts.filter((c) => c.winner === "current").length,
      },
      conflictStrategy: args.conflictStrategy,
    };
    if (args.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      if (args.command === "sync") {
        console.log(`Synced runtime memory bundle: ${bundleFile}`);
      } else {
        console.log(`Imported runtime memory bundle: ${bundleFile}`);
      }
      console.log(
        `working ${out.before.working} -> ${out.after.working}, episodic ${out.before.episodic} -> ${out.after.episodic} dryRun=${String(out.dryRun)}`,
      );
      if (out.conflicts.total > 0) {
        console.log(
          `conflicts=${out.conflicts.total} incomingWon=${out.conflicts.incomingWon} currentWon=${out.conflicts.currentWon} strategy=${out.conflictStrategy}`,
        );
      }
    }
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
