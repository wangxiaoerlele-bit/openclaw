import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyQueuedPersonalMemorySuggestion,
  dismissPersonalMemorySuggestion,
  enqueuePersonalMemorySuggestion,
  listPersonalMemorySuggestions,
  prunePersonalMemorySuggestionQueue,
} from "./suggestion-queue.js";

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
    path.join(baseDir, "04-decision-log.md"),
    `# 04 Decision Log

- 最后更新日期： 2026-02-25

## 决策记录

### [YYYY-MM-DD] 决策标题

- 背景：
`,
  );
}

function l2Suggestion(title = "测试写回"): {
  level: "L2";
  target: "decision-log";
  reason: string;
  structured: Record<string, string>;
} {
  return {
    level: "L2",
    target: "decision-log",
    reason: "需要持久化",
    structured: {
      date: "2026-02-28",
      title,
      background: "背景",
      decision: "决策",
      reason: "原因",
    },
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

describe("personal-memory suggestion queue", () => {
  it("queues non-L0 suggestions and dedupes by fingerprint", () => {
    const dir = makeTempDir("openclaw-pmsq-");
    seedPersonalContext(dir);
    const first = enqueuePersonalMemorySuggestion({
      personalContextDir: dir,
      suggestion: l2Suggestion("确认接入路径"),
      source: { runId: "run-1", sessionKey: "s1", channel: "feishu" },
    });
    expect(first.queued).toBe(true);
    const second = enqueuePersonalMemorySuggestion({
      personalContextDir: dir,
      suggestion: l2Suggestion("确认接入路径"),
      source: { runId: "run-2", sessionKey: "s2", channel: "web-gui" },
    });
    expect(second.queued).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    const listed = listPersonalMemorySuggestions({ personalContextDir: dir, status: "all" });
    expect(listed.items).toHaveLength(1);
  });

  it("applies queued L2 suggestion by id and marks item applied", () => {
    const dir = makeTempDir("openclaw-pmsq-");
    seedPersonalContext(dir);
    const queued = enqueuePersonalMemorySuggestion({
      personalContextDir: dir,
      suggestion: l2Suggestion("通过队列写入"),
    });

    const applied = applyQueuedPersonalMemorySuggestion({
      personalContextDir: dir,
      id: queued.item.id,
    });
    expect(applied.applyResult.applied || applied.applyResult.alreadyExists).toBe(true);
    expect(applied.item.status).toBe("applied");
    const logText = fs.readFileSync(path.join(dir, "04-decision-log.md"), "utf8");
    expect(logText).toContain("### [2026-02-28] 通过队列写入");
  });

  it("dismisses and prunes queue entries", () => {
    const dir = makeTempDir("openclaw-pmsq-");
    seedPersonalContext(dir);
    const queued = enqueuePersonalMemorySuggestion({
      personalContextDir: dir,
      suggestion: l2Suggestion("稍后处理"),
      now: () => new Date("2026-02-01T00:00:00.000Z"),
    });
    const dismissed = dismissPersonalMemorySuggestion({
      personalContextDir: dir,
      id: queued.item.id,
      now: () => new Date("2026-02-01T01:00:00.000Z"),
    });
    expect(dismissed.status).toBe("dismissed");
    const pruned = prunePersonalMemorySuggestionQueue({
      personalContextDir: dir,
      retainDismissedDays: 1,
      now: () => new Date("2026-02-05T00:00:00.000Z"),
    });
    expect(pruned.removed).toBe(1);
  });
});
