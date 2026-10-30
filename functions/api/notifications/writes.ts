export type NotificationWriteInput = {
  actorUserId?: string;
  dedupeKey: string;
  entityId: string;
  entityType: string;
  href?: string;
  id?: string;
  metadata?: Record<string, unknown>;
  notificationType: string;
  parentId?: string;
  parentType?: string;
  recipientUserId: string;
  summary: string;
};

export type IdentifiedNotificationWriteInput = NotificationWriteInput & {
  id: string;
};

export function notificationWriteWithId(input: NotificationWriteInput): IdentifiedNotificationWriteInput {
  return {
    ...input,
    id: input.id ?? crypto.randomUUID()
  };
}

export function notificationInsertStatement(db: D1Database, input: NotificationWriteInput) {
  const identifiedInput = notificationWriteWithId(input);
  return db
    .prepare(
      `
      INSERT OR IGNORE INTO notifications (
        id,
        recipient_user_id,
        actor_user_id,
        notification_type,
        entity_type,
        entity_id,
        parent_type,
        parent_id,
        summary,
        href,
        metadata_json,
        dedupe_key
      )
      VALUES (?, ?, NULLIF(?, ''), ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, ?)
      `
    )
    .bind(
      identifiedInput.id,
      identifiedInput.recipientUserId,
      identifiedInput.actorUserId ?? "",
      identifiedInput.notificationType,
      identifiedInput.entityType,
      identifiedInput.entityId,
      identifiedInput.parentType ?? "",
      identifiedInput.parentId ?? "",
      identifiedInput.summary,
      identifiedInput.href ?? "",
      JSON.stringify(identifiedInput.metadata ?? {}),
      identifiedInput.dedupeKey
    );
}
