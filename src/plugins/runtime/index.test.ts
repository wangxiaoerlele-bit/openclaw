import { beforeEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../../infra/agent-events.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

import { createPluginRuntime } from "./index.js";

describe("plugin runtime command execution", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockClear();
  });

  it("exposes runtime.system.runCommandWithTimeout by default", async () => {
    const commandResult = {
      stdout: "hello\n",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    };
    runCommandWithTimeoutMock.mockResolvedValue(commandResult);

    const runtime = createPluginRuntime();
    await expect(
      runtime.system.runCommandWithTimeout(["echo", "hello"], { timeoutMs: 1000 }),
    ).resolves.toEqual(commandResult);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["echo", "hello"], { timeoutMs: 1000 });
  });

  it("forwards runtime.system.runCommandWithTimeout errors", async () => {
    runCommandWithTimeoutMock.mockRejectedValue(new Error("boom"));
    const runtime = createPluginRuntime();
    await expect(
      runtime.system.runCommandWithTimeout(["echo", "hello"], { timeoutMs: 1000 }),
    ).rejects.toThrow("boom");
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["echo", "hello"], { timeoutMs: 1000 });
  });

  it("exposes runtime.events listener registration helpers", () => {
    const runtime = createPluginRuntime();
    expect(runtime.events.onAgentEvent).toBe(onAgentEvent);
    expect(runtime.events.onSessionTranscriptUpdate).toBe(onSessionTranscriptUpdate);
  });

  it("keeps the top-level runtime shape stable across internal splits", () => {
    const runtime = createPluginRuntime();
    expect(Object.keys(runtime).toSorted()).toEqual([
      "channel",
      "config",
      "events",
      "logging",
      "media",
      "state",
      "stt",
      "subagent",
      "system",
      "tools",
      "tts",
      "version",
    ]);
    expect(Object.keys(runtime.subagent).toSorted()).toEqual([
      "deleteSession",
      "getSession",
      "getSessionMessages",
      "run",
      "waitForRun",
    ]);
  });

  it("exposes runtime.system.requestHeartbeatNow", () => {
    const runtime = createPluginRuntime();
    expect(runtime.system.requestHeartbeatNow).toBe(requestHeartbeatNow);
  });

  it("throws for subagent methods when no gateway request scope is available", async () => {
    const runtime = createPluginRuntime();
    expect(() =>
      runtime.subagent.run({
        sessionKey: "session-1",
        message: "hello",
      }),
    ).toThrow("Plugin runtime subagent methods are only available during a gateway request.");
  });

  it("uses injected subagent runtime when provided", async () => {
    const subagent = {
      run: vi.fn().mockResolvedValue({ runId: "run-1" }),
      waitForRun: vi.fn().mockResolvedValue({ status: "ok" as const }),
      getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
      getSession: vi.fn().mockResolvedValue({ messages: [] }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };

    const runtime = createPluginRuntime({ subagent });
    await expect(
      runtime.subagent.run({
        sessionKey: "session-2",
        message: "hi",
      }),
    ).resolves.toEqual({ runId: "run-1" });
    expect(subagent.run).toHaveBeenCalledWith({
      sessionKey: "session-2",
      message: "hi",
    });
  });
});
