import path from "node:path";
import { clampInt, clampNumber } from "../utils.js";

export type MemoryTier = "hot" | "warm" | "cold";
export type MemoryTierBucket = MemoryTier | "legacy";

export type MemoryTieringConfig = {
  enabled: boolean;
  autoMigrate: boolean;
  hotWindowDays: number;
  warmWindowDays: number;
  maxMovesPerSync: number;
  retrieval: {
    hotBoost: number;
    warmBoost: number;
    coldBoost: number;
  };
  budget: {
    enabled: boolean;
    maxChars: number;
    warmSummaryChars: number;
    coldSnippetChars: number;
  };
};

export type MemoryTieringConfigInput = Partial<{
  enabled: boolean;
  autoMigrate: boolean;
  hotWindowDays: number;
  warmWindowDays: number;
  maxMovesPerSync: number;
  retrieval: Partial<{
    hotBoost: number;
    warmBoost: number;
    coldBoost: number;
  }>;
  budget: Partial<{
    enabled: boolean;
    maxChars: number;
    warmSummaryChars: number;
    coldSnippetChars: number;
  }>;
}>;

const DEFAULT_TIERING_CONFIG: MemoryTieringConfig = {
  enabled: true,
  autoMigrate: true,
  hotWindowDays: 7,
  warmWindowDays: 30,
  maxMovesPerSync: 200,
  retrieval: {
    hotBoost: 0.08,
    warmBoost: 0.03,
    coldBoost: 0,
  },
  budget: {
    enabled: true,
    maxChars: 12_000,
    warmSummaryChars: 320,
    coldSnippetChars: 180,
  },
};

const TIER_RANK: Record<MemoryTierBucket, number> = {
  hot: 3,
  warm: 2,
  legacy: 2,
  cold: 1,
};

function normalizePath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function resolveMemoryTierFromPath(relPath: string): MemoryTierBucket {
  const normalized = normalizePath(relPath);
  if (normalized.startsWith("memory/hot/")) {
    return "hot";
  }
  if (normalized.startsWith("memory/warm/")) {
    return "warm";
  }
  if (normalized.startsWith("memory/cold/")) {
    return "cold";
  }
  if (normalized === "MEMORY.md") {
    return "hot";
  }
  if (normalized.startsWith("memory/")) {
    return "legacy";
  }
  return "legacy";
}

export function resolveEffectiveTier(bucket: MemoryTierBucket): MemoryTier {
  if (bucket === "legacy") {
    return "warm";
  }
  return bucket;
}

export function resolveMemoryTierRank(bucket: MemoryTierBucket): number {
  return TIER_RANK[bucket];
}

export function resolveTierBoost(bucket: MemoryTierBucket, config: MemoryTieringConfig): number {
  const tier = resolveEffectiveTier(bucket);
  if (tier === "hot") {
    return config.retrieval.hotBoost;
  }
  if (tier === "warm") {
    return config.retrieval.warmBoost;
  }
  return config.retrieval.coldBoost;
}

export function resolveMemoryTieringConfig(raw?: MemoryTieringConfigInput): MemoryTieringConfig {
  const hotWindowDays = clampInt(
    raw?.hotWindowDays ?? DEFAULT_TIERING_CONFIG.hotWindowDays,
    1,
    3650,
  );
  const warmWindowDays = Math.max(
    hotWindowDays + 1,
    clampInt(raw?.warmWindowDays ?? DEFAULT_TIERING_CONFIG.warmWindowDays, 2, 7300),
  );
  return {
    enabled: raw?.enabled ?? DEFAULT_TIERING_CONFIG.enabled,
    autoMigrate: raw?.autoMigrate ?? DEFAULT_TIERING_CONFIG.autoMigrate,
    hotWindowDays,
    warmWindowDays,
    maxMovesPerSync: clampInt(
      raw?.maxMovesPerSync ?? DEFAULT_TIERING_CONFIG.maxMovesPerSync,
      1,
      5000,
    ),
    retrieval: {
      hotBoost: clampNumber(
        raw?.retrieval?.hotBoost ?? DEFAULT_TIERING_CONFIG.retrieval.hotBoost,
        -1,
        1,
      ),
      warmBoost: clampNumber(
        raw?.retrieval?.warmBoost ?? DEFAULT_TIERING_CONFIG.retrieval.warmBoost,
        -1,
        1,
      ),
      coldBoost: clampNumber(
        raw?.retrieval?.coldBoost ?? DEFAULT_TIERING_CONFIG.retrieval.coldBoost,
        -1,
        1,
      ),
    },
    budget: {
      enabled: raw?.budget?.enabled ?? DEFAULT_TIERING_CONFIG.budget.enabled,
      maxChars: clampInt(
        raw?.budget?.maxChars ?? DEFAULT_TIERING_CONFIG.budget.maxChars,
        1,
        200_000,
      ),
      warmSummaryChars: clampInt(
        raw?.budget?.warmSummaryChars ?? DEFAULT_TIERING_CONFIG.budget.warmSummaryChars,
        1,
        20_000,
      ),
      coldSnippetChars: clampInt(
        raw?.budget?.coldSnippetChars ?? DEFAULT_TIERING_CONFIG.budget.coldSnippetChars,
        1,
        20_000,
      ),
    },
  };
}

