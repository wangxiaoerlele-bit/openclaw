import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { setVerbose } from "../globals.js";
import { inspectBuiltinMemoryHealth, repairBuiltinMemoryHealth } from "../memory/health-check.js";
import { getMemorySearchManager, type MemorySearchManagerResult } from "../memory/index.js";
import { listMemoryFiles, normalizeExtraMemoryPaths } from "../memory/internal.js";
import { listSessionFilesForAgent, sessionPathForFile } from "../memory/session-files.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import { formatErrorMessage, withManager } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";
import { withProgress, withProgressTotals } from "./progress.js";

type MemoryCommandOptions = {
  agent?: string;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  force?: boolean;
  verbose?: boolean;
  strict?: boolean;
  repair?: boolean;
  maxFileMb?: number;
};

type MemoryManager = NonNullable<MemorySearchManagerResult["manager"]>;
type MemoryManagerPurpose = Parameters<typeof getMemorySearchManager>[0]["purpose"];

type MemorySourceName = "memory" | "sessions";

type SourceScan = {
  source: MemorySourceName;
  totalFiles: number | null;
  issues: string[];
};

type MemorySourceScan = {
  sources: SourceScan[];
  totalFiles: number | null;
  issues: string[];
};

type MemorySourceAudit = {
  source: MemorySourceName;
  discovered: number;
  indexed: number;
  missingInIndex: string[];
  staleInIndex: string[];
};

type MemoryAuditResult = {
  agentId: string;
  backend: string;
  workspaceDir?: string;
  dbPath?: string;
  sources: MemorySourceAudit[];
  issues: string[];
};

function normalizeIndexedPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function sortUniquePaths(values: string[]): string[] {
  const normalized = values.map((value) => normalizeIndexedPath(value).trim()).filter(Boolean);
  return Array.from(new Set(normalized)).toSorted((a, b) => a.localeCompare(b));
}

function isMemorySourceName(value: string): value is MemorySourceName {
  return value === "memory" || value === "sessions";
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
  const missingInIndex = discovered.filter((entry) => !indexedSet.has(entry));
  const staleInIndex = indexed.filter((entry) => !discoveredSet.has(entry));
  return { missingInIndex, staleInIndex };
}

async function discoverSourcePaths(params: {
  workspaceDir: string;
  agentId: string;
  sources: MemorySourceName[];
  extraPaths?: string[];
}): Promise<{ paths: Map<MemorySourceName, string[]>; issues: string[] }> {
  const discovered = new Map<MemorySourceName, string[]>();
  const issues: string[] = [];
  for (const source of params.sources) {
    if (source === "memory") {
      try {
        const files = await listMemoryFiles(params.workspaceDir, params.extraPaths);
        discovered.set(
          source,
          sortUniquePaths(
            files.map((absPath) =>
              normalizeIndexedPath(path.relative(params.workspaceDir, absPath)),
            ),
          ),
        );
      } catch (err) {
        const message = formatErrorMessage(err);
        issues.push(`memory file discovery failed: ${message}`);
        discovered.set(source, []);
      }
      continue;
    }
    if (source === "sessions") {
      try {
        const files = await listSessionFilesForAgent(params.agentId);
        discovered.set(source, sortUniquePaths(files.map((file) => sessionPathForFile(file))));
      } catch (err) {
        const message = formatErrorMessage(err);
        issues.push(`session file discovery failed: ${message}`);
        discovered.set(source, []);
      }
      continue;
    }
  }
  return { paths: discovered, issues };
}

