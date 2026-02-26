import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  PersonalMemoryLayer,
  PersonalMemoryRecord,
  PersonalMemorySearchHit,
  PersonalMemorySearchRequest,
  PersonalMemorySearchResult,
  PersonalMemoryStoreSnapshot,
} from "./types.js";

type SparseVector = Map<number, number>;
type SerializableSparseVector = Array<[number, number]>;

type SemanticRecordCacheEntry = {
  id: string;
  signature: string;
  vector: SerializableSparseVector;
};

type SemanticIndexCacheFileV1 = {
  version: 1;
  fingerprint: string;
  builtAt: string;
  vectorDim: number;
  records: SemanticRecordCacheEntry[];
};

type SemanticVectorResolver = (record: PersonalMemoryRecord) => SparseVector;
type SemanticScoreResolver = (record: PersonalMemoryRecord) => number | undefined;
type RerankSemanticVectorResolver = (record: PersonalMemoryRecord) => SparseVector;

type SqliteVecDbState = {
  db: DatabaseSync;
  loaded: boolean;
  extensionPath?: string;
  loadError?: string;
};

const SQLITE_VEC_DBS = new Map<string, SqliteVecDbState>();

export type PersonalMemorySearchCacheOptions = {
  enabled?: boolean;
  filePath?: string;
  fingerprint?: string;
  now?: () => Date;
  backend?: "sparse-cache" | "sqlite-vec";
  sqliteVec?: {
    dbPath?: string;
    extensionPath?: string;
  };
};

const VECTOR_DIM = 128;
const SQLITE_VEC_META_TABLE = "pm_semantic_meta";
const SQLITE_VEC_TABLE = "pm_semantic_vec";
const require = createRequire(import.meta.url);

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function tokenizeQuery(query: string): string[] {
  const normalized = normalize(query);
  if (!normalized) {
    return [];
  }
  const parts = normalized
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 0) {
    return [...new Set(parts)];
  }
  return [normalized];
}

function textFeatures(text: string): string[] {
  const normalized = normalize(text);
  if (!normalized) {
    return [];
  }
  const words = normalized
    .split(/[\s,.;:!?()[\]{}"'`/\\|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chars = Array.from(normalized.replace(/\s+/g, ""));
  const trigrams: string[] = [];
  for (let i = 0; i + 2 < chars.length; i += 1) {
    trigrams.push(`g:${chars[i]}${chars[i + 1]}${chars[i + 2]}`);
  }
  return [...new Set([...words.map((w) => `w:${w}`), ...trigrams])];
}

function hashFeature(feature: string): number {
  let hash = 2166136261;
  for (let i = 0; i < feature.length; i += 1) {
    hash ^= feature.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % VECTOR_DIM;
}

function buildSparseVector(texts: string[]): SparseVector {
  const vector = new Map<number, number>();
  for (const text of texts) {
    for (const feature of textFeatures(text)) {
      const idx = hashFeature(feature);
      vector.set(idx, (vector.get(idx) ?? 0) + 1);
    }
  }
  let norm = 0;
  for (const value of vector.values()) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm <= 0) {
    return vector;
  }
  for (const [key, value] of vector.entries()) {
    vector.set(key, value / norm);
  }
  return vector;
}

function cosineSimilarity(a: SparseVector, b: SparseVector): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [key, value] of small.entries()) {
    dot += value * (large.get(key) ?? 0);
  }
  return dot;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (index < haystack.length) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) {
      break;
    }
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function layerWeight(layer: PersonalMemoryLayer): number {
  if (layer === "working") {
    return 4;
  }
  if (layer === "episodic") {
    return 2;
  }
  return 1;
}

