import fs from "node:fs/promises";
import path from "node:path";
import { listMemoryFiles, normalizeExtraMemoryPaths } from "./internal.js";
import { listSessionFilesForAgent, sessionPathForFile } from "./session-files.js";
import { requireNodeSqlite } from "./sqlite.js";
import type { MemorySource } from "./types.js";

const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";

export type MemoryHealthSnapshot = {
  counts: {
    missingInIndex: number;
    staleInIndex: number;
    orphanChunks: number;
    duplicateChunkGroups: number;
    largeFiles: number;
  };
  details: {
    missingInIndex: string[];
    staleInIndex: string[];
    orphanChunkIds: string[];
    duplicateChunkGroups: Array<{ source: string; path: string; hash: string; count: number }>;
    largeFiles: Array<{ path: string; bytes: number }>;
  };
  suggestions: string[];
};

export type MemoryHealthRepairResult = {
  removedOrphanChunks: number;
  removedDuplicateChunks: number;
  removedStaleFiles: number;
};

function normalizeRelPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function sortUnique(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => normalizeRelPath(value).trim()).filter(Boolean)),
  ).toSorted((a, b) => a.localeCompare(b));
}

async function discoverSourcePaths(params: {
  workspaceDir: string;
  agentId: string;
  sources: MemorySource[];
  extraPaths?: string[];
}): Promise<Map<MemorySource, string[]>> {
  const paths = new Map<MemorySource, string[]>();
  for (const source of params.sources) {
    if (source === "memory") {
      const files = await listMemoryFiles(
        params.workspaceDir,
        normalizeExtraMemoryPaths(params.workspaceDir, params.extraPaths),
      );
      const rel = files.map((absPath) =>
        normalizeRelPath(path.relative(params.workspaceDir, absPath)),
      );
      paths.set(source, sortUnique(rel));
      continue;
    }
    if (source === "sessions") {
      const files = await listSessionFilesForAgent(params.agentId);
      paths.set(source, sortUnique(files.map((file) => sessionPathForFile(file))));
    }
  }
  return paths;
}

