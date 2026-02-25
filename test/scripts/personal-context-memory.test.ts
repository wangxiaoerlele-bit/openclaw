import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  insertDecisionEntryIntoLog,
  parseDecisionEntriesFromLog,
  resolvePersonalContextDir,
  resolvePersonalContextFilePath,
  sortDecisionEntriesByDateDesc,
  updateLastUpdatedLine,
} from "../../scripts/personal-context-memory.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("personal-context-memory paths", () => {
  it("rejects memory file names with path separators", () => {
    const workspace = makeTempDir("openclaw-mem-workspace-");
    const memDir = path.join(workspace, "personal-context");
    fs.mkdirSync(memDir);

    const resolvedDir = resolvePersonalContextDir(workspace, "personal-context");
    expect(() => resolvePersonalContextFilePath(resolvedDir, "../secret.txt")).toThrow(
      /path separators|'\.\.'/,
    );
  });

  it("rejects memory directory outside current workspace", () => {
    const workspace = makeTempDir("openclaw-mem-workspace-");
    const outsideRoot = makeTempDir("openclaw-mem-outside-");
    const outsideMemDir = path.join(outsideRoot, "personal-context");
    fs.mkdirSync(outsideMemDir);

    expect(() => resolvePersonalContextDir(workspace, outsideMemDir)).toThrow(
      /within current workspace/,
    );
  });
});

describe("personal-context-memory decision parsing", () => {
  const sampleLog = `# 04 Decision Log

## 模板（复制使用）

### [2026-02-01] 模板区里不该被解析

- 背景：模板区域

## 决策记录

### [2026-02-25] 建立本地定制版 OpenClaw 升级维护流程（示例）

- 背景：这是示例
- 决策：示例

### [2026-02-24] 第二条真实记录

- 背景：B
- 决策：B
- 原因：B

### [2026-02-25] 第一条真实记录

- 背景：A
- 决策：A
- 原因：A

### [YYYY-MM-DD] 决策标题

- 背景：
`;

  it("parses only entries under 决策记录 and filters template/example placeholders", () => {
    const entries = parseDecisionEntriesFromLog(sampleLog);
    expect(entries.map((e) => `${e.date}|${e.title}`)).toEqual([
      "2026-02-24|第二条真实记录",
      "2026-02-25|第一条真实记录",
    ]);
  });

  it("sorts entries by date descending before summary truncation", () => {
    const sorted = sortDecisionEntriesByDateDesc(parseDecisionEntriesFromLog(sampleLog));
    expect(sorted.map((e) => `${e.date}|${e.title}`)).toEqual([
      "2026-02-25|第一条真实记录",
      "2026-02-24|第二条真实记录",
    ]);
  });
});

describe("personal-context-memory log updates", () => {
  it("inserts new entries under 决策记录 and updates 最后更新日期", () => {
    const original = `# 04 Decision Log

- 最后更新日期： 2026-02-20

## 决策记录

### [2026-02-19] 旧记录
`;

    const updatedDate = updateLastUpdatedLine(original, "2026-02-25");
    expect(updatedDate.changed).toBe(true);
    expect(updatedDate.next).toContain("最后更新日期： 2026-02-25");

    const entry = `### [2026-02-25] 新记录\n\n- 背景：测试\n\n`;
    const next = insertDecisionEntryIntoLog(updatedDate.next, entry);
    const idxSection = next.indexOf("## 决策记录");
    const idxNew = next.indexOf("### [2026-02-25] 新记录");
    const idxOld = next.indexOf("### [2026-02-19] 旧记录");

    expect(idxSection).toBeGreaterThanOrEqual(0);
    expect(idxNew).toBeGreaterThan(idxSection);
    expect(idxOld).toBeGreaterThan(idxNew);
  });
});
