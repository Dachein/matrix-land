import {
  outboundAttachments,finalizeOutbound,repairOutboundMetadata,
  replyHeaders,
  saveOutbound,
} from "./outboundContent.ts";
import { appMailFetch, configureAppMailbox } from "./appMail.ts";
import {
  workspaceMailRequest,
  verifyMailToken,
  type MailAuthority,
} from "../../../src/shared/workspaceMailClient.ts";
import { mailToolDefinitions } from "../../../src/shared/mailTools.ts";
import { validateJsonSchema } from "../../mcp/src/schemaValidation.ts";
import {
  executeMailboxTool,
  storeIncomingMail,
  migrateLegacyMail,
  cleanLegacyMail,
} from "./mailbox.ts";
import { MailError, type MailEnv, type MailboxIdentity } from "./types.ts";
import { installationHostname } from "../../../src/shared/installationDomains.ts";

export async function mailFetch(
  request: Request,
  env: MailEnv,
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET")
      return Response.json({ ok: true, service: "workspace-mail-worker" });
    if (request.method !== "POST")
      throw new MailError(405, "mail_method_not_allowed");
    if (path.startsWith("/v1/app/mail/"))
      return await appMailFetch(request, env);
    let authority: MailAuthority;
    try {
      authority = await verifyMailToken(
        env.WORKSPACE_MAIL_SECRET,
        request.headers.get("authorization")?.replace(/^Bearer /, "") || "",
      );
    } catch {
      throw new MailError(401, "mail_unauthorized");
    }
    const raw = await request.text();
    if (raw.length > 7_000_000)
      throw new MailError(413, "mail_request_too_large");
    let args: Record<string, any>;
    try {
      args = JSON.parse(raw);
    } catch {
      throw new MailError(400, "mail_arguments_invalid");
    }
    if (!args || Array.isArray(args))
      throw new MailError(400, "mail_arguments_invalid");
    if (path === "/internal/mailboxes/disable") {
      requireScope(authority, "mail:provision");
      await env.RUNTIME_DB.prepare(
        "UPDATE workspace_mail_mailboxes SET status='disabled',receive_enabled=0,checked_at=CURRENT_TIMESTAMP WHERE mate_id=? AND org_id=? AND user_id=? AND owner_kind='mate'",
      )
        .bind(authority.mateId || "", authority.orgId, authority.userId)
        .run();
      return reply({ status: "disabled" });
    }
    if (path === "/internal/apps/revoke") {
      requireScope(authority, "mail:app-provision");
      if (!authority.appId)
        throw new MailError(403, "mail_app_configuration_denied");
      await env.RUNTIME_DB.batch([
        env.RUNTIME_DB.prepare(
          "UPDATE workspace_mail_app_grants SET enabled=0,receive_enabled=0,send_enabled=0 WHERE app_id=? AND org_id=?",
        ).bind(authority.appId, authority.orgId),
        env.RUNTIME_DB.prepare(
          "UPDATE workspace_mail_mailboxes SET status='disabled',receive_enabled=0 WHERE owner_kind='app' AND owner_id=? AND org_id=?",
        ).bind(authority.appId, authority.orgId),
      ]);
      return reply({ status: "disabled" });
    }
    if (path === "/internal/mailboxes/lookup") {
      requireScope(authority, "mail:provision");
      const value = await findMailbox(env, authority, false);
      return reply({
        mailboxId: value.mateId,
        address: value.address,
        status: value.status,
      });
    }
    if (path === "/internal/apps/configure")
      return reply(await configureAppMailbox(env, authority, args));
    if (path === "/internal/provision") {
      requireScope(authority, "mail:provision");
      return reply(
        await provisionMailbox(env, authority, args as MailboxIdentity),
      );
    }
    if (
      path === "/internal/event/read" ||
      path === "/internal/event/attachment"
    ) {
      requireScope(authority, "mail:event");
      const mailbox = await findMailbox(env, authority, false);
      return reply(
        await executeMailboxTool(
          env,
          mailbox,
          path.endsWith("/attachment") ? "mail_get_attachment" : "mail_get",
          path.endsWith("/attachment")
            ? {
                messageId: args.messageId,
                attachmentId: args.attachmentId,
                offset: args.offset,
              }
            : { messageId: args.messageId, bodyOffset: args.bodyOffset },
        ),
      );
    }
    if (path === "/internal/task/reply") {
      requireScope(authority, "mail:task-reply");
      const mailbox = await findMailbox(env, authority, false);
      const source = (await executeMailboxTool(env, mailbox, "mail_get", {
        messageId: args.messageId,
      })) as any;
      if (args.to !== source.message.from)
        throw new MailError(403, "mail_reply_recipient_invalid");
      return reply(
        await sendMail(env, mailbox, {
          ...args,
          subject: args.subject || `Re: ${source.message.subject}`,
          inReplyTo: source.messageIdHeader,
          references: source.references,
        }),
      );
    }
    if (path === "/internal/task/send") {
      requireScope(authority, "mail:task-send");
      return reply(
        await sendMail(env, await findMailbox(env, authority, false), args),
      );
    }
    const name = path.replace("/v1/mail/", "");
    const definition = mailToolDefinitions.find((t) => t.name === name);
    if (!definition) throw new MailError(404, "mail_tool_not_found");
    requireScope(
      authority,
      name === "mail_send" || name === "mail_reply"
        ? "mail:send"
        : name === "mail_update"
          ? "mail:write"
          : "mail:read",
    );
    if (validateJsonSchema(definition.inputSchema, args).length)
      throw new MailError(400, "mail_arguments_invalid");
    const mailbox = await findMailbox(env, authority, true);
    if (name === "mail_send") return reply(await sendMail(env, mailbox, args));
    if (name === "mail_reply") {
      const source = (await executeMailboxTool(env, mailbox, "mail_get", {
        messageId: args.messageId,
      })) as any;
      return reply(
        await sendMail(env, mailbox, {
          ...args,
          to: source.message.from,
          subject: `Re: ${source.message.subject}`,
          inReplyTo: source.messageIdHeader,
          references: source.references,
        }),
      );
    }
    return reply(await executeMailboxTool(env, mailbox, name, args));
  } catch (error) {
    const known = error as { status?: number; code?: string };
    return Response.json(
      { error: known.code || "mail_service_unavailable" },
      {
        status: known.status || 503,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}
export async function receiveMail(
  message: ForwardableEmailMessage,
  env: MailEnv,
) {
  const mailbox = await env.RUNTIME_DB.prepare(
    "SELECT mate_id AS mateId,org_id AS orgId,user_id AS userId,address,owner_kind AS ownerKind FROM workspace_mail_mailboxes WHERE address=? AND status='ready' AND receive_enabled=1",
  )
    .bind(message.to.trim().toLowerCase())
    .first<MailboxIdentity>();
  if (!mailbox) {
    message.setReject("Mailbox is not provisioned.");
    return;
  }
  if (message.rawSize > 5_000_000) {
    message.setReject("Maximum email size is 5 MB.");
    return;
  }
  await storeIncomingMail(
    env,
    mailbox,
    message.from.trim().toLowerCase(),
    await new Response(message.raw).arrayBuffer(),
  );
}
async function findMailbox(
  env: MailEnv,
  authority: MailAuthority,
  defaultOnly: boolean,
) {
  const mailbox = await env.RUNTIME_DB.prepare(
    `SELECT mate_id AS mateId,org_id AS orgId,user_id AS userId,address,display_name AS name,status FROM workspace_mail_mailboxes WHERE org_id=? AND user_id=? AND ${defaultOnly ? "is_default=1 AND owner_kind='mate'" : "mate_id=?"} LIMIT 1`,
  )
    .bind(
      authority.orgId,
      authority.userId,
      ...(defaultOnly ? [] : [authority.mateId || ""]),
    )
    .first<MailboxIdentity>();
  if (!mailbox) throw new MailError(409, "mailbox_not_provisioned");
  if (mailbox.status !== "ready") throw new MailError(503, "mailbox_not_ready");
  if (authority.mateId && authority.mateId !== mailbox.mateId)
    throw new MailError(403, "mailbox_access_denied");
  return mailbox;
}
export async function provisionMailbox(
  env: MailEnv,
  authority: MailAuthority,
  input: MailboxIdentity,
) {
  if (
    input.userId !== authority.userId ||
    input.orgId !== authority.orgId ||
    input.mateId !== authority.mateId ||
    !/^[a-zA-Z0-9._+-]+$/.test(input.address?.split('@')[0] || '') ||
    input.address?.split('@').length !== 2 ||
    input.address?.split('@')[1] !== (installationHostname(input.ownerKind === 'app' ? env.WORKSPACE_EMAIL_ROUTING_DOMAIN : env.WORKSPACE_MATE_EMAIL_DOMAIN))
  )
    throw new MailError(400, "mailbox_identity_invalid");
  const address = input.address.toLowerCase();
  const current = await env.RUNTIME_DB.prepare(
    "SELECT org_id,user_id,address,status FROM workspace_mail_mailboxes WHERE mate_id=?",
  ).bind(input.mateId).first<{org_id:string;user_id:string;address:string;status:string}>();
  if (current && (current.org_id !== input.orgId || current.user_id !== input.userId))
    throw new MailError(409, "mailbox_address_conflict");
  if (
    input.ownerKind === "app" &&
    (!authority.appId || input.ownerId !== authority.appId)
  )
    throw new MailError(403, "mail_app_configuration_denied");
  if (input.ownerKind !== "app" && authority.appId)
    throw new MailError(403, "mail_app_configuration_denied");
  const previous = await env.RUNTIME_DB.prepare(
    "SELECT org_id,user_id,mate_id FROM workspace_mail_mailboxes WHERE address=?",
  )
    .bind(address)
    .first<{ org_id: string; user_id: string; mate_id: string }>();
  if (
    previous &&
    (previous.org_id !== input.orgId ||
      previous.user_id !== input.userId ||
      previous.mate_id !== input.mateId)
  )
    throw new MailError(409, "mailbox_address_conflict");
  await env.RUNTIME_DB.prepare(
    `INSERT INTO workspace_mail_mailboxes (mate_id,org_id,user_id,address,display_name,is_default,owner_kind,owner_id,receive_enabled) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(mate_id) DO UPDATE SET display_name=excluded.display_name,is_default=excluded.is_default,receive_enabled=excluded.receive_enabled`,
  )
    .bind(
      input.mateId,
      input.orgId,
      input.userId,
      address,
      input.name || input.mateId,
      Number(input.isDefault === true),
      input.ownerKind || "mate",
      input.ownerId || input.mateId,
      Number(input.receiveEnabled !== false),
    )
    .run();
  try {
    if (input.receiveEnabled === false) {
      if (!env.EMAIL) throw new MailError(503, "mail_sending_not_configured");
      await env.RUNTIME_DB.prepare(
        "UPDATE workspace_mail_mailboxes SET address=?,status='ready',last_error=NULL,checked_at=CURRENT_TIMESTAMP WHERE mate_id=?",
      )
        .bind(address,input.mateId)
        .run();
      return { address, status: "ready" };
    }
    if (!env.CF_API_TOKEN || !env.CF_ZONE_ID)
      throw new MailError(503, "mail_routing_not_configured");
    const rules: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const part = await cf(
        env,
        `/zones/${env.CF_ZONE_ID}/email/routing/rules?per_page=50&page=${page}`,
      );
      rules.push(...part);
      if (part.length < 50) break;
      if (page === 100)
        throw new MailError(503, "mail_route_inventory_too_large");
    }
    const matching = rules.filter((rule: any) =>
      rule.matchers?.some(
        (matcher: any) =>
          matcher.field === "to" && matcher.value?.toLowerCase() === address,
      ),
    );
    if (
      matching.length > 1 ||
      (matching[0] &&
        (matching[0].matchers?.length !== 1 ||
          matching[0].matchers[0].type !== "literal"))
    )
      throw new MailError(409, "mailbox_route_conflict");
    const existing = matching[0];
    if (
      existing &&
      existing.actions?.some(
        (action: any) =>
          action.type !== "worker" ||
          ![
            "workspace-mail-worker",
            "workspace-mate-runtime",
            "workspace-email-router",
          ].includes(action.value?.[0]) ||
          action.value?.length !== 1,
      )
    )
      throw new MailError(409, "mailbox_route_conflict");
    const spec = {
      name: `Agent mailbox ${input.mateId}`,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: address }],
      actions: [{ type: "worker", value: ["workspace-mail-worker"] }],
    };
    const rule =
      existing?.enabled &&
      existing.actions?.[0]?.value?.[0] === "workspace-mail-worker"
        ? existing
        : await cf(
            env,
            `/zones/${env.CF_ZONE_ID}/email/routing/rules${existing ? `/${existing.id}` : ""}`,
            existing ? "PUT" : "POST",
            spec,
          );
    const probe = `health/${crypto.randomUUID()}`;
    await env.MAIL_OBJECTS.put(probe, "ready", {
      customMetadata: { purpose: "mailbox-provisioning" },
    });
    await env.MAIL_OBJECTS.delete(probe);
    await env.RUNTIME_DB.prepare(
      "UPDATE workspace_mail_mailboxes SET address=?,status='ready',routing_rule_id=?,last_error=NULL,checked_at=CURRENT_TIMESTAMP WHERE mate_id=?",
    )
      .bind(address, rule.id, input.mateId)
      .run();
    return { address, status: "ready" };
  } catch (error) {
    const code = (error as MailError).code || "mail_routing_provision_failed";
    await env.RUNTIME_DB.prepare(
      "UPDATE workspace_mail_mailboxes SET status=CASE WHEN ? THEN status ELSE 'provisioning' END,last_error=?,checked_at=CURRENT_TIMESTAMP WHERE mate_id=?",
    )
      .bind(Number(current?.status === 'ready' && current.address !== address),code, input.mateId)
      .run();
    throw error;
  }
}
async function cf(env: MailEnv, path: string, method = "GET", body?: unknown) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    // Workers supports manual/follow only; never forward credentials on redirects.
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status >= 300 && response.status < 400)
    throw new MailError(503, "mail_routing_redirect_denied");
  const payload = (await response.json()) as any;
  if (!response.ok || !payload.success)
    throw new MailError(503, `mail_routing_api_${response.status}`);
  return payload.result;
}
export async function sendMail(
  env: MailEnv,
  mailbox: MailboxIdentity,
  input: Record<string, any>,
  createRawMessage = async (from: string, to: string, raw: string): Promise<EmailMessage> => {
    const { EmailMessage } = await import("cloudflare:email");
    return new EmailMessage(from, to, raw);
  },
) {
  if (!env.EMAIL) throw new MailError(503, "mail_sending_not_configured");
  if (
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.to || "") ||
    typeof input.subject !== "string" ||
    !input.subject.trim() ||
    input.subject.length > 1000 ||
    /[\r\n]/.test(input.subject || "") ||
    typeof input.body !== "string" ||
    !input.body.trim() ||
    input.body.length > 80000 ||
    typeof input.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,180}$/.test(input.idempotencyKey)
  )
    throw new MailError(400, "mail_send_arguments_invalid");
  const attachments = outboundAttachments(input.attachments);
  const digest = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([
            mailbox.address,
            input.to,
            input.subject,
            input.body,
            input.inReplyTo || "",
            attachments.map((a) => [a.filename, a.mimeType, a.contentBase64]),
          ]),
        ),
      ),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const old = await env.RUNTIME_DB.prepare(
    "SELECT id,message_id,request_digest,status FROM workspace_mail_outbound WHERE org_id=? AND user_id=? AND mate_id=? AND idempotency_key=?",
  )
    .bind(mailbox.orgId, mailbox.userId, mailbox.mateId, input.idempotencyKey)
    .first<any>();
  if (old) {
    if (old.request_digest !== digest)
      throw new MailError(409, "mail_idempotency_conflict");
    return { id: old.id, status: old.status, messageId: old.message_id };
  }
  const id = `out_${crypto.randomUUID()}`,
    messageId = `<${id}@${mailbox.address.split("@")[1]}>`;
  const inserted = await env.RUNTIME_DB.prepare(
    `INSERT INTO workspace_mail_outbound (id,org_id,user_id,mate_id,idempotency_key,request_digest,recipient,subject,message_id,status) VALUES (?,?,?,?,?,?,?,?,?,'preparing') ON CONFLICT(org_id,user_id,mate_id,idempotency_key) DO NOTHING`,
  )
    .bind(
      id,
      mailbox.orgId,
      mailbox.userId,
      mailbox.mateId,
      input.idempotencyKey,
      digest,
      input.to,
      input.subject,
      messageId,
    )
    .run();
  if (!inserted.meta.changes) {
    const winner = await env.RUNTIME_DB.prepare(
      "SELECT id,message_id,request_digest,status FROM workspace_mail_outbound WHERE org_id=? AND user_id=? AND mate_id=? AND idempotency_key=?",
    )
      .bind(mailbox.orgId, mailbox.userId, mailbox.mateId, input.idempotencyKey)
      .first<any>();
    if (!winner || winner.request_digest !== digest)
      throw new MailError(409, "mail_idempotency_conflict");
    return {
      id: winner.id,
      status: winner.status,
      messageId: winner.message_id,
    };
  }
  let objectKey="", rawMime="";
  try {
    const archived = await saveOutbound(
      env,
      mailbox,
      id,
      messageId,
      input,
      attachments,
    );
    objectKey = archived.key;
    rawMime = archived.raw;
    await env.RUNTIME_DB.prepare(
      "UPDATE workspace_mail_outbound SET object_key=?,status='sending' WHERE id=?",
    )
      .bind(objectKey, id)
      .run();
  } catch {
    await env.RUNTIME_DB.prepare(
      "UPDATE workspace_mail_outbound SET status='failed',error='mail_storage_failed_before_send' WHERE id=?",
    )
      .bind(id)
      .run();
    throw new MailError(503, "mail_outbound_storage_failed");
  }
  try {
    // Explicit MIME Base64 parts preserve bytes; the structured builder may
    // choose a text transfer encoding or treat string content as literal text.
    const result = attachments.length
      ? await env.EMAIL.send(await createRawMessage(mailbox.address,input.to,
          rawMime.replace(/^Message-ID:[^\r\n]*(?:\r?\n|$)/im,"")))
      : await env.EMAIL.send({
      from: { email: mailbox.address, name: mailbox.name || mailbox.mateId },
      to: input.to,
      subject: input.subject,
      text: input.body,
      headers: {
        "X-Workspace-Mail-ID": id,
        "Auto-Submitted": "auto-generated",
        ...replyHeaders(input),
      },
    });
    await env.RUNTIME_DB.prepare(
      "UPDATE workspace_mail_outbound SET status='sent',provider_id=?,message_id=? WHERE id=?",
    )
      .bind(result.messageId || null,result.messageId||messageId, id)
      .run();
    const deliveredMessageId=result.messageId||messageId;
    try {await finalizeOutbound(env,objectKey,deliveredMessageId);}catch {await env.RUNTIME_DB.prepare("UPDATE workspace_mail_outbound SET error='provider_metadata_refresh_failed' WHERE id=?").bind(id).run();}
    return { id, status: "sent", messageId:deliveredMessageId };
  } catch (error) {
    const code=String((error as {code?:string})?.code||'');
    const rejected=/^E_(?:VALIDATION_ERROR|FIELD_MISSING|TOO_MANY_RECIPIENTS|TOO_MANY_ATTACHMENTS|SENDER_NOT_VERIFIED|SENDER_DOMAIN_NOT_AVAILABLE|RECIPIENT_NOT_ALLOWED|RECIPIENT_SUPPRESSED|CONTENT_TOO_LARGE|HEADER_[A-Z_]+|HEADERS_[A-Z_]+|RATE_LIMIT_EXCEEDED|DAILY_LIMIT_EXCEEDED)$/.test(code);
    await env.RUNTIME_DB.prepare("UPDATE workspace_mail_outbound SET status=?,error=? WHERE id=?").bind(rejected?'failed':'delivery_unknown',rejected?code:'provider_send_failed_or_unknown',id).run();
    throw new MailError(502,rejected?`mail_provider_${code.toLowerCase()}`:'mail_send_failed_or_unknown');
  }
}
export async function dispatchEvents(env: MailEnv) {
  // Repair an interrupted ingestion between the index commit and event publication.
  await env.RUNTIME_DB.prepare(
    `INSERT OR IGNORE INTO workspace_mail_events (message_id,org_id,user_id,mate_id) SELECT id,org_id,user_id,mate_id FROM mate_mail_messages WHERE object_key NOT LIKE 'mate-mail/%'`,
  ).run();
  const rows = (
    await env.RUNTIME_DB.prepare(
      `SELECT e.* FROM workspace_mail_events e JOIN workspace_mail_mailboxes m ON e.mate_id=m.mate_id JOIN mate_mail_messages msg ON msg.id=e.message_id WHERE m.owner_kind='mate' AND delivered_at IS NULL AND next_attempt_at<=CURRENT_TIMESTAMP AND attempts<20 ORDER BY e.next_attempt_at LIMIT 20`,
    ).all<any>()
  ).results;
  for (const row of rows) {
    try {
      const response = await workspaceMailRequest(
        {
          WORKSPACE_MAIL: env.MATE_RUNTIME,
          WORKSPACE_MAIL_SECRET: env.WORKSPACE_MAIL_SECRET,
        },
        {
          userId: row.user_id,
          orgId: row.org_id,
          mateId: row.mate_id,
          scopes: ["mail:event"],
        },
        "/internal/mail/received",
        { messageId: row.message_id },
      );
      if (!response.ok) throw new Error(`trigger_${response.status}`);
      await env.RUNTIME_DB.prepare(
        "UPDATE workspace_mail_events SET delivered_at=CURRENT_TIMESTAMP,last_error=NULL WHERE message_id=?",
      )
        .bind(row.message_id)
        .run();
    } catch (error) {
      await env.RUNTIME_DB.prepare(
        "UPDATE workspace_mail_events SET attempts=attempts+1,next_attempt_at=datetime('now','+1 minute'),last_error=? WHERE message_id=?",
      )
        .bind(String((error as Error).message).slice(0, 100), row.message_id)
        .run();
    }
  }
  const appEvents = (await env.RUNTIME_DB.prepare(`SELECT e.*,m.owner_id AS app_id,msg.envelope_to AS address,msg.received_at FROM workspace_mail_events e JOIN workspace_mail_mailboxes m ON m.mate_id=e.mate_id JOIN mate_mail_messages msg ON msg.id=e.message_id JOIN workspace_mail_app_grants g ON g.app_id=m.owner_id AND g.inbox_id=m.mate_id AND g.org_id=m.org_id WHERE m.owner_kind='app' AND m.status='ready' AND m.receive_enabled=1 AND g.enabled=1 AND g.receive_enabled=1 AND g.trigger_enabled=1 AND julianday(msg.received_at)>=julianday(g.trigger_enabled_at) AND e.delivered_at IS NULL AND e.next_attempt_at<=CURRENT_TIMESTAMP AND e.attempts<20 AND (e.app_lease_until IS NULL OR e.app_lease_until<=CURRENT_TIMESTAMP) ORDER BY e.next_attempt_at LIMIT 20`).all<any>()).results;
  for (const row of appEvents) {
    const lease=crypto.randomUUID();
    const claimed=await env.RUNTIME_DB.prepare("UPDATE workspace_mail_events SET attempts=attempts+1,app_lease_token=?,app_lease_until=datetime('now','+2 minutes') WHERE message_id=? AND delivered_at IS NULL AND attempts<20 AND (app_lease_until IS NULL OR app_lease_until<=CURRENT_TIMESTAMP)").bind(lease,row.message_id).run();
    if(!claimed.meta.changes)continue;
    try {
      const response = await workspaceMailRequest({WORKSPACE_MAIL:env.APPS_CONTROL_PLANE,WORKSPACE_MAIL_SECRET:env.WORKSPACE_MAIL_SECRET},{userId:row.user_id,orgId:row.org_id,appId:row.app_id,scopes:["mail:app-event"]},"/internal/mail/apps/received",{id:row.message_id,type:"workspace.mail.received",appId:row.app_id,messageId:row.message_id,mailbox:row.address,receivedAt:row.received_at});
      if (!response.ok) throw new Error(`app_trigger_${response.status}`);
      await env.RUNTIME_DB.prepare("UPDATE workspace_mail_events SET delivered_at=CURRENT_TIMESTAMP,last_error=NULL,app_lease_token=NULL,app_lease_until=NULL WHERE message_id=? AND app_lease_token=?").bind(row.message_id,lease).run();
    } catch(error) {
      await env.RUNTIME_DB.prepare("UPDATE workspace_mail_events SET next_attempt_at=datetime('now','+1 minute'),last_error=?,app_lease_token=NULL,app_lease_until=NULL WHERE message_id=? AND app_lease_token=?").bind(String((error as Error).message).slice(0,100),row.message_id,lease).run();
    }
  }
}
function requireScope(authority: MailAuthority, scope: string) {
  if (!authority.scopes.includes(scope))
    throw new MailError(403, "mail_scope_insufficient");
}
function reply(payload: unknown) {
  return Response.json(payload, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
export default {
  fetch: mailFetch,
  email: receiveMail,
  scheduled(
    _controller: ScheduledController,
    env: MailEnv,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(Promise.allSettled([migrateLegacyMail(env),cleanLegacyMail(env),dispatchEvents(env),repairOutboundMetadata(env)]).then(results=>{
      results.forEach((result,index)=>{if(result.status==='rejected')console.error('workspace_mail_maintenance_failed',{operation:['migration','cleanup','dispatch','outbound_metadata'][index],code:result.reason instanceof MailError?result.reason.code:'maintenance_failed'});});
    }));
  },
};
