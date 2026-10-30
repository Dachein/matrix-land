import { testInstallation } from "../../../tests/helpers/installation.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { receiveMail as handleMateEmail, mailFetch } from "../../mail/src/worker.ts";
import { routeMailRequest } from "./mailRoutes.ts";
import { storeIncomingMail } from "../../mail/src/mailbox.ts";
import { readDefaultMailbox } from "../../apps/src/mates/mailbox.ts";
import { callPublicMcpTool, mcpTools } from "../../mcp/src/tools.ts";
import { signJwt } from "../../mcp/src/auth.ts";
import { runtimeWorkspacePassToolDefinitions } from "../../mcp/src/runtimeWorkspacePassTools.ts";
import { handleWorkspaceMcpWorkerRequest } from "../../mcp/src/worker.ts";
class D1 {
  constructor(db) { this.db = db; }
  async batch(statements) { return Promise.all(statements.map(s=>s.run())); }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    const statement = (args = []) => ({ bind: (...values) => statement(values),
      async first() { return stmt.get(...args) || null; }, async all() { return { results: stmt.all(...args) }; },
      async run() { return { meta: { changes: Number(stmt.run(...args).changes) } }; } });
    return statement();
  }
}

export function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../db/migrations/0011_default_mailbox.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../db/migrations/0012_workspace_mail_service.sql", import.meta.url),"utf8"));
  db.exec(readFileSync(new URL("../db/migrations/0013_app_mail_trigger.sql", import.meta.url),"utf8"));
  db.exec(`CREATE TABLE apps_mates (id TEXT, org_id TEXT, owner_user_id TEXT, work_email TEXT, is_default INTEGER, status TEXT, active_release_id TEXT, display_name TEXT DEFAULT 'Mate');
    INSERT INTO apps_mates (id,org_id,owner_user_id,work_email,is_default,status,active_release_id) VALUES ('ada','org-1','user-1','ada@mate.example.invalid',1,'published','r1'),
      ('bob','org-1','user-2','bob@mate.example.invalid',1,'published','r2'),
      ('other','org-2','user-1','other@mate.example.invalid',1,'published','r3'),
      ('public','org-1','user-1','public@mate.example.invalid',0,'published','r4');`);
  db.exec("INSERT INTO workspace_mail_mailboxes(mate_id,org_id,user_id,address,display_name,is_default,status) SELECT id,org_id,owner_user_id,work_email,display_name,is_default,'ready' FROM apps_mates");
  const objects = new Map();
  const env = { ...testInstallation,
    WORKSPACE_MAIL_SECRET:"test-workspace-mail-secret-longer-than-32-characters",
    RUNTIME_DB: new D1(db), APPS_DB: new D1(db), MAIL_OBJECTS: {
      async put(key, value) { objects.set(key, value); }, async delete(keys) { for(const key of Array.isArray(keys)?keys:[keys])objects.delete(key); },
      async get(key) { return objects.has(key) ? { async json() { return JSON.parse(objects.get(key)); },async text(){ return String(objects.get(key)); },async arrayBuffer(){ const value=objects.get(key); return typeof value==='string'?new TextEncoder().encode(value).buffer:Uint8Array.from(new Uint8Array(value)).buffer; } } : null; }
    },
    MATE_RUNTIME_JWT_SECRET: "mail-test-runtime-jwt-secret-more-than-32-characters",
    MATE_PREVIEW_JWT_SECRET: "mail-test-preview-jwt-secret-more-than-32-characters",
    MATE_RUNTIME_SERVICE_TOKEN: "service-token", MATE_AUTH_SERVICE_TOKEN: "auth-service-token",
    AUTH_SERVICE: { async fetch(request) {
      assert.equal(request.headers.get("authorization"), "Bearer auth-service-token");
      const { userId } = await request.json();
      assert.ok(userId, "Ingress resolves the recipient owner, never the external sender");
      return Response.json({ orgId: "org-1", user: { id: userId, status: "active" } });
    } },
    APPS_CONTROL_PLANE: { async fetch(request) {
      assert.equal(request.headers.get("authorization"), "Bearer service-token");
      const url = new URL(request.url);
      assert.equal(url.pathname, "/internal/runtime/default-mailbox");
      return Response.json(await readDefaultMailbox(env, url.searchParams.has("address")
        ? { address: url.searchParams.get("address") }
        : { principal: { sub: request.headers.get("x-workspace-runtime-user-id"), orgId: request.headers.get("x-workspace-runtime-org-id") } }));
    } }
  };
  env.WORKSPACE_MAIL={fetch:request=>mailFetch(request,env)};
  const desktop = { ...testInstallation, MATE_RUNTIME_JWT_SECRET: env.MATE_RUNTIME_JWT_SECRET,
    MATE_RUNTIME: { async fetch(request) { try { return await routeMailRequest(request, env); }
      catch (error) { return Response.json({ error: error.code }, { status: error.status || 500 }); } } } };
  const principal = { sub: "user-1", orgId: "org-1", scopes: ["workspace:mail:read", "workspace:mail:write"] };
  const call = (name, args = {}, identity = principal) => callPublicMcpTool(name, args, desktop, identity);
  const mailbox = { mateId: "ada", userId: "user-1", orgId: "org-1", address: "ada@mate.example.invalid" };
  return { db, env, desktop, principal, mailbox, call, objects };
}

export function mime(subject = "Hotel invoice", text = "Please find the invoice.") {
  return `From: invoices@hotel.example\r\nTo: ada@mate.example.invalid\r\nSubject: ${subject}\r\nMessage-ID: <invoice-1@hotel.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="invoice"\r\n\r\n--invoice\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n--invoice\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="invoice.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from("%PDF-test-invoice\n").toString("base64")}\r\n--invoice--\r\n`;
}
