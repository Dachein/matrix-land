import { requireRuntimeMode, requireRuntimeScope, resolveRuntimePrincipal } from "./auth.ts";
import { triggerMateConversation } from "./channelConversation.ts";
import { RuntimeHttpError, type RuntimeEnv } from "./types.ts";

export async function routeMateChannelMessage(
  request: Request,
  env: RuntimeEnv
): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname;
  const match = pathname.match(/^\/v1\/mates\/([^/]+)\/conversations\/([^/]+)\/messages$/);
  if (!match?.[1] || !match[2]) return undefined;
  if (request.method !== "POST") throw new RuntimeHttpError(405, "mate_channel_message_method_not_allowed");
  const mateId = decodeSegment(match[1]);
  const conversationId = decodeSegment(match[2]);
  const principal = await resolveRuntimePrincipal(request, env);
  requireRuntimeMode(principal, "live");
  requireRuntimeScope(principal, "mate:invoke");
  if (principal.callerKind !== "user") throw new RuntimeHttpError(403, "mate_channel_message_user_caller_required");
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  rejectAuthorityFields(body);
  const messageId = typeof body.messageId === "string" && body.messageId.trim()
    ? body.messageId.trim()
    : `api-${crypto.randomUUID()}`;
  const result = await triggerMateConversation({
    conversationId,
    env,
    ingress: "api",
    messageId,
    principal,
    mateId,
    text: typeof body.text === "string" ? body.text : ""
  });
  return Response.json(result);
}

function rejectAuthorityFields(input: Record<string, unknown>) {
  for (const key of Object.keys(input)) {
    if (/^(userId|ownerUserId|orgId|scopes?|accessToken|refreshToken|authorization|cookie)$/i.test(key)) {
      throw new RuntimeHttpError(400, "caller_authority_field_forbidden", { field: key });
    }
  }
}

function decodeSegment(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.includes("/") || decoded.length > 180) throw new Error();
    return decoded;
  } catch { throw new RuntimeHttpError(404, "runtime_route_not_found"); }
}
