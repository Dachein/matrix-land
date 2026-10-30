import PostalMime from "postal-mime";
import type { MailboxIdentity, MailEnv as RuntimeEnv } from "./types.ts";
import { MailError as RuntimeHttpError } from "./types.ts";

export const MAX_MAIL_BYTES = 5_000_000;
type MailRow = {
  id: string;
  envelope_from: string;
  envelope_to: string;
  subject: string;
  received_at: string;
  delivery_status?: string;
  delivery_message_id?:string;
  direction?: "outbound";
  object_key: string;
  attachment_count: number;
  is_read: number;
  archived: number;
  labels_json: string;
  version: number;
};
export type StoredMail = {
  text: string;
  html: string;
  messageId: string;
  references: string;
  inReplyTo: string;
  autoSubmitted: string;
  rawKey: string;
  textKey: string;
  htmlKey: string;
  attachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    key: string;
    sha256: string;
  }>;
};

/** Write the complete object before publishing its D1 index. Retries never replay tasks. */
export async function storeIncomingMail(
  env: RuntimeEnv,
  mailbox: MailboxIdentity,
  from: string,
  raw: ArrayBuffer,
) {
  if (raw.byteLength > MAX_MAIL_BYTES)
    throw new RuntimeHttpError(413, "mail_too_large");
  const bucket = requireBucket(env);
  const rawDigest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", raw)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  // Namespace new digests by mailbox, while recognizing raw digests written by the previous Runtime.
  const digest = await sha256(
    new TextEncoder().encode(`${mailbox.mateId}\0${rawDigest}`),
  );
  const prior = await env.RUNTIME_DB.prepare(
    "SELECT id FROM mate_mail_messages WHERE org_id=? AND user_id=? AND mate_id=? AND (digest=? OR digest=?)",
  )
    .bind(mailbox.orgId, mailbox.userId, mailbox.mateId, digest, rawDigest)
    .first<{ id: string }>();
  if (prior) return { id: prior.id, duplicate: true };
  const parsed = await PostalMime.parse(raw);
  const id = `mail_${crypto.randomUUID()}`;
  const prefix = `${mailbox.orgId}/${mailbox.mateId}/${id}`;
  const objectKey = `${prefix}/manifest.json`;
  const stored: StoredMail = {
    text: "",
    html: "",
    messageId: parsed.messageId || "",
    references: parsed.references || "",
    inReplyTo: parsed.inReplyTo || "",
    autoSubmitted:
      parsed.headers.find((h) => h.key === "auto-submitted")?.value || "",
    rawKey: `${prefix}/raw.eml`,
    textKey: `${prefix}/body.txt`,
    htmlKey: `${prefix}/body.html`,
    attachments: parsed.attachments.map((attachment, index) => {
      const bytes =
        typeof attachment.content === "string"
          ? new TextEncoder().encode(attachment.content)
          : new Uint8Array(attachment.content);
      return {
        id: `attachment_${index + 1}`,
        filename: (attachment.filename || `attachment-${index + 1}`)
          .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
          .slice(0, 240),
        mimeType: attachment.mimeType || "application/octet-stream",
        size: bytes.byteLength,
        key: `${prefix}/attachments/${index + 1}`,
        sha256: "",
      };
    }),
  };
  await bucket.put(stored.rawKey, raw, {
    httpMetadata: { contentType: "message/rfc822" },
  });
  await bucket.put(stored.textKey, parsed.text || "", {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  await bucket.put(stored.htmlKey, parsed.html || "", {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  for (const [index, attachment] of parsed.attachments.entries()) {
    const bytes =
      typeof attachment.content === "string"
        ? new TextEncoder().encode(attachment.content)
        : new Uint8Array(attachment.content);
    stored.attachments[index].sha256 = await sha256(bytes);
    await bucket.put(stored.attachments[index].key, bytes, {
      httpMetadata: { contentType: stored.attachments[index].mimeType },
    });
  }
  await bucket.put(objectKey, JSON.stringify(stored), {
    httpMetadata: { contentType: "application/json" },
  });
  // On an uncertain D1 failure retain the object: D1 may already reference it.
  const inserted = await env.RUNTIME_DB.prepare(
    `INSERT INTO mate_mail_messages
    (id,org_id,user_id,mate_id,digest,envelope_from,envelope_to,subject,received_at,object_key,attachment_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,user_id,digest) DO NOTHING`,
  )
    .bind(
      id,
      mailbox.orgId,
      mailbox.userId,
      mailbox.mateId,
      digest,
      from,
      mailbox.address,
      (parsed.subject || "")
        .replace(/[\r\n\u0000-\u001f]/g, " ")
        .slice(0, 1000),
      new Date().toISOString(),
      objectKey,
      stored.attachments.length,
    )
    .run();
  if (!inserted.meta.changes) {
    await bucket.delete([
      objectKey,
      stored.rawKey,
      stored.textKey,
      stored.htmlKey,
      ...stored.attachments.map((a) => a.key),
    ]);
    const winner = await env.RUNTIME_DB.prepare(
      "SELECT id FROM mate_mail_messages WHERE org_id=? AND user_id=? AND mate_id=? AND (digest=? OR digest=?)",
    )
      .bind(mailbox.orgId, mailbox.userId, mailbox.mateId, digest, rawDigest)
      .first<{ id: string }>();
    if (!winner) throw new RuntimeHttpError(503, "mail_storage_unavailable");
    return { id: winner.id, duplicate: true };
  }
  await env.RUNTIME_DB.prepare(
    `INSERT OR IGNORE INTO workspace_mail_events (message_id,org_id,user_id,mate_id) VALUES (?,?,?,?)`,
  )
    .bind(id, mailbox.orgId, mailbox.userId, mailbox.mateId)
    .run();
  return { id, duplicate: false };
}

export async function executeMailboxTool(
  env: RuntimeEnv,
  mailbox: MailboxIdentity,
  tool: string,
  args: Record<string, unknown>,
) {
  if (tool === "mail_list" && args.folder === "sent")
    return listSent(env, mailbox, args);
  if (tool === "mail_list") {
    const conditions = ["org_id=?", "user_id=?", "mate_id=?"];
    const values: (string | number)[] = [
      mailbox.orgId,
      mailbox.userId,
      mailbox.mateId,
    ];
    for (const [key, column] of [
      ["from", "envelope_from"],
      ["after", "received_at"],
      ["before", "received_at"],
    ]) {
      if (typeof args[key] === "string") {
        conditions.push(
          `${column} ${key === "after" ? ">=" : key === "before" ? "<" : "="} ?`,
        );
        values.push(args[key] as string);
      }
    }
    if (typeof args.unread === "boolean") {
      conditions.push("is_read=?");
      values.push(args.unread ? 0 : 1);
    }
    if (typeof args.archived === "boolean") {
      conditions.push("archived=?");
      values.push(args.archived ? 1 : 0);
    }
    if (typeof args.label === "string") {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(labels_json) WHERE value=?)",
      );
      values.push(args.label);
    }
    if (typeof args.query === "string") {
      conditions.push("instr(lower(subject), lower(?)) > 0");
      values.push(args.query);
    }
    if (args.cursor) {
      let cursor: unknown;
      try {
        cursor = JSON.parse(atob(String(args.cursor)));
      } catch {
        throw new RuntimeHttpError(400, "mail_cursor_invalid");
      }
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 2 ||
        cursor.some((v) => typeof v !== "string") ||
        cursor[0].length > 40 ||
        cursor[1].length > 100
      )
        throw new RuntimeHttpError(400, "mail_cursor_invalid");
      conditions.push("(received_at < ? OR (received_at = ? AND id < ?))");
      values.push(cursor[0], cursor[0], cursor[1]);
    }
    const limit = Number(args.limit || 25);
    const rows = (
      await env.RUNTIME_DB.prepare(
        `SELECT * FROM mate_mail_messages WHERE ${conditions.join(" AND ")} ORDER BY received_at DESC,id DESC LIMIT ?`,
      )
        .bind(...values, limit + 1)
        .all<MailRow>()
    ).results;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      status: "ready",
      messages: items.map(summary),
      nextCursor:
        rows.length > limit && last
          ? btoa(JSON.stringify([last.received_at, last.id]))
          : null,
    };
  }
  const row = String(args.messageId || "").startsWith("out_")
    ? await readSent(env, mailbox, String(args.messageId))
    : await env.RUNTIME_DB.prepare(
        "SELECT * FROM mate_mail_messages WHERE id=? AND org_id=? AND user_id=? AND mate_id=?",
      )
        .bind(args.messageId, mailbox.orgId, mailbox.userId, mailbox.mateId)
        .first<MailRow>();
  if (!row) throw new RuntimeHttpError(404, "mail_not_found");
  if (tool === "mail_update") {
    if (row.direction === "outbound")
      throw new RuntimeHttpError(400, "mail_outbound_metadata_unsupported");
    const result = await env.RUNTIME_DB.prepare(
      `UPDATE mate_mail_messages SET is_read=?,archived=?,labels_json=?,version=version+1
      WHERE id=? AND org_id=? AND user_id=? AND version=?`,
    )
      .bind(
        args.read === undefined ? row.is_read : Number(args.read),
        args.archived === undefined ? row.archived : Number(args.archived),
        args.labels === undefined
          ? row.labels_json
          : JSON.stringify(args.labels),
        row.id,
        mailbox.orgId,
        mailbox.userId,
        args.expectedVersion,
      )
      .run();
    if (!result.meta.changes)
      throw new RuntimeHttpError(409, "mail_version_conflict");
    const updated = await env.RUNTIME_DB.prepare(
      "SELECT * FROM mate_mail_messages WHERE id=? AND org_id=? AND user_id=?",
    )
      .bind(row.id, mailbox.orgId, mailbox.userId)
      .first<MailRow>();
    return { message: summary(updated!) };
  }
  if (row.object_key.startsWith("mate-mail/"))
    await migrateLegacyMessage(env, mailbox, row);
  const object = await requireBucket(env).get(row.object_key);
  if (!object) throw new RuntimeHttpError(503, "mail_content_unavailable");
  const stored = await object.json<StoredMail>();
  const textObject = await requireBucket(env).get(stored.textKey),
    htmlObject = await requireBucket(env).get(stored.htmlKey);
  if (!textObject || !htmlObject)
    throw new RuntimeHttpError(503, "mail_content_unavailable");
  stored.text = await textObject.text();
  stored.html = await htmlObject.text();
  if (tool === "mail_get") {
    const body = stored.text || stored.html;
    const offset = Number(args.bodyOffset || 0);
    const end = Math.min(offset + 64_000, body.length);
    const processing = await env.RUNTIME_DB.prepare(
      "SELECT status,task_id AS taskId,release_id AS releaseId,error,attempts FROM workspace_mail_inbox_runs WHERE message_id=? AND mate_id=? AND user_id=? AND org_id=?",
    )
      .bind(row.id, mailbox.mateId, mailbox.userId, mailbox.orgId)
      .first();
    return {
      processing:
        row.direction === "outbound"
          ? { status: row.delivery_status }
          : processing || {
              status:
                mailbox.ownerKind === "app" ? "stored" : "awaiting_trigger",
            },
      message: summary(row),
      messageIdHeader: row.delivery_message_id||stored.messageId,
      references: stored.references,
      inReplyTo: stored.inReplyTo,
      autoSubmitted: stored.autoSubmitted,
      contentTrust: "untrusted_email",
      body: body.slice(offset, end),
      bodyFormat: stored.text ? "text" : "html",
      bodyOffset: offset,
      bodyLength: body.length,
      nextBodyOffset: end < body.length ? end : null,
      attachments: stored.attachments.map(
        ({ key: _, ...metadata }) => metadata,
      ),
    };
  }
  const attachment = stored.attachments.find(
    (item) => item.id === args.attachmentId,
  );
  if (!attachment) throw new RuntimeHttpError(404, "mail_attachment_not_found");
  const attachmentObject = await requireBucket(env).get(attachment.key);
  if (!attachmentObject)
    throw new RuntimeHttpError(503, "mail_attachment_unavailable");
  const bytes = new Uint8Array(await attachmentObject.arrayBuffer());
  const offset = Number(args.offset || 0);
  if (offset > bytes.length)
    throw new RuntimeHttpError(400, "mail_attachment_offset_invalid");
  const end = Math.min(offset + Number(args.length || 262144), bytes.length);
  return {
    messageId: row.id,
    attachmentId: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    encoding: "base64",
    data: base64(bytes.subarray(offset, end)),
    offset,
    totalBytes: bytes.length,
    nextOffset: end < bytes.length ? end : null,
  };
}

