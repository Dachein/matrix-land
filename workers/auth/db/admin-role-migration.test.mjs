import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

const portalMigration = readFileSync(
  "db/migrations/20260726_normalize_platform_admin_role.sql",
  "utf8"
);
const authMigration = readFileSync(
  "workers/auth/db/migrations/20260726_normalize_platform_admin_role.sql",
  "utf8"
);
const retiredRole = ["portal", "admin"].join("_");

describe("canonical Platform Admin migrations", () => {
  it("normalizes the Portal user role idempotently", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'member',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO users (id, role) VALUES
        ('admin', 'admin'),
        ('member', 'member');
    `);
    database
      .prepare("INSERT INTO users (id, role) VALUES (?, ?)")
      .run("legacy-admin", retiredRole);

    database.exec(portalMigration);
    database.exec(portalMigration);

    assert.deepEqual(readRoles(database, "users"), [
      ["admin", "admin"],
      ["legacy-admin", "admin"],
      ["member", "member"]
    ]);
    database.close();
  });

  it("normalizes the Auth directory role idempotently", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE auth_users (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'member',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO auth_users (id, role) VALUES
        ('admin', 'admin'),
        ('member', 'member');
    `);
    database
      .prepare("INSERT INTO auth_users (id, role) VALUES (?, ?)")
      .run("legacy-admin", retiredRole);

    database.exec(authMigration);
    database.exec(authMigration);

    assert.deepEqual(readRoles(database, "auth_users"), [
      ["admin", "admin"],
      ["legacy-admin", "admin"],
      ["member", "member"]
    ]);
    database.close();
  });
});

function readRoles(database, table) {
  return database
    .prepare(`SELECT id, role FROM ${table} ORDER BY id`)
    .all()
    .map((row) => [row.id, row.role]);
}
