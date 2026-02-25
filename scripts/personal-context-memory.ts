import fs from "node:fs";
import path from "node:path";

export const PERSONAL_CONTEXT_DIRNAME = "personal-context";

export type PersonalContextPathErrorCode =
  | "DIR_NOT_FOUND"
  | "DIR_NAME_INVALID"
  | "DIR_OUTSIDE_WORKSPACE"
  | "FILE_NAME_EMPTY"
  | "FILE_NAME_ABSOLUTE"
  | "FILE_NAME_PATH_SEPARATOR"
  | "FILE_NAME_DOT_DOT"
  | "FILE_NOT_FOUND"
  | "FILE_ESCAPES_DIR";

export class PersonalContextPathError extends Error {
  constructor(
    public readonly code: PersonalContextPathErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PersonalContextPathError";
  }
}

export function isPersonalContextPathError(err: unknown): err is PersonalContextPathError {
  return err instanceof PersonalContextPathError;
}

export type DecisionEntry = {
  date: string;
  title: string;
  background?: string;
  decision?: string;
  reason?: string;
  impact?: string;
  next?: string;
  links?: string;
};

type ParseDecisionEntriesOptions = {
  includeExamples?: boolean;
};

function isSubpath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolvePersonalContextDir(cwd: string, dirArg: string): string {
  const cwdReal = fs.realpathSync(cwd);
  const resolved = path.resolve(cwd, dirArg);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new PersonalContextPathError("DIR_NOT_FOUND", `memory directory not found: ${resolved}`);
  }
  const real = fs.realpathSync(resolved);
  if (path.basename(real) !== PERSONAL_CONTEXT_DIRNAME) {
    throw new PersonalContextPathError(
      "DIR_NAME_INVALID",
      `memory directory must be named "${PERSONAL_CONTEXT_DIRNAME}" (got ${real})`,
    );
  }
  if (!isSubpath(cwdReal, real)) {
    throw new PersonalContextPathError(
      "DIR_OUTSIDE_WORKSPACE",
      `memory directory must stay within current workspace: ${real}`,
    );
  }
  return real;
}

export function assertPersonalContextFileName(fileName: string): string {
  const name = fileName.trim();
  if (!name) {
    throw new PersonalContextPathError("FILE_NAME_EMPTY", "memory file name cannot be empty");
  }
  if (path.isAbsolute(name)) {
    throw new PersonalContextPathError(
      "FILE_NAME_ABSOLUTE",
      `memory file must be a file name, not an absolute path: ${name}`,
    );
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new PersonalContextPathError(
      "FILE_NAME_PATH_SEPARATOR",
      `memory file must not include path separators: ${name}`,
    );
  }
  if (name.includes("..")) {
    throw new PersonalContextPathError(
      "FILE_NAME_DOT_DOT",
      `memory file must not include '..': ${name}`,
    );
  }
  return name;
}

export function resolvePersonalContextFilePath(
  baseDir: string,
  fileName: string,
  opts?: { mustExist?: boolean },
): string {
  const safeName = assertPersonalContextFileName(fileName);
  const baseDirReal = fs.realpathSync(baseDir);
  const fullPath = path.join(baseDirReal, safeName);
  const mustExist = opts?.mustExist !== false;
  if (!mustExist) {
    return fullPath;
  }
  if (!fs.existsSync(fullPath)) {
    throw new PersonalContextPathError("FILE_NOT_FOUND", `memory file not found: ${fullPath}`);
  }
  const real = fs.realpathSync(fullPath);
  if (!isSubpath(baseDirReal, real)) {
    throw new PersonalContextPathError(
      "FILE_ESCAPES_DIR",
      `memory file escapes memory directory: ${safeName}`,
    );
  }
  return real;
}

export function extractDecisionRecordBody(text: string): string | null {
  const sectionMatch = text.match(/## 决策记录\s*([\s\S]*)$/);
  return sectionMatch ? sectionMatch[1] : null;
}

export function parseDecisionEntriesFromLog(
  text: string,
  opts: ParseDecisionEntriesOptions = {},
): DecisionEntry[] {
  const body = extractDecisionRecordBody(text);
  if (!body) {
    return [];
  }
  const includeExamples = opts.includeExamples ?? false;

  const headerRe = /^### \[(\d{4}-\d{2}-\d{2})\]\s+(.+)$/gm;
  const matches = Array.from(body.matchAll(headerRe));
  const entries: DecisionEntry[] = [];

  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const date = m[1] ?? "";
    const title = (m[2] ?? "").trim();
    if (!date || !title) {
      continue;
    }
    if (title === "决策标题") {
      continue;
    }
    if (!includeExamples && title.includes("示例")) {
      continue;
    }
    if (date === "YYYY-MM-DD") {
      continue;
    }
    if (/^\[?YYYY-MM-DD\]?$/.test(date)) {
      continue;
    }

    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? body.length) : body.length;
    const block = body.slice(start, end);
    const getField = (label: string) => {
      const fieldRe = new RegExp(`^- ${label}[：:]\\s*(.*)$`, "m");
      const mm = block.match(fieldRe);
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

export function sortDecisionEntriesByDateDesc(entries: DecisionEntry[]): DecisionEntry[] {
  return [...entries].toSorted((a, b) => {
    if (a.date !== b.date) {
      return b.date.localeCompare(a.date);
    }
    return b.title.localeCompare(a.title, "zh-CN");
  });
}

export function updateLastUpdatedLine(
  text: string,
  date: string,
): { changed: boolean; next: string } {
  const lineRe = /^([ \t]*[-*]?[ \t]*最后更新日期[ \t]*[:：])[ \t]*.*$/m;
  if (!lineRe.test(text)) {
    return { changed: false, next: text };
  }
  const next = text.replace(lineRe, `$1 ${date}`);
  return { changed: next !== text, next };
}

export function insertDecisionEntryIntoLog(text: string, entry: string): string {
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
