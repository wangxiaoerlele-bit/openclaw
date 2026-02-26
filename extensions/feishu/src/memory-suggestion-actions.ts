import fs from "node:fs";
import path from "node:path";
import {
  applyQueuedPersonalMemorySuggestion,
  dismissPersonalMemorySuggestion,
  type ClawdbotConfig,
  type PersonalMemorySuggestionQueueItem,
  PersonalMemorySuggestionQueueError,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";

export type FeishuPersonalMemorySuggestionActionPayload = {
  queueId: string;
  level: "L0" | "L1" | "L2" | "L3";
  target?: string;
  title?: string;
  reason?: string;
  canApply?: boolean;
};

type FeishuPersonalMemoryCardActionValue = {
  oc_action?: string;
  op?: string;
  queueId?: string;
  accountId?: string;
};

type FeishuCardActionEvent = {
  data?: unknown;
  event_callback?: unknown;
  open_id?: string;
  open_message_id?: string;
  action?: {
    value?: unknown;
  };
  event?: {
    open_message_id?: string;
    action?: {
      value?: unknown;
    };
  };
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getNestedValue(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const obj = asObject(current);
    if (!obj) {
      return undefined;
    }
    current = obj[key];
  }
  return current;
}

function parseActionValueRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return asObject(value);
}

function resolveDefaultPersonalContextDir(): string | undefined {
  const candidate = path.resolve(process.cwd(), "personal-context");
  return fs.existsSync(candidate) ? candidate : undefined;
}

function pickActionValue(event: FeishuCardActionEvent): FeishuPersonalMemoryCardActionValue {
  const value = [
    event.action?.value,
    event.event?.action?.value,
    getNestedValue(event.event_callback, ["action", "value"]),
    getNestedValue(event.event_callback, ["event", "action", "value"]),
    getNestedValue(event.data, ["action", "value"]),
    getNestedValue(event.data, ["event", "action", "value"]),
    getNestedValue(event.data, ["event_callback", "action", "value"]),
    getNestedValue(event.data, ["event_callback", "event", "action", "value"]),
  ]
    .map(parseActionValueRecord)
    .find(Boolean);
  if (!value) {
    return {};
  }
  return {
    oc_action: typeof value.oc_action === "string" ? value.oc_action : undefined,
    op: typeof value.op === "string" ? value.op : undefined,
    queueId: typeof value.queueId === "string" ? value.queueId : undefined,
    accountId: typeof value.accountId === "string" ? value.accountId : undefined,
  };
}

function isSupportedQueueId(value: string): boolean {
  return /^pms_[a-z0-9_-]+$/i.test(value);
}

function toast(type: "success" | "warning" | "info", content: string): Record<string, unknown> {
  return { toast: { type, content } };
}

function titleFromQueueItem(item: PersonalMemorySuggestionQueueItem): string | undefined {
  return item.suggestion.title ?? item.suggestion.structured?.title;
}

function buildCardMarkdownSummary(payload: FeishuPersonalMemorySuggestionActionPayload): string {
  const lines = [
    `**记忆建议** \`${payload.queueId}\``,
    `级别：${payload.level}${payload.target ? `（target=${payload.target}）` : ""}`,
    payload.title ? `标题：${payload.title}` : undefined,
    payload.reason ? `原因：${payload.reason}` : undefined,
    payload.canApply === false
      ? "该建议暂不支持直接应用，可选择忽略或使用队列命令查看详情。"
      : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}

export function buildFeishuPersonalMemorySuggestionActionCard(params: {
  payload: FeishuPersonalMemorySuggestionActionPayload;
  accountId?: string;
}): Record<string, unknown> {
  const p = params.payload;
  const actionBase = {
    oc_action: "personal_memory_suggestion",
    queueId: p.queueId,
    accountId: params.accountId,
  };
  const actions: Array<Record<string, unknown>> = [];
  if (p.canApply) {
    actions.push({
      tag: "button",
      type: "primary",
      text: { tag: "plain_text", content: "应用建议" },
      value: { ...actionBase, op: "apply" },
    });
  }
  actions.push({
    tag: "button",
    text: { tag: "plain_text", content: "忽略建议" },
    value: { ...actionBase, op: "dismiss" },
  });
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    elements: [
      {
        tag: "markdown",
        content: buildCardMarkdownSummary(p),
      },
      {
        tag: "action",
        actions,
      },
    ],
  };
}

