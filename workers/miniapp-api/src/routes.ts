import { HttpError, json } from "../../../functions/api/http.ts";
import type { MiniappContext, MiniappServices } from "./services.ts";

const PREFIX = "miniapp/v1/";

const AUTH_ROUTES = new Map([
  ["GET auth/logout", "/auth/logout"],
  ["POST auth/email/login", "/auth/email/login"],
  ["POST auth/email/login/verify", "/auth/email/login/verify"],
  ["POST auth/scan/prepare", "/auth/miniapp/scan/prepare"],
  ["POST auth/scan/exchange", "/auth/miniapp/scan/exchange"]
]);

export async function dispatchMiniappRoutes(
  context: MiniappContext,
  services: MiniappServices,
  path: string
): Promise<Response | undefined> {
  if (!path.startsWith(PREFIX)) return undefined;
  const route = path.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");
  if (context.request.method === "GET" && route === "health") {
    return json({ ok: true, service: "workspace-miniapp-api" }, {
      headers: { "Cache-Control": "no-store" }
    });
  }
  if (context.request.method === "GET" && route === "auth/session") {
    const session = await services.readAuthSession(context);
    return json({
      ...session,
      emailLoginUrl: "/api/miniapp/v1/auth/email/login",
      loginUrl: "/api/miniapp/v1/auth/scan/exchange",
      logoutUrl: "/api/miniapp/v1/auth/logout"
    }, { headers: { "Cache-Control": "private, no-store" } });
  }
  const authTarget = AUTH_ROUTES.get(`${context.request.method} ${route}`);
  if (authTarget) return services.miniappFacadeApi.proxyAuth(context, authTarget);

  if (context.request.method === "POST" && route === "file-uploads") {
    return json(await services.fileUploadApi.start(context), { status: 201 });
  }
  const chunkMatch = route.match(/^file-uploads\/([0-9a-f-]{36})\/chunks\/(\d+)$/);
  if (context.request.method === "PUT" && chunkMatch) {
    return json(await services.fileUploadApi.putChunk(context, chunkMatch[1], Number(chunkMatch[2])));
  }
  const completeMatch = route.match(/^file-uploads\/([0-9a-f-]{36})\/complete$/);
  if (context.request.method === "POST" && completeMatch) {
    return services.fileUploadApi.complete(context, completeMatch[1], services);
  }

  if (context.request.method === "GET" && route === "mates") {
    return services.appsProxyApi.proxyAppsWorkerRequest(context, "apps/mates");
  }
  if ((context.request.method === "GET" || context.request.method === "POST") && route === "mates/default") {
    return services.appsProxyApi.proxyAppsWorkerRequest(context, "apps/mates/default");
  }
  if (context.request.method === "GET" && route === "mates/avatar-options") {
    return services.appsProxyApi.proxyAppsWorkerRequest(context, "apps/mates/avatar-options");
  }
  if (context.request.method === "POST" && route === "mates") {
    return services.appsProxyApi.proxyAppsWorkerRequest(context, "apps/mates");
  }
  if (isMateControlPlaneRoute(context.request.method, route)) {
    return services.appsProxyApi.proxyAppsWorkerRequest(context, `apps/${route}`);
  }

  if (context.request.method === "POST" && route === "sessions") {
    const payload = await services.matePreviewSessionApi.createLiveSession(context);
    const { runtimeOrigin: _runtimeOrigin, ...session } = payload.session;
    return json({
      ...(Array.isArray(payload.conversations) ? { conversations: payload.conversations } : {}),
      session
    }, {
      headers: {
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer"
      },
      status: 201
    });
  }

  const knowledgeRoute = parseKnowledgeRoute(context.request.method, route);
  if (knowledgeRoute) {
    if (knowledgeRoute.kind === "upload") return json(await services.knowledgeApi.uploadFile(context), { status: 201, headers: { "Cache-Control": "private, no-store" } });
    if (knowledgeRoute.kind === "home") return json(await services.knowledgeApi.readLibraryHome(context), { headers: { "Cache-Control": "private, no-store" } });
    if (knowledgeRoute.kind === "folder") return json(await services.knowledgeApi.readLibraryFolder(context, knowledgeRoute.folderObjectId), { headers: { "Cache-Control": "private, no-store" } });
    if (knowledgeRoute.kind === "file") return json(await services.knowledgeApi.readLibraryFile(context, knowledgeRoute.fileId), { headers: { "Cache-Control": "private, no-store" } });
    if (knowledgeRoute.kind === "list") return json(await services.knowledgeApi.listServices(context));
    if (knowledgeRoute.kind === "service") return json(await services.knowledgeApi.readService(context, knowledgeRoute.serviceId));
    if (knowledgeRoute.kind === "handbook") return json(await services.knowledgeApi.readHandbook(context, knowledgeRoute.serviceId));
    if (knowledgeRoute.kind === "query") {
      const body = await readJsonBody(context.request);
      return json(await services.knowledgeApi.queryService(context, knowledgeRoute.serviceId, knowledgeRoute.action, body));
    }
    if (knowledgeRoute.kind === "resolve") {
      const body = await readJsonBody(context.request);
      return json(await services.knowledgeApi.resolvePreviewTarget(context, body), {
        headers: { "Cache-Control": "private, no-store" }
      });
    }
  }

  const runtimePath = miniappRuntimePath(context.request.method, route, context.request.headers);
  if (runtimePath) return services.miniappFacadeApi.proxyRuntime(context, runtimePath);
  return json({ error: "miniapp_route_not_found" }, { status: 404 });
}

