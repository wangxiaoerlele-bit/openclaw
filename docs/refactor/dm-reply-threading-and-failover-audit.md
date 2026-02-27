---
title: DM Reply Threading and Failover Audit 2026-02-27
description: Summary of direct-message reply threading hardening, failover classification fixes, and follow-up work.
summary: "Audit log for DM reply behavior and timeout failover classification updates"
read_when:
  - Reviewing DM threading behavior across channels
  - Debugging failover on stop reason network_error
  - Planning follow-up hardening for reply delivery
---

# DM Reply Threading and Failover Audit 2026-02-27

## Status

- Completed and validated with targeted tests + `pnpm check`.

## Scope

- Remove native reply/thread binding in direct-message contexts.
- Keep group/channel threading behavior unchanged.
- Classify `stop reason: network_error` as timeout failover.
- Align channel-specific behavior in Feishu, Mattermost, and Microsoft Teams.

## Changes Applied

- Core reply threading:
  - `resolveReplyToMode(...)` now forces `off` for `chatType=direct`.
  - Reply tag handling in direct chats strips `[[reply_to_*]]` directives.
  - Reply pipeline now passes chat type into reply-threading filters.
- Channel behavior:
  - Feishu DM replies no longer bind `replyToMessageId`.
  - Mattermost DM replies no longer set `replyToId`/`root_id`.
  - Microsoft Teams direct messages force `top-level` reply style.
- Failover classification:
  - `Unhandled stop reason: network_error` and related `reason/stop reason` variants are treated as timeout errors.

## Tests

- Added/updated:
  - `extensions/feishu/src/bot.test.ts`
  - `extensions/msteams/src/policy.test.ts`
  - `extensions/mattermost/src/mattermost/monitor-helpers.test.ts` (new)
  - `src/agents/failover-error.test.ts`
  - `src/agents/pi-embedded-helpers.isbillingerrormessage.test.ts`
  - `src/auto-reply/reply/reply-flow.test.ts`
  - `src/auto-reply/reply/reply-plumbing.test.ts`

## Follow-up Optimization Items

- Add an end-to-end monitor test that verifies Mattermost direct inbound events produce outbound sends without `replyToId`.
- Add a channel-agnostic contract test for "DM always top-level reply" across built-in + extension channels.
- Add a lightweight metrics counter for timeout failover causes split by raw stop reason (`abort` vs `network_error`) to improve operator visibility.
