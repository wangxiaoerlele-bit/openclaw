import { createRequire } from "node:module";
import * as accountIdSdk from "openclaw/plugin-sdk/account-id";
import * as compatSdk from "openclaw/plugin-sdk/compat";
import * as coreSdk from "openclaw/plugin-sdk/core";
import * as discordSdk from "openclaw/plugin-sdk/discord";
import * as imessageSdk from "openclaw/plugin-sdk/imessage";
import * as keyedAsyncQueueSdk from "openclaw/plugin-sdk/keyed-async-queue";
import * as lineSdk from "openclaw/plugin-sdk/line";
import * as msteamsSdk from "openclaw/plugin-sdk/msteams";
import * as signalSdk from "openclaw/plugin-sdk/signal";
import * as slackSdk from "openclaw/plugin-sdk/slack";
import * as telegramSdk from "openclaw/plugin-sdk/telegram";
import * as whatsappSdk from "openclaw/plugin-sdk/whatsapp";
import { describe, expect, it } from "vitest";
import { buildPluginSdkPackageExports, pluginSdkScopedExportEntries } from "./export-manifest.js";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as {
  exports?: Record<string, { types?: string; default?: string }>;
};

const directlyImportedSubpaths = new Set([
  "./plugin-sdk/compat",
  "./plugin-sdk/discord",
  "./plugin-sdk/imessage",
  "./plugin-sdk/line",
  "./plugin-sdk/msteams",
  "./plugin-sdk/signal",
  "./plugin-sdk/slack",
  "./plugin-sdk/telegram",
  "./plugin-sdk/whatsapp",
]);

describe("plugin-sdk subpath exports", () => {
  it("keeps package.json plugin-sdk exports in sync with the shared manifest", () => {
    const actualExports = Object.fromEntries(
      Object.entries(packageJson.exports ?? {}).filter(
        ([key]) => key === "./plugin-sdk" || key.startsWith("./plugin-sdk/"),
      ),
    );

    expect(actualExports).toEqual(buildPluginSdkPackageExports());
  });

  it("exports compat helpers", () => {
    expect(typeof compatSdk.emptyPluginConfigSchema).toBe("function");
    expect(typeof compatSdk.resolveControlCommandGate).toBe("function");
  });

  it("keeps the core entry focused on runtime-safe infrastructure helpers", () => {
    expect(typeof coreSdk.emptyPluginConfigSchema).toBe("function");
    expect(typeof coreSdk.buildOauthProviderAuthResult).toBe("function");
    expect(typeof coreSdk.runPluginCommandWithTimeout).toBe("function");
    expect(typeof coreSdk.resolveGatewayBindUrl).toBe("function");
    expect(typeof coreSdk.resolveTailnetHostWithRunner).toBe("function");

    const forbidden = [
      "resolveControlCommandGate",
      "resolveSenderCommandAuthorization",
      "handleSlackMessageAction",
      "extractToolSend",
    ];
    for (const key of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(coreSdk, key)).toBe(false);
    }
  });

  it("exports Discord helpers", () => {
    expect(typeof discordSdk.resolveDiscordAccount).toBe("function");
    expect(typeof discordSdk.inspectDiscordAccount).toBe("function");
    expect(typeof discordSdk.discordOnboardingAdapter).toBe("object");
  });

  it("exports Slack helpers", () => {
    expect(typeof slackSdk.resolveSlackAccount).toBe("function");
    expect(typeof slackSdk.inspectSlackAccount).toBe("function");
    expect(typeof slackSdk.handleSlackMessageAction).toBe("function");
  });

  it("exports Telegram helpers", () => {
    expect(typeof telegramSdk.resolveTelegramAccount).toBe("function");
    expect(typeof telegramSdk.inspectTelegramAccount).toBe("function");
    expect(typeof telegramSdk.telegramOnboardingAdapter).toBe("object");
  });

  it("exports Signal helpers", () => {
    expect(typeof signalSdk.resolveSignalAccount).toBe("function");
    expect(typeof signalSdk.signalOnboardingAdapter).toBe("object");
  });

  it("exports iMessage helpers", () => {
    expect(typeof imessageSdk.resolveIMessageAccount).toBe("function");
    expect(typeof imessageSdk.imessageOnboardingAdapter).toBe("object");
  });

  it("exports WhatsApp helpers", () => {
    expect(typeof whatsappSdk.resolveWhatsAppAccount).toBe("function");
    expect(typeof whatsappSdk.whatsappOnboardingAdapter).toBe("object");
  });

  it("exports LINE helpers", () => {
    expect(typeof lineSdk.processLineMessage).toBe("function");
    expect(typeof lineSdk.createInfoCard).toBe("function");
  });

  it("exports Microsoft Teams helpers", () => {
    expect(typeof msteamsSdk.resolveControlCommandGate).toBe("function");
    expect(typeof msteamsSdk.loadOutboundMediaFromUrl).toBe("function");
  });

  it("exports account id helpers", () => {
    expect(typeof accountIdSdk.normalizeAccountId).toBe("function");
    expect(typeof accountIdSdk.normalizeOptionalAccountId).toBe("function");
  });

  it("exports keyed async queue helpers", () => {
    expect(typeof keyedAsyncQueueSdk.enqueueKeyedTask).toBe("function");
    expect(typeof keyedAsyncQueueSdk.KeyedAsyncQueue).toBe("function");
  });

  it("resolves bundled extension subpaths", async () => {
    for (const entry of pluginSdkScopedExportEntries) {
      if (directlyImportedSubpaths.has(entry.packageSubpath)) {
        continue;
      }

      const mod = await import(entry.packageSubpath.replace(/^\.\//u, "openclaw/"));
      expect(typeof mod).toBe("object");
      expect(mod, `subpath ${entry.entryName} should resolve`).toBeTruthy();
    }
  });
});
