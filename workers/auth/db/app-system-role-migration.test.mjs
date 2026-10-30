import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";

const migration = readFileSync(
  "workers/auth/db/d1-migrations/0007_app_system_role_inheritance.sql",
  "utf8",
);

it("adds live App system-role projection fields with safe defaults", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE auth_app_clients (id TEXT PRIMARY KEY);
    CREATE TABLE auth_resource_clients (id TEXT PRIMARY KEY);
  `);

  database.exec(migration);

  assert.deepEqual(readAddedColumns(database, "auth_app_clients"), [
    ["collaborator_user_ids_json", "TEXT", "'[]'"],
    ["system_role_policy_version", "TEXT", "''"],
  ]);
  assert.deepEqual(readAddedColumns(database, "auth_resource_clients"), [
    ["collaborator_user_ids_json", "TEXT", "'[]'"],
    ["system_role_policy_version", "TEXT", "''"],
  ]);

  database.exec(`
    INSERT INTO auth_app_clients (id) VALUES ('app-1');
    INSERT INTO auth_resource_clients (id) VALUES ('resource-1');
  `);
  assert.deepEqual(
    { ...database.prepare(`
      SELECT collaborator_user_ids_json, system_role_policy_version
      FROM auth_app_clients
      WHERE id = 'app-1'
    `).get() },
    { collaborator_user_ids_json: "[]", system_role_policy_version: "" },
  );
  assert.deepEqual(
    { ...database.prepare(`
      SELECT collaborator_user_ids_json, system_role_policy_version
      FROM auth_resource_clients
      WHERE id = 'resource-1'
    `).get() },
    { collaborator_user_ids_json: "[]", system_role_policy_version: "" },
  );
});

function readAddedColumns(database, table) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .filter((column) => column.name !== "id")
    .map((column) => [column.name, column.type, column.dflt_value]);
}
