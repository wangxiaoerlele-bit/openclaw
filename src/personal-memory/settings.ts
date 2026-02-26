import fs from "node:fs";
import path from "node:path";
import type {
  PersonalMemoryChannel,
  PersonalMemoryLayer,
  PersonalMemorySearchRequest,
  PersonalMemorySelectionBudget,
} from "./types.js";

export const PERSONAL_MEMORY_SETTINGS_FILE = ".personal-memory.settings.json";

type ChannelOverride = {
  enabled?: boolean;
  preHook?: boolean;
  postHook?: boolean;
  budget?: PersonalMemorySelectionBudget;
  search?: {
    enabled?: boolean;
    mode?: PersonalMemorySearchRequest["mode"];
    limit?: number;
    layers?: PersonalMemoryLayer[];
    cache?: boolean;
    rerank?: boolean;
    rerankTopK?: number;
    rerankStrategy?: "mmr-lite" | "hybrid-v2";
    backend?: "sparse-cache" | "sqlite-vec";
    sqliteVecFile?: string;
    sqliteVecExtensionPath?: string;
  };
};

type RuntimeGcOverride = {
  enabled?: boolean;
  runOnPostHook?: boolean;
  minIntervalMinutes?: number;
  archiveRuntimeEpisodicDays?: number;
  retainEpisodicByChannelDays?: Partial<Record<PersonalMemoryChannel, number>>;
  protectEpisodicTags?: string[];
  protectEpisodicSources?: string[];
  keepPending?: number;
  retainAppliedDays?: number;
  retainDismissedDays?: number;
  retainWorkingHours?: number;
  retainEpisodicDays?: number;
  maxEpisodic?: number;
};

type RuntimeSyncOverride = {
  enabled?: boolean;
  runOnPreHook?: boolean;
  runOnPostHook?: boolean;
  minIntervalMinutes?: number;
  preMinIntervalMinutes?: number;
  postMinIntervalMinutes?: number;
  mode?: "export" | "import" | "sync";
  preMode?: "export" | "import" | "sync";
  postMode?: "export" | "import" | "sync";
  conflictStrategy?: "latest" | "current" | "incoming";
  channels?: PersonalMemoryChannel[];
  auditConflicts?: boolean;
  auditFile?: string;
  bundleFile?: string;
  includeWorking?: boolean;
  maxEpisodic?: number;
};

type RawSettings = {
  version?: number;
  enabled?: boolean;
  channels?: Record<string, ChannelOverride>;
  runtimeGc?: RuntimeGcOverride;
  runtimeSync?: RuntimeSyncOverride;
};

export type PersonalMemoryChannelPolicy = {
  enabled: boolean;
  preHookEnabled: boolean;
  postHookEnabled: boolean;
  budget?: PersonalMemorySelectionBudget;
  search: {
    enabled: boolean;
    mode: NonNullable<PersonalMemorySearchRequest["mode"]>;
    limit: number;
    layers?: PersonalMemoryLayer[];
    cacheEnabled: boolean;
    rerankEnabled: boolean;
    rerankTopK?: number;
    rerankStrategy: "mmr-lite" | "hybrid-v2";
    backend: "sparse-cache" | "sqlite-vec";
    sqliteVecFile?: string;
    sqliteVecExtensionPath?: string;
  };
};

export type PersonalMemoryRuntimeSettings = {
  version: 1;
  source: "defaults" | "file";
  filePath: string;
  enabled: boolean;
  channels: Partial<Record<PersonalMemoryChannel, ChannelOverride>>;
  runtimeGc: RuntimeGcOverride;
  runtimeSync: RuntimeSyncOverride;
};

