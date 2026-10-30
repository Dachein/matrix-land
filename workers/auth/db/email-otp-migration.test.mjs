import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";

const platformEmail = "ai-adoption@example.invalid";

it("creates the OTP challenge schema and upserts the platform mailbox idempotently", () => {
  const database = new DatabaseSync(":memory:");
  const schema = readFileSync("workers/auth/db/schema.sql", "utf8");
  const migration = readFileSync(
    "workers/auth/db/migrations/20260715_email_otp.sql",
    "utf8"
  );

  database.exec(schema);
  database.exec("DROP TABLE auth_email_otp_challenges");
  database.exec(migration);
  database.exec(migration);

  const columns = database
    .prepare("PRAGMA table_info(auth_email_otp_challenges)")
    .all()
    .map((column) => column.name);
  assert.deepEqual(columns, [
    "id",
    "user_id",
    "email_hash",
    "ip_hash",
    "state_hash",
    "code_hash",
    "status",
    "attempt_count",
    "max_attempts",
    "expires_at",
    "consumed_at",
    "consume_nonce",
    "provider_message_id",
    "request_id",
    "redirect_path",
    "created_at",
    "updated_at"
  ]);
  const indexes = database
    .prepare("PRAGMA index_list(auth_email_otp_challenges)")
    .all()
    .map((index) => index.name);
  assert.ok(indexes.includes("idx_auth_email_otp_email_created"));
  assert.ok(indexes.includes("idx_auth_email_otp_ip_created"));
  assert.ok(indexes.includes("idx_auth_email_otp_expires"));

  const platformUser = readPlatformUser(database);
  assert.equal(platformUser.status, "active");
  assert.equal(platformUser.role, "member");
  assert.equal(platformUser.provider, "microsoft_entra_id");
  assert.equal(platformUser.provider_subject, "3634bd9b-137f-41f8-9a3c-20e8914c0c84");
  assert.equal(
    database.prepare("SELECT count(*) AS total FROM auth_users WHERE lower(email) = lower(?)").get(platformEmail).total,
    1
  );
  assert.equal(
    database.prepare(`
      SELECT count(*) AS total
      FROM auth_user_memberships
      WHERE user_id = ? AND target_type = 'department' AND target_id = 'dept-ai-adoption-zwlqiw'
    `).get(platformUser.id).total,
    1
  );
});

it("does not revive a suspended platform mailbox or overwrite its canonical role", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/auth/db/schema.sql", "utf8"));
  const migration = readFileSync(
    "workers/auth/db/migrations/20260715_email_otp.sql",
    "utf8"
  );
  database.exec(migration);
  database.prepare("UPDATE auth_users SET role = 'admin', status = 'suspended' WHERE email = ?").run(platformEmail);
  database.exec(migration);

  const platformUser = readPlatformUser(database);
  assert.equal(platformUser.status, "suspended");
  assert.equal(platformUser.role, "admin");
});

it("adds an optional authorize return target to existing OTP challenges", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/auth/db/schema.sql", "utf8"));
  database.exec("DROP TABLE auth_email_otp_challenges");
  database.exec(readFileSync("workers/auth/db/migrations/20260715_email_otp.sql", "utf8"));
  database.exec(readFileSync(
    "workers/auth/db/d1-migrations/0011_email_otp_return_to.sql",
    "utf8"
  ));

  const columns = database
    .prepare("PRAGMA table_info(auth_email_otp_challenges)")
    .all()
    .map((column) => column.name);
  assert.ok(columns.includes("return_to"));
});

function readPlatformUser(database) {
  return database
    .prepare(`
      SELECT id, status, role, provider, provider_subject
      FROM auth_users
      WHERE lower(email) = lower(?)
      LIMIT 1
    `)
    .get(platformEmail);
}


it("fresh Auth schema has an empty allowlist and no pre-created employees", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/auth/db/schema.sql", "utf8"));
  const policy = database.prepare("SELECT mode, allowed_domains_json FROM auth_login_email_policy WHERE id=1").get();
  assert.equal(policy.mode, "company_email_only");
  assert.deepEqual(JSON.parse(policy.allowed_domains_json), []);
  assert.equal(database.prepare("SELECT count(*) AS count FROM auth_users").get().count, 0);
});
it("enrollment migration preserves existing challenges and users", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/auth/db/schema.sql", "utf8").replace("  recipient_ciphertext TEXT,\n", ""));
  database.exec("INSERT INTO auth_users(id,email,role,status) VALUES ('u','person@example.test','admin','suspended')");
  database.exec(readFileSync("workers/auth/db/d1-migrations/0024_email_otp_enrollment.sql", "utf8"));
  assert.ok(database.prepare("PRAGMA table_info(auth_email_otp_challenges)").all().some(column => column.name === "recipient_ciphertext"));
  assert.deepEqual({...database.prepare("SELECT role,status FROM auth_users WHERE id='u'").get()}, {role:"admin",status:"suspended"});
});
