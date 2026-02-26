import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBackedPersonalMemoryStore } from "./store.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function write(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeDefaultPersonalContext(baseDir: string) {
  write(
    path.join(baseDir, "00-identity.md"),
    "# 00 Identity\n\n- 最后更新日期： 2026-02-25\n\n## 简介\n\n- 角色：开发者\n",
  );
  write(
    path.join(baseDir, "01-current-focus.md"),
    "# 01 Current Focus\n\n- 最后更新日期： 2026-02-25\n\n## 当前重点\n\n1. 先做最小骨架\n",
  );
  write(
    path.join(baseDir, "02-projects.md"),
    "# 02 Projects\n\n- 最后更新日期： 2026-02-25\n\n## 项目\n\n- OpenClaw\n",
  );
  write(
    path.join(baseDir, "03-working-rules.md"),
    "# 03 Working Rules\n\n- 最后更新日期： 2026-02-25\n\n## 规则\n\n- 先审计后改代码\n",
  );
  write(
    path.join(baseDir, "04-decision-log.md"),
    `# 04 Decision Log

- 最后更新日期： 2026-02-25

## 决策记录

### [2026-02-25] 建立记忆系统文档与工具链

- 背景：需要先沉淀记忆管理规范
- 决策：先做模板和 CLI 工具，再做 runtime 记忆层
- 原因：先稳定格式和边界
`,
  );
}

