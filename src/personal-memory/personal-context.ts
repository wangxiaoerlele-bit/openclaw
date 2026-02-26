import fs from "node:fs";
import path from "node:path";
import type {
  PersonalContextDecisionEntry,
  PersonalContextDocKind,
  PersonalContextDocument,
  PersonalContextSection,
  PersonalContextSemanticSeed,
  PersonalMemoryRecord,
  PersonalMemoryStoreSnapshot,
} from "./types.js";

export const PERSONAL_CONTEXT_DIRNAME = "personal-context";

export const PERSONAL_CONTEXT_FILES: Record<string, PersonalContextDocKind> = {
  "00-identity.md": "identity",
  "01-current-focus.md": "current-focus",
  "02-projects.md": "projects",
  "03-working-rules.md": "working-rules",
  "04-decision-log.md": "decision-log",
};

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function findTitle(text: string): string | undefined {
  const m = text.match(/^#\s+(.+)$/m);
  const title = m?.[1]?.trim();
  return title || undefined;
}

function findLabeledField(text: string, label: string): string | undefined {
  const re = new RegExp(`^[ \\t]*[-*]?[ \\t]*${label}[ \\t]*[:：][ \\t]*(.*)[ \\t]*$`, "m");
  const m = text.match(re);
  const value = m?.[1]?.trim();
  return value || undefined;
}

export function parseMarkdownSections(text: string): PersonalContextSection[] {
  const normalized = normalizeNewlines(text);
  const lines = normalized.split("\n");
  const sections: PersonalContextSection[] = [];
  let currentHeading: string | null = null;
  let currentBody: string[] = [];

  function flush() {
    if (!currentHeading) {
      return;
    }
    sections.push({
      heading: currentHeading,
      body: currentBody.join("\n").trim(),
    });
  }

  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (!m) {
      currentBody.push(line);
      continue;
    }
    flush();
    currentHeading = (m[1] ?? "").trim();
    currentBody = [];
  }
  flush();

  return sections;
}

export function parsePersonalContextDocument(
  fileName: string,
  text: string,
): PersonalContextDocument {
  const kind = PERSONAL_CONTEXT_FILES[fileName];
  if (!kind) {
    throw new Error(`unsupported personal-context file: ${fileName}`);
  }
  const normalized = normalizeNewlines(text);
  return {
    kind,
    fileName,
    title: findTitle(normalized),
    lastUpdatedDate: findLabeledField(normalized, "最后更新日期"),
    applicablePeriod: findLabeledField(normalized, "适用周期"),
    sections: parseMarkdownSections(normalized),
    rawText: normalized,
  };
}

function extractDecisionRecordBody(text: string): string {
  const normalized = normalizeNewlines(text);
  const m = normalized.match(/##\s+决策记录\s*([\s\S]*)$/);
  return m?.[1] ?? "";
}

function getDecisionField(block: string, label: string): string | undefined {
  const re = new RegExp(`^- ${label}[：:]\\s*(.*)$`, "m");
  const m = block.match(re);
  const value = m?.[1]?.trim();
  if (!value) {
    return undefined;
  }
  return value;
}

export function parseDecisionLogEntries(text: string): PersonalContextDecisionEntry[] {
  const body = extractDecisionRecordBody(text);
  if (!body) {
    return [];
  }

  const headerRe = /^### \[(\d{4}-\d{2}-\d{2})\]\s+(.+)$/gm;
  const matches = Array.from(body.matchAll(headerRe));
  const entries: PersonalContextDecisionEntry[] = [];

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
    if (title.includes("示例")) {
      continue;
    }
    if (date === "YYYY-MM-DD" || /^\[?YYYY-MM-DD\]?$/.test(date)) {
      continue;
    }

    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? body.length) : body.length;
    const block = body.slice(start, end);
    entries.push({
      date,
      title,
      background: getDecisionField(block, "背景"),
      decision: getDecisionField(block, "决策"),
      reason: getDecisionField(block, "原因"),
      impact: getDecisionField(block, "影响范围"),
      next: getDecisionField(block, "后续动作"),
      links: getDecisionField(block, "相关文件/链接"),
    });
  }

  return entries.toSorted((a, b) => {
    if (a.date !== b.date) {
      return b.date.localeCompare(a.date);
    }
    return b.title.localeCompare(a.title, "zh-CN");
  });
}

export function loadPersonalContextSemanticSeed(baseDir: string): PersonalContextSemanticSeed {
  const docs: PersonalContextDocument[] = [];
  for (const fileName of Object.keys(PERSONAL_CONTEXT_FILES).toSorted()) {
    const filePath = path.join(baseDir, fileName);
    const text = fs.readFileSync(filePath, "utf8");
    docs.push(parsePersonalContextDocument(fileName, text));
  }

  const decisionDoc = docs.find((doc) => doc.kind === "decision-log");
  return {
    docs,
    decisions: decisionDoc ? parseDecisionLogEntries(decisionDoc.rawText) : [],
  };
}

export function buildInitialPersonalMemorySnapshot(
  seed: PersonalContextSemanticSeed,
): PersonalMemoryStoreSnapshot {
  const semanticRecords: PersonalMemoryRecord[] = seed.docs.map((doc) => ({
    id: `semantic:${doc.fileName}`,
    layer: "semantic",
    title: doc.title ?? doc.fileName,
    content: doc.rawText,
    source: "personal-context",
    tags: ["personal-context", doc.kind],
    createdAt: doc.lastUpdatedDate ?? new Date().toISOString().slice(0, 10),
    updatedAt: doc.lastUpdatedDate,
    metadata: {
      fileName: doc.fileName,
      kind: doc.kind,
      applicablePeriod: doc.applicablePeriod,
      sectionCount: doc.sections.length,
    },
  }));

  const episodicRecords: PersonalMemoryRecord[] = seed.decisions.map((entry) => ({
    id: `episodic:decision:${entry.date}:${entry.title}`,
    layer: "episodic",
    title: entry.title,
    content: [
      entry.background && `背景：${entry.background}`,
      entry.decision && `决策：${entry.decision}`,
      entry.reason && `原因：${entry.reason}`,
      entry.impact && `影响范围：${entry.impact}`,
      entry.next && `后续动作：${entry.next}`,
      entry.links && `相关文件/链接：${entry.links}`,
    ]
      .filter(Boolean)
      .join("\n"),
    source: "personal-context",
    tags: ["decision-log", "episodic"],
    createdAt: entry.date,
    updatedAt: entry.date,
    metadata: { ...entry },
  }));

  return {
    working: [],
    episodic: episodicRecords,
    semantic: semanticRecords,
  };
}
