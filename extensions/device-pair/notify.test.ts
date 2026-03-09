import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listDevicePairingMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/device-pair", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/device-pair")>(
    "openclaw/plugin-sdk/device-pair",
  );
  return {
    ...actual,
    listDevicePairing: listDevicePairingMock,
  };
});

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/device-pair";
import {
  armPairNotifyOnce,
  formatPendingRequests,
  handleNotifyCommand,
  registerPairingNotifierService,
} from "./notify.js";

type RegisteredService = {
  id: string;
  start: (ctx: { stateDir: string }) => Promise<void>;
  stop?: () => Promise<void>;
};

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function resolveNotifyStatePath(stateDir: string): string {
  return path.join(stateDir, "device-pair-notify.json");
}

async function readNotifyState(stateDir: string): Promise<{
  subscribers: Array<{
    to: string;
    accountId?: string;
    messageThreadId?: number;
    mode: "persistent" | "once";
    addedAtMs: number;
  }>;
  notifiedRequestIds: Record<string, number>;
}> {
  const content = await readFile(resolveNotifyStatePath(stateDir), "utf8");
  return JSON.parse(content) as {
    subscribers: Array<{
      to: string;
      accountId?: string;
      messageThreadId?: number;
      mode: "persistent" | "once";
      addedAtMs: number;
    }>;
    notifiedRequestIds: Record<string, number>;
  };
}

function createFakeApi(stateDir: string): {
  api: OpenClawPluginApi;
  logger: ReturnType<typeof createLogger>;
  sendMessageTelegram: ReturnType<typeof vi.fn>;
  getRegisteredService: () => RegisteredService;
} {
  const logger = createLogger();
  const sendMessageTelegram = vi.fn(async () => undefined);
  let registeredService: RegisteredService | null = null;

  const api = {
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
      channel: {
        telegram: {
          sendMessageTelegram,
        },
      },
    },
    logger,
    registerService(service: RegisteredService) {
      registeredService = service;
    },
  } as unknown as OpenClawPluginApi;

  return {
    api,
    logger,
    sendMessageTelegram,
    getRegisteredService: () => {
      if (!registeredService) {
        throw new Error("device-pair notifier service was not registered");
      }
      return registeredService;
    },
  };
}

describe("device-pair notify helpers", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-device-pair-"));
    listDevicePairingMock.mockReset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("formats pending pairing requests", () => {
    expect(formatPendingRequests([])).toBe("No pending device pairing requests.");
    expect(
      formatPendingRequests([
        {
          requestId: "req-1",
          deviceId: "device-1",
          displayName: "Alice iPhone",
          platform: "iOS",
          remoteIp: "203.0.113.5",
        },
      ]),
    ).toBe(
      "Pending device pairing requests:\n- req-1 · name=Alice iPhone · platform=iOS · ip=203.0.113.5",
    );
  });

  it("enables, reports, and disables persistent Telegram notifications", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const { api } = createFakeApi(stateDir);
    listDevicePairingMock.mockResolvedValue({
      pending: [
        { requestId: "req-1", deviceId: "device-1" },
        { requestId: "req-2", deviceId: "device-2" },
      ],
    });

    const ctx = {
      channel: "telegram",
      senderId: "12345",
      accountId: "telegram-main",
      messageThreadId: 77,
    };

    const enabled = await handleNotifyCommand({ api, ctx, action: "on" });
    expect(enabled.text).toContain("notifications enabled");

    const stateAfterEnable = await readNotifyState(stateDir);
    expect(stateAfterEnable.subscribers).toEqual([
      {
        to: "12345",
        accountId: "telegram-main",
        messageThreadId: 77,
        mode: "persistent",
        addedAtMs: new Date("2026-03-09T09:00:00Z").getTime(),
      },
    ]);

    const status = await handleNotifyCommand({ api, ctx, action: "status" });
    expect(status.text).toContain("Pair request notifications: enabled for this chat.");
    expect(status.text).toContain("Mode: persistent");
    expect(status.text).toContain("Subscribers: 1");
    expect(status.text).toContain("Pending requests: 2");

    const disabled = await handleNotifyCommand({ api, ctx, action: "off" });
    expect(disabled.text).toContain("notifications disabled");

    const stateAfterDisable = await readNotifyState(stateDir);
    expect(stateAfterDisable.subscribers).toEqual([]);
    expect(stateAfterDisable.notifiedRequestIds).toEqual({});
  });

  it("rejects notify commands outside Telegram", async () => {
    const { api } = createFakeApi(stateDir);

    const response = await handleNotifyCommand({
      api,
      ctx: { channel: "web", senderId: "user-1" },
      action: "on",
    });

    expect(response).toEqual({
      text: "Pairing notifications are currently supported only on Telegram.",
    });
    await expect(
      armPairNotifyOnce({ api, ctx: { channel: "web", senderId: "user-1" } }),
    ).resolves.toBe(false);
  });

  it("notifies one-shot subscribers for new pairing requests and auto-disables", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T10:00:00Z"));

    const { api, sendMessageTelegram, getRegisteredService } = createFakeApi(stateDir);
    const ctx = {
      channel: "telegram",
      senderId: "12345",
      accountId: "telegram-main",
      messageThreadId: 88,
    };

    await expect(armPairNotifyOnce({ api, ctx })).resolves.toBe(true);

    listDevicePairingMock.mockResolvedValue({
      pending: [
        {
          requestId: "req-new",
          deviceId: "device-1",
          displayName: "Alice iPhone",
          platform: "iOS",
          remoteIp: "203.0.113.5",
          ts: new Date("2026-03-09T10:00:05Z").getTime(),
        },
      ],
    });

    registerPairingNotifierService(api);
    const service = getRegisteredService();
    await service.start({ stateDir });

    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("/pair approve req-new"),
      {
        accountId: "telegram-main",
        messageThreadId: 88,
      },
    );

    const stateAfterNotify = await readNotifyState(stateDir);
    expect(stateAfterNotify.subscribers).toEqual([]);
    expect(stateAfterNotify.notifiedRequestIds).toHaveProperty("req-new");

    await service.stop?.();
  });

  it("does not notify one-shot subscribers for older pending requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T11:00:00Z"));

    const { api, sendMessageTelegram, getRegisteredService } = createFakeApi(stateDir);
    const ctx = {
      channel: "telegram",
      senderId: "12345",
    };

    await expect(armPairNotifyOnce({ api, ctx })).resolves.toBe(true);

    listDevicePairingMock.mockResolvedValue({
      pending: [
        {
          requestId: "req-old",
          deviceId: "device-1",
          ts: new Date("2026-03-09T10:59:30Z").getTime(),
        },
      ],
    });

    registerPairingNotifierService(api);
    const service = getRegisteredService();
    await service.start({ stateDir });

    expect(sendMessageTelegram).not.toHaveBeenCalled();

    const stateAfterPoll = await readNotifyState(stateDir);
    expect(stateAfterPoll.subscribers).toHaveLength(1);
    expect(stateAfterPoll.subscribers[0]?.mode).toBe("once");
    expect(stateAfterPoll.notifiedRequestIds).toEqual({});

    await service.stop?.();
  });
});
