import path from "node:path";
import { getMinimalServicePathPartsFromEnv } from "../../daemon/service-env.js";
import { isWindowsDrivePath } from "../../infra/archive-path.js";
import { findPathKey, mergePathPrepend, normalizePathPrepend } from "../../infra/path-prepend.js";
import { isWithinDir } from "../../infra/path-safety.js";
import { hasBinaryInPath } from "../../shared/config-eval.js";
import { resolveUserPath } from "../../utils.js";
import { resolveSkillToolsRootDir } from "./tools-dir.js";
import type { SkillEntry, SkillInstallSpec, SkillSnapshot } from "./types.js";

function needsInstallerFallbackPath(entry: SkillEntry): boolean {
  return (entry.metadata?.install ?? []).some((spec) => spec.kind !== "download");
}

function resolveDownloadTargetDir(entry: SkillEntry, spec: SkillInstallSpec): string | undefined {
  const safeRoot = resolveSkillToolsRootDir(entry);
  const raw = spec.targetDir?.trim();
  if (!raw) {
    return safeRoot;
  }

  const resolved =
    raw.startsWith("~") || path.isAbsolute(raw) || isWindowsDrivePath(raw)
      ? resolveUserPath(raw)
      : path.resolve(safeRoot, raw);
  return isWithinDir(safeRoot, resolved) ? resolved : undefined;
}

function resolveEntryDownloadPathDirs(entry: SkillEntry): string[] {
  const dirs: string[] = [];
  const toolsRoot = resolveSkillToolsRootDir(entry);
  let addedToolsRoot = false;

  for (const spec of entry.metadata?.install ?? []) {
    if (spec.kind !== "download") {
      continue;
    }
    if (!addedToolsRoot) {
      dirs.push(toolsRoot);
      dirs.push(path.join(toolsRoot, "bin"));
      addedToolsRoot = true;
    }
    const targetDir = resolveDownloadTargetDir(entry, spec);
    if (!targetDir) {
      continue;
    }
    dirs.push(targetDir);
    dirs.push(path.join(targetDir, "bin"));
  }

  return dirs;
}

export function resolveSkillRuntimePathPrepend(
  entries: SkillEntry[],
  opts?: {
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
  },
): string[] {
  const dirs: string[] = [];
  const platform = opts?.platform ?? process.platform;
  const env = opts?.env ?? process.env;

  // Match the same fallback bin search OpenClaw uses for minimal service PATHs so
  // skills installed via package managers remain usable even when the host app was
  // launched without the user's interactive shell PATH.
  if (entries.some((entry) => needsInstallerFallbackPath(entry))) {
    dirs.push(...getMinimalServicePathPartsFromEnv({ env, platform }));
  }

  for (const entry of entries) {
    dirs.push(...resolveEntryDownloadPathDirs(entry));
  }

  return normalizePathPrepend(dirs);
}

export function resolveSkillRuntimePathPrependForRun(params: {
  entries?: SkillEntry[];
  snapshot?: SkillSnapshot;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): string[] {
  const dirs = [...(params.snapshot?.runtimePathPrepend ?? [])];
  if (params.entries && params.entries.length > 0) {
    dirs.push(...resolveSkillRuntimePathPrepend(params.entries, params));
  }
  return normalizePathPrepend(dirs);
}

export function hasSkillRuntimeBinary(params: {
  entry: SkillEntry;
  bin: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): boolean {
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const pathKey = findPathKey(env as Record<string, string>);
  const pathEnv = env[pathKey] ?? "";
  const pathExt = platform === "win32" ? (env.PATHEXT ?? process.env.PATHEXT ?? "") : "";
  const mergedPath =
    mergePathPrepend(
      pathEnv,
      resolveSkillRuntimePathPrepend([params.entry], {
        env,
        platform,
      }),
    ) ?? pathEnv;
  return hasBinaryInPath(params.bin, mergedPath, pathExt);
}