function summary(row: MailRow) {
  return {
    id: row.id,
    from: row.envelope_from,
    to: row.envelope_to,
    subject: row.subject,
    receivedAt: row.received_at,
    ...(row.direction
      ? { direction: row.direction, deliveryStatus: row.delivery_status }
      : {}),
    attachmentCount: row.attachment_count,
    read: Boolean(row.is_read),
    archived: Boolean(row.archived),
    labels: JSON.parse(row.labels_json),
    version: row.version,
  };
}
function requireBucket(env: RuntimeEnv) {
  if (!env.MAIL_OBJECTS)
    throw new RuntimeHttpError(503, "mail_storage_not_configured");
  return env.MAIL_OBJECTS;
}
function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

async function sha256(bytes: Uint8Array) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export async function migrateLegacyMessage(
  env: RuntimeEnv,
  mailbox: MailboxIdentity,
  row: MailRow,
) {
  const oldKey = row.object_key;
  if (!/^mate-mail\/mail_[a-f0-9-]+\.json$/.test(oldKey))
    throw new RuntimeHttpError(503, "mail_legacy_key_invalid");
  const object = await env.LEGACY_MAIL_OBJECTS?.get(oldKey);
  if (!object) throw new RuntimeHttpError(503, "mail_content_unavailable");
  const old = await object.json<any>();
  const prefix = `${mailbox.orgId}/${mailbox.mateId}/${row.id}`;
  const raw = Uint8Array.from(atob(old.rawBase64), (c) => c.charCodeAt(0));
  const parsed = await PostalMime.parse(raw);
  const stored: StoredMail = {
    text: "",
    html: "",
    rawKey: `${prefix}/raw.eml`,
    textKey: `${prefix}/body.txt`,
    htmlKey: `${prefix}/body.html`,
    messageId: old.messageId || "",
    references: parsed.references || "",
    inReplyTo: parsed.inReplyTo || "",
    autoSubmitted:
      parsed.headers.find((h) => h.key === "auto-submitted")?.value || "",
    attachments: [],
  };
  await env.MAIL_OBJECTS.put(stored.rawKey, raw, {
    httpMetadata: { contentType: "message/rfc822" },
  });
  await env.MAIL_OBJECTS.put(stored.textKey, old.text || "");
  await env.MAIL_OBJECTS.put(stored.htmlKey, old.html || "");
  for (const a of old.attachments) {
    const bytes = Uint8Array.from(atob(a.contentBase64), (c) =>
      c.charCodeAt(0),
    );
    const key = `${prefix}/attachments/${a.id}`;
    await env.MAIL_OBJECTS.put(key, bytes);
    stored.attachments.push({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      size: bytes.length,
      key,
      sha256: await sha256(bytes),
    });
  }
  const newKey = `${prefix}/manifest.json`;
  await env.MAIL_OBJECTS.put(newKey, JSON.stringify(stored));
  // A migrated historical mail must never become a new Trigger event.
  await env.RUNTIME_DB.batch([
    env.RUNTIME_DB.prepare(
      "UPDATE mate_mail_messages SET object_key=? WHERE id=? AND object_key=? AND org_id=? AND user_id=?",
    ).bind(newKey, row.id, oldKey, mailbox.orgId, mailbox.userId),
    env.RUNTIME_DB.prepare(
      "INSERT OR IGNORE INTO workspace_mail_events(message_id,org_id,user_id,mate_id,delivered_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)",
    ).bind(row.id, mailbox.orgId, mailbox.userId, mailbox.mateId),
    env.RUNTIME_DB.prepare("INSERT OR IGNORE INTO workspace_mail_legacy_cleanup(object_key) VALUES(?)").bind(oldKey),
  ]);
  row.object_key = newKey;
  // Cleanup is retried separately; a failed delete must never invalidate the new private copy.
}
export async function migrateLegacyMail(env: RuntimeEnv) {
  const rows = (
    await env.RUNTIME_DB.prepare(
      "SELECT * FROM mate_mail_messages WHERE object_key LIKE 'mate-mail/%' LIMIT 10",
    ).all<MailRow & { org_id: string; user_id: string; mate_id: string }>()
  ).results;
  for (const row of rows)
    await migrateLegacyMessage(
      env,
      {
        orgId: row.org_id,
        userId: row.user_id,
        mateId: row.mate_id,
        address: row.envelope_to,
      },
      row,
    );
}

