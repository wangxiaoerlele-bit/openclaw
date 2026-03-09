import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../../infra/net/fetch-guard.js", () => ({
  withStrictGuardedFetchMode: (params: Record<string, unknown>) => ({
    ...params,
    mode: "strict",
  }),
  withTrustedEnvProxyGuardedFetchMode: (params: Record<string, unknown>) => ({
    ...params,
    mode: "trusted_env_proxy",
  }),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { resolveCitationRedirectUrl } from "./web-search-citation-redirect.js";

describe("web_search redirect resolution hardening", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("resolves redirects via SSRF-guarded HEAD requests", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com/final",
      release,
    });

    const resolved = await resolveCitationRedirectUrl("https://example.com/start");
    expect(resolved).toBe("https://example.com/final");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/start",
        timeoutMs: 5000,
        init: { method: "HEAD" },
        mode: "strict",
      }),
    );
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.proxy).toBeUndefined();
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("falls back to the original URL when guarded resolution fails", async () => {
    fetchWithSsrFGuardMock.mockRejectedValue(new Error("blocked"));
    await expect(resolveCitationRedirectUrl("https://example.com/start")).resolves.toBe(
      "https://example.com/start",
    );
  });
});
