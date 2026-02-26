import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

type AbortResult = { handled: boolean; aborted: boolean; stoppedSubagents?: number };

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
  tryFastAbortFromMessage: vi.fn<() => Promise<AbortResult>>(async () => ({
    handled: false,
    aborted: false,
  })),
}));
const diagnosticMocks = vi.hoisted(() => ({
  logMessageQueued: vi.fn(),
  logMessageProcessed: vi.fn(),
  logSessionStateChange: vi.fn(),
}));
const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runMessageReceived: vi.fn(async () => {}),
  },
}));
const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));
const personalMemoryMocks = vi.hoisted(() => ({
  runPersonalMemoryPreHook: vi.fn(async (params: { bodyForAgent: string }) => ({
    bodyForAgent: params.bodyForAgent,
  })),
  emitPersonalMemoryPostSuggestion: vi.fn(),
  emitPersonalMemoryPostSuggestionDetailed: vi.fn(() => ({
    suggestion: { level: "L0", reason: "no-op" },
  })),
  inferPersonalMemoryTaskKindFromText: vi.fn(() => "unknown"),
  inferPersonalMemoryUserConfirmedFromText: vi.fn(() => false),
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) =>
    Boolean(
      channel &&
      ["telegram", "slack", "discord", "signal", "imessage", "whatsapp"].includes(channel),
    ),
  routeReply: mocks.routeReply,
}));

vi.mock("./abort.js", () => ({
  tryFastAbortFromMessage: mocks.tryFastAbortFromMessage,
  formatAbortReplyText: (stoppedSubagents?: number) => {
    if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
      return "⚙️ Agent was aborted.";
    }
    const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
    return `⚙️ Agent was aborted. Stopped ${stoppedSubagents} ${label}.`;
  },
}));

vi.mock("../../logging/diagnostic.js", () => ({
  logMessageQueued: diagnosticMocks.logMessageQueued,
  logMessageProcessed: diagnosticMocks.logMessageProcessed,
  logSessionStateChange: diagnosticMocks.logSessionStateChange,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: internalHookMocks.createInternalHookEvent,
  triggerInternalHook: internalHookMocks.triggerInternalHook,
}));
vi.mock("../../personal-memory/runtime-hooks.js", () => ({
  runPersonalMemoryPreHook: personalMemoryMocks.runPersonalMemoryPreHook,
  emitPersonalMemoryPostSuggestion: personalMemoryMocks.emitPersonalMemoryPostSuggestion,
  emitPersonalMemoryPostSuggestionDetailed:
    personalMemoryMocks.emitPersonalMemoryPostSuggestionDetailed,
  inferPersonalMemoryTaskKindFromText: personalMemoryMocks.inferPersonalMemoryTaskKindFromText,
  inferPersonalMemoryUserConfirmedFromText:
    personalMemoryMocks.inferPersonalMemoryUserConfirmedFromText,
}));

const { dispatchReplyFromConfig } = await import("./dispatch-from-config.js");
const { resetInboundDedupe } = await import("./inbound-dedupe.js");

const noAbortResult = { handled: false, aborted: false } as const;
const emptyConfig = {} as OpenClawConfig;
type DispatchReplyArgs = Parameters<typeof dispatchReplyFromConfig>[0];

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

function createPersonalContextCwdFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dispatch-memory-"));
  fs.mkdirSync(path.join(dir, "personal-context"), { recursive: true });
  return dir;
}

function seedDecisionLogForDispatchFixture(cwdDir: string) {
  fs.writeFileSync(
    path.join(cwdDir, "personal-context", "04-decision-log.md"),
    `# 04 Decision Log

- 最后更新日期： 2026-02-25

## 决策记录

### [2026-02-25] 基线记录

- 背景：A
- 决策：B
- 原因：C
`,
    "utf8",
  );
}

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

