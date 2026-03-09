import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillSnapshot, loadWorkspaceSkillEntries } from "./skills.js";
import { resolveSkillToolsRootDir } from "./skills/tools-dir.js";

describe("skill runtime path integration", () => {
  it("treats download-installed binaries inside the skill tools dir as eligible", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-runtime-"));
    const stateDir = path.join(workspaceDir, ".state");
    try {
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "browser-use"),
        name: "browser-use",
        description: "Browser automation",
        metadata:
          '{"openclaw":{"requires":{"bins":["browser-use-test-bin"]},"install":[{"id":"runtime","kind":"download","url":"https://example.com/browser-use.tar.gz","targetDir":"runtime"}]}}',
      });

      await withEnvAsync(
        {
          HOME: workspaceDir,
          OPENCLAW_STATE_DIR: stateDir,
          PATH: "",
        },
        async () => {
          const entry = loadWorkspaceSkillEntries(workspaceDir).find(
            (candidate) => candidate.skill.name === "browser-use",
          );
          expect(entry).toBeDefined();

          const runtimeDir = path.join(resolveSkillToolsRootDir(entry), "runtime");
          await fs.mkdir(runtimeDir, { recursive: true });
          const binName =
            process.platform === "win32" ? "browser-use-test-bin.cmd" : "browser-use-test-bin";
          const binPath = path.join(runtimeDir, binName);
          await fs.writeFile(
            binPath,
            process.platform === "win32" ? "@echo off\r\necho ok\r\n" : "#!/bin/sh\necho ok\n",
            "utf-8",
          );
          if (process.platform !== "win32") {
            await fs.chmod(binPath, 0o755);
          }

          const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
            managedSkillsDir: path.join(workspaceDir, ".managed"),
            bundledSkillsDir: path.join(workspaceDir, ".bundled"),
          });

          expect(snapshot.skills.map((skill) => skill.name)).toContain("browser-use");
          expect(snapshot.runtimePathPrepend).toContain(runtimeDir);
        },
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
