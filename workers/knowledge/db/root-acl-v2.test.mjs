import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const schemaUrl = new URL("./schema.sql", import.meta.url);
const migrationUrl = new URL("./migrations/20260726_knowledge_root_acl_v2.sql", import.meta.url);
const repairMigrationUrl = new URL("./d1-migrations/0007_backfill_service_viewer_provenance.sql", import.meta.url);
const [schema, migration, repairMigration] = await Promise.all([
  readFile(schemaUrl, "utf8"),
  readFile(migrationUrl, "utf8"),
  readFile(repairMigrationUrl, "utf8")
]);

const e1Marker = "-- Knowledge Service V2 Root ACL invariants.";
const feedbackMarker = "-- Knowledge feedback.";
const invariantStart = "CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_permissions_one_active_root_owner";
const preE1Schema = schema.slice(0, schema.indexOf(e1Marker));

function createLegacyDatabase() {
  assert.ok(preE1Schema.length > 0, "fresh schema must retain the E1 marker");
  const database = new DatabaseSync(":memory:");
  database.exec(preE1Schema);
  database.exec(`
    INSERT INTO knowledge_namespaces (
      id, org_id, owner_user_id, kind, name, slug, r2_prefix
    ) VALUES (
      'namespace-1', 'org-1', 'owner-1', 'personal',
      'Owner Knowledge', 'owner-knowledge', 'org/org-1/ns/namespace-1'
    );

    INSERT INTO knowledge_objects (
      id, namespace_id, parent_path, path, file_name, object_kind,
      mime_type, content_kind, created_by_user_id, updated_by_user_id
    ) VALUES
      (
        'root-1', 'namespace-1', '', 'PB Partner', 'PB Partner', 'folder',
        'application/x-directory', 'folder', 'owner-1', 'owner-1'
      ),
      (
        'nested-1', 'namespace-1', 'PB Partner', 'PB Partner/entities',
        'entities', 'folder', 'application/x-directory', 'folder',
        'owner-1', 'owner-1'
      ),
      (
        'handbook-1', 'namespace-1', 'PB Partner', 'PB Partner/handbook.md',
        'handbook.md', 'file', 'text/markdown', 'markdown',
        'owner-1', 'owner-1'
      );

    INSERT INTO knowledge_permissions (
      id, namespace_id, object_id, subject_type, subject_id, role,
      can_share, granted_by_user_id
    ) VALUES
      (
        'owner-viewer', 'namespace-1', 'root-1', 'user', 'owner-1',
        'viewer', 0, 'owner-1'
      ),
      (
        'service-viewer', 'namespace-1', 'root-1', 'department', 'dept-1',
        'viewer', 0, 'owner-1'
      ),
      (
        'collaborator-1', 'namespace-1', 'root-1', 'user', 'collaborator-1',
        'editor', 1, 'owner-1'
      );

    INSERT INTO knowledge_services (
      id, namespace_id, folder_object_id, handbook_object_id, name, slug,
      status, agent_enabled, created_by_user_id
    ) VALUES (
      'service-1', 'namespace-1', 'root-1', 'handbook-1',
      'PB Partner', 'pb-partner', 'active', 1, 'owner-1'
    );
  `);
  return database;
}

test("fresh schema and E1 migration define the same Root ACL invariants", () => {
  const schemaIndex = schema.indexOf(invariantStart);
  const migrationIndex = migration.indexOf(invariantStart);
  assert.notEqual(schemaIndex, -1);
  assert.notEqual(migrationIndex, -1);
  assert.equal(
    schema.slice(schemaIndex, schema.indexOf(feedbackMarker)).trim(),
    migration.slice(migrationIndex).trim()
  );
});

