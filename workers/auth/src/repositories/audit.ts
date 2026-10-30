import type { AuditEventInput, Env } from "../types.ts";

// Append Auth audit records without owning business transactions.
export async function recordAuditEvent(env: Env, event: AuditEventInput) {
  const id = crypto.randomUUID();

  if (!env.AUTH_DB) {
    return { id, stored: false };
  }

  await env.AUTH_DB
    .prepare(
      `
      INSERT INTO auth_audit_events (
        id,
        request_id,
        actor_user_id,
        client_app_id,
        action,
        resource_type,
        resource_id,
        decision,
        reason,
        metadata_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `
    )
    .bind(
      id,
      event.requestId ?? null,
      event.actorUserId ?? null,
      event.clientAppId ?? null,
      event.action,
      event.resourceType ?? null,
      event.resourceId ?? null,
      event.decision ?? null,
      event.reason ?? null,
      JSON.stringify(event.metadata ?? {})
    )
    .run();

  return { id, stored: true };
}
