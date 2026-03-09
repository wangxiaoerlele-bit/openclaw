import { describe, expect, it } from "vitest";
import { extractToolSend } from "./tool-send.js";

describe("extractToolSend", () => {
  it("returns null when the action does not match", () => {
    expect(extractToolSend({ action: "other", to: "user:1" })).toBeNull();
  });

  it("extracts account and thread ids from sendMessage payloads", () => {
    expect(
      extractToolSend({
        action: "sendMessage",
        to: "user:1",
        accountId: " acct-1 ",
        threadId: 12345,
      }),
    ).toEqual({
      to: "user:1",
      accountId: "acct-1",
      threadId: "12345",
    });
  });

  it("drops blank thread ids", () => {
    expect(
      extractToolSend({
        action: "sendMessage",
        to: "user:2",
        threadId: "   ",
      }),
    ).toEqual({
      to: "user:2",
      accountId: undefined,
      threadId: undefined,
    });
  });
});
