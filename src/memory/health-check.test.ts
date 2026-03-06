import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectBuiltinMemoryHealth, repairBuiltinMemoryHealth } from "./health-check.js";
import { requireNodeSqlite } from "./sqlite.js";

describe("memory health check", () => {
  let rootDir = "";

  afterEach(async () => {
    if (!rootDir) {
      return;
    }
    await fs.rm(rootDir, { recursive: true, force: true });
    rootDir = "";
  });

  it("detects and repairs stale files, orphan chunks, and duplicate chunks", async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-health-"));
    const workspaceDir = path.join(rootDir, "workspace");
    const dbPath = path.join(rootDir, "memory.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "memory", "a.md"), "alpha");
    await fs.writeFile(path.join(workspaceDir, "memory", "b.md"), "beta");
    await fs.writeFile(path.join(workspaceDir, "memory", "large.md"), "x".repeat(3000));

    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    const insertFile = db.prepare(
      "INSERT INTO files(path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    );
    insertFile.run("memory/a.md", "memory", "ha", now, 5);
    insertFile.run("memory/stale.md", "memory", "hs", now, 5);
    const insertChunk = db.prepare(
      "INSERT INTO chunks(id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertChunk.run("chunk-a", "memory/a.md", "memory", 1, 1, "ha", "mock", "alpha", "[]", now);
    insertChunk.run(
      "chunk-orphan",
      "memory/orphan.md",
      "memory",
      1,
      1,
      "ho",
      "mock",
      "orphan",
      "[]",
      now,
    );
    insertChunk.run("chunk-dup-1", "memory/a.md", "memory", 2, 2, "dup", "mock", "dup", "[]", now);
    insertChunk.run(
      "chunk-dup-2",
      "memory/a.md",
      "memory",
      3,
      3,
      "dup",
      "mock",
      "dup",
      "[]",
      now - 1,
    );
    db.close();

    const snapshot = await inspectBuiltinMemoryHealth({
      workspaceDir,
      dbPath,
      agentId: "main",
      sources: ["memory"],
      maxFileBytes: 1024,
    });
    expect(snapshot.counts.missingInIndex).toBe(2);
    expect(snapshot.counts.staleInIndex).toBe(1);
    expect(snapshot.counts.orphanChunks).toBe(1);
    expect(snapshot.counts.duplicateChunkGroups).toBe(1);
    expect(snapshot.counts.largeFiles).toBe(1);

    const repair = repairBuiltinMemoryHealth({
      dbPath,
      discoveredPathsBySource: new Map([
        ["memory", ["memory/a.md", "memory/b.md", "memory/large.md"]],
      ]),
    });
    expect(repair.removedOrphanChunks).toBe(1);
    expect(repair.removedDuplicateChunks).toBe(1);
    expect(repair.removedStaleFiles).toBe(1);

    const after = await inspectBuiltinMemoryHealth({
      workspaceDir,
      dbPath,
      agentId: "main",
      sources: ["memory"],
      maxFileBytes: 1024,
    });
    expect(after.counts.staleInIndex).toBe(0);
    expect(after.counts.orphanChunks).toBe(0);
    expect(after.counts.duplicateChunkGroups).toBe(0);
  });
});
