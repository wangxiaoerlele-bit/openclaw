import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginSdkMocks = vi.hoisted(() => ({
  applyQueuedPersonalMemorySuggestion: vi.fn(),
  dismissPersonalMemorySuggestion: vi.fn(),
  PersonalMemorySuggestionQueueError: class PersonalMemorySuggestionQueueError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "PersonalMemorySuggestionQueueError";
    }
  },
}));

vi.mock("openclaw/plugin-sdk", () => pluginSdkMocks);

import {
  buildFeishuPersonalMemorySuggestionActionCard,
  extractFeishuPersonalMemorySuggestionActionPayload,
  handleFeishuPersonalMemoryCardAction,
} from "./memory-suggestion-actions.js";

describe("feishu personal-memory suggestion actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function withPersonalContextCwd(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-memory-actions-"));
    fs.mkdirSync(path.join(dir, "personal-context"), { recursive: true });
    return dir;
  }

  it("extracts channelData payload for personal-memory suggestion cards", () => {
    const payload = extractFeishuPersonalMemorySuggestionActionPayload({
      feishu: {
        personalMemorySuggestionAction: {
          queueId: "pms_abc123",
          level: "L2",
          target: "decision-log",
          title: "确认方案",
          reason: "测试",
          canApply: true,
        },
      },
    });

    expect(payload).toEqual({
      queueId: "pms_abc123",
      level: "L2",
      target: "decision-log",
      title: "确认方案",
      reason: "测试",
      canApply: true,
    });
  });

  it("builds an interactive card with apply and dismiss buttons", () => {
    const card = buildFeishuPersonalMemorySuggestionActionCard({
      payload: {
        queueId: "pms_abc123",
        level: "L2",
        target: "decision-log",
        canApply: true,
      },
      accountId: "main",
    }) as { schema?: string; elements?: Array<Record<string, unknown>> };

    expect(card.schema).toBeUndefined();
    const actionBlock = card.elements?.find((el) => el.tag === "action") as
      | { actions?: Array<{ value?: Record<string, unknown> }> }
      | undefined;
    expect(actionBlock?.actions).toHaveLength(2);
    expect(actionBlock?.actions?.[0]?.value).toMatchObject({
      oc_action: "personal_memory_suggestion",
      op: "apply",
      queueId: "pms_abc123",
      accountId: "main",
    });
  });

  it("handles dismiss card action by updating suggestion queue", async () => {
    pluginSdkMocks.dismissPersonalMemorySuggestion.mockReturnValue({
      id: "pms_abc123",
      status: "dismissed",
    });
    vi.spyOn(process, "cwd").mockReturnValue(withPersonalContextCwd());

    const result = await handleFeishuPersonalMemoryCardAction({
      cfg: {} as never,
      accountId: "main",
      runtime: {} as never,
      event: {
        action: {
          value: {
            oc_action: "personal_memory_suggestion",
            op: "dismiss",
            queueId: "pms_abc123",
            accountId: "main",
          },
        },
      },
    });

    expect(pluginSdkMocks.dismissPersonalMemorySuggestion).toHaveBeenCalled();
    expect(result).toEqual({
      toast: { type: "success", content: "已忽略记忆建议：pms_abc123" },
    });
  });

  it("handles apply card action by applying queue suggestion", async () => {
    pluginSdkMocks.applyQueuedPersonalMemorySuggestion.mockReturnValue({
      item: { id: "pms_abc123", suggestion: { title: "确认方案" } },
      applyResult: { applied: true, alreadyExists: false, title: "确认方案" },
    });
    vi.spyOn(process, "cwd").mockReturnValue(withPersonalContextCwd());

    const result = await handleFeishuPersonalMemoryCardAction({
      cfg: {} as never,
      accountId: "main",
      runtime: {} as never,
      event: {
        event: {
          action: {
            value: {
              oc_action: "personal_memory_suggestion",
              op: "apply",
              queueId: "pms_abc123",
              accountId: "main",
            },
          },
        },
      },
    });

    expect(pluginSdkMocks.applyQueuedPersonalMemorySuggestion).toHaveBeenCalled();
    expect(result).toEqual({
      toast: { type: "success", content: "已应用记忆建议：确认方案" },
    });
  });

  it("handles websocket-wrapped card action payloads", async () => {
    pluginSdkMocks.dismissPersonalMemorySuggestion.mockReturnValue({
      id: "pms_ws_001",
      status: "dismissed",
    });
    vi.spyOn(process, "cwd").mockReturnValue(withPersonalContextCwd());

    const result = await handleFeishuPersonalMemoryCardAction({
      cfg: {} as never,
      accountId: "main",
      runtime: {} as never,
      event: {
        data: {
          event_callback: {
            event: {
              action: {
                value: JSON.stringify({
                  oc_action: "personal_memory_suggestion",
                  op: "dismiss",
                  queueId: "pms_ws_001",
                  accountId: "main",
                }),
              },
            },
          },
        },
      },
    });

    expect(pluginSdkMocks.dismissPersonalMemorySuggestion).toHaveBeenCalled();
    expect(result).toEqual({
      toast: { type: "success", content: "已忽略记忆建议：pms_ws_001" },
    });
  });
});
