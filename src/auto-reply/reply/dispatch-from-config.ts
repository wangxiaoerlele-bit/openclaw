import fs from "node:fs";
import path from "node:path";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  logMessageProcessed,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import {
  emitPersonalMemoryPostSuggestionDetailed,
  inferPersonalMemoryTaskKindFromText,
  inferPersonalMemoryUserConfirmedFromText,
  runPersonalMemoryPreHook,
} from "../../personal-memory/runtime-hooks.js";
import { resolvePersonalMemoryChannelPolicy } from "../../personal-memory/settings.js";
import {
  applyQueuedPersonalMemorySuggestion,
  dismissPersonalMemorySuggestion,
  listPersonalMemorySuggestions,
  PersonalMemorySuggestionQueueError,
} from "../../personal-memory/suggestion-queue.js";
import type {
  PersonalMemoryChannel,
  PersonalMemoryPreSessionContext,
} from "../../personal-memory/types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { maybeApplyTtsToPayload, normalizeTtsAutoMode, resolveTtsConfig } from "../../tts/tts.js";
import { getReplyFromConfig } from "../reply.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import { shouldSkipDuplicateInbound } from "./inbound-dedupe.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

const AUDIO_PLACEHOLDER_RE = /^<media:audio>(\s*\([^)]*\))?$/i;
const AUDIO_HEADER_RE = /^\[Audio\b/i;

const normalizeMediaType = (value: string): string => value.split(";")[0]?.trim().toLowerCase();

const isInboundAudioContext = (ctx: FinalizedMsgContext): boolean => {
  const rawTypes = [
    typeof ctx.MediaType === "string" ? ctx.MediaType : undefined,
    ...(Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : []),
  ].filter(Boolean) as string[];
  const types = rawTypes.map((type) => normalizeMediaType(type));
  if (types.some((type) => type === "audio" || type.startsWith("audio/"))) {
    return true;
  }

  const body =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.CommandBody === "string"
        ? ctx.CommandBody
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
  const trimmed = body.trim();
  if (!trimmed) {
    return false;
  }
  if (AUDIO_PLACEHOLDER_RE.test(trimmed)) {
    return true;
  }
  return AUDIO_HEADER_RE.test(trimmed);
};

const resolveSessionTtsAuto = (
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): string | undefined => {
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const sessionKey = (targetSessionKey ?? ctx.SessionKey)?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey.toLowerCase()] ?? store[sessionKey];
    return normalizeTtsAutoMode(entry?.ttsAuto);
  } catch {
    return undefined;
  }
};

export type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

function resolvePersonalMemoryChannel(raw: string | undefined): PersonalMemoryChannel | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const alias: Record<string, PersonalMemoryChannel> = {
    webchat: "web-gui",
    feishu: "feishu",
    telegram: "telegram",
    discord: "discord",
    slack: "slack",
    signal: "signal",
    imessage: "imessage",
    whatsapp: "whatsapp",
    matrix: "matrix",
    msteams: "msteams",
    mattermost: "mattermost",
    googlechat: "googlechat",
    "nextcloud-talk": "nextcloud-talk",
    irc: "irc",
    zalo: "zalo",
    zalouser: "zalouser",
    bluebubbles: "bluebubbles",
    tlon: "tlon",
    twitch: "twitch",
  };
  return alias[normalized];
}

function resolveDefaultPersonalContextDir(): string | undefined {
  const candidate = path.resolve(process.cwd(), "personal-context");
  return fs.existsSync(candidate) ? candidate : undefined;
}

type ParsedPersonalMemoryDecisionFields = {
  decisionTitle?: string;
  background?: string;
  decision?: string;
  reason?: string;
  next?: string;
  links?: string;
};

type PersonalMemoryQueueInlineCommand =
  | { action: "list"; status?: "pending" | "all" }
  | { action: "apply"; id: string }
  | { action: "dismiss"; id: string };

