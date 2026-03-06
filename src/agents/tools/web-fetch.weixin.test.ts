import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";

const browserClientMocks = vi.hoisted(() => ({
  browserOpenTab: vi.fn(async () => ({
    targetId: "wx-tab",
    title: "",
    url: "https://mp.weixin.qq.com/s/example",
  })),
  browserCloseTab: vi.fn(async () => {}),
}));

const browserActionsMocks = vi.hoisted(() => ({
  browserNavigate: vi.fn(async (_baseUrl: unknown, opts: { targetId?: string; url: string }) => ({
    ok: true,
    targetId: opts.targetId ?? "wx-tab",
    url: opts.url,
  })),
  browserAct: vi.fn(
    async (): Promise<{ ok: boolean; targetId: string; result?: unknown }> => ({
      ok: true,
      targetId: "wx-tab",
    }),
  ),
}));

vi.mock("../../browser/client.js", () => browserClientMocks);
vi.mock("../../browser/client-actions.js", () => browserActionsMocks);

import { createWebFetchTool } from "./web-tools.js";

function makeHeaders(map: Record<string, string>): { get: (key: string) => string | null } {
  return {
    get: (key) => map[key.toLowerCase()] ?? null,
  };
}

function installMockFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const mockFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => await impl(input, init),
  );
  global.fetch = withFetchPreconnect(mockFetch);
  return mockFetch;
}

function htmlResponse(html: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: makeHeaders({ "content-type": "text/html; charset=utf-8" }),
    text: async () => html,
  } as Response;
}

function createFetchTool(fetchOverrides: Record<string, unknown> = {}) {
  return createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: 0,
            ...fetchOverrides,
          },
        },
      },
    },
    sandboxed: false,
  });
}

describe("web_fetch weixin extraction", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation(async (hostname) => {
      const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
      const addresses = ["93.184.216.34", "93.184.216.35"];
      return {
        hostname: normalized,
        addresses,
        lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses }),
      };
    });
  });

  afterEach(() => {
    global.fetch = priorFetch;
    vi.restoreAllMocks();
    browserClientMocks.browserOpenTab.mockReset();
    browserClientMocks.browserCloseTab.mockReset();
    browserActionsMocks.browserNavigate.mockReset();
    browserActionsMocks.browserAct.mockReset();
  });

  it("extracts WeChat article content from html without browser fallback", async () => {
    const html = `<!doctype html>
<html>
  <head>
    <title>Fallback Title</title>
    <meta property="og:url" content="https://mp.weixin.qq.com/s/example" />
  </head>
  <body>
    <h1 id="activity-name">微信文章标题</h1>
    <a id="js_name">Lanmei</a>
    <em id="publish_time">2026-03-04</em>
    <div id="js_content"><p>这是正文第一段。</p><p>这是正文第二段。</p></div>
  </body>
</html>`;
    installMockFetch(async () => htmlResponse(html, 200));
    const tool = createFetchTool({
      readability: false,
      firecrawl: { enabled: false },
    });

    const result = await tool?.execute?.("call", {
      url: "https://mp.weixin.qq.com/s/example",
      extractMode: "text",
    });
    const details = result?.details as
      | {
          extractor?: string;
          text?: string;
          title?: string;
          author?: string;
          publishTime?: string;
        }
      | undefined;
    expect(details?.extractor).toBe("weixin-html");
    expect(details?.text).toContain("这是正文第一段");
    expect(details?.title).toContain("微信文章标题");
    expect(details?.author).toContain("Lanmei");
    expect(details?.publishTime).toContain("2026-03-04");
    expect(browserClientMocks.browserOpenTab).not.toHaveBeenCalled();
  });

  it("falls back to browser extraction for blocked WeChat responses", async () => {
    installMockFetch(async () => htmlResponse("<html><body>blocked</body></html>", 403));
    browserClientMocks.browserOpenTab.mockResolvedValueOnce({
      targetId: "wx-tab",
      title: "",
      url: "https://mp.weixin.qq.com/s/example",
    });
    browserActionsMocks.browserNavigate.mockResolvedValueOnce({
      ok: true,
      targetId: "wx-tab",
      url: "https://mp.weixin.qq.com/s/example",
    });
    browserActionsMocks.browserAct
      .mockResolvedValueOnce({
        ok: true,
        targetId: "wx-tab",
      })
      .mockResolvedValueOnce({
        ok: true,
        targetId: "wx-tab",
      })
      .mockResolvedValueOnce({
        ok: true,
        targetId: "wx-tab",
        result: {
          title: "浏览器提取标题",
          author: "Lanmei",
          publishTime: "2026-03-04",
          contentHtml: "<p>浏览器提取正文。</p>",
          finalUrl: "https://mp.weixin.qq.com/s/example",
        },
      });

    const tool = createFetchTool({
      firecrawl: { enabled: false },
    });
    const result = await tool?.execute?.("call", {
      url: "https://mp.weixin.qq.com/s/example",
      extractMode: "markdown",
    });
    const details = result?.details as
      | {
          status?: number;
          extractor?: string;
          contentType?: string;
          text?: string;
          author?: string;
        }
      | undefined;
    expect(details).toMatchObject({
      status: 403,
      extractor: "weixin-browser",
      contentType: "text/markdown",
    });
    expect(details?.text).toContain("浏览器提取正文");
    expect(details?.author).toContain("Lanmei");
    expect(browserClientMocks.browserOpenTab).toHaveBeenCalledTimes(1);
    expect(browserClientMocks.browserCloseTab).toHaveBeenCalledTimes(1);
  });
});
