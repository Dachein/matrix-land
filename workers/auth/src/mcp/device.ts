import { authPublicUrl, issuer } from "../configuration.ts";
import { json } from "../http.ts";
import { resolveAuthorizeUser } from "../identity/users.ts";
import { approveMcpDeviceCode, createMcpDeviceCode, denyMcpDeviceCode, inspectMcpDeviceCode } from "../repositories/mcp/device.ts";
import { ensureMcpOAuthClient } from "../repositories/mcp/clients.ts";
import { recordAuditEvent } from "../repositories/audit.ts";
import { resolveAuthoritativeAuthUserSnapshot } from "../repositories/users/login.ts";
import { redirect } from "../session/cookies.ts";
import { signAuthToken, verifyAuthToken } from "../token.ts";
import { type Env, type WorkspaceUser, HttpError } from "../types.ts";
import { escapeHtml, readOptionalString, readString, requireText } from "../values.ts";
import { canonicalMcpOAuthResource, mcpSupportedScopes } from "./clientRegistration.ts";
import { WORKSPACE_WORKBUDDY_CLI_CLIENT_ID } from "./constants.ts";

// OAuth device authorization currently permits only the registered Workspace CLI for WorkBuddy client.
// Retired static-header login routes retain their separate reauthorization response.
export function isMcpDeviceFlowPath(pathname: string) {
  return /^\/(?:auth\/)?(?:v1\/)?mcp\/device\/(?:approve|code|deny|inspect|token|verify)$/.test(pathname);
}

export function mcpDeviceFlowRetired(env: Env, requestId: string) {
  return json({
    error: "mcp_oauth_required",
    error_description: "Workspace MCP device login has been retired. Reconnect this MCP server with the client's standard OAuth flow.",
    authorization_server: issuer(env),
    resource: canonicalMcpOAuthResource(undefined, env) ? `${canonicalMcpOAuthResource(undefined, env)}/mcp` : undefined,
    handoff: {
      state: "reauthorization_required",
      nextAction: {
        kind: "oauth_login",
        reason: "Remove the saved Bearer/header configuration, add the Workspace MCP URL without a static Authorization header, and complete the OAuth prompt.",
        requiresUserApproval: true
      }
    },
    requestId
  }, {
    status: 410,
    headers: { "Cache-Control": "no-store" }
  });
}