function buildSnippet(record: PersonalMemoryRecord, query: string): string {
  const text = record.content.trim();
  if (!text) {
    return "";
  }
  const lower = text.toLowerCase();
  const needle = normalize(query);
  const maxLen = 220;
  if (!needle) {
    return text.slice(0, maxLen);
  }
  const idx = lower.indexOf(needle);
  if (idx < 0) {
    return text.slice(0, maxLen);
  }
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + needle.length + 120);
  const clipped = text.slice(start, end).trim();
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${clipped}${suffix}`;
}

function scoreRecord(record: PersonalMemoryRecord, query: string, tokens: string[]) {
  const q = normalize(query);
  const title = record.title.toLowerCase();
  const content = record.content.toLowerCase();
  const tagText = (record.tags ?? []).join(" ").toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (q) {
    const titleMatches = countOccurrences(title, q);
    const contentMatches = countOccurrences(content, q);
    const tagMatches = countOccurrences(tagText, q);
    if (titleMatches > 0) {
      score += 24 * titleMatches;
      reasons.push("title:phrase");
    }
    if (contentMatches > 0) {
      score += 10 * contentMatches;
      reasons.push("content:phrase");
    }
    if (tagMatches > 0) {
      score += 14 * tagMatches;
      reasons.push("tags:phrase");
    }
  }

  for (const token of tokens) {
    if (!token || token === q) {
      continue;
    }
    const titleMatches = countOccurrences(title, token);
    const contentMatches = countOccurrences(content, token);
    const tagMatches = countOccurrences(tagText, token);
    if (titleMatches > 0) {
      score += 8 * titleMatches;
      reasons.push(`title:${token}`);
    }
    if (contentMatches > 0) {
      score += 3 * contentMatches;
      reasons.push(`content:${token}`);
    }
    if (tagMatches > 0) {
      score += 4 * tagMatches;
      reasons.push(`tags:${token}`);
    }
  }

  if (score <= 0) {
    return undefined;
  }

  score += layerWeight(record.layer);
  return {
    score,
    reasons: [...new Set(reasons)],
  };
}

function tokenCoverageScore(record: PersonalMemoryRecord, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  const title = record.title.toLowerCase();
  const content = record.content.toLowerCase();
  const tagText = (record.tags ?? []).join(" ").toLowerCase();
  let covered = 0;
  let titleCovered = 0;
  let tagCovered = 0;
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    const inTitle = title.includes(token);
    const inTags = tagText.includes(token);
    const inContent = content.includes(token);
    if (inTitle || inTags || inContent) {
      covered += 1;
    }
    if (inTitle) {
      titleCovered += 1;
    }
    if (inTags) {
      tagCovered += 1;
    }
  }
  const coverage = covered / tokens.length;
  const titleBoost = titleCovered / tokens.length;
  const tagBoost = tagCovered / tokens.length;
  return coverage + titleBoost * 0.35 + tagBoost * 0.2;
}

function freshnessScore(record: PersonalMemoryRecord): number {
  const ts = Date.parse(record.updatedAt || record.createdAt || "");
  if (!Number.isFinite(ts)) {
    return 0;
  }
  const ageMs = Math.max(0, Date.now() - ts);
  const halfLifeMs =
    record.layer === "working"
      ? 12 * 60 * 60 * 1000
      : record.layer === "episodic"
        ? 7 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
  return Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
}

function semanticTextsForRecord(record: PersonalMemoryRecord): string[] {
  return [
    record.title,
    record.content,
    ...(record.tags ?? []),
    typeof record.metadata?.kind === "string" ? record.metadata.kind : "",
  ];
}

function recordSemanticSignature(record: PersonalMemoryRecord): string {
  return [
    record.id,
    record.layer,
    record.title,
    record.content,
    record.createdAt,
    record.updatedAt ?? "",
    (record.tags ?? []).join("|"),
    typeof record.metadata?.kind === "string" ? record.metadata.kind : "",
  ].join("::");
}

function vectorToSerializable(vector: SparseVector): SerializableSparseVector {
  return [...vector.entries()].toSorted((a, b) => a[0] - b[0]);
}

function vectorFromSerializable(rows: SerializableSparseVector): SparseVector {
  const vector = new Map<number, number>();
  for (const [idx, value] of rows) {
    if (!Number.isFinite(idx) || !Number.isFinite(value)) {
      continue;
    }
    vector.set(idx, value);
  }
  return vector;
}

function buildRecordSemanticVector(record: PersonalMemoryRecord): SparseVector {
  return buildSparseVector(semanticTextsForRecord(record));
}

function semanticScoreRecord(
  record: PersonalMemoryRecord,
  queryVector: SparseVector | undefined,
  resolveVector: SemanticVectorResolver | undefined,
): number {
  if (!queryVector || queryVector.size === 0) {
    return 0;
  }
  const rv = resolveVector ? resolveVector(record) : buildRecordSemanticVector(record);
  return cosineSimilarity(queryVector, rv);
}

function clampRerankTopK(value: number | undefined, limit: number): number {
  const fallback = Math.max(limit, Math.min(20, limit * 3));
  if (!Number.isFinite(value ?? NaN)) {
    return fallback;
  }
  return Math.max(limit, Math.min(50, Math.floor(value!)));
}

function clampRerankLambda(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0.72;
  }
  return Math.max(0.1, Math.min(0.95, value));
}

function denseVectorFromSparse(vector: SparseVector): number[] {
  const dense = Array.from({ length: VECTOR_DIM }, () => 0);
  for (const [idx, value] of vector.entries()) {
    if (idx >= 0 && idx < VECTOR_DIM) {
      dense[idx] = value;
    }
  }
  return dense;
}

function denseVectorBlob(vector: SparseVector): Buffer {
  return Buffer.from(new Float32Array(denseVectorFromSparse(vector)).buffer);
}

function sqliteVecSignatureRows(snapshot: PersonalMemoryStoreSnapshot): Array<{
  record: PersonalMemoryRecord;
  signature: string;
}> {
  return [...snapshot.working, ...snapshot.episodic, ...snapshot.semantic].map((record) => ({
    record,
    signature: recordSemanticSignature(record),
  }));
}

function getOrOpenSqliteVecDb(params: {
  dbPath: string;
  extensionPath?: string;
}): SqliteVecDbState {
  const dbPath = path.resolve(params.dbPath);
  const cached = SQLITE_VEC_DBS.get(dbPath);
  if (cached) {
    if (!cached.loaded && params.extensionPath?.trim()) {
      // Retry once with explicit path if caller provides one later.
      cached.loadError = undefined;
      cached.loaded = false;
    } else {
      return cached;
    }
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const state: SqliteVecDbState = cached ?? {
    db: new DatabaseSync(dbPath, { allowExtension: true }),
    loaded: false,
  };
  try {
    const sqliteVec = require("sqlite-vec") as {
      load: (db: DatabaseSync) => void;
      getLoadablePath: () => string;
    };
    const resolvedPath = params.extensionPath?.trim() ? params.extensionPath.trim() : undefined;
    state.db.enableLoadExtension(true);
    if (resolvedPath) {
      state.db.loadExtension(resolvedPath);
      state.extensionPath = resolvedPath;
    } else {
      sqliteVec.load(state.db);
      state.extensionPath = sqliteVec.getLoadablePath();
    }
    state.db.exec(
      `CREATE TABLE IF NOT EXISTS ${SQLITE_VEC_META_TABLE} (\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  signature TEXT NOT NULL\n` +
        `)`,
    );
    state.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${SQLITE_VEC_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${VECTOR_DIM}]\n` +
        `)`,
    );
    state.loaded = true;
    state.loadError = undefined;
  } catch (err) {
    state.loaded = false;
    state.loadError = err instanceof Error ? err.message : String(err);
  }
  SQLITE_VEC_DBS.set(dbPath, state);
  return state;
}

