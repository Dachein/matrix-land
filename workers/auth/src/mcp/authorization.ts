import { authPublicUrl } from "../configuration.ts";
import { defaultPlatformBrand, platformBrandFromEnv, type PlatformBrand } from "../../../../src/shared/platformBrand.ts";
import { resolveAuthorizeUser } from "../identity/users.ts";
import { createMcpOAuthAuthorizationCode } from "../repositories/mcp/oauthCredentials.ts";
import { createMcpOAuthConnection } from "../repositories/mcp/connections.ts";
import { readMcpOAuthClient } from "../repositories/mcp/clients.ts";
import { recordAuditEvent } from "../repositories/audit.ts";
import { resolveAuthoritativeAuthUserSnapshot } from "../repositories/users/login.ts";
import { redirect } from "../session/cookies.ts";
import { signAuthToken, verifyAuthToken } from "../token.ts";
import { type Env, type WorkspaceUser, HttpError } from "../types.ts";
import { escapeHtml, readOptionalString, readString, readStringList, requireText } from "../values.ts";
import { deliverMcpOAuthCallback, redirectMcpOAuthError } from "./callbacks.ts";
import { canonicalMcpOAuthResource, mcpSupportedScopes } from "./clientRegistration.ts";

// MCP OAuth authorization, consent rendering and callback validation.
export async function authorizeMcpOAuthClient(request: Request, env: Env, requestId: string) {
  if (request.method === "POST") {
    return completeMcpOAuthAuthorization(request, env, requestId);
  }

  const url = new URL(request.url);
  const clientId = requireText(url.searchParams.get("client_id"), "invalid_client", 200);
  const redirectUri = requireText(url.searchParams.get("redirect_uri"), "invalid_redirect_uri", 1000);
  const client = await readMcpOAuthClient(env, clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) {
    throw new HttpError(400, "invalid_client");
  }
  if (url.searchParams.get("response_type") !== "code") {
    return redirectMcpOAuthError(redirectUri, url.searchParams.get("state"), "unsupported_response_type");
  }
  const codeChallenge = requireText(url.searchParams.get("code_challenge"), "invalid_request", 180);
  if (url.searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    return redirectMcpOAuthError(redirectUri, url.searchParams.get("state"), "invalid_request");
  }
  const resourceUrl = canonicalMcpOAuthResource(readOptionalString(url.searchParams.get("resource")), env);
  if (!resourceUrl) {
    return redirectMcpOAuthError(redirectUri, url.searchParams.get("state"), "invalid_target");
  }
  const requestedScopes = readString(url.searchParams.get("scope"))
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const scopes = requestedScopes.length > 0 ? requestedScopes : mcpSupportedScopes();
  if (scopes.some((scope) => !mcpSupportedScopes().includes(scope))) {
    return redirectMcpOAuthError(redirectUri, url.searchParams.get("state"), "invalid_scope");
  }

  const sessionUser = await resolveAuthorizeUser(request, env);
  if (!sessionUser) {
    const loginUrl = new URL("/auth/login", authPublicUrl(env));
    loginUrl.searchParams.set("return_to", url.toString());
    return redirect(loginUrl.toString());
  }
  const user = await resolveAuthoritativeAuthUserSnapshot(env, sessionUser);
  if (user.status && user.status !== "active") {
    return redirectMcpOAuthError(redirectUri, url.searchParams.get("state"), "access_denied");
  }
  const requestToken = await signAuthToken(env, {
    typ: "mcp_oauth_authorization_request",
    sub: user.id,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    resource: resourceUrl,
    scopes,
    state: readOptionalString(url.searchParams.get("state")),
    exp: Math.floor(Date.now() / 1000) + 10 * 60
  });

  return mcpOAuthConsentPage({ clientName: client.clientName, redirectUri, requestToken, scopes, user, brand: platformBrandFromEnv(env) });
}

