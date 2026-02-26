#!/usr/bin/env node
import path from "node:path";
import {
  loadPersonalMemoryRuntimeSettings,
  resolvePersonalMemoryRuntimeGcPolicy,
  resolvePersonalMemoryRuntimeSyncPolicy,
} from "../src/personal-memory/settings.ts";
import { FileBackedPersonalMemoryStore } from "../src/personal-memory/store.ts";
import { resolvePersonalContextDir } from "./personal-context-memory.ts";

type Args = {
  dir: string;
  json: boolean;
};

function usage(): string {
  return [
    "Usage: node --import tsx scripts/personal-memory-status.ts [options]",
    "",
    "Options:",
    "  --dir <dir>        Memory directory (default: personal-context)",
    "  --json             Output JSON",
    "  -h, --help         Show help",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: "personal-context", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--dir":
        if (!next) {
          throw new Error("--dir requires a value");
        }
        args.dir = next;
        i += 1;
        break;
      case "--json":
        args.json = true;
        break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    console.error(usage());
    process.exit(2);
    return;
  }

  let baseDir: string;
  try {
    baseDir = resolvePersonalContextDir(process.cwd(), args.dir);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const store = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
  try {
    const initResult = await store.init();
    const status = store.status();
    const snapshot = store.snapshot();
    const settings = loadPersonalMemoryRuntimeSettings(baseDir);
    const runtimeGc = resolvePersonalMemoryRuntimeGcPolicy(baseDir);
    const runtimeSync = resolvePersonalMemoryRuntimeSyncPolicy(baseDir);
    const payload = {
      personalContextDir: path.resolve(baseDir),
      init: initResult,
      status,
      settings: {
        source: settings.source,
        filePath: settings.filePath,
        enabled: settings.enabled,
        runtimeGc,
        runtimeSync,
        channels: Object.fromEntries(
          Object.entries(settings.channels).map(([channel, cfg]) => [
            channel,
            {
              enabled: cfg?.enabled ?? true,
              preHook: cfg?.preHook ?? true,
              postHook: cfg?.postHook ?? true,
              searchEnabled: cfg?.search?.enabled ?? true,
              searchMode: cfg?.search?.mode ?? "hybrid",
            },
          ]),
        ),
      },
      counts: {
        working: snapshot.working.length,
        episodic: snapshot.episodic.length,
        semantic: snapshot.semantic.length,
      },
      topRecords: {
        working: snapshot.working.slice(0, 3).map((r) => ({ id: r.id, title: r.title })),
        episodic: snapshot.episodic.slice(0, 3).map((r) => ({ id: r.id, title: r.title })),
        semantic: snapshot.semantic.slice(0, 3).map((r) => ({ id: r.id, title: r.title })),
      },
    };

    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Personal memory status: ${payload.personalContextDir}`);
    console.log(
      `Layers -> working=${payload.counts.working}, episodic=${payload.counts.episodic}, semantic=${payload.counts.semantic}`,
    );
    console.log(
      `Store -> initialized=${status.initialized}, refreshCount=${status.refreshCount}, fileCount=${status.fileCount}`,
    );
    console.log(
      `Settings -> source=${payload.settings.source} enabled=${String(payload.settings.enabled)}`,
    );
    console.log(
      `Runtime GC -> enabled=${String(runtimeGc.enabled)} postHook=${String(runtimeGc.runOnPostHook)} interval=${runtimeGc.minIntervalMinutes}m`,
    );
    if (
      runtimeGc.retainEpisodicByChannelDays &&
      Object.keys(runtimeGc.retainEpisodicByChannelDays).length > 0
    ) {
      const byChannel = Object.entries(runtimeGc.retainEpisodicByChannelDays)
        .map(([channel, days]) => `${channel}:${days}d`)
        .join(", ");
      console.log(`Runtime GC per-channel episodic retention -> ${byChannel}`);
    }
    if (runtimeGc.protectEpisodicTags.length > 0) {
      console.log(`Runtime GC protect tags -> ${runtimeGc.protectEpisodicTags.join(", ")}`);
    }
    if (runtimeGc.protectEpisodicSources.length > 0) {
      console.log(`Runtime GC protect sources -> ${runtimeGc.protectEpisodicSources.join(", ")}`);
    }
    console.log(
      `Runtime Sync -> enabled=${String(runtimeSync.enabled)} preHook=${String(runtimeSync.runOnPreHook)} postHook=${String(runtimeSync.runOnPostHook)} interval=${runtimeSync.minIntervalMinutes}m mode=${runtimeSync.mode} strategy=${runtimeSync.conflictStrategy}`,
    );
    if (runtimeSync.preMinIntervalMinutes || runtimeSync.postMinIntervalMinutes) {
      console.log(
        `Runtime Sync phase intervals -> pre=${runtimeSync.preMinIntervalMinutes ?? runtimeSync.minIntervalMinutes}m, post=${runtimeSync.postMinIntervalMinutes ?? runtimeSync.minIntervalMinutes}m`,
      );
    }
    if (runtimeSync.preMode || runtimeSync.postMode) {
      console.log(
        `Runtime Sync phase modes -> pre=${runtimeSync.preMode ?? runtimeSync.mode}, post=${runtimeSync.postMode ?? runtimeSync.mode}`,
      );
    }
    if (runtimeSync.channels && runtimeSync.channels.length > 0) {
      console.log(`Runtime Sync channels -> ${runtimeSync.channels.join(", ")}`);
    }
    if (runtimeSync.auditConflicts) {
      console.log(`Runtime Sync audit -> ${runtimeSync.auditFile}`);
    }
    if (status.lastLoadedAt) {
      console.log(`Last loaded: ${status.lastLoadedAt}`);
    }
    if (status.lastFingerprint) {
      console.log(`Fingerprint: ${status.lastFingerprint}`);
    }
    if (payload.topRecords.episodic[0]) {
      console.log(`Latest episodic: ${payload.topRecords.episodic[0].title}`);
    }
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
