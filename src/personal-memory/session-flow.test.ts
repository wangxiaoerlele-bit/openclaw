import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPersonalMemoryPreSessionContext,
  suggestPostSessionMemoryWrite,
} from "./session-flow.js";
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

function seedPersonalContext(baseDir: string) {
  write(
    path.join(baseDir, "00-identity.md"),
    "# 00 Identity\n\n- 最后更新日期： 2026-02-25\n\n## 简介\n\n- 角色：开发者\n",
  );
  write(
    path.join(baseDir, "01-current-focus.md"),
    "# 01 Current Focus\n\n- 最后更新日期： 2026-02-25\n\n## 当前重点\n\n1. 记忆系统\n",
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("personal-memory session flow", () => {
  it("builds pre-session context with selected snippets", async () => {
    const root = makeTempDir("openclaw-personal-memory-flow-");
    const baseDir = path.join(root, "personal-context");
    seedPersonalContext(baseDir);

    const store = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
    await store.init();
    store.upsertWorkingRecord({
      id: "working:turn",
      title: "本轮目标",
      content: "先做 pre-session 再做 post-session",
      createdAt: "2026-02-25T00:00:00.000Z",
    });

    const ctx = await buildPersonalMemoryPreSessionContext(store, {
      channel: "feishu",
      taskKind: "daily-qa",
    });

    expect(ctx.selection.selected.length).toBeGreaterThan(0);
    expect(ctx.snippets.some((s) => s.includes("本轮目标"))).toBe(true);
    expect(ctx.selection.profile).toContain("daily-qa");
    expect(ctx.search).toBeUndefined();
  });

  it("attaches keyword search hits when queryText is provided", async () => {
    const root = makeTempDir("openclaw-personal-memory-flow-");
    const baseDir = path.join(root, "personal-context");
    seedPersonalContext(baseDir);

    const store = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
    await store.init();

    const ctx = await buildPersonalMemoryPreSessionContext(store, {
      channel: "web-gui",
      taskKind: "project-discussion",
      queryText: "OpenClaw",
    });

    expect(ctx.search).toBeTruthy();
    expect(ctx.search?.totalHits).toBeGreaterThan(0);
  });

  it("generates decision-log suggestion with L1/L2 based on confirmation", () => {
    const l1 = suggestPostSessionMemoryWrite({
      channel: "web-gui",
      taskKind: "decision-review",
      summary: "确认采用 personal-memory 三层骨架方案",
      userConfirmed: false,
      decisionTitle: "确认 personal-memory 骨架方案",
      background: "需要先稳定结构再做 hooks 和索引",
      decision: "先做 personal-memory store 与 parser",
      reason: "降低返工并尽快建立最小可用闭环",
    });
    expect(l1.level).toBe("L1");
    expect(l1.target).toBe("decision-log");
    expect(l1.content).toContain("### [");

    const l2 = suggestPostSessionMemoryWrite({
      channel: "web-gui",
      taskKind: "decision-review",
      summary: "用户确认写入",
      userConfirmed: true,
      decisionTitle: "确认写入 decision-log",
      decision: "写入",
      reason: "用户明确确认",
    });
    expect(l2.level).toBe("L2");
  });

  it("returns L0 for non-decision daily QA summaries", () => {
    const result = suggestPostSessionMemoryWrite({
      channel: "feishu",
      taskKind: "daily-qa",
      summary: "回答了一个临时天气问题",
    });
    expect(result.level).toBe("L0");
    expect(result.target).toBeUndefined();
  });
});
