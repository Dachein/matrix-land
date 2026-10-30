import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const schemaUrl = new URL("./schema.sql", import.meta.url);
const migrationUrl = new URL("./migrations/20260725_knowledge_service_v2_foundation.sql", import.meta.url);
const actorEmailMigrationUrl = new URL("./d1-migrations/0006_knowledge_change_set_actor_email.sql", import.meta.url);
const [schema, migration, actorEmailMigration] = await Promise.all([
  readFile(schemaUrl, "utf8"),
  readFile(migrationUrl, "utf8"),
  readFile(actorEmailMigrationUrl, "utf8")
]);

const foundationMarker = "-- Knowledge Service V2 additive foundation.";
const e1Marker = "-- Knowledge Service V2 Root ACL invariants.";
const foundationStart = "CREATE TABLE IF NOT EXISTS knowledge_permission_provenance";
const legacySchema = schema.slice(0, schema.indexOf(foundationMarker));

const expectedTables = [
  "knowledge_change_items",
  "knowledge_change_sets",
  "knowledge_diff_outbox",
  "knowledge_index_chunks",
  "knowledge_index_documents",
  "knowledge_index_fts",
  "knowledge_index_outbox",
  "knowledge_ingestion_states",
  "knowledge_mutation_commands",
  "knowledge_permission_provenance",
  "knowledge_root_owner_transfers",
  "knowledge_service_index_state"
];

function createMigratedDatabase() {
  assert.ok(legacySchema.length > 0, "fresh schema must retain the V2 foundation marker");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(legacySchema);
  database.exec(migration);
  database.exec(migration);
  database.exec(actorEmailMigration);
  return database;
}

function insertBaseRows(database) {
  database.exec(`
    INSERT INTO knowledge_namespaces (
      id, org_id, owner_user_id, kind, name, slug, r2_prefix
    ) VALUES (
      'namespace-1', 'example-org', 'ai_adoption', 'personal',
      'AI Adoption Knowledge', 'ai-adoption', 'org/example-org/ns/namespace-1'
    );

    INSERT INTO knowledge_objects (
      id, namespace_id, parent_path, path, file_name, object_kind,
      mime_type, content_kind, created_by_user_id, updated_by_user_id
    ) VALUES
      (
        'root-1', 'namespace-1', '', 'PB Partner', 'PB Partner', 'folder',
        'application/x-directory', 'folder', 'ai_adoption', 'ai_adoption'
      ),
      (
        'handbook-1', 'namespace-1', 'PB Partner', 'PB Partner/handbook.md',
        'handbook.md', 'file', 'text/markdown', 'markdown',
        'ai_adoption', 'ai_adoption'
      ),
      (
        'file-1', 'namespace-1', 'PB Partner', 'PB Partner/partners.md',
        'partners.md', 'file', 'text/markdown', 'markdown',
        'ai_adoption', 'ai_adoption'
      );

    INSERT INTO knowledge_object_versions (
      id, object_id, namespace_id, version, r2_key, mime_type, size_bytes,
      sha256, created_by_user_id
    ) VALUES (
      'version-1', 'file-1', 'namespace-1', 1,
      'org/example-org/ns/namespace-1/version-1',
      'text/markdown', 34, 'hash-1', 'ai_adoption'
    );

    UPDATE knowledge_objects
    SET current_version_id = 'version-1', size_bytes = 34, sha256 = 'hash-1'
    WHERE id = 'file-1';

    INSERT INTO knowledge_services (
      id, namespace_id, folder_object_id, handbook_object_id, name, slug,
      description, status, update_mode, agent_enabled, index_status,
      created_by_user_id
    ) VALUES (
      'service-1', 'namespace-1', 'root-1', 'handbook-1',
      'PB Partner', 'pb-partner', 'PB partner knowledge', 'active',
      'auto', 1, 'queued', 'ai_adoption'
    );
  `);
}

test("fresh schema and additive migrations define the same V2 foundation", () => {
  const schemaFoundationIndex = schema.indexOf(foundationStart);
  const migrationFoundationIndex = migration.indexOf(foundationStart);
  assert.notEqual(schemaFoundationIndex, -1, "fresh schema must contain the V2 foundation");
  assert.notEqual(migrationFoundationIndex, -1, "migration must contain the V2 foundation");
  const migratedFoundation = migration
    .slice(migrationFoundationIndex)
    .replace(
      "  actor_user_id TEXT NOT NULL DEFAULT '',\n",
      "  actor_user_id TEXT NOT NULL DEFAULT '',\n  actor_email TEXT NOT NULL DEFAULT '',\n"
    );
  assert.equal(
    schema.slice(schemaFoundationIndex, schema.indexOf(e1Marker)).trim(),
    migratedFoundation.trim()
  );
});

