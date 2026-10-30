import { testInstallation } from "../../../tests/helpers/installation.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { receiveMail as handleMateEmail, mailFetch } from "../../mail/src/worker.ts";
import { routeMailRequest } from "./mailRoutes.ts";
import { storeIncomingMail } from "../../mail/src/mailbox.ts";
import { readDefaultMailbox } from "../../apps/src/mates/mailbox.ts";
import { callPublicMcpTool, mcpTools } from "../../mcp/src/tools.ts";
import { signJwt } from "../../mcp/src/auth.ts";
import { runtimeWorkspacePassToolDefinitions } from "../../mcp/src/runtimeWorkspacePassTools.ts";
import { handleWorkspaceMcpWorkerRequest } from "../../mcp/src/worker.ts";

import { fixture,mime } from "./mailTestFixture.mjs";
import { createConversationTools } from "./conversationAgent.ts";
import { executeConversationWorkspacePassRead } from "./workspacePassMcpExecutor.ts";

const buffer = value => new TextEncoder().encode(value).buffer;

test("a live owner conversation reads its provisioned mailbox without a generic Workspace MCP scope", async () => {
  const f = fixture();
  const stored = await storeIncomingMail(f.env, f.mailbox, "invoices@hotel.example", buffer(mime()));
  const bridge = { ...testInstallation,  ...f.desktop, MATE_RUNTIME_SERVICE_TOKEN: "bridge-secret" };
  const env = { ...testInstallation,  MATE_RUNTIME_SERVICE_TOKEN: "bridge-secret", AI: { async toMarkdown(file) {
    assert.equal(await file.blob.text(), "%PDF-test-invoice\n");
    return { format: "markdown", data: "Invoice amount 284.00" };
  } }, WORKSPACE_MCP_SERVICE: {
    fetch: request => handleWorkspaceMcpWorkerRequest(request, bridge)
  } };
  const definition = { mate: { id: "ada", ownerUserId: "user-1", orgId: "org-1", workEmail: "ada@mate.example.invalid" },
    release: { id: "ada-r1", manifest: { resources: { builtInToolBindings: [{ toolId: "document_read" }], appMcpBindings: [], knowledgeServiceBindings: [] } } } };
  const principal = { callerKind: "user", userId: "user-1", orgId: "org-1", scopes: ["mate:invoke"] };
  const selection = { appIds: [], attachments: new Map(), knowledgeServiceIds: [], mode: "live", turnId: "mail-read" };
  const tools = await createConversationTools(env, definition, principal, selection, []);
  assert.deepEqual(Object.keys(tools).filter(name => name.startsWith("mail_")).sort(), ["mail_attachment_read", "mail_get", "mail_get_attachment", "mail_list"]);
  const list = await tools.mail_list.execute({}, {});
  assert.equal(list.messages[0].id, stored.id);
  const detail = await tools.mail_get.execute({ messageId: stored.id }, {});
  assert.equal(detail.message.id, stored.id);
  const attachment = await tools.mail_get_attachment.execute({ messageId: stored.id, attachmentId: detail.attachments[0].id }, {});
  assert.equal(Buffer.from(attachment.data, "base64").toString(), "%PDF-test-invoice\n");
  const converted = await tools.mail_attachment_read.execute({ messageId: stored.id, attachmentId: detail.attachments[0].id }, {});
  assert.equal(converted.content, "Invoice amount 284.00");
  assert.equal(converted.contentTrust, "untrusted_email");
  const expectedDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("%PDF-test-invoice\n")))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(converted.sha256, expectedDigest);
  const policy = { name: "mail_get", runtimePolicy: { writeMode: "never" } };
  for (const [who, mode] of [[{ ...principal, userId: "user-2" }, "live"], [{ ...principal, orgId: "org-2" }, "live"],
    [{ ...principal, callerKind: "service" }, "live"], [principal, "preview"]]) {
    const denied = await createConversationTools(env, definition, who, { ...selection, mode }, []);
    assert.equal(Object.keys(denied).some(name => name.startsWith("mail_")), false);
    await assert.rejects(executeConversationWorkspacePassRead(env, definition, who, policy, { messageId: stored.id }, mode), /mailbox_access_denied/);
  }
});

