import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { deliverUserInvitations, queueUserInvitation } from "../../workers/auth/src/invitationEmail.ts";
import { renderInvitationEmail } from "../../workers/auth/src/invitationTemplate.ts";
import { upsertAuthUserSnapshot } from "../../workers/auth/src/repository.ts";
import worker from "../../workers/auth/src/index.ts";

function fixture(send) {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/auth/db/schema.sql", "utf8"));
  database.prepare("UPDATE auth_login_email_policy SET allowed_domains_json = ? WHERE id = 1").run(JSON.stringify(["partner.example.test", "example.invalid"]));
  const messages = [];
  const env = {
    AUTH_SERVICE_TOKEN: "invitation-test-service-token",
    EMAIL_OTP_FROM: "no-reply@example.com",
    PORTAL_URL: "https://work.example.com",
    AUTH_INVITATION_EMAIL_ENABLED: "1",
    AUTH_EMAIL: { async send(message) { messages.push(message); return send ? send(message) : { messageId: "provider-1" }; } },
    AUTH_DB: { prepare(sql) {
      const statement = database.prepare(sql);
      const make = (values = []) => ({
        bind(...params) { return make(params); },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { statement.run(...values); return { success: true }; }
      });
      return make();
    } }
  };
  function insert(id, status = "invited", email = `${id}@partner.example.test`) {
    database.prepare("INSERT INTO auth_users(id,email,name,status) VALUES (?,?,?,?)").run(id,email,id,status);
  }
  const record = id => database.prepare("SELECT * FROM auth_user_invitation_emails WHERE user_id=?").get(id);
  return { database, env, messages, insert, record };
}

test("invited creation queues once; repeated sync and repeated backfill send once", async () => {
  const f = fixture();
  f.insert("new");
  assert.equal(f.record("new").status, "pending");
  await deliverUserInvitations(f.env);
  f.database.prepare("UPDATE auth_users SET status='invited',name='Updated' WHERE id='new'").run();
  await queueUserInvitation(f.env, "new");
  await deliverUserInvitations(f.env);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].to, "new@partner.example.test");
  assert.equal(f.record("new").status, "sent");
  assert.equal(f.record("new").message_id, "provider-1");
});

test("empty email and inactive do not queue; filling email and transitioning to invited does", async () => {
  const f = fixture();
  f.insert("consultant", "inactive", "");
  f.insert("empty-invited", "invited", "");
  assert.equal(f.record("consultant"), undefined);
  assert.equal(f.record("empty-invited"), undefined);
  f.database.prepare("UPDATE auth_users SET status='invited',email='consultant@partner.example.test' WHERE id='consultant'").run();
  f.database.prepare("UPDATE auth_users SET email='filled@partner.example.test' WHERE id='empty-invited'").run();
  await deliverUserInvitations(f.env);
  assert.equal(f.messages.length, 2);
});

test("parallel sends and later invitation transitions still have a single persistent claim", async () => {
  const f = fixture(); f.insert("parallel");
  await Promise.all([deliverUserInvitations(f.env), deliverUserInvitations(f.env)]);
  f.database.prepare("UPDATE auth_users SET status='inactive' WHERE id='parallel'").run();
  f.database.prepare("UPDATE auth_users SET status='invited' WHERE id='parallel'").run();
  await deliverUserInvitations(f.env);
  assert.equal(f.messages.length, 1);
});

test("cancel queued invitations after account deactivation or with a disallowed mailbox", async () => {
  const f = fixture(); f.insert("disabled"); f.insert("personal", "invited", "person@gmail.com");
  f.database.prepare("UPDATE auth_users SET status='inactive' WHERE id='disabled'").run();
  await deliverUserInvitations(f.env);
  assert.equal(f.messages.length, 0);
  assert.equal(f.record("disabled").status, "cancelled");
  assert.equal(f.record("personal").status, "cancelled");
});

test("ambiguous provider errors are recorded without repeated sending", async () => {
  const f = fixture(() => { throw Error("timeout after provider may have accepted"); }); f.insert("timeout");
  await deliverUserInvitations(f.env); await deliverUserInvitations(f.env);
  assert.equal(f.messages.length, 1);
  assert.equal(f.record("timeout").status, "uncertain");
});

test("explicit provider rejection is visible as failed", async () => {
  const f = fixture(() => ({ status: "failed" })); f.insert("rejected");
  await deliverUserInvitations(f.env);
  assert.equal(f.record("rejected").status, "failed");
});

test("repository creation sends immediately and delivery failure does not undo the account", async () => {
  const f = fixture();
  await upsertAuthUserSnapshot(f.env,{id:"repository-user",email:"new@partner.example.test",name:"New User",status:"invited"});
  assert.equal(f.messages.length, 1);
  const failed = fixture(() => { throw Error("offline"); });
  await upsertAuthUserSnapshot(failed.env,{id:"repository-user",email:"new@partner.example.test",name:"New User",status:"invited"});
  assert.equal(failed.database.prepare("SELECT status FROM auth_users WHERE id='repository-user'").get().status,"invited");
  assert.equal(failed.record("repository-user").status, "uncertain");
});

test("HTML escapes employee data and uses the configured installation", () => {
  const html = renderInvitationEmail('<script>alert(1)</script>', "person@example.com", "https://work.example.com").html;
  assert.ok(!html.includes("<script>")); assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes('href="https://work.example.com/"'));
  assert.match(html, /Frontier Workspace/);
  assert.doesNotMatch(html, /https:\/\/ai\.example\.invalid/);
});

test("targeted invitation API requires service authorization and only sends specified users", async () => {
  const f = fixture(); f.insert("first"); f.insert("other");
  const request = token => new Request("https://auth.example.invalid/v1/admin/users/invitations", {method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({userIds:["first"]})});
  assert.equal((await worker.fetch(request("wrong"), f.env, {})).status,401);
  const response = await worker.fetch(request(f.env.AUTH_SERVICE_TOKEN), f.env, {});
  assert.equal(response.status,200);
  assert.equal((await response.json()).invitations[0].status,"sent");
  assert.equal(f.record("other").status,"pending");
  await worker.fetch(request(f.env.AUTH_SERVICE_TOKEN), f.env, {});
  assert.equal(f.messages.length,1);
});

test("migration does not queue old invited accounts before explicit backfill", () => {
  const database = new DatabaseSync(":memory:");
  const schema = readFileSync("workers/auth/db/schema.sql", "utf8").split("CREATE TABLE IF NOT EXISTS auth_user_invitation_emails")[0];
  database.exec(schema);
  database.exec("INSERT INTO auth_users(id,email,status) VALUES('old','old@partner.example.test','invited');");
  database.exec(readFileSync("workers/auth/db/d1-migrations/0018_user_invitation_email.sql","utf8"));
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM auth_user_invitation_emails").get().n,0);
});