export type PersonalMemoryRuntimeGcPolicy = {
  enabled: boolean;
  runOnPostHook: boolean;
  minIntervalMinutes: number;
  archiveRuntimeEpisodicDays?: number;
  retainEpisodicByChannelDays?: Partial<Record<PersonalMemoryChannel, number>>;
  protectEpisodicTags: string[];
  protectEpisodicSources: string[];
  keepPending: number;
  retainAppliedDays: number;
  retainDismissedDays: number;
  retainWorkingHours: number;
  retainEpisodicDays: number;
  maxEpisodic: number;
};

export type PersonalMemoryRuntimeSyncPolicy = {
  enabled: boolean;
  runOnPreHook: boolean;
  runOnPostHook: boolean;
  minIntervalMinutes: number;
  preMinIntervalMinutes?: number;
  postMinIntervalMinutes?: number;
  mode: "export" | "import" | "sync";
  preMode?: "export" | "import" | "sync";
  postMode?: "export" | "import" | "sync";
  conflictStrategy: "latest" | "current" | "incoming";
  channels?: PersonalMemoryChannel[];
  auditConflicts: boolean;
  auditFile: string;
  bundleFile: string;
  includeWorking: boolean;
  maxEpisodic: number;
};

type CacheEntry = {
  mtimeMs: number;
  size: number;
  settings: PersonalMemoryRuntimeSettings;
};

const settingsCache = new Map<string, CacheEntry>();

const KNOWN_CHANNELS: ReadonlySet<PersonalMemoryChannel> = new Set([
  "web-gui",
  "feishu",
  "telegram",
  "discord",
  "slack",
  "signal",
  "imessage",
  "whatsapp",
  "matrix",
  "msteams",
  "mattermost",
  "googlechat",
  "nextcloud-talk",
  "irc",
  "zalo",
  "zalouser",
  "bluebubbles",
  "tlon",
  "twitch",
  "unknown",
]);

function isMode(value: unknown): value is NonNullable<PersonalMemorySearchRequest["mode"]> {
  return value === "keyword" || value === "hybrid" || value === "semantic";
}

function isLayer(value: unknown): value is PersonalMemoryLayer {
  return value === "working" || value === "episodic" || value === "semantic";
}

