import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const scriptDir = path.join(repoRoot, "scripts");
const tsxImportPath = path.join(repoRoot, "node_modules/tsx/dist/loader.mjs");

const tempDirs: string[] = [];

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mem-cli-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function seedPersonalContext(workspace: string, opts?: { decisionLog?: string }) {
  const baseDir = path.join(workspace, "personal-context");
  fs.mkdirSync(baseDir, { recursive: true });
  const baseDate = "2026-02-25";
  writeFile(
    path.join(baseDir, "00-identity.md"),
    `# 00 Identity\n\n- 最后更新日期： ${baseDate}\n\n## 概览\n`,
  );
  writeFile(
    path.join(baseDir, "01-current-focus.md"),
    `# 01 Current Focus\n\n- 最后更新日期： ${baseDate}\n\n1. 当前重点A\n`,
  );
  writeFile(
    path.join(baseDir, "02-projects.md"),
    `# 02 Projects\n\n- 最后更新日期： ${baseDate}\n\n## 项目列表\n`,
  );
  writeFile(
    path.join(baseDir, "03-working-rules.md"),
    `# 03 Working Rules\n\n- 最后更新日期： ${baseDate}\n\n## 规则\n`,
  );
  writeFile(
    path.join(baseDir, "04-decision-log.md"),
    opts?.decisionLog ??
      `# 04 Decision Log

- 最后更新日期： ${baseDate}

## 模板（复制使用）

### [2026-02-01] 模板区里不该被解析

- 背景：模板区域

## 决策记录

### [2026-02-25] 示例记录（示例）

- 背景：示例
- 决策：示例

### [2026-02-20] 较早真实记录

- 背景：B
- 决策：B
- 原因：B

### [2026-02-24] 较新真实记录

- 背景：A
- 决策：A
- 原因：A

### [YYYY-MM-DD] 决策标题

- 背景：
`,
  );
}

