import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  processMokaDirectoryEvent,
  resolveMokaLoginUser,
  runScheduledMokaDirectorySync,
  syncMokaEmployees
} from "../../workers/auth/src/mokaSync.ts";

class D1Adapter {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1StatementAdapter(this.database.prepare(sql)); }
  async batch(statements) {
    const results = [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class D1StatementAdapter {
  constructor(statement, params = []) { this.params = params; this.statement = statement; }
  bind(...params) { return new D1StatementAdapter(this.statement, params); }
  async all() { return { results: this.statement.all(...this.params), success: true }; }
  async first() { return this.statement.get(...this.params) ?? null; }
  async run() { this.statement.run(...this.params); return { success: true }; }
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/auth/db/schema.sql", "utf8"));
  const calls = [];
  const departments = [{
    active: true,
    externalId: "1365705",
    name: "Insurance",
    parentExternalId: "1360702",
    path: ["Workspace Wealth Group Limited", "To C", "Insurance"]
  }, {
    active: true,
    externalId: "1360702",
    name: "Workspace Wealth Group Limited",
    path: ["Workspace Wealth Group Limited"]
  }];
  const employees = [{
    active: true,
    department: "To C/Insurance",
    departmentExternalId: "1365705",
    email: "person@example.test",
    externalId: "1731630",
    jobTitle: "Advisor",
    name: "Moka Person",
    path: ["Workspace Wealth Group Limited", "To C", "Insurance"]
  }];
  const env = {
    AUTH_DB: new D1Adapter(database),
    MOKA_CONNECTOR_SERVICE_TOKEN: "connector-token",
    MOKA_DIRECTORY_ENABLED: "1",
    MOKA_CONNECTOR: {
      async fetch(input, init) {
        const path = new URL(String(input)).pathname;
        calls.push({ body: JSON.parse(init.body), path });
        if (path === "/v1/directory/departments") return Response.json({ departments });
        if (path === "/v1/directory/employees") {
          const domains = JSON.parse(database.prepare("SELECT allowed_domains_json FROM auth_login_email_policy WHERE id = 1").get().allowed_domains_json);
          const eligible = employees.filter((employee) => (employee.active && !employee.email) || domains.includes(employee.email.split("@").at(-1).toLowerCase()));
          return Response.json({ employees: eligible, filteredCount: employees.length - eligible.length });
        }
        if (path === "/v1/employees/by-email" || path === "/v1/employees/by-id") {
          return Response.json({ employee: employees[0] });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      }
    }
  };
  database.prepare("UPDATE auth_login_email_policy SET allowed_domains_json = ? WHERE id = 1")
    .run(JSON.stringify(["example.test", "example.invalid", "partner.example.test"]));
  return { calls, database, departments, employees, env };
}

describe("Moka directory synchronization", () => {
  it("uses the shared login email policy before looking up a Moka employee", async () => {
    const { calls, env } = fixture();

    await assert.rejects(
      () => resolveMokaLoginUser(env, { email: "person@gmail.com", id: "user-1", role: "member" }),
      (error) => error.code === "company_email_required"
    );
    assert.equal(calls.length, 0);
  });

  it("skips Moka lookup only for an exact configured login exemption", async () => {
    const { calls, database, env } = fixture();
    database.prepare(`
      INSERT INTO auth_moka_validation_exemptions (email, skip_validation, reason)
      VALUES ('person@example.test', 1, 'approved temporary login exception')
    `).run();
    const input = { email: "PERSON@EXAMPLE.TEST", id: "existing-user", role: "admin" };

    const result = await resolveMokaLoginUser(env, input);

    assert.equal(result.validationSkipped, true);
    assert.equal(result.externalId, undefined);
    assert.equal(result.user, input);
    assert.equal(calls.length, 0);
  });

  it("synchronously refreshes departments when login encounters an unknown department", async () => {
    const { calls, env } = fixture();
    const result = await resolveMokaLoginUser(env, {
      email: "PERSON@example.test",
      id: "existing-user",
      role: "admin"
    });

    assert.equal(result.externalId, "1731630");
    assert.equal(result.user.email, "person@example.test");
    assert.equal(result.user.department, "Insurance");
    assert.match(result.user.departmentId, /^dept-/);
    assert.equal(calls.filter((call) => call.path === "/v1/directory/departments").length, 1);
  });

  it("runs departments before employees and preserves an existing internal user id and role", async () => {
    const { database, env } = fixture();
    database.prepare(`
      INSERT INTO auth_users (
        id, email, name, role, status, department_name, department_path_json,
        team_name, team_path_json, source, first_seen_at, last_seen_at, updated_at
      ) VALUES ('workspace-user-1', 'person@example.test', 'Old Name', 'admin', 'active', '', '[]', '', '[]', 'portal', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    const result = await runScheduledMokaDirectorySync(env);
    const user = database.prepare("SELECT id, email, name, role, status, department_id FROM auth_users WHERE id = 'workspace-user-1'").get();
    const source = database.prepare("SELECT external_id, user_id, canonical_email FROM auth_user_sources WHERE source = 'moka'").get();

    assert.equal(result.departments.seen, 2);
    assert.equal(result.employees.seen, 1);
    assert.deepEqual({ ...user }, {
      department_id: user.department_id,
      email: "person@example.test",
      id: "workspace-user-1",
      name: "Moka Person",
      role: "admin",
      status: "active"
    });
    assert.match(user.department_id, /^dept-/);
    assert.deepEqual({ ...source }, {
      canonical_email: "person@example.test",
      external_id: "1731630",
      user_id: "workspace-user-1"
    });
  });

  it("filters non-company email employees and deactivates any previously linked Workspace user", async () => {
    const { database, employees, env } = fixture();
    database.prepare(`
      INSERT INTO auth_users (
        id, email, name, role, status, department_name, department_path_json,
        team_name, team_path_json, source, first_seen_at, last_seen_at, updated_at
      ) VALUES ('legacy-google-user', 'old@legacy.example', 'Legacy', 'member', 'active', '', '[]', '', '[]', 'moka', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();
    database.prepare(`
      INSERT INTO auth_user_sources (source, external_id, user_id, canonical_email)
      VALUES ('moka', 'legacy-google-id', 'legacy-google-user', 'old@legacy.example')
    `).run();
    employees.push(
      { ...employees[0], email: "colleague@partner.example.test", externalId: "partner-employee" },
      { ...employees[0], email: "qa@gmail.com", externalId: "test-account" },
      { ...employees[0], email: "new@personal.example", externalId: "new-non-company" },
      { ...employees[0], email: "old@legacy.example", externalId: "legacy-google-id" }
    );

    const result = await syncMokaEmployees(env, "scheduled");

    assert.equal(result.seen, 5);
    assert.equal(result.updated, 2);
    assert.equal(result.skipped, 3);
    assert.equal(database.prepare("SELECT email FROM auth_users WHERE email = 'colleague@partner.example.test'").get().email, "colleague@partner.example.test");
    assert.equal(database.prepare("SELECT id FROM auth_users WHERE email = 'qa@gmail.com'").get(), undefined);
    assert.equal(database.prepare("SELECT id FROM auth_users WHERE email = 'new@personal.example'").get(), undefined);
    assert.equal(database.prepare("SELECT status FROM auth_users WHERE id = 'legacy-google-user'").get().status, "inactive");
    assert.equal(database.prepare("SELECT source_status FROM auth_user_sources WHERE external_id = 'legacy-google-id'").get().source_status, "inactive");
  });

  it("preserves partial failure counts and records the employee error without deactivating unseen users", async () => {
    const { database, employees, env } = fixture();
    await runScheduledMokaDirectorySync(env);
    database.prepare("INSERT INTO auth_users (id, email) VALUES ('missing-user', 'missing@example.test')").run();
    database.prepare(`INSERT INTO auth_user_sources (source, external_id, user_id, canonical_email)
      VALUES ('moka', 'missing-employee', 'missing-user', 'missing@example.test')`).run();
    employees.push({ ...employees[0], email: "broken@example.test", externalId: "broken-employee", departmentExternalId: undefined });

    await assert.rejects(syncMokaEmployees(env, "scheduled"), { code: "moka_employee_sync_partial_failure" });

    const run = database.prepare("SELECT * FROM auth_directory_sync_runs WHERE status = 'failed'").get();
    assert.equal(run.seen_count, 2);
    assert.equal(run.updated_count, 1);
    assert.equal(run.skipped_count, 0);
    assert.equal(run.error_count, 1);
    assert.equal(run.error_code, "moka_employee_sync_partial_failure");
    const audit = database.prepare("SELECT * FROM auth_audit_events WHERE action = 'moka_employee_sync_failed'").get();
    assert.equal(audit.resource_id, "broken-employee");
    assert.equal(audit.reason, "moka_department_unresolved");
    assert.equal(JSON.parse(audit.metadata_json).runId, run.id);
    assert.equal(database.prepare("SELECT status FROM auth_users WHERE id = 'missing-user'").get().status, "active");
  });

  it("syncs over 100 employees and departments within D1's bound variable limit", async () => {
    const { database, departments, employees, env } = fixture();
    for (let i = 0; i < 120; i += 1) {
      departments.push({ ...departments[0], externalId: `department-${i}`, name: `Department ${i}` });
      employees.push({ ...employees[0], email: `person-${i}@example.test`, externalId: `employee-${i}`, departmentExternalId: `department-${i}` });
    }
    database.prepare("INSERT INTO auth_users (id, email) VALUES ('missing-user', 'missing@example.test')").run();
    database.prepare(`INSERT INTO auth_user_sources (source, external_id, user_id, canonical_email)
      VALUES ('moka', 'missing-employee', 'missing-user', 'missing@example.test')`).run();
    const adapter = env.AUTH_DB;
    env.AUTH_DB = {
      prepare(sql) {
        const statement = adapter.prepare(sql);
        const bind = statement.bind.bind(statement);
        statement.bind = (...params) => {
          assert.ok(params.length <= 100, "D1 allows at most 100 bound variables per statement");
          return bind(...params);
        };
        return statement;
      },
      batch: adapter.batch.bind(adapter)
    };

    const result = await runScheduledMokaDirectorySync(env);

    assert.equal(result.departments.updated, 122);
    assert.equal(result.employees.updated, 121);
    assert.equal(result.employees.errors, 0);
    assert.equal(database.prepare("SELECT status FROM auth_users WHERE id = 'missing-user'").get().status, "inactive");
    assert.equal(database.prepare("SELECT source_status FROM auth_user_sources WHERE external_id = 'missing-employee'").get().source_status, "inactive");
    assert.equal(database.prepare("SELECT status FROM auth_users WHERE email = 'person-119@example.test'").get().status, "invited");
  });

  it("imports an active employee as invited and leaves it invited on repeated synchronization", async () => {
    const { database, env } = fixture();
    await runScheduledMokaDirectorySync(env);
    const first = database.prepare("SELECT id, status FROM auth_users WHERE email = 'person@example.test'").get();
    assert.equal(first.status, "invited");
    await syncMokaEmployees(env, "scheduled");
    const second = database.prepare("SELECT id, status FROM auth_users WHERE email = 'person@example.test'").get();
    assert.equal(second.id, first.id);
    assert.equal(second.status, "invited");
    assert.equal(database.prepare("SELECT source_status FROM auth_user_sources WHERE user_id = ?").get(first.id).source_status, "active");
    database.prepare("UPDATE auth_users SET status = 'active' WHERE id = ?").run(first.id);
    await syncMokaEmployees(env, "scheduled");
    assert.equal(database.prepare("SELECT status FROM auth_users WHERE id = ?").get(first.id).status, "active");
  });

  it("sends the first Moka invitation immediately but does not resend during full synchronization", async () => {
    const { env } = fixture();
    const messages = [];
    env.AUTH_INVITATION_EMAIL_ENABLED = "1";
    env.AUTH_PUBLIC_URL = "https://work.example.test";
    env.EMAIL_OTP_FROM = "no-reply@example.test";
    env.AUTH_EMAIL = { async send(message) { messages.push(message); return { messageId: "moka-invite" }; } };
    await runScheduledMokaDirectorySync(env);
    await syncMokaEmployees(env, "scheduled");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, "person@example.test");
  });

  it("keeps separate empty-email employees inactive and upgrades them to invited when a mailbox is supplied", async () => {
    const { database, employees, env } = fixture();
    employees.push({ ...employees[0], email: "", externalId: "empty-one", name: "First Consultant" });
    employees.push({ ...employees[0], email: "", externalId: "empty-two", name: "Second Consultant" });
    await runScheduledMokaDirectorySync(env);
    const first = database.prepare("SELECT u.id,u.status,u.email FROM auth_users u JOIN auth_user_sources s ON s.user_id=u.id WHERE s.external_id='empty-one'").get();
    assert.equal(first.status, "inactive");
    assert.equal(first.email, "");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM auth_users WHERE email='' AND status='inactive'").get().count, 2);
    assert.equal(database.prepare("SELECT source_status FROM auth_user_sources WHERE user_id=?").get(first.id).source_status, "active");
    await syncMokaEmployees(env, "scheduled");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM auth_users WHERE email=''").get().count, 2);
    employees[1].email = "consultant@example.test";
    await syncMokaEmployees(env, "scheduled");
    assert.deepEqual({...database.prepare("SELECT id,status,email FROM auth_users WHERE id=?").get(first.id)}, {id:first.id,status:"invited",email:"consultant@example.test"});
  });

  it("does not reactivate an explicitly suspended employee account", async () => {
    const { database, env } = fixture();
    await runScheduledMokaDirectorySync(env);
    database.prepare("UPDATE auth_users SET status = 'suspended' WHERE email = 'person@example.test'").run();
    await syncMokaEmployees(env, "scheduled");
    assert.equal(database.prepare("SELECT status FROM auth_users WHERE email = 'person@example.test'").get().status, "suspended");
  });

  it("updates a linked departed employee to inactive on the scheduled sync", async () => {
    const { database, employees, env } = fixture();
    await runScheduledMokaDirectorySync(env);
    const before = database.prepare("SELECT id FROM auth_users WHERE email = 'person@example.test'").get();
    employees[0].active = false;

    const result = await syncMokaEmployees(env, "scheduled");

    assert.equal(result.errors, 0);
    assert.equal(database.prepare("SELECT status FROM auth_users WHERE id = ?").get(before.id).status, "inactive");
    assert.equal(database.prepare("SELECT source_status FROM auth_user_sources WHERE user_id = ?").get(before.id).source_status, "inactive");
  });

  it("deduplicates a successfully processed webhook by requestUniqueKey", async () => {
    const { database, env } = fixture();
    const event = {
      action: "update",
      apiCode: "employee-code",
      entityType: "employee",
      eventKey: "request-unique-1",
      receivedAt: new Date().toISOString(),
      sourceId: "1731630",
      sourceType: "1"
    };
    await processMokaDirectoryEvent(env, event);
    await processMokaDirectoryEvent(env, event);
    const row = database.prepare("SELECT status, attempt_count FROM auth_directory_events WHERE event_key = ?").get(event.eventKey);
    assert.deepEqual({ ...row }, { attempt_count: 1, status: "succeeded" });
  });
});
