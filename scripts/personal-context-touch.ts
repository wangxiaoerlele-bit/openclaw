#!/usr/bin/env node
import fs from "node:fs";
import {
  isPersonalContextPathError,
  resolvePersonalContextDir,
  resolvePersonalContextFilePath,
  updateLastUpdatedLine,
} from "./personal-context-memory.ts";

type Args = {
  dir: string;
  date: string;
  files: string[];
  all: boolean;
  dryRun: boolean;
};

const DEFAULT_DIR = "personal-context";
const DEFAULT_FILES = [
  "00-identity.md",
  "01-current-focus.md",
  "02-projects.md",
  "03-working-rules.md",
  "04-decision-log.md",
];

function usage(): string {
  return [
    "Usage: node --import tsx scripts/personal-context-touch.ts [options]",
    "",
    "Options:",
    "  --dir <dir>          Memory directory (default: personal-context)",
    "  --date <YYYY-MM-DD>  Date to write (default: today local)",
    "  --file <name>        File to update (repeatable)",
    "  --all                Update all default memory files",
    "  --dry-run            Show planned updates only",
    "  -h, --help           Show help",
  ].join("\n");
}

function todayLocalIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dir: DEFAULT_DIR,
    date: todayLocalIsoDate(),
    files: [],
    all: false,
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
      case "--date":
        if (!next) {
          throw new Error("--date requires a value");
        }
        args.date = next;
        i += 1;
        break;
      case "--file":
        if (!next) {
          throw new Error("--file requires a value");
        }
        args.files.push(next);
        i += 1;
        break;
      case "--all":
        args.all = true;
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

  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error(`--date must be YYYY-MM-DD (got "${args.date}")`);
  }

  if (!args.all && args.files.length === 0) {
    args.all = true;
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

  const targets = args.all ? DEFAULT_FILES : args.files;
  const uniqueTargets = [...new Set(targets)];
  const results: Array<{
    file: string;
    status: "updated" | "unchanged" | "missing" | "no-field" | "invalid";
    detail?: string;
  }> = [];

  for (const file of uniqueTargets) {
    let filePath: string;
    try {
      filePath = resolvePersonalContextFilePath(baseDir, file);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        isPersonalContextPathError(err) &&
        (err.code === "FILE_NAME_EMPTY" ||
          err.code === "FILE_NAME_ABSOLUTE" ||
          err.code === "FILE_NAME_PATH_SEPARATOR" ||
          err.code === "FILE_NAME_DOT_DOT")
      ) {
        results.push({ file, status: "invalid", detail: message });
      } else {
        results.push({ file, status: "missing", detail: message });
      }
      continue;
    }
    const original = fs.readFileSync(filePath, "utf8");
    const { changed, next } = updateLastUpdatedLine(original, args.date);
    if (next === original && !/最后更新日期/.test(original)) {
      results.push({ file, status: "no-field" });
      continue;
    }
    if (!args.dryRun && changed) {
      fs.writeFileSync(filePath, next, "utf8");
    }
    results.push({ file, status: changed ? "updated" : "unchanged" });
  }

  const prefix = args.dryRun ? "DRY RUN" : "Updated";
  console.log(`${prefix} date=${args.date} in ${baseDir}`);
  for (const r of results) {
    console.log(`- ${r.file}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`);
  }

  if (results.some((r) => r.status === "missing" || r.status === "invalid")) {
    process.exitCode = 1;
  }
}

main();