function normalizeBudget(value: unknown): PersonalMemorySelectionBudget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const src = value as Record<string, unknown>;
  const out: PersonalMemorySelectionBudget = {};
  for (const key of [
    "maxRecords",
    "maxChars",
    "maxWorking",
    "maxEpisodic",
    "maxSemantic",
  ] as const) {
    const n = src[key];
    if (typeof n === "number" && Number.isFinite(n) && n > 0) {
      out[key] = Math.floor(n);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeChannelOverride(value: unknown): ChannelOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const src = value as Record<string, unknown>;
  const out: ChannelOverride = {};
  if (typeof src.enabled === "boolean") {
    out.enabled = src.enabled;
  }
  if (typeof src.preHook === "boolean") {
    out.preHook = src.preHook;
  }
  if (typeof src.postHook === "boolean") {
    out.postHook = src.postHook;
  }
  const budget = normalizeBudget(src.budget);
  if (budget) {
    out.budget = budget;
  }
  if (src.search && typeof src.search === "object" && !Array.isArray(src.search)) {
    const searchSrc = src.search as Record<string, unknown>;
    const search: NonNullable<ChannelOverride["search"]> = {};
    if (typeof searchSrc.enabled === "boolean") {
      search.enabled = searchSrc.enabled;
    }
    if (isMode(searchSrc.mode)) {
      search.mode = searchSrc.mode;
    }
    if (
      typeof searchSrc.limit === "number" &&
      Number.isFinite(searchSrc.limit) &&
      searchSrc.limit > 0
    ) {
      search.limit = Math.floor(searchSrc.limit);
    }
    if (typeof searchSrc.cache === "boolean") {
      search.cache = searchSrc.cache;
    }
    if (typeof searchSrc.rerank === "boolean") {
      search.rerank = searchSrc.rerank;
    }
    if (
      typeof searchSrc.rerankTopK === "number" &&
      Number.isFinite(searchSrc.rerankTopK) &&
      searchSrc.rerankTopK > 0
    ) {
      search.rerankTopK = Math.floor(searchSrc.rerankTopK);
    }
    if (searchSrc.rerankStrategy === "mmr-lite" || searchSrc.rerankStrategy === "hybrid-v2") {
      search.rerankStrategy = searchSrc.rerankStrategy;
    }
    if (searchSrc.backend === "sparse-cache" || searchSrc.backend === "sqlite-vec") {
      search.backend = searchSrc.backend;
    }
    if (typeof searchSrc.sqliteVecFile === "string" && searchSrc.sqliteVecFile.trim()) {
      search.sqliteVecFile = searchSrc.sqliteVecFile.trim();
    }
    if (
      typeof searchSrc.sqliteVecExtensionPath === "string" &&
      searchSrc.sqliteVecExtensionPath.trim()
    ) {
      search.sqliteVecExtensionPath = searchSrc.sqliteVecExtensionPath.trim();
    }
    if (Array.isArray(searchSrc.layers)) {
      const layers = searchSrc.layers.filter(isLayer);
      if (layers.length > 0) {
        search.layers = [...new Set(layers)];
      }
    }
    if (Object.keys(search).length > 0) {
      out.search = search;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function defaultChannels(): Partial<Record<PersonalMemoryChannel, ChannelOverride>> {
  return {
    "web-gui": {
      enabled: true,
      preHook: true,
      postHook: true,
      search: {
        enabled: true,
        mode: "hybrid",
        limit: 3,
        cache: true,
        rerank: true,
        rerankTopK: 12,
        rerankStrategy: "hybrid-v2",
      },
    },
    feishu: {
      enabled: true,
      preHook: true,
      postHook: true,
      search: {
        enabled: true,
        mode: "hybrid",
        limit: 2,
        cache: true,
        rerank: true,
        rerankTopK: 10,
        rerankStrategy: "hybrid-v2",
      },
    },
  };
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeRuntimeGcOverride(value: unknown): RuntimeGcOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const src = value as Record<string, unknown>;
  const out: RuntimeGcOverride = {};
  if (typeof src.enabled === "boolean") {
    out.enabled = src.enabled;
  }
  if (typeof src.runOnPostHook === "boolean") {
    out.runOnPostHook = src.runOnPostHook;
  }
  if (
    src.retainEpisodicByChannelDays &&
    typeof src.retainEpisodicByChannelDays === "object" &&
    !Array.isArray(src.retainEpisodicByChannelDays)
  ) {
    const map: Partial<Record<PersonalMemoryChannel, number>> = {};
    for (const [key, rawValue] of Object.entries(
      src.retainEpisodicByChannelDays as Record<string, unknown>,
    )) {
      if (!KNOWN_CHANNELS.has(key as PersonalMemoryChannel)) {
        continue;
      }
      const n = normalizePositiveInt(rawValue);
      if (n) {
        map[key as PersonalMemoryChannel] = n;
      }
    }
    if (Object.keys(map).length > 0) {
      out.retainEpisodicByChannelDays = map;
    }
  }
  if (Array.isArray(src.protectEpisodicTags)) {
    const tags = src.protectEpisodicTags
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    if (tags.length > 0) {
      out.protectEpisodicTags = [...new Set(tags)];
    }
  }
  if (Array.isArray(src.protectEpisodicSources)) {
    const sources = src.protectEpisodicSources
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    if (sources.length > 0) {
      out.protectEpisodicSources = [...new Set(sources)];
    }
  }
  for (const key of [
    "minIntervalMinutes",
    "archiveRuntimeEpisodicDays",
    "keepPending",
    "retainAppliedDays",
    "retainDismissedDays",
    "retainWorkingHours",
    "retainEpisodicDays",
    "maxEpisodic",
  ] as const) {
    const n = normalizePositiveInt(src[key]);
    if (n) {
      out[key] = n;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function defaultRuntimeGc(): RuntimeGcOverride {
  return {
    enabled: false,
    runOnPostHook: true,
    minIntervalMinutes: 30,
    archiveRuntimeEpisodicDays: 0,
    retainEpisodicByChannelDays: {},
    protectEpisodicTags: [],
    protectEpisodicSources: [],
    keepPending: 200,
    retainAppliedDays: 30,
    retainDismissedDays: 14,
    retainWorkingHours: 24,
    retainEpisodicDays: 30,
    maxEpisodic: 200,
  };
}

function normalizeRuntimeSyncOverride(value: unknown): RuntimeSyncOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const src = value as Record<string, unknown>;
  const out: RuntimeSyncOverride = {};
  if (typeof src.enabled === "boolean") {
    out.enabled = src.enabled;
  }
  if (typeof src.runOnPreHook === "boolean") {
    out.runOnPreHook = src.runOnPreHook;
  }
  if (typeof src.runOnPostHook === "boolean") {
    out.runOnPostHook = src.runOnPostHook;
  }
  if (typeof src.includeWorking === "boolean") {
    out.includeWorking = src.includeWorking;
  }
  if (typeof src.auditConflicts === "boolean") {
    out.auditConflicts = src.auditConflicts;
  }
  if (src.mode === "export" || src.mode === "import" || src.mode === "sync") {
    out.mode = src.mode;
  }
  if (src.preMode === "export" || src.preMode === "import" || src.preMode === "sync") {
    out.preMode = src.preMode;
  }
  if (src.postMode === "export" || src.postMode === "import" || src.postMode === "sync") {
    out.postMode = src.postMode;
  }
  if (
    src.conflictStrategy === "latest" ||
    src.conflictStrategy === "current" ||
    src.conflictStrategy === "incoming"
  ) {
    out.conflictStrategy = src.conflictStrategy;
  }
  if (Array.isArray(src.channels)) {
    const channels = src.channels.filter(
      (item): item is PersonalMemoryChannel =>
        typeof item === "string" && KNOWN_CHANNELS.has(item as PersonalMemoryChannel),
    );
    if (channels.length > 0) {
      out.channels = [...new Set(channels)];
    }
  }
  if (typeof src.bundleFile === "string" && src.bundleFile.trim()) {
    out.bundleFile = src.bundleFile.trim();
  }
  if (typeof src.auditFile === "string" && src.auditFile.trim()) {
    out.auditFile = src.auditFile.trim();
  }
  for (const key of [
    "minIntervalMinutes",
    "preMinIntervalMinutes",
    "postMinIntervalMinutes",
    "maxEpisodic",
  ] as const) {
    const n = normalizePositiveInt(src[key]);
    if (n) {
      out[key] = n;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function defaultRuntimeSync(): RuntimeSyncOverride {
  return {
    enabled: false,
    runOnPreHook: false,
    runOnPostHook: true,
    minIntervalMinutes: 30,
    preMinIntervalMinutes: undefined,
    postMinIntervalMinutes: undefined,
    mode: "export",
    preMode: undefined,
    postMode: undefined,
    conflictStrategy: "latest",
    channels: [],
    auditConflicts: false,
    auditFile: path.join("archive", "runtime-memory-auto-sync.audit.jsonl"),
    bundleFile: path.join("archive", "runtime-memory-share.json"),
    includeWorking: false,
    maxEpisodic: 200,
  };
}

function isDefaultEnabledChannel(channel: PersonalMemoryChannel): boolean {
  return channel === "web-gui" || channel === "feishu";
}

export function loadPersonalMemoryRuntimeSettings(
  personalContextDir: string,
): PersonalMemoryRuntimeSettings {
  const filePath = path.join(path.resolve(personalContextDir), PERSONAL_MEMORY_SETTINGS_FILE);
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : undefined;
  if (!stat) {
    return {
      version: 1,
      source: "defaults",
      filePath,
      enabled: true,
      channels: defaultChannels(),
      runtimeGc: defaultRuntimeGc(),
      runtimeSync: defaultRuntimeSync(),
    };
  }

  const cached = settingsCache.get(filePath);
  if (cached && cached.mtimeMs === Math.floor(stat.mtimeMs) && cached.size === stat.size) {
    return cached.settings;
  }

  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as RawSettings;
  const channels: Partial<Record<PersonalMemoryChannel, ChannelOverride>> = defaultChannels();
  if (raw.channels && typeof raw.channels === "object" && !Array.isArray(raw.channels)) {
    for (const [key, value] of Object.entries(raw.channels)) {
      if (!KNOWN_CHANNELS.has(key as PersonalMemoryChannel)) {
        continue;
      }
      const normalized = normalizeChannelOverride(value);
      if (!normalized) {
        continue;
      }
      channels[key as PersonalMemoryChannel] = {
        ...channels[key as PersonalMemoryChannel],
        ...normalized,
        search: {
          ...channels[key as PersonalMemoryChannel]?.search,
          ...normalized.search,
        },
      };
    }
  }
  const settings: PersonalMemoryRuntimeSettings = {
    version: 1,
    source: "file",
    filePath,
    enabled: raw.enabled !== false,
    channels,
    runtimeGc: {
      ...defaultRuntimeGc(),
      ...normalizeRuntimeGcOverride(raw.runtimeGc),
    },
    runtimeSync: {
      ...defaultRuntimeSync(),
      ...normalizeRuntimeSyncOverride(raw.runtimeSync),
    },
  };
  settingsCache.set(filePath, {
    mtimeMs: Math.floor(stat.mtimeMs),
    size: stat.size,
    settings,
  });
  return settings;
}

export function resolvePersonalMemoryRuntimeGcPolicy(
  personalContextDir: string,
): PersonalMemoryRuntimeGcPolicy {
  const settings = loadPersonalMemoryRuntimeSettings(personalContextDir);
  const gc = settings.runtimeGc;
  const minIntervalMinutes = Math.max(
    1,
    Math.min(24 * 60, normalizePositiveInt(gc.minIntervalMinutes) ?? 30),
  );
  const perChannel =
    gc.retainEpisodicByChannelDays && Object.keys(gc.retainEpisodicByChannelDays).length > 0
      ? { ...gc.retainEpisodicByChannelDays }
      : undefined;
  const protectTags = Array.isArray(gc.protectEpisodicTags)
    ? gc.protectEpisodicTags.filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      )
    : [];
  const protectSources = Array.isArray(gc.protectEpisodicSources)
    ? gc.protectEpisodicSources.filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      )
    : [];
  return {
    enabled: gc.enabled === true,
    runOnPostHook: gc.runOnPostHook !== false,
    minIntervalMinutes,
    archiveRuntimeEpisodicDays: normalizePositiveInt(gc.archiveRuntimeEpisodicDays),
    retainEpisodicByChannelDays: perChannel,
    protectEpisodicTags: [...new Set(protectTags)],
    protectEpisodicSources: [...new Set(protectSources)],
    keepPending: Math.max(1, normalizePositiveInt(gc.keepPending) ?? 200),
    retainAppliedDays: Math.max(1, normalizePositiveInt(gc.retainAppliedDays) ?? 30),
    retainDismissedDays: Math.max(1, normalizePositiveInt(gc.retainDismissedDays) ?? 14),
    retainWorkingHours: Math.max(1, normalizePositiveInt(gc.retainWorkingHours) ?? 24),
    retainEpisodicDays: Math.max(1, normalizePositiveInt(gc.retainEpisodicDays) ?? 30),
    maxEpisodic: Math.max(1, normalizePositiveInt(gc.maxEpisodic) ?? 200),
  };
}

export function resolvePersonalMemoryRuntimeSyncPolicy(
  personalContextDir: string,
): PersonalMemoryRuntimeSyncPolicy {
  const settings = loadPersonalMemoryRuntimeSettings(personalContextDir);
  const sync = settings.runtimeSync;
  return {
    enabled: sync.enabled === true,
    runOnPreHook: sync.runOnPreHook === true,
    runOnPostHook: sync.runOnPostHook !== false,
    minIntervalMinutes: Math.max(
      1,
      Math.min(24 * 60, normalizePositiveInt(sync.minIntervalMinutes) ?? 30),
    ),
    preMinIntervalMinutes: normalizePositiveInt(sync.preMinIntervalMinutes),
    postMinIntervalMinutes: normalizePositiveInt(sync.postMinIntervalMinutes),
    mode: sync.mode === "sync" ? "sync" : sync.mode === "import" ? "import" : "export",
    preMode:
      sync.preMode === "sync"
        ? "sync"
        : sync.preMode === "import"
          ? "import"
          : sync.preMode === "export"
            ? "export"
            : undefined,
    postMode:
      sync.postMode === "sync"
        ? "sync"
        : sync.postMode === "import"
          ? "import"
          : sync.postMode === "export"
            ? "export"
            : undefined,
    conflictStrategy:
      sync.conflictStrategy === "current"
        ? "current"
        : sync.conflictStrategy === "incoming"
          ? "incoming"
          : "latest",
    channels:
      Array.isArray(sync.channels) && sync.channels.length > 0
        ? [...new Set(sync.channels)]
        : undefined,
    auditConflicts: sync.auditConflicts === true,
    auditFile:
      sync.auditFile?.trim() || path.join("archive", "runtime-memory-auto-sync.audit.jsonl"),
    bundleFile: sync.bundleFile?.trim() || path.join("archive", "runtime-memory-share.json"),
    includeWorking: sync.includeWorking === true,
    maxEpisodic: Math.max(1, normalizePositiveInt(sync.maxEpisodic) ?? 200),
  };
}

export function resolvePersonalMemoryChannelPolicy(params: {
  personalContextDir: string;
  channel: PersonalMemoryChannel;
}): PersonalMemoryChannelPolicy {
  const settings = loadPersonalMemoryRuntimeSettings(params.personalContextDir);
  const channelCfg = settings.channels[params.channel] ?? {};
  const channelEnabled =
    settings.enabled &&
    (typeof channelCfg.enabled === "boolean"
      ? channelCfg.enabled
      : isDefaultEnabledChannel(params.channel));
  const searchMode = isMode(channelCfg.search?.mode) ? channelCfg.search.mode : "hybrid";
  const searchLimitRaw = channelCfg.search?.limit;
  const searchLimit =
    typeof searchLimitRaw === "number" && Number.isFinite(searchLimitRaw)
      ? Math.max(1, Math.min(10, Math.floor(searchLimitRaw)))
      : params.channel === "feishu"
        ? 2
        : 3;
  return {
    enabled: channelEnabled,
    preHookEnabled: channelEnabled && channelCfg.preHook !== false,
    postHookEnabled: channelEnabled && channelCfg.postHook !== false,
    budget: channelCfg.budget,
    search: {
      enabled: channelEnabled && channelCfg.search?.enabled !== false,
      mode: searchMode,
      limit: searchLimit,
      layers: channelCfg.search?.layers ? [...channelCfg.search.layers] : undefined,
      cacheEnabled: channelCfg.search?.cache !== false,
      rerankEnabled: channelCfg.search?.rerank !== false,
      rerankTopK: normalizePositiveInt(channelCfg.search?.rerankTopK),
      rerankStrategy: channelCfg.search?.rerankStrategy === "mmr-lite" ? "mmr-lite" : "hybrid-v2",
      backend: channelCfg.search?.backend === "sqlite-vec" ? "sqlite-vec" : "sparse-cache",
      sqliteVecFile: channelCfg.search?.sqliteVecFile,
      sqliteVecExtensionPath: channelCfg.search?.sqliteVecExtensionPath,
    },
  };
}
