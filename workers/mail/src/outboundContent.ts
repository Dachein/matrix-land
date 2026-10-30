import { createMimeMessage } from "mimetext/browser";
import { MailError, type MailEnv, type MailboxIdentity } from "./types.ts";

export type OutboundAttachment = {
  filename: string;
  mimeType: string;
  contentBase64: string;
};
export function outboundAttachments(
  value: unknown,
): Array<OutboundAttachment & { bytes: Uint8Array }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10)
    throw new MailError(400, "mail_attachment_arguments_invalid");
  let size = 0;
  return value.map((a) => {
    if (
      !a ||
      typeof a.filename !== "string" ||
      !a.filename ||
      a.filename.length > 240 ||
      /[\\/\r\n\x00-\x1f]/.test(a.filename) ||
      typeof a.mimeType !== "string" ||
      !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(a.mimeType) ||
      typeof a.contentBase64 !== "string" ||
      a.contentBase64.length > 6700000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        a.contentBase64,
      )
    )
      throw new MailError(400, "mail_attachment_arguments_invalid");
    const bytes = Uint8Array.from(atob(a.contentBase64), (c) =>
      c.charCodeAt(0),
    );
    size += bytes.length;
    if (size > 5000000) throw new MailError(413, "mail_attachments_too_large");
    return {
      filename: a.filename,
      mimeType: a.mimeType,
      contentBase64: a.contentBase64,
      bytes,
    };
  });
}
export function replyHeaders(input: {
  inReplyTo?: string;
  references?: string;
}): Record<string, string> {
  const original = String(input.inReplyTo || "").match(/<[^<>\s]{1,500}>/)?.[0];
  if (!original) return {};
  const ids=[...new Set(`${input.references||''} ${original}`.match(/<[^<>\s]{1,500}>/g)||[])];
  let references='';
  for(const id of ids.reverse()){const next=`${id} ${references}`.trim();if(new TextEncoder().encode(next).length>1800)break;references=next;}

  return { "In-Reply-To": original, References: references };
}
function encodedWords(mime: ReturnType<typeof createMimeMessage>, value: string) {
  const words: string[] = [], encoder = new TextEncoder();
  let chunk = "", size = 0;
  for (const char of value) {
    const length = encoder.encode(char).length;
    if (size + length > 42) {
      words.push(`=?utf-8?B?${mime.toBase64(chunk)}?=`);
      chunk = ""; size = 0;
    }
    chunk += char; size += length;
  }
  if (chunk) words.push(`=?utf-8?B?${mime.toBase64(chunk)}?=`);
  return words.join("\r\n ");
}
export async function saveOutbound(
  env: MailEnv,
  mailbox: MailboxIdentity,
  id: string,
  messageId: string,
  input: any,
  attachments: ReturnType<typeof outboundAttachments>,
) {
  const prefix = `${mailbox.orgId}/${mailbox.mateId}/${id}`;
  const stored = {
    textKey: `${prefix}/body.txt`,
    htmlKey: `${prefix}/body.html`,
    rawKey: `${prefix}/raw.eml`,
    messageId,
    references: replyHeaders(input).References || "",
    inReplyTo: replyHeaders(input)["In-Reply-To"] || "",
    autoSubmitted: "auto-generated",
    text: "",
    html: "",
    attachments: [] as Array<{
      id: string;
      filename: string;
      mimeType: string;
      size: number;
      key: string;
      sha256: string;
    }>,
  };
  const mime = createMimeMessage();
  mime.setSender({
    addr: mailbox.address,
    name: mailbox.name || mailbox.mateId,
  });
  mime.setRecipient(input.to);
  mime.setSubject(input.subject);
  mime.setHeader("Message-ID", messageId);
  mime.setHeader("X-Workspace-Mail-ID", id);
  mime.setHeader("Auto-Submitted", "auto-generated");
  for (const [header, value] of Object.entries(replyHeaders(input)))
    mime.setHeader(header, value);
  mime.addMessage({
    contentType: "text/plain", encoding: "base64",
    data: mime.toBase64(input.body).match(/.{1,76}/g)?.join("\r\n") || "",
  });
  for (const [index, a] of attachments.entries()) {
    const key = `${prefix}/attachments/${index + 1}`;
    await env.MAIL_OBJECTS.put(key, a.bytes, {
      httpMetadata: { contentType: a.mimeType },
    });
    const sha256 = [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new Uint8Array(a.bytes)),
      ),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    stored.attachments.push({
      id: `attachment_${index + 1}`,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.bytes.length,
      key,
      sha256,
    });
    mime.addAttachment({
      filename: a.filename,
      contentType: a.mimeType,
      data: a.contentBase64.match(/.{1,76}/g)?.join("\r\n") || "",
    });
  }
  const raw = mime.asRaw()
    .replace(/^Subject:[^\r\n]*/im, () => `Subject: ${encodedWords(mime,input.subject)}`)
    .replace(/^From:[^\r\n]*/im, () => `From: ${encodedWords(mime,mailbox.name || mailbox.mateId)} <${mailbox.address}>`)
    .replace(/^References: ([^\r\n]*)/im, (_,value: string) => `References: ${value.split(/ +/).join("\r\n ")}`);
  await env.MAIL_OBJECTS.put(stored.rawKey, raw, {
    httpMetadata: { contentType: "message/rfc822" },
  });
  await env.MAIL_OBJECTS.put(stored.textKey, input.body, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  await env.MAIL_OBJECTS.put(stored.htmlKey, "", {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  const key = `${prefix}/manifest.json`;
  await env.MAIL_OBJECTS.put(key, JSON.stringify(stored), {
    httpMetadata: { contentType: "application/json" },
  });
  return { key, raw };
}

export async function finalizeOutbound(env:MailEnv,key:string,messageId:string) {
 const object=await env.MAIL_OBJECTS.get(key);if(!object)throw new MailError(503,'mail_content_unavailable');
 const manifest=await object.json<any>();manifest.messageId=messageId;
 const raw=await env.MAIL_OBJECTS.get(manifest.rawKey);if(!raw)throw new MailError(503,'mail_content_unavailable');
 const content=(await raw.text()).replace(/^Message-ID:[^\r\n]*/im,`Message-ID: ${messageId}`);
 await env.MAIL_OBJECTS.put(manifest.rawKey,content,{httpMetadata:{contentType:'message/rfc822'}});
 await env.MAIL_OBJECTS.put(key,JSON.stringify(manifest),{httpMetadata:{contentType:'application/json'}});
}
export async function repairOutboundMetadata(env:MailEnv) {
 const rows=(await env.RUNTIME_DB.prepare("SELECT id,object_key,message_id FROM workspace_mail_outbound WHERE status='sent' AND error='provider_metadata_refresh_failed' LIMIT 10").all<{id:string;object_key:string;message_id:string}>()).results;
 for(const row of rows){await finalizeOutbound(env,row.object_key,row.message_id);await env.RUNTIME_DB.prepare('UPDATE workspace_mail_outbound SET error=NULL WHERE id=?').bind(row.id).run();}
}
