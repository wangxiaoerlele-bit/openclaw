#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  insertDecisionEntryIntoLog,
  insertMarkdownBlockUnderSection,
  parseDecisionEntriesFromLog,
  resolvePersonalContextDir,
  resolvePersonalContextFilePath,
  resolveWorkspaceReadableFilePath,
  sortDecisionEntriesByDateDesc,
  type DecisionEntry,
  updateLastUpdatedLine,
} from "./personal-context-memory.ts";

type TargetKind = "decision-log" | "current-focus" | "projects" | "identity" | "working-rules";

type Args = {
  dir: string;
  targetFile: string;
  targetKind?: TargetKind;
  from: string[];
  mergeProjectOverview: boolean;
  dryRun: boolean;
  json: boolean;
};

type SourceReport = {
  source: string;
  mode: "decision-log" | "loose" | "snapshot" | "projects-structured";
  parsed: number;
  imported: number;
  duplicates: number;
};

type LegacyProjectRow = {
  name: string;
  type?: string;
  stage?: string;
  priority?: string;
  next?: string;
  statusSummary?: string;
};

function usage(): string {
  return [
    "Usage: node --import tsx scripts/personal-memory-migrate-legacy.ts --from <file> [--from <file> ...] [options]",
    "",
    "Migrate legacy markdown into personal-context files.",
    "Default target is decision-log (structured entry import); non decision-log targets use snapshot import blocks.",
    "",
    "Options:",
    "  --dir <dir>         Memory directory (default: personal-context)",
    "  --target-file <f>   Target file (default: 04-decision-log.md)",
    "  --target-kind <k>   decision-log | current-focus | projects | identity | working-rules (default: infer from target-file)",
    "  --from <file>       Legacy markdown file within current workspace (repeatable, required)",
    "  --merge-project-overview  For target-kind=projects, upsert parsed rows into overview table",
    "  --dry-run           Preview only; do not write",
    "  --json              Output JSON summary",
    "  -h, --help          Show help",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dir: "personal-context",
    targetFile: "04-decision-log.md",
    from: [],
    mergeProjectOverview: false,
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
      case "--target-file":
        if (!next) {
          throw new Error("--target-file requires a value");
        }
        args.targetFile = next;
        i += 1;
        break;
      case "--target-kind":
        if (!next) {
          throw new Error("--target-kind requires a value");
        }
        if (
          next !== "decision-log" &&
          next !== "current-focus" &&
          next !== "projects" &&
          next !== "identity" &&
          next !== "working-rules"
        ) {
          throw new Error(
            "--target-kind must be one of: decision-log, current-focus, projects, identity, working-rules",
          );
        }
        args.targetKind = next;
        i += 1;
        break;
      case "--from":
        if (!next) {
          throw new Error("--from requires a value");
        }
        args.from.push(next);
        i += 1;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--merge-project-overview":
        args.mergeProjectOverview = true;
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
  if (args.from.length === 0) {
    throw new Error("at least one --from <file> is required");
  }
  return args;
}

function parseLastUpdatedDate(text: string): string | undefined {
  const m = text.match(
    /^[ \t]*[-*]?[ \t]*最后更新日期[ \t]*[:：][ \t]*(\d{4}-\d{2}-\d{2})[ \t]*$/m,
  );
  return m?.[1];
}

function inferTargetKindFromFile(fileName: string): TargetKind {
  if (fileName.includes("decision")) {
    return "decision-log";
  }
  if (fileName.includes("current-focus")) {
    return "current-focus";
  }
  if (fileName.includes("projects")) {
    return "projects";
  }
  if (fileName.includes("identity")) {
    return "identity";
  }
  if (fileName.includes("working-rules")) {
    return "working-rules";
  }
  return "decision-log";
}

function todayLocalIsoDate(): string {
  return new Date().toLocaleDateString("sv-SE");
}

function validateTargetCompatibility(targetFile: string, targetKind: TargetKind): void {
  const inferred = inferTargetKindFromFile(targetFile);
  // For custom filenames, inference falls back to decision-log; only enforce explicit known mappings.
  if (inferred !== "decision-log" && inferred !== targetKind) {
    throw new Error(
      `target-kind "${targetKind}" does not match target-file "${targetFile}" (inferred ${inferred})`,
    );
  }
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function summarizeMarkdown(text: string): string {
  const normalized = normalizeNewlines(text);
  const heading = normalized.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) {
    return heading;
  }
  const line = normalized
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("#") && !s.startsWith(">"));
  return line ?? "导入旧版快照";
}

