import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskService } from "./service.js";
import { loadTaskStore } from "./store.js";

const requestHeartbeatNowMock = vi.fn();
const enqueueSystemEventMock = vi.fn();
const runTaskWorkerTurnMock = vi.fn();

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("./worker.js", () => ({
  runTaskWorkerTurn: (...args: unknown[]) => runTaskWorkerTurnMock(...args),
}));

describe("TaskService", () => {
  beforeEach(() => {
    requestHeartbeatNowMock.mockClear();
    enqueueSystemEventMock.mockClear();
    runTaskWorkerTurnMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a task and marks it completed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tasks-"));
    const storePath = path.join(dir, "tasks.json");
    runTaskWorkerTurnMock.mockResolvedValueOnce({
      status: "completed",
      update: "群闭环已经验收完成。",
      evidence: ["群里已收到正确回复"],
      sideEffects: 1,
    });
    const service = new TaskService({
      loadConfig: () => ({}) as never,
      deps: {} as never,
      storePath,
    });

    await service.start();
    await service.create({
      agentId: "main",
      originSessionKey: "agent:main:feishu:direct:test",
      goal: "完成飞书群闭环验收",
      acceptance: ["群里收到正确回复"],
    });

    await vi.waitFor(async () => {
      const store = await loadTaskStore(storePath);
      expect(store.tasks[0]?.status).toBe("completed");
    });

    expect(runTaskWorkerTurnMock).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("[持续任务完成]"),
      expect.objectContaining({
        sessionKey: "agent:main:feishu:direct:test",
      }),
    );
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:feishu:direct:test",
      }),
    );

    service.stop();
  });

  it("keeps later tasks queued while the first task is waiting on external work", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tasks-"));
    const storePath = path.join(dir, "tasks.json");
    runTaskWorkerTurnMock.mockResolvedValueOnce({
      status: "waiting_external",
      update: "还缺一个外部权限确认。",
      blocker: "等待老板确认权限",
      evidence: [],
      sideEffects: 0,
    });
    const service = new TaskService({
      loadConfig: () => ({}) as never,
      deps: {} as never,
      storePath,
    });

    await service.start();
    await service.create({
      agentId: "main",
      originSessionKey: "session-a",
      goal: "任务 A",
      acceptance: ["完成 A"],
    });
    await service.create({
      agentId: "main",
      originSessionKey: "session-b",
      goal: "任务 B",
      acceptance: ["完成 B"],
    });

    await vi.waitFor(async () => {
      const store = await loadTaskStore(storePath);
      expect(store.tasks[0]?.status).toBe("waiting_external");
    });

    const store = await loadTaskStore(storePath);
    expect(runTaskWorkerTurnMock).toHaveBeenCalledTimes(1);
    expect(store.tasks[1]?.status).toBe("queued");

    service.stop();
  });
});