async function readSent(
  env: RuntimeEnv,
  mailbox: MailboxIdentity,
  id: string,
): Promise<MailRow | null> {
  const row = await env.RUNTIME_DB.prepare(
    "SELECT * FROM workspace_mail_outbound WHERE id=? AND org_id=? AND user_id=? AND mate_id=?",
  )
    .bind(id, mailbox.orgId, mailbox.userId, mailbox.mateId)
    .first<any>();
  if (!row) return null;
  if (!row.object_key)
    throw new RuntimeHttpError(503, "mail_content_unavailable");
  const manifest = await env.MAIL_OBJECTS.get(row.object_key);
  if (!manifest) throw new RuntimeHttpError(503, "mail_content_unavailable");
  const stored = await manifest.json<StoredMail>();
  return {
    id: row.id,
    envelope_from: mailbox.address,
    envelope_to: row.recipient,
    subject: row.subject,
    received_at: row.created_at,
    object_key: row.object_key,
    attachment_count: stored.attachments.length,
    is_read: 1,
    archived: 0,
    labels_json: "[]",
    version: 1,
    direction: "outbound",
    delivery_status: row.status,delivery_message_id:row.message_id,
  };
}
async function listSent(
  env: RuntimeEnv,
  mailbox: MailboxIdentity,
  args: Record<string, unknown>,
) {
  const where = ["org_id=?", "user_id=?", "mate_id=?"];
  const values: any[] = [mailbox.orgId, mailbox.userId, mailbox.mateId];
  if (args.cursor) {
    let cursor;
    try {
      cursor = JSON.parse(atob(String(args.cursor)));
    } catch {
      throw new RuntimeHttpError(400, "mail_cursor_invalid");
    }
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 2 ||
      cursor.some((v) => typeof v !== "string" || v.length > 100)
    )
      throw new RuntimeHttpError(400, "mail_cursor_invalid");
    where.push("(created_at<? OR (created_at=? AND id<?))");
    values.push(cursor[0], cursor[0], cursor[1]);
  }
  if (args.query) {
    where.push("instr(lower(subject),lower(?))>0");
    values.push(args.query);
  }
  if (args.after) {
    where.push("datetime(created_at)>=datetime(?)");
    values.push(args.after);
  }
  if (args.before) {
    where.push("datetime(created_at)<datetime(?)");
    values.push(args.before);
  }
  if (
    args.unread === true ||
    args.archived === true ||
    args.label ||
    (args.from && args.from !== mailbox.address)
  )
    return { status: "ready", messages: [], nextCursor: null };
  const limit = Number(args.limit || 25);
  const rows = (
    await env.RUNTIME_DB.prepare(
      `SELECT * FROM workspace_mail_outbound WHERE ${where.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ?`,
    )
      .bind(...values, limit + 1)
      .all<any>()
  ).results;
  const last = rows.slice(0, limit).at(-1);
  return {
    status: "ready",
    messages: rows.slice(0, limit).map((row) => ({
      id: row.id,
      from: mailbox.address,
      to: row.recipient,
      subject: row.subject,
      receivedAt: row.created_at,
      direction: "outbound",
      deliveryStatus: row.status,
      read: true,
      archived: false,
      labels: [],
      version: 1,
    })),
    nextCursor:
      rows.length > limit && last
        ? btoa(JSON.stringify([last.created_at, last.id]))
        : null,
  };
}

export async function cleanLegacyMail(env: RuntimeEnv) {
  if (!env.LEGACY_MAIL_OBJECTS) return;
  const rows = (
    await env.RUNTIME_DB.prepare(
      "SELECT object_key FROM workspace_mail_legacy_cleanup LIMIT 10",
    ).all<{ object_key: string }>()
  ).results;
  for (const row of rows) {
    if (!/^mate-mail\/mail_[a-f0-9-]+\.json$/.test(row.object_key)) continue;
    const referenced = await env.RUNTIME_DB.prepare(
      "SELECT id FROM mate_mail_messages WHERE object_key=?",
    )
      .bind(row.object_key)
      .first();
    if (referenced) continue;
    await env.LEGACY_MAIL_OBJECTS.delete(row.object_key);
    await env.RUNTIME_DB.prepare(
      "DELETE FROM workspace_mail_legacy_cleanup WHERE object_key=?",
    )
      .bind(row.object_key)
      .run();
  }
}
