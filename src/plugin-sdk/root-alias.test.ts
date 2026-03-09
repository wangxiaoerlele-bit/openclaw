import { createRequire } from "node:module";
import * as compatSdk from "openclaw/plugin-sdk/compat";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const rootAliasPath = require.resolve("./root-alias.cjs");

function loadFreshRootSdk(): Record<string, unknown> {
  delete require.cache[rootAliasPath];
  return require(rootAliasPath) as Record<string, unknown>;
}

type EmptySchema = {
  safeParse: (value: unknown) =>
    | { success: true; data?: unknown }
    | {
        success: false;
        error: { issues: Array<{ path: Array<string | number>; message: string }> };
      };
};

describe("plugin-sdk root alias", () => {
  it("exposes the fast empty config schema helper", () => {
    const rootSdk = loadFreshRootSdk();
    const factory = rootSdk.emptyPluginConfigSchema as (() => EmptySchema) | undefined;
    expect(typeof factory).toBe("function");
    if (!factory) {
      return;
    }
    const schema = factory();
    expect(schema.safeParse(undefined)).toEqual({ success: true, data: undefined });
    expect(schema.safeParse({})).toEqual({ success: true, data: {} });
    const parsed = schema.safeParse({ invalid: true });
    expect(parsed.success).toBe(false);
  });

  it("keeps the eager proxy surface limited before the monolithic sdk is loaded", () => {
    const rootSdk = loadFreshRootSdk();
    expect(Object.keys(rootSdk).toSorted()).toEqual([
      "emptyPluginConfigSchema",
      "resolveControlCommandGate",
    ]);
  });

  it("keeps the fast emptyPluginConfigSchema helper aligned with compat exports", () => {
    const rootSdk = loadFreshRootSdk();
    const buildSchema = rootSdk.emptyPluginConfigSchema as typeof compatSdk.emptyPluginConfigSchema;
    const rootSchema = buildSchema() as EmptySchema;
    const compatSchema = compatSdk.emptyPluginConfigSchema() as EmptySchema;

    for (const value of [undefined, {}, { invalid: true }, [], "text"]) {
      expect(rootSchema.safeParse(value)).toEqual(compatSchema.safeParse(value));
    }
  });

  it("keeps the fast resolveControlCommandGate helper aligned with compat exports", () => {
    const rootSdk = loadFreshRootSdk();
    const resolveGate =
      rootSdk.resolveControlCommandGate as typeof compatSdk.resolveControlCommandGate;
    const params: Parameters<typeof compatSdk.resolveControlCommandGate>[0] = {
      allowTextCommands: true,
      hasControlCommand: true,
      useAccessGroups: false,
      modeWhenAccessGroupsOff: "configured",
      authorizers: [
        { configured: false, allowed: false },
        { configured: true, allowed: false },
      ],
    };

    expect(resolveGate(params)).toEqual(compatSdk.resolveControlCommandGate(params));
  });

  it("loads legacy root exports lazily through the proxy", { timeout: 240_000 }, () => {
    const rootSdk = loadFreshRootSdk();
    expect(typeof rootSdk.resolveControlCommandGate).toBe("function");
    expect(typeof rootSdk.default).toBe("object");
    expect(rootSdk.default).toBe(rootSdk);
    expect(rootSdk.__esModule).toBe(true);
  });

  it("preserves reflection semantics for lazily resolved exports", { timeout: 240_000 }, () => {
    const rootSdk = loadFreshRootSdk();
    expect("resolveControlCommandGate" in rootSdk).toBe(true);
    const keys = Object.keys(rootSdk);
    expect(keys).toContain("resolveControlCommandGate");
    const descriptor = Object.getOwnPropertyDescriptor(rootSdk, "resolveControlCommandGate");
    expect(descriptor).toBeDefined();
  });
});