function firstToolResultPayload(dispatcher: ReplyDispatcher): ReplyPayload | undefined {
  return (dispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
    | ReplyPayload
    | undefined;
}

async function dispatchTwiceWithFreshDispatchers(params: Omit<DispatchReplyArgs, "dispatcher">) {
  await dispatchReplyFromConfig({
    ...params,
    dispatcher: createDispatcher(),
  });
  await dispatchReplyFromConfig({
    ...params,
    dispatcher: createDispatcher(),
  });
}

describe("dispatchReplyFromConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    resetInboundDedupe();
    diagnosticMocks.logMessageQueued.mockClear();
    diagnosticMocks.logMessageProcessed.mockClear();
    diagnosticMocks.logSessionStateChange.mockClear();
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageReceived.mockClear();
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockClear();
    personalMemoryMocks.runPersonalMemoryPreHook.mockClear();
    personalMemoryMocks.emitPersonalMemoryPostSuggestion.mockClear();
    personalMemoryMocks.emitPersonalMemoryPostSuggestionDetailed.mockClear();
    personalMemoryMocks.inferPersonalMemoryTaskKindFromText.mockClear();
    personalMemoryMocks.inferPersonalMemoryUserConfirmedFromText.mockClear();
    personalMemoryMocks.runPersonalMemoryPreHook.mockImplementation(
      async (params: { bodyForAgent: string }) => ({ bodyForAgent: params.bodyForAgent }),
    );
    personalMemoryMocks.inferPersonalMemoryTaskKindFromText.mockReturnValue("unknown");
    personalMemoryMocks.inferPersonalMemoryUserConfirmedFromText.mockReturnValue(false);
  });
  it("does not route when Provider matches OriginatingChannel (even if Surface is missing)", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: undefined,
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("routes when OriginatingChannel differs from Provider", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      AccountId: "acc-1",
      MessageThreadId: 123,
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:999",
        accountId: "acc-1",
        threadId: 123,
      }),
    );
  });

  it("runs shared personal-memory pre/post hooks for feishu messages", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const cwdDir = createPersonalContextCwdFixture();
    vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
    const ctx = buildTestCtx({
      Provider: "feishu",
      Surface: "feishu",
      SessionKey: "feishu-main",
      BodyForAgent: "今天天气怎么样",
      BodyForCommands: "今天天气怎么样",
      RawBody: "今天天气怎么样",
      Body: "今天天气怎么样",
      MessageSid: "msg-1",
    });

    const replyResolver = async () => ({ text: "晴天" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { runId: "run-feishu-1" },
    });

    expect(personalMemoryMocks.runPersonalMemoryPreHook).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-feishu-1",
        sessionKey: "feishu-main",
        channel: "feishu",
      }),
    );
    expect(personalMemoryMocks.emitPersonalMemoryPostSuggestionDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-feishu-1",
        sessionKey: "feishu-main",
        input: expect.objectContaining({
          channel: "feishu",
          summary: "晴天",
        }),
      }),
    );
  });

  it("handles external inline memory queue list command without invoking agent reply", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const cwdDir = createPersonalContextCwdFixture();
    vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
    fs.writeFileSync(
      path.join(cwdDir, "personal-context", ".personal-memory.suggestions.json"),
      JSON.stringify(
        {
          version: 1,
          items: [
            {
              id: "pms_test_list",
              createdAt: "2026-02-26T00:00:00.000Z",
              updatedAt: "2026-02-26T00:00:00.000Z",
              status: "pending",
              fingerprint: "fp1",
              source: { channel: "feishu" },
              suggestion: {
                level: "L1",
                target: "current-focus",
                reason: "测试",
                title: "更新当前重点",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const ctx = buildTestCtx({
      Provider: "feishu",
      Surface: "feishu",
      SessionKey: "feishu-main",
      ChatType: "direct",
      BodyForAgent: "记忆建议 列表",
      BodyForCommands: "记忆建议 列表",
      RawBody: "记忆建议 列表",
      Body: "记忆建议 列表",
      MessageSid: "msg-list-1",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) as ReplyPayload);

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(personalMemoryMocks.runPersonalMemoryPreHook).not.toHaveBeenCalled();
    expect(personalMemoryMocks.emitPersonalMemoryPostSuggestionDetailed).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("pms_test_list"),
      }),
    );
  });

  it("handles external inline memory queue apply command and writes decision-log", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const cwdDir = createPersonalContextCwdFixture();
    vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
    seedDecisionLogForDispatchFixture(cwdDir);
    fs.writeFileSync(
      path.join(cwdDir, "personal-context", ".personal-memory.suggestions.json"),
      JSON.stringify(
        {
          version: 1,
          items: [
            {
              id: "pms_test_apply",
              createdAt: "2026-02-26T00:00:00.000Z",
              updatedAt: "2026-02-26T00:00:00.000Z",
              status: "pending",
              fingerprint: "fp_apply",
              source: { channel: "feishu" },
              suggestion: {
                level: "L2",
                target: "decision-log",
                reason: "测试",
                structured: {
                  date: "2026-02-26",
                  title: "通过消息内命令应用建议",
                  background: "验证外部渠道消息内确认闭环",
                  decision: "支持文本命令 apply",
                  reason: "无需切到 CLI",
                },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const ctx = buildTestCtx({
      Provider: "feishu",
      Surface: "feishu",
      SessionKey: "feishu-main",
      ChatType: "direct",
      BodyForAgent: "记忆应用 pms_test_apply",
      BodyForCommands: "记忆应用 pms_test_apply",
      RawBody: "记忆应用 pms_test_apply",
      Body: "记忆应用 pms_test_apply",
      MessageSid: "msg-apply-1",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) as ReplyPayload);

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("记忆建议已应用"),
      }),
    );
    const queueText = fs.readFileSync(
      path.join(cwdDir, "personal-context", ".personal-memory.suggestions.json"),
      "utf8",
    );
    expect(queueText).toContain('"status": "applied"');
    const logText = fs.readFileSync(
      path.join(cwdDir, "personal-context", "04-decision-log.md"),
      "utf8",
    );
    expect(logText).toContain("### [2026-02-26] 通过消息内命令应用建议");
  });

  it("passes userConfirmed=true to post hook for explicit decision confirmation messages", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const cwdDir = createPersonalContextCwdFixture();
    vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
    personalMemoryMocks.inferPersonalMemoryTaskKindFromText.mockReturnValue("decision-review");
    personalMemoryMocks.inferPersonalMemoryUserConfirmedFromText.mockReturnValue(true);
    const ctx = buildTestCtx({
      Provider: "feishu",
      Surface: "feishu",
      SessionKey: "feishu-main",
      BodyForAgent:
        "我确认采用这个方案，请记录决策\n决策标题：确认 personal-memory 方案\n背景：需要降低返工\n决策：先接入确认识别\n原因：这样才能在 Feishu 触发 L2\n下一步：验证 apply 闭环",
      BodyForCommands:
        "我确认采用这个方案，请记录决策\n决策标题：确认 personal-memory 方案\n背景：需要降低返工\n决策：先接入确认识别\n原因：这样才能在 Feishu 触发 L2\n下一步：验证 apply 闭环",
      RawBody:
        "我确认采用这个方案，请记录决策\n决策标题：确认 personal-memory 方案\n背景：需要降低返工\n决策：先接入确认识别\n原因：这样才能在 Feishu 触发 L2\n下一步：验证 apply 闭环",
      Body: "我确认采用这个方案，请记录决策\n决策标题：确认 personal-memory 方案\n背景：需要降低返工\n决策：先接入确认识别\n原因：这样才能在 Feishu 触发 L2\n下一步：验证 apply 闭环",
      MessageSid: "msg-confirm-1",
    });

    const replyResolver = async () => ({ text: "已确认，给出实施步骤" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { runId: "run-feishu-confirm-1" },
    });

    expect(personalMemoryMocks.inferPersonalMemoryUserConfirmedFromText).toHaveBeenCalledWith(
      expect.stringContaining("我确认采用这个方案，请记录决策"),
    );
    expect(personalMemoryMocks.emitPersonalMemoryPostSuggestionDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          taskKind: "decision-review",
          userConfirmed: true,
          decisionTitle: "确认 personal-memory 方案",
          background: "需要降低返工",
          decision: "先接入确认识别",
          reason: "这样才能在 Feishu 触发 L2",
          next: "验证 apply 闭环",
        }),
      }),
    );
  });

  it("queues Feishu native suggestion action payload when post hook returns a queue id", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const cwdDir = createPersonalContextCwdFixture();
    vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
    personalMemoryMocks.emitPersonalMemoryPostSuggestionDetailed.mockReturnValueOnce({
      suggestion: {
        level: "L2",
        target: "decision-log",
        reason: "confirmed decision",
        title: "确认 personal-memory 方案",
        structured: { title: "确认 personal-memory 方案" },
      },
      queueId: "pms_test_001",
      commitCommand: "pnpm memory:add-decision ...",
    } as unknown as {
      suggestion: {
        level: string;
        reason: string;
        target?: string;
        title?: string;
        structured?: Record<string, string>;
      };
      queueId: string;
      commitCommand: string;
    });
    const ctx = buildTestCtx({
      Provider: "feishu",
      Surface: "feishu",
      ChatType: "direct",
      SessionKey: "feishu-main",
      BodyForAgent: "我确认采用这个方案",
      BodyForCommands: "我确认采用这个方案",
      RawBody: "我确认采用这个方案",
      Body: "我确认采用这个方案",
      MessageSid: "msg-confirm-card-1",
    });

    const replyResolver = async () => ({ text: "已确认，给出实施步骤" }) satisfies ReplyPayload;
    const result = await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { runId: "run-feishu-confirm-card-1" },
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("pms_test_001"),
        channelData: {
          feishu: {
            personalMemorySuggestionAction: expect.objectContaining({
              queueId: "pms_test_001",
              level: "L2",
              target: "decision-log",
              canApply: true,
            }),
          },
        },
      }),
    );
    expect(result.counts.final).toBe(1);
  });

  it("does not run personal-memory hooks for mapped channels unless enabled in settings", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const cwdDir = createPersonalContextCwdFixture();
    vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      SessionKey: "tg-main",
      BodyForAgent: "帮我梳理今天的工作重点",
      BodyForCommands: "帮我梳理今天的工作重点",
      RawBody: "帮我梳理今天的工作重点",
      Body: "帮我梳理今天的工作重点",
      MessageSid: "tg-msg-1",
    });

    const replyResolver = async () => ({ text: "收到" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { runId: "run-tg-1" },
    });

    expect(personalMemoryMocks.runPersonalMemoryPreHook).not.toHaveBeenCalled();
    expect(personalMemoryMocks.emitPersonalMemoryPostSuggestionDetailed).not.toHaveBeenCalled();
  });

  it("skips shared personal-memory hooks for webchat slash commands", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const cwdDir = createPersonalContextCwdFixture();
    vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      SessionKey: "main",
      BodyForAgent: "/help",
      BodyForCommands: "/help",
      RawBody: "/help",
      Body: "/help",
      MessageSid: "msg-web-1",
    });

    const replyResolver = async () => ({ text: "ok" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { runId: "run-web-1" },
    });

    expect(personalMemoryMocks.runPersonalMemoryPreHook).not.toHaveBeenCalled();
    expect(personalMemoryMocks.emitPersonalMemoryPostSuggestionDetailed).not.toHaveBeenCalled();
  });

  it("uses RawBody for webchat personal-memory classification when BodyForCommands injects /think", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const cwdDir = createPersonalContextCwdFixture();
    vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      SessionKey: "main",
      BodyForAgent: "请帮我规划下周安排",
      BodyForCommands: "/think low 请帮我规划下周安排",
      RawBody: "请帮我规划下周安排",
      Body: "请帮我规划下周安排",
      MessageSid: "msg-web-think-1",
    });

    const replyResolver = async () => ({ text: "好的，我来规划" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { runId: "run-web-think-1" },
    });

    expect(personalMemoryMocks.runPersonalMemoryPreHook).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "web-gui",
        messageText: "请帮我规划下周安排",
      }),
    );
  });

  it("routes media-only tool results when summaries are suppressed", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      ChatType: "group",
      AccountId: "acc-1",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      await opts?.onToolResult?.({
        text: "NO_REPLY",
        mediaUrls: ["https://example.com/tts-routed.opus"],
      });
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledTimes(1);
    const routed = mocks.routeReply.mock.calls[0]?.[0] as { payload?: ReplyPayload } | undefined;
    expect(routed?.payload?.mediaUrls).toEqual(["https://example.com/tts-routed.opus"]);
    expect(routed?.payload?.text).toBeUndefined();
  });

  it("provides onToolResult in DM sessions", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      expect(typeof opts?.onToolResult).toBe("function");
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses group tool summaries but still forwards tool media", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "group",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      await opts?.onToolResult?.({
        text: "NO_REPLY",
        mediaUrls: ["https://example.com/tts-group.opus"],
      });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    const sent = firstToolResultPayload(dispatcher);
    expect(sent?.mediaUrls).toEqual(["https://example.com/tts-group.opus"]);
    expect(sent?.text).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("sends tool results via dispatcher in DM sessions", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      // Simulate tool result emission
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ text: "🔧 exec: ls" }),
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses native tool summaries but still forwards tool media", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      CommandSource: "native",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      await opts?.onToolResult?.({ text: "🔧 tools/sessions_send" });
      await opts?.onToolResult?.({
        mediaUrl: "https://example.com/tts-native.opus",
      });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    const sent = firstToolResultPayload(dispatcher);
    expect(sent?.mediaUrl).toBe("https://example.com/tts-native.opus");
    expect(sent?.text).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("fast-aborts without calling the reply resolver", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
    });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Body: "/stop",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted.",
    });
  });

  it("fast-abort reply includes stopped subagent count when provided", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
      stoppedSubagents: 2,
    });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Body: "/stop",
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver: vi.fn(async () => ({ text: "hi" }) as ReplyPayload),
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted. Stopped 2 sub-agents.",
    });
  });

  it("deduplicates inbound messages by MessageSid and origin", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      MessageSid: "msg-1",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchTwiceWithFreshDispatchers({
      ctx,
      cfg,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("emits message_received hook with originating channel metadata", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "Telegram",
      OriginatingTo: "telegram:999",
      CommandBody: "/search hello",
      RawBody: "raw text",
      Body: "body text",
      Timestamp: 1710000000000,
      MessageSidFull: "sid-full",
      SenderId: "user-1",
      SenderName: "Alice",
      SenderUsername: "alice",
      SenderE164: "+15555550123",
      AccountId: "acc-1",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(hookMocks.runner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        from: ctx.From,
        content: "/search hello",
        timestamp: 1710000000000,
        metadata: expect.objectContaining({
          originatingChannel: "Telegram",
          originatingTo: "telegram:999",
          messageId: "sid-full",
          senderId: "user-1",
          senderName: "Alice",
          senderUsername: "alice",
          senderE164: "+15555550123",
        }),
      }),
      expect.objectContaining({
        channelId: "telegram",
        accountId: "acc-1",
        conversationId: "telegram:999",
      }),
    );
  });

  it("emits internal message:received hook when a session key is available", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      SessionKey: "agent:main:main",
      CommandBody: "/help",
      MessageSid: "msg-42",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      "agent:main:main",
      expect.objectContaining({
        from: ctx.From,
        content: "/help",
        channelId: "telegram",
        messageId: "msg-42",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("skips internal message:received hook when session key is unavailable", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      CommandBody: "/help",
    });
    (ctx as MsgContext).SessionKey = undefined;

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("emits diagnostics when enabled", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      SessionKey: "agent:main:main",
      MessageSid: "msg-1",
      To: "slack:C123",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logSessionStateChange).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      state: "processing",
      reason: "message_start",
    });
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        outcome: "completed",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("marks diagnostics skipped for duplicate inbound messages", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      MessageSid: "msg-dup",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchTwiceWithFreshDispatchers({
      ctx,
      cfg,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        outcome: "skipped",
        reason: "duplicate",
      }),
    );
  });
});
