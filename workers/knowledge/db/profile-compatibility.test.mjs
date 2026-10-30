import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ensureKnowledgeServiceProfileColumns,
  findMissingKnowledgeServiceProfileColumns
} from "../../../scripts/knowledge-service-profile-columns.mjs";

test("legacy Service profiles gain new registration columns without losing existing policy", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE knowledge_service_profiles (
        service_id TEXT PRIMARY KEY,
        category TEXT NOT NULL DEFAULT 'general',
        tags_json TEXT NOT NULL DEFAULT '[]',
        languages_json TEXT NOT NULL DEFAULT '[]',
        feedback_enabled INTEGER NOT NULL DEFAULT 1,
        feedback_policy_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO knowledge_service_profiles (
        service_id, category, feedback_policy_json
      ) VALUES ('service-1', 'finance', '{"mode":"moderated"}');
    `);

    assert.deepEqual(ensureKnowledgeServiceProfileColumns(database), [
      "coverage_json",
      "not_for_json",
      "maintenance_team"
    ]);
    assert.deepEqual(ensureKnowledgeServiceProfileColumns(database), []);

    assert.deepEqual(
      { ...database.prepare(
        `SELECT category, coverage_json, not_for_json, feedback_policy_json, maintenance_team
         FROM knowledge_service_profiles
         WHERE service_id = 'service-1'`
      ).get() },
      {
        category: "finance",
        coverage_json: "[]",
        feedback_policy_json: '{"mode":"moderated"}',
        maintenance_team: "",
        not_for_json: "[]"
      }
    );
  } finally {
    database.close();
  }
});

test("missing-column detection is independent of PRAGMA row order", () => {
  assert.deepEqual(
    findMissingKnowledgeServiceProfileColumns([
      { name: "not_for_json" },
      { name: "feedback_policy_json" },
      { name: "maintenance_team" },
      { name: "service_id" }
    ]).map((migration) => migration.name),
    ["coverage_json"]
  );
});

test("Query Ledger-only profiles gain the G1.5 feedback policy column", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE knowledge_service_profiles (
        service_id TEXT PRIMARY KEY,
        category TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        languages_json TEXT NOT NULL DEFAULT '[]',
        coverage_json TEXT NOT NULL DEFAULT '[]',
        not_for_json TEXT NOT NULL DEFAULT '[]',
        maintenance_team TEXT NOT NULL DEFAULT '',
        feedback_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    assert.deepEqual(ensureKnowledgeServiceProfileColumns(database), [
      "feedback_policy_json"
    ]);
    assert.equal(
      database.prepare(
        "SELECT dflt_value FROM pragma_table_info('knowledge_service_profiles') WHERE name = 'feedback_policy_json'"
      ).get().dflt_value,
      "'{}'"
    );
  } finally {
    database.close();
  }
});

test("routing Card migration is safe to retry", () => {
  const database = new DatabaseSync(":memory:");
  const migration = readFileSync(
    new URL("./d1-migrations/0005_knowledge_service_routing_card.sql", import.meta.url),
    "utf8"
  );
  try {
    database.exec(`
      CREATE TABLE knowledge_services (
        id TEXT PRIMARY KEY
      );
    `);
    database.exec(migration);
    database.exec(migration);
    assert.deepEqual(
      database.prepare(
        `SELECT name FROM pragma_table_info('knowledge_service_routing_cards') ORDER BY cid`
      ).all().map((column) => column.name),
      ["service_id", "role_text", "search_hints_json", "created_at", "updated_at"]
    );
  } finally {
    database.close();
  }
});
