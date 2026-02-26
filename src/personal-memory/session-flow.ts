import path from "node:path";
import { renderPersonalMemoryRecordSnippet, selectPersonalMemoryRecords } from "./policy.js";
import { searchPersonalMemorySnapshotCached } from "./search.js";
import type {
  PersonalMemoryLayer,
  PersonalMemoryPostSessionInput,
  PersonalMemoryPreSessionContext,
  PersonalMemoryStore,
  PersonalMemoryWriteSuggestion,
} from "./types.js";

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function buildPersonalMemoryPreSessionContext(
  store: PersonalMemoryStore,
  request: PersonalMemoryPreSessionContext["request"] & {
    queryText?: string;
    search?: {
      enabled?: boolean;
      mode?: "keyword" | "hybrid" | "semantic";
      limit?: number;
      layers?: PersonalMemoryLayer[];
      cache?: boolean;
      backend?: "sparse-cache" | "sqlite-vec";
      sqliteVecFile?: string;
      sqliteVecExtensionPath?: string;
      rerank?: {
        enabled?: boolean;
        topK?: number;
      };
    };
  },
): Promise<PersonalMemoryPreSessionContext> {
  const refresh = await store.refresh();
  const snapshot = store.snapshot();
  const { queryText, search: searchOpts, ...selectionRequest } = request;
  const selection = selectPersonalMemoryRecords(snapshot, selectionRequest);
  const snippets = selection.selected.map(renderPersonalMemoryRecordSnippet);
  const status = store.status();
  const search =
    searchOpts?.enabled === false || !(typeof queryText === "string" && queryText.trim())
      ? undefined
      : searchPersonalMemorySnapshotCached(
          snapshot,
          {
            query: queryText,
            limit: searchOpts?.limit ?? 3,
            layers: searchOpts?.layers ?? ["episodic", "semantic"],
            mode: searchOpts?.mode ?? "hybrid",
            rerank: {
              enabled: searchOpts?.rerank?.enabled,
              topK: searchOpts?.rerank?.topK,
            },
          },
          {
            enabled: searchOpts?.cache !== false,
            backend: searchOpts?.backend,
            fingerprint: refresh.fingerprint || status.lastFingerprint,
            filePath: path.join(status.personalContextDir, ".semantic-index-cache.json"),
            sqliteVec: {
              dbPath: searchOpts?.sqliteVecFile
                ? path.resolve(status.personalContextDir, searchOpts.sqliteVecFile)
                : path.join(status.personalContextDir, ".semantic-index.sqlite"),
              extensionPath: searchOpts?.sqliteVecExtensionPath,
            },
          },
        );
  return {
    request: selectionRequest,
    refresh,
    selection,
    snippets,
    search,
  };
}

function sanitizeInline(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text || undefined;
}

export function suggestPostSessionMemoryWrite(
  input: PersonalMemoryPostSessionInput,
): PersonalMemoryWriteSuggestion {
  const summary = input.summary.trim();
  const hasDecisionFields = Boolean(
    sanitizeInline(input.decisionTitle) &&
    sanitizeInline(input.decision) &&
    sanitizeInline(input.reason),
  );

  if (!summary) {
    return {
      level: "L0",
      reason: "缺少会话摘要，无法生成记忆写回建议",
    };
  }

  if (input.taskKind === "decision-review" && hasDecisionFields) {
    const confirmed = input.userConfirmed === true;
    const level = confirmed ? "L2" : "L1";
    const title = sanitizeInline(input.decisionTitle)!;
    const contentLines = [
      `### [${todayIsoDate()}] ${title}`,
      "",
      `- 背景：${sanitizeInline(input.background) ?? summary}`,
      `- 决策：${sanitizeInline(input.decision)}`,
      `- 原因：${sanitizeInline(input.reason)}`,
      `- 备选方案（可选）：(待补充)`,
      `- 影响范围：${sanitizeInline(input.summary)}`,
      `- 后续动作：${sanitizeInline(input.next) ?? "(待补充)"}`,
      `- 相关文件/链接：${sanitizeInline(input.links) ?? "(待补充)"}`,
    ];
    return {
      level,
      target: "decision-log",
      reason: confirmed
        ? "检测到用户已确认的决策信息，适合写入 decision-log（L2）"
        : "检测到决策信息但未确认，建议人工确认后写入 decision-log（L1）",
      title,
      content: contentLines.join("\n"),
      structured: {
        date: todayIsoDate(),
        title,
        background: sanitizeInline(input.background) ?? summary,
        decision: sanitizeInline(input.decision)!,
        reason: sanitizeInline(input.reason)!,
        next: sanitizeInline(input.next) ?? "",
        links: sanitizeInline(input.links) ?? "",
      },
    };
  }

  if (input.taskKind === "project-discussion") {
    return {
      level: "L1",
      target: "projects",
      reason: "项目讨论通常会带来状态变化，建议人工确认后更新 projects.md",
      title: "项目状态更新建议",
      content: summary,
    };
  }

  if (input.taskKind === "planning") {
    return {
      level: "L1",
      target: "current-focus",
      reason: "规划讨论可能改变当前重点，建议确认后更新 current-focus.md",
      title: "当前重点更新建议",
      content: summary,
    };
  }

  return {
    level: "L0",
    reason: "当前任务类型不建议自动沉淀，保留为临时会话上下文",
  };
}