function parsePersonalMemoryDecisionFieldsFromText(
  text: string,
): ParsedPersonalMemoryDecisionFields {
  const parsed: ParsedPersonalMemoryDecisionFields = {};
  const labelMap: Record<string, keyof ParsedPersonalMemoryDecisionFields> = {
    决策标题: "decisionTitle",
    标题: "decisionTitle",
    background: "background",
    背景: "background",
    decision: "decision",
    决策: "decision",
    reason: "reason",
    原因: "reason",
    next: "next",
    后续动作: "next",
    下一步: "next",
    links: "links",
    相关文件: "links",
    相关链接: "links",
    链接: "links",
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = /^([A-Za-z\u4e00-\u9fa5]+)\s*[：:]\s*(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const rawLabel = match[1]?.trim();
    const value = match[2]?.trim();
    if (!rawLabel || !value) {
      continue;
    }
    const key = labelMap[rawLabel] ?? labelMap[rawLabel.toLowerCase()];
    if (!key || parsed[key]) {
      continue;
    }
    parsed[key] = value;
  }
  return parsed;
}

function parsePersonalMemoryQueueInlineCommand(
  text: string,
): PersonalMemoryQueueInlineCommand | undefined {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) {
    return undefined;
  }

  let m = /^(?:记忆建议|记忆队列)\s*(?:列表|list|ls)?\s*(全部|all)?$/i.exec(firstLine);
  if (m) {
    return { action: "list", status: m[1] ? "all" : "pending" };
  }
  m = /^(?:memory\s+suggestions)(?:\s+(all))?$/i.exec(firstLine);
  if (m) {
    return { action: "list", status: m[1] ? "all" : "pending" };
  }

  m = /^(?:记忆(?:建议)?\s*应用|memory\s+apply)\s+(pms_[a-z0-9_-]+)$/i.exec(firstLine);
  if (m?.[1]) {
    return { action: "apply", id: m[1] };
  }
  m = /^(?:记忆(?:建议)?\s*(?:忽略|驳回)|memory\s+(?:dismiss|reject))\s+(pms_[a-z0-9_-]+)$/i.exec(
    firstLine,
  );
  if (m?.[1]) {
    return { action: "dismiss", id: m[1] };
  }
  return undefined;
}

function buildPersonalMemorySuggestionSummaryLine(params: {
  id: string;
  status: string;
  level: string;
  target?: string;
  title?: string;
  channel?: string;
}): string {
  const parts = [
    params.id,
    `[${params.status}]`,
    params.level,
    params.target ? `target=${params.target}` : undefined,
    params.channel ? `ch=${params.channel}` : undefined,
    params.title ? `title=${params.title}` : undefined,
  ].filter(Boolean);
  return `- ${parts.join(" | ")}`;
}