function readIndexedPathsFromBuiltinStore(params: {
  dbPath?: string;
  sources: MemorySourceName[];
}): { paths: Map<MemorySourceName, string[]>; issues: string[] } {
  const paths = new Map<MemorySourceName, string[]>();
  const issues: string[] = [];
  for (const source of params.sources) {
    paths.set(source, []);
  }
  if (!params.dbPath) {
    issues.push("memory db path unavailable");
    return { paths, issues };
  }
  const dbPath = params.dbPath.trim();
  if (!dbPath) {
    issues.push("memory db path unavailable");
    return { paths, issues };
  }

  const { DatabaseSync } = requireNodeSqlite();
  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const fileTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'files'")
      .get() as { name?: string } | undefined;
    if (!fileTable?.name) {
      issues.push(`files table missing in memory db (${shortenHomePath(dbPath)})`);
      return { paths, issues };
    }
    if (params.sources.length === 0) {
      return { paths, issues };
    }
    const placeholders = params.sources.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT path, source FROM files WHERE source IN (${placeholders})`)
      .all(...params.sources) as Array<{ path: string; source: string }>;
    for (const row of rows) {
      if (!row || typeof row.path !== "string" || !isMemorySourceName(row.source)) {
        continue;
      }
      const existing = paths.get(row.source) ?? [];
      existing.push(normalizeIndexedPath(row.path));
      paths.set(row.source, existing);
    }
    for (const source of params.sources) {
      paths.set(source, sortUniquePaths(paths.get(source) ?? []));
    }
  } catch (err) {
    const message = formatErrorMessage(err);
    issues.push(`memory db read failed (${shortenHomePath(dbPath)}): ${message}`);
  } finally {
    try {
      db?.close();
    } catch {}
  }
  return { paths, issues };
}

function formatSourceLabel(source: string, workspaceDir: string, agentId: string): string {
  if (source === "memory") {
    return shortenHomeInString(
      `memory (MEMORY.md + ${path.join(workspaceDir, "memory")}${path.sep}*.md)`,
    );
  }
  if (source === "sessions") {
    const stateDir = resolveStateDir(process.env, os.homedir);
    return shortenHomeInString(
      `sessions (${path.join(stateDir, "agents", agentId, "sessions")}${path.sep}*.jsonl)`,
    );
  }
  return source;
}

function resolveAgent(cfg: ReturnType<typeof loadConfig>, agent?: string) {
  const trimmed = agent?.trim();
  if (trimmed) {
    return trimmed;
  }
  return resolveDefaultAgentId(cfg);
}

function resolveAgentIds(cfg: ReturnType<typeof loadConfig>, agent?: string): string[] {
  const trimmed = agent?.trim();
  if (trimmed) {
    return [trimmed];
  }
  const list = cfg.agents?.list ?? [];
  if (list.length > 0) {
    return list.map((entry) => entry.id).filter(Boolean);
  }
  return [resolveDefaultAgentId(cfg)];
}

function formatExtraPaths(workspaceDir: string, extraPaths: string[]): string[] {
  return normalizeExtraMemoryPaths(workspaceDir, extraPaths).map((entry) => shortenHomePath(entry));
}

async function withMemoryManagerForAgent(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  purpose?: MemoryManagerPurpose;
  run: (manager: MemoryManager) => Promise<void>;
}): Promise<void> {
  const managerParams: Parameters<typeof getMemorySearchManager>[0] = {
    cfg: params.cfg,
    agentId: params.agentId,
  };
  if (params.purpose) {
    managerParams.purpose = params.purpose;
  }
  await withManager<MemoryManager>({
    getManager: () => getMemorySearchManager(managerParams),
    onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
    onCloseError: (err) =>
      defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
    close: async (manager) => {
      await manager.close?.();
    },
    run: params.run,
  });
}

async function checkReadableFile(pathname: string): Promise<{ exists: boolean; issue?: string }> {
  try {
    await fs.access(pathname, fsSync.constants.R_OK);
    return { exists: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { exists: false };
    }
    return {
      exists: true,
      issue: `${shortenHomePath(pathname)} not readable (${code ?? "error"})`,
    };
  }
}

async function scanSessionFiles(agentId: string): Promise<SourceScan> {
  const issues: string[] = [];
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const totalFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
    ).length;
    return { source: "sessions", totalFiles, issues };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`sessions directory missing (${shortenHomePath(sessionsDir)})`);
      return { source: "sessions", totalFiles: 0, issues };
    }
    issues.push(
      `sessions directory not accessible (${shortenHomePath(sessionsDir)}): ${code ?? "error"}`,
    );
    return { source: "sessions", totalFiles: null, issues };
  }
}

async function scanMemoryFiles(
  workspaceDir: string,
  extraPaths: string[] = [],
): Promise<SourceScan> {
  const issues: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altMemoryFile = path.join(workspaceDir, "memory.md");
  const memoryDir = path.join(workspaceDir, "memory");

  const primary = await checkReadableFile(memoryFile);
  const alt = await checkReadableFile(altMemoryFile);
  if (primary.issue) {
    issues.push(primary.issue);
  }
  if (alt.issue) {
    issues.push(alt.issue);
  }

  const resolvedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  for (const extraPath of resolvedExtraPaths) {
    try {
      const stat = await fs.lstat(extraPath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      const extraCheck = await checkReadableFile(extraPath);
      if (extraCheck.issue) {
        issues.push(extraCheck.issue);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        issues.push(`additional memory path missing (${shortenHomePath(extraPath)})`);
      } else {
        issues.push(
          `additional memory path not accessible (${shortenHomePath(extraPath)}): ${code ?? "error"}`,
        );
      }
    }
  }

  let dirReadable: boolean | null = null;
  try {
    await fs.access(memoryDir, fsSync.constants.R_OK);
    dirReadable = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`memory directory missing (${shortenHomePath(memoryDir)})`);
      dirReadable = false;
    } else {
      issues.push(
        `memory directory not accessible (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let listed: string[] = [];
  let listedOk = false;
  try {
    listed = await listMemoryFiles(workspaceDir, resolvedExtraPaths);
    listedOk = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (dirReadable !== null) {
      issues.push(
        `memory directory scan failed (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let totalFiles: number | null = 0;
  if (dirReadable === null) {
    totalFiles = null;
  } else {
    const files = new Set<string>(listedOk ? listed : []);
    if (!listedOk) {
      if (primary.exists) {
        files.add(memoryFile);
      }
      if (alt.exists) {
        files.add(altMemoryFile);
      }
    }
    totalFiles = files.size;
  }

  if ((totalFiles ?? 0) === 0 && issues.length === 0) {
    issues.push(`no memory files found in ${shortenHomePath(workspaceDir)}`);
  }

  return { source: "memory", totalFiles, issues };
}

async function summarizeQmdIndexArtifact(manager: MemoryManager): Promise<string | null> {
  const status = manager.status?.();
  if (!status || status.backend !== "qmd") {
    return null;
  }
  const dbPath = status.dbPath?.trim();
  if (!dbPath) {
    return null;
  }
  let stat: fsSync.Stats;
  try {
    stat = await fs.stat(dbPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`QMD index file not found: ${shortenHomePath(dbPath)}`, { cause: err });
    }
    throw new Error(
      `QMD index file check failed: ${shortenHomePath(dbPath)} (${code ?? "error"})`,
      { cause: err },
    );
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`QMD index file is empty: ${shortenHomePath(dbPath)}`);
  }
  return `QMD index: ${shortenHomePath(dbPath)} (${stat.size} bytes)`;
}

async function scanMemorySources(params: {
  workspaceDir: string;
  agentId: string;
  sources: MemorySourceName[];
  extraPaths?: string[];
}): Promise<MemorySourceScan> {
  const scans: SourceScan[] = [];
  const extraPaths = params.extraPaths ?? [];
  for (const source of params.sources) {
    if (source === "memory") {
      scans.push(await scanMemoryFiles(params.workspaceDir, extraPaths));
    }
    if (source === "sessions") {
      scans.push(await scanSessionFiles(params.agentId));
    }
  }
  const issues = scans.flatMap((scan) => scan.issues);
  const totals = scans.map((scan) => scan.totalFiles);
  const numericTotals = totals.filter((total): total is number => total !== null);
  const totalFiles = totals.some((total) => total === null)
    ? null
    : numericTotals.reduce((sum, total) => sum + total, 0);
  return { sources: scans, totalFiles, issues };
}

export async function runMemoryStatus(opts: MemoryCommandOptions) {
  setVerbose(Boolean(opts.verbose));
  const cfg = loadConfig();
  const agentIds = resolveAgentIds(cfg, opts.agent);
  const allResults: Array<{
    agentId: string;
    status: ReturnType<MemoryManager["status"]>;
    embeddingProbe?: Awaited<ReturnType<MemoryManager["probeEmbeddingAvailability"]>>;
    indexError?: string;
    scan?: MemorySourceScan;
  }> = [];

  for (const agentId of agentIds) {
    const managerPurpose = opts.index ? "default" : "status";
    await withMemoryManagerForAgent({
      cfg,
      agentId,
      purpose: managerPurpose,
      run: async (manager) => {
        const deep = Boolean(opts.deep || opts.index);
        let embeddingProbe:
          | Awaited<ReturnType<typeof manager.probeEmbeddingAvailability>>
          | undefined;
        let indexError: string | undefined;
        const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
        if (deep) {
          await withProgress({ label: "Checking memory…", total: 2 }, async (progress) => {
            progress.setLabel("Probing vector…");
            await manager.probeVectorAvailability();
            progress.tick();
            progress.setLabel("Probing embeddings…");
            embeddingProbe = await manager.probeEmbeddingAvailability();
            progress.tick();
          });
          if (opts.index && syncFn) {
            await withProgressTotals(
              {
                label: "Indexing memory…",
                total: 0,
                fallback: opts.verbose ? "line" : undefined,
              },
              async (update, progress) => {
                try {
                  await syncFn({
                    reason: "cli",
                    force: Boolean(opts.force),
                    progress: (syncUpdate) => {
                      update({
                        completed: syncUpdate.completed,
                        total: syncUpdate.total,
                        label: syncUpdate.label,
                      });
                      if (syncUpdate.label) {
                        progress.setLabel(syncUpdate.label);
                      }
                    },
                  });
                } catch (err) {
                  indexError = formatErrorMessage(err);
                  defaultRuntime.error(`Memory index failed: ${indexError}`);
                  process.exitCode = 1;
                }
              },
            );
          } else if (opts.index && !syncFn) {
            defaultRuntime.log("Memory backend does not support manual reindex.");
          }
        } else {
          await manager.probeVectorAvailability();
        }
        const status = manager.status();
        const sources = (
          status.sources?.length ? status.sources : ["memory"]
        ) as MemorySourceName[];
        const workspaceDir = status.workspaceDir;
        const scan = workspaceDir
          ? await scanMemorySources({
              workspaceDir,
              agentId,
              sources,
              extraPaths: status.extraPaths,
            })
          : undefined;
        allResults.push({ agentId, status, embeddingProbe, indexError, scan });
      },
    });
  }

  if (opts.json) {
    defaultRuntime.log(JSON.stringify(allResults, null, 2));
    return;
  }

  const rich = isRich();
  const heading = (text: string) => colorize(rich, theme.heading, text);
  const muted = (text: string) => colorize(rich, theme.muted, text);
  const info = (text: string) => colorize(rich, theme.info, text);
  const success = (text: string) => colorize(rich, theme.success, text);
  const warn = (text: string) => colorize(rich, theme.warn, text);
  const accent = (text: string) => colorize(rich, theme.accent, text);
  const label = (text: string) => muted(`${text}:`);

  for (const result of allResults) {
    const { agentId, status, embeddingProbe, indexError, scan } = result;
    const filesIndexed = status.files ?? 0;
    const chunksIndexed = status.chunks ?? 0;
    const totalFiles = scan?.totalFiles ?? null;
    const indexedLabel =
      totalFiles === null
        ? `${filesIndexed}/? files · ${chunksIndexed} chunks`
        : `${filesIndexed}/${totalFiles} files · ${chunksIndexed} chunks`;
    if (opts.index) {
      const line = indexError ? `Memory index failed: ${indexError}` : "Memory index complete.";
      defaultRuntime.log(line);
    }
    const requestedProvider = status.requestedProvider ?? status.provider;
    const modelLabel = status.model ?? status.provider;
    const storePath = status.dbPath ? shortenHomePath(status.dbPath) : "<unknown>";
    const workspacePath = status.workspaceDir ? shortenHomePath(status.workspaceDir) : "<unknown>";
    const sourceList = status.sources?.length ? status.sources.join(", ") : null;
    const extraPaths = status.workspaceDir
      ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
      : [];
    const lines = [
      `${heading("Memory Search")} ${muted(`(${agentId})`)}`,
      `${label("Provider")} ${info(status.provider)} ${muted(`(requested: ${requestedProvider})`)}`,
      `${label("Model")} ${info(modelLabel)}`,
      sourceList ? `${label("Sources")} ${info(sourceList)}` : null,
      extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null,
      `${label("Indexed")} ${success(indexedLabel)}`,
      `${label("Dirty")} ${status.dirty ? warn("yes") : muted("no")}`,
      `${label("Store")} ${info(storePath)}`,
      `${label("Workspace")} ${info(workspacePath)}`,
    ].filter(Boolean) as string[];
    if (embeddingProbe) {
      const state = embeddingProbe.ok ? "ready" : "unavailable";
      const stateColor = embeddingProbe.ok ? theme.success : theme.warn;
      lines.push(`${label("Embeddings")} ${colorize(rich, stateColor, state)}`);
      if (embeddingProbe.error) {
        lines.push(`${label("Embeddings error")} ${warn(embeddingProbe.error)}`);
      }
    }
    if (status.sourceCounts?.length) {
      lines.push(label("By source"));
      for (const entry of status.sourceCounts) {
        const total = scan?.sources?.find(
          (scanEntry) => scanEntry.source === entry.source,
        )?.totalFiles;
        const counts =
          total === null
            ? `${entry.files}/? files · ${entry.chunks} chunks`
            : `${entry.files}/${total} files · ${entry.chunks} chunks`;
        lines.push(`  ${accent(entry.source)} ${muted("·")} ${muted(counts)}`);
      }
    }
    if (status.fallback) {
      lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
    }
    if (status.vector) {
      const vectorState = status.vector.enabled
        ? status.vector.available === undefined
          ? "unknown"
          : status.vector.available
            ? "ready"
            : "unavailable"
        : "disabled";
      const vectorColor =
        vectorState === "ready"
          ? theme.success
          : vectorState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("Vector")} ${colorize(rich, vectorColor, vectorState)}`);
      if (status.vector.dims) {
        lines.push(`${label("Vector dims")} ${info(String(status.vector.dims))}`);
      }
      if (status.vector.extensionPath) {
        lines.push(`${label("Vector path")} ${info(shortenHomePath(status.vector.extensionPath))}`);
      }
      if (status.vector.loadError) {
        lines.push(`${label("Vector error")} ${warn(status.vector.loadError)}`);
      }
    }
    if (status.fts) {
      const ftsState = status.fts.enabled
        ? status.fts.available
          ? "ready"
          : "unavailable"
        : "disabled";
      const ftsColor =
        ftsState === "ready"
          ? theme.success
          : ftsState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("FTS")} ${colorize(rich, ftsColor, ftsState)}`);
      if (status.fts.error) {
        lines.push(`${label("FTS error")} ${warn(status.fts.error)}`);
      }
    }
    if (status.cache) {
      const cacheState = status.cache.enabled ? "enabled" : "disabled";
      const cacheColor = status.cache.enabled ? theme.success : theme.muted;
      const suffix =
        status.cache.enabled && typeof status.cache.entries === "number"
          ? ` (${status.cache.entries} entries)`
          : "";
      lines.push(`${label("Embedding cache")} ${colorize(rich, cacheColor, cacheState)}${suffix}`);
      if (status.cache.enabled && typeof status.cache.maxEntries === "number") {
        lines.push(`${label("Cache cap")} ${info(String(status.cache.maxEntries))}`);
      }
    }
    if (status.batch) {
      const batchState = status.batch.enabled ? "enabled" : "disabled";
      const batchColor = status.batch.enabled ? theme.success : theme.warn;
      const batchSuffix = ` (failures ${status.batch.failures}/${status.batch.limit})`;
      lines.push(
        `${label("Batch")} ${colorize(rich, batchColor, batchState)}${muted(batchSuffix)}`,
      );
      if (status.batch.lastError) {
        lines.push(`${label("Batch error")} ${warn(status.batch.lastError)}`);
      }
    }
    if (status.fallback?.reason) {
      lines.push(muted(status.fallback.reason));
    }
    if (indexError) {
      lines.push(`${label("Index error")} ${warn(indexError)}`);
    }
    if (scan?.issues.length) {
      lines.push(label("Issues"));
      for (const issue of scan.issues) {
        lines.push(`  ${warn(issue)}`);
      }
    }
    defaultRuntime.log(lines.join("\n"));
    defaultRuntime.log("");
  }
}

export async function runMemoryAudit(opts: MemoryCommandOptions): Promise<void> {
  setVerbose(Boolean(opts.verbose));
  const cfg = loadConfig();
  const agentIds = resolveAgentIds(cfg, opts.agent);
  const allResults: MemoryAuditResult[] = [];

  for (const agentId of agentIds) {
    await withMemoryManagerForAgent({
      cfg,
      agentId,
      purpose: "status",
      run: async (manager) => {
        const status = manager.status();
        const statusSources = status.sources?.filter(isMemorySourceName) ?? [];
        const sources: MemorySourceName[] = statusSources.length > 0 ? statusSources : ["memory"];
        const issues: string[] = [];
        const sourceAudits: MemorySourceAudit[] = [];
        const discoveredPaths = new Map<MemorySourceName, string[]>();
        const indexedPaths = new Map<MemorySourceName, string[]>();

        if (!status.workspaceDir?.trim()) {
          issues.push("workspace path unavailable");
        } else {
          const discovery = await discoverSourcePaths({
            workspaceDir: status.workspaceDir,
            agentId,
            sources,
            extraPaths: status.extraPaths,
          });
          for (const source of sources) {
            discoveredPaths.set(source, discovery.paths.get(source) ?? []);
          }
          issues.push(...discovery.issues);
        }

        if (status.backend === "builtin") {
          const indexed = readIndexedPathsFromBuiltinStore({
            dbPath: status.dbPath,
            sources,
          });
          for (const source of sources) {
            indexedPaths.set(source, indexed.paths.get(source) ?? []);
          }
          issues.push(...indexed.issues);
        } else {
          for (const source of sources) {
            indexedPaths.set(source, []);
          }
          issues.push("path-level audit unavailable for qmd backend");
        }

        for (const source of sources) {
          const discovered = discoveredPaths.get(source) ?? [];
          const indexed = indexedPaths.get(source) ?? [];
          const diff = diffPaths(discovered, indexed);
          sourceAudits.push({
            source,
            discovered: discovered.length,
            indexed: indexed.length,
            missingInIndex: diff.missingInIndex,
            staleInIndex: diff.staleInIndex,
          });
        }

        allResults.push({
          agentId,
          backend: status.backend,
          workspaceDir: status.workspaceDir,
          dbPath: status.dbPath,
          sources: sourceAudits,
          issues,
        });
      },
    });
  }

  if (opts.json) {
    defaultRuntime.log(JSON.stringify(allResults, null, 2));
  } else {
    const rich = isRich();
    const heading = (text: string) => colorize(rich, theme.heading, text);
    const muted = (text: string) => colorize(rich, theme.muted, text);
    const info = (text: string) => colorize(rich, theme.info, text);
    const success = (text: string) => colorize(rich, theme.success, text);
    const warn = (text: string) => colorize(rich, theme.warn, text);
    const label = (text: string) => muted(`${text}:`);

    for (const result of allResults) {
      const lines = [
        `${heading("Memory Audit")} ${muted(`(${result.agentId})`)}`,
        `${label("Backend")} ${info(result.backend)}`,
        `${label("Workspace")} ${info(shortenHomePath(result.workspaceDir ?? "<unknown>"))}`,
        `${label("Store")} ${info(shortenHomePath(result.dbPath ?? "<unknown>"))}`,
      ];
      for (const source of result.sources) {
        const hasDiff = source.missingInIndex.length > 0 || source.staleInIndex.length > 0;
        const countLine = `${source.source}: discovered ${source.discovered} · indexed ${source.indexed} · missing ${source.missingInIndex.length} · stale ${source.staleInIndex.length}`;
        lines.push(hasDiff ? warn(countLine) : success(countLine));
        if (source.missingInIndex.length > 0) {
          lines.push(`  ${warn("missing in index:")}`);
          for (const entry of source.missingInIndex.slice(0, 20)) {
            lines.push(`    ${warn(entry)}`);
          }
          if (source.missingInIndex.length > 20) {
            lines.push(`    ${muted(`... ${source.missingInIndex.length - 20} more`)}`);
          }
        }
        if (source.staleInIndex.length > 0) {
          lines.push(`  ${warn("stale in index:")}`);
          for (const entry of source.staleInIndex.slice(0, 20)) {
            lines.push(`    ${warn(entry)}`);
          }
          if (source.staleInIndex.length > 20) {
            lines.push(`    ${muted(`... ${source.staleInIndex.length - 20} more`)}`);
          }
        }
      }
      if (result.issues.length > 0) {
        lines.push(label("Issues"));
        for (const issue of result.issues) {
          lines.push(`  ${warn(issue)}`);
        }
      }
      defaultRuntime.log(lines.join("\n"));
      defaultRuntime.log("");
    }
  }

  if (opts.strict) {
    const hasProblems = allResults.some(
      (result) =>
        result.issues.length > 0 ||
        result.sources.some(
          (source) => source.missingInIndex.length > 0 || source.staleInIndex.length > 0,
        ),
    );
    if (hasProblems) {
      process.exitCode = 1;
    }
  }
}

export async function runMemoryHealth(opts: MemoryCommandOptions): Promise<void> {
  setVerbose(Boolean(opts.verbose));
  const cfg = loadConfig();
  const agentIds = resolveAgentIds(cfg, opts.agent);
  const requestedMaxFileMb = typeof opts.maxFileMb === "number" ? opts.maxFileMb : 2;
  const maxFileBytes = Math.max(1, Math.floor(requestedMaxFileMb * 1024 * 1024));

  const allResults: Array<{
    agentId: string;
    backend: string;
    workspaceDir?: string;
    dbPath?: string;
    snapshot?: Awaited<ReturnType<typeof inspectBuiltinMemoryHealth>>;
    repair?: ReturnType<typeof repairBuiltinMemoryHealth>;
    issues: string[];
  }> = [];

  for (const agentId of agentIds) {
    await withMemoryManagerForAgent({
      cfg,
      agentId,
      purpose: "status",
      run: async (manager) => {
        const status = manager.status();
        const sources = status.sources?.filter(isMemorySourceName) ?? ["memory"];
        const issues: string[] = [];
        let snapshot: Awaited<ReturnType<typeof inspectBuiltinMemoryHealth>> | undefined;
        let repair: ReturnType<typeof repairBuiltinMemoryHealth> | undefined;

        if (status.backend !== "builtin") {
          issues.push("health check currently supports builtin backend only");
        } else if (!status.workspaceDir?.trim() || !status.dbPath?.trim()) {
          issues.push("workspace or db path unavailable");
        } else {
          snapshot = await inspectBuiltinMemoryHealth({
            workspaceDir: status.workspaceDir,
            dbPath: status.dbPath,
            agentId,
            sources,
            extraPaths: status.extraPaths,
            maxFileBytes,
          });
          if (opts.repair) {
            const discovered = await discoverSourcePaths({
              workspaceDir: status.workspaceDir,
              agentId,
              sources,
              extraPaths: status.extraPaths,
            });
            issues.push(...discovered.issues);
            repair = repairBuiltinMemoryHealth({
              dbPath: status.dbPath,
              discoveredPathsBySource: discovered.paths,
            });
            if (manager.sync) {
              await manager.sync({ reason: "cli", force: true });
            }
            snapshot = await inspectBuiltinMemoryHealth({
              workspaceDir: status.workspaceDir,
              dbPath: status.dbPath,
              agentId,
              sources,
              extraPaths: status.extraPaths,
              maxFileBytes,
            });
          }
        }
        allResults.push({
          agentId,
          backend: status.backend,
          workspaceDir: status.workspaceDir,
          dbPath: status.dbPath,
          snapshot,
          repair,
          issues,
        });
      },
    });
  }

  if (opts.json) {
    defaultRuntime.log(JSON.stringify(allResults, null, 2));
  } else {
    const rich = isRich();
    const heading = (text: string) => colorize(rich, theme.heading, text);
    const muted = (text: string) => colorize(rich, theme.muted, text);
    const info = (text: string) => colorize(rich, theme.info, text);
    const success = (text: string) => colorize(rich, theme.success, text);
    const warn = (text: string) => colorize(rich, theme.warn, text);
    const label = (text: string) => muted(`${text}:`);

    for (const result of allResults) {
      const lines = [
        `${heading("Memory Health")} ${muted(`(${result.agentId})`)}`,
        `${label("Backend")} ${info(result.backend)}`,
        `${label("Workspace")} ${info(shortenHomePath(result.workspaceDir ?? "<unknown>"))}`,
        `${label("Store")} ${info(shortenHomePath(result.dbPath ?? "<unknown>"))}`,
      ];
      if (result.snapshot) {
        const counts = result.snapshot.counts;
        const healthy =
          counts.missingInIndex === 0 &&
          counts.staleInIndex === 0 &&
          counts.orphanChunks === 0 &&
          counts.duplicateChunkGroups === 0 &&
          counts.largeFiles === 0;
        lines.push(
          healthy
            ? success("status: healthy")
            : warn(
                `status: issues (missing ${counts.missingInIndex}, stale ${counts.staleInIndex}, orphan ${counts.orphanChunks}, duplicate ${counts.duplicateChunkGroups}, large ${counts.largeFiles})`,
              ),
        );
        if (result.snapshot.suggestions.length > 0) {
          lines.push(label("Suggestions"));
          for (const item of result.snapshot.suggestions) {
            lines.push(`  ${warn(item)}`);
          }
        }
      }
      if (result.repair) {
        lines.push(
          `${label("Repair")} ${success(
            `removed orphan ${result.repair.removedOrphanChunks}, duplicate ${result.repair.removedDuplicateChunks}, stale files ${result.repair.removedStaleFiles}`,
          )}`,
        );
      }
      if (result.issues.length > 0) {
        lines.push(label("Issues"));
        for (const issue of result.issues) {
          lines.push(`  ${warn(issue)}`);
        }
      }
      defaultRuntime.log(lines.join("\n"));
      defaultRuntime.log("");
    }
  }

  if (opts.strict) {
    const hasIssues = allResults.some((result) => {
      if (result.issues.length > 0 || !result.snapshot) {
        return true;
      }
      const counts = result.snapshot.counts;
      return (
        counts.missingInIndex > 0 ||
        counts.staleInIndex > 0 ||
        counts.orphanChunks > 0 ||
        counts.duplicateChunkGroups > 0 ||
        counts.largeFiles > 0
      );
    });
    if (hasIssues) {
      process.exitCode = 1;
    }
  }
}

export function registerMemoryCli(program: Command) {
  const memory = program
    .command("memory")
    .description("Search, inspect, audit, and reindex memory files")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw memory status", "Show index and provider status."],
          ["openclaw memory audit --strict", "Audit discovered files versus indexed files."],
          ["openclaw memory health --repair --strict", "Run health checks and apply repairs."],
          ["openclaw memory index --force", "Force a full reindex."],
          ['openclaw memory search --query "deployment notes"', "Search indexed memory entries."],
          ["openclaw memory status --json", "Output machine-readable JSON."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.openclaw.ai/cli/memory")}\n`,
    );

  memory
    .command("status")
    .description("Show memory search index status")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .option("--deep", "Probe embedding provider availability")
    .option("--index", "Reindex if dirty (implies --deep)")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions & { force?: boolean }) => {
      await runMemoryStatus(opts);
    });

  memory
    .command("audit")
    .description("Compare discovered memory files with indexed files")
    .option("--agent <id>", "Agent id (default: all configured agents)")
    .option("--json", "Print JSON")
    .option("--strict", "Exit with code 1 when mismatches or issues are found", false)
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      await runMemoryAudit(opts);
    });

  memory
    .command("health")
    .description("Run memory health checks (missing index, orphan chunks, large files)")
    .option("--agent <id>", "Agent id (default: all configured agents)")
    .option("--json", "Print JSON")
    .option("--repair", "Apply health repairs and force reindex", false)
    .option("--max-file-mb <n>", "Large file threshold in MB", (value: string) => Number(value))
    .option("--strict", "Exit with code 1 when health issues are found", false)
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      await runMemoryHealth(opts);
    });

  memory
    .command("index")
    .description("Reindex memory files")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--force", "Force full reindex", false)
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      setVerbose(Boolean(opts.verbose));
      const cfg = loadConfig();
      const agentIds = resolveAgentIds(cfg, opts.agent);
      for (const agentId of agentIds) {
        await withMemoryManagerForAgent({
          cfg,
          agentId,
          run: async (manager) => {
            try {
              const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
              if (opts.verbose) {
                const status = manager.status();
                const rich = isRich();
                const heading = (text: string) => colorize(rich, theme.heading, text);
                const muted = (text: string) => colorize(rich, theme.muted, text);
                const info = (text: string) => colorize(rich, theme.info, text);
                const warn = (text: string) => colorize(rich, theme.warn, text);
                const label = (text: string) => muted(`${text}:`);
                const sourceLabels = (status.sources ?? []).map((source) =>
                  formatSourceLabel(source, status.workspaceDir ?? "", agentId),
                );
                const extraPaths = status.workspaceDir
                  ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
                  : [];
                const requestedProvider = status.requestedProvider ?? status.provider;
                const modelLabel = status.model ?? status.provider;
                const lines = [
                  `${heading("Memory Index")} ${muted(`(${agentId})`)}`,
                  `${label("Provider")} ${info(status.provider)} ${muted(
                    `(requested: ${requestedProvider})`,
                  )}`,
                  `${label("Model")} ${info(modelLabel)}`,
                  sourceLabels.length
                    ? `${label("Sources")} ${info(sourceLabels.join(", "))}`
                    : null,
                  extraPaths.length
                    ? `${label("Extra paths")} ${info(extraPaths.join(", "))}`
                    : null,
                ].filter(Boolean) as string[];
                if (status.fallback) {
                  lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
                }
                defaultRuntime.log(lines.join("\n"));
                defaultRuntime.log("");
              }
              const startedAt = Date.now();
              let lastLabel = "Indexing memory…";
              let lastCompleted = 0;
              let lastTotal = 0;
              const formatElapsed = () => {
                const elapsedMs = Math.max(0, Date.now() - startedAt);
                const seconds = Math.floor(elapsedMs / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
              };
              const formatEta = () => {
                if (lastTotal <= 0 || lastCompleted <= 0) {
                  return null;
                }
                const elapsedMs = Math.max(1, Date.now() - startedAt);
                const rate = lastCompleted / elapsedMs;
                if (!Number.isFinite(rate) || rate <= 0) {
                  return null;
                }
                const remainingMs = Math.max(0, (lastTotal - lastCompleted) / rate);
                const seconds = Math.floor(remainingMs / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
              };
              const buildLabel = () => {
                const elapsed = formatElapsed();
                const eta = formatEta();
                return eta
                  ? `${lastLabel} · elapsed ${elapsed} · eta ${eta}`
                  : `${lastLabel} · elapsed ${elapsed}`;
              };
              if (!syncFn) {
                defaultRuntime.log("Memory backend does not support manual reindex.");
                return;
              }
              await withProgressTotals(
                {
                  label: "Indexing memory…",
                  total: 0,
                  fallback: opts.verbose ? "line" : undefined,
                },
                async (update, progress) => {
                  const interval = setInterval(() => {
                    progress.setLabel(buildLabel());
                  }, 1000);
                  try {
                    await syncFn({
                      reason: "cli",
                      force: Boolean(opts.force),
                      progress: (syncUpdate) => {
                        if (syncUpdate.label) {
                          lastLabel = syncUpdate.label;
                        }
                        lastCompleted = syncUpdate.completed;
                        lastTotal = syncUpdate.total;
                        update({
                          completed: syncUpdate.completed,
                          total: syncUpdate.total,
                          label: buildLabel(),
                        });
                        progress.setLabel(buildLabel());
                      },
                    });
                  } finally {
                    clearInterval(interval);
                  }
                },
              );
              const qmdIndexSummary = await summarizeQmdIndexArtifact(manager);
              if (qmdIndexSummary) {
                defaultRuntime.log(qmdIndexSummary);
              }
              defaultRuntime.log(`Memory index updated (${agentId}).`);
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory index failed (${agentId}): ${message}`);
              process.exitCode = 1;
            }
          },
        });
      }
    });

  memory
    .command("search")
    .description("Search memory files")
    .argument("[query]", "Search query")
    .option("--query <text>", "Search query (alternative to positional argument)")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--max-results <n>", "Max results", (value: string) => Number(value))
    .option("--min-score <n>", "Minimum score", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(
      async (
        queryArg: string | undefined,
        opts: MemoryCommandOptions & {
          query?: string;
          maxResults?: number;
          minScore?: number;
        },
      ) => {
        const query = opts.query ?? queryArg;
        if (!query) {
          defaultRuntime.error(
            "Missing search query. Provide a positional query or use --query <text>.",
          );
          process.exitCode = 1;
          return;
        }
        const cfg = loadConfig();
        const agentId = resolveAgent(cfg, opts.agent);
        await withMemoryManagerForAgent({
          cfg,
          agentId,
          run: async (manager) => {
            let results: Awaited<ReturnType<typeof manager.search>>;
            try {
              results = await manager.search(query, {
                maxResults: opts.maxResults,
                minScore: opts.minScore,
              });
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory search failed: ${message}`);
              process.exitCode = 1;
              return;
            }
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ results }, null, 2));
              return;
            }
            if (results.length === 0) {
              defaultRuntime.log("No matches.");
              return;
            }
            const rich = isRich();
            const lines: string[] = [];
            for (const result of results) {
              lines.push(
                `${colorize(rich, theme.success, result.score.toFixed(3))} ${colorize(
                  rich,
                  theme.accent,
                  `${shortenHomePath(result.path)}:${result.startLine}-${result.endLine}`,
                )}`,
              );
              lines.push(colorize(rich, theme.muted, result.snippet));
              lines.push("");
            }
            defaultRuntime.log(lines.join("\n").trim());
          },
        });
      },
    );
}
