import type { ForumContext, ForumDeps, ForumEnv, ForumLinkEmbedRecord } from "./types.ts";

const FORUM_LINK_PREVIEW_TIMEOUT_MS = 3000;
const MAX_FORUM_LINK_PREVIEW_BYTES = 160_000;
const MAX_FORUM_LINK_PREVIEW_REDIRECTS = 3;
const MAX_FORUM_LINK_URL_CHARS = 2048;

// Cloudflare fetch does not expose a way to pin the IP address that was checked
// before the request. Fetching only exact, Workspace-controlled trust choices avoids
// a DNS-rebinding gap while still allowing arbitrary public links as static cards.
const FORUM_OPEN_GRAPH_HOST_ALLOWLIST = new Set([
  "mobile.twitter.com",
  "mp.weixin.qq.com",
  "twitter.com",
  "x.com"
]);

const HTML_CONTENT_TYPES = new Set(["application/xhtml+xml", "text/html"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SPECIAL_USE_HOST_SUFFIXES = [
  ".corp",
  ".example",
  ".home",
  ".home.arpa",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localhost",
  ".onion",
  ".test"
];

export async function previewForumLink<TEnv extends ForumEnv>(context: ForumContext<TEnv>, deps: ForumDeps<TEnv>) {
  await deps.resolveCurrentUser(context);
  const rawUrl = new URL(context.request.url).searchParams.get("url") ?? "";
  return { preview: await resolveForumLinkEmbed(rawUrl, deps) };
}

export async function sanitizeForumLinkEmbeds<TEnv extends ForumEnv>(value: unknown, deps: ForumDeps<TEnv>): Promise<ForumLinkEmbedRecord[]> {
  if (!Array.isArray(value)) {
    return [];
  }

  const rawUrl = value.map((item) => readString(item).trim()).find(Boolean);
  return rawUrl ? [await resolveForumLinkEmbed(rawUrl, deps)] : [];
}

export async function resolveForumLinkEmbed<TEnv extends ForumEnv>(value: string, deps: ForumDeps<TEnv>): Promise<ForumLinkEmbedRecord> {
  const url = parseForumLinkUrl(value, deps);
  const fallback = buildForumLinkEmbed(url);

  if (fallback.embedType === "video" || !canFetchForumOpenGraph(url)) {
    return fallback;
  }

  const openGraph = await fetchOpenGraphPreview(url, deps);
  const title = openGraph.title ?? fallback.title;
  const description = openGraph.description ?? fallback.description;

  return {
    ...fallback,
    provider: fallback.provider || openGraph.siteName || url.hostname,
    title: title.slice(0, 180),
    description: description.slice(0, 280),
    previewImageUrl: openGraph.imageUrl ?? fallback.previewImageUrl
  };
}

export function buildForumLinkEmbed(url: URL): ForumLinkEmbedRecord {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const youtubeId = readYouTubeVideoId(url);

  if (youtubeId) {
    return {
      url: url.toString(),
      provider: "YouTube",
      title: "YouTube video",
      description: "Embedded video shared with this topic.",
      previewImageUrl: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
      embedType: "video"
    };
  }

  if (host === "mp.weixin.qq.com") {
    return {
      url: url.toString(),
      provider: "WeChat Official Account",
      title: "WeChat article",
      description: "Official account article shared with this topic.",
      embedType: "link"
    };
  }

  if (host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com") {
    const author = readXAuthor(url);

    return {
      url: url.toString(),
      provider: "X",
      title: author ? `@${author} on X` : "X post",
      description: "Shared social post referenced by this topic.",
      embedType: "social"
    };
  }

  return {
    url: url.toString(),
    provider: host || "Link",
    title: host || "Shared link",
    description: url.toString(),
    embedType: "link"
  };
}

async function fetchOpenGraphPreview<TEnv extends ForumEnv>(url: URL, deps: ForumDeps<TEnv>) {
  const fetchPreview = deps.fetchForumLinkPreview ?? fetch;
  const controller = new AbortController();
  const configuredTimeout = deps.forumLinkPreviewTimeoutMs ?? FORUM_LINK_PREVIEW_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.min(FORUM_LINK_PREVIEW_TIMEOUT_MS, Math.max(1, Math.floor(configuredTimeout)))
    : FORUM_LINK_PREVIEW_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = url;

    for (let redirectCount = 0; redirectCount <= MAX_FORUM_LINK_PREVIEW_REDIRECTS; redirectCount += 1) {
      const response = await fetchPreview(currentUrl.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "WorkspaceForumBot/1.0 (+https://frontier-workspace.pages.dev)"
        }
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await cancelResponseBody(response);

        if (!location || redirectCount === MAX_FORUM_LINK_PREVIEW_REDIRECTS) {
          return {};
        }

        const redirectUrl = safeForumLinkUrl(location, currentUrl);

        if (!redirectUrl || !canFetchForumOpenGraph(redirectUrl)) {
          return {};
        }

        currentUrl = redirectUrl;
        continue;
      }

      if (!response.ok) {
        await cancelResponseBody(response);
        return {};
      }

      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

      if (!HTML_CONTENT_TYPES.has(contentType)) {
        await cancelResponseBody(response);
        return {};
      }

      const html = await readResponseText(response, MAX_FORUM_LINK_PREVIEW_BYTES);

      if (html === undefined) {
        return {};
      }

      const image = readMetaContent(html, ["og:image", "twitter:image", "twitter:image:src"]);
      const imageUrl = image ? safeAbsoluteUrl(image, currentUrl) : undefined;

      return {
        title: readMetaContent(html, ["og:title", "twitter:title"]) ?? readTitleTag(html),
        description: readMetaContent(html, ["og:description", "twitter:description", "description"]),
        imageUrl,
        siteName: readMetaContent(html, ["og:site_name", "twitter:site"])
      };
    }

    return {};
  } catch {
    return {};
  } finally {
    clearTimeout(timeoutId);
  }
}