export function extractFeishuPersonalMemorySuggestionActionPayload(
  payload: unknown,
): FeishuPersonalMemorySuggestionActionPayload | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const root = payload as Record<string, unknown>;
  const feishuData =
    root.feishu && typeof root.feishu === "object" && !Array.isArray(root.feishu)
      ? (root.feishu as Record<string, unknown>)
      : undefined;
  const action =
    feishuData?.personalMemorySuggestionAction &&
    typeof feishuData.personalMemorySuggestionAction === "object" &&
    !Array.isArray(feishuData.personalMemorySuggestionAction)
      ? (feishuData.personalMemorySuggestionAction as Record<string, unknown>)
      : undefined;
  if (!action || typeof action.queueId !== "string" || typeof action.level !== "string") {
    return undefined;
  }
  return {
    queueId: action.queueId,
    level: action.level as FeishuPersonalMemorySuggestionActionPayload["level"],
    target: typeof action.target === "string" ? action.target : undefined,
    title: typeof action.title === "string" ? action.title : undefined,
    reason: typeof action.reason === "string" ? action.reason : undefined,
    canApply: typeof action.canApply === "boolean" ? action.canApply : undefined,
  };
}

export async function handleFeishuPersonalMemoryCardAction(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  event: unknown;
  runtime?: RuntimeEnv;
}): Promise<Record<string, unknown> | undefined> {
  const event = (params.event ?? {}) as FeishuCardActionEvent;
  const action = pickActionValue(event);
  if (action.oc_action !== "personal_memory_suggestion") {
    return undefined;
  }
  if (!action.queueId || !isSupportedQueueId(action.queueId)) {
    return toast("warning", "无效的记忆建议 ID");
  }
  if (action.accountId && action.accountId !== params.accountId) {
    return toast("warning", "该建议不属于当前账号");
  }
  const personalContextDir = resolveDefaultPersonalContextDir();
  if (!personalContextDir) {
    return toast("warning", "未找到 personal-context 目录");
  }

  try {
    if (action.op === "dismiss") {
      const item = dismissPersonalMemorySuggestion({
        personalContextDir,
        id: action.queueId,
      });
      return toast("success", `已忽略记忆建议：${item.id}`);
    }
    if (action.op === "apply") {
      const applied = applyQueuedPersonalMemorySuggestion({
        personalContextDir,
        id: action.queueId,
      });
      const appliedTitle =
        applied.applyResult.title ?? titleFromQueueItem(applied.item) ?? action.queueId;
      if (applied.applyResult.applied) {
        return toast("success", `已应用记忆建议：${appliedTitle}`);
      }
      if (applied.applyResult.alreadyExists) {
        return toast("info", `该记忆建议已存在：${appliedTitle}`);
      }
      return toast("warning", `该记忆建议当前不可直接应用：${appliedTitle}`);
    }
    return toast("warning", "不支持的记忆建议操作");
  } catch (err) {
    if (err instanceof PersonalMemorySuggestionQueueError) {
      params.runtime?.error?.(
        `feishu[${params.accountId}]: personal-memory card action failed: ${err.code} ${err.message}`,
      );
      return toast("warning", `记忆建议操作失败：${err.message}`);
    }
    params.runtime?.error?.(
      `feishu[${params.accountId}]: personal-memory card action error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return toast("warning", "记忆建议操作失败，请稍后重试");
  }
}
