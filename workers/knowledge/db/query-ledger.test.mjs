import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("./migrations/20260730_knowledge_query_ledger.sql", import.meta.url),
  "utf8"
);

test("Query Ledger migration is retry-safe and links feedback without making it knowledge content", () => {
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
        'active', 1, 'ready', 'owner-1'
      );
    `);

    database.exec(migration);
    database.exec(migration);

    assert.deepEqual(
      { ...database.prepare(
        "SELECT category, tags_json, languages_json, coverage_json, not_for_json, feedback_enabled FROM knowledge_service_profiles WHERE service_id = 'service-1'"
      ).get() },
      {
        category: "general",
        coverage_json: "[]",
        feedback_enabled: 1,
        languages_json: "[]",
        not_for_json: "[]",
        tags_json: "[]"
      }
    );

    database.exec(`
      INSERT INTO knowledge_query_sessions (
        id, org_id, actor_user_id, connection_id, client_id,
        client_session_id, client_turn_id, original_question_hash
      ) VALUES (
        'query-1', 'example-org', 'viewer-1', 'connection-1', 'codex',
        'session-1', 'turn-1', 'sha256-question'
      );
      INSERT INTO knowledge_query_steps (
        id, query_id, service_id, actor_user_id, action, request_id,
        query_text_hash, result_count, source_revision, index_generation,
        duration_ms, status, completed_at
      ) VALUES (
        'step-1', 'query-1', 'service-1', 'viewer-1', 'search', 'request-1',
        'sha256-search', 3, 4, 2, 25, 'succeeded', CURRENT_TIMESTAMP
      );
      INSERT INTO knowledge_feedback (
        id, org_id, namespace_id, root_object_id, service_id, actor_user_id,
        source_channel, kind, message, idempotency_key
      ) VALUES (
        'feedback-1', 'example-org', 'ns-1', 'root-1', 'service-1', 'viewer-1',
        'mcp', 'question', 'The answer is missing.', 'feedback-query-1'
      );
      INSERT INTO knowledge_feedback_query_links (
        feedback_id, query_id, query_step_id
      ) VALUES ('feedback-1', 'query-1', 'step-1');
    `);

    assert.deepEqual(
      { ...database.prepare(
        `SELECT link.query_id, link.query_step_id, step.action
         FROM knowledge_feedback_query_links AS link
         JOIN knowledge_query_steps AS step ON step.id = link.query_step_id
         WHERE link.feedback_id = 'feedback-1'`
      ).get() },
      { action: "search", query_id: "query-1", query_step_id: "step-1" }
    );

    database.prepare("DELETE FROM knowledge_query_sessions WHERE id = 'query-1'").run();
    assert.deepEqual(
      { ...database.prepare(
        `SELECT query_id, query_step_id
         FROM knowledge_feedback_query_links
         WHERE feedback_id = 'feedback-1'`
      ).get() },
      { query_id: null, query_step_id: null }
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM knowledge_feedback WHERE id = 'feedback-1'").get().count,
      1
    );
  } finally {
    database.close();
  }
});
