import { tool } from "ai";
import { z } from "zod";
import { HttpError } from "./http.ts";
import type { MateToolEnv } from "./types.ts";
import { CloudflareWebSearchError, searchCloudflareExa } from "../../../../src/shared/cloudflareWebSearch.ts";

const MAX_WEB_BODY_BYTES = 3_000_000;
const MAX_WEB_TEXT_CHARACTERS = 100_000;
const MAX_REDIRECTS = 4;

type WebFetchDeps = {
  fetch?: typeof fetch;
  now?: () => Date;
};

export function createWorkspaceWebTools(env: MateToolEnv) {
  return {
    web_search: tool({
      description: "搜索公开互联网，返回网页标题、URL、简介和已知更新时间。适合外部事实、新闻、市场、产品文档或时效性信息；企业内部事实仍应优先查询 Workspace 知识库。搜索结果只是线索，重要结论应继续调用 web_fetch 阅读原页。",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(10).default(5),
        query: z.string().trim().min(1).max(500)
      }),
      execute: async ({ limit, query }) => searchPublicWeb(env, query, limit)
    }),
    web_fetch: tool({
      description: "读取一个公开 http/https 网页或 PDF，并转换为适合分析和引用的 Markdown/文本。必须使用 web_search 返回或用户明确提供的公开 URL；会阻止本地、内网和不安全地址。",
      inputSchema: z.object({
        url: z.string().url().max(2_048)
      }),
      execute: async ({ url }, options) => fetchPublicWeb(env, url, {
        signal: options.abortSignal
      })
    })
  };
}

export async function searchPublicWeb(env: MateToolEnv, query: string, limit = 5) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new HttpError(400, "web_search_query_required");
  try {
    return await searchCloudflareExa(env.AI, normalizedQuery.slice(0, 500), Math.max(1, Math.min(10, Math.trunc(limit))));
  } catch (error) {
    if (error instanceof CloudflareWebSearchError) throw new HttpError(error.status, error.code);
    throw error;
  }
}

export async function fetchPublicWeb(
  env: MateToolEnv,
  inputUrl: string,
  options: { signal?: AbortSignal } = {},
  deps: WebFetchDeps = {}
) {
  let url = requirePublicUrl(inputUrl);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    response = await (deps.fetch ?? fetch)(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,application/json,application/xml;q=0.9,*/*;q=0.2",
        "User-Agent": "Workspace-Mate-Runtime/1.0"
      },
      redirect: "manual",
      signal: options.signal
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirect === MAX_REDIRECTS) throw new HttpError(502, "web_fetch_redirect_invalid");
    url = requirePublicUrl(new URL(location, url).toString());
  }
  if (!response) throw new HttpError(502, "web_fetch_failed");
  if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, "web_fetch_upstream_failed");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEB_BODY_BYTES) {
    throw new HttpError(413, "web_fetch_body_too_large");
  }
  const bytes = await readLimitedBody(response, MAX_WEB_BODY_BYTES);
  const contentType = (response.headers.get("content-type") ?? "application/octet-stream")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const title = headerTitle(response.headers) || url.hostname;
  let content: string;
  let format: "markdown" | "text";
  if (isPlainWebContent(contentType)) {
    content = new TextDecoder().decode(bytes);
    format = "text";
  } else if (isConvertibleWebContent(contentType)) {
    if (!env.AI) throw new HttpError(503, "workers_ai_not_configured");
    const name = webDocumentName(url, contentType);
    const converted = await env.AI.toMarkdown(
      { blob: new Blob([bytes], { type: contentType }), name },
      {
        conversionOptions: {
          html: contentType.includes("html") ? { hostname: url.origin } : undefined,
          pdf: contentType === "application/pdf" ? { metadata: false } : undefined
        }
      }
    );
    if (converted.format === "error") throw new HttpError(502, "web_fetch_conversion_failed");
    content = converted.data;
    format = "markdown";
  } else {
    throw new HttpError(415, "web_fetch_content_type_unsupported");
  }
  const trimmed = content.trim();
  return {
    content: trimmed.slice(0, MAX_WEB_TEXT_CHARACTERS),
    contentType,
    fetchedAt: (deps.now?.() ?? new Date()).toISOString(),
    format,
    title: titleFromContent(trimmed, title),
    truncated: trimmed.length > MAX_WEB_TEXT_CHARACTERS,
    url: url.toString()
  };
}

function requirePublicUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, "web_fetch_url_invalid"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new HttpError(400, "web_fetch_url_invalid");
  }
  if ((url.protocol === "http:" && url.port && url.port !== "80") || (url.protocol === "https:" && url.port && url.port !== "443")) {
    throw new HttpError(400, "web_fetch_port_not_allowed");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || isPrivateHostname(hostname)) throw new HttpError(403, "web_fetch_private_address_blocked");
  url.hash = "";
  return url;
}

function isPrivateHostname(hostname: string) {
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname === "metadata.google.internal"
    || hostname.includes(":")
  ) return true;
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

async function readLimitedBody(response: Response, limit: number) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new HttpError(413, "web_fetch_body_too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isPlainWebContent(value: string | undefined) {
  return Boolean(value?.startsWith("text/plain"))
    || value === "application/json"
    || value === "application/xml"
    || value === "text/csv"
    || value === "text/markdown";
}

function isConvertibleWebContent(value: string | undefined) {
  return value === "application/pdf"
    || value === "application/xhtml+xml"
    || value === "text/html";
}

function webDocumentName(url: URL, contentType: string | undefined) {
  const leaf = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "").slice(0, 120);
  if (leaf && /\.[a-z0-9]{1,8}$/i.test(leaf)) return leaf;
  return contentType === "application/pdf" ? "document.pdf" : "page.html";
}

function headerTitle(headers: Headers) {
  return headers.get("x-document-title")?.trim() || "";
}

function titleFromContent(content: string, fallback: string) {
  const markdownHeading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return markdownHeading?.slice(0, 300) || fallback;
}