function runTsScript(workspace: string, scriptName: string, args: string[] = []): RunResult {
  const scriptPath = path.join(scriptDir, scriptName);
  const result = spawnSync(process.execPath, ["--import", tsxImportPath, scriptPath, ...args], {
    cwd: workspace,
    encoding: "utf8",
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("personal-context CLI scripts", () => {
  it("memory:check warns when decision-log has no real entries in 决策记录 section", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace, {
      decisionLog: `# 04 Decision Log

- 最后更新日期： 2026-02-25

## 模板（复制使用）

### [2026-02-25] 这条在模板区

- 背景：模板

## 决策记录

### [YYYY-MM-DD] 决策标题

- 背景：
`,
    });

    const res = runTsScript(workspace, "personal-context-check.ts");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Checking personal context:");
    expect(res.stderr).toContain("04-decision-log.md: no dated decision entries found yet");
  });

  it("memory:summary returns JSON sorted by date desc and excludes 示例/template entries", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);

    const res = runTsScript(workspace, "personal-context-summary.ts", ["--json", "--limit", "5"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      totalEntries: number;
      shown: number;
      entries: Array<{ date: string; title: string }>;
    };
    expect(parsed.totalEntries).toBe(2);
    expect(parsed.shown).toBe(2);
    expect(parsed.entries.map((e) => `${e.date}|${e.title}`)).toEqual([
      "2026-02-24|较新真实记录",
      "2026-02-20|较早真实记录",
    ]);
  });

  it("memory:summary rejects memory directories outside current workspace", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    const outside = makeTempWorkspace();
    seedPersonalContext(outside);

    const res = runTsScript(workspace, "personal-context-summary.ts", [
      "--dir",
      path.join(outside, "personal-context"),
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("must stay within current workspace");
  });

  it("memory:add-decision rejects invalid --file path", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);

    const res = runTsScript(workspace, "personal-context-add-decision.ts", [
      "--dry-run",
      "--file",
      "../oops.md",
      "--title",
      "x",
      "--background",
      "y",
      "--decision",
      "z",
      "--reason",
      "r",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("memory file must not include path separators");
  });

  it("memory:add-decision inserts under 决策记录 and updates 最后更新日期", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    const filePath = path.join(workspace, "personal-context", "04-decision-log.md");

    const res = runTsScript(workspace, "personal-context-add-decision.ts", [
      "--date",
      "2026-02-26",
      "--title",
      "新增测试决策",
      "--background",
      "背景A",
      "--decision",
      "决策A",
      "--reason",
      "原因A",
    ]);

    expect(res.code).toBe(0);
    const next = fs.readFileSync(filePath, "utf8");
    expect(next).toContain("最后更新日期： 2026-02-26");
    const sectionIdx = next.indexOf("## 决策记录");
    const newIdx = next.indexOf("### [2026-02-26] 新增测试决策");
    const oldIdx = next.indexOf("### [2026-02-20] 较早真实记录");
    expect(newIdx).toBeGreaterThan(sectionIdx);
    expect(oldIdx).toBeGreaterThan(newIdx);
  });

  it("memory:touch reports invalid file names explicitly and exits non-zero", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);

    const res = runTsScript(workspace, "personal-context-touch.ts", [
      "--file",
      "../oops.md",
      "--dry-run",
    ]);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("../oops.md: invalid");
    expect(res.stdout).toContain("path separators");
  });

  it("memory:status returns JSON counts for personal-memory snapshot", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);

    const res = runTsScript(workspace, "personal-memory-status.ts", ["--json"]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      counts: { working: number; episodic: number; semantic: number };
      status: { initialized: boolean; fileCount: number; refreshCount: number };
    };
    expect(payload.counts).toEqual({
      working: 0,
      episodic: 2,
      semantic: 5,
    });
    expect(payload.status.initialized).toBe(true);
    expect(payload.status.fileCount).toBe(5);
    expect(payload.status.refreshCount).toBe(1);
  });

  it("memory:search returns ranked hits and supports layer filter", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace, {
      decisionLog: `# 04 Decision Log

- 最后更新日期： 2026-02-25

## 决策记录

### [2026-02-25] Hooks 集成方案

- 背景：需要把 personal-memory 接入会话
- 决策：先接 chat.send 再做通用 hooks
- 原因：降低接入风险
`,
    });
    const projectsPath = path.join(workspace, "personal-context", "02-projects.md");
    fs.writeFileSync(
      projectsPath,
      `# 02 Projects

- 最后更新日期： 2026-02-25

## 项目列表

- OpenClaw: 目前正在推进 personal-memory search 能力
`,
      "utf8",
    );

    const episodicRes = runTsScript(workspace, "personal-memory-search.ts", [
      "--query",
      "hooks",
      "--layers",
      "episodic",
      "--json",
    ]);
    expect(episodicRes.code).toBe(0);
    const episodicPayload = JSON.parse(episodicRes.stdout) as {
      totalHits: number;
      hits: Array<{ layer: string; title: string }>;
    };
    expect(episodicPayload.totalHits).toBe(1);
    expect(episodicPayload.hits[0]?.layer).toBe("episodic");
    expect(episodicPayload.hits[0]?.title).toContain("Hooks 集成方案");

    const semanticRes = runTsScript(workspace, "personal-memory-search.ts", [
      "--query",
      "search",
      "--layers",
      "semantic",
      "--json",
    ]);
    expect(semanticRes.code).toBe(0);
    const semanticPayload = JSON.parse(semanticRes.stdout) as {
      totalHits: number;
      hits: Array<{ layer: string; title: string; snippet: string }>;
    };
    expect(semanticPayload.totalHits).toBeGreaterThanOrEqual(1);
    expect(semanticPayload.hits[0]?.layer).toBe("semantic");
    expect(semanticPayload.hits[0]?.snippet).toContain("search");

    const semanticModeRes = runTsScript(workspace, "personal-memory-search.ts", [
      "--query",
      "OpenClw",
      "--mode",
      "semantic",
      "--json",
    ]);
    expect(semanticModeRes.code).toBe(0);
    const semanticModePayload = JSON.parse(semanticModeRes.stdout) as {
      mode: string;
      totalHits: number;
      rerank?: { enabled: boolean; applied: boolean; strategy: string };
      cache?: { enabled: boolean; rebuilt?: boolean; cacheHit?: boolean };
    };
    expect(semanticModePayload.mode).toBe("semantic");
    expect(semanticModePayload.totalHits).toBeGreaterThan(0);
    expect(semanticModePayload.rerank?.enabled).toBe(true);
    expect(semanticModePayload.rerank?.strategy).toBe("hybrid-v2");
    expect(semanticModePayload.cache?.enabled).toBe(true);

    const rerankOffRes = runTsScript(workspace, "personal-memory-search.ts", [
      "--query",
      "OpenClw",
      "--mode",
      "semantic",
      "--no-rerank",
      "--json",
    ]);
    expect(rerankOffRes.code).toBe(0);
    const rerankOffPayload = JSON.parse(rerankOffRes.stdout) as {
      rerank?: { enabled: boolean; applied: boolean; reason?: string };
    };
    expect(rerankOffPayload.rerank?.enabled).toBe(false);
    expect(rerankOffPayload.rerank?.applied).toBe(false);

    const rerankTopKRes = runTsScript(workspace, "personal-memory-search.ts", [
      "--query",
      "OpenClw",
      "--mode",
      "semantic",
      "--limit",
      "3",
      "--rerank-top-k",
      "5",
      "--json",
    ]);
    expect(rerankTopKRes.code).toBe(0);
    const rerankTopKPayload = JSON.parse(rerankTopKRes.stdout) as {
      rerank?: { topK: number };
    };
    expect(rerankTopKPayload.rerank?.topK).toBe(5);

    const rerankStrategyRes = runTsScript(workspace, "personal-memory-search.ts", [
      "--query",
      "OpenClw",
      "--mode",
      "semantic",
      "--rerank-strategy",
      "mmr-lite",
      "--json",
    ]);
    expect(rerankStrategyRes.code).toBe(0);
    const rerankStrategyPayload = JSON.parse(rerankStrategyRes.stdout) as {
      rerank?: { strategy?: string };
    };
    expect(rerankStrategyPayload.rerank?.strategy).toBe("mmr-lite");

    const noCacheRes = runTsScript(workspace, "personal-memory-search.ts", [
      "--query",
      "OpenClw",
      "--mode",
      "semantic",
      "--no-cache",
      "--json",
    ]);
    expect(noCacheRes.code).toBe(0);
    const noCachePayload = JSON.parse(noCacheRes.stdout) as {
      cache?: { enabled: boolean; reason?: string };
    };
    expect(noCachePayload.cache?.enabled).toBe(false);
    expect(noCachePayload.cache?.reason).toBe("disabled");

    const sqliteVecFallbackRes = runTsScript(workspace, "personal-memory-search.ts", [
      "--query",
      "OpenClw",
      "--mode",
      "semantic",
      "--backend",
      "sqlite-vec",
      "--sqlite-vec-extension",
      path.join(workspace, "missing-sqlite-vec.dylib"),
      "--json",
    ]);
    expect(sqliteVecFallbackRes.code).toBe(0);
    const sqliteVecFallbackPayload = JSON.parse(sqliteVecFallbackRes.stdout) as {
      cache?: { backend?: string; reason?: string };
    };
    expect(sqliteVecFallbackPayload.cache?.backend).toBe("sparse-cache");
    expect(sqliteVecFallbackPayload.cache?.reason?.startsWith("sqlite-vec-fallback:")).toBe(true);
  });

  it("memory:apply-suggestion applies validated L2 decision-log suggestion", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    const filePath = path.join(workspace, "personal-context", "04-decision-log.md");
    const suggestion = {
      level: "L2",
      target: "decision-log",
      reason: "测试",
      structured: {
        date: "2026-02-27",
        title: "通过 apply-suggestion 写入",
        background: "背景X",
        decision: "决策X",
        reason: "原因X",
        next: "后续X",
      },
    };

    const res = runTsScript(workspace, "personal-memory-apply-suggestion.ts", [
      "--json",
      JSON.stringify(suggestion),
    ]);
    expect(res.code).toBe(0);
    const next = fs.readFileSync(filePath, "utf8");
    expect(next).toContain("### [2026-02-27] 通过 apply-suggestion 写入");
    expect(next).toContain("最后更新日期： 2026-02-27");
  });

  it("memory:apply-suggestion rejects non-L2 suggestion", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    const suggestion = {
      level: "L1",
      target: "decision-log",
      reason: "测试",
      structured: {
        date: "2026-02-27",
        title: "不该写入",
        background: "背景X",
        decision: "决策X",
        reason: "原因X",
      },
    };

    const res = runTsScript(workspace, "personal-memory-apply-suggestion.ts", [
      "--json",
      JSON.stringify(suggestion),
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("only L2 suggestions can be applied");
  });

  it("memory:suggestions lists, applies and dismisses queued suggestions", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    const suggestionA = {
      level: "L2",
      target: "decision-log",
      reason: "测试A",
      structured: {
        date: "2026-02-27",
        title: "队列建议A",
        background: "背景A",
        decision: "决策A",
        reason: "原因A",
      },
    };
    const suggestionB = {
      level: "L1",
      target: "projects",
      reason: "测试B",
      title: "项目更新建议",
      content: "建议更新项目状态",
    };
    runTsScript(workspace, "personal-memory-apply-suggestion.ts", [
      "--json",
      JSON.stringify(suggestionA),
      "--dry-run",
    ]);
    // Queue is produced by runtime hooks in real flow; for CLI test we use the queue script via direct JSON append path
    // by calling the script's apply command requires an existing queue, so seed one through the queue file using list/apply flow:
    const queueFile = path.join(workspace, "personal-context", ".personal-memory.suggestions.json");
    fs.writeFileSync(
      queueFile,
      JSON.stringify(
        {
          version: 1,
          items: [
            {
              id: "pms_test_a",
              createdAt: "2026-02-26T00:00:00.000Z",
              updatedAt: "2026-02-26T00:00:00.000Z",
              status: "pending",
              fingerprint: "fpa",
              source: { channel: "feishu", runId: "run-a", sessionKey: "s-a" },
              suggestion: suggestionA,
            },
            {
              id: "pms_test_b",
              createdAt: "2026-02-26T01:00:00.000Z",
              updatedAt: "2026-02-26T01:00:00.000Z",
              status: "pending",
              fingerprint: "fpb",
              source: { channel: "feishu", runId: "run-b", sessionKey: "s-b" },
              suggestion: suggestionB,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const listRes = runTsScript(workspace, "personal-memory-suggestions.ts", ["list", "--json"]);
    expect(listRes.code).toBe(0);
    const listPayload = JSON.parse(listRes.stdout) as {
      total: number;
      items: Array<{ id: string }>;
    };
    expect(listPayload.total).toBe(2);

    const applyDryRun = runTsScript(workspace, "personal-memory-suggestions.ts", [
      "apply",
      "--id",
      "pms_test_a",
      "--dry-run",
      "--json",
    ]);
    expect(applyDryRun.code).toBe(0);
    const applyDryRunPayload = JSON.parse(applyDryRun.stdout) as {
      item: { status: string };
      applyResult: { dryRun: boolean; target: string };
    };
    expect(applyDryRunPayload.applyResult.dryRun).toBe(true);

    const applyRes = runTsScript(workspace, "personal-memory-suggestions.ts", [
      "apply",
      "--id",
      "pms_test_a",
      "--json",
    ]);
    expect(applyRes.code).toBe(0);
    const applyPayload = JSON.parse(applyRes.stdout) as {
      item: { status: string };
      applyResult: { title: string };
    };
    expect(applyPayload.item.status).toBe("applied");
    expect(applyPayload.applyResult.title).toBe("队列建议A");

    const dismissRes = runTsScript(workspace, "personal-memory-suggestions.ts", [
      "dismiss",
      "--id",
      "pms_test_b",
      "--json",
    ]);
    expect(dismissRes.code).toBe(0);
    const dismissPayload = JSON.parse(dismissRes.stdout) as { item: { status: string } };
    expect(dismissPayload.item.status).toBe("dismissed");
  });

  it("memory:gc dry-run reports runtime/suggestion cleanup without mutating files", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    const baseDir = path.join(workspace, "personal-context");
    const runtimePath = path.join(baseDir, ".runtime-memory.json");
    const queuePath = path.join(baseDir, ".personal-memory.suggestions.json");
    fs.writeFileSync(
      runtimePath,
      JSON.stringify(
        {
          version: 1,
          working: [
            {
              id: "working:old",
              layer: "working",
              title: "old",
              content: "old",
              source: "runtime",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          episodic: [],
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      queuePath,
      JSON.stringify(
        {
          version: 1,
          items: [
            {
              id: "pms_old",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              status: "dismissed",
              fingerprint: "old",
              source: {},
              suggestion: { level: "L1", reason: "old" },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const beforeRuntime = fs.readFileSync(runtimePath, "utf8");
    const beforeQueue = fs.readFileSync(queuePath, "utf8");
    const res = runTsScript(workspace, "personal-memory-gc.ts", ["--dry-run", "--json"]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      dryRun: boolean;
      runtime: { beforeWorking: number; afterWorking: number };
      suggestions: { before: number; after: number };
    };
    expect(payload.dryRun).toBe(true);
    expect(payload.runtime.beforeWorking).toBe(1);
    expect(payload.runtime.afterWorking).toBeLessThanOrEqual(1);
    expect(payload.suggestions.before).toBe(1);
    expect(fs.readFileSync(runtimePath, "utf8")).toBe(beforeRuntime);
    expect(fs.readFileSync(queuePath, "utf8")).toBe(beforeQueue);
  });

  it("memory:gc non-json output does not crash on text mode", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    const res = runTsScript(workspace, "personal-memory-gc.ts", ["--dry-run"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Personal memory GC:");
    expect(res.stdout).toContain("Runtime -> working");
    expect(res.stdout).toContain("Suggestions ->");
  });

  it("memory:migrate-legacy imports missing decision entries and skips duplicates", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace, {
      decisionLog: `# 04 Decision Log

- 最后更新日期： 2026-02-25

## 决策记录

### [2026-02-24] 已存在决策

- 背景：已有
- 决策：已有
- 原因：已有
`,
    });
    writeFile(
      path.join(workspace, "legacy-decisions.md"),
      `# 旧版决策整理

## 决策记录

### [2026-02-24] 已存在决策

- 背景：重复
- 决策：重复
- 原因：重复

### [2026-02-26] 新迁移决策

- 背景：迁移背景
- 决策：迁移决策
- 原因：迁移原因
- 后续动作：执行验证
`,
    );

    const res = runTsScript(workspace, "personal-memory-migrate-legacy.ts", [
      "--json",
      "--from",
      "legacy-decisions.md",
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      imported: number;
      duplicates: number;
      importedEntries: Array<{ date: string; title: string }>;
    };
    expect(payload.imported).toBe(1);
    expect(payload.duplicates).toBe(1);
    expect(payload.importedEntries).toEqual([{ date: "2026-02-26", title: "新迁移决策" }]);

    const decisionLog = fs.readFileSync(
      path.join(workspace, "personal-context", "04-decision-log.md"),
      "utf8",
    );
    expect(decisionLog).toContain("### [2026-02-26] 新迁移决策");
    expect(decisionLog).toContain("最后更新日期： 2026-02-26");
  });

  it("memory:migrate-legacy dry-run does not mutate files and rejects source outside workspace", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    const before = fs.readFileSync(
      path.join(workspace, "personal-context", "04-decision-log.md"),
      "utf8",
    );
    writeFile(
      path.join(workspace, "legacy-loose.md"),
      `# Loose

### [2026-02-26] 松散格式决策
- 背景：A
- 决策：B
- 原因：C
`,
    );

    const dryRun = runTsScript(workspace, "personal-memory-migrate-legacy.ts", [
      "--dry-run",
      "--json",
      "--from",
      "legacy-loose.md",
    ]);
    expect(dryRun.code).toBe(0);
    const dryPayload = JSON.parse(dryRun.stdout) as {
      dryRun: boolean;
      imported: number;
      sources: Array<{ mode: string }>;
    };
    expect(dryPayload.dryRun).toBe(true);
    expect(dryPayload.imported).toBe(1);
    expect(dryPayload.sources[0]?.mode).toBe("loose");
    expect(
      fs.readFileSync(path.join(workspace, "personal-context", "04-decision-log.md"), "utf8"),
    ).toBe(before);

    const outside = makeTempWorkspace();
    writeFile(path.join(outside, "legacy.md"), "# x\n");
    const reject = runTsScript(workspace, "personal-memory-migrate-legacy.ts", [
      "--from",
      path.join(outside, "legacy.md"),
    ]);
    expect(reject.code).toBe(1);
    expect(reject.stderr).toContain("must stay within current workspace");
  });

  it("memory:migrate-legacy supports snapshot import into current-focus and structured import into projects", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    writeFile(
      path.join(workspace, "legacy-focus.md"),
      `# 本周重点（旧版）

- 最后更新日期： 2026-02-27

本周重点是完成记忆系统优化的测试和文档收口。
`,
    );
    writeFile(
      path.join(workspace, "legacy-projects.md"),
      `# 项目状态（旧版）

- 最后更新日期： 2026-02-26

## OpenClaw

- 当前状态：记忆系统优化进入稳定阶段 | 等待收尾
- 下一步：补 sqlite-vec 检索后端
`,
    );

    const dryRun = runTsScript(workspace, "personal-memory-migrate-legacy.ts", [
      "--target-file",
      "01-current-focus.md",
      "--target-kind",
      "current-focus",
      "--from",
      "legacy-focus.md",
      "--dry-run",
      "--json",
    ]);
    expect(dryRun.code).toBe(0);
    const dryPayload = JSON.parse(dryRun.stdout) as {
      targetKind: string;
      imported: number;
      duplicates: number;
    };
    expect(dryPayload.targetKind).toBe("current-focus");
    expect(dryPayload.imported).toBe(1);
    expect(dryPayload.duplicates).toBe(0);

    const applyProjects = runTsScript(workspace, "personal-memory-migrate-legacy.ts", [
      "--target-file",
      "02-projects.md",
      "--target-kind",
      "projects",
      "--from",
      "legacy-projects.md",
      "--json",
    ]);
    expect(applyProjects.code).toBe(0);
    const projectsPayload = JSON.parse(applyProjects.stdout) as {
      targetKind: string;
      imported: number;
      sources: Array<{ mode: string; parsed: number }>;
    };
    expect(projectsPayload.targetKind).toBe("projects");
    expect(projectsPayload.imported).toBe(1);
    expect(projectsPayload.sources[0]?.mode).toBe("projects-structured");
    expect(projectsPayload.sources[0]?.parsed).toBe(1);

    const projectsText = fs.readFileSync(
      path.join(workspace, "personal-context", "02-projects.md"),
      "utf8",
    );
    expect(projectsText).toContain("## 历史迁移项目状态（结构化）");
    expect(projectsText).toContain("### [2026-02-26] 迁移项目状态：legacy-projects.md");
    expect(projectsText).toContain("#### 结构化项目状态");
    expect(projectsText).toContain("| OpenClaw |");
    expect(projectsText).toContain("记忆系统优化进入稳定阶段 \\| 等待收尾");

    const applyProjectsAgain = runTsScript(workspace, "personal-memory-migrate-legacy.ts", [
      "--target-file",
      "02-projects.md",
      "--target-kind",
      "projects",
      "--from",
      "legacy-projects.md",
      "--json",
    ]);
    expect(applyProjectsAgain.code).toBe(0);
    const projectsAgainPayload = JSON.parse(applyProjectsAgain.stdout) as {
      imported: number;
      duplicates: number;
    };
    expect(projectsAgainPayload.imported).toBe(0);
    expect(projectsAgainPayload.duplicates).toBe(1);
  });

  it("memory:migrate-legacy parses markdown project table into structured project migration section", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    writeFile(
      path.join(workspace, "legacy-project-table.md"),
      `# 项目表（旧版）

- 最后更新日期： 2026-02-28

| 项目 | 类型 | 当前阶段 | 优先级 | 下一步 | 当前状态 |
| ---- | ---- | -------- | ------ | ------ | -------- |
| OpenClaw | 开发 | 维护 | P0 | 完成收尾测试 | 记忆系统优化接近完成 |
| Portal | 运维 | 上线 | P1 | 观察错误率 | 发布后观察 |
`,
    );

    const res = runTsScript(workspace, "personal-memory-migrate-legacy.ts", [
      "--target-file",
      "02-projects.md",
      "--target-kind",
      "projects",
      "--from",
      "legacy-project-table.md",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      imported: number;
      duplicates: number;
      sources: Array<{ mode: string; parsed: number; imported: number }>;
    };
    expect(payload.imported).toBe(2);
    expect(payload.duplicates).toBe(0);
    expect(payload.sources[0]?.mode).toBe("projects-structured");
    expect(payload.sources[0]?.parsed).toBe(2);
    expect(payload.sources[0]?.imported).toBe(2);

    const projectsText = fs.readFileSync(
      path.join(workspace, "personal-context", "02-projects.md"),
      "utf8",
    );
    expect(projectsText).toContain("### [2026-02-28] 迁移项目状态：legacy-project-table.md");
    expect(projectsText).toContain(
      "| OpenClaw | 开发 | 维护 | P0 | 完成收尾测试 | 记忆系统优化接近完成 |",
    );
    expect(projectsText).toContain("| Portal | 运维 | 上线 | P1 | 观察错误率 | 发布后观察 |");
  });

  it("memory:migrate-legacy can merge structured project rows into projects overview table", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    writeFile(
      path.join(workspace, "personal-context", "02-projects.md"),
      `# 02 Projects

- 最后更新日期： 2026-02-25

## 项目清单（总览）

| 项目 | 类型 | 当前阶段 | 优先级 | 下一步 |
| ---- | ---- | -------- | ------ | ------ |
| OpenClaw | 开发 | 进行中 | P1 | 完成接口联调 |
| 示例项目B | 学习/研究 | 调研中 | P2 | 输出调研结论 |

## 更新规则

- 最后更新日期： 2026-02-25
`,
    );
    writeFile(
      path.join(workspace, "legacy-projects-merge.md"),
      `# 项目状态（旧版）

- 最后更新日期： 2026-02-28

## OpenClaw

- 当前阶段：维护
- 优先级：P0
- 下一步：发布收尾

## Runtime Memory

- 项目类型：基础设施
- 当前阶段：开发
- 优先级：P1
- 当前状态：补自动同步策略
- 下一步：验证多渠道稳定性
`,
    );

    const res = runTsScript(workspace, "personal-memory-migrate-legacy.ts", [
      "--target-file",
      "02-projects.md",
      "--target-kind",
      "projects",
      "--merge-project-overview",
      "--from",
      "legacy-projects-merge.md",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      imported: number;
      mergeProjectOverview: boolean;
      overviewTableUpdated: boolean;
      overviewMergedRows: number;
      overviewInsertedRows: number;
    };
    expect(payload.imported).toBe(2);
    expect(payload.mergeProjectOverview).toBe(true);
    expect(payload.overviewTableUpdated).toBe(true);
    expect(payload.overviewMergedRows).toBe(1);
    expect(payload.overviewInsertedRows).toBe(1);

    const projectsText = fs.readFileSync(
      path.join(workspace, "personal-context", "02-projects.md"),
      "utf8",
    );
    expect(projectsText).toContain("| OpenClaw");
    expect(projectsText).toContain("| 开发");
    expect(projectsText).toContain("| 维护");
    expect(projectsText).toContain("| P0");
    expect(projectsText).toContain("发布收尾");
    expect(projectsText).toContain("Runtime Memory");
    expect(projectsText).toContain("基础设施");
    expect(projectsText).toContain("验证多渠道稳定性");
    expect(projectsText).toContain("## 历史迁移项目状态（结构化）");

    const rerun = runTsScript(workspace, "personal-memory-migrate-legacy.ts", [
      "--target-file",
      "02-projects.md",
      "--target-kind",
      "projects",
      "--merge-project-overview",
      "--from",
      "legacy-projects-merge.md",
      "--json",
    ]);
    expect(rerun.code).toBe(0);
    const rerunPayload = JSON.parse(rerun.stdout) as {
      imported: number;
      duplicates: number;
      overviewTableUpdated: boolean;
      overviewMergedRows: number;
      overviewInsertedRows: number;
    };
    expect(rerunPayload.imported).toBe(0);
    expect(rerunPayload.duplicates).toBe(2);
    expect(rerunPayload.overviewTableUpdated).toBe(false);
    expect(rerunPayload.overviewMergedRows).toBe(0);
    expect(rerunPayload.overviewInsertedRows).toBe(0);
  });

  it("memory:migrate-legacy supports snapshot import into identity/working-rules", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    writeFile(
      path.join(workspace, "legacy-identity.md"),
      `# 我的身份信息（旧版）

- 最后更新日期： 2026-02-24

我是一名长期使用 OpenClaw 的开发者。
`,
    );
    writeFile(
      path.join(workspace, "legacy-rules.md"),
      `# 工作规则（旧版）

- 最后更新日期： 2026-02-23

1. 先验证再下结论
2. 先小步改动再扩大范围
`,
    );

    const applyIdentity = runTsScript(workspace, "personal-memory-migrate-legacy.ts", [
      "--target-file",
      "00-identity.md",
      "--target-kind",
      "identity",
      "--from",
      "legacy-identity.md",
      "--json",
    ]);
    expect(applyIdentity.code).toBe(0);
    const identityPayload = JSON.parse(applyIdentity.stdout) as {
      imported: number;
      targetKind: string;
    };
    expect(identityPayload.imported).toBe(1);
    expect(identityPayload.targetKind).toBe("identity");

    const applyRules = runTsScript(workspace, "personal-memory-migrate-legacy.ts", [
      "--target-file",
      "03-working-rules.md",
      "--target-kind",
      "working-rules",
      "--from",
      "legacy-rules.md",
      "--json",
    ]);
    expect(applyRules.code).toBe(0);
    const rulesPayload = JSON.parse(applyRules.stdout) as { imported: number; targetKind: string };
    expect(rulesPayload.imported).toBe(1);
    expect(rulesPayload.targetKind).toBe("working-rules");

    const identityText = fs.readFileSync(
      path.join(workspace, "personal-context", "00-identity.md"),
      "utf8",
    );
    const rulesText = fs.readFileSync(
      path.join(workspace, "personal-context", "03-working-rules.md"),
      "utf8",
    );
    expect(identityText).toContain("## 历史迁移快照");
    expect(identityText).toContain("legacy-identity.md");
    expect(rulesText).toContain("## 历史迁移快照");
    expect(rulesText).toContain("legacy-rules.md");
  });

  it("memory:migrate-legacy rejects mismatched target-kind and target-file", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    writeFile(path.join(workspace, "legacy-focus.md"), "# legacy\n");
    const res = runTsScript(workspace, "personal-memory-migrate-legacy.ts", [
      "--target-file",
      "01-current-focus.md",
      "--target-kind",
      "projects",
      "--from",
      "legacy-focus.md",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('does not match target-file "01-current-focus.md"');
  });

  it("memory:migrate-legacy rejects --merge-project-overview for non-project targets", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    writeFile(path.join(workspace, "legacy-focus.md"), "# legacy\n");
    const res = runTsScript(workspace, "personal-memory-migrate-legacy.ts", [
      "--target-file",
      "01-current-focus.md",
      "--target-kind",
      "current-focus",
      "--merge-project-overview",
      "--from",
      "legacy-focus.md",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("only supported with --target-kind projects");
  });

  it("memory:archive dry-run reports archived candidates without mutating files", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace, {
      decisionLog: `# 04 Decision Log

- 最后更新日期： 2026-02-26

## 决策记录

### [2026-01-01] 旧决策

- 背景：old
- 决策：old
- 原因：old

### [2026-02-25] 新决策

- 背景：new
- 决策：new
- 原因：new
`,
    });
    const mainPath = path.join(workspace, "personal-context", "04-decision-log.md");
    const archivePath = path.join(
      workspace,
      "personal-context",
      "archive",
      "04-decision-log.archive.md",
    );
    const before = fs.readFileSync(mainPath, "utf8");

    const res = runTsScript(workspace, "personal-memory-archive.ts", [
      "--retain-days",
      "30",
      "--dry-run",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      dryRun: boolean;
      mainBefore: number;
      mainAfter: number;
      archivedCandidates: number;
      archiveAdded: number;
    };
    expect(payload.dryRun).toBe(true);
    expect(payload.mainBefore).toBe(2);
    expect(payload.mainAfter).toBe(1);
    expect(payload.archivedCandidates).toBe(1);
    expect(payload.archiveAdded).toBe(1);
    expect(fs.readFileSync(mainPath, "utf8")).toBe(before);
    expect(fs.existsSync(archivePath)).toBe(false);
  });

  it("memory:archive moves old decisions into archive file and updates main log", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace, {
      decisionLog: `# 04 Decision Log

- 最后更新日期： 2026-02-26

## 决策记录

### [2026-01-01] 旧决策

- 背景：old
- 决策：old
- 原因：old

### [2026-02-25] 新决策

- 背景：new
- 决策：new
- 原因：new
`,
    });

    const res = runTsScript(workspace, "personal-memory-archive.ts", [
      "--retain-days",
      "30",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      mainBefore: number;
      mainAfter: number;
      archiveAdded: number;
      archiveFilePath: string;
    };
    expect(payload.mainBefore).toBe(2);
    expect(payload.mainAfter).toBe(1);
    expect(payload.archiveAdded).toBe(1);

    const mainText = fs.readFileSync(
      path.join(workspace, "personal-context", "04-decision-log.md"),
      "utf8",
    );
    expect(mainText).not.toContain("### [2026-01-01] 旧决策");
    expect(mainText).toContain("### [2026-02-25] 新决策");
    const archiveText = fs.readFileSync(payload.archiveFilePath, "utf8");
    expect(archiveText).toContain("### [2026-01-01] 旧决策");
  });

  it("memory:archive-runtime archives old runtime episodic records", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    writeFile(
      path.join(workspace, "personal-context", ".runtime-memory.json"),
      JSON.stringify(
        {
          version: 1,
          working: [],
          episodic: [
            {
              id: "ep-old",
              layer: "episodic",
              title: "old",
              content: "old",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "ep-new",
              layer: "episodic",
              title: "new",
              content: "new",
              createdAt: "2026-02-27T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );
    const res = runTsScript(workspace, "personal-memory-archive-runtime.ts", [
      "--retain-days",
      "30",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      beforeEpisodic: number;
      afterEpisodic: number;
      archivedAdded: number;
      archiveFilePath: string;
    };
    expect(payload.beforeEpisodic).toBe(2);
    expect(payload.afterEpisodic).toBe(1);
    expect(payload.archivedAdded).toBe(1);
    expect(fs.existsSync(payload.archiveFilePath)).toBe(true);
  });

  it("memory:archive-runtime dry-run does not create archive file", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    writeFile(
      path.join(workspace, "personal-context", ".runtime-memory.json"),
      JSON.stringify(
        {
          version: 1,
          working: [],
          episodic: [
            {
              id: "ep-old",
              layer: "episodic",
              title: "old",
              content: "old",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );
    const archiveFile = path.join(
      workspace,
      "personal-context",
      "archive",
      "runtime-episodic.archive.jsonl",
    );
    const res = runTsScript(workspace, "personal-memory-archive-runtime.ts", [
      "--retain-days",
      "30",
      "--dry-run",
      "--json",
    ]);
    expect(res.code).toBe(0);
    expect(fs.existsSync(archiveFile)).toBe(false);
  });

  it("memory:share-runtime exports and imports runtime episodic records across workspaces", () => {
    const src = makeTempWorkspace();
    const dst = makeTempWorkspace();
    seedPersonalContext(src);
    seedPersonalContext(dst);
    const srcRuntimePath = path.join(src, "personal-context", ".runtime-memory.json");
    fs.writeFileSync(
      srcRuntimePath,
      JSON.stringify(
        {
          version: 1,
          working: [
            {
              id: "working:1",
              layer: "working",
              title: "临时上下文",
              content: "本轮处理中",
              source: "runtime",
              createdAt: "2026-02-27T00:00:00.000Z",
              updatedAt: "2026-02-27T00:01:00.000Z",
            },
          ],
          episodic: [
            {
              id: "ep:1",
              layer: "episodic",
              title: "迁移测试",
              content: "来自源工作区",
              source: "runtime",
              createdAt: "2026-02-27T00:00:00.000Z",
              updatedAt: "2026-02-27T00:02:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const bundleRel = path.join("tmp", "runtime-share.json");
    const exportRes = runTsScript(src, "personal-memory-share-runtime.ts", [
      "export",
      "--file",
      bundleRel,
      "--json",
    ]);
    expect(exportRes.code).toBe(0);
    const exportPayload = JSON.parse(exportRes.stdout) as {
      exportedWorking: number;
      exportedEpisodic: number;
      bundleFile: string;
    };
    expect(exportPayload.exportedWorking).toBe(0);
    expect(exportPayload.exportedEpisodic).toBe(1);
    expect(fs.existsSync(exportPayload.bundleFile)).toBe(true);

    const copiedBundle = path.join(dst, "tmp", "runtime-share.json");
    writeFile(copiedBundle, fs.readFileSync(exportPayload.bundleFile, "utf8"));

    const importDryRun = runTsScript(dst, "personal-memory-share-runtime.ts", [
      "import",
      "--file",
      path.join("tmp", "runtime-share.json"),
      "--json",
      "--dry-run",
    ]);
    expect(importDryRun.code).toBe(0);
    const importDryRunPayload = JSON.parse(importDryRun.stdout) as {
      before: { episodic: number };
      after: { episodic: number };
      dryRun: boolean;
    };
    expect(importDryRunPayload.dryRun).toBe(true);
    expect(importDryRunPayload.before.episodic).toBe(0);
    expect(importDryRunPayload.after.episodic).toBe(1);
    expect(fs.existsSync(path.join(dst, "personal-context", ".runtime-memory.json"))).toBe(false);

    const importRes = runTsScript(dst, "personal-memory-share-runtime.ts", [
      "import",
      "--file",
      path.join("tmp", "runtime-share.json"),
      "--json",
    ]);
    expect(importRes.code).toBe(0);
    const importPayload = JSON.parse(importRes.stdout) as {
      after: { episodic: number };
      conflicts: { total: number };
      auditFile: string;
    };
    expect(importPayload.after.episodic).toBe(1);
    expect(importPayload.conflicts.total).toBe(0);

    const importedRuntime = JSON.parse(
      fs.readFileSync(path.join(dst, "personal-context", ".runtime-memory.json"), "utf8"),
    ) as { episodic: Array<{ id: string }>; working: unknown[] };
    expect(importedRuntime.working).toEqual([]);
    expect(importedRuntime.episodic.map((r) => r.id)).toContain("ep:1");
    expect(fs.existsSync(importPayload.auditFile)).toBe(false);
  });

  it("memory:share-runtime export dry-run does not create bundle path", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    const bundleDir = path.join(workspace, "tmp", "nested");
    const bundleRel = path.join("tmp", "nested", "runtime-share.json");
    const res = runTsScript(workspace, "personal-memory-share-runtime.ts", [
      "export",
      "--file",
      bundleRel,
      "--dry-run",
      "--json",
    ]);
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(bundleDir, "runtime-share.json"))).toBe(false);
    expect(fs.existsSync(bundleDir)).toBe(false);
  });

  it("memory:share-runtime sync merges local + bundle and writes back bundle", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    const runtimePath = path.join(workspace, "personal-context", ".runtime-memory.json");
    const bundleRel = path.join("tmp", "runtime-sync.json");
    const bundlePath = path.join(workspace, bundleRel);
    writeFile(
      runtimePath,
      JSON.stringify(
        {
          version: 1,
          working: [],
          episodic: [
            {
              id: "ep:local",
              layer: "episodic",
              title: "local",
              content: "local",
              source: "runtime",
              createdAt: "2026-02-27T00:00:00.000Z",
              updatedAt: "2026-02-27T00:02:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );
    writeFile(
      bundlePath,
      JSON.stringify(
        {
          version: 1,
          exportedAt: "2026-02-27T00:10:00.000Z",
          source: { cwd: "/tmp/src", personalContextDir: "/tmp/src/personal-context" },
          runtime: {
            version: 1,
            working: [],
            episodic: [
              {
                id: "ep:bundle",
                layer: "episodic",
                title: "bundle",
                content: "bundle",
                source: "runtime",
                createdAt: "2026-02-27T00:00:00.000Z",
                updatedAt: "2026-02-27T00:03:00.000Z",
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const res = runTsScript(workspace, "personal-memory-share-runtime.ts", [
      "sync",
      "--file",
      bundleRel,
      "--json",
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      command: string;
      after: { episodic: number };
      exportedToBundle?: { episodic: number };
      conflicts: { total: number; incomingWon: number; currentWon: number };
      auditFile: string;
    };
    expect(payload.command).toBe("sync");
    expect(payload.after.episodic).toBe(2);
    expect(payload.exportedToBundle?.episodic).toBe(2);
    expect(payload.conflicts.total).toBe(0);

    const nextRuntime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as {
      episodic: Array<{ id: string }>;
    };
    expect(nextRuntime.episodic.map((r) => r.id)).toEqual(
      expect.arrayContaining(["ep:local", "ep:bundle"]),
    );

    const nextBundle = JSON.parse(fs.readFileSync(bundlePath, "utf8")) as {
      runtime: { episodic: Array<{ id: string }> };
    };
    expect(nextBundle.runtime.episodic.map((r) => r.id)).toEqual(
      expect.arrayContaining(["ep:local", "ep:bundle"]),
    );
    expect(fs.existsSync(payload.auditFile)).toBe(false);
  });

  it("memory:share-runtime import writes conflict audit when ids overlap", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    const runtimePath = path.join(workspace, "personal-context", ".runtime-memory.json");
    writeFile(
      runtimePath,
      JSON.stringify(
        {
          version: 1,
          working: [],
          episodic: [
            {
              id: "ep:dup",
              layer: "episodic",
              title: "local newer",
              content: "local",
              source: "runtime",
              createdAt: "2026-02-27T00:00:00.000Z",
              updatedAt: "2026-02-27T00:05:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );
    const bundleRel = path.join("tmp", "runtime-share-conflict.json");
    writeFile(
      path.join(workspace, bundleRel),
      JSON.stringify(
        {
          version: 1,
          exportedAt: "2026-02-27T00:10:00.000Z",
          source: { cwd: "/tmp/src", personalContextDir: "/tmp/src/personal-context" },
          runtime: {
            version: 1,
            working: [],
            episodic: [
              {
                id: "ep:dup",
                layer: "episodic",
                title: "bundle older",
                content: "bundle",
                source: "runtime",
                createdAt: "2026-02-27T00:00:00.000Z",
                updatedAt: "2026-02-27T00:03:00.000Z",
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    const res = runTsScript(workspace, "personal-memory-share-runtime.ts", [
      "import",
      "--file",
      bundleRel,
      "--json",
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      conflicts: { total: number; currentWon: number; incomingWon: number };
      auditFile: string;
    };
    expect(payload.conflicts.total).toBe(1);
    expect(payload.conflicts.currentWon).toBe(1);
    expect(payload.conflicts.incomingWon).toBe(0);
    expect(fs.existsSync(payload.auditFile)).toBe(true);
    const auditText = fs.readFileSync(payload.auditFile, "utf8");
    expect(auditText).toContain('"type":"runtime-share-conflict"');
    expect(auditText).toContain('"id":"ep:dup"');
    expect(auditText).toContain('"winner":"current"');
  });

  it("memory:share-runtime import accepts --conflict-strategy incoming", () => {
    const workspace = makeTempWorkspace();
    seedPersonalContext(workspace);
    const runtimePath = path.join(workspace, "personal-context", ".runtime-memory.json");
    writeFile(
      runtimePath,
      JSON.stringify(
        {
          version: 1,
          working: [],
          episodic: [
            {
              id: "ep:dup",
              layer: "episodic",
              title: "local newer",
              content: "local",
              source: "runtime",
              createdAt: "2026-02-27T00:00:00.000Z",
              updatedAt: "2026-02-27T00:05:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );
    const bundleRel = path.join("tmp", "runtime-share-conflict-incoming.json");
    writeFile(
      path.join(workspace, bundleRel),
      JSON.stringify(
        {
          version: 1,
          exportedAt: "2026-02-27T00:10:00.000Z",
          source: { cwd: "/tmp/src", personalContextDir: "/tmp/src/personal-context" },
          runtime: {
            version: 1,
            working: [],
            episodic: [
              {
                id: "ep:dup",
                layer: "episodic",
                title: "bundle older",
                content: "bundle",
                source: "runtime",
                createdAt: "2026-02-27T00:00:00.000Z",
                updatedAt: "2026-02-27T00:03:00.000Z",
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const res = runTsScript(workspace, "personal-memory-share-runtime.ts", [
      "import",
      "--file",
      bundleRel,
      "--conflict-strategy",
      "incoming",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      conflictStrategy: string;
      conflicts: { incomingWon: number; currentWon: number };
    };
    expect(payload.conflictStrategy).toBe("incoming");
    expect(payload.conflicts.incomingWon).toBe(1);
    expect(payload.conflicts.currentWon).toBe(0);

    const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as {
      episodic: Array<{ title: string }>;
    };
    expect(runtime.episodic[0]?.title).toBe("bundle older");
  });
});
