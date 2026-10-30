import { installationHostname } from "../../../src/shared/installationDomains.ts";
import type { MailAuthority } from "../../../src/shared/workspaceMailClient.ts";
import { mailToolDefinitions } from "../../../src/shared/mailTools.ts";
import { validateJsonSchema } from "../../mcp/src/schemaValidation.ts";
import { executeMailboxTool } from "./mailbox.ts";
import { MailError, type MailboxIdentity, type MailEnv } from "./types.ts";
import { provisionMailbox, sendMail } from "./worker.ts";

type AppGrant = {
  app_id: string;
  org_id: string;
  user_id: string;
  token_hash: string;
  inbox_id: string | null;
  sender_id: string | null;
  receive_enabled: number;
  send_enabled: number;
  enabled: number;
  trigger_enabled: number;
  trigger_enabled_at: string | null;
};
export async function appMailFetch(
  request: Request,
  env: MailEnv,
): Promise<Response> {
  const token =
    request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  if (!/^fmail_[a-f0-9]{64}$/.test(token))
    throw new MailError(401, "mail_app_unauthorized");
  const grant = await env.RUNTIME_DB.prepare(
    "SELECT * FROM workspace_mail_app_grants WHERE token_hash=? AND enabled=1",
  )
    .bind(await tokenHash(token))
    .first<AppGrant>();
  if (!grant) throw new MailError(401, "mail_app_unauthorized");
  const name = new URL(request.url).pathname.replace("/v1/app/mail/", "");
  if (request.method !== "POST")
    throw new MailError(405, "mail_method_not_allowed");
  const raw = await request.text();
  if (raw.length > 7000000) throw new MailError(413, "mail_request_too_large");
  let args: any;
  try {
    args = JSON.parse(raw);
  } catch {
    throw new MailError(400, "mail_arguments_invalid");
  }
  const read = async (id: string | null) =>
    id
      ? await env.RUNTIME_DB.prepare(
          "SELECT mate_id AS mateId,org_id AS orgId,user_id AS userId,address,display_name AS name,status,owner_kind AS ownerKind FROM workspace_mail_mailboxes WHERE mate_id=? AND org_id=? AND owner_kind='app' AND owner_id=?",
        )
          .bind(id, grant.org_id, grant.app_id)
          .first<MailboxIdentity>()
      : null;
  if (name === "mailbox") {
    const inbox = await read(grant.inbox_id),
      sender = await read(grant.sender_id);
    return Response.json({
      status:
        (!grant.receive_enabled || inbox?.status === "ready") &&
        (!grant.send_enabled || sender?.status === "ready")
          ? "ready"
          : "provisioning",
      inbox: inbox?.address,
      sender: sender?.address,
      receive: !!grant.receive_enabled,
      send: !!grant.send_enabled,
      trigger: {
        enabled: !!grant.trigger_enabled,
        path: "/_workspace/mail/received",
        delivery: "at_least_once",
        ...(grant.trigger_enabled ? await env.RUNTIME_DB.prepare(`SELECT COALESCE(SUM(CASE WHEN e.attempts<20 OR e.app_lease_until>CURRENT_TIMESTAMP THEN 1 ELSE 0 END),0) AS pending,COALESCE(SUM(CASE WHEN e.attempts>=20 AND (e.app_lease_until IS NULL OR e.app_lease_until<=CURRENT_TIMESTAMP) THEN 1 ELSE 0 END),0) AS failed FROM workspace_mail_events e JOIN mate_mail_messages msg ON msg.id=e.message_id WHERE e.mate_id=? AND delivered_at IS NULL AND julianday(msg.received_at)>=julianday(?)`).bind(grant.inbox_id || "",grant.trigger_enabled_at || "9999-12-31T23:59:59.999Z").first() : {pending:0,failed:0}),
      },
    });
  }
  const definition = mailToolDefinitions.find((t) => t.name === name);
  if (!definition) throw new MailError(404, "mail_tool_not_found");
  if (validateJsonSchema(definition.inputSchema, args).length)
    throw new MailError(400, "mail_arguments_invalid");
  const sending = name === "mail_send" || name === "mail_reply";
  const outboundRead =
    (name === "mail_list" && args.folder === "sent") ||
    (["mail_get", "mail_get_attachment"].includes(name) &&
      String(args.messageId).startsWith("out_"));
  if (
    ((sending || outboundRead) && !grant.send_enabled) ||
    (!sending && !outboundRead && !grant.receive_enabled) ||
    (name === "mail_reply" && !grant.receive_enabled)
  )
    throw new MailError(403, "mail_app_capability_disabled");
  const mailbox = await read(
    sending || outboundRead ? grant.sender_id : grant.inbox_id,
  );
  if (!mailbox || mailbox.status !== "ready")
    throw new MailError(503, "mailbox_not_ready");
  let result;
  if (name === "mail_send") result = await sendMail(env, mailbox, args);
  else if (name === "mail_reply") {
    const inbox = await read(grant.inbox_id);
    if (!inbox) throw new MailError(403, "mail_app_capability_disabled");
    const source = (await executeMailboxTool(env, inbox, "mail_get", {
      messageId: args.messageId,
    })) as any;
    result = await sendMail(env, mailbox, {
      ...args,
      to: source.message.from,
      subject: `Re: ${source.message.subject}`,
      inReplyTo: source.messageIdHeader,
      references: source.references,
    });
  } else result = await executeMailboxTool(env, mailbox, name, args);
  return Response.json(result, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
export async function configureAppMailbox(
  env: MailEnv,
  authority: MailAuthority,
  input: any,
) {
  if (
    !authority.scopes.includes("mail:app-provision") ||
    !input.appId ||
    authority.appId !== input.appId ||
    typeof input.receive !== "boolean" ||
    typeof input.send !== "boolean" ||
    !/^fmail_[a-f0-9]{64}$/.test(input.token || "")
  )
    throw new MailError(403, "mail_app_configuration_denied");
  const existing = await env.RUNTIME_DB.prepare(
    "SELECT * FROM workspace_mail_app_grants WHERE app_id=?",
  )
    .bind(input.appId)
    .first<AppGrant>();
  if (existing && existing.org_id !== authority.orgId)
    throw new MailError(403, "mail_app_configuration_denied");
  if (input.triggerEnabled !== undefined && typeof input.triggerEnabled !== "boolean") throw new MailError(400,"mail_app_trigger_invalid");
  if (input.triggerEnabled && !input.receive) throw new MailError(400,"mail_app_trigger_requires_mailbox");
  const result: { inbox?: string; sender?: string } = {};
  for (const role of ["inbox", "sender"] as const) {
    const address = input[role];
    const enabled = role === "inbox" ? input.receive : input.send;
    if (!enabled) continue;
    if (
      typeof address !== "string" ||
      address.split("@")[1] !== installationHostname(env.WORKSPACE_EMAIL_ROUTING_DOMAIN)
    )
      throw new MailError(400, "mail_app_address_invalid");
    const unified = input.receive && input.send && input.inbox?.toLowerCase() === input.sender?.toLowerCase();
    const mailboxId = (unified && (existing?.inbox_id || existing?.sender_id)) || `app:${input.appId}:${(await tokenHash(address.toLowerCase())).slice(0, 16)}`;
    await provisionMailbox(
      env,
      { ...authority, mateId: mailboxId },
      {
        orgId: authority.orgId,
        userId: authority.userId,
        mateId: mailboxId,
        address,
        name: input.name || input.appId,
        ownerKind: "app",
        ownerId: input.appId,
        receiveEnabled: input.receive && address === input.inbox,
      },
    );
    result[role] = mailboxId;
  }
  await env.RUNTIME_DB.prepare(
    `INSERT INTO workspace_mail_app_grants(app_id,org_id,user_id,token_hash,inbox_id,sender_id,receive_enabled,send_enabled,enabled) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(app_id) DO UPDATE SET token_hash=excluded.token_hash,inbox_id=excluded.inbox_id,sender_id=excluded.sender_id,receive_enabled=excluded.receive_enabled,send_enabled=excluded.send_enabled,enabled=excluded.enabled`,
  )
    .bind(
      input.appId,
      authority.orgId,
      authority.userId,
      await tokenHash(input.token),
      result.inbox || existing?.inbox_id || null,
      result.sender || existing?.sender_id || null,
      Number(input.receive),
      Number(input.send),
      Number(input.receive || input.send),
    )
    .run();
  await env.RUNTIME_DB.prepare(`UPDATE workspace_mail_app_grants SET trigger_enabled_at=CASE WHEN ?=1 AND trigger_enabled=0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE trigger_enabled_at END,trigger_enabled=? WHERE app_id=?`).bind(Number(input.triggerEnabled === true),Number(input.triggerEnabled === true),input.appId).run();
  await env.RUNTIME_DB.prepare(
    "UPDATE workspace_mail_mailboxes SET receive_enabled=CASE WHEN mate_id=? THEN ? ELSE 0 END WHERE owner_kind='app' AND owner_id=? AND org_id=?",
  )
    .bind(
      result.inbox || "",
      Number(input.receive),
      input.appId,
      authority.orgId,
    )
    .run();
  return { status: "ready", ...result };
}
async function tokenHash(token: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
