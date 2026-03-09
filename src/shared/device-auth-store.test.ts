import { describe, expect, it, vi } from "vitest";
import {
  clearDeviceAuthTokenFromStore,
  loadDeviceAuthTokenFromStore,
  storeDeviceAuthTokenInStore,
  type DeviceAuthStoreAdapter,
} from "./device-auth-store.js";
import type { DeviceAuthStore } from "./device-auth.js";

function createMemoryAdapter(initialStore: DeviceAuthStore | null = null): {
  adapter: DeviceAuthStoreAdapter;
  read: () => DeviceAuthStore | null;
} {
  let store = initialStore;
  return {
    adapter: {
      readStore: () => store,
      writeStore: (nextStore) => {
        store = nextStore;
      },
    },
    read: () => store,
  };
}

describe("device auth store helpers", () => {
  it("stores normalized scopes and loads by normalized role", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));
    try {
      const { adapter, read } = createMemoryAdapter();
      const stored = storeDeviceAuthTokenInStore({
        adapter,
        deviceId: "dev-1",
        role: " operator ",
        token: "tok-1",
        scopes: [" operator.read ", "operator.admin", "operator.read"],
      });

      expect(stored).toMatchObject({
        token: "tok-1",
        role: "operator",
        scopes: ["operator.admin", "operator.read"],
      });
      expect(
        loadDeviceAuthTokenFromStore({ adapter, deviceId: "dev-1", role: "operator" }),
      ).toEqual(stored);
      expect(read()).toMatchObject({
        version: 1,
        deviceId: "dev-1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not load tokens for a different device id", () => {
    const { adapter } = createMemoryAdapter({
      version: 1,
      deviceId: "dev-1",
      tokens: {
        operator: {
          token: "tok-1",
          role: "operator",
          scopes: ["operator.admin"],
          updatedAtMs: 1,
        },
      },
    });

    expect(loadDeviceAuthTokenFromStore({ adapter, deviceId: "dev-2", role: "operator" })).toBe(
      null,
    );
  });

  it("clears only the requested role token", () => {
    const { adapter, read } = createMemoryAdapter({
      version: 1,
      deviceId: "dev-1",
      tokens: {
        operator: {
          token: "tok-1",
          role: "operator",
          scopes: ["operator.admin"],
          updatedAtMs: 1,
        },
        node: {
          token: "tok-2",
          role: "node",
          scopes: [],
          updatedAtMs: 2,
        },
      },
    });

    clearDeviceAuthTokenFromStore({ adapter, deviceId: "dev-1", role: "operator" });

    expect(read()).toEqual({
      version: 1,
      deviceId: "dev-1",
      tokens: {
        node: {
          token: "tok-2",
          role: "node",
          scopes: [],
          updatedAtMs: 2,
        },
      },
    });
  });
});
