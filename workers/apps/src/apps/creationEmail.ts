import { platformBrandFromEnv } from "../../../../src/shared/platformBrand.ts";
import { renderCollaborationNotificationEmail } from "../../../../src/shared/collaborationNotificationEmail";
import type { AppsApp } from "../../../../src/shared/types";
import type { Env, Principal } from "../core/types";

export function renderAppCreationEmail(app: AppsApp, principal: Principal, env: Pick<Env, "PLATFORM_BRAND_JSON" | "APP_CREATION_EMAIL_INSTRUCTIONS"> = {}) {
  return renderCollaborationNotificationEmail({
    kind: "app_created",
    actorName: principal.name || principal.sub,
    recipientName: principal.name,
    recipientStatus: "active",
    resourceType: "app",
    resourceName: app.name,
    resourceUrl: app.productionUrl,
    excerpt: env.APP_CREATION_EMAIL_INSTRUCTIONS?.trim()
  }, platformBrandFromEnv(env));
}

// Delivery is best effort: a mail failure must not turn a persisted creation
// into an API failure and cause clients to create duplicate apps on retry.
export async function sendAppCreationEmail(env: Env, principal: Principal, app: AppsApp): Promise<void> {
  const recipient = principal.email?.trim();
  const token = (env.APPS_AUTH_SERVICE_TOKEN || env.AUTH_SERVICE_TOKEN)?.trim();
  const baseUrl = (env.AUTH_WORKER_URL || env.AUTH_ISSUER)?.trim();
  if (!recipient || !token || (!env.AUTH_SERVICE && !baseUrl)) {
    console.warn("apps_app_creation_email_skipped", { appId: app.id, reason: !recipient ? "missing_creator_email" : "mail_service_not_configured" });
    return;
  }
  try {
    const cc = configuredCopyRecipients(env.APP_CREATION_EMAIL_CC);
    const request = new Request(`${(baseUrl || "https://auth.internal").replace(/\/+$/, "")}/v1/notifications/email`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...renderAppCreationEmail(app, principal, env),
        ...(env.WORKSPACE_EMAIL_FROM?.trim() ? { from: env.WORKSPACE_EMAIL_FROM.trim() } : {}),
        to: recipient,
        ...(cc.length ? { cc } : {})
      }),
      signal: AbortSignal.timeout(8000)
    });
    const response = await (env.AUTH_SERVICE ? env.AUTH_SERVICE.fetch(request) : fetch(request));
    if (!response.ok) throw new Error(`email_dispatch_http_${response.status}`);
  } catch (error) {
    console.warn("apps_app_creation_email_failed", { appId: app.id, error: error instanceof Error ? error.message : "unknown" });
  }
}

function configuredCopyRecipients(value: string | undefined) {
  if (!value?.trim()) return [];
  const addresses = [...new Set(value.split(",").map((entry) => entry.trim().toLowerCase()))];
  if (addresses.length > 20 || addresses.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error("invalid_app_creation_email_cc");
  }
  return addresses;
}
