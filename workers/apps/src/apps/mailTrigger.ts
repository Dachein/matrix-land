import {
  WORKSPACE_MAIL_EVENT_PATH,
  type WorkspaceMailEvent,
} from "../../../../sdk/mail/events.ts";
import type { MailAuthority } from "../../../../src/shared/workspaceMailClient.ts";
import { decryptSecretValue } from "../core/auth";
import { HttpError, type Env } from "../core/types";
import type { AppsAppRow, AppsAppSecretRow } from "../db/rows";
import { runtimeUrls } from "../runtime/urls";

/** Only the mail service can reach this route; callbacks always target the app's canonical host. */
export async function deliverAppMailEvent(
  env: Env,
  authority: MailAuthority,
  event: WorkspaceMailEvent,
) {
  if (
    !authority.appId ||
    !authority.scopes.includes("mail:app-event") ||
    event.appId !== authority.appId ||
    event.id !== event.messageId ||
    event.type !== "workspace.mail.received"
  )
    throw new HttpError(403, "mail_app_event_denied");
  const app = await env.APPS_DB.prepare(
    "SELECT * FROM apps_apps WHERE id=? AND org_id=? AND owner_user_id=? AND status='published'",
  )
    .bind(authority.appId, authority.orgId, authority.userId)
    .first<AppsAppRow>();
  if (!app) throw new HttpError(409, "mail_app_not_published");
  const enabled = await env.APPS_DB.prepare(
    "SELECT value FROM apps_app_env_vars WHERE app_id=? AND name='WORKSPACE_MAIL_TRIGGER_ENABLED' AND environment='production' AND target='runtime'",
  )
    .bind(app.id)
    .first<{ value: string }>();
  if (enabled?.value !== "1")
    throw new HttpError(409, "mail_app_trigger_disabled");
  const secret = await env.APPS_DB.prepare(
    "SELECT * FROM apps_app_secrets WHERE app_id=? AND name='WORKSPACE_MAIL_TOKEN' AND environment='production' AND status='configured'",
  )
    .bind(app.id)
    .first<AppsAppSecretRow>();
  if (!secret?.cipher_iv || !secret.cipher_text)
    throw new HttpError(503, "mail_app_token_unavailable");
  const token = await decryptSecretValue(env, {
    algorithm: secret.algorithm,
    cipherIv: secret.cipher_iv,
    cipherText: secret.cipher_text,
  });
  const raw = JSON.stringify(event),
    timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = [
    ...new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${timestamp}.${raw}`),
      ),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const callback = new URL(
    WORKSPACE_MAIL_EVENT_PATH,
    runtimeUrls(env, app.code || app.slug).productionUrl,
  );
  const response = await fetch(callback, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-workspace-mail-signature": `t=${timestamp},v1=${signature}`,
    },
    body: raw,
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  // A generic HTML/login 200 is not evidence that an application accepted the event.
  const accepted =
    response.ok && response.headers.get("x-workspace-mail-ack") === event.id;
  await response.body?.cancel();
  if (!accepted) throw new HttpError(502, "mail_app_event_not_acknowledged");
  return { delivered: true };
}