function clipMarkdown(text: string, maxChars = 1800): string {
  const normalized = normalizeNewlines(text).trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}\n...`;
}

function buildSnapshotImportBlock(params: {
  date: string;
  sourceRel: string;
  sourceText: string;
}): string {
  const summary = summarizeMarkdown(params.sourceText);
  const excerpt = clipMarkdown(params.sourceText);
  const fence = excerpt.includes("```") ? "````" : "```";
  return [
    `### [${params.date}] 迁移：${params.sourceRel}`,
    "",
    `- 来源：${params.sourceRel}`,
    "- 导入方式：legacy-snapshot",
    `- 摘要：${summary}`,
    "",
    "#### 快照摘录",
    "",
    `${fence}md`,
    excerpt,
    fence,
    "",
  ].join("\n");
}

function normalizeProjectCell(value: string | undefined, fallback = "(待补充)"): string {
  const text = (value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " / ")
    .replaceAll("|", "\\|")
    .trim();
  return text || fallback;
}

function parseMarkdownProjectRows(text: string): LegacyProjectRow[] {
  const lines = normalizeNewlines(text).split("\n");
  for (let i = 0; i + 2 < lines.length; i += 1) {
    const headerLine = lines[i]?.trim();
    const separatorLine = lines[i + 1]?.trim();
    if (!headerLine || !separatorLine) {
      continue;
    }
    if (!headerLine.includes("|") || !separatorLine.includes("|")) {
      continue;
    }
    const headers = headerLine
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (headers.length < 2 || !headers.includes("项目")) {
      continue;
    }
    const isSeparator = separatorLine
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .every((cell) => /^:?-{3,}:?$/.test(cell));
    if (!isSeparator) {
      continue;
    }
    const headerIndex = new Map(headers.map((header, idx) => [header, idx]));
    const rows: LegacyProjectRow[] = [];
    for (let j = i + 2; j < lines.length; j += 1) {
      const rowLine = lines[j]?.trim() ?? "";
      if (!rowLine.startsWith("|") || !rowLine.includes("|")) {
        break;
      }
      const cells = rowLine
        .split("|")
        .map((cell) => cell.trim())
        .filter(
          (_, idx, arr) =>
            !(idx === 0 && arr[0] === "") && !(idx === arr.length - 1 && arr[idx] === ""),
        );
      if (cells.every((cell) => !cell)) {
        continue;
      }
      const name = cells[headerIndex.get("项目") ?? -1]?.trim();
      if (!name || name.includes("示例")) {
        continue;
      }
      rows.push({
        name,
        type: cells[headerIndex.get("类型") ?? -1],
        stage: cells[headerIndex.get("当前阶段") ?? -1] ?? cells[headerIndex.get("阶段") ?? -1],
        priority: cells[headerIndex.get("优先级") ?? -1],
        next:
          cells[headerIndex.get("下一步") ?? -1] ??
          cells[headerIndex.get("下一步动作") ?? -1] ??
          cells[headerIndex.get("后续动作") ?? -1],
        statusSummary:
          cells[headerIndex.get("当前状态") ?? -1] ?? cells[headerIndex.get("状态摘要") ?? -1],
      });
    }
    if (rows.length > 0) {
      return rows;
    }
  }
  return [];
}

