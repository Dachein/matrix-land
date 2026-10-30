import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { resolveMokaDirectoryUser } from "../../workers/auth/src/mokaDirectory.ts";

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

function authDb() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/auth/db/schema.sql", "utf8"));
  database.prepare("UPDATE auth_login_email_policy SET allowed_domains_json = ? WHERE id = 1")
    .run(JSON.stringify(["example.test"]));
  return new D1Adapter(database);
}

function user(overrides = {}) {
  return {
    email: "Person@Example.Test",
    id: "workspace-user-1",
    name: "Old Name",
    role: "admin",
    ...overrides
  };
}

describe("Moka-backed Workspace Auth directory", () => {
  it("uses normalized work email as the only lookup key and preserves Workspace identity", async () => {
    let request;
    const resolved = await resolveMokaDirectoryUser({
      AUTH_DB: authDb(),
      MOKA_CONNECTOR_SERVICE_TOKEN: "connector-token",
      MOKA_DIRECTORY_ENABLED: "1",
      MOKA_CONNECTOR: {
        async fetch(input, init) {
          request = { input, init };
          if (String(input).endsWith("/v1/directory/departments")) {
            return new Response(JSON.stringify({
              departments: [{
                active: true,
                externalId: "department-100",
                name: "AI Adoption",
                path: ["AI Adoption"]
              }]
            }));
          }
          return new Response(JSON.stringify({
            employee: {
              active: true,
              department: "AI Adoption",
              departmentExternalId: "department-100",
              email: "person@example.test",
              externalId: "employee-100",
              jobTitle: "Engineer",
              name: "Moka Name",
              source: "moka"
            }
          }));
        }
      }
    }, user());

    assert.equal(resolved.department, "AI Adoption");
    assert.match(resolved.departmentId, /^dept-/);
    assert.deepEqual(resolved.departmentPath, [resolved.departmentId]);
    assert.deepEqual({ ...resolved, departmentId: undefined, departmentPath: undefined }, {
      department: "AI Adoption",
      departmentId: undefined,
      departmentPath: undefined,
      email: "person@example.test",
      id: "workspace-user-1",
      jobTitle: "Engineer",
      name: "Moka Name",
      role: "admin",
      source: "moka",
      status: "active"
    });
  });

  it("fails closed for missing, inactive, conflicting, or mismatched employees", async () => {
    const withResponse = (status, payload) => ({
      AUTH_DB: authDb(),
      MOKA_CONNECTOR_SERVICE_TOKEN: "connector-token",
      MOKA_DIRECTORY_ENABLED: "1",
      MOKA_CONNECTOR: { async fetch() { return new Response(JSON.stringify(payload), { status }); } }
    });

    await assert.rejects(
      resolveMokaDirectoryUser(withResponse(404, { error: "moka_employee_not_found" }), user()),
      { status: 403, code: "moka_employee_not_found" }
    );
    await assert.rejects(
      resolveMokaDirectoryUser(withResponse(409, { error: "moka_employee_email_conflict" }), user()),
      { status: 409, code: "moka_employee_email_conflict" }
    );
    await assert.rejects(
      resolveMokaDirectoryUser(withResponse(200, { employee: { active: false, email: "person@example.test" } }), user()),
      { status: 403, code: "moka_employee_inactive" }
    );
    await assert.rejects(
      resolveMokaDirectoryUser(withResponse(200, { employee: { active: true, email: "other@example.test" } }), user()),
      { status: 502, code: "moka_employee_email_mismatch" }
    );
  });

  it("is a no-op while the controlled rollout flag is disabled", async () => {
    const original = user();
    assert.equal(await resolveMokaDirectoryUser({}, original), original);
  });
});
