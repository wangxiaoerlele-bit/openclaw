import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PERSONAL_MEMORY_RUNTIME_STATE_FILE } from "./gc.js";
import {
  exportPersonalMemoryRuntimeBundle,
  importPersonalMemoryRuntimeBundle,
  syncPersonalMemoryRuntimeBundle,
} from "./runtime-share.js";

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

describe("personal-memory runtime-share", () => {
  it("imports bundle into local runtime without rewriting bundle in import mode", () => {
    const dir = makeTempDir("openclaw-runtime-share-");
    const bundlePath = path.join(dir, "archive", "runtime-share.json");
    writeJson(bundlePath, {
      version: 1,
      exportedAt: "2026-02-26T00:00:00.000Z",
      source: { cwd: "/tmp", personalContextDir: "/tmp/pc" },
      runtime: {
        version: 1,
        working: [],
        episodic: [
          {
            id: "episodic:remote:1",
            title: "remote",
            content: "remote",
            layer: "episodic",
            source: "runtime",
            createdAt: "2026-02-25T00:00:00.000Z",
            updatedAt: "2026-02-25T00:00:00.000Z",
          },
        ],
      },
    });
    const beforeBundle = fs.readFileSync(bundlePath, "utf8");

    const result = importPersonalMemoryRuntimeBundle({
      personalContextDir: dir,
      bundleFile: path.join("archive", "runtime-share.json"),
      maxEpisodic: 20,
    });

    expect(result.bundleExists).toBe(true);
    expect(result.importedEpisodic).toBe(1);
    const runtime = JSON.parse(
      fs.readFileSync(path.join(dir, PERSONAL_MEMORY_RUNTIME_STATE_FILE), "utf8"),
    ) as { episodic: Array<{ id: string }> };
    expect(runtime.episodic.map((r) => r.id)).toContain("episodic:remote:1");
    expect(fs.readFileSync(bundlePath, "utf8")).toBe(beforeBundle);
  });

  it("supports configurable conflictStrategy in sync mode", () => {
    const dir = makeTempDir("openclaw-runtime-share-");
    const runtimePath = path.join(dir, PERSONAL_MEMORY_RUNTIME_STATE_FILE);
    const bundleRel = path.join("archive", "runtime-share.json");
    const bundlePath = path.join(dir, bundleRel);
    writeJson(runtimePath, {
      version: 1,
      working: [],
      episodic: [
        {
          id: "episodic:same",
          title: "local newer",
          content: "local newer",
          layer: "episodic",
          source: "runtime",
          createdAt: "2026-02-25T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      ],
    });
    writeJson(bundlePath, {
      version: 1,
      exportedAt: "2026-02-26T00:00:00.000Z",
      source: { cwd: "/tmp", personalContextDir: "/tmp/pc" },
      runtime: {
        version: 1,
        working: [],
        episodic: [
          {
            id: "episodic:same",
            title: "incoming older",
            content: "incoming older",
            layer: "episodic",
            source: "runtime",
            createdAt: "2026-02-25T00:00:00.000Z",
            updatedAt: "2026-02-26T00:00:00.000Z",
          },
        ],
      },
    });

    const keepLocal = syncPersonalMemoryRuntimeBundle({
      personalContextDir: dir,
      bundleFile: bundleRel,
      conflictStrategy: "current",
    });
    expect(keepLocal.currentWon).toBe(1);
    let runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as {
      episodic: Array<{ title: string }>;
    };
    expect(runtime.episodic[0]?.title).toBe("local newer");

    // Re-seed to test "incoming" preference deterministically.
    writeJson(runtimePath, {
      version: 1,
      working: [],
      episodic: [
        {
          id: "episodic:same",
          title: "local newer",
          content: "local newer",
          layer: "episodic",
          source: "runtime",
          createdAt: "2026-02-25T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      ],
    });
    writeJson(bundlePath, {
      version: 1,
      exportedAt: "2026-02-26T00:00:00.000Z",
      source: { cwd: "/tmp", personalContextDir: "/tmp/pc" },
      runtime: {
        version: 1,
        working: [],
        episodic: [
          {
            id: "episodic:same",
            title: "incoming older",
            content: "incoming older",
            layer: "episodic",
            source: "runtime",
            createdAt: "2026-02-25T00:00:00.000Z",
            updatedAt: "2026-02-26T00:00:00.000Z",
          },
        ],
      },
    });

    const preferIncoming = syncPersonalMemoryRuntimeBundle({
      personalContextDir: dir,
      bundleFile: bundleRel,
      conflictStrategy: "incoming",
    });
    expect(preferIncoming.incomingWon).toBe(1);
    runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as {
      episodic: Array<{ title: string }>;
    };
    expect(runtime.episodic[0]?.title).toBe("incoming older");
  });

  it("exports bundle with capped episodic count", () => {
    const dir = makeTempDir("openclaw-runtime-share-");
    writeJson(path.join(dir, PERSONAL_MEMORY_RUNTIME_STATE_FILE), {
      version: 1,
      working: [],
      episodic: Array.from({ length: 5 }, (_, i) => ({
        id: `episodic:${i}`,
        title: `e${i}`,
        content: `e${i}`,
        layer: "episodic",
        source: "runtime",
        createdAt: `2026-02-2${i}T00:00:00.000Z`,
        updatedAt: `2026-02-2${i}T00:00:00.000Z`,
      })),
    });

    const result = exportPersonalMemoryRuntimeBundle({
      personalContextDir: dir,
      maxEpisodic: 2,
    });

    expect(result.exportedEpisodic).toBe(2);
  });
});