function readIndexedPaths(
  db: import("node:sqlite").DatabaseSync,
  sources: MemorySource[],
): Map<MemorySource, string[]> {
  const out = new Map<MemorySource, string[]>();
  for (const source of sources) {
    out.set(source, []);
  }
  if (sources.length === 0) {
    return out;
  }
  const placeholders = sources.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT source, path FROM files WHERE source IN (${placeholders})`)
    .all(...sources) as Array<{ source: string; path: string }>;
  for (const row of rows) {
    if (row.source !== "memory" && row.source !== "sessions") {
      continue;
    }
    const existing = out.get(row.source) ?? [];
    existing.push(normalizeRelPath(row.path));
    out.set(row.source, existing);
  }
  for (const source of sources) {
    out.set(source, sortUnique(out.get(source) ?? []));
  }
  return out;
}

function diffPaths(
  discovered: string[],
  indexed: string[],
): {
  missingInIndex: string[];
  staleInIndex: string[];
} {
  const discoveredSet = new Set(discovered);
  const indexedSet = new Set(indexed);
  return {
    missingInIndex: discovered.filter((entry) => !indexedSet.has(entry)),
    staleInIndex: indexed.filter((entry) => !discoveredSet.has(entry)),
  };
}

async function detectLargeFiles(
  workspaceDir: string,
  relPaths: string[],
  maxFileBytes: number,
): Promise<Array<{ path: string; bytes: number }>> {
  const large: Array<{ path: string; bytes: number }> = [];
  for (const relPath of relPaths) {
    const absPath = path.join(workspaceDir, relPath);
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size <= maxFileBytes) {
      continue;
    }
    large.push({ path: relPath, bytes: stat.size });
  }
  return large.toSorted((a, b) => b.bytes - a.bytes);
}

function collectSuggestions(snapshot: MemoryHealthSnapshot): string[] {
  const suggestions: string[] = [];
  if (snapshot.counts.missingInIndex > 0) {
    suggestions.push("Run `openclaw memory index --force` to rebuild missing files.");
  }
  if (snapshot.counts.staleInIndex > 0) {
    suggestions.push("Run `openclaw memory health --repair` to prune stale index rows.");
  }
  if (snapshot.counts.orphanChunks > 0) {
    suggestions.push("Run `openclaw memory health --repair` to delete orphan chunks.");
  }
  if (snapshot.counts.duplicateChunkGroups > 0) {
    suggestions.push("Run `openclaw memory health --repair` to deduplicate repeated chunks.");
  }
  if (snapshot.counts.largeFiles > 0) {
    suggestions.push("Archive or split oversized files before indexing.");
  }
  return suggestions;
}

export async function inspectBuiltinMemoryHealth(params: {
  workspaceDir: string;
  dbPath: string;
  agentId: string;
  sources: MemorySource[];
  extraPaths?: string[];
  maxFileBytes: number;
}): Promise<MemoryHealthSnapshot> {
  const discovered = await discoverSourcePaths({
    workspaceDir: params.workspaceDir,
    agentId: params.agentId,
    sources: params.sources,
    extraPaths: params.extraPaths,
  });

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(params.dbPath, { readOnly: true });
  try {
    const indexed = readIndexedPaths(db, params.sources);
    const missingInIndex: string[] = [];
    const staleInIndex: string[] = [];
    for (const source of params.sources) {
      const diff = diffPaths(discovered.get(source) ?? [], indexed.get(source) ?? []);
      missingInIndex.push(...diff.missingInIndex);
      staleInIndex.push(...diff.staleInIndex);
    }

    const orphanRows = db
      .prepare(
        "SELECT c.id FROM chunks c LEFT JOIN files f ON f.path = c.path AND f.source = c.source WHERE f.path IS NULL",
      )
      .all() as Array<{ id: string }>;
    const duplicateRows = db
      .prepare(
        "SELECT source, path, hash, COUNT(*) as c FROM chunks GROUP BY source, path, hash HAVING COUNT(*) > 1",
      )
      .all() as Array<{ source: string; path: string; hash: string; c: number }>;
    const largeFiles = params.sources.includes("memory")
      ? await detectLargeFiles(
          params.workspaceDir,
          discovered.get("memory") ?? [],
          Math.max(1, params.maxFileBytes),
        )
      : [];

    const snapshot: MemoryHealthSnapshot = {
      counts: {
        missingInIndex: missingInIndex.length,
        staleInIndex: staleInIndex.length,
        orphanChunks: orphanRows.length,
        duplicateChunkGroups: duplicateRows.length,
        largeFiles: largeFiles.length,
      },
      details: {
        missingInIndex: sortUnique(missingInIndex),
        staleInIndex: sortUnique(staleInIndex),
        orphanChunkIds: sortUnique(orphanRows.map((row) => row.id)),
        duplicateChunkGroups: duplicateRows
          .map((row) => ({
            source: row.source,
            path: normalizeRelPath(row.path),
            hash: row.hash,
            count: row.c ?? 0,
          }))
          .toSorted((a, b) => b.count - a.count),
        largeFiles,
      },
      suggestions: [],
    };
    snapshot.suggestions = collectSuggestions(snapshot);
    return snapshot;
  } finally {
    db.close();
  }
}

export function repairBuiltinMemoryHealth(params: {
  dbPath: string;
  discoveredPathsBySource: Map<MemorySource, string[]>;
}): MemoryHealthRepairResult {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(params.dbPath, { allowExtension: true });
  const discoveredBySource = new Map<MemorySource, Set<string>>();
  for (const [source, values] of params.discoveredPathsBySource.entries()) {
    discoveredBySource.set(source, new Set(values.map((value) => normalizeRelPath(value))));
  }
  let removedOrphanChunks = 0;
  let removedDuplicateChunks = 0;
  let removedStaleFiles = 0;

  db.exec("BEGIN");
  try {
    const orphanRows = db
      .prepare(
        "SELECT c.id FROM chunks c LEFT JOIN files f ON f.path = c.path AND f.source = c.source WHERE f.path IS NULL",
      )
      .all() as Array<{ id: string }>;
    for (const row of orphanRows) {
      db.prepare("DELETE FROM chunks WHERE id = ?").run(row.id);
      try {
        db.prepare(`DELETE FROM ${FTS_TABLE} WHERE id = ?`).run(row.id);
      } catch {}
      try {
        db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(row.id);
      } catch {}
    }
    removedOrphanChunks += orphanRows.length;

    const chunkRows = db
      .prepare("SELECT rowid, id, source, path, hash, updated_at FROM chunks")
      .all() as Array<{
      rowid: number;
      id: string;
      source: string;
      path: string;
      hash: string;
      updated_at: number;
    }>;
    const groups = new Map<string, typeof chunkRows>();
    for (const row of chunkRows) {
      const key = `${row.source}:${normalizeRelPath(row.path)}:${row.hash}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    for (const rows of groups.values()) {
      if (rows.length <= 1) {
        continue;
      }
      rows.sort((a, b) => {
        if (a.updated_at !== b.updated_at) {
          return (b.updated_at ?? 0) - (a.updated_at ?? 0);
        }
        return b.rowid - a.rowid;
      });
      for (const row of rows.slice(1)) {
        db.prepare("DELETE FROM chunks WHERE id = ?").run(row.id);
        try {
          db.prepare(`DELETE FROM ${FTS_TABLE} WHERE id = ?`).run(row.id);
        } catch {}
        try {
          db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(row.id);
        } catch {}
        removedDuplicateChunks += 1;
      }
    }

    const staleRows = db.prepare("SELECT source, path FROM files").all() as Array<{
      source: string;
      path: string;
    }>;
    for (const row of staleRows) {
      if (row.source !== "memory" && row.source !== "sessions") {
        continue;
      }
      const discovered = discoveredBySource.get(row.source);
      if (discovered?.has(normalizeRelPath(row.path))) {
        continue;
      }
      db.prepare("DELETE FROM files WHERE source = ? AND path = ?").run(row.source, row.path);
      db.prepare("DELETE FROM chunks WHERE source = ? AND path = ?").run(row.source, row.path);
      try {
        db.prepare(`DELETE FROM ${FTS_TABLE} WHERE source = ? AND path = ?`).run(
          row.source,
          row.path,
        );
      } catch {}
      removedStaleFiles += 1;
    }

    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    db.close();
    throw err;
  }
  db.close();
  return { removedOrphanChunks, removedDuplicateChunks, removedStaleFiles };
}
