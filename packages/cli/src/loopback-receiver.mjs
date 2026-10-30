import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const LOOPBACK_HOST = "127.0.0.1";

export async function createLoopbackReceiver(options = {}) {
  const callbackPath = options.callbackPath ?? `/oauth/callback/${(options.randomBytes ?? randomBytes)(18).toString("base64url")}`;
  if (!/^\/oauth\/callback(?:\/[A-Za-z0-9_-]+)?$/.test(callbackPath)) throw new Error("Invalid OAuth loopback callback path");
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 10 * 60 * 1_000);
  let address;
  let settled = false;
  let timer;
  let resolveCallback;
  let rejectCallback;
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${LOOPBACK_HOST}:${address?.port || 0}`);
    if (request.method !== "GET" || requestUrl.pathname !== callbackPath) {
      response.writeHead(404, secureHtmlHeaders());
      response.end(completionPage(false, "这个本地回调地址无效，请返回 Frontier Workspace 重新授权。"));
      return;
    }
    if (settled) {
      response.writeHead(409, secureHtmlHeaders());
      response.end(completionPage(false, "这次授权回调已经处理，请返回发起授权的 Agent。"));
      return;
    }
    settled = true;
    clearTimeout(timer);
    if (options.expectedState && requestUrl.searchParams.get("state") !== options.expectedState) {
      response.writeHead(400, secureHtmlHeaders());
      response.end(completionPage(false, "这次授权回调无法验证，请返回 Frontier Workspace 重新授权。"));
      rejectCallback(new Error("OAuth callback state did not match the pending Workspace authorization"));
      return;
    }
    const failed = Boolean(requestUrl.searchParams.get("error"));
    response.writeHead(failed ? 400 : 200, secureHtmlHeaders());
    response.end(completionPage(!failed, failed
      ? "没有签发任何凭据。你可以关闭此页面后重新尝试。"
      : "Workspace CLI 已收到授权结果，正在安全完成连接。现在可以关闭此页面。"));
    resolveCallback(requestUrl);
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true });
  });

  address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Unable to allocate a Workspace OAuth loopback port");
  }

  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectCallback(new Error("Workspace OAuth authorization timed out"));
    void closeServer(server);
  }, timeoutMs);

  return {
    redirectUri: `http://${LOOPBACK_HOST}:${address.port}${callbackPath}`,
    async waitForCallback() {
      return callback;
    },
    async close() {
      clearTimeout(timer);
      await closeServer(server);
    }
  };
}

function secureHtmlHeaders() {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  };
}

function completionPage(success, message) {
  const title = success ? "授权成功" : "授权未完成";
  const marker = success ? "✓ 安全连接" : "连接未完成";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
  :root{color-scheme:light;--ink:#11110f;--muted:#68635b;--line:#aaa49a;--green:#27704e}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;background:#f3f2ee;color:var(--ink);font-family:Inter,"Noto Sans SC",system-ui,sans-serif;padding:24px}main{width:min(100%,620px);border:1px solid var(--line);border-top:4px solid var(--ink);background:#fff;padding:40px;box-shadow:0 8px 24px rgba(0,0,0,.05)}.marker{color:${success ? "var(--green)" : "var(--muted)"};font-weight:850}h1{font-size:36px;margin:12px 0}p{color:var(--muted);line-height:1.65}
  </style></head><body><main><span class="marker">${marker}</span><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
