import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryIndexManager } from "./index.js";
import { getRequiredMemoryIndexManager } from "./test-manager-helpers.js";
import "./test-runtime-mocks.js";

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "gemini",
    provider: null,
    providerUnavailableReason: 'No API key found for provider "google".',
  }),
}));

function createFtsOnlyCfg(workspaceDir: string, indexPath: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "gemini",
          model: "gemini-embedding-001",
          store: { path: indexPath, vector: { enabled: false } },
          cache: { enabled: false },
          query: { minScore: 0, hybrid: { enabled: true } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

describe("MemoryIndexManager FTS-only indexing", () => {
  let workspaceDir = "";
  let manager: MemoryIndexManager | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
    }
  });

  it("indexes and returns hits when embeddings are unavailable", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fts-only-"));
    const indexPath = path.join(workspaceDir, "index.sqlite");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "2026-03-04.md"), "lighthouseproof token");

    manager = await getRequiredMemoryIndexManager({
      cfg: createFtsOnlyCfg(workspaceDir, indexPath),
      agentId: "main",
    });

    await manager.sync({ force: true });

    const status = manager.status();
    expect(status.provider).toBe("none");
    expect(status.custom?.searchMode).toBe("fts-only");
    expect(status.files).toBeGreaterThan(0);
    expect(status.chunks).toBeGreaterThan(0);

    const results = await manager.search("lighthouseproof", { maxResults: 3, minScore: 0 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.snippet).toContain("lighthouseproof");
  });
});
