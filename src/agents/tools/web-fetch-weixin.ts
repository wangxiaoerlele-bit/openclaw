import { browserAct, browserNavigate } from "../../browser/client-actions.js";
import { browserCloseTab, browserOpenTab } from "../../browser/client.js";
import { htmlToMarkdown, markdownToText, type ExtractMode } from "./web-fetch-utils.js";
import { stripInvisibleUnicode } from "./web-fetch-visibility.js";

const WEIXIN_ARTICLE_HOST = "mp.weixin.qq.com";
const WEIXIN_BROWSER_PROFILE = "openclaw";
const WEIXIN_BROWSER_SETTLE_MS = 800;

export type WeixinExtractedArticle = {
  text: string;
  title?: string;
  author?: string;
  publishTime?: string;
  finalUrl?: string;
  extractor: "weixin-html" | "weixin-browser";
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value: string): string {
  return stripInvisibleUnicode(
    decodeEntities(value)
      .replace(/\r/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)));
}

function parseUrlOrNull(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

export function isWeixinArticleUrl(rawUrl: string): boolean {
  const parsed = parseUrlOrNull(rawUrl);
  if (!parsed) {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return false;
  }
  return parsed.hostname.trim().toLowerCase().replace(/\.$/, "") === WEIXIN_ARTICLE_HOST;
}

function extractByIdInnerHtml(html: string, id: string): string | undefined {
  const idPattern = escapeRegExp(id);
  const pattern = new RegExp(
    `<([a-z0-9:_-]+)\\b[^>]*\\bid\\s*=\\s*["']${idPattern}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    "i",
  );
  const match = pattern.exec(html);
  return match?.[2];
}

function extractTagText(html: string, tagName: string): string | undefined {
  const tag = escapeRegExp(tagName);
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = pattern.exec(html);
  if (!match?.[1]) {
    return undefined;
  }
  const text = normalizeText(stripTags(match[1]));
  return text || undefined;
}

function extractMetaContent(
  html: string,
  key: string,
  attr: "property" | "name",
): string | undefined {
  const escapedKey = escapeRegExp(key);
  const forwardPattern = new RegExp(
    `<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${escapedKey}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*>`,
    "i",
  );
  const reversePattern = new RegExp(
    `<meta\\b[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\b${attr}\\s*=\\s*["']${escapedKey}["'][^>]*>`,
    "i",
  );
  const match = forwardPattern.exec(html) ?? reversePattern.exec(html);
  if (!match?.[1]) {
    return undefined;
  }
  const text = normalizeText(match[1]);
  return text || undefined;
}

function extractTextFromId(html: string, id: string): string | undefined {
  const inner = extractByIdInnerHtml(html, id);
  if (!inner) {
    return undefined;
  }
  const text = normalizeText(stripTags(inner));
  return text || undefined;
}

function parseWeixinTimestamp(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d{9,13}$/.test(trimmed)) {
    const unix = Number.parseInt(trimmed, 10);
    if (Number.isFinite(unix) && unix > 0) {
      const ms = trimmed.length > 10 ? unix : unix * 1000;
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
  }
  return trimmed;
}

function buildWeixinArticleFromParts(params: {
  contentHtml: string;
  title?: string;
  author?: string;
  publishTime?: string;
  url: string;
  finalUrl?: string;
  extractMode: ExtractMode;
  extractor: "weixin-html" | "weixin-browser";
}): WeixinExtractedArticle | null {
  const rendered = htmlToMarkdown(params.contentHtml);
  const bodyMarkdown = rendered.text.trim();
  if (!bodyMarkdown) {
    return null;
  }

  const title = params.title?.trim() || rendered.title?.trim() || undefined;
  const author = params.author?.trim() || undefined;
  const publishTime = parseWeixinTimestamp(params.publishTime);
  const sourceUrl = params.finalUrl || params.url;

  const lines: string[] = [];
  if (title) {
    lines.push(`# ${title}`, "");
  }
  if (author) {
    lines.push(`Author: ${author}`);
  }
  if (publishTime) {
    lines.push(`Published: ${publishTime}`);
  }
  lines.push(`Source: ${sourceUrl}`, "", bodyMarkdown);

  const markdown = normalizeText(lines.join("\n"));
  const text = params.extractMode === "text" ? markdownToText(markdown) : markdown;
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return null;
  }

  return {
    text: normalizedText,
    title,
    author,
    publishTime,
    finalUrl: params.finalUrl,
    extractor: params.extractor,
  };
}

export function extractWeixinArticleFromHtml(params: {
  html: string;
  url: string;
  extractMode: ExtractMode;
}): WeixinExtractedArticle | null {
  const contentHtml = extractByIdInnerHtml(params.html, "js_content");
  if (!contentHtml) {
    return null;
  }

  const title =
    extractTextFromId(params.html, "activity-name") ||
    extractMetaContent(params.html, "og:title", "property") ||
    extractTagText(params.html, "title");
  const author = extractTextFromId(params.html, "js_name");
  const publishTime =
    extractTextFromId(params.html, "publish_time") ||
    parseWeixinTimestamp(/\bct\s*=\s*["']?(\d{9,13})["']?/i.exec(params.html)?.[1] ?? undefined);
  const canonical =
    extractMetaContent(params.html, "og:url", "property") ||
    extractMetaContent(params.html, "twitter:url", "name");

  return buildWeixinArticleFromParts({
    contentHtml,
    title,
    author,
    publishTime,
    url: params.url,
    finalUrl: canonical || undefined,
    extractMode: params.extractMode,
    extractor: "weixin-html",
  });
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

const WEIXIN_BROWSER_EXTRACT_FN = `() => {
  const clean = (value) => {
    if (typeof value !== "string") return "";
    return value
      .replace(/\\u00a0/g, " ")
      .replace(/\\r/g, "")
      .replace(/[ \\t]+\\n/g, "\\n")
      .replace(/\\n{3,}/g, "\\n\\n")
      .replace(/[ \\t]{2,}/g, " ")
      .trim();
  };
  const textOf = (selector) => {
    const el = document.querySelector(selector);
    return clean(el && typeof el.textContent === "string" ? el.textContent : "");
  };
  const htmlOf = (selector) => {
    const el = document.querySelector(selector);
    return el && typeof el.innerHTML === "string" ? el.innerHTML : "";
  };
  const meta = (key, attr) => {
    const selector = 'meta[' + attr + '="' + key + '"]';
    const el = document.querySelector(selector);
    const content = el ? el.getAttribute("content") : "";
    return clean(content || "");
  };
  return {
    title: textOf("#activity-name") || meta("og:title", "property") || clean(document.title || ""),
    author: textOf("#js_name"),
    publishTime: textOf("#publish_time"),
    publishTimestamp:
      typeof window.ct === "number" || typeof window.ct === "string" ? String(window.ct) : "",
    contentHtml: htmlOf("#js_content"),
    html: document.documentElement && document.documentElement.outerHTML
      ? String(document.documentElement.outerHTML)
      : "",
    finalUrl: typeof location.href === "string" ? location.href : "",
  };
}`;

export async function fetchWeixinArticleViaBrowser(params: {
  url: string;
  extractMode: ExtractMode;
  timeoutMs: number;
}): Promise<WeixinExtractedArticle | null> {
  if (!isWeixinArticleUrl(params.url)) {
    return null;
  }

  let targetId: string | undefined;
  try {
    const opened = await browserOpenTab(undefined, params.url, {
      profile: WEIXIN_BROWSER_PROFILE,
    });
    targetId = opened.targetId;

    await browserNavigate(undefined, {
      url: params.url,
      targetId,
      profile: WEIXIN_BROWSER_PROFILE,
    });
    await browserAct(
      undefined,
      {
        kind: "wait",
        targetId,
        loadState: "domcontentloaded",
        timeoutMs: params.timeoutMs,
      },
      { profile: WEIXIN_BROWSER_PROFILE },
    );
    await browserAct(
      undefined,
      {
        kind: "wait",
        targetId,
        timeMs: WEIXIN_BROWSER_SETTLE_MS,
      },
      { profile: WEIXIN_BROWSER_PROFILE },
    );
    const evaluated = await browserAct(
      undefined,
      {
        kind: "evaluate",
        targetId,
        timeoutMs: params.timeoutMs,
        fn: WEIXIN_BROWSER_EXTRACT_FN,
      },
      { profile: WEIXIN_BROWSER_PROFILE },
    );

    const evaluatedPayload = toRecord(evaluated?.result);
    if (!evaluatedPayload) {
      return null;
    }

    const contentHtml = readStringField(evaluatedPayload, "contentHtml") ?? "";
    const finalUrl = readStringField(evaluatedPayload, "finalUrl");
    const publishTime =
      readStringField(evaluatedPayload, "publishTime") ||
      readStringField(evaluatedPayload, "publishTimestamp");
    if (contentHtml.trim()) {
      return buildWeixinArticleFromParts({
        contentHtml,
        title: readStringField(evaluatedPayload, "title"),
        author: readStringField(evaluatedPayload, "author"),
        publishTime,
        url: params.url,
        finalUrl,
        extractMode: params.extractMode,
        extractor: "weixin-browser",
      });
    }

    const html = readStringField(evaluatedPayload, "html");
    if (!html?.trim()) {
      return null;
    }
    const extracted = extractWeixinArticleFromHtml({
      html,
      url: finalUrl || params.url,
      extractMode: params.extractMode,
    });
    if (!extracted) {
      return null;
    }
    return {
      ...extracted,
      finalUrl: finalUrl || extracted.finalUrl,
      extractor: "weixin-browser",
    };
  } catch {
    return null;
  } finally {
    if (targetId) {
      await browserCloseTab(undefined, targetId, { profile: WEIXIN_BROWSER_PROFILE }).catch(
        () => {},
      );
    }
  }
}