function bumpMtime(filePath: string) {
  const stat = fs.statSync(filePath);
  const next = new Date(stat.mtimeMs + 2000);
  fs.utimesSync(filePath, next, next);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("FileBackedPersonalMemoryStore", () => {
  it("initializes from personal-context and exposes snapshot/status", async () => {
    const root = makeTempDir("openclaw-personal-memory-store-");
    const baseDir = path.join(root, "personal-context");
    writeDefaultPersonalContext(baseDir);

    const store = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
    const result = await store.init();
    const snapshot = store.snapshot();
    const status = store.status();

    expect(result.changed).toBe(true);
    expect(snapshot.semantic).toHaveLength(5);
    expect(snapshot.episodic).toHaveLength(1);
    expect(snapshot.working).toHaveLength(0);
    expect(status.initialized).toBe(true);
    expect(status.fileCount).toBe(5);
    expect(status.refreshCount).toBe(1);
    expect(status.lastFingerprint).toBeTruthy();
    expect(status.lastError).toBeUndefined();
  });

  it("returns changed=false when no files changed", async () => {
    const root = makeTempDir("openclaw-personal-memory-store-");
    const baseDir = path.join(root, "personal-context");
    writeDefaultPersonalContext(baseDir);

    const store = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
    await store.init();
    const result = await store.refresh();
    const status = store.status();

    expect(result.changed).toBe(false);
    expect(status.refreshCount).toBe(1);
    expect(status.lastError).toBeUndefined();
  });

  it("refreshes snapshot when decision-log changes", async () => {
    const root = makeTempDir("openclaw-personal-memory-store-");
    const baseDir = path.join(root, "personal-context");
    writeDefaultPersonalContext(baseDir);
    const decisionLogPath = path.join(baseDir, "04-decision-log.md");

    const store = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
    await store.init();

    fs.appendFileSync(
      decisionLogPath,
      `
### [2026-02-26] 新增决策

- 背景：B
- 决策：B
- 原因：B
`,
      "utf8",
    );
    bumpMtime(decisionLogPath);

    const result = await store.refresh();
    const snapshot = store.snapshot();
    const status = store.status();

    expect(result.changed).toBe(true);
    expect(snapshot.episodic).toHaveLength(2);
    expect(snapshot.episodic[0]?.title).toBe("新增决策");
    expect(status.refreshCount).toBe(2);
  });

  it("preserves runtime working/episodic overlays across refresh", async () => {
    const root = makeTempDir("openclaw-personal-memory-store-");
    const baseDir = path.join(root, "personal-context");
    writeDefaultPersonalContext(baseDir);

    const store = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
    await store.init();

    store.upsertWorkingRecord({
      id: "working:focus:temp",
      title: "当前会话工作记忆",
      content: "用户要求先实现三层骨架",
      createdAt: "2026-02-25T00:00:00.000Z",
      updatedAt: "2026-02-25T00:00:00.000Z",
      tags: ["working"],
    });
    store.appendEpisodicRecord({
      id: "episodic:runtime:1",
      title: "运行时对话结论",
      content: "先做 personal-context parser",
      createdAt: "2026-02-25T00:01:00.000Z",
      updatedAt: "2026-02-25T00:01:00.000Z",
      tags: ["runtime"],
    });

    const before = store.snapshot();
    expect(before.working).toHaveLength(1);
    expect(before.episodic.length).toBeGreaterThanOrEqual(2);

    const refresh = await store.refresh();
    const after = store.snapshot();
    expect(refresh.changed).toBe(false);
    expect(after.working[0]?.id).toBe("working:focus:temp");
    expect(after.episodic.some((r) => r.id === "episodic:runtime:1")).toBe(true);
    expect(store.status().workingCount).toBe(1);
    expect(store.status().episodicCount).toBe(after.episodic.length);

    expect(store.removeWorkingRecord("working:focus:temp")).toBe(true);
    expect(store.removeWorkingRecord("working:missing")).toBe(false);
    expect(store.snapshot().working).toHaveLength(0);
  });

  it("captures load errors in status and rethrows", async () => {
    const root = makeTempDir("openclaw-personal-memory-store-");
    const baseDir = path.join(root, "personal-context");
    fs.mkdirSync(baseDir, { recursive: true });

    const store = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
    await expect(store.init()).rejects.toThrow();
    expect(store.status().lastError).toBeTruthy();
    expect(store.status().initialized).toBe(false);
  });

  it("returns defensive copies for snapshot and seed", async () => {
    const root = makeTempDir("openclaw-personal-memory-store-");
    const baseDir = path.join(root, "personal-context");
    writeDefaultPersonalContext(baseDir);

    const store = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
    await store.init();

    const snap1 = store.snapshot();
    const seed1 = store.seed();
    const originalSemanticTitle = snap1.semantic[0]?.title ?? "";
    const originalDocTitle = seed1.docs[0]?.title ?? "";
    const originalDecisionTitle = seed1.decisions[0]?.title ?? "";

    if (snap1.semantic[0]) {
      snap1.semantic[0].title = "mutated";
      snap1.semantic[0].tags = ["mutated"];
      snap1.semantic[0].metadata = { mutated: true };
    }
    if (seed1.docs[0]) {
      seed1.docs[0].title = "mutated-doc";
      if (seed1.docs[0].sections[0]) {
        seed1.docs[0].sections[0].heading = "mutated-section";
      }
    }
    if (seed1.decisions[0]) {
      seed1.decisions[0].title = "mutated-decision";
    }

    const snap2 = store.snapshot();
    const seed2 = store.seed();

    expect(snap2.semantic[0]?.title).toBe(originalSemanticTitle);
    expect(snap2.semantic[0]?.title).not.toBe("mutated");
    expect(seed2.docs[0]?.title).toBe(originalDocTitle);
    expect(seed2.docs[0]?.title).not.toBe("mutated-doc");
    expect(seed2.docs[0]?.sections[0]?.heading).not.toBe("mutated-section");
    expect(seed2.decisions[0]?.title).toBe(originalDecisionTitle);
    expect(seed2.decisions[0]?.title).not.toBe("mutated-decision");
  });

  it("persists runtime overlays and restores them in a new store instance", async () => {
    const root = makeTempDir("openclaw-personal-memory-store-");
    const baseDir = path.join(root, "personal-context");
    writeDefaultPersonalContext(baseDir);

    const storeA = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
    await storeA.init();
    storeA.upsertWorkingRecord({
      id: "working:restore",
      title: "恢复 working 记录",
      content: "用于测试 runtime overlay 持久化",
      createdAt: "2026-02-25T00:00:00.000Z",
      updatedAt: "2026-02-25T00:00:01.000Z",
      tags: ["runtime"],
    });
    storeA.appendEpisodicRecord({
      id: "episodic:restore",
      title: "恢复 episodic 记录",
      content: "用于测试 runtime overlay 持久化",
      createdAt: "2026-02-25T00:00:02.000Z",
      updatedAt: "2026-02-25T00:00:03.000Z",
      tags: ["runtime"],
    });

    const runtimeFile = path.join(baseDir, ".runtime-memory.json");
    expect(fs.existsSync(runtimeFile)).toBe(true);

    const storeB = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
    await storeB.init();
    const snap = storeB.snapshot();
    expect(snap.working.some((r) => r.id === "working:restore")).toBe(true);
    expect(snap.episodic.some((r) => r.id === "episodic:restore")).toBe(true);
    expect(storeB.status().runtimeStateLoadedAt).toBeTruthy();
    expect(storeB.status().runtimeStateLastError).toBeUndefined();
  });

  it("tolerates invalid runtime overlay file without breaking init", async () => {
    const root = makeTempDir("openclaw-personal-memory-store-");
    const baseDir = path.join(root, "personal-context");
    writeDefaultPersonalContext(baseDir);
    fs.writeFileSync(path.join(baseDir, ".runtime-memory.json"), "{bad-json", "utf8");

    const store = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
    await expect(store.init()).resolves.toBeTruthy();
    expect(store.status().runtimeStateLastError).toBeTruthy();
    expect(store.snapshot().working).toHaveLength(0);
  });

  it("hydrates existing runtime overlays before first mutation without init", () => {
    const root = makeTempDir("openclaw-personal-memory-store-");
    const baseDir = path.join(root, "personal-context");
    writeDefaultPersonalContext(baseDir);
    write(
      path.join(baseDir, ".runtime-memory.json"),
      JSON.stringify(
        {
          version: 1,
          working: [],
          episodic: [
            {
              id: "episodic:stale",
              title: "stale",
              content: "stale",
              layer: "episodic",
              source: "runtime",
              createdAt: "2025-12-01T00:00:00.000Z",
              updatedAt: "2025-12-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );

    const store = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
    store.appendEpisodicRecord({
      id: "episodic:new",
      title: "new",
      content: "new",
      createdAt: "2026-02-26T00:00:00.000Z",
      updatedAt: "2026-02-26T00:00:00.000Z",
    });

    const runtime = JSON.parse(
      fs.readFileSync(path.join(baseDir, ".runtime-memory.json"), "utf8"),
    ) as { episodic: Array<{ id: string }> };
    expect(runtime.episodic.some((r) => r.id === "episodic:stale")).toBe(true);
    expect(runtime.episodic.some((r) => r.id === "episodic:new")).toBe(true);
  });
});