function parseSectionField(block: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const m = block.match(new RegExp(`^- ${label}[：:]\\s*(.*)$`, "m"));
    const value = m?.[1]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function parseSectionProjectRows(text: string): LegacyProjectRow[] {
  const normalized = normalizeNewlines(text);
  const headerRe = /^##\s+(.+)$/gm;
  const matches = Array.from(normalized.matchAll(headerRe));
  const rows: LegacyProjectRow[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const heading = (matches[i]?.[1] ?? "").trim();
    if (!heading || heading.includes("项目状态") || heading.includes("总览")) {
      continue;
    }
    const start = (matches[i]?.index ?? 0) + (matches[i]?.[0]?.length ?? 0);
    const end =
      i + 1 < matches.length ? (matches[i + 1]?.index ?? normalized.length) : normalized.length;
    const block = normalized.slice(start, end);
    const next = parseSectionField(block, ["下一步", "下一步动作", "后续动作"]);
    const statusSummary = parseSectionField(block, ["当前状态", "状态", "进展"]);
    const stage = parseSectionField(block, ["当前阶段", "阶段"]);
    const type = parseSectionField(block, ["项目类型", "类型"]);
    const priority = parseSectionField(block, ["优先级"]);
    if (!next && !statusSummary && !stage && !priority && !type) {
      continue;
    }
    rows.push({
      name: heading,
      type,
      stage: stage ?? statusSummary,
      priority,
      next,
      statusSummary,
    });
  }
  return rows;
}

function parseStructuredLegacyProjectRows(text: string): LegacyProjectRow[] {
  const fromTable = parseMarkdownProjectRows(text);
  if (fromTable.length > 0) {
    return fromTable;
  }
  return parseSectionProjectRows(text);
}

function buildStructuredProjectImportBlock(params: {
  date: string;
  sourceRel: string;
  rows: LegacyProjectRow[];
}): string {
  const tableLines = [
    "| 项目 | 类型 | 当前阶段 | 优先级 | 下一步 | 状态摘要 |",
    "| ---- | ---- | -------- | ------ | ------ | -------- |",
    ...params.rows.map((row) =>
      [
        "|",
        normalizeProjectCell(row.name),
        "|",
        normalizeProjectCell(row.type),
        "|",
        normalizeProjectCell(row.stage),
        "|",
        normalizeProjectCell(row.priority),
        "|",
        normalizeProjectCell(row.next),
        "|",
        normalizeProjectCell(row.statusSummary),
        "|",
      ].join(" "),
    ),
  ];
  return [
    `### [${params.date}] 迁移项目状态：${params.sourceRel}`,
    "",
    `- 来源：${params.sourceRel}`,
    "- 导入方式：legacy-projects-structured",
    `- 解析项目数：${params.rows.length}`,
    "",
    "#### 结构化项目状态",
    "",
    ...tableLines,
    "",
  ].join("\n");
}

type ProjectOverviewRow = {
  name: string;
  type: string;
  stage: string;
  priority: string;
  next: string;
};

function parseMarkdownTableCells(line: string): string[] {
  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter(
      (_, idx, arr) =>
        !(idx === 0 && arr[0] === "") && !(idx === arr.length - 1 && arr[idx] === ""),
    );
}

function parseProjectOverviewTable(text: string): {
  rows: ProjectOverviewRow[];
  tableText: string;
} | null {
  const sectionMatch = text.match(/## 项目清单（总览）\s*\n+([\s\S]*?)(?:\n##\s+|$)/);
  const sectionBody = sectionMatch?.[1];
  if (!sectionBody) {
    return null;
  }
  const lines = sectionBody.split("\n");
  for (let i = 0; i + 2 < lines.length; i += 1) {
    const header = (lines[i] ?? "").trim();
    const sep = (lines[i + 1] ?? "").trim();
    if (!header.startsWith("|") || !sep.startsWith("|")) {
      continue;
    }
    const headers = parseMarkdownTableCells(header);
    const required = ["项目", "类型", "当前阶段", "优先级", "下一步"];
    if (!required.every((col) => headers.includes(col))) {
      continue;
    }
    const sepOk = parseMarkdownTableCells(sep).every((cell) => /^:?-{3,}:?$/.test(cell));
    if (!sepOk) {
      continue;
    }
    const headerIndex = new Map(headers.map((h, idx) => [h, idx]));
    const rows: ProjectOverviewRow[] = [];
    let end = i + 2;
    for (let j = i + 2; j < lines.length; j += 1) {
      const rowLine = (lines[j] ?? "").trim();
      if (!rowLine.startsWith("|")) {
        break;
      }
      end = j + 1;
      const cells = parseMarkdownTableCells(rowLine);
      const name = cells[headerIndex.get("项目") ?? -1]?.trim() ?? "";
      if (!name) {
        continue;
      }
      rows.push({
        name,
        type: cells[headerIndex.get("类型") ?? -1]?.trim() ?? "",
        stage: cells[headerIndex.get("当前阶段") ?? -1]?.trim() ?? "",
        priority: cells[headerIndex.get("优先级") ?? -1]?.trim() ?? "",
        next: cells[headerIndex.get("下一步") ?? -1]?.trim() ?? "",
      });
    }
    return {
      rows,
      tableText: lines.slice(i, end).join("\n"),
    };
  }
  return null;
}

function renderProjectOverviewTable(rows: ProjectOverviewRow[]): string {
  const normalizedRows = rows.map((row) => ({
    name: normalizeProjectCell(row.name),
    type: normalizeProjectCell(row.type),
    stage: normalizeProjectCell(row.stage),
    priority: normalizeProjectCell(row.priority),
    next: normalizeProjectCell(row.next),
  }));
  const colWidths = {
    name: Math.max("项目".length, ...normalizedRows.map((r) => r.name.length)),
    type: Math.max("类型".length, ...normalizedRows.map((r) => r.type.length)),
    stage: Math.max("当前阶段".length, ...normalizedRows.map((r) => r.stage.length)),
    priority: Math.max("优先级".length, ...normalizedRows.map((r) => r.priority.length)),
    next: Math.max("下一步".length, ...normalizedRows.map((r) => r.next.length)),
  };
  const row = (cells: [string, string, string, string, string]) =>
    `| ${cells[0].padEnd(colWidths.name)} | ${cells[1].padEnd(colWidths.type)} | ${cells[2].padEnd(colWidths.stage)} | ${cells[3].padEnd(colWidths.priority)} | ${cells[4].padEnd(colWidths.next)} |`;
  const sep = (n: number) => "-".repeat(Math.max(3, n));
  return [
    row(["项目", "类型", "当前阶段", "优先级", "下一步"]),
    `| ${sep(colWidths.name)} | ${sep(colWidths.type)} | ${sep(colWidths.stage)} | ${sep(colWidths.priority)} | ${sep(colWidths.next)} |`,
    ...normalizedRows.map((r) => row([r.name, r.type, r.stage, r.priority, r.next])),
  ].join("\n");
}

function mergeProjectsIntoOverviewTable(
  targetText: string,
  rows: LegacyProjectRow[],
): {
  changed: boolean;
  next: string;
  mergedRows: number;
  insertedRows: number;
} {
  const parsed = parseProjectOverviewTable(targetText);
  if (!parsed) {
    return { changed: false, next: targetText, mergedRows: 0, insertedRows: 0 };
  }
  const map = new Map(parsed.rows.map((row) => [row.name, { ...row }]));
  let mergedRows = 0;
  let insertedRows = 0;
  for (const legacy of rows) {
    const name = legacy.name.trim();
    if (!name) {
      continue;
    }
    const existing = map.get(name);
    if (existing) {
      const before = JSON.stringify(existing);
      if (legacy.type?.trim()) {
        existing.type = legacy.type.trim();
      }
      if (legacy.stage?.trim()) {
        existing.stage = legacy.stage.trim();
      }
      if (legacy.priority?.trim()) {
        existing.priority = legacy.priority.trim();
      }
      if (legacy.next?.trim()) {
        existing.next = legacy.next.trim();
      }
      if (JSON.stringify(existing) !== before) {
        mergedRows += 1;
      }
      continue;
    }
    map.set(name, {
      name,
      type: legacy.type?.trim() ?? "",
      stage: legacy.stage?.trim() ?? "",
      priority: legacy.priority?.trim() ?? "",
      next: legacy.next?.trim() ?? "",
    });
    insertedRows += 1;
  }
  if (mergedRows === 0 && insertedRows === 0) {
    return { changed: false, next: targetText, mergedRows, insertedRows };
  }
  const ordered = [...map.values()].toSorted((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const nextTable = renderProjectOverviewTable(ordered);
  const nextText = targetText.replace(parsed.tableText, nextTable);
  return { changed: nextText !== targetText, next: nextText, mergedRows, insertedRows };
}

function insertProjectStructuredImportBlock(params: { targetText: string; block: string }): string {
  const withStructuredSection = insertMarkdownBlockUnderSection({
    text: params.targetText,
    sectionHeading: "历史迁移项目状态（结构化）",
    block: params.block,
    beforeHeading: "历史迁移快照",
  });
  if (withStructuredSection !== params.targetText) {
    return withStructuredSection;
  }
  return insertMarkdownBlockUnderSection({
    text: params.targetText,
    sectionHeading: "历史迁移项目状态（结构化）",
    block: params.block,
    beforeHeading: "更新规则",
  });
}

function insertSnapshotImportBlock(params: { targetText: string; block: string }): string {
  return insertMarkdownBlockUnderSection({
    text: params.targetText,
    sectionHeading: "历史迁移快照",
    block: params.block,
    beforeHeading: "更新规则",
  });
}

function normalizeInline(text: string | undefined): string {
  return (text ?? "").trim() || "(待补充)";
}

function buildDecisionEntryMarkdown(entry: DecisionEntry): string {
  return [
    `### [${entry.date}] ${entry.title}`,
    "",
    `- 背景：${normalizeInline(entry.background)}`,
    `- 决策：${normalizeInline(entry.decision)}`,
    `- 原因：${normalizeInline(entry.reason)}`,
    `- 备选方案（可选）：(待补充)`,
    `- 影响范围：${normalizeInline(entry.impact)}`,
    `- 后续动作：${normalizeInline(entry.next)}`,
    `- 相关文件/链接：${normalizeInline(entry.links)}`,
    "",
  ].join("\n");
}

function parseLooseDecisionEntries(text: string): DecisionEntry[] {
  const headerRe = /^### \[(\d{4}-\d{2}-\d{2})\]\s+(.+)$/gm;
  const matches = Array.from(text.matchAll(headerRe));
  const entries: DecisionEntry[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const date = m[1]?.trim();
    const title = m[2]?.trim();
    if (!date || !title || title.includes("示例") || title === "决策标题") {
      continue;
    }
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const block = text.slice(start, end);
    const getField = (label: string) => {
      const mm = block.match(new RegExp(`^- ${label}[：:]\\s*(.*)$`, "m"));
      return mm?.[1]?.trim() || undefined;
    };
    entries.push({
      date,
      title,
      background: getField("背景"),
      decision: getField("决策"),
      reason: getField("原因"),
      impact: getField("影响范围"),
      next: getField("后续动作"),
      links: getField("相关文件/链接"),
    });
  }
  return entries;
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
  let targetPath: string;
  let sourcePaths: string[];
  try {
    baseDir = resolvePersonalContextDir(process.cwd(), args.dir);
    targetPath = resolvePersonalContextFilePath(baseDir, args.targetFile);
    sourcePaths = args.from.map((file) => resolveWorkspaceReadableFilePath(process.cwd(), file));
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  try {
    const original = fs.readFileSync(targetPath, "utf8");
    const targetKind = args.targetKind ?? inferTargetKindFromFile(args.targetFile);
    validateTargetCompatibility(args.targetFile, targetKind);
    if (args.mergeProjectOverview && targetKind !== "projects") {
      throw new Error("--merge-project-overview is only supported with --target-kind projects");
    }
    if (targetKind !== "decision-log") {
      let nextText = original;
      const sourceReports: SourceReport[] = [];
      const importedBlocks: Array<{ date: string; source: string }> = [];
      let imported = 0;
      let duplicates = 0;
      let overviewMergedRows = 0;
      let overviewInsertedRows = 0;
      let overviewTableUpdated = false;
      let latestImportedDate: string | undefined;
      for (const sourcePath of sourcePaths) {
        const sourceText = fs.readFileSync(sourcePath, "utf8");
        const sourceRel = path.relative(process.cwd(), sourcePath) || sourcePath;
        const date = parseLastUpdatedDate(sourceText) ?? todayLocalIsoDate();
        let block = buildSnapshotImportBlock({ date, sourceRel, sourceText });
        let mode: SourceReport["mode"] = "snapshot";
        let parsed = 1;
        const structuredRows =
          targetKind === "projects" ? parseStructuredLegacyProjectRows(sourceText) : [];
        if (targetKind === "projects" && structuredRows.length > 0) {
          block = buildStructuredProjectImportBlock({ date, sourceRel, rows: structuredRows });
          mode = "projects-structured";
          parsed = structuredRows.length;
          if (args.mergeProjectOverview) {
            const merged = mergeProjectsIntoOverviewTable(nextText, structuredRows);
            nextText = merged.next;
            overviewMergedRows += merged.mergedRows;
            overviewInsertedRows += merged.insertedRows;
            overviewTableUpdated ||= merged.changed;
          }
        }
        const headingLine = block.split(/\r?\n/, 1)[0] ?? "";
        if (nextText.includes(headingLine)) {
          duplicates += parsed;
          sourceReports.push({
            source: sourceRel,
            mode,
            parsed,
            imported: 0,
            duplicates: parsed,
          });
          continue;
        }
        nextText =
          mode === "projects-structured"
            ? insertProjectStructuredImportBlock({ targetText: nextText, block })
            : insertSnapshotImportBlock({ targetText: nextText, block });
        imported += parsed;
        importedBlocks.push({ date, source: sourceRel });
        if (!latestImportedDate || date > latestImportedDate) {
          latestImportedDate = date;
        }
        sourceReports.push({
          source: sourceRel,
          mode,
          parsed,
          imported: parsed,
          duplicates: 0,
        });
      }
      const currentLastUpdated = parseLastUpdatedDate(original);
      const finalLastUpdated =
        latestImportedDate && (!currentLastUpdated || latestImportedDate > currentLastUpdated)
          ? latestImportedDate
          : currentLastUpdated;
      if (finalLastUpdated) {
        nextText = updateLastUpdatedLine(nextText, finalLastUpdated).next;
      }
      const payload = {
        dryRun: args.dryRun,
        targetKind,
        targetPath,
        mergeProjectOverview: args.mergeProjectOverview,
        overviewTableUpdated,
        overviewMergedRows,
        overviewInsertedRows,
        sources: sourceReports,
        imported,
        duplicates,
        latestImportedDate,
        importedEntries: importedBlocks,
      };
      if (!args.dryRun && imported > 0) {
        fs.writeFileSync(targetPath, nextText, "utf8");
      }
      if (args.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(`Legacy snapshot migration (${targetKind}): ${targetPath}`);
      console.log(`Imported: ${imported} (duplicates skipped=${duplicates})`);
      if (args.dryRun) {
        console.log("DRY RUN: no files written");
      }
      return;
    }

    const existing = parseDecisionEntriesFromLog(original);
    const existingKeys = new Set(existing.map(keyOf));
    const importKeys = new Set<string>();
    const toImport: DecisionEntry[] = [];
    const sourceReports: SourceReport[] = [];

    for (const sourcePath of sourcePaths) {
      const text = fs.readFileSync(sourcePath, "utf8");
      let entries = parseDecisionEntriesFromLog(text);
      let mode: SourceReport["mode"] = "decision-log";
      if (entries.length === 0) {
        entries = parseLooseDecisionEntries(text);
        mode = "loose";
      }
      let imported = 0;
      let duplicates = 0;
      for (const entry of entries) {
        const k = keyOf(entry);
        if (existingKeys.has(k) || importKeys.has(k)) {
          duplicates += 1;
          continue;
        }
        importKeys.add(k);
        toImport.push(entry);
        imported += 1;
      }
      sourceReports.push({
        source: path.relative(process.cwd(), sourcePath) || sourcePath,
        mode,
        parsed: entries.length,
        imported,
        duplicates,
      });
    }

    const ordered = sortDecisionEntriesByDateDesc(toImport).toReversed();
    let nextText = original;
    let latestImportedDate: string | undefined;
    for (const entry of ordered) {
      nextText = insertDecisionEntryIntoLog(nextText, buildDecisionEntryMarkdown(entry));
      if (!latestImportedDate || entry.date > latestImportedDate) {
        latestImportedDate = entry.date;
      }
    }
    const currentLastUpdated = parseLastUpdatedDate(original);
    const finalLastUpdated =
      latestImportedDate && (!currentLastUpdated || latestImportedDate > currentLastUpdated)
        ? latestImportedDate
        : currentLastUpdated;
    if (finalLastUpdated) {
      nextText = updateLastUpdatedLine(nextText, finalLastUpdated).next;
    }

    const payload = {
      dryRun: args.dryRun,
      targetPath,
      sources: sourceReports,
      totalParsed: sourceReports.reduce((sum, item) => sum + item.parsed, 0),
      imported: toImport.length,
      duplicates: sourceReports.reduce((sum, item) => sum + item.duplicates, 0),
      latestImportedDate,
      importedEntries: sortDecisionEntriesByDateDesc(toImport).map((entry) => ({
        date: entry.date,
        title: entry.title,
      })),
    };

    if (!args.dryRun && toImport.length > 0) {
      fs.writeFileSync(targetPath, nextText, "utf8");
    }

    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Legacy decision migration: ${targetPath}`);
    console.log(`Imported: ${payload.imported} (duplicates skipped=${payload.duplicates})`);
    for (const source of sourceReports) {
      console.log(
        `- ${source.source} [${source.mode}] parsed=${source.parsed} imported=${source.imported} duplicates=${source.duplicates}`,
      );
    }
    if (args.dryRun) {
      console.log("DRY RUN: no files written");
    }
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
