import type { Principal } from "./types";
import { randomToken } from "./utils";

export async function audit(
  db: D1Database,
  principal: Principal,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>
) {
  await db
    .prepare(
      `
      INSERT INTO apps_audit_logs (id, actor_user_id, org_id, action, target_type, target_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(`audit_${randomToken(12)}`, principal.sub, principal.orgId, action, targetType, targetId, JSON.stringify(metadata), new Date().toISOString())
    .run();
}
