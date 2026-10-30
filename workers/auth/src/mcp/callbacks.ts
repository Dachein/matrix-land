import { redirect } from "../session/cookies.ts";
import { escapeHtml } from "../values.ts";

// Validate and deliver registered MCP OAuth callbacks without owning authorization state.
export function redirectMcpOAuthError(redirectUri: string, state: string | null | undefined, error: string) {
  const callback = new URL(redirectUri);
  callback.searchParams.set("error", error);
  if (state) callback.searchParams.set("state", state);
  return deliverMcpOAuthCallback(callback);
}

export function deliverMcpOAuthCallback(callback: URL) {
  if (!isWorkBuddyMcpOAuthCallbackDeliveryUrl(callback)) {
    return redirect(callback.toString(), { headers: { "Cache-Control": "no-store" } });
  }

  const callbackUrl = callback.toString();
  const callbackJson = JSON.stringify(callbackUrl).replace(/</g, "\\u003c");
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>正在返回 WorkBuddy</title>
  <style>
    :root{color-scheme:light;--canvas:#f3f2ee;--paper:#fff;--ink:#11110f;--muted:#6f6a61;--line:#aaa49a;--green:#27704e}
    *{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;background:var(--canvas);color:var(--ink);font-family:Inter,"Noto Sans SC",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}.paper{width:min(100%,560px);border:1px solid var(--line);border-top:4px solid var(--ink);background:var(--paper);padding:40px;box-shadow:0 7px 20px rgba(17,17,15,.05)}.kicker{color:var(--green);font-size:13px;font-weight:850}.paper h1{margin:14px 0 10px;font-size:34px;line-height:1.08}.paper p{margin:0;color:var(--muted);font-size:15px;line-height:1.6}.button{display:flex;align-items:center;justify-content:center;min-height:46px;margin-top:28px;border:1px solid var(--ink);border-radius:3px;background:var(--ink);color:#fff;font-weight:850;text-decoration:none}.hint{margin-top:14px!important;font-size:12px!important}@media(max-width:560px){.paper{padding:28px 22px}}
  </style>
</head>
<body>
  <main class="paper">
    <span class="kicker">✓ Workspace MCP 已授权</span>
    <h1>正在返回 WorkBuddy</h1>
    <p>浏览器会自动尝试打开 WorkBuddy。如果没有自动打开，请点击下面的按钮。</p>
    <a class="button" id="open-workbuddy" href="${escapeHtml(callbackUrl)}">打开 WorkBuddy</a>
    <p class="hint">完成连接后可以关闭此页面。</p>
  </main>
  <script nonce="${nonce}">window.location.replace(${callbackJson});</script>
</body>
</html>`;
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export function isSafeMcpOAuthRedirectUri(value: string) {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (isWorkBuddyMcpOAuthRedirectUri(url)) return true;
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (loopback && (url.protocol === "http:" || url.protocol === "https:")) return true;
    if (url.protocol === "cursor:" && url.hostname === "anysphere.cursor-mcp" && url.pathname === "/oauth/callback") return true;
    return url.protocol === "https:"
      && url.hostname === "www.cursor.com"
      && url.pathname === "/agents/mcp/oauth/callback";
  } catch {
    return false;
  }
}

function isWorkBuddyMcpOAuthRedirectUri(url: URL) {
  return url.protocol === "workbuddy:"
    && url.hostname === "workbuddy"
    && url.port === ""
    && url.pathname === "/mcp/custom-mcp%3Aworkspace-ai/oauth/callback"
    && url.search === ""
    && url.hash === ""
    && url.username === ""
    && url.password === "";
}

function isWorkBuddyMcpOAuthCallbackDeliveryUrl(url: URL) {
  return url.protocol === "workbuddy:"
    && url.hostname === "workbuddy"
    && url.port === ""
    && url.pathname === "/mcp/custom-mcp%3Aworkspace-ai/oauth/callback"
    && url.hash === ""
    && url.username === ""
    && url.password === "";
}

export function describeMcpOAuthRedirectUri(value: string) {
  try {
    const url = new URL(value);
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      hasQuery: Boolean(url.search),
      hasHash: Boolean(url.hash),
      hasUserInfo: Boolean(url.username || url.password)
    };
  } catch {
    return {
      parseable: false,
      valueLength: value.length
    };
  }
}