test("external mail is saved once and all four desktop tools share the same mailbox", async () => {
  const { env, call, objects, db } = fixture();
  const raw = mime();
  for (let i = 0; i < 2; i++) await handleMateEmail({ from: "invoices@hotel.example", to: "ada@mate.example.invalid",
    raw: new Response(raw).body, rawSize: buffer(raw).byteLength, headers: new Headers(), setReject(reason) { assert.fail(reason); } }, env, {},
    { reply() { assert.fail("Receipt alone cannot execute work or reply"); } });
  const list = await call("mail_list");
  assert.equal(list.messages.length, 1);
  assert.equal(objects.size, 5);
  const message = list.messages[0];
  assert.equal(message.from, "invoices@hotel.example");
  const detail = await call("mail_get", { messageId: message.id });
  assert.equal(detail.contentTrust, "untrusted_email");
  assert.match(detail.body, /invoice/);
  assert.equal(detail.message.read, false);
  assert.equal(detail.attachments[0].filename, "invoice.pdf");
  const chunks = [];
  let offset = 0;
  do {
    const part = await call("mail_get_attachment", { messageId: message.id, attachmentId: detail.attachments[0].id, offset, length: 5 });
    chunks.push(Buffer.from(part.data, "base64")); offset = part.nextOffset;
  } while (offset !== null);
  assert.equal(Buffer.concat(chunks).toString(), "%PDF-test-invoice\n");
  const updated = await call("mail_update", { messageId: message.id, expectedVersion: 1, read: true, archived: true, labels: ["invoice"] });
  assert.equal(updated.message.version, 2);
  assert.equal(updated.message.archived, true);
  assert.equal((await call("mail_list", { label: "invoice", unread: false, archived: true })).messages.length, 1);
  assert.equal((await call("mail_list", { archived: false })).messages.length, 0);
  await assert.rejects(call("mail_update", { messageId: message.id, expectedVersion: 1, read: false }), /mail_version_conflict/);
  const key = db.prepare("SELECT object_key FROM mate_mail_messages").get().object_key;
  assert.equal(Buffer.from(objects.get(JSON.parse(objects.get(key)).rawKey)).toString(), raw);
  assert.equal(JSON.parse(objects.get(key)).rawBase64, undefined);
});

test("mailbox isolation, missing provisioning, scopes and mailbox selector rejection", async () => {
  const { env, mailbox, call, principal } = fixture();
  const { id } = await storeIncomingMail(env, mailbox, "invoices@hotel.example", buffer(mime()));
  const bob = { ...principal, sub: "user-2" };
  assert.equal((await call("mail_list", {}, bob)).messages.length, 0);
  for (const [tool, args] of [["mail_get", { messageId: id }], ["mail_get_attachment", { messageId: id, attachmentId: "attachment_1" }],
    ["mail_update", { messageId: id, expectedVersion: 1, read: true }]]) await assert.rejects(call(tool, args, bob), /mail_not_found/);
  assert.deepEqual(await call("mail_list", {}, { ...principal, sub: "unprovisioned" }), { status: "mailbox_not_provisioned", defaultAgent: null, message: "前往 Mate 开通", activationUrl: "https://ai.example.invalid/mate" });
  await assert.rejects(call("mail_list", { userId: "user-2" }), /Invalid arguments/);
  await assert.rejects(call("mail_list", { address: "bob@mate.example.invalid" }), /Invalid arguments/);
  await assert.rejects(call("mail_update", { messageId: id, expectedVersion: 1 }), /Invalid arguments/);
  await assert.rejects(call("mail_get", { messageId: id }, { ...principal, scopes: ["workspace:apps:read"] }), /scope/);
  await assert.rejects(call("mail_get", { messageId: id }, { ...principal, mateId: "public" }), /mailbox_access_denied/);
  assert.equal((await call("mail_get", { messageId: id }, { ...principal, mateId: "ada" })).message.id, id);
  await assert.rejects(call("mail_list", {}, { ...principal, orgId: "org-2" }), /mailbox_access_denied/);
});

