export interface Env {
  AUTH_WORKER_URL?: string;
}

type AccessCode = "ACCESS_NOT_GRANTED" | "ACCESS_PENDING" | "USER_INACTIVE" | "APP_UNAVAILABLE";

type AccessResult = {
  app?: { id?: string; name?: string };
  code?: AccessCode;
  launchUrl?: string;
  requestId?: string;
  valid?: boolean;
};

type AccessPageModel = {
  appName: string;
  code: AccessCode | "AUTH_RESULT_INVALID" | "AUTH_SERVICE_UNAVAILABLE";
  descriptionEn: string;
  descriptionZh: string;
  eyebrow: string;
  launchUrl?: string;
  requestId?: string;
  status: number;
  titleEn: string;
  titleZh: string;
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const url = new URL(context.request.url);
  const result = url.searchParams.get("result")?.trim();
  const model = await resolveAccessPage(context.env, result);
  const body = context.request.method === "HEAD" ? null : accessPageHtml(model, url.origin);
  return new Response(body, {
    status: model.status,
    headers: {
      "Cache-Control": "no-store, private",
      "Content-Language": "zh-Hans, en",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    }
  });
};

async function resolveAccessPage(env: Env, result: string | undefined): Promise<AccessPageModel> {
  if (!result) {
    return pageModel("AUTH_RESULT_INVALID");
  }
  const authOrigin = env.AUTH_WORKER_URL?.trim().replace(/\/+$/, "");
  if (!authOrigin) {
    return pageModel("AUTH_SERVICE_UNAVAILABLE");
  }

  try {
    const endpoint = new URL("/auth/access/result", authOrigin);
    endpoint.searchParams.set("result", result);
    const response = await fetch(endpoint.toString(), {
      headers: { Accept: "application/json" },
      redirect: "manual"
    });
    const payload = await response.json().catch(() => ({})) as AccessResult;
    if (!response.ok || payload.valid !== true || !isAccessCode(payload.code)) {
      return pageModel("AUTH_RESULT_INVALID");
    }
    return pageModel(payload.code, payload);
  } catch {
    return pageModel("AUTH_SERVICE_UNAVAILABLE");
  }
}

function pageModel(
  code: AccessPageModel["code"],
  result: AccessResult = {}
): AccessPageModel {
  const shared = {
    appName: cleanText(result.app?.name, 160) || "Workspace App",
    code,
    launchUrl: safeHttpsUrl(result.launchUrl),
    requestId: cleanText(result.requestId, 160) || undefined
  };

  if (code === "ACCESS_PENDING") {
    return {
      ...shared,
      descriptionEn: "Your access request is still being reviewed. You can return after the app author approves it.",
      descriptionZh: "你的访问申请仍在审批中。App 作者批准后，即可重新进入。",
      eyebrow: "App access · Pending",
      status: 403,
      titleEn: "Access pending",
      titleZh: "等待授权"
    };
  }
  if (code === "USER_INACTIVE") {
    return {
      ...shared,
      descriptionEn: "Your Workspace account is currently unavailable. Please contact your organization administrator.",
      descriptionZh: "你的 Workspace 账户当前不可用，请联系公司管理员。",
      eyebrow: "Account access · 403",
      status: 403,
      titleEn: "Account unavailable",
      titleZh: "账户不可用"
    };
  }
  if (code === "APP_UNAVAILABLE") {
    return {
      ...shared,
      descriptionEn: "This app is not available at the moment. Please contact the app author for assistance.",
      descriptionZh: "此 App 当前不可用，请联系 App 作者处理。",
      eyebrow: "App status · Unavailable",
      status: 403,
      titleEn: "App unavailable",
      titleZh: "App 暂不可用"
    };
  }
  if (code === "AUTH_RESULT_INVALID") {
    return {
      ...shared,
      descriptionEn: "This access result has expired or is invalid. Please reopen the app to start again.",
      descriptionZh: "本次访问结果已过期或无效，请重新打开 App。",
      eyebrow: "Workspace Auth · Invalid result",
      status: 400,
      titleEn: "Session expired",
      titleZh: "登录已过期"
    };
  }
  if (code === "AUTH_SERVICE_UNAVAILABLE") {
    return {
      ...shared,
      descriptionEn: "Workspace Auth is temporarily unavailable. Please try again in a moment.",
      descriptionZh: "Workspace Auth 暂时不可用，请稍后重试。",
      eyebrow: "Workspace Auth · Unavailable",
      status: 503,
      titleEn: "Please try again",
      titleZh: "暂时无法验证"
    };
  }
  return {
    ...shared,
    descriptionEn: "You don’t have permission to access this app. Please contact the app author to request access.",
    descriptionZh: "你没有足够权限访问此 App，请联系 App 作者给予授权。",
    eyebrow: "App access · 403",
    status: 403,
    titleEn: "Access restricted",
    titleZh: "访问受限"
  };
}

