#!/usr/bin/env node
import fs from "node:fs";
import {
  applyPersonalMemorySuggestion,
  assertApplicablePersonalMemorySuggestion,
} from "../src/personal-memory/apply-suggestion.ts";
import type { PersonalMemoryWriteSuggestion } from "../src/personal-memory/types.ts";
import {
  resolvePersonalContextDir,
  resolvePersonalContextFilePath,
} from "./personal-context-memory.ts";

type Args = {
  dir: string;
  file: string;
  json?: string;
  jsonFile?: string;
  dryRun: boolean;
};

function usage(): string {
  return [
    "Usage: node --import tsx scripts/personal-memory-apply-suggestion.ts (--json <json> | --json-file <file>) [options]",
    "",
    "Options:",
    "  --dir <dir>           Memory directory (default: personal-context)",
    "  --file <file>         Decision log file (default: 04-decision-log.md)",
    "  --json <json>         PersonalMemoryWriteSuggestion JSON payload",
    "  --json-file <file>    Path to suggestion JSON file",
    "  --dry-run             Print validated action without writing",
    "  -h, --help            Show help",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dir: "personal-context",
    file: "04-decision-log.md",
    dryRun: false,
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
      case "--json":
        if (!next) {
          throw new Error("--json requires a value");
        }
        args.json = next;
        i += 1;
        break;
      case "--json-file":
        if (!next) {
          throw new Error("--json-file requires a value");
        }
        args.jsonFile = next;
        i += 1;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.json && !args.jsonFile) {
    throw new Error("one of --json or --json-file is required");
  }
  if (args.json && args.jsonFile) {
    throw new Error("--json and --json-file are mutually exclusive");
  }
  return args;
}

function parseSuggestionPayload(raw: string): PersonalMemoryWriteSuggestion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  return assertApplicablePersonalMemorySuggestion(parsed);
}

function readSuggestionJson(args: Args): string {
  if (args.json) {
    return args.json;
  }
  const filePath = args.jsonFile!;
  return fs.readFileSync(filePath, "utf8");
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

  let suggestion: PersonalMemoryWriteSuggestion;
  try {
    suggestion = parseSuggestionPayload(readSuggestionJson(args));
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  let baseDir: string;
  try {
    baseDir = resolvePersonalContextDir(process.cwd(), args.dir);
    resolvePersonalContextFilePath(baseDir, args.file);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }
  if (args.file !== "04-decision-log.md") {
    console.error("ERROR: --file only supports 04-decision-log.md for L2 suggestion apply");
    process.exit(1);
    return;
  }

  const structured = suggestion.structured as Record<string, string>;
  if (args.dryRun) {
    const result = applyPersonalMemorySuggestion({
      suggestion,
      personalContextDir: baseDir,
      dryRun: true,
    });
    console.log(`DRY RUN: apply L2 suggestion to ${result.filePath}`);
    console.log("----- entry preview -----");
    console.log(result.entryPreview);
    console.log("----- end preview -----");
    process.exit(0);
  }

  const result = applyPersonalMemorySuggestion({
    suggestion,
    personalContextDir: baseDir,
    dryRun: false,
  });
  if (result.alreadyExists) {
    console.log(`Decision already exists, skipped: ${result.title}`);
  } else {
    console.log(`Applied L2 suggestion to decision-log: ${structured.title}`);
  }
  console.log(`Updated: ${result.filePath}`);
}

main();
