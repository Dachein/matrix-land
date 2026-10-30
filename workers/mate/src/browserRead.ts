import { RuntimeHttpError, type BrowserRunBinding, type RuntimeEnv } from "./types.ts";

const KITESURF_ENGINE = "kitesurf" as const;
const MAX_URL_CHARACTERS = 4_096;
const MAX_MARKDOWN_CHARACTERS = 60_000;
const CDP_TIMEOUT_MS = 30_000;
const PAGE_READY_TIMEOUT_MS = 20_000;

export type PublicWebReadResult = {
  contentDigest: string;
  engine: typeof KITESURF_ENGINE;
  fetchedAt: string;
  markdown: string;
  truncated: boolean;
  url: string;
};

type RenderedPage = {
  links: Array<{ href: string; text: string }>;
  readyState: string;
  text: string;
  title: string;
  url: string;
};

export function publicWebUrlFromInstruction(instruction: string) {
  const match = instruction.match(/https:\/\/[^\s<>"'`]+/i);
  if (!match) return undefined;
  const candidate = match[0].replace(/[),.;:!?，。；：！？、]+$/u, "");
  return normalizePublicWebUrl(candidate);
}

export async function readPublicWebPage(env: RuntimeEnv, requestedUrl: string): Promise<PublicWebReadResult> {
  const url = normalizePublicWebUrl(requestedUrl);
  const allowedOrigin = new URL(url).origin;
  if (!env.BROWSER) throw new RuntimeHttpError(503, "browser_run_not_configured");

  if (env.BROWSER.quickAction) return readPublicWebPageQuickAction(env.BROWSER, url, allowedOrigin);

  let browser: KitesurfCdpClient | undefined;
  try {
    browser = await connectKitesurf(env.BROWSER, new URL(url).hostname);
    const created = record(await browser.send("Target.createTarget", { url: "about:blank" }));
    const targetId = text(created.targetId);
    if (!targetId) throw new Error("kitesurf_target_missing");
    const sessionId = await browser.attachToTarget(targetId, { timeoutMs: CDP_TIMEOUT_MS });
    let requestPolicyFailure: Error | undefined;
    browser.on("Fetch.requestPaused", async (event) => {
      try {
        const params = record(event.params);
        const request = record(params.request);
        const requestId = text(params.requestId);
        if (!requestId) throw new Error("kitesurf_request_id_missing");
        const requestedResource = publicSameOriginUrl(text(request.url), allowedOrigin);
        if (!requestedResource) {
          if (text(params.resourceType) === "Document") {
            requestPolicyFailure ??= new RuntimeHttpError(400, "public_web_url_not_allowed");
          }
          await browser?.send("Fetch.failRequest", {
            errorReason: "BlockedByClient",
            requestId
          }, { sessionId, timeoutMs: CDP_TIMEOUT_MS });
          return;
        }
        await browser?.send("Fetch.continueRequest", { requestId }, { sessionId, timeoutMs: CDP_TIMEOUT_MS });
      } catch (error) {
        requestPolicyFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    });
    const assertRequestPolicy = async () => {
      await browser?.waitForEvents();
      if (requestPolicyFailure) throw requestPolicyFailure;
    };

    await browser.send("Page.enable", {}, { sessionId, timeoutMs: CDP_TIMEOUT_MS });
    await browser.send("Runtime.enable", {}, { sessionId, timeoutMs: CDP_TIMEOUT_MS });
    await browser.send("Fetch.enable", {
      patterns: [{ requestStage: "Request", urlPattern: "*" }]
    }, { sessionId, timeoutMs: CDP_TIMEOUT_MS });
    const navigation = record(await browser.send("Page.navigate", { url }, { sessionId, timeoutMs: CDP_TIMEOUT_MS }));
    await assertRequestPolicy();
    if (text(navigation.errorText)) throw new Error(`kitesurf_navigation_failed:${text(navigation.errorText)}`);

    const page = await readRenderedPage(browser, sessionId, assertRequestPolicy);
    await assertRequestPolicy();
    const finalUrl = publicSameOriginUrl(page.url || url, allowedOrigin);
    if (!finalUrl) throw new RuntimeHttpError(400, "public_web_url_not_allowed");
    const evidence = renderedPageEvidence(page, finalUrl);
    if (!evidence) throw new RuntimeHttpError(502, "browser_run_content_empty");

    const truncated = evidence.length > MAX_MARKDOWN_CHARACTERS;
    const output = evidence.slice(0, MAX_MARKDOWN_CHARACTERS);
    return {
      contentDigest: `sha256:${await sha256Hex(output)}`,
      engine: KITESURF_ENGINE,
      fetchedAt: new Date().toISOString(),
      markdown: output,
      truncated,
      url: finalUrl
    };
  } catch (error) {
    if (error instanceof RuntimeHttpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/\b429\b|rate.?limit|quota/i.test(message)) throw new RuntimeHttpError(429, "browser_run_rate_limited");
    console.warn("kitesurf_public_web_read_failed", { message: message.slice(0, 500) });
    throw new RuntimeHttpError(502, "browser_run_read_failed");
  } finally {
    browser?.close();
  }
}

async function readPublicWebPageQuickAction(
  binding: BrowserRunBinding,
  url: string,
  allowedOrigin: string
): Promise<PublicWebReadResult> {
  try {
    const response = await binding.quickAction?.("markdown", {
      actionTimeout: PAGE_READY_TIMEOUT_MS,
      allowRequestPattern: [sameOriginRequestPattern(allowedOrigin)],
      browser: KITESURF_ENGINE,
      cacheTTL: 0,
      gotoOptions: {
        timeout: PAGE_READY_TIMEOUT_MS,
        waitUntil: "domcontentloaded"
      },
      url
    });
    if (!response) throw new Error("browser_run_quick_action_unavailable");
    const body = record(await response.json().catch(() => undefined));
    if (!response.ok || body.success !== true) {
      const errors = Array.isArray(body.errors) ? body.errors : [];
      const detail = errors.map((value) => text(record(value).message)).filter(Boolean).join("; ");
      throw new Error(`browser_run_quick_action_failed:${response.status}:${detail.slice(0, 300)}`);
    }
    const markdown = text(body.result).trim();
    if (!markdown) throw new RuntimeHttpError(502, "browser_run_content_empty");
    const evidence = [`Source: ${url}`, markdown].join("\n\n");
    const truncated = evidence.length > MAX_MARKDOWN_CHARACTERS;
    const output = evidence.slice(0, MAX_MARKDOWN_CHARACTERS);
    return {
      contentDigest: `sha256:${await sha256Hex(output)}`,
      engine: KITESURF_ENGINE,
      fetchedAt: new Date().toISOString(),
      markdown: output,
      truncated,
      url
    };
  } catch (error) {
    if (error instanceof RuntimeHttpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/\b429\b|rate.?limit|quota/i.test(message)) throw new RuntimeHttpError(429, "browser_run_rate_limited");
    console.warn("browser_run_quick_action_failed", { message: message.slice(0, 500) });
    throw new RuntimeHttpError(502, "browser_run_read_failed");
  }
}

function sameOriginRequestPattern(origin: string) {
  const escaped = origin.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return `/^${escaped}(?:\\/|$)/`;
}

async function readRenderedPage(
  browser: KitesurfCdpClient,
  sessionId: string,
  assertRequestPolicy: () => Promise<void>
) {
  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;
  let page: RenderedPage = { links: [], readyState: "", text: "", title: "", url: "" };
  while (Date.now() < deadline) {
    const evaluation = record(await browser.send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `(() => {
        const body = document.body;
        const primary = document.querySelector("main, article, [role='main']");
        const primaryText = primary instanceof HTMLElement ? primary.innerText : "";
        const bodyText = body instanceof HTMLElement ? body.innerText : "";
        const root = primaryText.trim().length >= 200 ? primary : body;
        return {
          readyState: document.readyState,
          title: document.title || "",
          url: location.href,
          text: (primaryText.trim().length >= 200 ? primaryText : bodyText).trim(),
          links: Array.from(root?.querySelectorAll("a[href]") || []).slice(0, 120).map((link) => ({
            href: link.href,
            text: (link.textContent || "").replace(/\\s+/g, " ").trim()
          }))
        };
      })()`,
      returnByValue: true
    }, { sessionId, timeoutMs: CDP_TIMEOUT_MS }));
    await assertRequestPolicy();
    if (evaluation.exceptionDetails) throw new Error("kitesurf_page_evaluation_failed");
    page = renderedPage(record(record(evaluation.result).value));
    if ((page.readyState === "interactive" || page.readyState === "complete") && page.text) return page;
    await pause(150);
  }
  return page;
}