function formatPersonalMemoryInlineCommandReply(params: {
  command: PersonalMemoryQueueInlineCommand;
  personalContextDir: string;
}): string {
  try {
    if (params.command.action === "list") {
      const status = params.command.status ?? "pending";
      const result = listPersonalMemorySuggestions({
        personalContextDir: params.personalContextDir,
        status,
        limit: 10,
      });
      if (result.items.length === 0) {
        return `记忆建议队列为空（status=${status}）`;
      }
      const lines = [
        `记忆建议队列（status=${status}，显示前 ${result.items.length} 条）`,
        ...result.items.map((item) =>
          buildPersonalMemorySuggestionSummaryLine({
            id: item.id,
            status: item.status,
            level: item.suggestion.level,
            target: item.suggestion.target,
            title: item.suggestion.title ?? item.suggestion.structured?.title,
            channel: item.source.channel,
          }),
        ),
        "",
        "可用命令：",
        "记忆应用 pms_xxx",
        "记忆忽略 pms_xxx",
      ];
      return lines.join("\n");
    }
    if (params.command.action === "apply") {
      const applied = applyQueuedPersonalMemorySuggestion({
        personalContextDir: params.personalContextDir,
        id: params.command.id,
      });
      return [
        `记忆建议已应用：${applied.item.id}`,
        `状态：${applied.item.status}`,
        `标题：${applied.applyResult.title ?? "-"}`,
        `写入：${applied.applyResult.applied ? "yes" : "no"}`,
        `重复：${applied.applyResult.alreadyExists ? "yes" : "no"}`,
      ].join("\n");
    }
    const dismissed = dismissPersonalMemorySuggestion({
      personalContextDir: params.personalContextDir,
      id: params.command.id,
    });
    return `记忆建议已忽略：${dismissed.id}\n状态：${dismissed.status}`;
  } catch (err) {
    if (err instanceof PersonalMemorySuggestionQueueError) {
      return `记忆建议操作失败：${err.message}`;
    }
    return `记忆建议操作失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

function buildFeishuPersonalMemorySuggestionReply(params: {
  queueId: string;
  suggestionLevel: string;
  target?: string;
  title?: string;
  reason?: string;
  commitCommand?: string;
}): ReplyPayload {
  const canApply = Boolean(params.commitCommand);
  const lines = [
    `已生成记忆建议：${params.queueId}`,
    `级别：${params.suggestionLevel}${params.target ? ` (target=${params.target})` : ""}`,
    params.title ? `标题：${params.title}` : undefined,
    params.reason ? `原因：${params.reason}` : undefined,
    "",
    canApply ? `可直接点击按钮处理，或发送：记忆应用 ${params.queueId}` : undefined,
    `也可发送：记忆忽略 ${params.queueId}`,
  ].filter(Boolean) as string[];
  return {
    text: lines.join("\n"),
    channelData: {
      feishu: {
        personalMemorySuggestionAction: {
          queueId: params.queueId,
          level: params.suggestionLevel,
          target: params.target,
          title: params.title,
          reason: params.reason,
          canApply,
        },
      },
    },
  };
}

export async function dispatchReplyFromConfig(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof getReplyFromConfig;
}): Promise<DispatchFromConfigResult> {
  const { ctx, cfg, dispatcher } = params;
  const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
  const channel = String(ctx.Surface ?? ctx.Provider ?? "unknown").toLowerCase();
  const chatId = ctx.To ?? ctx.From;
  const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const sessionKey = ctx.SessionKey;
  const startTime = diagnosticsEnabled ? Date.now() : 0;
  const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);

  const recordProcessed = (
    outcome: "completed" | "skipped" | "error",
    opts?: {
      reason?: string;
      error?: string;
    },
  ) => {
    if (!diagnosticsEnabled) {
      return;
    }
    logMessageProcessed({
      channel,
      chatId,
      messageId,
      sessionKey,
      durationMs: Date.now() - startTime,
      outcome,
      reason: opts?.reason,
      error: opts?.error,
    });
  };

  const markProcessing = () => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logMessageQueued({ sessionKey, channel, source: "dispatch" });
    logSessionStateChange({
      sessionKey,
      state: "processing",
      reason: "message_start",
    });
  };

  const markIdle = (reason: string) => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logSessionStateChange({
      sessionKey,
      state: "idle",
      reason,
    });
  };

  if (shouldSkipDuplicateInbound(ctx)) {
    recordProcessed("skipped", { reason: "duplicate" });
    return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
  }

  const inboundAudio = isInboundAudioContext(ctx);
  const sessionTtsAuto = resolveSessionTtsAuto(ctx, cfg);
  const hookRunner = getGlobalHookRunner();

  // Extract message context for hooks (plugin and internal)
  const timestamp =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined;
  const messageIdForHook =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const content =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.RawBody === "string"
        ? ctx.RawBody
        : typeof ctx.Body === "string"
          ? ctx.Body
          : "";
  const personalMemoryContent =
    typeof ctx.RawBody === "string"
      ? ctx.RawBody
      : typeof ctx.BodyForCommands === "string"
        ? ctx.BodyForCommands
        : typeof ctx.Body === "string"
          ? ctx.Body
          : "";
  const channelId = (ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "").toLowerCase();
  const conversationId = ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? undefined;
  const personalMemoryChannel = resolvePersonalMemoryChannel(channelId);
  const personalContextDir = personalMemoryChannel ? resolveDefaultPersonalContextDir() : undefined;
  let personalMemoryPolicy: ReturnType<typeof resolvePersonalMemoryChannelPolicy> | undefined;
  if (personalMemoryChannel && personalContextDir) {
    try {
      personalMemoryPolicy = resolvePersonalMemoryChannelPolicy({
        personalContextDir,
        channel: personalMemoryChannel,
      });
    } catch (err) {
      logVerbose(
        `dispatch-from-config: personal-memory settings failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      personalMemoryPolicy = undefined;
    }
  }
  const runIdForMemory =
    typeof params.replyOptions?.runId === "string" && params.replyOptions.runId.trim()
      ? params.replyOptions.runId
      : typeof messageIdForHook === "string" && messageIdForHook.trim()
        ? `pm:${messageIdForHook}`
        : undefined;
  const shouldSkipPersonalMemory =
    !personalMemoryChannel ||
    !personalContextDir ||
    !personalMemoryPolicy ||
    (!personalMemoryPolicy.preHookEnabled && !personalMemoryPolicy.postHookEnabled) ||
    !sessionKey ||
    typeof ctx.BodyForAgent !== "string" ||
    (personalMemoryChannel === "web-gui" && personalMemoryContent.trim().startsWith("/"));
  const inlineQueueCommand =
    personalMemoryChannel &&
    personalMemoryChannel !== "web-gui" &&
    ctx.ChatType !== "group" &&
    personalContextDir &&
    personalMemoryPolicy?.enabled
      ? parsePersonalMemoryQueueInlineCommand(personalMemoryContent)
      : undefined;
  let personalMemoryPre: PersonalMemoryPreSessionContext | undefined;

  // Trigger plugin hooks (fire-and-forget)
  if (hookRunner?.hasHooks("message_received")) {
    void hookRunner
      .runMessageReceived(
        {
          from: ctx.From ?? "",
          content,
          timestamp,
          metadata: {
            to: ctx.To,
            provider: ctx.Provider,
            surface: ctx.Surface,
            threadId: ctx.MessageThreadId,
            originatingChannel: ctx.OriginatingChannel,
            originatingTo: ctx.OriginatingTo,
            messageId: messageIdForHook,
            senderId: ctx.SenderId,
            senderName: ctx.SenderName,
            senderUsername: ctx.SenderUsername,
            senderE164: ctx.SenderE164,
          },
        },
        {
          channelId,
          accountId: ctx.AccountId,
          conversationId,
        },
      )
      .catch((err) => {
        logVerbose(`dispatch-from-config: message_received plugin hook failed: ${String(err)}`);
      });
  }

  // Bridge to internal hooks (HOOK.md discovery system) - refs #8807
  if (sessionKey) {
    void triggerInternalHook(
      createInternalHookEvent("message", "received", sessionKey, {
        from: ctx.From ?? "",
        content,
        timestamp,
        channelId,
        accountId: ctx.AccountId,
        conversationId,
        messageId: messageIdForHook,
        metadata: {
          to: ctx.To,
          provider: ctx.Provider,
          surface: ctx.Surface,
          threadId: ctx.MessageThreadId,
          senderId: ctx.SenderId,
          senderName: ctx.SenderName,
          senderUsername: ctx.SenderUsername,
          senderE164: ctx.SenderE164,
        },
      }),
    ).catch((err) => {
      logVerbose(`dispatch-from-config: message_received internal hook failed: ${String(err)}`);
    });
  }

  // Check if we should route replies to originating channel instead of dispatcher.
  // Only route when the originating channel is DIFFERENT from the current surface.
  // This handles cross-provider routing (e.g., message from Telegram being processed
  // by a shared session that's currently on Slack) while preserving normal dispatcher
  // flow when the provider handles its own messages.
  //
  // Debug: `pnpm test src/auto-reply/reply/dispatch-from-config.test.ts`
  const originatingChannel = ctx.OriginatingChannel;
  const originatingTo = ctx.OriginatingTo;
  const currentSurface = (ctx.Surface ?? ctx.Provider)?.toLowerCase();
  const shouldRouteToOriginating =
    isRoutableChannel(originatingChannel) && originatingTo && originatingChannel !== currentSurface;
  const ttsChannel = shouldRouteToOriginating ? originatingChannel : currentSurface;

  /**
   * Helper to send a payload via route-reply (async).
   * Only used when actually routing to a different provider.
   * Note: Only called when shouldRouteToOriginating is true, so
   * originatingChannel and originatingTo are guaranteed to be defined.
   */
  const sendPayloadAsync = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
    mirror?: boolean,
  ): Promise<void> => {
    // TypeScript doesn't narrow these from the shouldRouteToOriginating check,
    // but they're guaranteed non-null when this function is called.
    if (!originatingChannel || !originatingTo) {
      return;
    }
    if (abortSignal?.aborted) {
      return;
    }
    const result = await routeReply({
      payload,
      channel: originatingChannel,
      to: originatingTo,
      sessionKey: ctx.SessionKey,
      accountId: ctx.AccountId,
      threadId: ctx.MessageThreadId,
      cfg,
      abortSignal,
      mirror,
    });
    if (!result.ok) {
      logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
    }
  };

  markProcessing();

  try {
    if (inlineQueueCommand && personalContextDir) {
      const payload = {
        text: formatPersonalMemoryInlineCommandReply({
          command: inlineQueueCommand,
          personalContextDir,
        }),
      } satisfies ReplyPayload;
      let queuedFinal = false;
      let routedFinalCount = 0;
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
        });
        queuedFinal = result.ok;
        if (result.ok) {
          routedFinalCount += 1;
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(payload);
      }
      const counts = dispatcher.getQueuedCounts();
      counts.final += routedFinalCount;
      recordProcessed("completed", {
        reason: `personal_memory_queue_${inlineQueueCommand.action}`,
      });
      markIdle("message_completed");
      return { queuedFinal, counts };
    }

    if (
      !shouldSkipPersonalMemory &&
      runIdForMemory &&
      sessionKey &&
      personalContextDir &&
      personalMemoryChannel &&
      typeof ctx.BodyForAgent === "string"
    ) {
      const preResult = await runPersonalMemoryPreHook({
        runId: runIdForMemory,
        sessionKey,
        messageText: personalMemoryContent,
        bodyForAgent: ctx.BodyForAgent,
        personalContextDir,
        channel: personalMemoryChannel,
      });
      ctx.BodyForAgent = preResult.bodyForAgent;
      personalMemoryPre = preResult.pre;
    }

    const fastAbort = await tryFastAbortFromMessage({ ctx, cfg });
    if (fastAbort.handled) {
      const payload = {
        text: formatAbortReplyText(fastAbort.stoppedSubagents),
      } satisfies ReplyPayload;
      let queuedFinal = false;
      let routedFinalCount = 0;
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
        });
        queuedFinal = result.ok;
        if (result.ok) {
          routedFinalCount += 1;
        }
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (abort) failed: ${result.error ?? "unknown error"}`,
          );
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(payload);
      }
      const counts = dispatcher.getQueuedCounts();
      counts.final += routedFinalCount;
      recordProcessed("completed", { reason: "fast_abort" });
      markIdle("message_completed");
      return { queuedFinal, counts };
    }

    // Track accumulated block text for TTS generation after streaming completes.
    // When block streaming succeeds, there's no final reply, so we need to generate
    // TTS audio separately from the accumulated block content.
    let accumulatedBlockText = "";
    let blockCount = 0;

    const shouldSendToolSummaries = ctx.ChatType !== "group" && ctx.CommandSource !== "native";

    const resolveToolDeliveryPayload = (payload: ReplyPayload): ReplyPayload | null => {
      if (shouldSendToolSummaries) {
        return payload;
      }
      // Group/native flows intentionally suppress tool summary text, but media-only
      // tool results (for example TTS audio) must still be delivered.
      const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
      if (!hasMedia) {
        return null;
      }
      return { ...payload, text: undefined };
    };

    const replyResult = await (params.replyResolver ?? getReplyFromConfig)(
      ctx,
      {
        ...params.replyOptions,
        onToolResult: (payload: ReplyPayload) => {
          const run = async () => {
            const ttsPayload = await maybeApplyTtsToPayload({
              payload,
              cfg,
              channel: ttsChannel,
              kind: "tool",
              inboundAudio,
              ttsAuto: sessionTtsAuto,
            });
            const deliveryPayload = resolveToolDeliveryPayload(ttsPayload);
            if (!deliveryPayload) {
              return;
            }
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(deliveryPayload, undefined, false);
            } else {
              dispatcher.sendToolResult(deliveryPayload);
            }
          };
          return run();
        },
        onBlockReply: (payload: ReplyPayload, context) => {
          const run = async () => {
            // Accumulate block text for TTS generation after streaming
            if (payload.text) {
              if (accumulatedBlockText.length > 0) {
                accumulatedBlockText += "\n";
              }
              accumulatedBlockText += payload.text;
              blockCount++;
            }
            const ttsPayload = await maybeApplyTtsToPayload({
              payload,
              cfg,
              channel: ttsChannel,
              kind: "block",
              inboundAudio,
              ttsAuto: sessionTtsAuto,
            });
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(ttsPayload, context?.abortSignal, false);
            } else {
              dispatcher.sendBlockReply(ttsPayload);
            }
          };
          return run();
        },
      },
      cfg,
    );

    const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];

    let queuedFinal = false;
    let routedFinalCount = 0;
    for (const reply of replies) {
      const ttsReply = await maybeApplyTtsToPayload({
        payload: reply,
        cfg,
        channel: ttsChannel,
        kind: "final",
        inboundAudio,
        ttsAuto: sessionTtsAuto,
      });
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        // Route final reply to originating channel.
        const result = await routeReply({
          payload: ttsReply,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
        });
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
          );
        }
        queuedFinal = result.ok || queuedFinal;
        if (result.ok) {
          routedFinalCount += 1;
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(ttsReply) || queuedFinal;
      }
    }

    const ttsMode = resolveTtsConfig(cfg).mode ?? "final";
    // Generate TTS-only reply after block streaming completes (when there's no final reply).
    // This handles the case where block streaming succeeds and drops final payloads,
    // but we still want TTS audio to be generated from the accumulated block content.
    if (
      ttsMode === "final" &&
      replies.length === 0 &&
      blockCount > 0 &&
      accumulatedBlockText.trim()
    ) {
      try {
        const ttsSyntheticReply = await maybeApplyTtsToPayload({
          payload: { text: accumulatedBlockText },
          cfg,
          channel: ttsChannel,
          kind: "final",
          inboundAudio,
          ttsAuto: sessionTtsAuto,
        });
        // Only send if TTS was actually applied (mediaUrl exists)
        if (ttsSyntheticReply.mediaUrl) {
          // Send TTS-only payload (no text, just audio) so it doesn't duplicate the block content
          const ttsOnlyPayload: ReplyPayload = {
            mediaUrl: ttsSyntheticReply.mediaUrl,
            audioAsVoice: ttsSyntheticReply.audioAsVoice,
          };
          if (shouldRouteToOriginating && originatingChannel && originatingTo) {
            const result = await routeReply({
              payload: ttsOnlyPayload,
              channel: originatingChannel,
              to: originatingTo,
              sessionKey: ctx.SessionKey,
              accountId: ctx.AccountId,
              threadId: ctx.MessageThreadId,
              cfg,
            });
            queuedFinal = result.ok || queuedFinal;
            if (result.ok) {
              routedFinalCount += 1;
            }
            if (!result.ok) {
              logVerbose(
                `dispatch-from-config: route-reply (tts-only) failed: ${result.error ?? "unknown error"}`,
              );
            }
          } else {
            const didQueue = dispatcher.sendFinalReply(ttsOnlyPayload);
            queuedFinal = didQueue || queuedFinal;
          }
        }
      } catch (err) {
        logVerbose(
          `dispatch-from-config: accumulated block TTS failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    const replySummary = replies
      .map((reply) => (typeof reply.text === "string" ? reply.text.trim() : ""))
      .filter(Boolean)
      .join("\n\n")
      .trim();
    const summaryForPost = replySummary || accumulatedBlockText.trim();
    const inferredTaskKind =
      personalMemoryPre?.request.taskKind ??
      inferPersonalMemoryTaskKindFromText(personalMemoryContent);
    const decisionFields =
      inferredTaskKind === "decision-review"
        ? parsePersonalMemoryDecisionFieldsFromText(personalMemoryContent)
        : {};
    if (
      !shouldSkipPersonalMemory &&
      runIdForMemory &&
      summaryForPost &&
      sessionKey &&
      personalContextDir &&
      personalMemoryChannel
    ) {
      const postMemory = emitPersonalMemoryPostSuggestionDetailed({
        runId: runIdForMemory,
        sessionKey,
        personalContextDir,
        input: {
          channel: personalMemoryChannel,
          taskKind: inferredTaskKind,
          summary: summaryForPost,
          userConfirmed:
            inferredTaskKind === "decision-review" &&
            inferPersonalMemoryUserConfirmedFromText(personalMemoryContent),
          decisionTitle: decisionFields.decisionTitle,
          background: decisionFields.background,
          decision: decisionFields.decision,
          reason: decisionFields.reason,
          next: decisionFields.next,
          links: decisionFields.links,
        },
      });
      if (
        personalMemoryChannel === "feishu" &&
        ctx.ChatType !== "group" &&
        postMemory.queueId &&
        postMemory.suggestion.level !== "L0"
      ) {
        const didQueue = dispatcher.sendFinalReply(
          buildFeishuPersonalMemorySuggestionReply({
            queueId: postMemory.queueId,
            suggestionLevel: postMemory.suggestion.level,
            target: postMemory.suggestion.target,
            title: postMemory.suggestion.title ?? postMemory.suggestion.structured?.title,
            reason: postMemory.suggestion.reason,
            commitCommand: postMemory.commitCommand,
          }),
        );
        queuedFinal = didQueue || queuedFinal;
        if (didQueue) {
          counts.final += 1;
        }
      }
    }
    recordProcessed("completed");
    markIdle("message_completed");
    return { queuedFinal, counts };
  } catch (err) {
    recordProcessed("error", { error: String(err) });
    markIdle("message_error");
    throw err;
  }
}
