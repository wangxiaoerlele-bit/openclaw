#!/usr/bin/env node
import fs from "node:fs";
import {
  insertDecisionEntryIntoLog,
  resolvePersonalContextDir,
  resolvePersonalContextFilePath,
  updateLastUpdatedLine,
} from "./personal-context-memory.ts";

type Args = {
  dir: string;
  file: string;
  date: string;
  title: string;
  background: string;
  decision: string;
  reason: string;
  alternatives?: string;
  impact?: string;
  next?: string;
  links?: string;
  dryRun: boolean;
};

function usage(): string {
  return [
    "Usage: node --import tsx scripts/personal-context-add-decision.ts --title <title> --background <text> --decision <text> --reason <text> [options]",
    "",
    "Options:",
    "  --dir <dir>            Memory directory (default: personal-context)",
    "  --file <file>          Decision log file (default: 04-decision-log.md)",
    "  --date <YYYY-MM-DD>    Entry date (default: today local)",
    "  --title <text>         Decision title (required)",
    "  --background <text>    Background (required)",
    "  --decision <text>      Decision (required)",
    "  --reason <text>        Reason (required)",
    "  --alternatives <text>  Alternatives (optional)",
    "  --impact <text>        Impact scope (optional)",
    "  --next <text>          Next actions (optional)",
    "  --links <text>         Related files/links (optional)",
    "  --dry-run              Print result preview without writing",
    "  -h, --help             Show help",
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
    dir: "personal-context",
    file: "04-decision-log.md",
    date: todayLocalIsoDate(),
    title: "",
    background: "",
    decision: "",
    reason: "",
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
      case "--date":
        if (!next) {
          throw new Error("--date requires a value");
        }
        args.date = next;
        i += 1;
        break;
      case "--title":
        if (!next) {
          throw new Error("--title requires a value");
        }
        args.title = next;
        i += 1;
        break;
      case "--background":
        if (!next) {
          throw new Error("--background requires a value");
        }
        args.background = next;
        i += 1;
        break;
      case "--decision":
        if (!next) {
          throw new Error("--decision requires a value");
        }
        args.decision = next;
        i += 1;
        break;
      case "--reason":
        if (!next) {
          throw new Error("--reason requires a value");
        }
        args.reason = next;
        i += 1;
        break;
      case "--alternatives":
        if (!next) {
          throw new Error("--alternatives requires a value");
        }
        args.alternatives = next;
        i += 1;
        break;
      case "--impact":
        if (!next) {
          throw new Error("--impact requires a value");
        }
        args.impact = next;
        i += 1;
        break;
      case "--next":
        if (!next) {
          throw new Error("--next requires a value");
        }
        args.next = next;
        i += 1;
        break;
      case "--links":
        if (!next) {
          throw new Error("--links requires a value");
        }
        args.links = next;
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

  for (const [key, value] of [
    ["title", args.title],
    ["background", args.background],
    ["decision", args.decision],
    ["reason", args.reason],
  ] as const) {
    if (!value.trim()) {
      throw new Error(`--${key} is required`);
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error(`--date must be YYYY-MM-DD (got "${args.date}")`);
  }

  return args;
}

function normalizeInline(text: string | undefined): string {
  return (text ?? "").trim() || "(待补充)";
}

function buildDecisionEntry(args: Args): string {
  return [
    `### [${args.date}] ${args.title.trim()}`,
    "",
    `- 背景：${normalizeInline(args.background)}`,
    `- 决策：${normalizeInline(args.decision)}`,
    `- 原因：${normalizeInline(args.reason)}`,
    `- 备选方案（可选）：${normalizeInline(args.alternatives)}`,
    `- 影响范围：${normalizeInline(args.impact)}`,
    `- 后续动作：${normalizeInline(args.next)}`,
    `- 相关文件/链接：${normalizeInline(args.links)}`,
    "",
  ].join("\n");
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

  let filePath: string;
  try {
    const baseDir = resolvePersonalContextDir(process.cwd(), args.dir);
    filePath = resolvePersonalContextFilePath(baseDir, args.file);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const original = fs.readFileSync(filePath, "utf8");
  const entry = buildDecisionEntry(args);
  const withUpdatedDate = updateLastUpdatedLine(original, args.date).next;
  const nextText = insertDecisionEntryIntoLog(withUpdatedDate, entry);

  if (args.dryRun) {
    console.log(`DRY RUN: ${filePath}`);
    console.log("----- entry preview -----");
    console.log(entry.trimEnd());
    console.log("----- end preview -----");
    process.exit(0);
  }

  fs.writeFileSync(filePath, nextText, "utf8");
  console.log(`Added decision entry: ${args.title}`);
  console.log(`Updated: ${filePath}`);
}

main();
