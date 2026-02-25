#!/usr/bin/env node
import fs from "node:fs";
import {
  type DecisionEntry,
  parseDecisionEntriesFromLog,
  resolvePersonalContextDir,
  resolvePersonalContextFilePath,
  sortDecisionEntriesByDateDesc,
} from "./personal-context-memory.ts";

type Args = {
  dir: string;
  file: string;
  limit: number;
  json: boolean;
};

function usage(): string {
  return [
    "Usage: node --import tsx scripts/personal-context-summary.ts [options]",
    "",
    "Options:",
    "  --dir <dir>        Memory directory (default: personal-context)",
    "  --file <file>      Decision log file (default: 04-decision-log.md)",
    "  --limit <n>        Max entries to output (default: 5)",
    "  --json             Output JSON",
    "  -h, --help         Show help",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dir: "personal-context",
    file: "04-decision-log.md",
    limit: 5,
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
      case "--file":
        if (!next) {
          throw new Error("--file requires a value");
        }
        args.file = next;
        i += 1;
        break;
      case "--limit":
        if (!next) {
          throw new Error("--limit requires a value");
        }
        args.limit = Number.parseInt(next, 10);
        i += 1;
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

  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    throw new Error("--limit must be a positive integer");
  }

  return args;
}

function printTable(entries: DecisionEntry[]) {
  if (entries.length === 0) {
    console.log("No decision entries found.");
    return;
  }

  console.log(`Recent decision entries (${entries.length})`);
  console.log("");
  for (const [idx, e] of entries.entries()) {
    console.log(`${idx + 1}. [${e.date}] ${e.title}`);
    if (e.decision) {
      console.log(`   决策: ${e.decision}`);
    }
    if (e.reason) {
      console.log(`   原因: ${e.reason}`);
    }
    if (e.next) {
      console.log(`   后续: ${e.next}`);
    }
    console.log("");
  }
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
  let filePath: string;
  try {
    baseDir = resolvePersonalContextDir(process.cwd(), args.dir);
    filePath = resolvePersonalContextFilePath(baseDir, args.file);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const text = fs.readFileSync(filePath, "utf8");
  const allEntries = sortDecisionEntriesByDateDesc(parseDecisionEntriesFromLog(text));
  const entries = allEntries.slice(0, args.limit);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          file: filePath,
          totalEntries: allEntries.length,
          shown: entries.length,
          entries,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Decision log: ${filePath}`);
  printTable(entries);
}

main();