async function completeMcpOAuthAuthorization(request: Request, env: Env, requestId: string) {
  const form = await request.formData();
  const requestToken = requireText(form.get("request_token"), "invalid_request", 8000);
  const payload = await verifyAuthToken(env, requestToken);
  if (payload.typ !== "mcp_oauth_authorization_request") {
    throw new HttpError(400, "invalid_request");
  }
  const redirectUri = requireText(payload.redirect_uri, "invalid_redirect_uri", 1000);
  const state = readOptionalString(payload.state);
  if (String(form.get("decision") ?? "") !== "approve") {
    await recordAuditEvent(env, {
      action: "mcp_oauth_authorization_denied",
      actorUserId: readString(payload.sub),
      clientAppId: readString(payload.client_id),
      decision: "deny",
      metadata: { scopes: readStringList(payload.scopes) },
      requestId,
      resourceType: "mcp_connection"
    });
    return redirectMcpOAuthError(redirectUri, state, "access_denied");
  }
  const sessionUser = await resolveAuthorizeUser(request, env);
  if (!sessionUser || sessionUser.id !== readString(payload.sub)) {
    throw new HttpError(401, "not_authenticated");
  }
  const user = await resolveAuthoritativeAuthUserSnapshot(env, sessionUser);
  const oauthClientId = requireText(payload.client_id, "invalid_client", 200);
  const client = await readMcpOAuthClient(env, oauthClientId);
  if (!client || !client.redirectUris.includes(redirectUri)) {
    throw new HttpError(400, "invalid_client");
  }
  const scopes = readStringList(payload.scopes);
  const connection = await createMcpOAuthConnection(env, {
    agentType: client.agentType,
    displayName: client.clientName || client.agentType,
    resourceUrl: readString(payload.resource),
    scopes,
    user
  });
  const code = await createMcpOAuthAuthorizationCode(env, {
    codeChallenge: requireText(payload.code_challenge, "invalid_request", 180),
    connectionId: connection.connectionId,
    oauthClientId,
    redirectUri,
    resourceUrl: readString(payload.resource),
    scopes: connection.scopes,
    userId: user.id
  });
  await recordAuditEvent(env, {
    action: "mcp_oauth_authorization_approved",
    actorUserId: user.id,
    clientAppId: oauthClientId,
    decision: "allow",
    metadata: { agentType: client.agentType, connectionId: connection.connectionId, scopes: connection.scopes },
    requestId,
    resourceId: connection.connectionId,
    resourceType: "mcp_connection"
  });
  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  if (state) callback.searchParams.set("state", state);
  return deliverMcpOAuthCallback(callback);
}

