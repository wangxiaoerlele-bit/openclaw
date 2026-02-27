import { normalizeChatType } from "../../channels/chat-type.js";
import { getChannelDock } from "../../channels/dock.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";

export function resolveReplyToMode(
  cfg: OpenClawConfig,
  channel?: OriginatingChannelType,
  accountId?: string | null,
  chatType?: string | null,
): ReplyToMode {
  if (normalizeChatType(chatType ?? undefined) === "direct") {
    // DM policy: never use native reply/quote linkage.
    return "off";
  }
  const provider = normalizeChannelId(channel);
  if (!provider) {
    return "all";
  }
  const resolved = getChannelDock(provider)?.threading?.resolveReplyToMode?.({
    cfg,
    accountId,
    chatType,
  });
  return resolved ?? "all";
}

export function createReplyToModeFilter(
  mode: ReplyToMode,
  opts: { allowExplicitReplyTagsWhenOff?: boolean } = {},
) {
  let hasThreaded = false;
  return (payload: ReplyPayload): ReplyPayload => {
    if (!payload.replyToId) {
      return payload;
    }
    if (mode === "off") {
      const isExplicit = Boolean(payload.replyToTag) || Boolean(payload.replyToCurrent);
      if (opts.allowExplicitReplyTagsWhenOff && isExplicit) {
        return payload;
      }
      return { ...payload, replyToId: undefined };
    }
    if (mode === "all") {
      return payload;
    }
    if (hasThreaded) {
      return { ...payload, replyToId: undefined };
    }
    hasThreaded = true;
    return payload;
  };
}

export function createReplyToModeFilterForChannel(
  mode: ReplyToMode,
  channel?: OriginatingChannelType,
  opts: { chatType?: string | null } = {},
) {
  const provider = normalizeChannelId(channel);
  const normalized = typeof channel === "string" ? channel.trim().toLowerCase() : undefined;
  const isWebchat = normalized === "webchat";
  const isDirect = normalizeChatType(opts.chatType ?? undefined) === "direct";
  // Default: allow explicit reply tags/directives even when replyToMode is "off".
  // Unknown channels fail closed; internal webchat stays allowed.
  const dock = provider ? getChannelDock(provider) : undefined;
  const allowExplicitReplyTagsWhenOff = isDirect
    ? false
    : provider
      ? (dock?.threading?.allowExplicitReplyTagsWhenOff ??
        dock?.threading?.allowTagsWhenOff ??
        true)
      : isWebchat;
  return createReplyToModeFilter(mode, {
    allowExplicitReplyTagsWhenOff,
  });
}
