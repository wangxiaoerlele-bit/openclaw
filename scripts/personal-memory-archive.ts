#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  insertDecisionEntryIntoLog,
  parseDecisionEntriesFromLog,
  renderDecisionEntryMarkdown,
  replaceDecisionEntriesInLog,
  resolvePersonalContextDir,
  resolvePersonalContextFilePath,
  sortDecisionEntriesByDateDesc,
  type DecisionEntry,
  updateLastUpdatedLine,
} from "./personal-context-memory.ts";

type Args = {
  dir: string;
  file: string;
  archiveDir: string;
  archiveFile: string;
  retainDays: number;
  dryRun: boolean;
  json: boolean;
};

function usage(): string {
  return [
    "Usage: node --import tsx scripts/personal-memory-archive.ts [options]",
    "",
    "Archive old decision-log entries into personal-context/archive/*.md",
    "",
    "Options:",
    "  --dir <dir>            Memory directory (default: personal-context)",
    "  --file <file>          Decision log file (default: 04-decision-log.md)",
    "  --archive-dir <dir>    Archive dir under personal-context (default: archive)",
    "  --archive-file <file>  Archive file name (default: 04-decision-log.archive.md)",
    "  --retain-days <n>      Keep recent decisions in main log (default: 30)",
    "  --dry-run              Preview only",
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
    dir: "personal-context",
    file: "04-decision-log.md",
    archiveDir: "archive",
    archiveFile: "04-decision-log.archive.md",
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
      case "--file":
        if (!next) {
          throw new Error("--file requires a value");
        }
        args.file = next;
        i += 1;
        break;
      case "--archive-dir":
        if (!next) {
          throw new Error("--archive-dir requires a value");
        }
        args.archiveDir = next;
        i += 1;
        break;
      case "--archive-file":
        if (!next) {
          throw new Error("--archive-file requires a value");
        }
        args.archiveFile = next;
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

function parseIsoDateUtc(date: string): number | undefined {
  const t = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(t) ? t : undefined;
}

function todayLocalIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function archiveSeedText(): string {
  return [
    "# 04 Decision Log Archive",
    "",
    "> 自动归档旧决策，减少主决策日志噪音。",
    "",
    `- 最后更新日期： ${todayLocalIsoDate()}`,
    "",
    "## 决策记录",
    "",
    "### [YYYY-MM-DD]",
    "",
    "- 背景：",
    "- 决策：",
    "- 原因：",
    "- 备选方案（可选）：",
    "- 影响范围：",
    "- 后续动作：",
    "- 相关文件/链接：",
    "",
  ].join("\n");
}

function ensureArchiveFile(filePath: string) {
  if (fs.existsSync(filePath)) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, archiveSeedText(), "utf8");
}

function keyOf(entry: Pick<DecisionEntry, "date" | "title">): string {
  return `${entry.date}\u0000${entry.title.trim()}`;
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
  let mainLogPath: string;
  try {
    baseDir = resolvePersonalContextDir(process.cwd(), args.dir);
    mainLogPath = resolvePersonalContextFilePath(baseDir, args.file);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const archiveDirPath = path.join(baseDir, args.archiveDir.trim() || "archive");
  const archiveFilePath = path.join(
    archiveDirPath,
    args.archiveFile.trim() || "04-decision-log.archive.md",
  );
  if (path.relative(baseDir, archiveFilePath).startsWith("..")) {
    console.error("ERROR: archive file must stay within memory directory");
    process.exit(1);
    return;
  }

  try {
    const now = new Date();
    const cutoffMs = now.getTime() - args.retainDays * 24 * 3600 * 1000;
    const mainOriginal = fs.readFileSync(mainLogPath, "utf8");
    const mainEntries = parseDecisionEntriesFromLog(mainOriginal);
    const archiveOriginal = fs.existsSync(archiveFilePath)
      ? fs.readFileSync(archiveFilePath, "utf8")
      : archiveSeedText();
    const archiveEntries = parseDecisionEntriesFromLog(archiveOriginal);
    const archiveKeys = new Set(archiveEntries.map(keyOf));

    const toArchive: DecisionEntry[] = [];
    const keepInMain: DecisionEntry[] = [];
    for (const entry of mainEntries) {
      const ts = parseIsoDateUtc(entry.date);
      if (ts !== undefined && ts < cutoffMs) {
        toArchive.push(entry);
      } else {
        keepInMain.push(entry);
      }
    }

    const newArchiveEntries: DecisionEntry[] = [];
    let duplicates = 0;
    for (const entry of toArchive) {
      const k = keyOf(entry);
      if (archiveKeys.has(k)) {
        duplicates += 1;
        continue;
      }
      archiveKeys.add(k);
      newArchiveEntries.push(entry);
    }

    let nextArchiveText = archiveOriginal;
    for (const entry of sortDecisionEntriesByDateDesc(newArchiveEntries).toReversed()) {
      nextArchiveText = insertDecisionEntryIntoLog(
        nextArchiveText,
        renderDecisionEntryMarkdown(entry),
      );
    }

    const keptOrdered = sortDecisionEntriesByDateDesc(keepInMain);
    let nextMainText = replaceDecisionEntriesInLog(mainOriginal, keptOrdered);

    const newestMainDate = keptOrdered[0]?.date;
    const newestArchiveDate = sortDecisionEntriesByDateDesc([
      ...archiveEntries,
      ...newArchiveEntries,
    ])[0]?.date;
    if (newestMainDate) {
      nextMainText = updateLastUpdatedLine(nextMainText, newestMainDate).next;
    }
    if (newestArchiveDate) {
      nextArchiveText = updateLastUpdatedLine(nextArchiveText, newestArchiveDate).next;
    }

    if (!args.dryRun) {
      if (newArchiveEntries.length > 0) {
        if (!fs.existsSync(archiveFilePath)) {
          ensureArchiveFile(archiveFilePath);
        }
        fs.writeFileSync(archiveFilePath, nextArchiveText, "utf8");
      }
      if (toArchive.length > 0) {
        fs.writeFileSync(mainLogPath, nextMainText, "utf8");
      }
    }

    const payload = {
      dryRun: args.dryRun,
      retainDays: args.retainDays,
      cutoffDate: new Date(cutoffMs).toISOString().slice(0, 10),
      mainLogPath,
      archiveFilePath,
      mainBefore: mainEntries.length,
      mainAfter: keepInMain.length,
      archiveBefore: archiveEntries.length,
      archiveAdded: newArchiveEntries.length,
      duplicatesSkipped: duplicates,
      archivedCandidates: toArchive.length,
      archived: newArchiveEntries.map((entry) => ({ date: entry.date, title: entry.title })),
    };

    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`Decision archive: ${mainLogPath}`);
    console.log(`Cutoff: ${payload.cutoffDate} (retainDays=${args.retainDays})`);
    console.log(
      `Main ${payload.mainBefore} -> ${payload.mainAfter}; archived=${payload.archiveAdded} (duplicates skipped=${payload.duplicatesSkipped})`,
    );
    console.log(`Archive file: ${archiveFilePath}`);
    if (args.dryRun) {
      console.log("DRY RUN: no files written");
    }
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