function readMetaContent(html: string, names: string[]) {
  for (const name of names) {
    const escapedName = escapeRegExp(name);
    const direct = html.match(new RegExp(`<meta\\s+[^>]*(?:property|name)=["']${escapedName}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"));
    const reversed = html.match(new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escapedName}["'][^>]*>`, "i"));
    const content = direct?.[1] ?? reversed?.[1];

    if (content) {
      return decodeHtmlEntities(content).trim();
    }
  }

  return undefined;
}

function readTitleTag(html: string) {
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  return title ? decodeHtmlEntities(title).trim() : undefined;
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function safeAbsoluteUrl(value: string, base: URL) {
  return safeForumLinkUrl(value, base)?.toString();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseForumLinkUrl<TEnv extends ForumEnv>(value: string, deps: ForumDeps<TEnv>) {
  const normalizedValue = value.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(normalizedValue)
    ? normalizedValue
    : normalizedValue.startsWith("//")
      ? `https:${normalizedValue}`
      : `https://${normalizedValue}`;

  try {
    if (!normalizedValue || normalizedValue.length > MAX_FORUM_LINK_URL_CHARS) {
      throw new Error("invalid_url_length");
    }

    return normalizeForumLinkUrl(new URL(candidate));
  } catch {
    throw deps.httpError(400, "invalid_forum_link_url");
  }
}

function safeForumLinkUrl(value: string, base: URL) {
  try {
    if (value.length > MAX_FORUM_LINK_URL_CHARS) {
      return undefined;
    }

    return normalizeForumLinkUrl(new URL(value, base));
  } catch {
    return undefined;
  }
}

function normalizeForumLinkUrl(input: URL) {
  const url = new URL(input.toString());

  if (url.toString().length > MAX_FORUM_LINK_URL_CHARS || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error("unsupported_protocol");
  }

  if (url.username || url.password || url.port) {
    throw new Error("unsafe_authority");
  }

  const rawHostname = url.hostname.toLowerCase();
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname.replace(/\.+$/, "");

  if (!hostname || isIpLiteral(hostname) || isSpecialUseHostname(hostname)) {
    throw new Error("unsafe_hostname");
  }

  url.hostname = hostname;
  return url;
}

function canFetchForumOpenGraph(url: URL) {
  return url.protocol === "https:" && FORUM_OPEN_GRAPH_HOST_ALLOWLIST.has(url.hostname.toLowerCase());
}

function isIpLiteral(hostname: string) {
  // WHATWG URL canonicalizes decimal, octal, hexadecimal and shortened IPv4
  // forms before this check. A colon in a valid URL hostname denotes IPv6.
  return hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(hostname);
}

function isSpecialUseHostname(hostname: string) {
  if (!hostname.includes(".")) {
    return true;
  }

  return SPECIAL_USE_HOST_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix));
}

async function readResponseText(response: Response, maxBytes: number) {
  const contentLength = response.headers.get("content-length")?.trim();

  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await cancelResponseBody(response);
    return undefined;
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  while (true) {
    const chunk = await reader.read();

    if (chunk.done) {
      return text + decoder.decode();
    }

    bytesRead += chunk.value.byteLength;

    if (bytesRead > maxBytes) {
      await reader.cancel("forum_link_preview_response_too_large");
      return undefined;
    }

    text += decoder.decode(chunk.value, { stream: true });
  }
}

async function cancelResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be closed or locked; there is nothing else to consume.
  }
}

function readYouTubeVideoId(url: URL) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  if (host === "youtu.be") {
    return cleanYouTubeVideoId(url.pathname.split("/").filter(Boolean)[0]);
  }

  if (host !== "youtube.com" && host !== "m.youtube.com") {
    return undefined;
  }

  const fromQuery = cleanYouTubeVideoId(url.searchParams.get("v") ?? "");

  if (fromQuery) {
    return fromQuery;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const markerIndex = parts.findIndex((part) => ["embed", "shorts", "live"].includes(part));
  return markerIndex >= 0 ? cleanYouTubeVideoId(parts[markerIndex + 1]) : undefined;
}

function cleanYouTubeVideoId(value: string | undefined) {
  const id = readString(value).trim();
  return /^[a-zA-Z0-9_-]{6,32}$/.test(id) ? id : undefined;
}

function readXAuthor(url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  const statusIndex = parts.findIndex((part) => part.toLowerCase() === "status");
  const author = statusIndex > 0 ? parts[statusIndex - 1] : "";
  return /^[a-zA-Z0-9_]{1,32}$/.test(author) ? author : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