test("pagination is stable across equal timestamps and body/attachment reads are bounded", async () => {
  const { env, mailbox, call, db } = fixture();
  for (let i = 0; i < 5; i++) await storeIncomingMail(env, mailbox, "invoices@hotel.example", buffer(mime(`Invoice ${i}`, "x".repeat(70000))));
  db.exec("UPDATE mate_mail_messages SET received_at='2026-10-17T00:00:00.000Z'");
  const ids = []; let cursor;
  do { const page = await call("mail_list", { limit: 2, ...(cursor ? { cursor } : {}) }); ids.push(...page.messages.map(m => m.id)); cursor = page.nextCursor; } while (cursor);
  assert.equal(new Set(ids).size, 5);
  const first = await call("mail_get", { messageId: ids[0] });
  assert.equal(first.body.length, 64000);
  const rest = await call("mail_get", { messageId: ids[0], bodyOffset: first.nextBodyOffset });
  assert.equal(first.body.length + rest.body.length, first.bodyLength);
  assert.equal(rest.nextBodyOffset, null);
  assert.equal((await call("mail_list", { after: "2026-10-18T00:00:00.000Z" })).messages.length, 0);
  await assert.rejects(call("mail_list", { cursor: "bad" }), /mail_cursor_invalid/);
  await assert.rejects(call("mail_get_attachment", { messageId: ids[0], attachmentId: "attachment_1", length: 262145 }), /Invalid arguments/);
});

test("runtime rejects invocation-only tokens, preview grants and untrusted authority", async () => {
  const { env } = fixture();
  async function invoke(claims, args = {}) {
    const token = await signJwt({ aud: "workspace-mate-runtime", sub: "user-1", org_id: "org-1", exp: Date.now() / 1000 + 60, ...claims },
      claims.runtime_mode === "preview" ? env.MATE_PREVIEW_JWT_SECRET : env.MATE_RUNTIME_JWT_SECRET);
    return routeMailRequest(new Request("https://runtime.example.invalid/v1/mail/mail_list", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(args) }), env);
  }
  await assert.rejects(invoke({ scopes: ["mate:*"] }), /mail_scope_insufficient/);
  await assert.rejects(invoke({ scopes: ["mail:read"], runtime_mode: "preview", mate_id: "ada", release_id: "r1" }), /runtime_mode_mismatch/);
  await assert.rejects(invoke({ scopes: ["mail:read"] }, { orgId: "org-2" }), /mail_arguments_invalid/);
});

test("catalog has six mail tools with separate send consent, scope-filtered and available to cloud Mate", async () => {
  const all = await mcpTools();
  assert.deepEqual(all.filter(t => t.name.startsWith("mail_")).map(t => t.name).sort(), ["mail_get", "mail_get_attachment", "mail_list", "mail_reply", "mail_send", "mail_update"]);
  const readOnly = await mcpTools(undefined, { scopes: ["workspace:mail:read"] });
  assert.equal(readOnly.filter(t => t.name.startsWith("mail_")).length, 3);
  assert.equal((await mcpTools(undefined, { scopes: ["workspace:apps:read"] })).filter(t => t.name.startsWith("mail_")).length, 0);
  assert.match(all.find(t => t.name === "mail_get_attachment").description, /nextOffset/);
  const cloud = runtimeWorkspacePassToolDefinitions(all).filter(t => t.name.startsWith("mail_"));
  assert.equal(cloud.length, 6);
  assert.equal(cloud.find(t => t.name === "mail_update").runtimePolicy.writeMode, "always");
});

