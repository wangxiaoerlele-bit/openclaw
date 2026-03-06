import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createMemoryManagerOrThrow } from "./test-manager.js";

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async () => [1, 0, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    },
  }),
}));

describe("memory tier migration + ranking", () => {
  let workspaceDir = "";
  let manager: Awaited<ReturnType<typeof createMemoryManagerOrThrow>> | null = null;

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

  it("moves untiered memory files into hot tier on sync", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-tier-migrate-"));
    const indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "memory", "legacy.md"), "legacy note");

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    manager = await createMemoryManagerOrThrow(cfg);
    await manager.sync?.({ force: true });

    await expect(fs.stat(path.join(workspaceDir, "memory", "legacy.md"))).rejects.toThrow();
    const migrated = path.join(workspaceDir, "memory", "hot", "legacy.md");
    await expect(fs.stat(migrated)).resolves.toBeDefined();
  });

  it("prefers hot over cold when scores are otherwise equal", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-tier-rank-"));
    const indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory", "hot"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "memory", "cold"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "memory", "hot", "hot.md"), "shared token");
    await fs.writeFile(path.join(workspaceDir, "memory", "cold", "cold.md"), "shared token");

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { hybrid: { enabled: false }, minScore: 0 },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    manager = await createMemoryManagerOrThrow(cfg);
    await manager.sync?.({ force: true });
    const results = await manager.search("shared token", { maxResults: 2, minScore: 0 });
    expect(results).toHaveLength(2);
    expect(results[0]?.path).toMatch(/^memory\/hot\//);
    expect(results[1]?.path).toMatch(/^memory\/cold\//);
  });
});
