import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildInitialPersonalMemorySnapshot,
  loadPersonalContextSemanticSeed,
  parseDecisionLogEntries,
  parsePersonalContextDocument,
} from "./personal-context.js";

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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("personal-context parser", () => {
  it("parses metadata and sections from a personal-context document", () => {
    const doc = parsePersonalContextDocument(
      "01-current-focus.md",
      `# 01 Current Focus

- 最后更新日期： 2026-02-25
- 适用周期： 本周

## 当前重点

1. A
2. B

## 暂缓事项

- X
`,
    );

    expect(doc.kind).toBe("current-focus");
    expect(doc.title).toBe("01 Current Focus");
    expect(doc.lastUpdatedDate).toBe("2026-02-25");
    expect(doc.applicablePeriod).toBe("本周");
    expect(doc.sections.map((s) => s.heading)).toEqual(["当前重点", "暂缓事项"]);
  });

  it("parses decision-log entries from 决策记录 only and ignores examples/placeholders", () => {
    const entries = parseDecisionLogEntries(`# 04 Decision Log

## 模板（复制使用）

### [2026-02-01] 模板区标题

- 背景：模板

## 决策记录

### [2026-02-24] 较新真实记录
- 背景：A
- 决策：A
- 原因：A

### [2026-02-25] 示例记录（示例）
- 背景：示例

### [2026-02-20] 较早真实记录
- 背景：B
- 决策：B
- 原因：B

### [YYYY-MM-DD] 决策标题
- 背景：
`);

    expect(entries.map((e) => `${e.date}|${e.title}`)).toEqual([
      "2026-02-24|较新真实记录",
      "2026-02-20|较早真实记录",
    ]);
    expect(entries[0]?.decision).toBe("A");
  });

  it("loads semantic seed from personal-context directory and derives initial snapshot", () => {
    const root = makeTempDir("openclaw-personal-memory-");
    const baseDir = path.join(root, "personal-context");
    write(
      path.join(baseDir, "00-identity.md"),
      `# 00 Identity\n\n- 最后更新日期： 2026-02-25\n\n## 简介\n\n- 角色：开发者\n`,
    );
    write(
      path.join(baseDir, "01-current-focus.md"),
      `# 01 Current Focus\n\n- 最后更新日期： 2026-02-25\n\n## 当前重点\n\n1. 记忆系统\n`,
    );
    write(
      path.join(baseDir, "02-projects.md"),
      `# 02 Projects\n\n- 最后更新日期： 2026-02-25\n\n## 项目列表\n\n- OpenClaw\n`,
    );
    write(
      path.join(baseDir, "03-working-rules.md"),
      `# 03 Working Rules\n\n- 最后更新日期： 2026-02-25\n\n## 规则\n\n- 先审计后改代码\n`,
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

    const seed = loadPersonalContextSemanticSeed(baseDir);
    expect(seed.docs).toHaveLength(5);
    expect(seed.decisions).toHaveLength(1);
    expect(seed.decisions[0]?.title).toContain("建立记忆系统文档与工具链");

    const snapshot = buildInitialPersonalMemorySnapshot(seed);
    expect(snapshot.semantic).toHaveLength(5);
    expect(snapshot.episodic).toHaveLength(1);
    expect(snapshot.working).toHaveLength(0);
    expect(snapshot.semantic[0]?.layer).toBe("semantic");
    expect(snapshot.episodic[0]?.layer).toBe("episodic");
  });
});
