type MiniappFacadeEnv = {
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  PORTAL_AUTH_SERVICE_TOKEN?: string;
  MATE_RUNTIME_URL?: string;
};

type MiniappFacadeContext<TEnv extends MiniappFacadeEnv> = EventContext<TEnv, string, unknown>;

type MiniappFacadeDeps<TEnv extends MiniappFacadeEnv> = {
  fetch?: typeof fetch;
  httpError(status: number, code: string): Error;
};

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

const PASSTHROUGH_RESPONSE_HEADERS = [
  "x-workspace-chat-next-cursor",
  "cache-control",
  "content-disposition",
  "content-length",
  "content-type",
  "etag",
  "last-modified",
  "set-cookie"
];

export function createMiniappFacadeApi<TEnv extends MiniappFacadeEnv>(deps: MiniappFacadeDeps<TEnv>) {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));

  return {
    async proxyAuth(context: MiniappFacadeContext<TEnv>, authPath: string) {
      const target = new URL(authPath, `${configuredOrigin(context.env.AUTH_WORKER_URL, "auth_worker_url_not_configured", deps)}/`);
      target.search = new URL(context.request.url).search;
      const headers = new Headers(context.request.headers);
      for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
      stripUntrustedIdentityHeaders(headers);

      const publicUrl = new URL(context.request.url);
      headers.set("x-workspace-public-origin", publicUrl.origin);
      headers.set("x-forwarded-host", publicUrl.host);
      headers.set("x-forwarded-proto", publicUrl.protocol.replace(/:$/, ""));
      if (context.request.method === "POST" && (
        target.pathname === "/auth/email/login"
        || target.pathname === "/auth/email/login/verify"
      )) {
        const proxyToken = context.env.PORTAL_AUTH_SERVICE_TOKEN?.trim()
          || context.env.AUTH_SERVICE_TOKEN?.trim();
        const clientIp = context.request.headers.get("cf-connecting-ip")?.trim();
        if (proxyToken) headers.set("x-workspace-auth-proxy-token", proxyToken);
        if (clientIp) headers.set("x-workspace-client-ip", clientIp);
        headers.set("x-workspace-auth-channel", "miniapp");
      }

      let response: Response;
      try {
        response = await fetchImpl(target, {
          body: requestBody(context.request),
          headers,
          method: context.request.method,
          redirect: "manual"
        });
      } catch {
        throw deps.httpError(502, "miniapp_auth_unavailable");
      }
      return new Response(response.body, response);
    },

    async proxyRuntime(context: MiniappFacadeContext<TEnv>, runtimePath: string) {
      const target = new URL(runtimePath, `${configuredOrigin(
        context.env.MATE_RUNTIME_URL,
        "mate_runtime_url_not_configured",
        deps
      )}/`);
      target.search = new URL(context.request.url).search;
      const websocket = context.request.headers.get("upgrade")?.trim().toLowerCase() === "websocket";
      const headers = new Headers();
      copyRequestHeader(context.request.headers, headers, "accept");
      copyRequestHeader(context.request.headers, headers, "authorization");
      copyRequestHeader(context.request.headers, headers, "content-type");
      copyRequestHeader(context.request.headers, headers, "content-length");
      copyRequestHeader(context.request.headers, headers, "x-request-id");
      if (websocket) headers.set("upgrade", "websocket");

      let response: Response;
      try {
        response = await fetchImpl(target, {
          body: requestBody(context.request),
          headers,
          method: context.request.method,
          redirect: "manual"
        });
      } catch {
        throw deps.httpError(502, "miniapp_runtime_unavailable");
      }

      if (response.status === 101) return response;
      const responseHeaders = new Headers();
      for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      copyRequestHeader(response.headers, responseHeaders, "x-request-id");
      return new Response(response.body, {
        headers: responseHeaders,
        status: response.status,
        statusText: response.statusText
      });
    }
  };
}

function configuredOrigin<TEnv extends MiniappFacadeEnv>(
  value: string | undefined,
  errorCode: string,
  deps: Pick<MiniappFacadeDeps<TEnv>, "httpError">
) {
  const text = value?.trim();
  if (!text) throw deps.httpError(503, errorCode);
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw deps.httpError(503, errorCode);
  }
}

function requestBody(request: Request) {
  return request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
}

function copyRequestHeader(source: Headers, destination: Headers, name: string) {
  const value = source.get(name);
  if (value) destination.set(name, value);
}

function stripUntrustedIdentityHeaders(headers: Headers) {
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith("x-workspace-user-")
      || lower === "x-workspace-miniapp-public-origin"
      || lower.startsWith("x-workspace-provider-")
      || lower.startsWith("x-workspace-entra-")
      || lower === "x-workspace-role"
      || lower.startsWith("x-workspace-team-")
      || lower.startsWith("x-workspace-department-")
      || lower === "x-workspace-client-ip"
      || lower === "x-workspace-auth-proxy-token"
      || lower === "x-workspace-auth-channel"
      || lower === "cf-access-authenticated-user-email"
      || lower === "cf-access-jwt-assertion"
    ) {
      headers.delete(name);
    }
  }
}
