export interface Env {
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  PORTAL_AUTH_SERVICE_TOKEN?: string;
}

type PagesContext = EventContext<Env, string, { path?: string | string[] }>;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export const onRequest: PagesFunction<Env, string, { path?: string | string[] }> = async (context) => {
  if (!context.env.AUTH_WORKER_URL?.trim()) {
    return new Response(JSON.stringify({ error: "auth_worker_url_not_configured" }), {
      status: 503,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }

  const target = authWorkerTarget(context);
  const headers = new Headers(context.request.headers);
  const publicUrl = new URL(context.request.url);

  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }
  stripUntrustedIdentityHeaders(headers);

  headers.set("x-workspace-public-origin", publicUrl.origin);
  headers.set("x-forwarded-host", publicUrl.host);
  headers.set("x-forwarded-proto", publicUrl.protocol.replace(/:$/, ""));

  if (isEmailOtpPost(context.request, target)) {
    const proxyToken = portalAuthServiceToken(context.env);
    const clientIp = context.request.headers.get("cf-connecting-ip")?.trim();
    if (proxyToken) {
      headers.set("x-workspace-auth-proxy-token", proxyToken);
    }
    if (clientIp) {
      headers.set("x-workspace-client-ip", clientIp);
    }
  }

  const response = await fetch(target.toString(), {
    method: context.request.method,
    headers,
    body: context.request.method === "GET" || context.request.method === "HEAD" ? undefined : context.request.body,
    redirect: "manual"
  });

  return new Response(response.body, response);
};

function isEmailOtpPost(request: Request, target: URL) {
  return request.method === "POST" && (
    target.pathname === "/auth/email/login" ||
    target.pathname === "/auth/email/login/verify"
  );
}

function portalAuthServiceToken(env: Env) {
  return env.PORTAL_AUTH_SERVICE_TOKEN?.trim() || env.AUTH_SERVICE_TOKEN?.trim();
}

function stripUntrustedIdentityHeaders(headers: Headers) {
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith("x-workspace-user-") ||
      lower.startsWith("x-workspace-provider-") ||
      lower.startsWith("x-workspace-entra-") ||
      lower === "x-workspace-role" ||
      lower.startsWith("x-workspace-team-") ||
      lower.startsWith("x-workspace-department-") ||
      lower === "x-workspace-client-ip" ||
      lower === "x-workspace-auth-proxy-token" ||
      lower === "cf-access-authenticated-user-email" ||
      lower === "cf-access-jwt-assertion"
    ) {
      headers.delete(name);
    }
  }
}

function authWorkerTarget(context: PagesContext) {
  const base = context.env.AUTH_WORKER_URL!.trim().replace(/\/+$/, "");
  const path = normalizePathParam(context.params.path);
  const source = new URL(context.request.url);
  const target = new URL(`${base}/auth/${path}`);
  target.search = source.search;
  return target;
}

function normalizePathParam(value: string | string[] | undefined) {
  const parts = Array.isArray(value) ? value : value ? [value] : [];
  return parts
    .flatMap((part) => part.split("/"))
    .map((part) => encodeURIComponent(part))
    .join("/");
}
