export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, code: string) {
    super(code);
    this.name = "HttpError";
    this.status = status;
  }
}

export function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export async function readJson<T>(request: Request, maxBytes = 17 * 1024 * 1024): Promise<T> {
  const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, "request_too_large");
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new HttpError(413, "request_too_large");
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

export function redirect(location: string, headersInit?: HeadersInit) {
  const headers = new Headers(headersInit);
  headers.set("Cache-Control", "no-store");
  headers.set("Location", location);
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(null, { status: 302, headers });
}

export function withAppSecurityHeaders(response: Response) {
  const headers = new Headers(response.headers);
  const allowSameOriginFrame = headers.get("X-Workspace-Allow-Same-Origin-Frame") === "1";
  headers.delete("X-Workspace-Allow-Same-Origin-Frame");
  headers.set("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self' https://ai.example.invalid",
    `frame-ancestors ${allowSameOriginFrame ? "'self'" : "'none'"}`,
    "frame-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'"
  ].join("; "));
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", allowSameOriginFrame ? "SAMEORIGIN" : "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function assertSameOrigin(request: Request, allowLocalDev = false) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin === new URL(request.url).origin && (!fetchSite || fetchSite === "same-origin")) return;
  if (allowLocalDev && !request.headers.get("cf-ray") && isLoopbackOrigin(origin) && (!fetchSite || fetchSite === "same-origin")) return;
  throw new HttpError(403, "cross_origin_request_rejected");
}

function isLoopbackOrigin(value: string | null) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function errorResponse(error: unknown) {
  if (error instanceof HttpError) {
    return json({ error: error.message }, { status: error.status });
  }

  return json({ error: "internal_error" }, { status: 500 });
}
