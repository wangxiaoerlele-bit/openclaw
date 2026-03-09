import type { OpenClawConfig } from "../../config/config.js";
import { loadWorkspaceSkillEntries, type SkillEntry, type SkillSnapshot } from "../skills.js";
import { resolveSkillRuntimePathPrependForRun } from "../skills/runtime-paths.js";

export function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
}): {
  shouldLoadSkillEntries: boolean;
  skillEntries: SkillEntry[];
  runtimePathPrepend: string[];
} {
  const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
  const skillEntries = shouldLoadSkillEntries
    ? loadWorkspaceSkillEntries(params.workspaceDir, { config: params.config })
    : [];
  return {
    shouldLoadSkillEntries,
    skillEntries,
    runtimePathPrepend: resolveSkillRuntimePathPrependForRun({
      entries: skillEntries,
      snapshot: params.skillsSnapshot,
    }),
  };
}
