/** Pre-migration shared JSON storage fixture; never imported by a production entrypoint. */
import PostalMime from "postal-mime";
import type { MailboxIdentity } from "./mailboxIdentity.ts";
import { RuntimeHttpError, type RuntimeEnv } from "./types.ts";

export const MAX_MAIL_BYTES = 5_000_000;
type MailRow = {
  id: string; envelope_from: string; envelope_to: string; subject: string; received_at: string;
  object_key: string; attachment_count: number; is_read: number; archived: number; labels_json: string; version: number;
};
type StoredMail = {
  text: string; html: string; rawBase64: string; messageId: string;
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number; contentBase64: string }>;
};

/** Write the complete object before publishing its D1 index. Retries never replay tasks. */
export async function storeIncomingMail(env: RuntimeEnv, mailbox: MailboxIdentity, from: string, raw: ArrayBuffer) {
  if (raw.byteLength > MAX_MAIL_BYTES) throw new RuntimeHttpError(413, "mail_too_large");
  const bucket = requireBucket(env);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)), b => b.toString(16).padStart(2, "0")).join("");
  const prior = await env.RUNTIME_DB.prepare("SELECT id FROM mate_mail_messages WHERE org_id=? AND user_id=? AND digest=?")
    .bind(mailbox.orgId, mailbox.userId, digest).first<{ id: string }>();
  if (prior) return { id: prior.id, duplicate: true };
  const parsed = await PostalMime.parse(raw);
  const id = `mail_${crypto.randomUUID()}`;
  const objectKey = `mate-mail/${id}.json`;
  const stored: StoredMail = {
    text: parsed.text || "", html: parsed.html || "", rawBase64: base64(new Uint8Array(raw)), messageId: parsed.messageId || "",
    attachments: parsed.attachments.map((attachment, index) => {
      const bytes = typeof attachment.content === "string" ? new TextEncoder().encode(attachment.content) : new Uint8Array(attachment.content);
      return { id: `attachment_${index + 1}`, filename: (attachment.filename || `attachment-${index + 1}`).replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 240),
        mimeType: attachment.mimeType || "application/octet-stream", size: bytes.byteLength, contentBase64: base64(bytes) };
    })
  };
  await bucket.put(objectKey, JSON.stringify(stored), { httpMetadata: { contentType: "application/json" } });
  // On an uncertain D1 failure retain the object: D1 may already reference it.
  const inserted = await env.RUNTIME_DB.prepare(`INSERT INTO mate_mail_messages
    (id,org_id,user_id,mate_id,digest,envelope_from,envelope_to,subject,received_at,object_key,attachment_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,user_id,digest) DO NOTHING`).bind(id, mailbox.orgId, mailbox.userId, mailbox.mateId, digest,
      from, mailbox.address, (parsed.subject || "").replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 1000),
      new Date().toISOString(), objectKey, stored.attachments.length).run();
  if (!inserted.meta.changes) {
    await bucket.delete(objectKey);
    const winner = await env.RUNTIME_DB.prepare("SELECT id FROM mate_mail_messages WHERE org_id=? AND user_id=? AND digest=?")
      .bind(mailbox.orgId, mailbox.userId, digest).first<{ id: string }>();
    if (!winner) throw new RuntimeHttpError(503, "mail_storage_unavailable");
    return { id: winner.id, duplicate: true };
  }
  return { id, duplicate: false };
}

