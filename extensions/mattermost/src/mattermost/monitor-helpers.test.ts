import { describe, expect, it } from "vitest";
import { resolveOutboundReplyToId } from "./monitor-helpers.js";

describe("monitor helpers", () => {
  describe("resolveOutboundReplyToId", () => {
    it("drops native threading in direct chats", () => {
      expect(resolveOutboundReplyToId("direct", "thread-1")).toBeUndefined();
      expect(resolveOutboundReplyToId("direct", undefined)).toBeUndefined();
    });

    it("keeps thread linkage for group and channel chats", () => {
      expect(resolveOutboundReplyToId("group", "thread-2")).toBe("thread-2");
      expect(resolveOutboundReplyToId("channel", "thread-3")).toBe("thread-3");
    });
  });
});
