import { describe, expect, it } from "vitest";
import {
  applyTieredSnippetBudget,
  planTierMigration,
  resolveMemoryTierFromPath,
  resolveMemoryTieringConfig,
  scoreWithTierBoost,
} from "./tiering.js";

describe("memory tiering", () => {
  it("classifies paths by tier", () => {
    expect(resolveMemoryTierFromPath("memory/hot/note.md")).toBe("hot");
    expect(resolveMemoryTierFromPath("memory/warm/note.md")).toBe("warm");
    expect(resolveMemoryTierFromPath("memory/cold/note.md")).toBe("cold");
    expect(resolveMemoryTierFromPath("memory/note.md")).toBe("legacy");
    expect(resolveMemoryTierFromPath("MEMORY.md")).toBe("hot");
  });

  it("plans migration from untiered memory into hot", () => {
    const config = resolveMemoryTieringConfig();
    const plan = planTierMigration({
      relPath: "memory/imported/2026-03-04/note.md",
      mtimeMs: Date.now() - 40 * 24 * 60 * 60 * 1000,
      config,
    });
    expect(plan).toEqual({
      from: "legacy",
      to: "hot",
      targetRelPath: "memory/hot/imported/2026-03-04/note.md",
    });
  });

  it("plans migration from hot into warm/cold by age", () => {
    const config = resolveMemoryTieringConfig({ hotWindowDays: 7, warmWindowDays: 30 });
    const nowMs = Date.now();
    const warmPlan = planTierMigration({
      relPath: "memory/hot/note.md",
      mtimeMs: nowMs - 10 * 24 * 60 * 60 * 1000,
      nowMs,
      config,
    });
    expect(warmPlan?.to).toBe("warm");
    const coldPlan = planTierMigration({
      relPath: "memory/warm/note.md",
      mtimeMs: nowMs - 40 * 24 * 60 * 60 * 1000,
      nowMs,
      config,
    });
    expect(coldPlan?.to).toBe("cold");
  });

  it("applies tier score boost", () => {
    const config = resolveMemoryTieringConfig({
      retrieval: { hotBoost: 0.2, warmBoost: 0.1, coldBoost: 0 },
    });
    expect(scoreWithTierBoost(0.5, "memory/hot/a.md", config)).toBeCloseTo(0.7);
    expect(scoreWithTierBoost(0.5, "memory/warm/a.md", config)).toBeCloseTo(0.6);
    expect(scoreWithTierBoost(0.5, "memory/cold/a.md", config)).toBeCloseTo(0.5);
  });

  it("enforces tiered snippet budget when total exceeds cap", () => {
    const config = resolveMemoryTieringConfig({
      budget: { maxChars: 20, warmSummaryChars: 8, coldSnippetChars: 4 },
    });
    const out = applyTieredSnippetBudget(
      [
        { path: "memory/cold/c.md", score: 0.9, snippet: "1234567890" },
        { path: "memory/hot/h.md", score: 0.5, snippet: "abcdefghij" },
        { path: "memory/warm/w.md", score: 0.4, snippet: "ABCDEFGHIJ" },
      ],
      config,
    );
    expect(out[0]?.path).toBe("memory/hot/h.md");
    expect(out[0]?.snippet).toBe("abcdefghij");
    expect(out[1]?.path).toBe("memory/warm/w.md");
    expect(out[1]?.snippet.length).toBeLessThanOrEqual(8);
    expect(out[2]?.path).toBe("memory/cold/c.md");
    expect(out[2]?.snippet.length).toBeLessThanOrEqual(4);
  });
});
