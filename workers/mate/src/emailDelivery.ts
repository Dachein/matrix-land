import { workspaceMailRequest } from "../../../src/shared/workspaceMailClient.ts";
import { createMimeMessage } from "mimetext/browser";
import {
  recordOutboundEmail,
  subjectWithThreadCode
} from "./inboxStorage.ts";
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimePrincipal } from "./types.ts";

export async function sendMateProactiveEmail(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  input: { body: string; subject: string; taskId?: string; threadCode: string; to: string }
) {

  const from = definition.mate.workEmail?.trim() || "";
  const to = normalizeEmail(input.to);
  if (!normalizeEmail(from) || !to) throw new RuntimeHttpError(503, "mate_email_address_not_configured");
  const subject = subjectWithThreadCode(input.subject, input.threadCode, definition.mate.id);
  const messageDigest = await sha256Hex(`${definition.mate.id}\n${principal.userId}\n${input.taskId || ""}\n${subject}\n${input.body}`);
  const sent=await env.RUNTIME_DB.prepare(`SELECT status FROM mate_email_messages WHERE mate_id=? AND user_id=? AND message_digest=?`).bind(definition.mate.id,principal.userId,messageDigest).first<{status:string}>();
  if(sent?.status==="sent") return {messageDigest,subject,status:"sent" as const};
  const previous=await env.RUNTIME_DB.prepare(`SELECT external_message_id AS messageId FROM mate_email_messages WHERE mate_id=? AND user_id=? AND thread_code=? AND external_message_id IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1`).bind(definition.mate.id,principal.userId,input.threadCode).first<{messageId:string}>();
  const replyTo=normalizeMessageId(previous?.messageId);
  const messageId=`<${crypto.randomUUID()}@${from.split("@")[1]}>`;
  const metadata={envelopeFrom:from,envelopeTo:to,messageDigest,subject,taskId:input.taskId,mateId:definition.mate.id,threadCode:input.threadCode,userId:principal.userId};
  try {
    const response=await workspaceMailRequest(env,{userId:definition.mate.ownerUserId,orgId:definition.mate.orgId,mateId:definition.mate.id,scopes:['mail:task-send']},'/internal/task/send',{to,subject,body:input.body.slice(0,80000),idempotencyKey:`proactive:${messageDigest}`,inReplyTo:replyTo,references:replyTo});
    const result=await response.json() as {status?:string;messageId?:string};
    if(!response.ok||result.status!=='sent')throw new RuntimeHttpError(502,'mate_email_send_failed');
    await recordOutboundEmail(env.RUNTIME_DB,{...metadata,externalMessageId:result.messageId || messageId,providerMessageId:text(result.messageId) || undefined});
  } catch(error) {
    await recordOutboundEmail(env.RUNTIME_DB,{...metadata,status:"failed"});
    return {messageDigest,subject,status:"failed" as const};
  }

  return { messageDigest, subject,status:"sent" as const };
}

export async function replyToMateEmail(
  message: ForwardableEmailMessage,
  definition: RuntimeDefinition,
  input: { body: string; originalMessageId?: string; references?: string; subject: string; threadCode: string }
) {
  const from = definition.mate.workEmail?.trim() || "";
  const to = normalizeEmail(message.from);
  if (!normalizeEmail(from) || !to) throw new RuntimeHttpError(503, "mate_email_address_not_configured");
  const {subject,messageId,raw} = buildThreadReply(definition,{...input,to});
  const { EmailMessage } = await import("cloudflare:email");
  await message.reply(new EmailMessage(from, to, raw));
  return { subject,messageId };
}

export function buildThreadReply(definition:RuntimeDefinition,input:{to:string;body:string;subject:string;threadCode:string;originalMessageId?:string;references?:string}) {
  const from=definition.mate.workEmail!;
  const subject = subjectWithThreadCode(input.subject, input.threadCode, definition.mate.id);
  const mime = createMimeMessage();
  mime.setSender({ addr: from, name: definition.mate.displayName });
  mime.setRecipient(input.to);
  mime.setSubject(subject);
  const original=normalizeMessageId(input.originalMessageId);
  if (original) mime.setHeader("In-Reply-To", original);
  const references = normalizedReferences(input.references, original);
  if (references) mime.setHeader("References", references);
  const messageId=`<${crypto.randomUUID()}@${from.split("@")[1]}>`;
  mime.setHeader("Message-ID",messageId);
  mime.addMessage({ contentType: "text/plain", data: input.body.slice(0, 80_000) });
  return {subject,messageId,raw:mime.asRaw()};
}
export function normalizeMessageId(value?:string) {
  const raw=value?.trim() || "";
  if (/^<[^<>\s]{1,500}>$/.test(raw)) return raw;
  if (/^[^<>\s]{1,500}@[^<>\s]{1,200}$/.test(raw)) return `<${raw}>`;
}

function normalizedReferences(value: string | undefined, messageId: string | undefined) {
  const references = [...new Set((`${value || ""} ${messageId || ""}`).match(/<[^<>\s]{1,500}>/g) || [])].slice(-100);
  return references.join(" ");
}

function normalizeEmail(value: unknown) {
  const email = text(value).toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
async function sha256Hex(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
