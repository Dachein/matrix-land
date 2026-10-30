import type { Env, NamespaceRow, Principal } from "../types.ts";
import { safeErrorName } from "../errors.ts";

export async function writeAuditEvent(env: Env, input: {
  action: string;
  actorUserId?: string;
  metadata?: Record<string, unknown>;
  namespace: NamespaceRow;
  objectId?: string | null;
  principal?: Principal;
}) {
  const actorUserId = input.principal?.sub ?? input.actorUserId ?? "system";
  const metadata = {
    ...(input.metadata ?? {}),
    orgId: input.namespace.org_id
  };
  try {
    await env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_audit_events (
           id, actor_user_id, namespace_id, object_id, action, decision, metadata_json
         ) VALUES (?, ?, ?, ?, ?, 'allow', ?)`
      )
      .bind(
        `kaudit_${crypto.randomUUID()}`,
        actorUserId,
        input.namespace.id,
        input.objectId ?? null,
        input.action,
        JSON.stringify(metadata)
      )
      .run();
  } catch (error) {
    // Audit storage must not turn an already-committed permission/share change
    // into a misleading client failure. Surface the fault to Worker logs.
    console.error("knowledge_audit_write_failed", {
      action: input.action,
      errorName: safeErrorName(error),
      namespaceId: input.namespace.id,
      objectId: input.objectId ?? null
    });
  }
}
