import fs from "node:fs";
import path from "node:path";
import { prunePersonalMemorySuggestionQueue } from "./suggestion-queue.js";
import type { PersonalMemoryChannel } from "./types.js";

export const PERSONAL_MEMORY_RUNTIME_STATE_FILE = ".runtime-memory.json";
const KNOWN_CHANNEL_TAGS = new Set<string>([
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

export type PersonalMemoryGcPolicy = {
  retainEpisodicByChannelDays?: Partial<Record<PersonalMemoryChannel, number>>;
  protectEpisodicTags?: string[];
  protectEpisodicSources?: string[];
  keepPending: number;
  retainAppliedDays: number;
  retainDismissedDays: number;
  retainWorkingHours: number;
  retainEpisodicDays: number;
  maxEpisodic: number;
};

type RuntimeMemoryState = {
  version?: number;
  working?: unknown[];
  episodic?: unknown[];
};

export type PersonalMemoryRuntimeGcResult = {
  filePath: string;
  exists: boolean;
  beforeWorking: number;
  afterWorking: number;
  beforeEpisodic: number;
  afterEpisodic: number;
};

export type PersonalMemoryGcResult = {
  personalContextDir: string;
  dryRun: boolean;
  runtime: PersonalMemoryRuntimeGcResult;
  suggestions: {
    filePath: string;
    before: number;
    after: number;
    removed: number;
  };
};

export function defaultPersonalMemoryGcPolicy(): PersonalMemoryGcPolicy {
  return {
    keepPending: 200,
    retainAppliedDays: 30,
    retainDismissedDays: 14,
    retainWorkingHours: 24,
    retainEpisodicDays: 30,
    maxEpisodic: 200,
  };
}

function parseIsoMs(text: unknown): number | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : undefined;
}

function inferRuntimeRecordChannel(
  value: Record<string, unknown>,
): PersonalMemoryChannel | undefined {
  const metadata =
    value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? (value.metadata as Record<string, unknown>)
      : undefined;
  if (typeof metadata?.channel === "string" && metadata.channel.trim()) {
    return metadata.channel.trim() as PersonalMemoryChannel;
  }
  const tags = Array.isArray(value.tags)
    ? value.tags.filter((item): item is string => typeof item === "string")
    : [];
  for (const tag of tags) {
    if (KNOWN_CHANNEL_TAGS.has(tag)) {
      return tag as PersonalMemoryChannel;
    }
  }
  return undefined;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function episodicRecordProtectionFlags(
  value: Record<string, unknown>,
  protectTags: ReadonlySet<string>,
  protectSources: ReadonlySet<string>,
) {
  const source =
    typeof value.source === "string" && value.source.trim() ? value.source.trim() : undefined;
  const tags = parseStringArray(value.tags);
  const hasProtectedSource = source ? protectSources.has(source) : false;
  const hasProtectedTag = tags.some((tag) => protectTags.has(tag));
  return { hasProtectedSource, hasProtectedTag };
}

function sortEpisodicForRetention(
  records: Array<Record<string, unknown>>,
  protectTags: ReadonlySet<string>,
  protectSources: ReadonlySet<string>,
) {
  return records.toSorted((a, b) => {
    const aFlags = episodicRecordProtectionFlags(a, protectTags, protectSources);
    const bFlags = episodicRecordProtectionFlags(b, protectTags, protectSources);
    const aPriority = Number(aFlags.hasProtectedSource) * 2 + Number(aFlags.hasProtectedTag);
    const bPriority = Number(bFlags.hasProtectedSource) * 2 + Number(bFlags.hasProtectedTag);
    if (bPriority !== aPriority) {
      return bPriority - aPriority;
    }
    const aTs = parseIsoMs(a.updatedAt) ?? parseIsoMs(a.createdAt) ?? 0;
    const bTs = parseIsoMs(b.updatedAt) ?? parseIsoMs(b.createdAt) ?? 0;
    if (bTs !== aTs) {
      return bTs - aTs;
    }
    const aId = typeof a.id === "string" ? a.id : "";
    const bId = typeof b.id === "string" ? b.id : "";
    return aId.localeCompare(bId);
  });
}

export function prunePersonalMemoryRuntimeState(params: {
  personalContextDir: string;
  retainWorkingHours?: number;
  retainEpisodicDays?: number;
  retainEpisodicByChannelDays?: Partial<Record<PersonalMemoryChannel, number>>;
  protectEpisodicTags?: string[];
  protectEpisodicSources?: string[];
  maxEpisodic?: number;
  dryRun?: boolean;
  now?: () => Date;
}): PersonalMemoryRuntimeGcResult {
  const filePath = path.join(
    path.resolve(params.personalContextDir),
    PERSONAL_MEMORY_RUNTIME_STATE_FILE,
  );
  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      exists: false,
      beforeWorking: 0,
      afterWorking: 0,
      beforeEpisodic: 0,
      afterEpisodic: 0,
    };
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as RuntimeMemoryState;
  const nowMs = (params.now ?? (() => new Date()))().getTime();
  const keepWorkingMs = Math.max(1, params.retainWorkingHours ?? 24) * 3600 * 1000;
  const keepEpisodicMs = Math.max(1, params.retainEpisodicDays ?? 30) * 24 * 3600 * 1000;
  const keepEpisodicByChannelMs = new Map<string, number>();
  if (params.retainEpisodicByChannelDays) {
    for (const [channel, days] of Object.entries(params.retainEpisodicByChannelDays)) {
      if (typeof days === "number" && Number.isFinite(days) && days > 0) {
        keepEpisodicByChannelMs.set(channel, Math.floor(days) * 24 * 3600 * 1000);
      }
    }
  }
  const protectEpisodicTags = new Set(
    (params.protectEpisodicTags ?? []).map((v) => v.trim()).filter(Boolean),
  );
  const protectEpisodicSources = new Set(
    (params.protectEpisodicSources ?? []).map((v) => v.trim()).filter(Boolean),
  );
  const maxEpisodic = Math.max(1, params.maxEpisodic ?? 200);
  const working = Array.isArray(raw.working) ? raw.working : [];
  const episodic = Array.isArray(raw.episodic) ? raw.episodic : [];
  const nextWorking = working.filter((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const value = item as Record<string, unknown>;
    const ts = parseIsoMs(value.updatedAt) ?? parseIsoMs(value.createdAt);
    return ts ? nowMs - ts <= keepWorkingMs : true;
  });
  const nextEpisodic = sortEpisodicForRetention(
    episodic.filter((item): item is Record<string, unknown> => !!item && typeof item === "object"),
    protectEpisodicTags,
    protectEpisodicSources,
  )
    .filter((value) => {
      const flags = episodicRecordProtectionFlags(
        value,
        protectEpisodicTags,
        protectEpisodicSources,
      );
      if (flags.hasProtectedSource || flags.hasProtectedTag) {
        return true;
      }
      const ts = parseIsoMs(value.updatedAt) ?? parseIsoMs(value.createdAt);
      const channel = inferRuntimeRecordChannel(value);
      const budgetMs = (channel && keepEpisodicByChannelMs.get(channel)) ?? keepEpisodicMs;
      return ts ? nowMs - ts <= budgetMs : true;
    })
    .slice(0, maxEpisodic);

  if (!params.dryRun) {
    const next = {
      version: raw.version === 1 ? 1 : 1,
      working: nextWorking,
      episodic: nextEpisodic,
    };
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, filePath);
  }
  return {
    filePath,
    exists: true,
    beforeWorking: working.length,
    afterWorking: nextWorking.length,
    beforeEpisodic: episodic.length,
    afterEpisodic: nextEpisodic.length,
  };
}

