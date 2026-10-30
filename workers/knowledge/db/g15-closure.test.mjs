import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("./migrations/20260730_knowledge_g15_closure.sql", import.meta.url),
  "utf8"
);

test("G1.5 profile migration is retry-safe and seeds existing Knowledge Services", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(schema);
    database.exec(`
      INSERT INTO knowledge_namespaces (id, owner_user_id) VALUES ('ns-1', 'owner-1');
      INSERT INTO knowledge_objects (
        id, namespace_id, parent_path, path, file_name, object_kind, created_by_user_id
      ) VALUES
        ('root-1', 'ns-1', '', 'PB Partner', 'PB Partner', 'folder', 'owner-1'),
        ('handbook-1', 'ns-1', 'PB Partner', 'PB Partner/handbook.md', 'handbook.md', 'file', 'owner-1');
      INSERT INTO knowledge_services (
        id, namespace_id, folder_object_id, handbook_object_id, name,
        status, agent_enabled, created_by_user_id
      ) VALUES (
        'service-1', 'ns-1', 'root-1', 'handbook-1', 'PB Partner',
        'active', 1, 'owner-1'
      );
      DELETE FROM knowledge_service_profiles WHERE service_id = 'service-1';
    `);

    database.exec(migration);
    database.exec(migration);

    assert.deepEqual(
      { ...database.prepare(
        `SELECT category, tags_json, languages_json, feedback_enabled, feedback_policy_json
         FROM knowledge_service_profiles WHERE service_id = 'service-1'`
      ).get() },
      {
        category: "general",
        feedback_enabled: 1,
        feedback_policy_json: "{}",
        languages_json: "[]",
        tags_json: "[]"
      }
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM knowledge_service_profiles WHERE service_id = 'service-1'"
      ).get().count,
      1
    );
  } finally {
    database.close();
  }
});
