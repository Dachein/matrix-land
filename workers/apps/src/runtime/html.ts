import { installationAppHostPrefix } from "../../../../src/shared/installationDomains";
import type { AppsApp } from "../../../../src/shared/types";
import type { Env } from "../core/types";
import { normalizeAppCode, readString } from "../core/utils";
import { baseDomain, platformMcpUrl } from "./urls";

export function runtimeHost(url: URL, env: Env): { appCode: string; appPath: string; environment: "production"; sharedOrigin: boolean } | undefined {
  const domain = baseDomain(env).toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const platformHost = new URL(platformMcpUrl(env)).hostname.toLowerCase();

  if (hostname === platformHost) {
    const pathMatch = url.pathname.match(/^\/run\/([^/]+)(\/.*)?$/);
    if (!pathMatch?.[1]) {
      return undefined;
    }

    const appCode = normalizeAppCode(decodeURIComponent(pathMatch[1]));
    if (!appCode) {
      return undefined;
    }

    return {
      appCode,
      appPath: pathMatch[2] || "/",
      environment: "production",
      sharedOrigin: true
    };
  }

  if (!hostname.endsWith(`.${domain}`)) {
    return undefined;
  }

  const subdomain = hostname.slice(0, -(domain.length + 1));
  if (!subdomain) {
    return undefined;
  }

  const prefix = installationAppHostPrefix(env.APPS_APP_HOST_PREFIX ?? "");
  if (!subdomain.startsWith(prefix) || subdomain.includes(".")) return undefined;
  const candidate = subdomain.slice(prefix.length);
  const appCode = normalizeAppCode(candidate);
  if (candidate !== appCode) return undefined;
  return appCode ? { appCode, appPath: url.pathname || "/", environment: "production", sharedOrigin: false } : undefined;
}

export function htmlResponse(body: string, options: { method?: string; status?: number } = {}) {
  return new Response(options.method === "HEAD" ? null : body, {
    status: options.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'none'; base-uri 'none'"
    }
  });
}

export function appRuntimeHtml(app: AppsApp, environment: "production") {
  const runtimeUrl = app.productionUrl;
  const resources = app.resources
    .slice(0, 8)
    .map((resource) => `<li><strong>${escapeHtml(resource.type)}</strong><span>${escapeHtml(resource.resourceName)}</span><em>${escapeHtml(resource.environment)} / ${escapeHtml(resource.status)}</em></li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(app.name)} · Workspace APPS</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f6fa; color: #171b24; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px; }
    main { width: min(920px, 100%); border: 1px solid #dfe5ee; border-radius: 12px; background: #fff; box-shadow: 0 20px 70px rgba(15, 23, 42, .08); overflow: hidden; }
    header { display: grid; gap: 14px; padding: 28px; border-bottom: 1px solid #e6ebf2; }
    .eyebrow { color: #e11d2e; font-size: 12px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 28px; line-height: 1.15; }
    p { margin: 0; color: #667085; line-height: 1.6; }
    .badges, .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .badge { border: 1px solid #dfe5ee; border-radius: 999px; background: #f8fafc; padding: 6px 10px; color: #475467; font-size: 12px; font-weight: 800; }
    .badge.ok { border-color: #bde8d2; background: #ecfdf3; color: #079455; }
    .body { display: grid; grid-template-columns: 1.1fr .9fr; gap: 20px; padding: 24px 28px 28px; }
    section { display: grid; gap: 12px; min-width: 0; }
    h2 { margin: 0; font-size: 15px; }
    dl { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 10px 14px; margin: 0; font-size: 13px; }
    dt { color: #667085; }
    dd { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 800; }
    ul { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
    li { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 4px 10px; border: 1px solid #e6ebf2; border-radius: 8px; padding: 10px; }
    li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    li em { grid-column: 2; color: #667085; font-style: normal; font-size: 12px; }
    a { display: inline-flex; align-items: center; justify-content: center; min-height: 38px; border: 1px solid #dfe5ee; border-radius: 8px; padding: 0 12px; color: #171b24; text-decoration: none; font-weight: 900; }
    a.primary { border-color: #111827; background: #111827; color: #fff; }
    @media (max-width: 760px) { body { padding: 18px; } .body { grid-template-columns: 1fr; } dl { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <span class="eyebrow">Workspace APPS runtime</span>
      <h1>${escapeHtml(app.name)}</h1>
      <p>${escapeHtml(app.description)}</p>
      <div class="badges">
        <span class="badge ok">${escapeHtml(app.status)}</span>
        <span class="badge">${escapeHtml(app.type)}</span>
        <span class="badge">${escapeHtml(app.visibility)}</span>
        <span class="badge">${app.loginRequired ? "login required" : "public access"}</span>
      </div>
    </header>
    <div class="body">
      <section>
        <h2>Runtime</h2>
        <dl>
          <dt>App ID</dt><dd>${escapeHtml(app.id)}</dd>
          <dt>App Code</dt><dd>${escapeHtml(app.appCode)}</dd>
          <dt>Environment</dt><dd>${escapeHtml(environment)}</dd>
          <dt>Data Service</dt><dd>${escapeHtml(app.dataServiceId)}</dd>
          <dt>Current URL</dt><dd>${escapeHtml(runtimeUrl)}</dd>
        </dl>
        <div class="actions">
          <a class="primary" href="${escapeHtml(runtimeUrl)}">Open Production</a>
        </div>
      </section>
      <section>
        <h2>Provisioned resources</h2>
        <ul>${resources || "<li><strong>Resources</strong><span>Pending</span><em>No resources yet</em></li>"}</ul>
      </section>
    </div>
  </main>
</body>
</html>`;
}

export function runtimeErrorHtml(title: string, message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(title)} · Workspace APPS</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6fa;color:#171b24;font-family:Inter,ui-sans-serif,system-ui,sans-serif;padding:24px}main{width:min(560px,100%);border:1px solid #dfe5ee;border-radius:12px;background:#fff;padding:24px;box-shadow:0 20px 70px rgba(15,23,42,.08)}p{color:#667085;line-height:1.6}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function escapeHtml(value: unknown) {
  return readString(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