function accessPageHtml(model: AccessPageModel, portalOrigin: string) {
  const appName = escapeHtml(model.appName);
  const requestId = model.requestId ? escapeHtml(model.requestId) : "";
  const retry = model.launchUrl
    ? `<a class="button button--secondary" href="${escapeAttribute(model.launchUrl)}">重新尝试 · Retry</a>`
    : "";
  const reference = requestId
    ? `<p class="reference">参考编号 · Reference <code>${requestId}</code></p>`
    : "";

  return `<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(model.titleZh)} · ${escapeHtml(model.titleEn)}</title>
  <style>
    :root { color-scheme:light; --portal-canvas:#f3f2ee; --portal-paper:#fff; --portal-ink:#11110f; --portal-muted:#5e5a52; --portal-soft:#817b71; --portal-line:#d4d0c7; --portal-line-strong:#aaa49a; --portal-red:#e60012; --portal-focus-ring:rgba(36,92,171,.26); --portal-radius:3px; font-family:Inter,"Noto Sans SC",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    * { box-sizing:border-box; }
    html { min-width:320px; min-height:100%; }
    body { min-height:100%; margin:0; overflow-x:hidden; background:var(--portal-canvas); color:var(--portal-ink); font-size:12px; text-rendering:geometricPrecision; }
    h1,p { margin:0; }
    a { color:inherit; text-decoration:none; -webkit-tap-highlight-color:transparent; }
    a:focus-visible { outline:3px solid var(--portal-focus-ring); outline-offset:2px; }
    .auth-gate { display:grid; grid-template-columns:auto minmax(0,1fr); align-content:center; justify-items:start; gap:18px; width:min(620px,calc(100% - 40px)); min-height:100vh; margin:0 auto; padding:40px 0; }
    .brand { display:flex; grid-column:1 / -1; align-items:center; gap:10px; font-size:16px; }
    .brand-mark { display:grid; place-items:center; width:30px; height:30px; border-radius:2px; background:var(--portal-red); color:var(--portal-paper); font-family:Georgia,"Times New Roman",serif; font-size:13px; font-weight:700; letter-spacing:-.08em; line-height:1; }
    .brand strong { font-weight:920; }
    .status-icon { display:grid; place-items:center; width:38px; height:38px; border:1px solid var(--portal-line-strong); border-radius:var(--portal-radius); background:var(--portal-paper); color:var(--portal-ink); }
    .status-icon svg { width:20px; height:20px; }
    .app-context { display:grid; align-self:center; gap:3px; min-width:0; }
    .app-context small { color:var(--portal-soft); font-size:10px; font-weight:900; text-transform:uppercase; }
    .app-context strong { overflow:hidden; font-size:13px; font-weight:850; text-overflow:ellipsis; white-space:nowrap; }
    h1 { grid-column:1 / -1; max-width:620px; font-size:42px; font-weight:900; line-height:1.05; letter-spacing:0; }
    h1 span { display:block; margin-top:8px; color:var(--portal-soft); font-size:18px; font-weight:760; line-height:1.2; }
    .message { grid-column:1 / -1; max-width:500px; color:var(--portal-muted); font-size:15px; line-height:1.58; }
    .message span { display:block; margin-top:5px; color:var(--portal-soft); font-size:13px; }
    .actions { display:flex; grid-column:1 / -1; flex-wrap:wrap; gap:8px; }
    .button { display:inline-flex; align-items:center; justify-content:center; min-height:38px; border-radius:var(--portal-radius); padding:0 14px; font-weight:860; transition:transform 140ms ease; }
    .button--primary { border:1px solid var(--portal-ink); background:var(--portal-ink); color:var(--portal-paper); }
    .button--secondary { border:1px solid var(--portal-line-strong); background:var(--portal-paper); color:var(--portal-ink); }
    .button:hover { transform:translateY(-1px); }
    .reference { grid-column:1 / -1; color:var(--portal-soft); font-size:10px; line-height:1.5; }
    .reference code { color:var(--portal-muted); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
    @media (max-width:600px) { .auth-gate{align-content:start;width:min(100% - 32px,620px);padding:72px 0 36px} h1{font-size:34px}.message{font-size:14px}.actions{display:grid;width:100%}.button{width:100%}.app-context strong{white-space:normal} }
    @media (prefers-reduced-motion:reduce) { .button{transition:none} }
  </style>
</head>
<body>
  <main class="auth-gate" aria-labelledby="access-title">
    <div class="brand"><span class="brand-mark" aria-hidden="true">AI</span><strong>Frontier Workspace</strong></div>
    <span class="status-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="1"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></span>
    <div class="app-context"><small>${escapeHtml(model.eyebrow)}</small><strong>${appName}</strong></div>
    <h1 id="access-title">${escapeHtml(model.titleZh)}<span>${escapeHtml(model.titleEn)}</span></h1>
    <p class="message">${escapeHtml(model.descriptionZh)}<span>${escapeHtml(model.descriptionEn)}</span></p>
    <div class="actions">
      <a class="button button--primary" href="${escapeAttribute(portalOrigin)}/">返回 Frontier Workspace · Back to Frontier Workspace</a>
      ${retry}
    </div>
    ${reference}
  </main>
</body>
</html>`;
}

function isAccessCode(value: unknown): value is AccessCode {
  return ["ACCESS_NOT_GRANTED", "ACCESS_PENDING", "USER_INACTIVE", "APP_UNAVAILABLE"].includes(String(value));
}

function safeHttpsUrl(value: unknown) {
  const text = cleanText(value, 800);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}
