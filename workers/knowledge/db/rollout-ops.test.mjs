import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("./migrations/20260729_knowledge_rollout_ops.sql", import.meta.url),
  "utf8"
);

test("rollout migration is retry-safe and creates one backfill job per active Service", () => {
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
        status, agent_enabled, index_status, created_by_user_id
      ) VALUES (
        'service-1', 'ns-1', 'root-1', 'handbook-1', 'PB Partner',
        'active', 1, 'disabled', 'owner-1'
      );
    `);

    database.exec(migration);
    database.exec(migration);

    assert.deepEqual(
      { ...database.prepare(
        "SELECT source_revision, index_status FROM knowledge_services WHERE id = 'service-1'"
      ).get() },
      { source_revision: 1, index_status: "queued" }
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM knowledge_index_outbox WHERE service_id = 'service-1'"
      ).get().count,
      1
    );
    assert.equal(
      database.prepare(
        "SELECT status FROM knowledge_service_index_state WHERE service_id = 'service-1'"
      ).get().status,
      "queued"
    );
  } finally {
    database.close();
  }
});
