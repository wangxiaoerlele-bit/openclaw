import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";

const { chatHandlers } = await import("./chat.js");

function createPersonalContextFixture(): { rootDir: string; filePath: string } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-memory-"));
  const personalDir = path.join(rootDir, "personal-context");
  fs.mkdirSync(personalDir, { recursive: true });
  const filePath = path.join(personalDir, "04-decision-log.md");
  fs.writeFileSync(
    filePath,
    [
      "# 决策日志",
      "",
      "- 最后更新日期：2026-02-25",
      "",
      "## 决策记录",
      "",
      "### [YYYY-MM-DD] 决策标题",
      "",
      "- 背景：...",
    ].join("\n"),
    "utf8",
  );
  return { rootDir, filePath };
}

function createContext(): Pick<GatewayRequestContext, "logGateway"> {
  return {
    logGateway: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as GatewayRequestContext["logGateway"],
  };
}

function buildSuggestion() {
  return {
    level: "L2",
    target: "decision-log",
    reason: "需要持久化",
    structured: {
      date: "2026-02-26",
      title: "网关确认写回",
      background: "背景",
      decision: "决策",
      reason: "原因",
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chatHandlers memory.applySuggestion", () => {
  it("returns dry-run preview without mutating decision-log", async () => {
    const { rootDir, filePath } = createPersonalContextFixture();
    const before = fs.readFileSync(filePath, "utf8");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(rootDir);
    void cwdSpy;
    const respond = vi.fn();

    await chatHandlers["memory.applySuggestion"]({
      req: {} as never,
      params: { suggestion: buildSuggestion(), dryRun: true },
      respond: respond as never,
      client: null,
      isWebchatConnect: () => false,
      context: createContext() as GatewayRequestContext,
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      dryRun: true,
      target: "decision-log",
      title: "网关确认写回",
    });
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });

  it("applies L2 suggestion to local personal-context decision-log", async () => {
    const { rootDir, filePath } = createPersonalContextFixture();
    vi.spyOn(process, "cwd").mockReturnValue(rootDir);
    const respond = vi.fn();

    await chatHandlers["memory.applySuggestion"]({
      req: {} as never,
      params: { suggestion: buildSuggestion() },
      respond: respond as never,
      client: null,
      isWebchatConnect: () => false,
      context: createContext() as GatewayRequestContext,
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      dryRun: false,
      title: "网关确认写回",
    });
    const next = fs.readFileSync(filePath, "utf8");
    expect(next).toContain("### [2026-02-26] 网关确认写回");
  });

  it("rejects non-L2 suggestion payloads", async () => {
    const { rootDir } = createPersonalContextFixture();
    vi.spyOn(process, "cwd").mockReturnValue(rootDir);
    const respond = vi.fn();

    await chatHandlers["memory.applySuggestion"]({
      req: {} as never,
      params: {
        suggestion: { level: "L1", target: "projects", reason: "x" },
      },
      respond: respond as never,
      client: null,
      isWebchatConnect: () => false,
      context: createContext() as GatewayRequestContext,
    });

    const [ok, payload, error] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({ code: expect.any(String) });
  });

  it("lists/applies/dismisses queued suggestions via gateway methods", async () => {
    const { rootDir, filePath } = createPersonalContextFixture();
    const queuePath = path.join(rootDir, "personal-context", ".personal-memory.suggestions.json");
    fs.writeFileSync(
      queuePath,
      JSON.stringify(
        {
          version: 1,
          items: [
            {
              id: "pms_gateway_a",
              createdAt: "2026-02-26T00:00:00.000Z",
              updatedAt: "2026-02-26T00:00:00.000Z",
              status: "pending",
              fingerprint: "fpa",
              source: { channel: "web-gui", runId: "r1", sessionKey: "s1" },
              suggestion: buildSuggestion(),
            },
            {
              id: "pms_gateway_b",
              createdAt: "2026-02-26T01:00:00.000Z",
              updatedAt: "2026-02-26T01:00:00.000Z",
              status: "pending",
              fingerprint: "fpb",
              source: { channel: "feishu", runId: "r2", sessionKey: "s2" },
              suggestion: { level: "L1", target: "projects", reason: "later" },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    vi.spyOn(process, "cwd").mockReturnValue(rootDir);
    const context = createContext() as GatewayRequestContext;

    const respondList = vi.fn();
    await chatHandlers["memory.suggestions.list"]({
      req: {} as never,
      params: { status: "pending", limit: 10 },
      respond: respondList as never,
      client: null,
      isWebchatConnect: () => false,
      context,
    });
    const [listOk, listPayload] = respondList.mock.calls.at(-1) ?? [];
    expect(listOk).toBe(true);
    expect(listPayload.items).toHaveLength(2);

    const respondApply = vi.fn();
    await chatHandlers["memory.suggestions.apply"]({
      req: {} as never,
      params: { id: "pms_gateway_a" },
      respond: respondApply as never,
      client: null,
      isWebchatConnect: () => false,
      context,
    });
    const [applyOk, applyPayload] = respondApply.mock.calls.at(-1) ?? [];
    expect(applyOk).toBe(true);
    expect(applyPayload.item.status).toBe("applied");
    expect(fs.readFileSync(filePath, "utf8")).toContain("### [2026-02-26] 网关确认写回");

    const respondDismiss = vi.fn();
    await chatHandlers["memory.suggestions.dismiss"]({
      req: {} as never,
      params: { id: "pms_gateway_b" },
      respond: respondDismiss as never,
      client: null,
      isWebchatConnect: () => false,
      context,
    });
    const [dismissOk, dismissPayload] = respondDismiss.mock.calls.at(-1) ?? [];
    expect(dismissOk).toBe(true);
    expect(dismissPayload.status).toBe("dismissed");
  });
});