test("R2 failure never publishes an unreadable mail index", async () => {
  const { env, mailbox, db } = fixture();
  env.MAIL_OBJECTS.put = async () => { throw Error("r2 unavailable"); };
  await assert.rejects(storeIncomingMail(env, mailbox, "sender@example.com", buffer(mime())), /r2 unavailable/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mate_mail_messages").get().n, 0);
});

test("cloud bridge forwards explicit mail grants and binds the default Mate", async () => {
  const { env, mailbox, desktop, call } = fixture();
  const { id } = await storeIncomingMail(env, mailbox, "sender@example.com", buffer(mime()));
  const bridge = { ...testInstallation,  ...desktop, MATE_RUNTIME_SERVICE_TOKEN: "bridge-secret" };
  const invoke = (name, args, extra = {}) => handleWorkspaceMcpWorkerRequest(new Request(`https://mcp.example.invalid/internal/runtime/workspace-pass/tools/${name}`, {
    method: "POST", headers: { authorization: "Bearer bridge-secret", "content-type": "application/json",
      "x-workspace-runtime-user-id": "user-1", "x-workspace-runtime-org-id": "org-1", "x-workspace-runtime-mate-id": "ada", ...extra }, body: JSON.stringify(args)
  }), bridge);
  const read = await invoke("mail_get", { messageId: id });
  assert.equal(read.status, 200, await read.clone().text());
  assert.equal((await read.json()).message.id, id);
  assert.equal((await invoke("mail_get", { messageId: id }, { "x-workspace-runtime-mate-id": "public" })).status, 403);
  assert.equal((await invoke("mail_get", { messageId: id }, { "x-workspace-runtime-mate-id": "" })).status, 403);
  const update = { messageId: id, expectedVersion: 1, read: true };
  assert.equal((await invoke("mail_update", update)).status, 403);
  assert.equal((await invoke("mail_update", update, { "x-workspace-runtime-approval": "single-use-approved" })).status, 200);
  assert.equal((await call("mail_get", { messageId: id })).message.read, true);
});

test("Auth migration adds allowed scopes without changing existing grants", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE auth_mcp_clients(id TEXT, allowed_scopes_json TEXT, updated_at TEXT);
    CREATE TABLE auth_mcp_connections(id TEXT, scopes_json TEXT);
    INSERT INTO auth_mcp_clients VALUES ('workspace-ai-mcp','["workspace:apps:read"]','old'),('custom','[]','old');
    INSERT INTO auth_mcp_connections VALUES ('existing','["workspace:apps:read"]');`);
  const migration = readFileSync(new URL("../../auth/db/d1-migrations/0022_default_mailbox_scopes.sql", import.meta.url), "utf8");
  db.exec(migration); db.exec(migration);
  assert.equal(JSON.parse(db.prepare("SELECT allowed_scopes_json FROM auth_mcp_clients WHERE id='workspace-ai-mcp'").get().allowed_scopes_json).length, 3);
  assert.equal(db.prepare("SELECT allowed_scopes_json FROM auth_mcp_clients WHERE id='custom'").get().allowed_scopes_json, "[]");
  assert.equal(db.prepare("SELECT scopes_json FROM auth_mcp_connections").get().scopes_json, '["workspace:apps:read"]');
});

test("concurrent delivery leaves one complete object and preserves cross-company isolation", async () => {
  const { env, mailbox, objects, call, db } = fixture();
  const receipts = await Promise.all(Array.from({ length: 4 }, () => storeIncomingMail(env, mailbox, "sender@example.com", buffer(mime()))));
  assert.equal(new Set(receipts.map(receipt => receipt.id)).size, 1);
  assert.equal(objects.size, 5);
  await storeIncomingMail(env, { ...mailbox, orgId: "org-2", mateId: "other", address: "other@mate.example.invalid" }, "sender@example.com", buffer(mime()));
  assert.equal(db.prepare("SELECT count(*) AS n FROM mate_mail_messages").get().n, 2);
  assert.equal((await call("mail_list")).messages.length, 1);
  assert.deepEqual(await readDefaultMailbox(env, { address: "public@mate.example.invalid" }), { mailbox: null });
});

test("disabled users cannot read mail even with an otherwise valid bearer token", async () => {
  const { env, call } = fixture();
  env.AUTH_SERVICE.fetch = async () => Response.json({ error: "inactive_user" }, { status: 403 });
  await assert.rejects(call("mail_list"), /scheduled_user_resolution_failed/);
});
