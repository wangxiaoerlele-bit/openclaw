import { describe, expect, it, vi } from "vitest";
import { patchFeishuWSClientCardFrameCompat } from "./client.js";

describe("feishu ws card frame compat", () => {
  it("remaps card frame type to event before delegating to sdk handler", async () => {
    const original = vi.fn().mockResolvedValue(undefined);
    const fakeClient = {
      handleEventData: original,
    } as unknown as Parameters<typeof patchFeishuWSClientCardFrameCompat>[0];

    patchFeishuWSClientCardFrameCompat(fakeClient);

    const patched = (
      fakeClient as unknown as { handleEventData: (frame: unknown) => Promise<void> }
    ).handleEventData;
    await patched({
      headers: [
        { key: "type", value: "card" },
        { key: "message_id", value: "m1" },
      ],
    });

    expect(original).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledWith({
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "m1" },
      ],
    });
  });

  it("does not double-patch the same client instance", async () => {
    const original = vi.fn().mockResolvedValue(undefined);
    const fakeClient = {
      handleEventData: original,
    } as unknown as Parameters<typeof patchFeishuWSClientCardFrameCompat>[0];

    patchFeishuWSClientCardFrameCompat(fakeClient);
    const firstPatched = (
      fakeClient as unknown as { handleEventData: (frame: unknown) => Promise<void> }
    ).handleEventData;
    patchFeishuWSClientCardFrameCompat(fakeClient);
    const secondPatched = (
      fakeClient as unknown as { handleEventData: (frame: unknown) => Promise<void> }
    ).handleEventData;

    expect(secondPatched).toBe(firstPatched);
    await secondPatched({ headers: [{ key: "type", value: "event" }] });
    expect(original).toHaveBeenCalledTimes(1);
  });
});