export async function createMcpDeviceAuthorization(request: Request, env: Env, requestId: string) {
  if (!request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) {
    throw new HttpError(415, "form_required");
  }
  const form = new URLSearchParams(await request.text());
  if (form.get("client_id") !== WORKSPACE_WORKBUDDY_CLI_CLIENT_ID) {
    throw new HttpError(401, "invalid_client");
  }
  const resourceUrl = canonicalMcpOAuthResource(readOptionalString(form.get("resource")), env);
  if (!resourceUrl) {
    throw new HttpError(400, "invalid_target");
  }
  const requestedScopes = readString(form.get("scope"))
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (requestedScopes.some((scope) => !mcpSupportedScopes().includes(scope))) {
    throw new HttpError(400, "invalid_scope");
  }
  await ensureMcpOAuthClient(env, {
    agentType: "workbuddy",
    clientId: WORKSPACE_WORKBUDDY_CLI_CLIENT_ID,
    clientName: "Workspace CLI for WorkBuddy"
  });
  const created = await createMcpDeviceCode(env, {
    agentType: "workbuddy",
    clientId: "workspace-ai-mcp",
    displayName: "Workspace CLI for WorkBuddy",
    resourceUrl,
    scopes: requestedScopes.length > 0 ? requestedScopes : undefined
  });
  const verificationUri = `${authPublicUrl(env)}/auth/mcp/device/verify`;
  await recordAuditEvent(env, {
    action: "mcp_device_code_created",
    clientAppId: WORKSPACE_WORKBUDDY_CLI_CLIENT_ID,
    decision: "allow",
    metadata: { agentType: "workbuddy", scopes: created.scopes },
    requestId,
    resourceId: created.clientId,
    resourceType: "mcp_client"
  });
  return json({
    device_code: created.deviceCode,
    user_code: displayMcpDeviceUserCode(created.userCode),
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(created.userCode)}`,
    expires_in: Math.max(0, Math.floor((Date.parse(created.expiresAt) - Date.now()) / 1000)),
    interval: 5
  }, { status: 200, headers: { "Cache-Control": "no-store" } });
}

export async function verifyMcpDeviceAuthorization(request: Request, env: Env, requestId: string) {
  if (request.method === "POST") {
    const form = await request.formData();
    const requestToken = requireText(form.get("request_token"), "invalid_request", 8000);
    const payload = await verifyAuthToken(env, requestToken);
    if (payload.typ !== "mcp_device_authorization_request") {
      throw new HttpError(400, "invalid_request");
    }
    const sessionUser = await resolveAuthorizeUser(request, env);
    if (!sessionUser || sessionUser.id !== readString(payload.sub)) {
      throw new HttpError(401, "not_authenticated");
    }
    const user = await resolveAuthoritativeAuthUserSnapshot(env, sessionUser);
    const userCode = requireText(payload.user_code, "invalid_request", 40);
    const approved = String(form.get("decision") ?? "") === "approve";
    if (approved) {
      const result = await approveMcpDeviceCode(env, userCode, user);
      await recordAuditEvent(env, {
        action: "mcp_device_code_approved",
        actorUserId: user.id,
        clientAppId: WORKSPACE_WORKBUDDY_CLI_CLIENT_ID,
        decision: "allow",
        metadata: { connectionId: result.connectionId, scopes: result.scopes },
        requestId,
        resourceId: result.connectionId,
        resourceType: "mcp_connection"
      });
    } else {
      await denyMcpDeviceCode(env, userCode);
      await recordAuditEvent(env, {
        action: "mcp_device_code_denied",
        actorUserId: user.id,
        clientAppId: WORKSPACE_WORKBUDDY_CLI_CLIENT_ID,
        decision: "deny",
        requestId,
        resourceId: userCode,
        resourceType: "mcp_device_code"
      });
    }
    return mcpDeviceAuthorizationCompletePage(approved);
  }

  const url = new URL(request.url);
  const rawUserCode = readOptionalString(url.searchParams.get("user_code"));
  if (!rawUserCode) {
    return mcpDeviceCodeEntryPage();
  }
  const sessionUser = await resolveAuthorizeUser(request, env);
  if (!sessionUser) {
    const loginUrl = new URL("/auth/login", authPublicUrl(env));
    loginUrl.searchParams.set("return_to", url.toString());
    return redirect(loginUrl.toString());
  }
  const user = await resolveAuthoritativeAuthUserSnapshot(env, sessionUser);
  const device = await inspectMcpDeviceCode(env, rawUserCode);
  if (device.status !== "pending") {
    throw new HttpError(device.status === "expired" ? 410 : 409, `mcp_device_code_${device.status}`);
  }
  const requestToken = await signAuthToken(env, {
    typ: "mcp_device_authorization_request",
    sub: user.id,
    user_code: device.userCode,
    exp: Math.floor(Date.now() / 1000) + 10 * 60
  });
  return mcpDeviceConsentPage({ device, requestToken, user });
}

function displayMcpDeviceUserCode(value: string) {
  const normalized = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return normalized.length === 8 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}

function mcpDeviceCodeEntryPage() {
  return htmlPage("连接 Workspace MCP", `
    <p>请输入 WorkBuddy 显示的设备验证码。</p>
    <form method="get"><label>设备验证码<input name="user_code" required autocomplete="one-time-code"></label><button type="submit">继续</button></form>
  `);
}

function mcpDeviceConsentPage(input: {
  device: Awaited<ReturnType<typeof inspectMcpDeviceCode>>;
  requestToken: string;
  user: WorkspaceUser;
}) {
  const name = input.user.name || input.user.email || input.user.id;
  return htmlPage("授权 Workspace CLI", `
    <span class="ok">安全连接</span>
    <h1>授权 Workspace MCP</h1>
    <p><strong>Workspace CLI for WorkBuddy</strong> 希望连接你的 Frontier Workspace 工作空间。</p>
    <dl><dt>当前用户</dt><dd>${escapeHtml(name)}</dd><dt>设备验证码</dt><dd>${escapeHtml(displayMcpDeviceUserCode(input.device.userCode))}</dd><dt>有效期</dt><dd>持续使用时保持有效；连续 7 天未使用后自动失效</dd></dl>
    <form method="post"><input type="hidden" name="request_token" value="${escapeHtml(input.requestToken)}"><div class="actions"><button class="secondary" name="decision" value="deny">拒绝</button><button name="decision" value="approve">批准连接</button></div></form>
  `);
}

function mcpDeviceAuthorizationCompletePage(approved: boolean) {
  return htmlPage(approved ? "授权成功" : "已拒绝授权", approved
    ? `<span class="ok">✓ Workspace MCP 已授权</span><h1>连接已完成</h1><p>WorkBuddy 会自动检测授权结果。现在可以关闭此页面。</p>`
    : `<h1>已拒绝连接</h1><p>没有向 WorkBuddy 签发凭据，现在可以关闭此页面。</p>`);
}

function htmlPage(title: string, content: string) {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{color-scheme:light;--ink:#11110f;--muted:#68635b;--line:#c9c4ba;--green:#27704e}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;background:#f3f2ee;color:var(--ink);font-family:Inter,"Noto Sans SC",system-ui,sans-serif;padding:24px}main{width:min(100%,620px);border:1px solid #aaa49a;border-top:4px solid var(--ink);background:#fff;padding:40px;box-shadow:0 8px 24px rgba(0,0,0,.05)}h1{font-size:36px;margin:12px 0}p{color:var(--muted);line-height:1.65}.ok{color:var(--green);font-weight:850}dl{display:grid;grid-template-columns:120px 1fr;border-block:1px solid var(--line);margin:26px 0}dt,dd{margin:0;padding:14px 0;border-bottom:1px solid var(--line)}dt:nth-last-of-type(1),dd:nth-last-of-type(1){border-bottom:0}dt{color:var(--muted);font-weight:700}dd{font-weight:750}label{display:grid;gap:9px;font-weight:750}input{width:100%;min-height:46px;border:1px solid var(--line);font:inherit;padding:0 12px}.actions{display:flex;justify-content:flex-end;gap:12px;margin-top:24px}button{min-height:44px;border:1px solid var(--ink);border-radius:3px;background:var(--ink);color:#fff;font:inherit;font-weight:800;padding:0 18px;cursor:pointer}.secondary{background:#fff;color:var(--ink)}@media(max-width:560px){main{padding:28px 22px}dl{grid-template-columns:1fr}dt{padding-bottom:0}dd{padding-top:6px}}
  </style></head><body><main>${content}</main></body></html>`;
  return new Response(body, { headers: { "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } });
}