test("Root ACL migration backfills one direct Owner and Service Viewer provenance", () => {
  const database = createLegacyDatabase();
  try {
    database.exec(migration);
    database.exec(migration);

    assert.deepEqual(
      database.prepare(
        `SELECT subject_id, role
         FROM knowledge_permissions
         WHERE object_id = 'root-1' AND revoked_at IS NULL
         ORDER BY subject_id`
      ).all().map((row) => ({ ...row })),
      [
        { subject_id: "collaborator-1", role: "editor" },
        { subject_id: "dept-1", role: "viewer" },
        { subject_id: "owner-1", role: "owner" }
      ]
    );
    assert.deepEqual(
      database.prepare(
        `SELECT permission_id, grant_source, source_id
         FROM knowledge_permission_provenance
         ORDER BY permission_id`
      ).all().map((row) => ({ ...row })),
      [
        { permission_id: "collaborator-1", grant_source: "direct", source_id: "root-1" },
        { permission_id: "owner-viewer", grant_source: "direct", source_id: "root-1" },
        { permission_id: "service-viewer", grant_source: "knowledge_service", source_id: "service-1" }
      ]
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("managed repair backfills a unique active Service Viewer without replacing direct provenance", () => {
  const database = createLegacyDatabase();
  try {
    database.exec(migration);
    database.exec(`
      INSERT INTO knowledge_permissions (
        id, namespace_id, object_id, subject_type, subject_id, role, granted_by_user_id
      ) VALUES
        ('orphan-viewer', 'namespace-1', 'root-1', 'department', 'dept-2', 'viewer', 'owner-1'),
        ('direct-viewer', 'namespace-1', 'root-1', 'user', 'user-2', 'viewer', 'owner-1');
      INSERT INTO knowledge_permission_provenance (permission_id, grant_source, source_id)
      VALUES ('direct-viewer', 'direct', 'root-1');
    `);

    database.exec(repairMigration);
    database.exec(repairMigration);

    assert.deepEqual(database.prepare(`
      SELECT permission_id, grant_source, source_id
      FROM knowledge_permission_provenance
      WHERE permission_id IN ('orphan-viewer', 'direct-viewer')
      ORDER BY permission_id
    `).all().map((row) => ({ ...row })), [
      { permission_id: "direct-viewer", grant_source: "direct", source_id: "root-1" },
      { permission_id: "orphan-viewer", grant_source: "knowledge_service", source_id: "service-1" }
    ]);
  } finally {
    database.close();
  }
});

test("Root ACL database guards reject nested grants, nested Services, and ambiguous Owners", () => {
  const database = createLegacyDatabase();
  try {
    database.exec(migration);
    assert.throws(
      () => database.exec(`
        INSERT INTO knowledge_permissions (
          id, namespace_id, object_id, subject_type, subject_id, role, granted_by_user_id
        ) VALUES (
          'nested-grant', 'namespace-1', 'nested-1', 'user', 'user-2', 'editor', 'owner-1'
        );
      `),
      /knowledge_acl_root_required/
    );
    assert.throws(
      () => database.exec(`
        INSERT INTO knowledge_permissions (
          id, namespace_id, object_id, subject_type, subject_id, role, granted_by_user_id
        ) VALUES (
          'second-owner', 'namespace-1', 'root-1', 'user', 'owner-2', 'owner', 'owner-1'
        );
      `),
      /UNIQUE constraint failed/
    );
    assert.throws(
      () => database.exec(`
        INSERT INTO knowledge_permissions (
          id, namespace_id, object_id, subject_type, subject_id, role, granted_by_user_id
        ) VALUES (
          'department-owner', 'namespace-1', 'root-1', 'department', 'dept-2', 'owner', 'owner-1'
        );
      `),
      /knowledge_owner_subject_must_be_user/
    );
    assert.throws(
      () => database.exec(`
        INSERT INTO knowledge_services (
          id, namespace_id, folder_object_id, handbook_object_id, name, slug,
          status, agent_enabled, created_by_user_id
        ) VALUES (
          'nested-service', 'namespace-1', 'nested-1', 'handbook-1',
          'Nested', 'nested', 'active', 1, 'owner-1'
        );
      `),
      /knowledge_service_root_required/
    );
  } finally {
    database.close();
  }
});
