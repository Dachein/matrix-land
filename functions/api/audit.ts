export async function audit(
  db: D1Database | undefined,
  actorType: string,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>
) {
  const id = crypto.randomUUID();

  if (db) {
    await db
      .prepare(
        `
        INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(id, actorType, actorId, action, targetType, targetId, JSON.stringify(metadata))
      .run();
  }

  return id;
}
