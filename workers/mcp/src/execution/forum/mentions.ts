type McpMentionTarget = { text: string; userId: string };

export function parseMcpMentionPrefixes(value: string) {
  return Array.from(value.matchAll(/(?:^|[\s([{"'，。！？、:：;；])@([a-zA-Z0-9._-]{1,64})/g), (match) =>
    match[1].replace(/[._-]+$/g, "").toLowerCase()
  ).filter(Boolean);
}

export async function resolveMcpMentionTargets(db: D1Database, prefixes: string[]) {
  const mentions: McpMentionTarget[] = [];
  for (const prefix of Array.from(new Set(prefixes))) {
    const matches = await db
      .prepare(
        `
        SELECT id
        FROM users
        WHERE status = 'active'
          AND lower(substr(email, 1, instr(email, '@') - 1)) = ?
        ORDER BY email
        LIMIT 2
        `
      )
      .bind(prefix)
      .all<{ id: string }>();
    if ((matches.results ?? []).length === 1) {
      mentions.push({ text: `@${prefix}`, userId: matches.results[0].id });
    }
  }
  return mentions;
}

export function appendMcpMentionStatements(
  statements: D1PreparedStatement[],
  db: D1Database,
  options: { actorName: string; actorUserId: string; mentions: McpMentionTarget[]; postId: string; topicId: string; topicTitle: string }
) {
  const notificationIds: string[] = [];
  options.mentions.forEach((mention) => {
    statements.push(db.prepare(
      `
      INSERT INTO forum_mentions (id, topic_id, post_id, mentioned_user_id, mention_text, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?)
      `
    ).bind(crypto.randomUUID(), options.topicId, options.postId, mention.userId, mention.text, options.actorUserId));
    if (mention.userId === options.actorUserId) {
      return;
    }
    const notificationId = crypto.randomUUID();
    notificationIds.push(notificationId);
    statements.push(db.prepare(
      `
      INSERT OR IGNORE INTO notifications (
        id, recipient_user_id, actor_user_id, notification_type,
        entity_type, entity_id, parent_type, parent_id, summary, href,
        metadata_json, dedupe_key
      ) VALUES (?, ?, ?, 'forum.mention', 'forum_post', ?, 'forum_topic', ?, ?, ?, ?, ?)
      `
    ).bind(
      notificationId,
      mention.userId,
      options.actorUserId,
      options.postId,
      options.topicId,
      `${options.actorName} 提到了你：《${options.topicTitle}》`,
      `#/posts/${encodeURIComponent(options.topicId)}`,
      JSON.stringify({ mentionText: mention.text, postId: options.postId, topicId: options.topicId, topicTitle: options.topicTitle }),
      `forum.mention:${options.postId}:${mention.userId}`
    ));
  });
  return notificationIds;
}
