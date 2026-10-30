import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("./migrations/20260728_knowledge_feedback.sql", import.meta.url),
  "utf8"
);

test("feedback migration is retry-safe and scopes MCP idempotency per actor", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(schema);
    database.exec(migration);
    database.exec(migration);

    database.exec(`
      INSERT INTO knowledge_namespaces (id, owner_user_id) VALUES ('ns-1', 'owner-1');
      INSERT INTO knowledge_objects (
        id, namespace_id, path, file_name, object_kind, created_by_user_id
      ) VALUES ('root-1', 'ns-1', 'root', 'root', 'folder', 'owner-1');
      INSERT INTO knowledge_feedback (
        id, org_id, namespace_id, root_object_id, actor_user_id,
        source_channel, kind, message, idempotency_key
      ) VALUES (
        'feedback-1', 'example-org', 'ns-1', 'root-1', 'viewer-1',
        'mcp', 'correction', 'The supplier status is stale.', 'retry-1'
      );
    `);

    assert.throws(
      () => database.exec(`
        INSERT INTO knowledge_feedback (
          id, org_id, namespace_id, root_object_id, actor_user_id,
          source_channel, kind, message, idempotency_key
        ) VALUES (
          'feedback-2', 'example-org', 'ns-1', 'root-1', 'viewer-1',
          'mcp', 'correction', 'Duplicate retry.', 'retry-1'
        );
      `),
      /UNIQUE/
    );

    database.exec(`
      INSERT INTO knowledge_feedback (
        id, org_id, namespace_id, root_object_id, actor_user_id,
        source_channel, kind, message, idempotency_key
      ) VALUES (
        'feedback-3', 'example-org', 'ns-1', 'root-1', 'viewer-2',
        'mcp', 'question', 'Can I use this record?', 'retry-1'
      );
    `);
  } finally {
    database.close();
  }
});