export function runPersonalMemoryGc(params: {
  personalContextDir: string;
  dryRun?: boolean;
  now?: () => Date;
  policy?: Partial<PersonalMemoryGcPolicy>;
}): PersonalMemoryGcResult {
  const defaults = defaultPersonalMemoryGcPolicy();
  const policy: PersonalMemoryGcPolicy = {
    ...defaults,
    ...params.policy,
  };
  const runtime = prunePersonalMemoryRuntimeState({
    personalContextDir: params.personalContextDir,
    retainWorkingHours: policy.retainWorkingHours,
    retainEpisodicDays: policy.retainEpisodicDays,
    retainEpisodicByChannelDays: policy.retainEpisodicByChannelDays,
    protectEpisodicTags: policy.protectEpisodicTags,
    protectEpisodicSources: policy.protectEpisodicSources,
    maxEpisodic: policy.maxEpisodic,
    dryRun: params.dryRun,
    now: params.now,
  });
  const suggestions = prunePersonalMemorySuggestionQueue({
    personalContextDir: params.personalContextDir,
    keepPending: policy.keepPending,
    retainAppliedDays: policy.retainAppliedDays,
    retainDismissedDays: policy.retainDismissedDays,
    dryRun: params.dryRun,
    now: params.now,
  });
  return {
    personalContextDir: path.resolve(params.personalContextDir),
    dryRun: params.dryRun === true,
    runtime,
    suggestions,
  };
}
