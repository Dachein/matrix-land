import { requireRuntimeMode, requireRuntimeScope, resolveRuntimePrincipal } from "./auth.ts";
import { normalizeMateChatRouteAddress } from "./chatAddress.ts";
import { createMateChatGrant, verifyMateChatGrant } from "./chatGrant.ts";
import { loadRuntimeDefinition } from "./controlPlane.ts";
import { ensurePreviewSdkConversation, readConversation } from "./storage.ts";
import { RuntimeHttpError, type RuntimeEnv, type RuntimeMode } from "./types.ts";

const CHAT_GRANT_TTL_SECONDS = 120;

type ChatRoute = {
  action: "grant" | "messages" | "socket";
  conversationId: string;
  mode: RuntimeMode;
  mateId: string;
};

/**
 * Routes only the protected Cloudflare chat surface. The public URL never
 * contains a DO class or instance name; both are derived after a short-lived
 * signed grant has been verified.
 */
export async function routeMateChatRequest(
  request: Request,
  env: RuntimeEnv
): Promise<Response | undefined> {
  const route = matchChatRoute(new URL(request.url).pathname);
  if (!route) return undefined;
  if (route.action === "grant") return issueChatGrant(request, env, route);
  if (route.action === "messages" && request.method !== "GET") {
    throw new RuntimeHttpError(405, "mate_chat_messages_method_not_allowed");
  }
  if (route.action === "messages" && isWebSocketUpgrade(request)) {
    throw new RuntimeHttpError(400, "mate_chat_messages_upgrade_forbidden");
  }
  return forwardChatTransport(request, env, route);
}

async function issueChatGrant(request: Request, env: RuntimeEnv, route: ChatRoute) {
  if (request.method !== "POST") throw new RuntimeHttpError(405, "mate_chat_grant_method_not_allowed");
  const address = normalizeMateChatRouteAddress(route);
  const principal = await resolveRuntimePrincipal(request, env);
  requireRuntimeMode(principal, address.mode);
  requireRuntimeScope(principal, route.mode === "preview" ? "mate:owner_test" : "mate:invoke");
  if (route.mode === "preview") requireRuntimeScope(principal, "mate:invoke");
  if (principal.callerKind !== "user") throw new RuntimeHttpError(403, "mate_chat_user_caller_required");

  const definition = await loadRuntimeDefinition(env, principal, address.mateId, address.mode);
  assertChatChannelEnabled(definition.release.manifest as Record<string, any>, address.mode);
  const conversation = address.mode === "preview"
    ? await ensurePreviewSdkConversation(env.RUNTIME_DB, address.mateId, principal, address.conversationId)
    : await readConversation(
      env.RUNTIME_DB,
      address.mateId,
      principal.userId,
      address.mode,
      address.conversationId
    );
  if (conversation.channel !== "sdk") {
    throw new RuntimeHttpError(409, "mate_chat_conversation_channel_invalid");
  }
  const grant = await createMateChatGrant({
    callerKind: "user",
    conversationId: address.conversationId,
    ...(principal.departmentId ? { departmentId: principal.departmentId } : {}),
    ...(principal.departmentPath?.length ? { departmentPath: principal.departmentPath } : {}),
    mode: address.mode,
    orgId: principal.orgId,
    releaseId: definition.release.id,
    scopes: principal.scopes,
    mateId: address.mateId,
    userId: principal.userId
  }, chatGrantSecret(env), { ttlSeconds: CHAT_GRANT_TTL_SECONDS });
  const claims = await verifyMateChatGrant(
    grant,
    chatGrantSecret(env),
    address
  );

  return Response.json({
    grant,
    expiresAt: new Date(claims.exp * 1_000).toISOString(),
    releaseId: claims.releaseId,
    mode: claims.mode
  }, { status: 201 });
}

async function forwardChatTransport(request: Request, env: RuntimeEnv, route: ChatRoute) {
  if (!env.MATE_CHAT_AGENT) throw new RuntimeHttpError(503, "mate_chat_agent_not_configured");
  const address = normalizeMateChatRouteAddress(route);
  const url = new URL(request.url);
  const claims = await verifyMateChatGrant(
    url.searchParams.get("grant"),
    chatGrantSecret(env),
    address
  );
  if (route.action === "socket" && (request.method !== "GET" || !isWebSocketUpgrade(request))) {
    throw new RuntimeHttpError(426, "mate_chat_websocket_upgrade_required");
  }
  const id = env.MATE_CHAT_AGENT.idFromName(claims.instanceName);
  const agent = env.MATE_CHAT_AGENT.get(id, { locationHint: "apac" });
  if (route.action === "messages") {
    url.pathname = "/workspace-chat-history";
    return agent.fetch(new Request(url, request));
  }
  return agent.fetch(request);
}

function matchChatRoute(pathname: string): ChatRoute | undefined {
  const match = pathname.match(
    /^\/v1\/(owner-test\/)?mates\/([^/]+)\/conversations\/([^/]+)\/(chat-grants|chat(?:\/get-messages)?)$/
  );
  if (!match?.[2] || !match[3] || !match[4]) return undefined;
  return {
    action: match[4] === "chat-grants"
      ? "grant"
      : match[4] === "chat/get-messages"
        ? "messages"
        : "socket",
    conversationId: decodePathSegment(match[3]),
    mode: match[1] ? "preview" : "live",
    mateId: decodePathSegment(match[2])
  };
}

function decodePathSegment(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.includes("/")) throw new Error("invalid_segment");
    return decoded;
  } catch {
    throw new RuntimeHttpError(404, "runtime_route_not_found");
  }
}

function chatGrantSecret(env: RuntimeEnv) {
  return env.MATE_CHAT_GRANT_SECRET?.trim() || "";
}

function isWebSocketUpgrade(request: Request) {
  return request.headers.get("upgrade")?.trim().toLowerCase() === "websocket";
}

function assertChatChannelEnabled(manifest: Record<string, any>, mode: RuntimeMode) {
  if (mode === "preview") {
    const ownerTesting = manifest.experiencePolicy?.ownerTesting;
    if (
      ownerTesting?.enabled !== true
      || ownerTesting.candidateReleaseOnly !== true
      || ownerTesting.isolatedFromLiveData !== true
    ) {
      throw new RuntimeHttpError(403, "mate_chat_channel_disabled");
    }
    return;
  }
  const channels = manifest.channels ?? {};
  if (channels.embedded?.enabled !== true && channels.standalone?.enabled !== true) {
    throw new RuntimeHttpError(403, "mate_chat_channel_disabled");
  }
}
