#!/usr/bin/env node
import { runPersonalMemoryGc } from "../src/personal-memory/gc.ts";
import { resolvePersonalContextDir } from "./personal-context-memory.ts";

type Args = {
  dir: string;
  dryRun: boolean;
  json: boolean;
  keepPending: number;
  retainAppliedDays: number;
  retainDismissedDays: number;
  retainWorkingHours: number;
  retainEpisodicDays: number;
  maxEpisodic: number;
};

function usage(): string {
  return [
    "Usage: node --import tsx scripts/personal-memory-gc.ts [options]",
    "",
    "Options:",
    "  --dir <dir>                 Memory directory (default: personal-context)",
    "  --keep-pending <n>          Keep newest pending suggestions (default: 200)",
    "  --retain-applied-days <n>   Keep applied suggestions for N days (default: 30)",
    "  --retain-dismissed-days <n> Keep dismissed suggestions for N days (default: 14)",
    "  --retain-working-hours <n>  Keep runtime working entries for N hours (default: 24)",
    "  --retain-episodic-days <n>  Keep runtime episodic entries for N days (default: 30)",
    "  --max-episodic <n>          Max runtime episodic entries to keep (default: 200)",
    "  --dry-run                   Preview only",
    "  --json                      Output JSON",
    "  -h, --help                  Show help",
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
    dir: "personal-context",
    dryRun: false,
    json: false,
    keepPending: 200,
    retainAppliedDays: 30,
    retainDismissedDays: 14,
    retainWorkingHours: 24,
    retainEpisodicDays: 30,
    maxEpisodic: 200,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--dir":
        if (!next) {
          throw new Error("--dir requires a value");
        }
        args.dir = next;
        i += 1;
        break;
      case "--keep-pending":
        if (!next) {
          throw new Error("--keep-pending requires a value");
        }
        args.keepPending = parsePositiveInt(next, "--keep-pending");
        i += 1;
        break;
      case "--retain-applied-days":
        if (!next) {
          throw new Error("--retain-applied-days requires a value");
        }
        args.retainAppliedDays = parsePositiveInt(next, "--retain-applied-days");
        i += 1;
        break;
      case "--retain-dismissed-days":
        if (!next) {
          throw new Error("--retain-dismissed-days requires a value");
        }
        args.retainDismissedDays = parsePositiveInt(next, "--retain-dismissed-days");
        i += 1;
        break;
      case "--retain-working-hours":
        if (!next) {
          throw new Error("--retain-working-hours requires a value");
        }
        args.retainWorkingHours = parsePositiveInt(next, "--retain-working-hours");
        i += 1;
        break;
      case "--retain-episodic-days":
        if (!next) {
          throw new Error("--retain-episodic-days requires a value");
        }
        args.retainEpisodicDays = parsePositiveInt(next, "--retain-episodic-days");
        i += 1;
        break;
      case "--max-episodic":
        if (!next) {
          throw new Error("--max-episodic requires a value");
        }
        args.maxEpisodic = parsePositiveInt(next, "--max-episodic");
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
  return args;
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
  let baseDir: string;
  try {
    baseDir = resolvePersonalContextDir(process.cwd(), args.dir);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }
  try {
    const payload = runPersonalMemoryGc({
      personalContextDir: baseDir,
      dryRun: args.dryRun,
      policy: {
        keepPending: args.keepPending,
        retainAppliedDays: args.retainAppliedDays,
        retainDismissedDays: args.retainDismissedDays,
        retainWorkingHours: args.retainWorkingHours,
        retainEpisodicDays: args.retainEpisodicDays,
        maxEpisodic: args.maxEpisodic,
      },
    });
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    const { runtime, suggestions } = payload;
    console.log(
      `Personal memory GC: ${payload.personalContextDir} dryRun=${String(payload.dryRun)}`,
    );
    console.log(
      `Runtime -> working ${runtime.beforeWorking} -> ${runtime.afterWorking}, episodic ${runtime.beforeEpisodic} -> ${runtime.afterEpisodic}`,
    );
    console.log(
      `Suggestions -> ${suggestions.before} -> ${suggestions.after} (removed=${suggestions.removed})`,
    );
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
