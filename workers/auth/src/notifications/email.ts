import { json, readJson } from "../http.ts";
import { type Env, HttpError } from "../types.ts";
import { normalizeEmailAddress, readOptionalString, readString, requireText } from "../values.ts";

// Portal notification delivery and audit boundary.
type PortalNotificationEmailBody = {
  cc?: unknown;
  from?: unknown;
  html?: unknown;
  subject?: unknown;
  text?: unknown;
  to?: unknown;
};

export async function sendPortalNotificationEmail(request: Request, env: Env, requestId: string) {
  if (!env.AUTH_EMAIL?.send) {
    throw new HttpError(503, "auth_email_not_configured");
  }

  const body = await readJson<PortalNotificationEmailBody>(request);
  const configuredFrom = normalizeEmailAddress(env.EMAIL_OTP_FROM ?? "");
  const from = normalizeEmailAddress(body.from ?? configuredFrom);
  if (!from || !configuredFrom || from !== configuredFrom) {
    throw new HttpError(403, "invalid_notification_email_sender");
  }

  const to = normalizeEmailAddress(body.to);
  if (!to) {
    throw new HttpError(400, "invalid_notification_email_recipient");
  }

  let cc: string[] | undefined;
  if (body.cc !== undefined) {
    if (!Array.isArray(body.cc) || body.cc.length > 20) {
      throw new HttpError(400, "invalid_notification_email_cc");
    }
    cc = body.cc.map((address) => normalizeEmailAddress(address));
    if (cc.some((address) => !address)) {
      throw new HttpError(400, "invalid_notification_email_cc");
    }
    cc = [...new Set(cc)];
  }

  const subject = requireText(body.subject, "missing_notification_email_subject", 240);
  const html = readString(body.html).trim();
  const text = readString(body.text).trim();
  if (!html && !text) {
    throw new HttpError(400, "missing_notification_email_content");
  }
  if (html.length > 200_000 || text.length > 100_000) {
    throw new HttpError(413, "notification_email_content_too_large");
  }

  const result = await env.AUTH_EMAIL.send({
    ...(cc?.length ? { cc } : {}),
    from,
    ...(html ? { html } : {}),
    subject,
    ...(text ? { text } : {}),
    to
  });
  if (readString(result?.status).trim().toLowerCase() === "failed") {
    throw new HttpError(502, "notification_email_delivery_failed");
  }

  return json({
    messageId: readOptionalString(result?.messageId),
    requestId,
    sent: true
  }, { status: 202 });
}
