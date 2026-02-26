import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { searchPersonalMemorySnapshot, searchPersonalMemorySnapshotCached } from "./search.js";
import type { PersonalMemoryStoreSnapshot } from "./types.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeSnapshot(): PersonalMemoryStoreSnapshot {
  return {
    working: [
      {
        id: "working:1",
        layer: "working",
        title: "当前会话重点",
        content: "正在实现 personal-memory search 和 hooks 集成",
        source: "runtime",
        createdAt: "2026-02-25T10:00:00.000Z",
        updatedAt: "2026-02-25T10:01:00.000Z",
        tags: ["working", "search"],
      },
    ],
    episodic: [
      {
        id: "episodic:1",
        layer: "episodic",
        title: "确认采用 personal-memory 三层骨架方案",
        content: "决策：先做 parser/store/policy，再接 hooks",
        source: "personal-context",
        createdAt: "2026-02-25",
        updatedAt: "2026-02-25",
        tags: ["decision-log", "hooks"],
      },
    ],
    semantic: [
      {
        id: "semantic:projects",
        layer: "semantic",
        title: "02 Projects",
        content: "OpenClaw 项目包含 memory 工具链与 personal-context 模板",
        source: "personal-context",
        createdAt: "2026-02-25",
        updatedAt: "2026-02-25",
        tags: ["projects"],
        metadata: { kind: "projects" },
      },
    ],
  };
}

describe("searchPersonalMemorySnapshot", () => {
  it("returns ranked hits with snippets and reasons", () => {
    const result = searchPersonalMemorySnapshot(makeSnapshot(), {
      query: "hooks",
      limit: 5,
    });

    expect(result.totalHits).toBeGreaterThanOrEqual(2);
    expect(result.hits.some((hit) => hit.title.includes("当前会话重点"))).toBe(true);
    expect(result.hits.some((hit) => hit.title.includes("三层骨架方案"))).toBe(true);
    expect(result.hits[0]?.reasons.length).toBeGreaterThan(0);
    expect(result.hits[0]?.snippet.length).toBeGreaterThan(0);
    if (result.hits[1]) {
      const firstScore = result.hits[0]?.score ?? 0;
      expect(firstScore).toBeGreaterThanOrEqual(result.hits[1].score);
    }
  });

  it("supports layer filtering and limit", () => {
    const result = searchPersonalMemorySnapshot(makeSnapshot(), {
      query: "memory",
      limit: 1,
      layers: ["semantic"],
    });

    expect(result.totalHits).toBe(1);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.layer).toBe("semantic");
    expect(result.hits[0]?.title).toBe("02 Projects");
  });

  it("supports semantic mode for near-match typo queries", () => {
    const result = searchPersonalMemorySnapshot(makeSnapshot(), {
      query: "OpenClw",
      mode: "semantic",
      limit: 5,
      layers: ["semantic", "working"],
    });

    expect(result.mode).toBe("semantic");
    expect(result.totalHits).toBeGreaterThan(0);
    expect(result.hits.some((hit) => hit.title === "02 Projects")).toBe(true);
    expect(result.hits.some((hit) => typeof hit.semanticScore === "number")).toBe(true);
    expect(result.rerank?.enabled).toBe(true);
    expect(result.rerank?.strategy).toBe("hybrid-v2");
  });

  it("allows disabling rerank explicitly", () => {
    const result = searchPersonalMemorySnapshot(makeSnapshot(), {
      query: "OpenClw",
      mode: "semantic",
      limit: 5,
      rerank: { enabled: false },
    });
    expect(result.rerank?.enabled).toBe(false);
    expect(result.rerank?.applied).toBe(false);
    expect(result.rerank?.reason).toMatch(/disabled|mode=keyword/);
  });

  it("supports explicit mmr-lite rerank strategy override", () => {
    const result = searchPersonalMemorySnapshot(makeSnapshot(), {
      query: "OpenClw hooks",
      mode: "semantic",
      limit: 5,
      rerank: { enabled: true, strategy: "mmr-lite", topK: 4 },
    });
    expect(result.rerank?.enabled).toBe(true);
    expect(result.rerank?.strategy).toBe("mmr-lite");
    expect(result.rerank?.topK).toBeGreaterThanOrEqual(4);
  });

  it("persists and reuses semantic cache for hybrid/semantic search", () => {
    const dir = makeTempDir("openclaw-personal-memory-search-cache-");
    const cacheFile = path.join(dir, ".semantic-index-cache.json");
    const snapshot = makeSnapshot();

    const first = searchPersonalMemorySnapshotCached(
      snapshot,
      { query: "OpenClaw", mode: "hybrid", limit: 5 },
      {
        filePath: cacheFile,
        fingerprint: "fp-1",
        enabled: true,
        now: () => new Date("2026-02-26T00:00:00.000Z"),
      },
    );
    expect(first.cache?.enabled).toBe(true);
    expect(first.cache?.cacheHit).toBe(false);
    expect(first.cache?.rebuilt).toBe(true);
    expect(fs.existsSync(cacheFile)).toBe(true);

    const second = searchPersonalMemorySnapshotCached(
      snapshot,
      { query: "OpenClw", mode: "semantic", limit: 5 },
      {
        filePath: cacheFile,
        fingerprint: "fp-1",
        enabled: true,
      },
    );
    expect(second.cache?.enabled).toBe(true);
    expect(second.cache?.cacheHit).toBe(true);
    expect(second.cache?.rebuilt).toBe(false);
    expect(second.totalHits).toBeGreaterThan(0);

    const third = searchPersonalMemorySnapshotCached(
      snapshot,
      { query: "OpenClaw", mode: "semantic", limit: 5 },
      {
        filePath: cacheFile,
        fingerprint: "fp-2",
        enabled: true,
      },
    );
    expect(third.cache?.rebuilt).toBe(true);
    expect(third.cache?.reason).toBe("fingerprint-mismatch");
  });

  it("falls back to sparse-cache when sqlite-vec backend is unavailable", () => {
    const dir = makeTempDir("openclaw-personal-memory-search-sqlite-vec-fallback-");
    const snapshot = makeSnapshot();
    const result = searchPersonalMemorySnapshotCached(
      snapshot,
      { query: "OpenClw", mode: "semantic", limit: 5 },
      {
        enabled: true,
        backend: "sqlite-vec",
        filePath: path.join(dir, ".semantic-index-cache.json"),
        fingerprint: "fp-sqlite-vec-fallback",
        sqliteVec: {
          dbPath: path.join(dir, ".semantic-index.sqlite"),
          extensionPath: path.join(dir, "missing-sqlite-vec.dylib"),
        },
      },
    );

    expect(result.totalHits).toBeGreaterThan(0);
    expect(result.cache?.backend).toBe("sparse-cache");
    expect(result.cache?.reason?.startsWith("sqlite-vec-fallback:")).toBe(true);
  });
});
