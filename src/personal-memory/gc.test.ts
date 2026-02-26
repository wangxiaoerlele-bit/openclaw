import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultPersonalMemoryGcPolicy,
  prunePersonalMemoryRuntimeState,
  runPersonalMemoryGc,
} from "./gc.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("personal-memory gc", () => {
  it("prunes stale runtime working/episodic records", () => {
    const dir = makeTempDir("openclaw-personal-memory-gc-");
    const runtimePath = path.join(dir, ".runtime-memory.json");
    writeJson(runtimePath, {
      version: 1,
      working: [
        {
          id: "working:old",
          title: "old",
          content: "old",
          source: "runtime",
          layer: "working",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "working:new",
          title: "new",
          content: "new",
          source: "runtime",
          layer: "working",
          createdAt: "2026-02-26T00:00:00.000Z",
          updatedAt: "2026-02-26T00:00:00.000Z",
        },
      ],
      episodic: [
        {
          id: "episodic:old",
          title: "old",
          content: "old",
          source: "runtime",
          layer: "episodic",
          createdAt: "2025-12-01T00:00:00.000Z",
          updatedAt: "2025-12-01T00:00:00.000Z",
        },
      ],
    });

    const result = prunePersonalMemoryRuntimeState({
      personalContextDir: dir,
      retainWorkingHours: 24,
      retainEpisodicDays: 30,
      maxEpisodic: 10,
      now: () => new Date("2026-02-26T12:00:00.000Z"),
    });
    expect(result.beforeWorking).toBe(2);
    expect(result.afterWorking).toBe(1);
    expect(result.beforeEpisodic).toBe(1);
    expect(result.afterEpisodic).toBe(0);

    const next = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as {
      working: Array<{ id: string }>;
      episodic: Array<{ id: string }>;
    };
    expect(next.working.map((x) => x.id)).toEqual(["working:new"]);
    expect(next.episodic).toEqual([]);
  });

  it("runs combined gc and respects dry-run for queue/runtime", () => {
    const dir = makeTempDir("openclaw-personal-memory-gc-");
    writeJson(path.join(dir, ".runtime-memory.json"), {
      version: 1,
      working: [
        {
          id: "working:old",
          title: "old",
          content: "old",
          source: "runtime",
          layer: "working",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      episodic: [],
    });
    writeJson(path.join(dir, ".personal-memory.suggestions.json"), {
      version: 1,
      items: [
        {
          id: "pms_old",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          status: "dismissed",
          fingerprint: "old",
          source: {},
          suggestion: { level: "L1", reason: "old" },
        },
      ],
    });
    const beforeRuntime = fs.readFileSync(path.join(dir, ".runtime-memory.json"), "utf8");
    const beforeQueue = fs.readFileSync(
      path.join(dir, ".personal-memory.suggestions.json"),
      "utf8",
    );

    const result = runPersonalMemoryGc({
      personalContextDir: dir,
      dryRun: true,
      now: () => new Date("2026-02-26T12:00:00.000Z"),
      policy: { retainWorkingHours: 1, retainDismissedDays: 1 },
    });
    expect(result.dryRun).toBe(true);
    expect(result.runtime.beforeWorking).toBe(1);
    expect(result.runtime.afterWorking).toBe(0);
    expect(result.suggestions.before).toBe(1);
    expect(result.suggestions.after).toBe(0);
    expect(fs.readFileSync(path.join(dir, ".runtime-memory.json"), "utf8")).toBe(beforeRuntime);
    expect(fs.readFileSync(path.join(dir, ".personal-memory.suggestions.json"), "utf8")).toBe(
      beforeQueue,
    );
  });

  it("supports per-channel episodic retention overrides", () => {
    const dir = makeTempDir("openclaw-personal-memory-gc-");
    const runtimePath = path.join(dir, ".runtime-memory.json");
    writeJson(runtimePath, {
      version: 1,
      working: [],
      episodic: [
        {
          id: "episodic:feishu-old",
          title: "feishu-old",
          content: "feishu-old",
          source: "runtime",
          layer: "episodic",
          tags: ["runtime", "episodic", "feishu"],
          createdAt: "2026-02-20T00:00:00.000Z",
          updatedAt: "2026-02-20T00:00:00.000Z",
        },
        {
          id: "episodic:webgui-old",
          title: "webgui-old",
          content: "webgui-old",
          source: "runtime",
          layer: "episodic",
          tags: ["runtime", "episodic", "web-gui"],
          metadata: { channel: "web-gui" },
          createdAt: "2026-02-20T00:00:00.000Z",
          updatedAt: "2026-02-20T00:00:00.000Z",
        },
      ],
    });

    const result = prunePersonalMemoryRuntimeState({
      personalContextDir: dir,
      retainEpisodicDays: 14,
      retainEpisodicByChannelDays: {
        feishu: 3,
      },
      maxEpisodic: 10,
      now: () => new Date("2026-02-26T12:00:00.000Z"),
    });

    expect(result.beforeEpisodic).toBe(2);
    expect(result.afterEpisodic).toBe(1);
    const next = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as {
      episodic: Array<{ id: string }>;
    };
    expect(next.episodic.map((x) => x.id)).toEqual(["episodic:webgui-old"]);
  });

  it("keeps protected episodic records beyond retention and prioritizes them under maxEpisodic", () => {
    const dir = makeTempDir("openclaw-personal-memory-gc-");
    const runtimePath = path.join(dir, ".runtime-memory.json");
    writeJson(runtimePath, {
      version: 1,
      working: [],
      episodic: [
        {
          id: "episodic:recent",
          title: "recent",
          content: "recent",
          source: "runtime",
          layer: "episodic",
          tags: ["runtime", "episodic", "feishu"],
          createdAt: "2026-02-26T08:00:00.000Z",
          updatedAt: "2026-02-26T08:00:00.000Z",
        },
        {
          id: "episodic:old-pinned",
          title: "old pinned",
          content: "old pinned",
          source: "manual",
          layer: "episodic",
          tags: ["runtime", "episodic", "pinned"],
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
        {
          id: "episodic:old-unprotected",
          title: "old unprotected",
          content: "old unprotected",
          source: "runtime",
          layer: "episodic",
          tags: ["runtime", "episodic"],
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    });

    const result = prunePersonalMemoryRuntimeState({
      personalContextDir: dir,
      retainEpisodicDays: 3,
      protectEpisodicTags: ["pinned"],
      protectEpisodicSources: ["manual"],
      maxEpisodic: 2,
      now: () => new Date("2026-02-26T12:00:00.000Z"),
    });

    expect(result.beforeEpisodic).toBe(3);
    expect(result.afterEpisodic).toBe(2);
    const next = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as {
      episodic: Array<{ id: string }>;
    };
    expect(next.episodic.map((x) => x.id)).toEqual(["episodic:old-pinned", "episodic:recent"]);
  });

  it("exposes stable default policy values", () => {
    expect(defaultPersonalMemoryGcPolicy()).toEqual({
      keepPending: 200,
      retainAppliedDays: 30,
      retainDismissedDays: 14,
      retainWorkingHours: 24,
      retainEpisodicDays: 30,
      maxEpisodic: 200,
    });
  });
});
