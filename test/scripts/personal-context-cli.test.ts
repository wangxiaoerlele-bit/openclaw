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
});
