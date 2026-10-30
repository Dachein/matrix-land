/** Pre-migration baseline for compatibility tests; production intake belongs to workspace-mail-worker. */
import PostalMime from "postal-mime";
import { storeIncomingMail } from "./mailbox.fixture.ts";
import { resolveDefaultMailbox } from "./mailboxIdentity.ts";
import { loadRuntimeDefinitionByEmail } from "./controlPlane.ts";
import { normalizeMessageId, replyToMateEmail } from "./emailDelivery.ts";
import {
  attachEmailThreadTask,
  claimInboundEmail,
  completeInboundEmail,
  recordOutboundEmail,
  threadCodeFromSubject
} from "./inboxStorage.ts";
import { resolveUserRuntimePrincipal, resolveEmailRuntimePrincipal } from "./runtimeIdentity.ts";
import { ensureWorkThread, findThreadByEmailReferences } from "./workThreads.ts";
import { createTask, readTask } from "./storage.ts";
import { executeConfiguredTask } from "./taskExecutor.ts";
import { RuntimeHttpError, type RuntimeEnv } from "./types.ts";

const MAX_EMAIL_BYTES = 5_000_000;

export async function handleMateEmail(
  message: ForwardableEmailMessage,
  env: RuntimeEnv,
  _ctx: ExecutionContext,
  delivery: {reply:typeof replyToMateEmail} = {reply:replyToMateEmail}
) {
  if (message.rawSize > MAX_EMAIL_BYTES) {
    message.setReject("This Mate accepts email messages up to 5 MB.");
    return;
  }
  const envelopeFrom = normalizeEmail(message.from);
  const envelopeTo = normalizeEmail(message.to);
  if (!envelopeFrom || !envelopeTo) {
    message.setReject("Invalid email envelope.");
    return;
  }

  let taskId = "";
  let messageDigest = "";
  let mateId = "";
  try {
    const raw = await new Response(message.raw).arrayBuffer();
    if (raw.byteLength > MAX_EMAIL_BYTES) { message.setReject("This mailbox accepts email messages up to 5 MB."); return; }
    const mailbox = await resolveDefaultMailbox(env, { address: envelopeTo });
    if (mailbox) {
      const owner = await resolveUserRuntimePrincipal(env, mailbox.userId);
      if (owner.orgId !== mailbox.orgId) throw new RuntimeHttpError(403, "mailbox_access_denied");
      await storeIncomingMail(env, mailbox, envelopeFrom, raw);
      return;
    }
    const parsed = await PostalMime.parse(raw);
    const subject = cleanSubject(parsed.subject || message.headers.get("subject") || "Email Task");
    if (subject.length > 240) throw new RuntimeHttpError(422, "email_subject_too_long");
    const principal = await resolveEmailRuntimePrincipal(env, envelopeFrom, "email_binding");
    const definition = await loadRuntimeDefinitionByEmail(env, principal, envelopeTo);
    mateId = definition.mate.id;
    if (definition.release.manifest.channels.inbox?.email?.enabled !== true) {
      throw new RuntimeHttpError(403, "mate_email_channel_disabled");
    }
    const body = emailText(parsed.text, parsed.html);
    if (!body) throw new RuntimeHttpError(422, "email_task_body_required");
    const originalMessageId=normalizeMessageId(parsed.messageId || message.headers.get("message-id") || undefined);
    messageDigest = await sha256Hex(`${envelopeFrom}\n${envelopeTo}\n${originalMessageId || await sha256Bytes(raw)}`);
    const scope={mateId,userId:principal.userId,mode:"live" as const};
    const previousEmail=await env.RUNTIME_DB.prepare(`SELECT status,thread_code AS threadCode FROM mate_email_messages WHERE mate_id=? AND user_id=? AND message_digest=? AND direction='inbound'`).bind(mateId,principal.userId,messageDigest).first<{status:string;threadCode:string}>();
    if(previousEmail && previousEmail.status!=="failed") return;
    const references=parsed.references || message.headers.get("references") || "";
    const inReplyTo=normalizeMessageId(parsed.inReplyTo || message.headers.get("in-reply-to") || undefined);
    const referenceThread=await findThreadByEmailReferences(env.RUNTIME_DB,scope,`${references} ${inReplyTo || ""}`);
    const requestedCode=threadCodeFromSubject(subject,mateId);
    if(referenceThread && requestedCode && referenceThread.threadCode!==requestedCode) throw new RuntimeHttpError(409,"email_thread_reference_mismatch");
    const thread=previousEmail ? await ensureWorkThread(env.RUNTIME_DB,scope,{threadCode:previousEmail.threadCode,title:subject}) : referenceThread || await ensureWorkThread(env.RUNTIME_DB,scope,{threadCode:requestedCode || undefined,title:subject});
    const claimed = await claimInboundEmail(env.RUNTIME_DB, {
      envelopeFrom,
      envelopeTo,
      messageDigest,
      externalMessageId:originalMessageId,
      subject,
      mateId,
      threadCode: thread.threadCode,
      userId: principal.userId
    });
    if (!claimed) {
      await env.RUNTIME_DB.prepare(`DELETE FROM mate_work_threads WHERE id=? AND NOT EXISTS(SELECT 1 FROM mate_tasks WHERE thread_id=?) AND NOT EXISTS(SELECT 1 FROM mate_email_messages WHERE mate_id=? AND user_id=? AND thread_code=?)`).bind(thread.id,thread.id,mateId,principal.userId,thread.threadCode).run();
      return;
    }

    // A delivery retry reuses the recorded execution; it must never replay tools.
    const accepted=await env.RUNTIME_DB.prepare(`SELECT task_id AS taskId FROM mate_email_messages WHERE mate_id=? AND user_id=? AND message_digest=?`).bind(mateId,principal.userId,messageDigest).first<{taskId?:string}>();
    const existingTask=accepted?.taskId ? await readTask(env.RUNTIME_DB,mateId,principal,"live",accepted.taskId) : undefined;
    const createdTask=existingTask || await createTask(env.RUNTIME_DB, definition, principal, "live", {
      channel:"email",threadId:thread.id,title:thread.title,
      context:{messageIdDigest:messageDigest,subject:thread.title,threadCode:thread.threadCode,timezone:definition.release.manifest.taskPolicy.defaultTimezone || "UTC"},
      instruction:`邮件主题：${thread.title}\n\n邮件正文：\n${body}`
    });
    taskId=String(createdTask.id);
    await completeInboundEmail(env.RUNTIME_DB,mateId,messageDigest,taskId,"accepted");
    await attachEmailThreadTask(env.RUNTIME_DB,mateId,principal.userId,thread.threadCode,taskId);
    let result:Record<string,unknown>;
    if(createdTask.status==="queued") {
      try { result=await executeConfiguredTask(env,definition,principal,"live",taskId); }
      catch(error) {
        const failed=await readTask(env.RUNTIME_DB,mateId,principal,"live",taskId);
        if(failed.status!=="failed") throw error;
        result={task:failed};
      }
    } else if(["completed","failed","cancelled","waiting_for_approval"].includes(createdTask.status)) result={task:createdTask};
    else throw new RuntimeHttpError(409,"email_task_still_running");
    const resultRecord = record(result);
    const plan = record(resultRecord.plan);
    const todos = array(resultRecord.todos) as Array<{ dueAt?: string; title: string }>;
    const reminders = array(resultRecord.reminders) as Array<{ nextDueAt: string; title: string }>;
    const completedTask = record(resultRecord.task);
    const conclusion = record(completedTask.conclusion);
    const responseBody = emailReplyBody(text(plan.reply) || text(conclusion.summary) || "Task completed.", todos, reminders, thread.threadCode);
    const reply = await delivery.reply(message, definition, {
      body: responseBody,
      originalMessageId,
      references,
      subject:thread.title,
      threadCode: thread.threadCode
    });
    await completeInboundEmail(env.RUNTIME_DB, mateId, messageDigest, taskId, "replied");
    await recordOutboundEmail(env.RUNTIME_DB, {
      envelopeFrom: envelopeTo,
      envelopeTo: envelopeFrom,
      messageDigest: await sha256Hex(`${messageDigest}\nreply\n${responseBody}`),
      subject: reply.subject,
      externalMessageId:reply.messageId,
      taskId,
      mateId,
      threadCode: thread.threadCode,
      userId: principal.userId
    });
  } catch (error) {
    if (mateId && messageDigest) {
      await completeInboundEmail(env.RUNTIME_DB, mateId, messageDigest, taskId || "", "failed").catch(() => undefined);
    }
    if (error instanceof RuntimeHttpError && error.code === "email_sender_not_active_workspace_user") {
      message.setReject("Only an active Workspace user can assign work to this Mate by email.");
      return;
    }
    throw error;
  }
}

function emailReplyBody(reply: string, todos: Array<{ dueAt?: string; title: string }>, reminders: Array<{ nextDueAt: string; title: string }>, threadCode: string) {
  const sections = [reply.trim(), `Thread Code: ${threadCode}`];
  if (todos.length) sections.push(`已记录 Todo：\n${todos.map((todo) => `- ${todo.title}${todo.dueAt ? ` · ${todo.dueAt}` : ""}`).join("\n")}`);
  if (reminders.length) sections.push(`已设置提醒：\n${reminders.map((reminder) => `- ${reminder.title} · ${reminder.nextDueAt}`).join("\n")}`);
  sections.push("后续补充请直接回复本邮件，并保留标题中的 Thread Code。");
  return sections.filter(Boolean).join("\n\n").slice(0, 80_000);
}

function emailText(textBody: unknown, htmlBody: unknown) {
  const text = typeof textBody === "string" ? textBody.trim() : "";
  if (text) return text.slice(0, 12_000);
  const html = typeof htmlBody === "string" ? htmlBody : "";
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ").trim().slice(0, 12_000);
}

function cleanSubject(value: string) { return value.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim(); }
function normalizeEmail(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}
async function sha256Bytes(value: ArrayBuffer) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