async function connectKitesurf(binding: BrowserRunBinding, hostname: string) {
  const endpoint = new URL("https://localhost/v1/devtools/browser");
  endpoint.searchParams.set("browser", KITESURF_ENGINE);
  const response = await binding.fetch(endpoint, {
    headers: {
      Upgrade: "websocket",
      "cf-brapi-guardrails": browserRunGuardrails(hostname)
    }
  });
  if (!response.webSocket) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`kitesurf_websocket_unavailable:${response.status}:${detail}`);
  }
  response.webSocket.accept();
  return new KitesurfCdpClient(response.webSocket, CDP_TIMEOUT_MS);
}

function browserRunGuardrails(hostname: string) {
  const encoded = btoa(JSON.stringify({ allowedDomains: [hostname] }));
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

class KitesurfCdpClient {
  private defaultTimeoutMs: number;
  private eventHandlers = new Map<string, Set<(event: Record<string, unknown>) => unknown>>();
  private eventWork = new Set<Promise<void>>();
  private nextId = 1;
  private pending = new Map<number, {
    reject: (error: Error) => void;
    resolve: (value: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private socket: WebSocket;

  constructor(socket: WebSocket, defaultTimeoutMs: number) {
    this.socket = socket;
    this.defaultTimeoutMs = defaultTimeoutMs;
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("error", () => this.rejectAll(new Error("kitesurf_socket_error")));
    socket.addEventListener("close", () => this.rejectAll(new Error("kitesurf_socket_closed")));
  }

  send(method: string, params?: unknown, options: { sessionId?: string; timeoutMs?: number } = {}) {
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`kitesurf_cdp_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timeout });
    });
    try {
      this.socket.send(JSON.stringify({
        id,
        method,
        params,
        ...(options.sessionId ? { sessionId: options.sessionId } : {})
      }));
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending.timeout);
      this.pending.delete(id);
      throw error;
    }
    return result;
  }

  on(method: string, handler: (event: Record<string, unknown>) => unknown) {
    const handlers = this.eventHandlers.get(method) ?? new Set();
    handlers.add(handler);
    this.eventHandlers.set(method, handlers);
    return () => handlers.delete(handler);
  }

  async waitForEvents() {
    while (this.eventWork.size > 0) await Promise.all([...this.eventWork]);
  }

  async attachToTarget(targetId: string, options: { timeoutMs?: number } = {}) {
    const result = record(await this.send("Target.attachToTarget", { flatten: true, targetId }, options));
    const sessionId = text(result.sessionId);
    if (!sessionId) throw new Error("kitesurf_session_missing");
    return sessionId;
  }

  close() {
    this.rejectAll(new Error("kitesurf_client_closed"));
    try { this.socket.close(1000, "Done"); }
    catch {}
  }

  private handleMessage(event: MessageEvent) {
    if (typeof event.data !== "string") return;
    let payload: Record<string, unknown>;
    try { payload = record(JSON.parse(event.data)); }
    catch { return; }
    const method = text(payload.method);
    if (method) {
      for (const handler of this.eventHandlers.get(method) ?? []) {
        let work: Promise<void>;
        work = Promise.resolve(handler(payload)).then(() => undefined, (error) => {
          console.warn("kitesurf_cdp_event_failed", {
            message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
            method
          });
        }).finally(() => this.eventWork.delete(work));
        this.eventWork.add(work);
      }
    }
    const id = Number(payload.id);
    const pending = this.pending.get(id);
    if (!Number.isInteger(id) || !pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    const error = record(payload.error);
    if (Object.keys(error).length > 0) {
      pending.reject(new Error(`kitesurf_cdp_error:${text(error.code) || "unknown"}:${text(error.message) || "unknown"}`));
      return;
    }
    pending.resolve(payload.result);
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function renderedPage(value: Record<string, unknown>): RenderedPage {
  return {
    links: Array.isArray(value.links) ? value.links.flatMap((item) => {
      const link = record(item);
      const href = text(link.href);
      return /^https?:\/\//i.test(href) ? [{ href, text: text(link.text) }] : [];
    }).slice(0, 120) : [],
    readyState: text(value.readyState),
    text: text(value.text),
    title: text(value.title),
    url: text(value.url)
  };
}

function renderedPageEvidence(page: RenderedPage, url: string) {
  const links = page.links.map((link) => `- [${(link.text || link.href).replace(/[\]\r\n]/g, " ").slice(0, 240)}](${link.href})`);
  return [
    `# ${page.title.trim() || "Public webpage"}`,
    `Source: ${url}`,
    page.text.trim(),
    ...(links.length ? ["## Links", links.join("\n")] : [])
  ].filter(Boolean).join("\n\n").trim();
}

export function normalizePublicWebUrl(value: string) {
  if (!value || value.length > MAX_URL_CHARACTERS) throw new RuntimeHttpError(400, "public_web_url_invalid");
  let url: URL;
  try { url = new URL(value); }
  catch { throw new RuntimeHttpError(400, "public_web_url_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new RuntimeHttpError(400, "public_web_url_not_allowed");
  }
  const rawHostname = url.hostname.toLowerCase();
  const hostname = rawHostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || isPrivateHostname(hostname)) throw new RuntimeHttpError(400, "public_web_url_not_allowed");
  if (rawHostname.endsWith(".")) url.hostname = hostname;
  url.hash = "";
  return url.toString();
}

function publicSameOriginUrl(value: string, allowedOrigin: string) {
  try {
    const normalized = normalizePublicWebUrl(value);
    return new URL(normalized).origin === allowedOrigin ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function isPrivateHostname(hostname: string) {
  if (
    hostname === "localhost"
    || hostname === "metadata"
    || hostname === "metadata.google.internal"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home.arpa")
    || hostname.endsWith(".onion")
    || hostname.endsWith(".test")
    || hostname.endsWith(".invalid")
    || hostname.endsWith(".example")
  ) return true;
  if (hostname.includes(":")) return !isGlobalIpv6(hostname);
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return !hostname.includes(".");
  }
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function isGlobalIpv6(hostname: string) {
  const address = ipv6ToBigInt(hostname);
  if (address === undefined) return false;
  const globalStart = 0x20000000000000000000000000000000n;
  const globalEnd = 0x3fffffffffffffffffffffffffffffffn;
  const documentationStart = 0x20010db8000000000000000000000000n;
  const documentationEnd = 0x20010db8ffffffffffffffffffffffffn;
  return address >= globalStart && address <= globalEnd
    && !(address >= documentationStart && address <= documentationEnd);
}

function ipv6ToBigInt(hostname: string) {
  const halves = hostname.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return undefined;
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return undefined;
  const parts = [...left, ...Array(Math.max(0, omitted)).fill("0"), ...right];
  if (parts.length !== 8) return undefined;
  return parts.reduce((address, part) => (address << 16n) + BigInt(`0x${part}`), 0n);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function pause(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