export async function executeMailboxTool(env: RuntimeEnv, mailbox: MailboxIdentity, tool: string, args: Record<string, unknown>) {
  if (tool === "mail_list") {
    const conditions = ["org_id=?", "user_id=?"];
    const values: (string | number)[] = [mailbox.orgId, mailbox.userId];
    for (const [key, column] of [["from", "envelope_from"], ["after", "received_at"], ["before", "received_at"]]) {
      if (typeof args[key] === "string") { conditions.push(`${column} ${key === "after" ? ">=" : key === "before" ? "<" : "="} ?`); values.push(args[key] as string); }
    }
    if (typeof args.unread === "boolean") { conditions.push("is_read=?"); values.push(args.unread ? 0 : 1); }
    if (typeof args.archived === "boolean") { conditions.push("archived=?"); values.push(args.archived ? 1 : 0); }
    if (typeof args.label === "string") { conditions.push("EXISTS (SELECT 1 FROM json_each(labels_json) WHERE value=?)"); values.push(args.label); }
    if (typeof args.query === "string") { conditions.push("instr(lower(subject), lower(?)) > 0"); values.push(args.query); }
    if (args.cursor) {
      let cursor: unknown;
      try { cursor = JSON.parse(atob(String(args.cursor))); } catch { throw new RuntimeHttpError(400, "mail_cursor_invalid"); }
      if (!Array.isArray(cursor) || cursor.length !== 2 || cursor.some(v => typeof v !== "string") || cursor[0].length > 40 || cursor[1].length > 100) throw new RuntimeHttpError(400, "mail_cursor_invalid");
      conditions.push("(received_at < ? OR (received_at = ? AND id < ?))"); values.push(cursor[0], cursor[0], cursor[1]);
    }
    const limit = Number(args.limit || 25);
    const rows = (await env.RUNTIME_DB.prepare(`SELECT * FROM mate_mail_messages WHERE ${conditions.join(" AND ")} ORDER BY received_at DESC,id DESC LIMIT ?`)
      .bind(...values, limit + 1).all<MailRow>()).results;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { status: "ready", messages: items.map(summary), nextCursor: rows.length > limit && last ? btoa(JSON.stringify([last.received_at, last.id])) : null };
  }
  const row = await env.RUNTIME_DB.prepare("SELECT * FROM mate_mail_messages WHERE id=? AND org_id=? AND user_id=?")
    .bind(args.messageId, mailbox.orgId, mailbox.userId).first<MailRow>();
  if (!row) throw new RuntimeHttpError(404, "mail_not_found");
  if (tool === "mail_update") {
    const result = await env.RUNTIME_DB.prepare(`UPDATE mate_mail_messages SET is_read=?,archived=?,labels_json=?,version=version+1
      WHERE id=? AND org_id=? AND user_id=? AND version=?`).bind(
      args.read === undefined ? row.is_read : Number(args.read), args.archived === undefined ? row.archived : Number(args.archived),
      args.labels === undefined ? row.labels_json : JSON.stringify(args.labels), row.id, mailbox.orgId, mailbox.userId, args.expectedVersion).run();
    if (!result.meta.changes) throw new RuntimeHttpError(409, "mail_version_conflict");
    const updated = await env.RUNTIME_DB.prepare("SELECT * FROM mate_mail_messages WHERE id=? AND org_id=? AND user_id=?").bind(row.id, mailbox.orgId, mailbox.userId).first<MailRow>();
    return { message: summary(updated!) };
  }
  const object = await requireBucket(env).get(row.object_key);
  if (!object) throw new RuntimeHttpError(503, "mail_content_unavailable");
  const stored = await object.json<StoredMail>();
  if (tool === "mail_get") {
    const body = stored.text || stored.html;
    const offset = Number(args.bodyOffset || 0);
    const end = Math.min(offset + 64_000, body.length);
    return { message: summary(row), messageIdHeader: stored.messageId, contentTrust: "untrusted_email",
      body: body.slice(offset, end), bodyFormat: stored.text ? "text" : "html", bodyOffset: offset,
      bodyLength: body.length, nextBodyOffset: end < body.length ? end : null,
      attachments: stored.attachments.map(({ contentBase64: _, ...metadata }) => metadata) };
  }
  const attachment = stored.attachments.find(item => item.id === args.attachmentId);
  if (!attachment) throw new RuntimeHttpError(404, "mail_attachment_not_found");
  const bytes = Uint8Array.from(atob(attachment.contentBase64), char => char.charCodeAt(0));
  const offset = Number(args.offset || 0);
  if (offset > bytes.length) throw new RuntimeHttpError(400, "mail_attachment_offset_invalid");
  const end = Math.min(offset + Number(args.length || 262144), bytes.length);
  return { messageId: row.id, attachmentId: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType,
    encoding: "base64", data: base64(bytes.subarray(offset, end)), offset, totalBytes: bytes.length,
    nextOffset: end < bytes.length ? end : null };
}

function summary(row: MailRow) {
  return { id: row.id, from: row.envelope_from, to: row.envelope_to, subject: row.subject, receivedAt: row.received_at,
    attachmentCount: row.attachment_count, read: Boolean(row.is_read), archived: Boolean(row.archived), labels: JSON.parse(row.labels_json), version: row.version };
}
function requireBucket(env: RuntimeEnv) {
  if (!env.MATE_ARTIFACTS) throw new RuntimeHttpError(503, "mail_storage_not_configured");
  return env.MATE_ARTIFACTS;
}
function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
