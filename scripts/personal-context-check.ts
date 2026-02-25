#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  parseDecisionEntriesFromLog,
  resolvePersonalContextDir,
  resolvePersonalContextFilePath,
} from "./personal-context-memory.ts";

type CheckResult = {
  ok: boolean;
  warnings: string[];
  errors: string[];
};

type MemoryFileSpec = {
  file: string;
  requiredHeading?: string;
  staleAfterDays?: number;
};

const DEFAULT_DIR = "personal-context";

const REQUIRED_FILES: MemoryFileSpec[] = [
  { file: "00-identity.md", requiredHeading: "# 00 Identity" },
  { file: "01-current-focus.md", requiredHeading: "# 01 Current Focus", staleAfterDays: 14 },
  { file: "02-projects.md", requiredHeading: "# 02 Projects", staleAfterDays: 30 },
  { file: "03-working-rules.md", requiredHeading: "# 03 Working Rules", staleAfterDays: 90 },
  { file: "04-decision-log.md", requiredHeading: "# 04 Decision Log", staleAfterDays: 30 },
];

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function findLastUpdated(text: string): string | null {
  const match = text.match(/^[ \t]*[-*]?[ \t]*最后更新日期[ \t]*[:：][ \t]*(.*)[ \t]*$/m);
  if (!match) {
    return null;
  }
  const value = (match[1] ?? "").trim();
  return value || "";
}

function parseDateDaysAgo(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!iso) {
    return null;
  }
  const d = new Date(`${iso[1]}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  const ms = Date.now() - d.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function checkFile(baseDir: string, spec: MemoryFileSpec): CheckResult {
  const result: CheckResult = { ok: true, warnings: [], errors: [] };
  const filePath = path.join(baseDir, spec.file);
  const text = readText(filePath);
  if (text == null) {
    result.ok = false;
    result.errors.push(`Missing file: ${spec.file}`);
    return result;
  }

  if (spec.requiredHeading && !text.includes(spec.requiredHeading)) {
    result.warnings.push(`Unexpected heading in ${spec.file} (expected ${spec.requiredHeading})`);
  }

  const lastUpdated = findLastUpdated(text);
  if (lastUpdated === "") {
    result.warnings.push(`${spec.file}: "最后更新日期" is present but empty`);
  } else if (lastUpdated == null) {
    result.warnings.push(`${spec.file}: missing "最后更新日期" field`);
  } else if (spec.staleAfterDays != null) {
    const daysAgo = parseDateDaysAgo(lastUpdated);
    if (daysAgo == null) {
      result.warnings.push(`${spec.file}: could not parse last update date "${lastUpdated}"`);
    } else if (daysAgo > spec.staleAfterDays) {
      result.warnings.push(
        `${spec.file}: appears stale (${daysAgo} days since update; threshold ${spec.staleAfterDays})`,
      );
    }
  }

  if (spec.file === "01-current-focus.md") {
    const priorityCount = (text.match(/^\d+\.\s+/gm) ?? []).length;
    if (priorityCount > 8) {
      result.warnings.push(
        `${spec.file}: too many numbered items (${priorityCount}); consider pruning`,
      );
    }
  }

  if (spec.file === "04-decision-log.md") {
    const count = parseDecisionEntriesFromLog(text).length;
    if (count === 0) {
      result.warnings.push(`${spec.file}: no dated decision entries found yet`);
    }
  }

  return result;
}

function printUsage() {
  console.log(
    "Usage: node --import tsx scripts/personal-context-check.ts [--dir personal-context]",
  );
}

function main() {
  let dir = DEFAULT_DIR;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dir") {
      dir = args[i + 1] ?? dir;
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
    console.error(`Unknown argument: ${arg}`);
    printUsage();
    process.exit(2);
  }

  let baseDir: string;
  try {
    baseDir = resolvePersonalContextDir(process.cwd(), dir);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  console.log(`Checking personal context: ${baseDir}`);

  let hasErrors = false;
  const allWarnings: string[] = [];
  for (const spec of REQUIRED_FILES) {
    try {
      resolvePersonalContextFilePath(baseDir, spec.file, { mustExist: false });
    } catch (err) {
      hasErrors = true;
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const res = checkFile(baseDir, spec);
    if (!res.ok) {
      hasErrors = true;
    }
    for (const err of res.errors) {
      console.error(`ERROR: ${err}`);
    }
    allWarnings.push(...res.warnings);
  }

  for (const warning of allWarnings) {
    console.warn(`WARN: ${warning}`);
  }

  if (hasErrors) {
    process.exit(1);
  }

  console.log(`OK: required files present (${REQUIRED_FILES.length})`);
  if (allWarnings.length > 0) {
    console.log(`Warnings: ${allWarnings.length}`);
  } else {
    console.log("Warnings: 0");
  }
}

main();
