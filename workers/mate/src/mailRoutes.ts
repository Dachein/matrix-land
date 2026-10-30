import { mailToolDefinitions } from "../../../src/shared/mailTools.ts";
import { validateJsonSchema } from "../../mcp/src/schemaValidation.ts";
import { requireRuntimeMode, resolveRuntimePrincipal } from "./auth.ts";
import { workspaceMailRequest } from "../../../src/shared/workspaceMailClient.ts";
import { resolveDefaultMailbox } from "./mailboxIdentity.ts";
import { resolveUserRuntimePrincipal } from "./runtimeIdentity.ts";
import { RuntimeHttpError, type RuntimeEnv } from "./types.ts";

export async function routeMailRequest(request: Request, env: RuntimeEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/v1/mail/")) return null;
  const definition = mailToolDefinitions.find(tool => path === `/v1/mail/${tool.name}`);
  if (!definition) throw new RuntimeHttpError(404, "mail_tool_not_found");
  if (request.method !== "POST") throw new RuntimeHttpError(405, "mail_method_not_allowed");
  const principal = await resolveRuntimePrincipal(request, env);
  requireRuntimeMode(principal, "live");
  // Explicit mail grants: mate:invoke and mate:* never imply mailbox access.
  const scope = definition.name === "mail_send" || definition.name === "mail_reply" ? "mail:send" : definition.name === "mail_update" ? "mail:write" : "mail:read";
  if (!principal.scopes.includes(scope)) throw new RuntimeHttpError(403, "mail_scope_insufficient");
  const active = await resolveUserRuntimePrincipal(env, principal.userId);
  if (active.orgId !== principal.orgId) throw new RuntimeHttpError(403, "mailbox_access_denied");
  const body = await request.text();
  if (body.length > 7000000) throw new RuntimeHttpError(413, "mail_arguments_too_large");
  let args: Record<string, unknown>;
  try { args = JSON.parse(body); } catch { throw new RuntimeHttpError(400, "mail_arguments_invalid"); }
  if (validateJsonSchema(definition.inputSchema, args).length) throw new RuntimeHttpError(400, "mail_arguments_invalid");
  const mailbox = await resolveDefaultMailbox(env, { principal });
  const headers = { "Cache-Control": "private, no-store" };
  if (!mailbox) return Response.json({ status: "mailbox_not_provisioned", defaultAgent: null, message: "前往 Mate 开通", activationUrl: `${new URL(env.MATE_WEB_HOST_URL!).origin}/mate` }, { headers });
  if (principal.mailMateId && principal.mailMateId !== mailbox.mateId) throw new RuntimeHttpError(403, "mailbox_access_denied");
  const response = await workspaceMailRequest(env,{userId:principal.userId,orgId:principal.orgId,mateId:mailbox.mateId,scopes:[scope]},path,args);
  return new Response(response.body,{status:response.status,headers:{...headers,"Content-Type":"application/json"}});
}
