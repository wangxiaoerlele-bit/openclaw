import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPersonalMemoryRuntimeSettings,
  PERSONAL_MEMORY_SETTINGS_FILE,
  resolvePersonalMemoryChannelPolicy,
  resolvePersonalMemoryRuntimeGcPolicy,
  resolvePersonalMemoryRuntimeSyncPolicy,
} from "./settings.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeSettings(dir: string, value: unknown) {
  fs.writeFileSync(
    path.join(dir, PERSONAL_MEMORY_SETTINGS_FILE),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("personal-memory runtime settings", () => {
  it("uses safe defaults (web-gui/feishu enabled, others disabled by default policy)", () => {
    const dir = makeTempDir("openclaw-personal-memory-settings-");
    const settings = loadPersonalMemoryRuntimeSettings(dir);
    expect(settings.source).toBe("defaults");
    expect(settings.enabled).toBe(true);

    const web = resolvePersonalMemoryChannelPolicy({ personalContextDir: dir, channel: "web-gui" });
    expect(web.enabled).toBe(true);
    expect(web.preHookEnabled).toBe(true);
    expect(web.postHookEnabled).toBe(true);

    const telegram = resolvePersonalMemoryChannelPolicy({
      personalContextDir: dir,
      channel: "telegram",
    });
    expect(telegram.enabled).toBe(false);
    expect(telegram.preHookEnabled).toBe(false);
    expect(telegram.postHookEnabled).toBe(false);
  });

  it("loads per-channel overrides for budget/search and enable flags", () => {
    const dir = makeTempDir("openclaw-personal-memory-settings-");
    writeSettings(dir, {
      version: 1,
      enabled: true,
      channels: {
        telegram: {
          enabled: true,
          preHook: true,
          postHook: false,
          budget: { maxRecords: 4, maxChars: 1800 },
          search: {
            enabled: true,
            mode: "keyword",
            limit: 1,
            layers: ["episodic"],
            cache: false,
            rerank: false,
            rerankTopK: 7,
            rerankStrategy: "mmr-lite",
            backend: "sqlite-vec",
            sqliteVecFile: "archive/personal-memory.sqlite",
            sqliteVecExtensionPath: "/opt/sqlite-vec.dylib",
          },
        },
      },
    });

    const telegram = resolvePersonalMemoryChannelPolicy({
      personalContextDir: dir,
      channel: "telegram",
    });
    expect(telegram.enabled).toBe(true);
    expect(telegram.preHookEnabled).toBe(true);
    expect(telegram.postHookEnabled).toBe(false);
    expect(telegram.budget?.maxRecords).toBe(4);
    expect(telegram.budget?.maxChars).toBe(1800);
    expect(telegram.search.enabled).toBe(true);
    expect(telegram.search.mode).toBe("keyword");
    expect(telegram.search.limit).toBe(1);
    expect(telegram.search.layers).toEqual(["episodic"]);
    expect(telegram.search.cacheEnabled).toBe(false);
    expect(telegram.search.rerankEnabled).toBe(false);
    expect(telegram.search.rerankTopK).toBe(7);
    expect(telegram.search.rerankStrategy).toBe("mmr-lite");
    expect(telegram.search.backend).toBe("sqlite-vec");
    expect(telegram.search.sqliteVecFile).toBe("archive/personal-memory.sqlite");
    expect(telegram.search.sqliteVecExtensionPath).toBe("/opt/sqlite-vec.dylib");
  });

  it("defaults rerank on for enabled channels", () => {
    const dir = makeTempDir("openclaw-personal-memory-settings-");
    const web = resolvePersonalMemoryChannelPolicy({ personalContextDir: dir, channel: "web-gui" });
    expect(web.search.rerankEnabled).toBe(true);
    expect(web.search.rerankTopK).toBeTruthy();
    expect(web.search.rerankStrategy).toBe("hybrid-v2");
  });

  it("loads runtimeGc overrides and resolves normalized auto-gc policy", () => {
    const dir = makeTempDir("openclaw-personal-memory-settings-");
    writeSettings(dir, {
      version: 1,
      runtimeGc: {
        enabled: true,
        runOnPostHook: true,
        minIntervalMinutes: 5,
        archiveRuntimeEpisodicDays: 14,
        retainEpisodicByChannelDays: {
          feishu: 7,
          telegram: 3,
          unknown_channel: 99,
        },
        protectEpisodicTags: ["pinned", "important", "pinned"],
        protectEpisodicSources: ["manual", "imported", "manual"],
        keepPending: 50,
        retainAppliedDays: 10,
        retainDismissedDays: 3,
        retainWorkingHours: 6,
        retainEpisodicDays: 7,
        maxEpisodic: 40,
      },
    });

    const settings = loadPersonalMemoryRuntimeSettings(dir);
    expect(settings.runtimeGc.enabled).toBe(true);
    expect(settings.runtimeGc.minIntervalMinutes).toBe(5);
    expect(settings.runtimeGc.archiveRuntimeEpisodicDays).toBe(14);
    expect(settings.runtimeGc.retainEpisodicByChannelDays).toEqual({
      feishu: 7,
      telegram: 3,
    });
    expect(settings.runtimeGc.protectEpisodicTags).toEqual(["pinned", "important"]);
    expect(settings.runtimeGc.protectEpisodicSources).toEqual(["manual", "imported"]);

    const policy = resolvePersonalMemoryRuntimeGcPolicy(dir);
    expect(policy).toEqual({
      enabled: true,
      runOnPostHook: true,
      minIntervalMinutes: 5,
      archiveRuntimeEpisodicDays: 14,
      retainEpisodicByChannelDays: { feishu: 7, telegram: 3 },
      protectEpisodicTags: ["pinned", "important"],
      protectEpisodicSources: ["manual", "imported"],
      keepPending: 50,
      retainAppliedDays: 10,
      retainDismissedDays: 3,
      retainWorkingHours: 6,
      retainEpisodicDays: 7,
      maxEpisodic: 40,
    });
  });

  it("loads runtimeSync overrides and resolves normalized auto-sync policy", () => {
    const dir = makeTempDir("openclaw-personal-memory-settings-");
    writeSettings(dir, {
      version: 1,
      runtimeSync: {
        enabled: true,
        runOnPreHook: true,
        runOnPostHook: true,
        minIntervalMinutes: 7,
        preMinIntervalMinutes: 2,
        postMinIntervalMinutes: 9,
        mode: "sync",
        preMode: "import",
        postMode: "sync",
        conflictStrategy: "incoming",
        channels: ["feishu", "web-gui", "unknown_channel" as never],
        auditConflicts: true,
        auditFile: "archive/custom-auto-sync.audit.jsonl",
        bundleFile: "archive/custom-runtime-sync.json",
        includeWorking: true,
        maxEpisodic: 55,
      },
    });

    const settings = loadPersonalMemoryRuntimeSettings(dir);
    expect(settings.runtimeSync.enabled).toBe(true);
    expect(settings.runtimeSync.bundleFile).toBe("archive/custom-runtime-sync.json");

    const policy = resolvePersonalMemoryRuntimeSyncPolicy(dir);
    expect(policy).toEqual({
      enabled: true,
      runOnPreHook: true,
      runOnPostHook: true,
      minIntervalMinutes: 7,
      preMinIntervalMinutes: 2,
      postMinIntervalMinutes: 9,
      mode: "sync",
      preMode: "import",
      postMode: "sync",
      conflictStrategy: "incoming",
      channels: ["feishu", "web-gui"],
      auditConflicts: true,
      auditFile: "archive/custom-auto-sync.audit.jsonl",
      bundleFile: "archive/custom-runtime-sync.json",
      includeWorking: true,
      maxEpisodic: 55,
    });
  });

  it("supports runtimeSync import mode and defaults conflictStrategy to latest", () => {
    const dir = makeTempDir("openclaw-personal-memory-settings-");
    writeSettings(dir, {
      version: 1,
      runtimeSync: {
        enabled: true,
        mode: "import",
      },
    });

    const policy = resolvePersonalMemoryRuntimeSyncPolicy(dir);
    expect(policy.mode).toBe("import");
    expect(policy.conflictStrategy).toBe("latest");
    expect(policy.auditConflicts).toBe(false);
    expect(policy.auditFile).toContain("runtime-memory-auto-sync.audit.jsonl");
  });
});