function syncSqliteVecIndex(
  db: DatabaseSync,
  snapshot: PersonalMemoryStoreSnapshot,
): { recordCount: number } {
  const rows = sqliteVecSignatureRows(snapshot);
  const wanted = new Map(rows.map((row) => [row.record.id, row]));
  const existing = db.prepare(`SELECT id, signature FROM ${SQLITE_VEC_META_TABLE}`).all() as Array<{
    id: string;
    signature: string;
  }>;
  const toDelete: string[] = [];
  const toUpsert: Array<{ record: PersonalMemoryRecord; signature: string }> = [];

  const existingMap = new Map(existing.map((row) => [row.id, row.signature]));
  for (const [id, signature] of existingMap.entries()) {
    const next = wanted.get(id);
    if (!next) {
      toDelete.push(id);
      continue;
    }
    if (next.signature !== signature) {
      toUpsert.push(next);
    }
  }
  for (const [id, row] of wanted.entries()) {
    if (!existingMap.has(id)) {
      toUpsert.push(row);
    }
  }

  if (toDelete.length > 0 || toUpsert.length > 0) {
    db.exec("BEGIN");
    try {
      const deleteVec = db.prepare(`DELETE FROM ${SQLITE_VEC_TABLE} WHERE id = ?`);
      const deleteMeta = db.prepare(`DELETE FROM ${SQLITE_VEC_META_TABLE} WHERE id = ?`);
      const insertVec = db.prepare(`INSERT INTO ${SQLITE_VEC_TABLE} (id, embedding) VALUES (?, ?)`);
      const upsertMeta = db.prepare(
        `INSERT INTO ${SQLITE_VEC_META_TABLE} (id, signature) VALUES (?, ?)\n` +
          `ON CONFLICT(id) DO UPDATE SET signature=excluded.signature`,
      );
      for (const id of toDelete) {
        deleteVec.run(id);
        deleteMeta.run(id);
      }
      for (const row of toUpsert) {
        deleteVec.run(row.record.id);
        insertVec.run(row.record.id, denseVectorBlob(buildRecordSemanticVector(row.record)));
        upsertMeta.run(row.record.id, row.signature);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return { recordCount: wanted.size };
}

function sqliteVecSemanticScores(params: {
  snapshot: PersonalMemoryStoreSnapshot;
  query: string;
  limit: number;
  dbPath: string;
  extensionPath?: string;
}): {
  byId: Map<string, number>;
  recordCount: number;
  dbPath: string;
  extensionPath?: string;
} {
  const qv = buildSparseVector([params.query]);
  if (qv.size === 0) {
    return {
      byId: new Map(),
      recordCount: 0,
      dbPath: path.resolve(params.dbPath),
      extensionPath: undefined,
    };
  }
  const state = getOrOpenSqliteVecDb({
    dbPath: params.dbPath,
    extensionPath: params.extensionPath,
  });
  if (!state.loaded) {
    throw new Error(state.loadError ?? "sqlite-vec unavailable");
  }
  const synced = syncSqliteVecIndex(state.db, params.snapshot);
  const queryLimit = Math.max(25, Math.min(200, params.limit * 4));
  const rows = state.db
    .prepare(
      `SELECT id, vec_distance_cosine(embedding, ?) AS dist\n` +
        `FROM ${SQLITE_VEC_TABLE}\n` +
        `ORDER BY dist ASC\n` +
        `LIMIT ?`,
    )
    .all(denseVectorBlob(qv), queryLimit) as Array<{ id: string; dist: number }>;
  const byId = new Map<string, number>();
  for (const row of rows) {
    const score = Number.isFinite(row.dist) ? Math.max(0, 1 - row.dist) : 0;
    if (score > 0) {
      byId.set(row.id, score);
    }
  }
  return {
    byId,
    recordCount: synced.recordCount,
    dbPath: path.resolve(params.dbPath),
    extensionPath: state.extensionPath,
  };
}

function searchPersonalMemorySnapshotInternal(
  snapshot: PersonalMemoryStoreSnapshot,
  request: PersonalMemorySearchRequest,
  opts?: {
    resolveSemanticVector?: SemanticVectorResolver;
    resolveSemanticScore?: SemanticScoreResolver;
    rerankSemanticVector?: RerankSemanticVectorResolver;
    cacheMeta?: PersonalMemorySearchResult["cache"];
  },
): PersonalMemorySearchResult {
  const query = request.query.trim();
  const limit = Math.max(1, Math.min(50, request.limit ?? 10));
  const mode = request.mode ?? "hybrid";
  const tokens = tokenizeQuery(query);
  const layerSet = request.layers ? new Set(request.layers) : undefined;
  const candidates = [...snapshot.working, ...snapshot.episodic, ...snapshot.semantic].filter(
    (record) => !layerSet || layerSet.has(record.layer),
  );
  const queryVector = mode === "keyword" ? undefined : buildSparseVector([query]);

  const scoredCandidates: Array<{
    record: PersonalMemoryRecord;
    effectiveScore: number;
    keywordScore: number;
    semanticScoreRaw?: number;
    reasons: string[];
  }> = [];
  for (const record of candidates) {
    const keyword = scoreRecord(record, query, tokens);
    const semantic =
      opts?.resolveSemanticScore?.(record) ??
      semanticScoreRecord(record, queryVector, opts?.resolveSemanticVector);
    const keywordScore = keyword?.score ?? 0;
    const semanticBoost = semantic > 0 ? Math.round(semantic * 40) : 0;
    const effectiveScore =
      mode === "keyword"
        ? keywordScore
        : mode === "semantic"
          ? semanticBoost + layerWeight(record.layer)
          : keywordScore + semanticBoost;
    if (effectiveScore <= 0) {
      continue;
    }
    const reasons = [
      ...new Set([...(keyword?.reasons ?? []), ...(semanticBoost > 0 ? ["semantic"] : [])]),
    ];
    scoredCandidates.push({
      record,
      effectiveScore,
      keywordScore,
      semanticScoreRaw: semanticBoost > 0 ? Number(semantic.toFixed(4)) : undefined,
      reasons,
    });
  }

  const baseOrdered = scoredCandidates.toSorted((a, b) => {
    if (a.effectiveScore !== b.effectiveScore) {
      return b.effectiveScore - a.effectiveScore;
    }
    if (a.record.layer !== b.record.layer) {
      return a.record.layer.localeCompare(b.record.layer);
    }
    return a.record.title.localeCompare(b.record.title, "zh-CN");
  });

  const rerankEnabled = mode !== "keyword" && request.rerank?.enabled !== false;
  const rerankTopK = clampRerankTopK(request.rerank?.topK, limit);
  const rerankLambda = clampRerankLambda(request.rerank?.lambda);
  const rerankStrategy = request.rerank?.strategy === "mmr-lite" ? "mmr-lite" : "hybrid-v2";
  let ordered = baseOrdered;
  let rerankMeta: PersonalMemorySearchResult["rerank"] | undefined;

  if (!rerankEnabled) {
    rerankMeta = {
      enabled: false,
      applied: false,
      strategy: rerankStrategy,
      topK: rerankTopK,
      rerankedCount: 0,
      movedCount: 0,
      reason: mode === "keyword" ? "mode=keyword" : "disabled",
    };
  } else if (baseOrdered.length <= 1) {
    rerankMeta = {
      enabled: true,
      applied: false,
      strategy: rerankStrategy,
      topK: rerankTopK,
      rerankedCount: baseOrdered.length,
      movedCount: 0,
      reason: "insufficient-candidates",
    };
  } else if (rerankStrategy === "mmr-lite") {
    const poolSize = Math.min(rerankTopK, baseOrdered.length);
    const pool = baseOrdered.slice(0, poolSize);
    const tail = baseOrdered.slice(poolSize);
    const relevanceMax = Math.max(1, ...pool.map((c) => c.effectiveScore));
    const remaining = [...pool];
    const selected: typeof pool = [];
    const vectorCache = new Map<string, SparseVector>();
    const getVector = (record: PersonalMemoryRecord): SparseVector => {
      const cached = vectorCache.get(record.id);
      if (cached) {
        return cached;
      }
      const v =
        opts?.rerankSemanticVector?.(record) ??
        opts?.resolveSemanticVector?.(record) ??
        buildRecordSemanticVector(record);
      vectorCache.set(record.id, v);
      return v;
    };
    while (remaining.length > 0) {
      let bestIdx = 0;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const [idx, candidate] of remaining.entries()) {
        const relevance = candidate.effectiveScore / relevanceMax;
        let diversityPenalty = 0;
        if (selected.length > 0) {
          const cv = getVector(candidate.record);
          for (const picked of selected) {
            diversityPenalty = Math.max(
              diversityPenalty,
              cosineSimilarity(cv, getVector(picked.record)),
            );
          }
        }
        const mmrScore = rerankLambda * relevance - (1 - rerankLambda) * diversityPenalty;
        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIdx = idx;
        }
      }
      const [picked] = remaining.splice(bestIdx, 1);
      if (picked) {
        selected.push(picked);
      }
    }
    const movedCount = pool.reduce(
      (acc, item, idx) => acc + (selected[idx]?.record.id === item.record.id ? 0 : 1),
      0,
    );
    ordered = [...selected, ...tail];
    rerankMeta = {
      enabled: true,
      applied: true,
      strategy: "mmr-lite",
      topK: rerankTopK,
      rerankedCount: poolSize,
      movedCount,
      reason: "ok",
    };
  } else {
    const poolSize = Math.min(rerankTopK, baseOrdered.length);
    const pool = baseOrdered.slice(0, poolSize);
    const tail = baseOrdered.slice(poolSize);
    const relevanceMax = Math.max(1, ...pool.map((c) => c.effectiveScore));
    const rescored = pool
      .map((candidate) => {
        const relevance = candidate.effectiveScore / relevanceMax;
        const semantic = candidate.semanticScoreRaw ?? 0;
        const coverage = tokenCoverageScore(candidate.record, tokens);
        const freshness = freshnessScore(candidate.record);
        const titlePhraseBoost = candidate.reasons.includes("title:phrase") ? 0.25 : 0;
        const tagPhraseBoost = candidate.reasons.includes("tags:phrase") ? 0.15 : 0;
        const diversityHint = layerWeight(candidate.record.layer) / 10;
        const score =
          relevance * 0.5 +
          semantic * 0.18 +
          coverage * 0.22 +
          freshness * 0.07 +
          titlePhraseBoost +
          tagPhraseBoost +
          diversityHint * 0.03;
        return { candidate, score };
      })
      .toSorted((a, b) => {
        if (a.score !== b.score) {
          return b.score - a.score;
        }
        return b.candidate.effectiveScore - a.candidate.effectiveScore;
      });
    const selected = rescored.map((item) => item.candidate);
    const movedCount = pool.reduce(
      (acc, item, idx) => acc + (selected[idx]?.record.id === item.record.id ? 0 : 1),
      0,
    );
    ordered = [...selected, ...tail];
    rerankMeta = {
      enabled: true,
      applied: true,
      strategy: "hybrid-v2",
      topK: rerankTopK,
      rerankedCount: poolSize,
      movedCount,
      reason: "ok",
    };
  }

  const hits: PersonalMemorySearchHit[] = ordered.map((candidate, idx) => {
    const hit: PersonalMemorySearchHit = {
      id: candidate.record.id,
      layer: candidate.record.layer,
      title: candidate.record.title,
      score: candidate.effectiveScore,
      keywordScore: candidate.keywordScore || undefined,
      semanticScore: candidate.semanticScoreRaw,
      reasons: [...candidate.reasons],
      snippet: buildSnippet(candidate.record, query),
      tags: candidate.record.tags ? [...candidate.record.tags] : undefined,
    };
    if (rerankMeta?.applied && idx < rerankMeta.rerankedCount) {
      hit.reasons = [...new Set([...hit.reasons, `rerank:${rerankMeta.strategy}`])];
    }
    return hit;
  });
  return {
    query,
    limit,
    mode,
    totalHits: ordered.length,
    hits: hits.slice(0, limit),
    rerank: rerankMeta,
    cache: opts?.cacheMeta,
  };
}

export function searchPersonalMemorySnapshot(
  snapshot: PersonalMemoryStoreSnapshot,
  request: PersonalMemorySearchRequest,
): PersonalMemorySearchResult {
  return searchPersonalMemorySnapshotInternal(snapshot, request);
}

function loadSemanticCache(filePath: string): SemanticIndexCacheFileV1 | undefined {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<SemanticIndexCacheFileV1>;
  if (parsed.version !== 1 || parsed.vectorDim !== VECTOR_DIM || !Array.isArray(parsed.records)) {
    return undefined;
  }
  return {
    version: 1,
    fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : "",
    builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : "",
    vectorDim: VECTOR_DIM,
    records: parsed.records
      .filter((entry): entry is SemanticRecordCacheEntry =>
        Boolean(
          entry &&
          typeof entry === "object" &&
          typeof entry.id === "string" &&
          typeof entry.signature === "string" &&
          Array.isArray(entry.vector),
        ),
      )
      .map((entry) => ({
        id: entry.id,
        signature: entry.signature,
        vector: entry.vector.filter(
          (row): row is [number, number] =>
            Array.isArray(row) &&
            row.length === 2 &&
            typeof row[0] === "number" &&
            typeof row[1] === "number",
        ),
      })),
  };
}

function buildSemanticCacheIndex(snapshot: PersonalMemoryStoreSnapshot): {
  byId: Map<string, { signature: string; vector: SparseVector }>;
  recordCount: number;
} {
  const all = [...snapshot.working, ...snapshot.episodic, ...snapshot.semantic];
  const byId = new Map<string, { signature: string; vector: SparseVector }>();
  for (const record of all) {
    byId.set(record.id, {
      signature: recordSemanticSignature(record),
      vector: buildRecordSemanticVector(record),
    });
  }
  return { byId, recordCount: all.length };
}

function writeSemanticCache(filePath: string, payload: SemanticIndexCacheFileV1) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function searchPersonalMemorySnapshotSparseCached(
  snapshot: PersonalMemoryStoreSnapshot,
  request: PersonalMemorySearchRequest,
  cacheOptions: PersonalMemorySearchCacheOptions = {},
): PersonalMemorySearchResult {
  const mode = request.mode ?? "hybrid";
  const semanticNeeded = mode !== "keyword";
  if (!semanticNeeded) {
    return searchPersonalMemorySnapshotInternal(snapshot, request, {
      cacheMeta: { enabled: false, backend: "sparse-cache", reason: "mode=keyword" },
    });
  }
  if (cacheOptions.enabled === false) {
    return searchPersonalMemorySnapshotInternal(snapshot, request, {
      cacheMeta: { enabled: false, backend: "sparse-cache", reason: "disabled" },
    });
  }
  const filePath = cacheOptions.filePath;
  const fingerprint = cacheOptions.fingerprint;
  if (!filePath || !fingerprint) {
    return searchPersonalMemorySnapshotInternal(snapshot, request, {
      cacheMeta: { enabled: false, backend: "sparse-cache", reason: "missing-file-or-fingerprint" },
    });
  }

  const now = cacheOptions.now ?? (() => new Date());
  let cacheHit = false;
  let rebuilt = false;
  let builtAt: string | undefined;
  let reason: string | undefined;
  let semanticRecordCount = 0;
  let vectorIndex: Map<string, { signature: string; vector: SparseVector }> | undefined;

  try {
    if (fs.existsSync(filePath)) {
      const cached = loadSemanticCache(filePath);
      if (cached && cached.fingerprint === fingerprint) {
        cacheHit = true;
        builtAt = cached.builtAt || undefined;
        vectorIndex = new Map(
          cached.records.map((entry) => [
            entry.id,
            { signature: entry.signature, vector: vectorFromSerializable(entry.vector) },
          ]),
        );
      } else {
        reason = cached ? "fingerprint-mismatch" : "invalid-cache-file";
      }
    } else {
      reason = "cache-miss";
    }
  } catch {
    reason = "cache-read-error";
  }

  if (!vectorIndex) {
    const built = buildSemanticCacheIndex(snapshot);
    semanticRecordCount = built.recordCount;
    vectorIndex = built.byId;
    rebuilt = true;
    builtAt = now().toISOString();
    try {
      writeSemanticCache(filePath, {
        version: 1,
        fingerprint,
        builtAt,
        vectorDim: VECTOR_DIM,
        records: [...vectorIndex.entries()].map(([id, entry]) => ({
          id,
          signature: entry.signature,
          vector: vectorToSerializable(entry.vector),
        })),
      });
      if (!reason) {
        reason = "rebuilt";
      }
    } catch {
      if (!reason) {
        reason = "cache-write-error";
      }
    }
  } else {
    semanticRecordCount = vectorIndex.size;
  }

  const resolveSemanticVector: SemanticVectorResolver = (record) => {
    const entry = vectorIndex?.get(record.id);
    const signature = recordSemanticSignature(record);
    if (entry && entry.signature === signature) {
      return entry.vector;
    }
    const vector = buildRecordSemanticVector(record);
    if (vectorIndex) {
      vectorIndex.set(record.id, { signature, vector });
    }
    return vector;
  };

  return searchPersonalMemorySnapshotInternal(snapshot, request, {
    resolveSemanticVector,
    cacheMeta: {
      enabled: true,
      backend: "sparse-cache",
      filePath,
      cacheHit,
      rebuilt,
      reason,
      fingerprint,
      builtAt,
      semanticRecordCount,
    },
  });
}

export function searchPersonalMemorySnapshotCached(
  snapshot: PersonalMemoryStoreSnapshot,
  request: PersonalMemorySearchRequest,
  cacheOptions: PersonalMemorySearchCacheOptions = {},
): PersonalMemorySearchResult {
  const mode = request.mode ?? "hybrid";
  if (mode === "keyword") {
    return searchPersonalMemorySnapshotSparseCached(snapshot, request, cacheOptions);
  }
  const backend = cacheOptions.backend ?? "sparse-cache";
  if (backend !== "sqlite-vec") {
    return searchPersonalMemorySnapshotSparseCached(snapshot, request, cacheOptions);
  }

  const filePath = cacheOptions.filePath;
  const fingerprint = cacheOptions.fingerprint;
  const sqliteDbPath =
    cacheOptions.sqliteVec?.dbPath ??
    (filePath
      ? filePath.replace(/\.semantic-index-cache\.json$/, ".semantic-index.sqlite")
      : undefined);
  if (!sqliteDbPath || !fingerprint) {
    return searchPersonalMemorySnapshotSparseCached(snapshot, request, {
      ...cacheOptions,
      backend: "sparse-cache",
    });
  }

  try {
    const semanticScores = sqliteVecSemanticScores({
      snapshot,
      query: request.query,
      limit: Math.max(1, request.limit ?? 10),
      dbPath: sqliteDbPath,
      extensionPath: cacheOptions.sqliteVec?.extensionPath,
    });
    return searchPersonalMemorySnapshotInternal(snapshot, request, {
      resolveSemanticScore: (record) => semanticScores.byId.get(record.id),
      cacheMeta: {
        enabled: true,
        backend: "sqlite-vec",
        filePath: semanticScores.dbPath,
        cacheHit: true,
        rebuilt: false,
        reason: "sqlite-vec",
        fingerprint,
        semanticRecordCount: semanticScores.recordCount,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fallback = searchPersonalMemorySnapshotSparseCached(snapshot, request, {
      ...cacheOptions,
      backend: "sparse-cache",
    });
    return {
      ...fallback,
      cache: fallback.cache
        ? {
            ...fallback.cache,
            reason: `sqlite-vec-fallback:${message}`,
          }
        : {
            enabled: false,
            backend: "sparse-cache",
            reason: `sqlite-vec-fallback:${message}`,
          },
    };
  }
}
