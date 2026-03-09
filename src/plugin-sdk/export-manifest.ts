type PluginSdkExportEntry = {
  packageSubpath: `./plugin-sdk${string}`;
  entryName: string;
  srcFile: `${string}.ts`;
  distFile: `${string}.js`;
};

export const pluginSdkExportEntries = [
  { packageSubpath: "./plugin-sdk", entryName: "index", srcFile: "index.ts", distFile: "index.js" },
  {
    packageSubpath: "./plugin-sdk/core",
    entryName: "core",
    srcFile: "core.ts",
    distFile: "core.js",
  },
  {
    packageSubpath: "./plugin-sdk/compat",
    entryName: "compat",
    srcFile: "compat.ts",
    distFile: "compat.js",
  },
  {
    packageSubpath: "./plugin-sdk/telegram",
    entryName: "telegram",
    srcFile: "telegram.ts",
    distFile: "telegram.js",
  },
  {
    packageSubpath: "./plugin-sdk/discord",
    entryName: "discord",
    srcFile: "discord.ts",
    distFile: "discord.js",
  },
  {
    packageSubpath: "./plugin-sdk/slack",
    entryName: "slack",
    srcFile: "slack.ts",
    distFile: "slack.js",
  },
  {
    packageSubpath: "./plugin-sdk/signal",
    entryName: "signal",
    srcFile: "signal.ts",
    distFile: "signal.js",
  },
  {
    packageSubpath: "./plugin-sdk/imessage",
    entryName: "imessage",
    srcFile: "imessage.ts",
    distFile: "imessage.js",
  },
  {
    packageSubpath: "./plugin-sdk/whatsapp",
    entryName: "whatsapp",
    srcFile: "whatsapp.ts",
    distFile: "whatsapp.js",
  },
  {
    packageSubpath: "./plugin-sdk/line",
    entryName: "line",
    srcFile: "line.ts",
    distFile: "line.js",
  },
  {
    packageSubpath: "./plugin-sdk/msteams",
    entryName: "msteams",
    srcFile: "msteams.ts",
    distFile: "msteams.js",
  },
  {
    packageSubpath: "./plugin-sdk/acpx",
    entryName: "acpx",
    srcFile: "acpx.ts",
    distFile: "acpx.js",
  },
  {
    packageSubpath: "./plugin-sdk/bluebubbles",
    entryName: "bluebubbles",
    srcFile: "bluebubbles.ts",
    distFile: "bluebubbles.js",
  },
  {
    packageSubpath: "./plugin-sdk/copilot-proxy",
    entryName: "copilot-proxy",
    srcFile: "copilot-proxy.ts",
    distFile: "copilot-proxy.js",
  },
  {
    packageSubpath: "./plugin-sdk/device-pair",
    entryName: "device-pair",
    srcFile: "device-pair.ts",
    distFile: "device-pair.js",
  },
  {
    packageSubpath: "./plugin-sdk/diagnostics-otel",
    entryName: "diagnostics-otel",
    srcFile: "diagnostics-otel.ts",
    distFile: "diagnostics-otel.js",
  },
  {
    packageSubpath: "./plugin-sdk/diffs",
    entryName: "diffs",
    srcFile: "diffs.ts",
    distFile: "diffs.js",
  },
  {
    packageSubpath: "./plugin-sdk/feishu",
    entryName: "feishu",
    srcFile: "feishu.ts",
    distFile: "feishu.js",
  },
  {
    packageSubpath: "./plugin-sdk/google-gemini-cli-auth",
    entryName: "google-gemini-cli-auth",
    srcFile: "google-gemini-cli-auth.ts",
    distFile: "google-gemini-cli-auth.js",
  },
  {
    packageSubpath: "./plugin-sdk/googlechat",
    entryName: "googlechat",
    srcFile: "googlechat.ts",
    distFile: "googlechat.js",
  },
  { packageSubpath: "./plugin-sdk/irc", entryName: "irc", srcFile: "irc.ts", distFile: "irc.js" },
  {
    packageSubpath: "./plugin-sdk/llm-task",
    entryName: "llm-task",
    srcFile: "llm-task.ts",
    distFile: "llm-task.js",
  },
  {
    packageSubpath: "./plugin-sdk/lobster",
    entryName: "lobster",
    srcFile: "lobster.ts",
    distFile: "lobster.js",
  },
  {
    packageSubpath: "./plugin-sdk/matrix",
    entryName: "matrix",
    srcFile: "matrix.ts",
    distFile: "matrix.js",
  },
  {
    packageSubpath: "./plugin-sdk/mattermost",
    entryName: "mattermost",
    srcFile: "mattermost.ts",
    distFile: "mattermost.js",
  },
  {
    packageSubpath: "./plugin-sdk/memory-core",
    entryName: "memory-core",
    srcFile: "memory-core.ts",
    distFile: "memory-core.js",
  },
  {
    packageSubpath: "./plugin-sdk/memory-lancedb",
    entryName: "memory-lancedb",
    srcFile: "memory-lancedb.ts",
    distFile: "memory-lancedb.js",
  },
  {
    packageSubpath: "./plugin-sdk/minimax-portal-auth",
    entryName: "minimax-portal-auth",
    srcFile: "minimax-portal-auth.ts",
    distFile: "minimax-portal-auth.js",
  },
  {
    packageSubpath: "./plugin-sdk/nextcloud-talk",
    entryName: "nextcloud-talk",
    srcFile: "nextcloud-talk.ts",
    distFile: "nextcloud-talk.js",
  },
  {
    packageSubpath: "./plugin-sdk/nostr",
    entryName: "nostr",
    srcFile: "nostr.ts",
    distFile: "nostr.js",
  },
  {
    packageSubpath: "./plugin-sdk/open-prose",
    entryName: "open-prose",
    srcFile: "open-prose.ts",
    distFile: "open-prose.js",
  },
  {
    packageSubpath: "./plugin-sdk/phone-control",
    entryName: "phone-control",
    srcFile: "phone-control.ts",
    distFile: "phone-control.js",
  },
  {
    packageSubpath: "./plugin-sdk/qwen-portal-auth",
    entryName: "qwen-portal-auth",
    srcFile: "qwen-portal-auth.ts",
    distFile: "qwen-portal-auth.js",
  },
  {
    packageSubpath: "./plugin-sdk/synology-chat",
    entryName: "synology-chat",
    srcFile: "synology-chat.ts",
    distFile: "synology-chat.js",
  },
  {
    packageSubpath: "./plugin-sdk/talk-voice",
    entryName: "talk-voice",
    srcFile: "talk-voice.ts",
    distFile: "talk-voice.js",
  },
  {
    packageSubpath: "./plugin-sdk/test-utils",
    entryName: "test-utils",
    srcFile: "test-utils.ts",
    distFile: "test-utils.js",
  },
  {
    packageSubpath: "./plugin-sdk/thread-ownership",
    entryName: "thread-ownership",
    srcFile: "thread-ownership.ts",
    distFile: "thread-ownership.js",
  },
  {
    packageSubpath: "./plugin-sdk/tlon",
    entryName: "tlon",
    srcFile: "tlon.ts",
    distFile: "tlon.js",
  },
  {
    packageSubpath: "./plugin-sdk/twitch",
    entryName: "twitch",
    srcFile: "twitch.ts",
    distFile: "twitch.js",
  },
  {
    packageSubpath: "./plugin-sdk/voice-call",
    entryName: "voice-call",
    srcFile: "voice-call.ts",
    distFile: "voice-call.js",
  },
  {
    packageSubpath: "./plugin-sdk/zalo",
    entryName: "zalo",
    srcFile: "zalo.ts",
    distFile: "zalo.js",
  },
  {
    packageSubpath: "./plugin-sdk/zalouser",
    entryName: "zalouser",
    srcFile: "zalouser.ts",
    distFile: "zalouser.js",
  },
  {
    packageSubpath: "./plugin-sdk/account-id",
    entryName: "account-id",
    srcFile: "account-id.ts",
    distFile: "account-id.js",
  },
  {
    packageSubpath: "./plugin-sdk/keyed-async-queue",
    entryName: "keyed-async-queue",
    srcFile: "keyed-async-queue.ts",
    distFile: "keyed-async-queue.js",
  },
] as const satisfies readonly PluginSdkExportEntry[];

export type PluginSdkEntryName = (typeof pluginSdkExportEntries)[number]["entryName"];

export type PluginSdkScopedExportEntry = Extract<
  (typeof pluginSdkExportEntries)[number],
  { packageSubpath: `./plugin-sdk/${string}` }
>;

export const pluginSdkEntryNames = pluginSdkExportEntries.map((entry) => entry.entryName);

export const pluginSdkScopedExportEntries = pluginSdkExportEntries.filter(
  (entry): entry is PluginSdkScopedExportEntry => entry.packageSubpath !== "./plugin-sdk",
);

export function buildPluginSdkPackageExports(): Record<
  (typeof pluginSdkExportEntries)[number]["packageSubpath"],
  { types: string; default: string }
> {
  return Object.fromEntries(
    pluginSdkExportEntries.map((entry) => [
      entry.packageSubpath,
      {
        types: `./dist/plugin-sdk/${entry.entryName}.d.ts`,
        default: `./dist/plugin-sdk/${entry.entryName}.js`,
      },
    ]),
  ) as Record<
    (typeof pluginSdkExportEntries)[number]["packageSubpath"],
    { types: string; default: string }
  >;
}
