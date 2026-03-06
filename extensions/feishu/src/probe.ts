import { createFeishuClient, type FeishuClientCredentials } from "./client.js";
import type { FeishuProbeResult } from "./types.js";

// Cache bot info for 24 hours to reduce API calls
const BOT_INFO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const botInfoCache = new Map<string, { result: FeishuProbeResult; cachedAt: number }>();

export async function probeFeishu(creds?: FeishuClientCredentials): Promise<FeishuProbeResult> {
  if (!creds?.appId || !creds?.appSecret) {
    return {
      ok: false,
      error: "missing credentials (appId, appSecret)",
    };
  }

  const cacheKey = creds.appId;
  const now = Date.now();

  // Check cache first
  const cached = botInfoCache.get(cacheKey);
  if (cached && now - cached.cachedAt < BOT_INFO_CACHE_TTL_MS) {
    return cached.result;
  }

  try {
    const client = createFeishuClient(creds);
    // Use bot/v3/info API to get bot information
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK generic request method
    const response = await (client as any).request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
      data: {},
    });

    if (response.code !== 0) {
      return {
        ok: false,
        appId: creds.appId,
        error: `API error: ${response.msg || `code ${response.code}`}`,
      };
    }

    const bot = response.bot || response.data?.bot;
    const result: FeishuProbeResult = {
      ok: true,
      appId: creds.appId,
      botName: bot?.bot_name,
      botOpenId: bot?.open_id,
    };
    // Cache successful result
    botInfoCache.set(cacheKey, { result, cachedAt: now });
    return result;
  } catch (err) {
    return {
      ok: false,
      appId: creds.appId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Clear the bot info cache for a specific app or all apps.
 * Useful when quota is exhausted and you want to retry after reset.
 */
export function clearBotInfoCache(appId?: string): void {
  if (appId) {
    botInfoCache.delete(appId);
  } else {
    botInfoCache.clear();
  }
}

/**
 * Manually set the bot open_id to bypass API calls.
 * Useful when API quota is exhausted.
 */
export function setBotOpenIdCache(appId: string, botOpenId: string): void {
  const result: FeishuProbeResult = {
    ok: true,
    appId,
    botOpenId,
  };
  botInfoCache.set(appId, { result, cachedAt: Date.now() });
}
