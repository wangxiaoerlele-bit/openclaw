import fs from "node:fs";
import path from "node:path";
import type { PersonalMemoryWriteSuggestion } from "./types.js";

const DECISION_LOG_FILE = "04-decision-log.md";

export class PersonalMemoryApplySuggestionError extends Error {
  constructor(
    public readonly code:
      | "INVALID_SUGGESTION"
      | "CONTEXT_DIR_NOT_FOUND"
      | "DECISION_LOG_NOT_FOUND"
      | "WRITE_FAILED",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PersonalMemoryApplySuggestionError";
  }
}

function normalizeInline(text: string | undefined): string {
  return (text ?? "").trim() || "(待补充)";
}

function buildDecisionEntryFromStructured(structured: Record<string, string>): {
  date: string;
  title: string;
  entry: string;
} {
  const date = structured.date?.trim();
  const title = structured.title?.trim();
  if (!date || !title) {
    throw new PersonalMemoryApplySuggestionError(
      "INVALID_SUGGESTION",
      "suggestion.structured must include date and title",
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new PersonalMemoryApplySuggestionError(
      "INVALID_SUGGESTION",
      `invalid structured.date: ${date}`,
    );
  }
  const entry = [
    `### [${date}] ${title}`,
    "",
    `- 背景：${normalizeInline(structured.background)}`,
    `- 决策：${normalizeInline(structured.decision)}`,
    `- 原因：${normalizeInline(structured.reason)}`,
    `- 备选方案（可选）：${normalizeInline(structured.alternatives)}`,
    `- 影响范围：${normalizeInline(structured.impact)}`,
    `- 后续动作：${normalizeInline(structured.next)}`,
    `- 相关文件/链接：${normalizeInline(structured.links)}`,
    "",
  ].join("\n");
  return { date, title, entry };
}

function updateLastUpdatedLine(text: string, date: string): string {
  const lineRe = /^([ \t]*[-*]?[ \t]*最后更新日期[ \t]*[:：])[ \t]*.*$/m;
  if (!lineRe.test(text)) {
    return text;
  }
  return text.replace(lineRe, `$1 ${date}`);
}

function insertDecisionEntryIntoLog(text: string, entry: string): string {
  const recordSectionRe = /(## 决策记录\s*\n+)/m;
  if (recordSectionRe.test(text)) {
    return text.replace(recordSectionRe, `$1\n${entry}`);
  }
  const placeholderRe = /\n### \[YYYY-MM-DD\][\s\S]*$/m;
  if (placeholderRe.test(text)) {
    return text.replace(placeholderRe, `\n${entry}$&`);
  }
  if (text.endsWith("\n")) {
    return `${text}\n${entry}`;
  }
  return `${text}\n\n${entry}`;
}

export function assertApplicablePersonalMemorySuggestion(
  suggestion: unknown,
): PersonalMemoryWriteSuggestion {
  if (!suggestion || typeof suggestion !== "object") {
    throw new PersonalMemoryApplySuggestionError(
      "INVALID_SUGGESTION",
      "suggestion must be an object",
    );
  }
  const typed = suggestion as Partial<PersonalMemoryWriteSuggestion>;
  if (typed.level !== "L2") {
    throw new PersonalMemoryApplySuggestionError(
      "INVALID_SUGGESTION",
      `only L2 suggestions can be applied (got ${String(typed.level)})`,
    );
  }
  if (typed.target !== "decision-log") {
    throw new PersonalMemoryApplySuggestionError(
      "INVALID_SUGGESTION",
      `only decision-log target is supported (got ${String(typed.target)})`,
    );
  }
  if (!typed.structured || typeof typed.structured !== "object") {
    throw new PersonalMemoryApplySuggestionError(
      "INVALID_SUGGESTION",
      "L2 decision-log suggestion requires structured payload",
    );
  }
  const required = ["title", "background", "decision", "reason"] as const;
  for (const key of required) {
    const v = (typed.structured as Record<string, unknown>)[key];
    if (typeof v !== "string" || !v.trim()) {
      throw new PersonalMemoryApplySuggestionError(
        "INVALID_SUGGESTION",
        `suggestion.structured.${key} is required`,
      );
    }
  }
  return typed as PersonalMemoryWriteSuggestion;
}

export type ApplyPersonalMemorySuggestionParams = {
  suggestion: unknown;
  personalContextDir: string;
  dryRun?: boolean;
};

export type ApplyPersonalMemorySuggestionResult = {
  target: "decision-log";
  dryRun: boolean;
  applied: boolean;
  alreadyExists: boolean;
  filePath: string;
  date: string;
  title: string;
  entryPreview: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDecisionLogEntry(text: string, date: string, title: string): boolean {
  const header = new RegExp(`^### \\[${escapeRegExp(date)}\\]\\s+${escapeRegExp(title)}$`, "m");
  return header.test(text);
}

export function applyPersonalMemorySuggestion(
  params: ApplyPersonalMemorySuggestionParams,
): ApplyPersonalMemorySuggestionResult {
  const suggestion = assertApplicablePersonalMemorySuggestion(params.suggestion);
  if (
    !fs.existsSync(params.personalContextDir) ||
    !fs.statSync(params.personalContextDir).isDirectory()
  ) {
    throw new PersonalMemoryApplySuggestionError(
      "CONTEXT_DIR_NOT_FOUND",
      `personal-context directory not found: ${params.personalContextDir}`,
    );
  }
  const filePath = path.join(params.personalContextDir, DECISION_LOG_FILE);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new PersonalMemoryApplySuggestionError(
      "DECISION_LOG_NOT_FOUND",
      `decision-log file not found: ${filePath}`,
    );
  }
  const structured = suggestion.structured as Record<string, string>;
  const built = buildDecisionEntryFromStructured(structured);
  const original = fs.readFileSync(filePath, "utf8");
  const alreadyExists = hasDecisionLogEntry(original, built.date, built.title);
  if (!params.dryRun) {
    try {
      if (!alreadyExists) {
        const withUpdatedDate = updateLastUpdatedLine(original, built.date);
        const nextText = insertDecisionEntryIntoLog(withUpdatedDate, built.entry);
        fs.writeFileSync(filePath, nextText, "utf8");
      }
    } catch (err) {
      throw new PersonalMemoryApplySuggestionError("WRITE_FAILED", String(err), {
        cause: err,
      });
    }
  }
  return {
    target: "decision-log",
    dryRun: Boolean(params.dryRun),
    applied: !params.dryRun && !alreadyExists,
    alreadyExists,
    filePath,
    date: built.date,
    title: built.title,
    entryPreview: built.entry.trimEnd(),
  };
}
