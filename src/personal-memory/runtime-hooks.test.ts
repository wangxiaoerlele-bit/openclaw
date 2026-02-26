import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMemoryAddDecisionCommandFromSuggestion,
  emitPersonalMemoryPostSuggestion,
  inferPersonalMemoryTaskKindFromText,
  inferPersonalMemoryUserConfirmedFromText,
  maybeBuildPersonalMemoryPromptForChat,
} from "./runtime-hooks.js";
import { PERSONAL_MEMORY_SETTINGS_FILE } from "./settings.js";
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
    "# 01 Current Focus\n\n- 最后更新日期： 2026-02-25\n\n## 当前重点\n\n1. 做记忆系统\n",
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
- 背景：先有规范再自动化
- 决策：先做 parser 和 store
- 原因：降低返工
`,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("personal-memory runtime hooks", () => {
  it("infers task kind from message text heuristics", () => {
    expect(inferPersonalMemoryTaskKindFromText("帮我做方案取舍复盘")).toBe("decision-review");
    expect(inferPersonalMemoryTaskKindFromText("梳理这个项目代码结构")).toBe("project-discussion");
    expect(inferPersonalMemoryTaskKindFromText("本周规划和优先级")).toBe("planning");
    expect(inferPersonalMemoryTaskKindFromText("今天广州天气")).toBe("daily-qa");
  });

  it("infers explicit confirmation intent from text heuristics", () => {
    expect(inferPersonalMemoryUserConfirmedFromText("我确认采用这个方案")).toBe(true);
    expect(inferPersonalMemoryUserConfirmedFromText("就按这个方案执行")).toBe(true);
    expect(inferPersonalMemoryUserConfirmedFromText("I confirm we go with this plan")).toBe(true);
    expect(inferPersonalMemoryUserConfirmedFromText("帮我梳理一下这个方案")).toBe(false);
    expect(inferPersonalMemoryUserConfirmedFromText("先给我一个建议，我还没决定")).toBe(false);
  });

  it("builds chat prompt with personal-memory envelope when directory exists", async () => {
    const root = makeTempDir("openclaw-personal-memory-hooks-");
    const baseDir = path.join(root, "personal-context");
    seedPersonalContext(baseDir);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    const res = await maybeBuildPersonalMemoryPromptForChat({
      runId: "run-1",
      sessionKey: "main",
      messageText: "帮我梳理开发者身份与 OpenClaw 项目的代码结构",
      bodyForAgent: "原始用户消息",
      personalContextDir: baseDir,
      channel: "web-gui",
      logger,
    });

    expect(res.pre).toBeTruthy();
    expect(res.bodyForAgent).toContain("[Personal Memory Context]");
    expect(res.pre?.search?.totalHits).toBeGreaterThan(0);
    expect(res.bodyForAgent).toContain("searchHits=");
    if (res.bodyForAgent.includes("searchHits=0")) {
      expect(res.bodyForAgent).not.toContain("[Personal Memory Search Hits]");
    } else {
      expect(res.bodyForAgent).toContain("[Personal Memory Search Hits]");
    }
    expect(res.bodyForAgent).toContain("[Current User Message]");
    expect(res.bodyForAgent).toContain("原始用户消息");
    expect(logger.debug).toHaveBeenCalled();
  });

  it("runs auto-sync sync on pre hook when runtimeSync pre-hook is enabled", async () => {
    const root = makeTempDir("openclaw-personal-memory-hooks-");
    const baseDir = path.join(root, "personal-context");
    seedPersonalContext(baseDir);
    write(
      path.join(baseDir, PERSONAL_MEMORY_SETTINGS_FILE),
      JSON.stringify(
        {
          version: 1,
          runtimeSync: {
            enabled: true,
            runOnPreHook: true,
            runOnPostHook: false,
            minIntervalMinutes: 1,
            mode: "sync",
            bundleFile: "archive/pre-runtime-sync.json",
            includeWorking: false,
            maxEpisodic: 20,
          },
        },
        null,
        2,
      ),
    );
    write(
      path.join(baseDir, "archive", "pre-runtime-sync.json"),
      JSON.stringify(
        {
          version: 1,
          exportedAt: "2026-02-26T00:00:00.000Z",
          source: { cwd: "/tmp", personalContextDir: "/tmp/personal-context" },
          runtime: {
            version: 1,
            working: [],
            episodic: [
              {
                id: "episodic:remote:pre-1",
                layer: "episodic",
                title: "Remote pre-sync episodic",
                content: "pre-hook sync should pull this before selection",
                source: "runtime",
                tags: ["runtime", "episodic"],
                createdAt: "2026-02-24T00:00:00.000Z",
                updatedAt: "2026-02-24T00:00:00.000Z",
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    const res = await maybeBuildPersonalMemoryPromptForChat({
      runId: "run-pre-sync",
      sessionKey: "session-pre-sync",
      messageText: "帮我回顾最近 runtime 记录",
      bodyForAgent: "原始用户消息",
      personalContextDir: baseDir,
      channel: "feishu",
      logger,
    });

    expect(res.pre).toBeTruthy();
    const runtime = JSON.parse(
      fs.readFileSync(path.join(baseDir, ".runtime-memory.json"), "utf8"),
    ) as {
      episodic: Array<{ id: string }>;
    };
    expect(runtime.episodic.some((r) => r.id === "episodic:remote:pre-1")).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("mode=sync"));
  });

  it("runs auto-sync import on pre hook when runtimeSync mode is import", async () => {
    const root = makeTempDir("openclaw-personal-memory-hooks-");
    const baseDir = path.join(root, "personal-context");
    seedPersonalContext(baseDir);
    write(
      path.join(baseDir, PERSONAL_MEMORY_SETTINGS_FILE),
      JSON.stringify(
        {
          version: 1,
          runtimeSync: {
            enabled: true,
            runOnPreHook: true,
            runOnPostHook: false,
            minIntervalMinutes: 1,
            mode: "import",
            conflictStrategy: "incoming",
            bundleFile: "archive/pre-runtime-import.json",
            includeWorking: false,
            maxEpisodic: 20,
          },
        },
        null,
        2,
      ),
    );
    write(
      path.join(baseDir, "archive", "pre-runtime-import.json"),
      JSON.stringify(
        {
          version: 1,
          exportedAt: "2026-02-26T00:00:00.000Z",
          source: { cwd: "/tmp", personalContextDir: "/tmp/personal-context" },
          runtime: {
            version: 1,
            working: [],
            episodic: [
              {
                id: "episodic:remote:import-1",
                layer: "episodic",
                title: "Remote import episodic",
                content: "pre-hook import should pull this before selection",
                source: "runtime",
                tags: ["runtime", "episodic"],
                createdAt: "2026-02-24T00:00:00.000Z",
                updatedAt: "2026-02-24T00:00:00.000Z",
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    const bundleBefore = fs.readFileSync(
      path.join(baseDir, "archive", "pre-runtime-import.json"),
      "utf8",
    );
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    const res = await maybeBuildPersonalMemoryPromptForChat({
      runId: "run-pre-import",
      sessionKey: "session-pre-import",
      messageText: "回顾远端 runtime 记忆",
      bodyForAgent: "原始用户消息",
      personalContextDir: baseDir,
      channel: "feishu",
      logger,
    });

    expect(res.pre).toBeTruthy();
    const runtime = JSON.parse(
      fs.readFileSync(path.join(baseDir, ".runtime-memory.json"), "utf8"),
    ) as {
      episodic: Array<{ id: string }>;
    };
    expect(runtime.episodic.some((r) => r.id === "episodic:remote:import-1")).toBe(true);
    expect(fs.readFileSync(path.join(baseDir, "archive", "pre-runtime-import.json"), "utf8")).toBe(
      bundleBefore,
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("phase=pre mode=import strategy=incoming"),
    );
  });

  it("supports runtimeSync preMode/postMode overrides and channel allowlist", async () => {
    const root = makeTempDir("openclaw-personal-memory-hooks-");
    const baseDir = path.join(root, "personal-context");
    seedPersonalContext(baseDir);
    write(
      path.join(baseDir, PERSONAL_MEMORY_SETTINGS_FILE),
      JSON.stringify(
        {
          version: 1,
          runtimeSync: {
            enabled: true,
            runOnPreHook: true,
            runOnPostHook: true,
            minIntervalMinutes: 1,
            mode: "export",
            preMode: "import",
            postMode: "sync",
            channels: ["feishu"],
            bundleFile: "archive/phase-runtime-sync.json",
            includeWorking: false,
            maxEpisodic: 20,
          },
        },
        null,
        2,
      ),
    );
    write(
      path.join(baseDir, "archive", "phase-runtime-sync.json"),
      JSON.stringify(
        {
          version: 1,
          exportedAt: "2026-02-26T00:00:00.000Z",
          source: { cwd: "/tmp", personalContextDir: "/tmp/personal-context" },
          runtime: {
            version: 1,
            working: [],
            episodic: [
              {
                id: "episodic:remote:phase-1",
                layer: "episodic",
                title: "phase remote",
                content: "phase import before hook",
                source: "runtime",
                tags: ["runtime", "episodic"],
                createdAt: "2026-02-24T00:00:00.000Z",
                updatedAt: "2026-02-24T00:00:00.000Z",
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-26T12:00:00.000Z"));

    await maybeBuildPersonalMemoryPromptForChat({
      runId: "run-pre-allow",
      sessionKey: "session-pre-allow",
      messageText: "回顾远端 runtime 记忆",
      bodyForAgent: "原始用户消息",
      personalContextDir: baseDir,
      channel: "web-gui",
      logger,
    });
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("mode=import"));

    await maybeBuildPersonalMemoryPromptForChat({
      runId: "run-pre-feishu",
      sessionKey: "session-pre-feishu",
      messageText: "回顾远端 runtime 记忆",
      bodyForAgent: "原始用户消息",
      personalContextDir: baseDir,
      channel: "feishu",
      logger,
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("phase=pre mode=import"));
    vi.setSystemTime(new Date("2026-02-26T12:02:00.000Z"));

    emitPersonalMemoryPostSuggestion({
      runId: "run-post-feishu",
      sessionKey: "session-post-feishu",
      personalContextDir: baseDir,
      logger,
      input: {
        channel: "feishu",
        taskKind: "project-discussion",
        summary: "phase override post should use sync",
      },
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("phase=post mode=sync"));
    vi.useRealTimers();
  });

  it("does not throttle post auto-sync behind pre auto-sync in the same minute", async () => {
    const root = makeTempDir("openclaw-personal-memory-hooks-");
    const baseDir = path.join(root, "personal-context");
    seedPersonalContext(baseDir);
    write(
      path.join(baseDir, PERSONAL_MEMORY_SETTINGS_FILE),
      JSON.stringify(
        {
          version: 1,
          runtimeSync: {
            enabled: true,
            runOnPreHook: true,
            runOnPostHook: true,
            minIntervalMinutes: 30,
            preMode: "import",
            postMode: "export",
            channels: ["feishu"],
            bundleFile: "archive/same-minute-sync.json",
          },
        },
        null,
        2,
      ),
    );
    write(
      path.join(baseDir, "archive", "same-minute-sync.json"),
      JSON.stringify(
        {
          version: 1,
          exportedAt: "2026-02-26T00:00:00.000Z",
          source: { cwd: "/tmp", personalContextDir: "/tmp/personal-context" },
          runtime: { version: 1, working: [], episodic: [] },
        },
        null,
        2,
      ),
    );
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-26T12:00:00.000Z"));

    await maybeBuildPersonalMemoryPromptForChat({
      runId: "run-same-minute-pre",
      sessionKey: "session-same-minute",
      messageText: "同步前读取记忆",
      bodyForAgent: "原始用户消息",
      personalContextDir: baseDir,
      channel: "feishu",
      logger,
    });
    emitPersonalMemoryPostSuggestion({
      runId: "run-same-minute-post",
      sessionKey: "session-same-minute",
      personalContextDir: baseDir,
      logger,
      input: {
        channel: "feishu",
        taskKind: "project-discussion",
        summary: "同一分钟内也应执行 post auto-sync",
      },
    });

    const infoLines = logger.info.mock.calls.map((call) => String(call[0]));
    expect(infoLines.some((line) => line.includes("phase=pre mode=import"))).toBe(true);
    expect(infoLines.some((line) => line.includes("phase=post mode=export"))).toBe(true);
    vi.useRealTimers();
  });

  it("writes auto-sync conflict audit file when enabled", () => {
    const root = makeTempDir("openclaw-personal-memory-hooks-");
    const baseDir = path.join(root, "personal-context");
    seedPersonalContext(baseDir);
    write(
      path.join(baseDir, PERSONAL_MEMORY_SETTINGS_FILE),
      JSON.stringify(
        {
          version: 1,
          runtimeSync: {
            enabled: true,
            runOnPreHook: false,
            runOnPostHook: true,
            minIntervalMinutes: 1,
            mode: "sync",
            conflictStrategy: "current",
            auditConflicts: true,
            auditFile: "archive/auto-sync-conflicts.jsonl",
            bundleFile: "archive/auto-sync-bundle.json",
            includeWorking: false,
          },
        },
        null,
        2,
      ),
    );
    write(
      path.join(baseDir, ".runtime-memory.json"),
      JSON.stringify(
        {
          version: 1,
          working: [],
          episodic: [
            {
              id: "episodic:dup",
              layer: "episodic",
              title: "local newer",
              content: "local",
              source: "runtime",
              createdAt: "2026-02-26T00:00:00.000Z",
              updatedAt: "2026-02-26T00:05:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );
    write(
      path.join(baseDir, "archive", "auto-sync-bundle.json"),
      JSON.stringify(
        {
          version: 1,
          exportedAt: "2026-02-26T00:10:00.000Z",
          source: { cwd: "/tmp", personalContextDir: "/tmp/personal-context" },
          runtime: {
            version: 1,
            working: [],
            episodic: [
              {
                id: "episodic:dup",
                layer: "episodic",
                title: "incoming older",
                content: "incoming",
                source: "runtime",
                createdAt: "2026-02-26T00:00:00.000Z",
                updatedAt: "2026-02-26T00:01:00.000Z",
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    emitPersonalMemoryPostSuggestion({
      runId: "run-auto-sync-audit",
      sessionKey: "session-auto-sync-audit",
      personalContextDir: baseDir,
      logger,
      input: {
        channel: "feishu",
        taskKind: "project-discussion",
        summary: "触发 auto-sync 冲突审计",
      },
    });

    const auditPath = path.join(baseDir, "archive", "auto-sync-conflicts.jsonl");
    expect(fs.existsSync(auditPath)).toBe(true);
    const auditText = fs.readFileSync(auditPath, "utf8");
    expect(auditText).toContain('"type":"runtime-auto-sync-conflict"');
    expect(auditText).toContain('"mode":"sync"');
    expect(auditText).toContain('"winner":"current"');
  });

  it("emits post-session suggestion and builds L2 commit command for decision-log", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const suggestion = emitPersonalMemoryPostSuggestion({
      runId: "run-2",
      sessionKey: "main",
      logger,
      input: {
        channel: "web-gui",
        taskKind: "decision-review",
        summary: "确认采用 personal-memory 三层骨架方案",
        userConfirmed: true,
        decisionTitle: "确认 personal-memory 三层骨架方案",
        background: "需要减少返工并建立可演进结构",
        decision: "先完成 parser/store/policy，再接 hooks",
        reason: "先稳定数据结构和边界",
        next: "接入 chat.send pre-session",
        links: "src/personal-memory",
      },
    });

    expect(suggestion.level).toBe("L2");
    const cmd = buildMemoryAddDecisionCommandFromSuggestion(suggestion);
    expect(cmd).toContain("pnpm memory:add-decision");
    expect(cmd).toContain("--title");
    expect(logger.info).toHaveBeenCalled();
  });

  it("persists runtime working/episodic memory through pre/post hook flow", async () => {
    const root = makeTempDir("openclaw-personal-memory-hooks-");
    const baseDir = path.join(root, "personal-context");
    seedPersonalContext(baseDir);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    await maybeBuildPersonalMemoryPromptForChat({
      runId: "run-3",
      sessionKey: "session-a",
      messageText: "帮我梳理 OpenClaw 项目代码",
      bodyForAgent: "原始用户消息",
      personalContextDir: baseDir,
      channel: "web-gui",
      logger,
    });

    const runtimeFile = path.join(baseDir, ".runtime-memory.json");
    expect(fs.existsSync(runtimeFile)).toBe(true);

    emitPersonalMemoryPostSuggestion({
      runId: "run-3",
      sessionKey: "session-a",
      personalContextDir: baseDir,
      logger,
      input: {
        channel: "web-gui",
        taskKind: "project-discussion",
        summary: "完成 OpenClaw 项目结构梳理并给出模块边界建议",
      },
    });

    const store = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
    await store.init();
    const snapshot = store.snapshot();
    expect(snapshot.working.some((r) => r.id === "working:session:session-a")).toBe(false);
    expect(snapshot.episodic.some((r) => r.id === "episodic:runtime:session-a:run-3")).toBe(true);
  });

  it("respects channel settings and skips pre/post hooks when disabled", async () => {
    const root = makeTempDir("openclaw-personal-memory-hooks-");
    const baseDir = path.join(root, "personal-context");
    seedPersonalContext(baseDir);
    write(
      path.join(baseDir, PERSONAL_MEMORY_SETTINGS_FILE),
      JSON.stringify(
        {
          version: 1,
          channels: {
            feishu: { enabled: false },
          },
        },
        null,
        2,
      ),
    );
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    const pre = await maybeBuildPersonalMemoryPromptForChat({
      runId: "run-skip",
      sessionKey: "session-skip",
      messageText: "帮我梳理 OpenClaw 项目代码",
      bodyForAgent: "原始用户消息",
      personalContextDir: baseDir,
      channel: "feishu",
      logger,
    });
    expect(pre.pre).toBeUndefined();
    expect(pre.bodyForAgent).toBe("原始用户消息");

    const post = emitPersonalMemoryPostSuggestion({
      runId: "run-skip",
      sessionKey: "session-skip",
      personalContextDir: baseDir,
      logger,
      input: {
        channel: "feishu",
        taskKind: "project-discussion",
        summary: "这条不会被写入 runtime episodic",
      },
    });
    expect(post.level).toBe("L0");
    expect(post.reason).toContain("skipped post-session suggestion");
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("personal-memory post:"));
  });

  it("runs auto-gc on post hook when runtimeGc is enabled", () => {
    const root = makeTempDir("openclaw-personal-memory-hooks-");
    const baseDir = path.join(root, "personal-context");
    seedPersonalContext(baseDir);
    write(
      path.join(baseDir, PERSONAL_MEMORY_SETTINGS_FILE),
      JSON.stringify(
        {
          version: 1,
          runtimeGc: {
            enabled: true,
            runOnPostHook: true,
            minIntervalMinutes: 1,
            archiveRuntimeEpisodicDays: 1,
            retainWorkingHours: 1,
            retainEpisodicDays: 1,
            retainDismissedDays: 1,
            retainAppliedDays: 1,
            keepPending: 5,
            maxEpisodic: 10,
          },
        },
        null,
        2,
      ),
    );
    write(
      path.join(baseDir, ".runtime-memory.json"),
      JSON.stringify(
        {
          version: 1,
          working: [
            {
              id: "working:stale",
              title: "stale",
              content: "stale",
              layer: "working",
              source: "runtime",
              createdAt: "2025-12-01T00:00:00.000Z",
              updatedAt: "2025-12-01T00:00:00.000Z",
            },
          ],
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
    write(
      path.join(baseDir, ".personal-memory.suggestions.json"),
      JSON.stringify(
        {
          version: 1,
          items: [
            {
              id: "pms_stale",
              createdAt: "2025-12-01T00:00:00.000Z",
              updatedAt: "2025-12-01T00:00:00.000Z",
              status: "dismissed",
              fingerprint: "stale",
              source: { channel: "feishu" },
              suggestion: { level: "L1", reason: "stale", target: "projects" },
            },
          ],
        },
        null,
        2,
      ),
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-26T12:00:00.000Z"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    const suggestion = emitPersonalMemoryPostSuggestion({
      runId: "run-gc",
      sessionKey: "session-gc",
      personalContextDir: baseDir,
      logger,
      input: {
        channel: "feishu",
        taskKind: "project-discussion",
        summary: "梳理当前状态并给出下一步实施计划",
      },
    });

    expect(suggestion.level).toBe("L1");
    const runtime = JSON.parse(
      fs.readFileSync(path.join(baseDir, ".runtime-memory.json"), "utf8"),
    ) as {
      working: Array<{ id: string }>;
      episodic: Array<{ id: string }>;
    };
    expect(runtime.working).toEqual([]);
    expect(runtime.episodic.some((item) => item.id === "episodic:stale")).toBe(false);
    expect(runtime.episodic.some((item) => item.id === "episodic:runtime:session-gc:run-gc")).toBe(
      true,
    );
    const queue = JSON.parse(
      fs.readFileSync(path.join(baseDir, ".personal-memory.suggestions.json"), "utf8"),
    ) as {
      items: Array<{ id: string; status: string }>;
    };
    expect(queue.items.some((item) => item.id === "pms_stale")).toBe(false);
    expect(queue.items.some((item) => item.status === "pending")).toBe(true);
    const runtimeArchivePath = path.join(baseDir, "archive", "runtime-episodic.archive.jsonl");
    expect(fs.existsSync(runtimeArchivePath)).toBe(true);
    expect(fs.readFileSync(runtimeArchivePath, "utf8")).toContain('"id":"episodic:stale"');
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("personal-memory auto-gc: runtimeArchived="),
    );
    vi.useRealTimers();
  });

  it("runs auto-sync export on post hook when runtimeSync is enabled", () => {
    const root = makeTempDir("openclaw-personal-memory-hooks-");
    const baseDir = path.join(root, "personal-context");
    seedPersonalContext(baseDir);
    write(
      path.join(baseDir, PERSONAL_MEMORY_SETTINGS_FILE),
      JSON.stringify(
        {
          version: 1,
          runtimeSync: {
            enabled: true,
            runOnPreHook: false,
            runOnPostHook: true,
            minIntervalMinutes: 1,
            mode: "export",
            bundleFile: "archive/auto-runtime-sync.json",
            includeWorking: false,
            maxEpisodic: 20,
          },
        },
        null,
        2,
      ),
    );
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    emitPersonalMemoryPostSuggestion({
      runId: "run-sync",
      sessionKey: "session-sync",
      personalContextDir: baseDir,
      logger,
      input: {
        channel: "feishu",
        taskKind: "project-discussion",
        summary: "完成 runtime auto-sync 导出测试",
      },
    });

    const bundlePath = path.join(baseDir, "archive", "auto-runtime-sync.json");
    expect(fs.existsSync(bundlePath)).toBe(true);
    const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8")) as {
      runtime: { working: Array<{ id: string }>; episodic: Array<{ id: string }> };
    };
    expect(bundle.runtime.working).toEqual([]);
    expect(
      bundle.runtime.episodic.some((r) => r.id === "episodic:runtime:session-sync:run-sync"),
    ).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("phase=post mode=export"));
  });

  it("runs auto-sync sync on post hook when runtimeSync mode is sync", () => {
    const root = makeTempDir("openclaw-personal-memory-hooks-");
    const baseDir = path.join(root, "personal-context");
    seedPersonalContext(baseDir);
    write(
      path.join(baseDir, PERSONAL_MEMORY_SETTINGS_FILE),
      JSON.stringify(
        {
          version: 1,
          runtimeSync: {
            enabled: true,
            runOnPreHook: false,
            runOnPostHook: true,
            minIntervalMinutes: 1,
            mode: "sync",
            bundleFile: "archive/auto-runtime-sync.json",
            includeWorking: false,
            maxEpisodic: 20,
          },
        },
        null,
        2,
      ),
    );
    write(
      path.join(baseDir, "archive", "auto-runtime-sync.json"),
      JSON.stringify(
        {
          version: 1,
          exportedAt: "2026-02-26T00:00:00.000Z",
          source: { cwd: "/tmp", personalContextDir: "/tmp/personal-context" },
          runtime: {
            version: 1,
            working: [],
            episodic: [
              {
                id: "episodic:remote:1",
                layer: "episodic",
                title: "Remote episodic",
                content: "来自另一实例的 runtime 记录",
                source: "runtime",
                tags: ["runtime", "episodic"],
                createdAt: "2026-02-24T00:00:00.000Z",
                updatedAt: "2026-02-24T00:00:00.000Z",
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    emitPersonalMemoryPostSuggestion({
      runId: "run-sync-merge",
      sessionKey: "session-sync-merge",
      personalContextDir: baseDir,
      logger,
      input: {
        channel: "feishu",
        taskKind: "project-discussion",
        summary: "完成 runtime auto-sync 双向收敛测试",
      },
    });

    const runtime = JSON.parse(
      fs.readFileSync(path.join(baseDir, ".runtime-memory.json"), "utf8"),
    ) as {
      episodic: Array<{ id: string }>;
    };
    expect(runtime.episodic.some((r) => r.id === "episodic:remote:1")).toBe(true);
    expect(
      runtime.episodic.some((r) => r.id === "episodic:runtime:session-sync-merge:run-sync-merge"),
    ).toBe(true);

    const bundle = JSON.parse(
      fs.readFileSync(path.join(baseDir, "archive", "auto-runtime-sync.json"), "utf8"),
    ) as {
      runtime: { episodic: Array<{ id: string }> };
    };
    expect(bundle.runtime.episodic.some((r) => r.id === "episodic:remote:1")).toBe(true);
    expect(
      bundle.runtime.episodic.some(
        (r) => r.id === "episodic:runtime:session-sync-merge:run-sync-merge",
      ),
    ).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("phase=post mode=sync"));
  });

  it("downgrades auto-sync sync bundle version mismatch to warning", () => {
    const root = makeTempDir("openclaw-personal-memory-hooks-");
    const baseDir = path.join(root, "personal-context");
    seedPersonalContext(baseDir);
    write(
      path.join(baseDir, PERSONAL_MEMORY_SETTINGS_FILE),
      JSON.stringify(
        {
          version: 1,
          runtimeSync: {
            enabled: true,
            runOnPreHook: false,
            runOnPostHook: true,
            minIntervalMinutes: 1,
            mode: "sync",
            bundleFile: "archive/auto-runtime-sync.json",
          },
        },
        null,
        2,
      ),
    );
    write(
      path.join(baseDir, "archive", "auto-runtime-sync.json"),
      JSON.stringify({ version: 2, runtime: { version: 1, working: [], episodic: [] } }, null, 2),
    );
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    const suggestion = emitPersonalMemoryPostSuggestion({
      runId: "run-sync-bad-bundle",
      sessionKey: "session-sync-bad-bundle",
      personalContextDir: baseDir,
      logger,
      input: {
        channel: "feishu",
        taskKind: "project-discussion",
        summary: "这次应该降级 warning 而不是中断回复链路",
      },
    });

    expect(suggestion.level).toBe("L1");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "personal-memory auto-sync failed: unsupported runtime share bundle version",
      ),
    );
  });
});
