import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archivePersonalMemoryRuntimeEpisodic,
  PERSONAL_MEMORY_RUNTIME_EPISODIC_ARCHIVE_FILE,
} from "./runtime-archive.js";

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

function writeRuntimeState(personalContextDir: string, episodic: unknown[]) {
  fs.mkdirSync(personalContextDir, { recursive: true });
  fs.writeFileSync(
    path.join(personalContextDir, ".runtime-memory.json"),
    `${JSON.stringify({ version: 1, working: [], episodic }, null, 2)}\n`,
    "utf8",
  );
}

describe("archivePersonalMemoryRuntimeEpisodic", () => {
  it("archives old runtime episodic records and keeps recent ones", () => {
    const personalContextDir = makeTempDir("openclaw-runtime-archive-");
    writeRuntimeState(personalContextDir, [
      {
        id: "ep-old",
        layer: "episodic",
        title: "old",
        content: "old",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "ep-new",
        layer: "episodic",
        title: "new",
        content: "new",
        createdAt: "2026-02-26T00:00:00.000Z",
        updatedAt: "2026-02-26T00:00:00.000Z",
      },
    ]);

    const result = archivePersonalMemoryRuntimeEpisodic({
      personalContextDir,
      retainDays: 30,
      now: () => new Date("2026-02-27T00:00:00.000Z"),
    });

    expect(result.beforeEpisodic).toBe(2);
    expect(result.afterEpisodic).toBe(1);
    expect(result.candidates).toBe(1);
    expect(result.archivedAdded).toBe(1);

    const runtime = JSON.parse(
      fs.readFileSync(path.join(personalContextDir, ".runtime-memory.json"), "utf8"),
    ) as { episodic: Array<{ id: string }> };
    expect(runtime.episodic.map((r) => r.id)).toEqual(["ep-new"]);

    const archiveFile = path.join(
      personalContextDir,
      PERSONAL_MEMORY_RUNTIME_EPISODIC_ARCHIVE_FILE,
    );
    const lines = fs.readFileSync(archiveFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0] ?? "{}") as { id: string; record?: { id?: string } };
    expect(row.id).toBe("ep-old");
    expect(row.record?.id).toBe("ep-old");
  });

  it("dry-run does not mutate runtime state or create archive file", () => {
    const personalContextDir = makeTempDir("openclaw-runtime-archive-");
    writeRuntimeState(personalContextDir, [
      {
        id: "ep-old",
        layer: "episodic",
        title: "old",
        content: "old",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const runtimePath = path.join(personalContextDir, ".runtime-memory.json");
    const before = fs.readFileSync(runtimePath, "utf8");

    const result = archivePersonalMemoryRuntimeEpisodic({
      personalContextDir,
      retainDays: 30,
      dryRun: true,
      now: () => new Date("2026-02-27T00:00:00.000Z"),
    });

    expect(result.dryRun).toBe(true);
    expect(result.archivedAdded).toBe(1);
    expect(fs.readFileSync(runtimePath, "utf8")).toBe(before);
    expect(
      fs.existsSync(path.join(personalContextDir, PERSONAL_MEMORY_RUNTIME_EPISODIC_ARCHIVE_FILE)),
    ).toBe(false);
  });
});
