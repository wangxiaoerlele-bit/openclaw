import { resolveAgentIdFromSessionKey } from "../../config/sessions.js";
import { buildTaskAcceptedText, hasExecutionCommitment } from "../../tasks/commitment.js";
import { getActiveTaskRuntime } from "../../tasks/runtime.js";
import type { ReplyPayload } from "../types.js";

function findCommitmentPayload(payloads: ReplyPayload[]): ReplyPayload | undefined {
  return payloads.find(
    (payload) =>
      !payload.isError && typeof payload.text === "string" && hasExecutionCommitment(payload.text),
  );
}

function replaceTextPayloads(payloads: ReplyPayload[], text: string): ReplyPayload[] {
  const replaced: ReplyPayload[] = [];
  let inserted = false;
  for (const payload of payloads) {
    if (!payload.isError && typeof payload.text === "string") {
      if (!inserted) {
        replaced.push({ ...payload, text });
        inserted = true;
      }
      continue;
    }
    replaced.push(payload);
  }
  if (!inserted) {
    replaced.push({ text });
  }
  return replaced;
}

export async function applyExecutionTaskGuard(params: {
  payloads: ReplyPayload[];
  commandBody: string;
  sessionKey?: string;
  agentId?: string;
  originMessageId?: string;
  successfulMutatingToolCalls?: number;
  successfulCronAdds?: number;
  didSendViaMessagingTool?: boolean;
}): Promise<ReplyPayload[]> {
  const commitmentPayload = findCommitmentPayload(params.payloads);
  if (!commitmentPayload) {
    return params.payloads;
  }
  const hadConcreteAction =
    (params.successfulMutatingToolCalls ?? 0) > 0 ||
    (params.successfulCronAdds ?? 0) > 0 ||
    params.didSendViaMessagingTool === true;
  if (hadConcreteAction) {
    return params.payloads;
  }
  const activeTaskRuntime = getActiveTaskRuntime();
  const sessionKey = params.sessionKey?.trim();
  const agentId = params.agentId?.trim() || resolveAgentIdFromSessionKey(sessionKey);
  if (!activeTaskRuntime || !sessionKey || !agentId) {
    return params.payloads;
  }
  const created = await activeTaskRuntime.create({
    agentId,
    originSessionKey: sessionKey,
    originMessageId: params.originMessageId,
    goal: params.commandBody,
    acceptance: [
      "Produce concrete progress with tools, or record a clear blocker.",
      "Only report new facts, blockers, or final completion.",
    ],
  });
  return replaceTextPayloads(
    params.payloads,
    buildTaskAcceptedText({
      queuePosition: created.queuePosition,
      startedImmediately: created.startedImmediately,
    }),
  );
}