function parseKnowledgeRoute(method: string, route: string) {
  if (method === "POST" && route === "knowledge-library/files") return { kind: "upload" as const };
  if (method === "GET" && route === "knowledge-library/home") return { kind: "home" as const };
  const folderMatch = route.match(/^knowledge-library\/folders\/([^/]+)$/);
  if (method === "GET" && folderMatch?.[1]) return { kind: "folder" as const, folderObjectId: decodeURIComponent(folderMatch[1]) };
  const fileMatch = route.match(/^knowledge-library\/files\/([^/]+)$/);
  if (method === "GET" && fileMatch?.[1]) return { kind: "file" as const, fileId: decodeURIComponent(fileMatch[1]) };
  if (method === "GET" && route === "knowledge-services") return { kind: "list" as const };
  if (method === "POST" && route === "knowledge-preview/resolve") return { kind: "resolve" as const };
  const serviceMatch = route.match(/^knowledge-services\/([^/]+)(?:\/(handbook|tree|search|read))?$/);
  if (!serviceMatch?.[1]) return undefined;
  const serviceId = decodeURIComponent(serviceMatch[1]);
  const action = serviceMatch[2] as "handbook" | "tree" | "search" | "read" | undefined;
  if (method === "GET" && !action) return { kind: "service" as const, serviceId };
  if (method === "GET" && action === "handbook") return { kind: "handbook" as const, serviceId };
  if (method === "POST" && (action === "tree" || action === "search" || action === "read")) {
    return { kind: "query" as const, serviceId, action };
  }
  return undefined;
}

async function readJsonBody(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new HttpError(400, "miniapp_knowledge_json_body_required");
  }
  let body: unknown;
  try {
    body = await request.json() as unknown;
  } catch {
    throw new HttpError(400, "miniapp_knowledge_json_body_required");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "miniapp_knowledge_json_body_required");
  }
  return body as Record<string, unknown>;
}

function isMateControlPlaneRoute(method: string, route: string) {
  return (method === "GET" && /^mates\/[^/]+$/.test(route))
    || ((method === "PATCH" || method === "DELETE") && /^mates\/[^/]+$/.test(route))
    || (method === "POST" && /^mates\/[^/]+\/deploy$/.test(route))
    || (method === "POST" && /^mates\/[^/]+\/releases\/[^/]+\/publish$/.test(route));
}

function miniappRuntimePath(method: string, route: string, headers: Headers) {
  if (/^mates\/[^/]+\/tasks$/.test(route) && method === "GET") return `/v1/${route}`;
  if (/^mates\/[^/]+\/workspace-files\/art_[0-9a-f-]{36}\/knowledge$/.test(route) && method === "POST") return `/v1/${route}`;
  if (/^mates\/[^/]+\/runtime$/.test(route) && method === "GET") {
    return `/v1/${route}`;
  }
  if (/^mates\/[^/]+\/workspace-attachments$/.test(route) && method === "POST") {
    return `/v1/${route}`;
  }
  if (/^mates\/[^/]+\/workspace-files\/[^/]+\/(?:raw|download|thumbnail)$/.test(route) && method === "GET") {
    return `/v1/${route}`;
  }
  if (/^mates\/[^/]+\/approvals$/.test(route) && method === "GET") {
    return `/v1/${route}`;
  }
  if (/^mates\/[^/]+\/approvals\/[^/]+\/decision$/.test(route) && method === "POST") {
    return `/v1/${route}`;
  }
  if (/^mates\/[^/]+\/conversations$/.test(route) && (method === "GET" || method === "POST")) {
    return `/v1/${route}`;
  }
  if (/^mates\/[^/]+\/conversations\/[^/]+$/.test(route) && (method === "PATCH" || method === "DELETE")) {
    return `/v1/${route}`;
  }
  if (/^mates\/[^/]+\/conversations\/[^/]+\/chat-grants$/.test(route) && method === "POST") {
    return `/v1/${route}`;
  }
  if (/^mates\/[^/]+\/conversations\/[^/]+\/chat\/get-messages$/.test(route) && method === "GET") {
    return `/v1/${route}`;
  }
  if (
    /^mates\/[^/]+\/conversations\/[^/]+\/chat$/.test(route)
    && method === "GET"
    && headers.get("upgrade")?.trim().toLowerCase() === "websocket"
  ) {
    return `/v1/${route}`;
  }
  return "";
}