function resolveAgeDays(mtimeMs: number, nowMs: number): number {
  if (!Number.isFinite(mtimeMs)) {
    return 0;
  }
  const elapsed = Math.max(0, nowMs - mtimeMs);
  return elapsed / (24 * 60 * 60 * 1000);
}

function tierFromAgeDays(ageDays: number, config: MemoryTieringConfig): MemoryTier {
  if (ageDays <= config.hotWindowDays) {
    return "hot";
  }
  if (ageDays <= config.warmWindowDays) {
    return "warm";
  }
  return "cold";
}

type TierMigrationPlan = {
  from: MemoryTierBucket;
  to: MemoryTier;
  targetRelPath: string;
};

function resolveTierSuffix(relPath: string, from: MemoryTierBucket): string | null {
  const normalized = normalizePath(relPath);
  if (from === "legacy") {
    if (!normalized.startsWith("memory/")) {
      return null;
    }
    return normalized.slice("memory/".length);
  }
  const prefix = `memory/${from}/`;
  if (!normalized.startsWith(prefix)) {
    return null;
  }
  return normalized.slice(prefix.length);
}

function buildTierRelativePath(targetTier: MemoryTier, suffix: string): string {
  const normalizedSuffix = normalizePath(suffix).replace(/^\/+/, "");
  return normalizePath(path.posix.join("memory", targetTier, normalizedSuffix));
}

export function planTierMigration(params: {
  relPath: string;
  mtimeMs: number;
  nowMs?: number;
  config: MemoryTieringConfig;
}): TierMigrationPlan | null {
  const relPath = normalizePath(params.relPath);
  if (!params.config.enabled || !params.config.autoMigrate) {
    return null;
  }
  if (!relPath.startsWith("memory/") || !relPath.endsWith(".md")) {
    return null;
  }

  const from = resolveMemoryTierFromPath(relPath);
  if (from === "cold") {
    return null;
  }

  const suffix = resolveTierSuffix(relPath, from);
  if (!suffix) {
    return null;
  }

  let to: MemoryTier;
  if (from === "legacy") {
    // Untiered writes are normalized into hot first.
    to = "hot";
  } else {
    const nowMs = params.nowMs ?? Date.now();
    const ageDays = resolveAgeDays(params.mtimeMs, nowMs);
    to = tierFromAgeDays(ageDays, params.config);
  }

  if (from === to) {
    return null;
  }
  return {
    from,
    to,
    targetRelPath: buildTierRelativePath(to, suffix),
  };
}

export function scoreWithTierBoost(
  score: number,
  relPath: string,
  config: MemoryTieringConfig,
): number {
  if (!config.enabled) {
    return score;
  }
  return score + resolveTierBoost(resolveMemoryTierFromPath(relPath), config);
}

export function applyTieredSnippetBudget<
  T extends { path: string; snippet: string; score: number },
>(results: T[], config: MemoryTieringConfig): T[] {
  if (!config.enabled || !config.budget.enabled || results.length === 0) {
    return results;
  }

  const totalChars = results.reduce((sum, entry) => sum + (entry.snippet?.length ?? 0), 0);
  if (totalChars <= config.budget.maxChars) {
    return results;
  }

  const ordered = results
    .map((entry, index) => ({ entry, index }))
    .toSorted((a, b) => {
      const tierA = resolveMemoryTierRank(resolveMemoryTierFromPath(a.entry.path));
      const tierB = resolveMemoryTierRank(resolveMemoryTierFromPath(b.entry.path));
      if (tierA !== tierB) {
        return tierB - tierA;
      }
      if (a.entry.score !== b.entry.score) {
        return b.entry.score - a.entry.score;
      }
      return a.index - b.index;
    });

  let remaining = config.budget.maxChars;
  const out: T[] = [];
  for (const wrapped of ordered) {
    if (remaining <= 0) {
      break;
    }
    const bucket = resolveMemoryTierFromPath(wrapped.entry.path);
    const snippet = wrapped.entry.snippet ?? "";
    const tierCap =
      bucket === "hot"
        ? snippet.length
        : bucket === "warm" || bucket === "legacy"
          ? config.budget.warmSummaryChars
          : config.budget.coldSnippetChars;
    const sliceLen = Math.min(snippet.length, tierCap, remaining);
    if (sliceLen <= 0) {
      continue;
    }
    out.push({
      ...wrapped.entry,
      snippet: snippet.slice(0, sliceLen),
    });
    remaining -= sliceLen;
  }
  return out;
}

export function getTierDirectoryPaths(workspaceDir: string): Record<MemoryTier, string> {
  return {
    hot: path.join(workspaceDir, "memory", "hot"),
    warm: path.join(workspaceDir, "memory", "warm"),
    cold: path.join(workspaceDir, "memory", "cold"),
  };
}
