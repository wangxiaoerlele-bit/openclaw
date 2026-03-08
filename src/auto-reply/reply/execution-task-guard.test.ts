import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTaskAcceptedText } from "../../tasks/commitment.js";
import { resetActiveTaskRuntimeForTests, setActiveTaskRuntime } from "../../tasks/runtime.js";
import { applyExecutionTaskGuard } from "./execution-task-guard.js";

afterEach(() => {
  resetActiveTaskRuntimeForTests();
});

describe("applyExecutionTaskGuard", () => {
  it("creates a durable task for empty execution commitments", async () => {
    const createTask = vi.fn().mockResolvedValue({
      task: { taskId: "task-1" },
      queuePosition: 1,
      startedImmediately: true,
    });
    setActiveTaskRuntime({
      create: createTask,
      wake: vi.fn(),
    });

    const result = await applyExecutionTaskGuard({
      payloads: [{ text: "我会继续推进这条任务，完成后回来汇报。" }],
      commandBody: "帮我把飞书群闭环验收到完成",
      sessionKey: "main",
      agentId: "main",
      originMessageId: "msg-123",
      successfulMutatingToolCalls: 0,
      successfulCronAdds: 0,
      didSendViaMessagingTool: false,
    });

    expect(result).toEqual([
      {
        text: buildTaskAcceptedText({
          queuePosition: 1,
          startedImmediately: true,
        }),
      },
    ]);
    expect(createTask).toHaveBeenCalledWith({
      agentId: "main",
      originSessionKey: "main",
      originMessageId: "msg-123",
      goal: "帮我把飞书群闭环验收到完成",
      acceptance: [
        "Produce concrete progress with tools, or record a clear blocker.",
        "Only report new facts, blockers, or final completion.",
      ],
    });
  });

  it("does not create a durable task after concrete mutating work already happened", async () => {
    const createTask = vi.fn();
    setActiveTaskRuntime({
      create: createTask,
      wake: vi.fn(),
    });

    const result = await applyExecutionTaskGuard({
      payloads: [{ text: "我会继续推进这条任务，刚刚已经把配置改掉了。" }],
      commandBody: "继续推进",
      sessionKey: "main",
      agentId: "main",
      successfulMutatingToolCalls: 1,
      successfulCronAdds: 0,
      didSendViaMessagingTool: false,
    });

    expect(result).toEqual([{ text: "我会继续推进这条任务，刚刚已经把配置改掉了。" }]);
    expect(createTask).not.toHaveBeenCalled();
  });
});
