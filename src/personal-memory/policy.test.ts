import { describe, expect, it } from "vitest";
import { selectPersonalMemoryRecords } from "./policy.js";
import type { PersonalMemoryStoreSnapshot } from "./types.js";

function makeSnapshot(): PersonalMemoryStoreSnapshot {
  return {
    working: [
      {
        id: "working:1",
        layer: "working",
        title: "当前会话目标",
        content: "先实现三层记忆骨架",
        source: "runtime",
        createdAt: "2026-02-25T00:00:00.000Z",
      },
    ],
    episodic: [
      {
        id: "episodic:1",
        layer: "episodic",
        title: "上次决策",
        content: "先做模板与工具再做 runtime",
        source: "personal-context",
        createdAt: "2026-02-25",
      },
      {
        id: "episodic:2",
        layer: "episodic",
        title: "另一条历史记录",
        content: "B".repeat(1200),
        source: "personal-context",
        createdAt: "2026-02-24",
      },
    ],
    semantic: [
      {
        id: "semantic:identity",
        layer: "semantic",
        title: "00 Identity",
        content: "身份信息",
        source: "personal-context",
        createdAt: "2026-02-25",
        metadata: { kind: "identity" },
      },
      {
        id: "semantic:focus",
        layer: "semantic",
        title: "01 Current Focus",
        content: "当前重点",
        source: "personal-context",
        createdAt: "2026-02-25",
        metadata: { kind: "current-focus" },
      },
      {
        id: "semantic:projects",
        layer: "semantic",
        title: "02 Projects",
        content: "项目状态",
        source: "personal-context",
        createdAt: "2026-02-25",
        metadata: { kind: "projects" },
      },
      {
        id: "semantic:rules",
        layer: "semantic",
        title: "03 Working Rules",
        content: "工作规则",
        source: "personal-context",
        createdAt: "2026-02-25",
        metadata: { kind: "working-rules" },
      },
      {
        id: "semantic:decisions",
        layer: "semantic",
        title: "04 Decision Log",
        content: "决策索引",
        source: "personal-context",
        createdAt: "2026-02-25",
        metadata: { kind: "decision-log" },
      },
    ],
  };
}

describe("personal-memory selection policy", () => {
  it("prefers current-focus + working-rules for Feishu daily QA", () => {
    const result = selectPersonalMemoryRecords(makeSnapshot(), {
      channel: "feishu",
      taskKind: "daily-qa",
    });
    const ids = result.selected.map((r) => r.id);
    expect(ids).toContain("working:1");
    expect(ids).toContain("semantic:focus");
    expect(ids).toContain("semantic:rules");
    expect(result.profile).toContain("daily-qa");
  });

  it("enforces char budget and records dropped reason", () => {
    const result = selectPersonalMemoryRecords(makeSnapshot(), {
      channel: "feishu",
      taskKind: "project-discussion",
      budget: { maxChars: 500, maxRecords: 10 },
    });
    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.dropped.some((d) => d.reason === "max-chars")).toBe(true);
    expect(result.usedChars).toBeLessThanOrEqual(500);
  });
});
