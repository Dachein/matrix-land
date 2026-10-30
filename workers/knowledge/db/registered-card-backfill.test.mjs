import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationSql = readFileSync(
  new URL("./d1-migrations/0004_registered_knowledge_service_card_backfill.sql", import.meta.url),
  "utf8"
);

const expectedServices = new Map([
  ["ksvc_f92247df-5b25-45a1-bb4b-33a03419b5dd", "employee-handbook"],
  ["ksvc_d5ca22d2-8e4b-41ef-b96f-2140cd8089f4", "employee-handbook"],
  ["ksvc_dc4d3fd4-ce66-4d0b-bec9-769d3302102f", "employee-handbook"],
  ["ksvc_d8df3b3d-5c0f-4b14-969d-d85bcd2954d6", "private-banking"],
  ["ksvc_ff9fd96f-9f0f-484f-ba10-c039041be27b", "platform-help"],
  ["ksvc_951e1bb5-4bcc-42d5-879c-2d051f9cc0b9", "company-policy"]
]);

test("registered knowledge service cards are complete and the backfill is repeatable", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE knowledge_services (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE knowledge_service_profiles (
        service_id TEXT PRIMARY KEY REFERENCES knowledge_services(id) ON DELETE CASCADE,
        category TEXT NOT NULL DEFAULT 'general',
        tags_json TEXT NOT NULL DEFAULT '[]',
        languages_json TEXT NOT NULL DEFAULT '[]',
        coverage_json TEXT NOT NULL DEFAULT '[]',
        not_for_json TEXT NOT NULL DEFAULT '[]',
        feedback_enabled INTEGER NOT NULL DEFAULT 1,
        feedback_policy_json TEXT NOT NULL DEFAULT '{}',
        maintenance_team TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const insertService = database.prepare(
      "INSERT INTO knowledge_services (id, description) VALUES (?, 'Read-only Knowledge Service.')"
    );
    for (const serviceId of expectedServices.keys()) insertService.run(serviceId);
    insertService.run("ksvc_unrelated");

    database.exec(migrationSql);
    database.exec(migrationSql);

    const rows = database.prepare(`
      SELECT service.id, service.description, profile.category, profile.tags_json,
             profile.languages_json, profile.coverage_json, profile.not_for_json,
             profile.maintenance_team
      FROM knowledge_services AS service
      JOIN knowledge_service_profiles AS profile ON profile.service_id = service.id
      ORDER BY service.id
    `).all();
    assert.equal(rows.length, expectedServices.size);

    for (const row of rows) {
      assert.equal(row.category, expectedServices.get(row.id));
      assert.doesNotMatch(row.description, /Read-only Knowledge Service/);
      assert.ok(row.description.length > 30);
      assert.ok(JSON.parse(row.tags_json).length >= 8);
      assert.ok(JSON.parse(row.languages_json).length >= 1);
      assert.ok(JSON.parse(row.coverage_json).length >= 4);
      assert.ok(JSON.parse(row.not_for_json).length >= 3);
      assert.ok(row.maintenance_team.length > 0);
    }

    assert.deepEqual(
      { ...database.prepare(
        "SELECT description FROM knowledge_services WHERE id = 'ksvc_unrelated'"
      ).get() },
      { description: "Read-only Knowledge Service." }
    );
  } finally {
    database.close();
  }
});

test("card backfill is safe when production registrations are absent", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE knowledge_services (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE knowledge_service_profiles (
        service_id TEXT PRIMARY KEY REFERENCES knowledge_services(id) ON DELETE CASCADE,
        category TEXT NOT NULL DEFAULT 'general',
        tags_json TEXT NOT NULL DEFAULT '[]',
        languages_json TEXT NOT NULL DEFAULT '[]',
        coverage_json TEXT NOT NULL DEFAULT '[]',
        not_for_json TEXT NOT NULL DEFAULT '[]',
        feedback_enabled INTEGER NOT NULL DEFAULT 1,
        feedback_policy_json TEXT NOT NULL DEFAULT '{}',
        maintenance_team TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    assert.doesNotThrow(() => database.exec(migrationSql));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM knowledge_service_profiles").get().count, 0);
  } finally {
    database.close();
  }
});