export function mcpOAuthConsentPage(input: { clientName: string; redirectUri: string; requestToken: string; scopes: string[]; user: WorkspaceUser; brand?: PlatformBrand }) {
  const brand = input.brand ?? defaultPlatformBrand;
  const userName = input.user.name || input.user.email || input.user.id;
  const userInitial = Array.from(userName.trim())[0]?.toUpperCase() || "F";
  const domains = mcpOAuthConsentDomains();
  const callbackUrl = new URL(input.redirectUri);
  const callbackSource = callbackUrl.protocol === "http:" || callbackUrl.protocol === "https:"
    ? callbackUrl.origin
    : callbackUrl.protocol;
  const domainItems = domains.map((domain) => `
    <li>
      <strong>${escapeHtml(domain.name)}</strong>
      <span>${escapeHtml(domain.description)}</span>
    </li>`).join("");
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>授权 Workspace MCP</title>
  <style>
    :root{color-scheme:light;--canvas:#f3f2ee;--paper:#fff;--paper-soft:#faf9f6;--ink:#11110f;--muted:#5e5a52;--soft:#817b71;--line:#d4d0c7;--line-strong:#aaa49a;--red:#e60012;--green:#27704e;--focus:rgba(17,17,15,.18);--shadow:0 1px 0 rgba(17,17,15,.07),0 7px 20px rgba(17,17,15,.04)}
    *{box-sizing:border-box}html{min-width:320px;min-height:100%}body{min-height:100vh;margin:0;background:var(--canvas);color:var(--ink);font-family:Inter,"Noto Sans SC",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;text-rendering:geometricPrecision}
    button{font:inherit;cursor:pointer}button:focus-visible{outline:0;box-shadow:inset 0 -2px 0 var(--focus)}.page{min-height:100vh;padding:24px}.header{display:flex;align-items:center;justify-content:space-between;width:min(100%,1040px);margin:0 auto 40px;border-bottom:1px solid var(--line);padding-bottom:16px}.brand{display:flex;align-items:center;gap:10px}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:2px;background:var(--red);color:#fff;font-family:Georgia,"Times New Roman",serif;font-size:13px;font-weight:700;letter-spacing:-.08em}.brand-copy{display:grid;gap:4px}.brand-copy strong{font-size:16px;font-weight:900;line-height:1}.brand-copy small,.user-copy small{color:var(--soft);font-size:10px;font-weight:740}.user{display:flex;align-items:center;gap:8px}.avatar{display:grid;place-items:center;width:38px;height:38px;border:1px solid rgba(17,17,15,.16);border-radius:50%;background:#2c2b27;color:#fff;font-size:11px;font-weight:900}.user-copy{display:grid;gap:2px}.user-copy strong{font-size:12px}.paper{display:grid;gap:24px;width:min(100%,680px);margin:0 auto;border:1px solid var(--line-strong);border-top:4px solid var(--ink);background:var(--paper);box-shadow:var(--shadow);padding:clamp(24px,5vw,40px)}.intro{display:grid;gap:14px}.kicker{display:inline-flex;align-items:center;gap:8px;color:var(--green);font-size:12px;font-weight:900;text-transform:uppercase}.shield{display:grid;place-items:center;width:18px;height:18px;border:2px solid currentColor;border-radius:50%;font-size:10px;line-height:1}.intro h1{max-width:620px;margin:0;font-size:clamp(34px,6vw,42px);font-weight:900;line-height:1.04}.intro p{margin:0;color:var(--muted);font-size:16px;line-height:1.55}.connection{display:grid;border-block:1px solid var(--line)}.row{display:grid;grid-template-columns:132px minmax(0,1fr);gap:16px;border-bottom:1px solid var(--line);padding:16px 0}.row:last-child{border-bottom:0}.row-label{color:var(--muted);font-size:12px;font-weight:800}.row-value{font-weight:800;overflow-wrap:anywhere}.domains{display:grid;gap:12px}.domains-heading{display:grid;gap:5px}.domains-heading h2{margin:0;font-size:18px}.domains-heading p,.note{margin:0;color:var(--soft);font-size:12px;line-height:1.55}.domain-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0;padding:0;list-style:none}.domain-list li{display:grid;gap:4px;border:1px solid var(--line);background:var(--paper-soft);padding:12px}.domain-list strong{font-size:13px}.domain-list span{color:var(--muted);font-size:11px}.actions{display:flex;justify-content:flex-end;gap:12px;border-top:1px solid var(--line);padding-top:20px}.button{display:inline-flex;align-items:center;justify-content:center;min-height:40px;border-radius:3px;padding:0 16px;font-weight:860}.button:hover{transform:translateY(-1px)}.deny{border:1px solid var(--line-strong);background:var(--paper);color:var(--ink)}.approve{border:1px solid var(--ink);background:var(--ink);color:var(--paper)}
    @media(max-width:640px){.page{padding:16px}.header{margin-bottom:24px}.user-copy{display:none}.paper{padding:24px 16px}.row,.domain-list{grid-template-columns:1fr}.actions .button{flex:1 1 0}}
  </style>
</head>
<body>
  <main class="page">
    <header class="header">
      <div class="brand"><span class="brand-mark" aria-hidden="true">${escapeHtml(brand.logoText)}</span><span class="brand-copy"><strong>${escapeHtml(brand.name)}</strong><small>工作空间</small></span></div>
      <div class="user"><span class="avatar" aria-hidden="true">${escapeHtml(userInitial)}</span><span class="user-copy"><small>当前登录</small><strong>${escapeHtml(userName)}</strong></span></div>
    </header>
    <section class="paper">
      <div class="intro">
        <span class="kicker"><span class="shield" aria-hidden="true">✓</span>安全连接</span>
        <h1>授权 Workspace MCP</h1>
        <p><strong>${escapeHtml(input.clientName)}</strong> 希望连接你的 ${escapeHtml(brand.name)} 工作空间。</p>
      </div>
      <div class="connection">
        <div class="row"><span class="row-label">连接方式</span><span class="row-value">统一 MCP 工具连接</span></div>
        <div class="row"><span class="row-label">有效期</span><span class="row-value">持续使用时保持有效；连续 7 天未使用后自动失效</span></div>
      </div>
      <div class="domains">
        <div class="domains-heading"><h2>可使用领域</h2><p>目前所有连接使用统一能力范围。领域标签仅说明工具覆盖范围，不代表独立权限，也无需逐项选择。</p></div>
        <ul class="domain-list">${domainItems}</ul>
      </div>
      <p class="note">批准后，新 task 会自动使用这条连接；已经打开的 task 需要重新加载。</p>
      <form method="post">
        <input type="hidden" name="request_token" value="${escapeHtml(input.requestToken)}">
        <div class="actions"><button class="button deny" name="decision" value="deny">拒绝</button><button class="button approve" name="decision" value="approve">批准连接</button></div>
      </form>
    </section>
  </main>
</body>
</html>`;
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackSource}; base-uri 'none'; frame-ancestors 'none'`,
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function mcpOAuthConsentDomains() {
  return [
    { name: "Forum", description: "讨论与协作" },
    { name: "Hub", description: "资源与发现" },
    { name: "APPS", description: "Apps 与 Skills" },
    { name: "Knowledge", description: "知识服务" }
  ];
}