test("V2 foundation migration is additive and retry-safe", () => {
  const database = createMigratedDatabase();
  try {
    const tables = database
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type IN ('table', 'view')
          AND name LIKE 'knowledge_%'
        ORDER BY name
      `)
      .all()
      .map((row) => row.name);
    for (const table of expectedTables) {
      assert.ok(tables.includes(table), `missing V2 foundation table: ${table}`);
    }
    assert.ok(
      database.prepare("PRAGMA table_info(knowledge_change_sets)").all().some((column) => column.name === "actor_email"),
      "knowledge_change_sets must preserve the authenticated actor email"
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("version-bound canonical chunks keep the trigram FTS index in sync", () => {
  const database = createMigratedDatabase();
  try {
    insertBaseRows(database);
    database.exec(`
      INSERT INTO knowledge_index_documents (
        id, service_id, root_object_id, object_id, version_id, mime_type,
        extractor_version, status, content_hash, chunk_count
      ) VALUES (
        'document-1', 'service-1', 'root-1', 'file-1', 'version-1',
        'text/markdown', 'native-text-v1', 'ready', 'hash-1', 1
      );

      INSERT INTO knowledge_index_chunks (
        chunk_id, document_id, service_id, object_id, version_id,
        chunk_ordinal, relative_path_cache, start_line, end_line, text, content_hash
      ) VALUES (
        'chunk-1', 'document-1', 'service-1', 'file-1', 'version-1',
        0, 'partners.md', 1, 3, 'PB partner onboarding requirements', 'chunk-hash-1'
      );
    `);

    const countMatches = (query) => Number(
      database
        .prepare("SELECT COUNT(*) AS count FROM knowledge_index_fts WHERE knowledge_index_fts MATCH ?")
        .get(query)
        .count
    );

    assert.equal(countMatches('"partner"'), 1);
    database
      .prepare("UPDATE knowledge_index_chunks SET text = ?, content_hash = ? WHERE chunk_id = ?")
      .run("Custody account documentation", "chunk-hash-2", "chunk-1");
    assert.equal(countMatches('"partner"'), 0);
    assert.equal(countMatches('"account"'), 1);
    database.prepare("DELETE FROM knowledge_index_chunks WHERE chunk_id = ?").run("chunk-1");
    assert.equal(countMatches('"account"'), 0);
  } finally {
    database.close();
  }
});

test("foundation constraints scope idempotency and preserve permission provenance", () => {
  const database = createMigratedDatabase();
  try {
    insertBaseRows(database);
    database.exec(`
      INSERT INTO knowledge_permissions (
        id, namespace_id, object_id, subject_type, subject_id, role,
        granted_by_user_id
      ) VALUES (
        'permission-1', 'namespace-1', 'root-1', 'user', 'ai_adoption',
        'owner', 'ai_adoption'
      );

      INSERT INTO knowledge_permission_provenance (
        permission_id, grant_source, source_id
      ) VALUES (
        'permission-1', 'direct', 'root-1'
      );

      INSERT INTO knowledge_mutation_commands (
        id, org_id, namespace_id, root_object_id, object_id, operation,
        expected_version_id, version_after_id, idempotency_scope,
        idempotency_key, request_hash
      ) VALUES (
        'mutation-1', 'example-org', 'namespace-1', 'root-1', 'file-1',
        'update', 'version-1', 'version-2',
        'example-org:ai_adoption:mcp:knowledge_edit_file_update',
        'pb-update-1', 'request-hash-1'
      );
    `);

    assert.throws(
      () => database.exec(`
        INSERT INTO knowledge_mutation_commands (
          id, org_id, namespace_id, root_object_id, object_id, operation,
          expected_version_id, version_after_id, idempotency_scope,
          idempotency_key, request_hash
        ) VALUES (
          'mutation-2', 'example-org', 'namespace-1', 'root-1', 'file-1',
          'update', 'version-1', 'version-3',
          'example-org:ai_adoption:mcp:knowledge_edit_file_update',
          'pb-update-1', 'different-request-hash'
        );
      `),
      /UNIQUE constraint failed/
    );

    database.prepare("DELETE FROM knowledge_permissions WHERE id = ?").run("permission-1");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM knowledge_permission_provenance").get().count,
      0
    );
  } finally {
    database.close();
  }
});
