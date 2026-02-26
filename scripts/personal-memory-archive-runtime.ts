#!/usr/bin/env node
import { archivePersonalMemoryRuntimeEpisodic } from "../src/personal-memory/runtime-archive.ts";
import { resolvePersonalContextDir } from "./personal-context-memory.ts";

type Args = {
  dir: string;
  retainDays: number;
  dryRun: boolean;
  json: boolean;
};

function usage(): string {
  return [
    "Usage: node --import tsx scripts/personal-memory-archive-runtime.ts [options]",
    "",
    "Archive old runtime episodic records into personal-context/archive/runtime-episodic.archive.jsonl",
    "",
    "Options:",
    "  --dir <dir>          Memory directory (default: personal-context)",
    "  --retain-days <n>    Keep runtime episodic for N days before archiving (default: 30)",
    "  --dry-run            Preview only; do not write",
    "  --json               Output JSON",
    "  -h, --help           Show help",
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
    retainDays: 30,
    dryRun: false,
    json: false,
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
      case "--retain-days":
        if (!next) {
          throw new Error("--retain-days requires a value");
        }
        args.retainDays = parsePositiveInt(next, "--retain-days");
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

function main() {
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
    const result = archivePersonalMemoryRuntimeEpisodic({
      personalContextDir: baseDir,
      retainDays: args.retainDays,
      dryRun: args.dryRun,
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Runtime episodic archive: ${result.personalContextDir}`);
    console.log(
      `episodic ${result.beforeEpisodic} -> ${result.afterEpisodic} candidates=${result.candidates}`,
    );
    console.log(
      `archive added=${result.archivedAdded} duplicates=${result.archiveDuplicates} file=${result.archiveFilePath}`,
    );
    if (result.dryRun) {
      console.log("DRY RUN: no files written");
    }
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
