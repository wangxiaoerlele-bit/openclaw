import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPersonalMemorySuggestion,
  PersonalMemoryApplySuggestionError,
} from "./apply-suggestion.js";

function createPersonalContextFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-apply-"));
  const personalDir = path.join(dir, "personal-context");
  fs.mkdirSync(personalDir, { recursive: true });
  fs.writeFileSync(
    path.join(personalDir, "04-decision-log.md"),
    [
      "# 决策日志",
      "",
      "- 最后更新日期：2026-02-25",
      "",
      "## 决策记录",
      "",
      "### [YYYY-MM-DD] 决策标题",
      "",
      "- 背景：...",
    ].join("\n"),
    "utf8",
  );
  return personalDir;
}

function suggestion() {
  return {
    level: "L2",
    target: "decision-log",
    reason: "需要持久化决策",
    structured: {
      date: "2026-02-26",
      title: "测试决策",
      background: "背景",
      decision: "决策",
      reason: "原因",
      next: "后续",
    },
  };
}

describe("applyPersonalMemorySuggestion", () => {
  it("supports dry-run without mutating files", () => {
    const personalContextDir = createPersonalContextFixture();
    const filePath = path.join(personalContextDir, "04-decision-log.md");
    const before = fs.readFileSync(filePath, "utf8");

    const result = applyPersonalMemorySuggestion({
      suggestion: suggestion(),
      personalContextDir,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.alreadyExists).toBe(false);
    expect(result.entryPreview).toContain("### [2026-02-26] 测试决策");
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });

  it("writes L2 decision-log suggestion to the file", () => {
    const personalContextDir = createPersonalContextFixture();
    const filePath = path.join(personalContextDir, "04-decision-log.md");

    const result = applyPersonalMemorySuggestion({
      suggestion: suggestion(),
      personalContextDir,
    });

    expect(result.dryRun).toBe(false);
    expect(result.applied).toBe(true);
    expect(result.alreadyExists).toBe(false);
    const next = fs.readFileSync(filePath, "utf8");
    expect(next).toMatch(/最后更新日期：\s*2026-02-26/);
    expect(next).toContain("### [2026-02-26] 测试决策");
  });

  it("skips duplicate decision-log entries on retry", () => {
    const personalContextDir = createPersonalContextFixture();
    const filePath = path.join(personalContextDir, "04-decision-log.md");

    const first = applyPersonalMemorySuggestion({
      suggestion: suggestion(),
      personalContextDir,
    });
    const afterFirst = fs.readFileSync(filePath, "utf8");
    const second = applyPersonalMemorySuggestion({
      suggestion: suggestion(),
      personalContextDir,
    });
    const afterSecond = fs.readFileSync(filePath, "utf8");

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.alreadyExists).toBe(true);
    expect(afterSecond).toBe(afterFirst);
  });

  it("rejects non-L2 suggestions", () => {
    expect(() =>
      applyPersonalMemorySuggestion({
        suggestion: { level: "L1", target: "projects", reason: "x" },
        personalContextDir: createPersonalContextFixture(),
        dryRun: true,
      }),
    ).toThrowError(PersonalMemoryApplySuggestionError);
  });
});
