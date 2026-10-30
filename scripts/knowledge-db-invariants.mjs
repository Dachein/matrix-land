export const knowledgeDbInvariantQueries = [
  {
    name: "foreign-key integrity",
    sql: "SELECT COUNT(*) AS violation_count FROM pragma_foreign_key_check;"
  },
  {
    name: "one active object per namespace path",
    sql: `
      SELECT COUNT(*) AS violation_count
      FROM (
        SELECT namespace_id, path
        FROM knowledge_objects
        WHERE deleted_at IS NULL
        GROUP BY namespace_id, path
        HAVING COUNT(*) > 1
      );
    `
  },
  {
    name: "deleted objects use isolated tombstone paths",
    sql: `
      SELECT COUNT(*) AS violation_count
      FROM knowledge_objects
      WHERE deleted_at IS NOT NULL
        AND substr(path, 1, 16) != '/.workspace-deleted/';
    `
  },
  {
    name: "deleted objects retain no active permissions",
    sql: `
      SELECT COUNT(*) AS violation_count
      FROM knowledge_permissions AS permission
      JOIN knowledge_objects AS object ON object.id = permission.object_id
      WHERE object.deleted_at IS NOT NULL
        AND permission.revoked_at IS NULL;
    `
  },
  {
    name: "deleted objects retain no active shares",
    sql: `
      SELECT COUNT(*) AS violation_count
      FROM knowledge_shares AS share
      JOIN knowledge_objects AS object ON object.id = share.object_id
      WHERE object.deleted_at IS NOT NULL
        AND share.revoked_at IS NULL;
    `
  },
  {
    name: "deleted objects retain no open tokens",
    sql: `
      SELECT COUNT(*) AS violation_count
      FROM knowledge_open_tokens AS token
      JOIN knowledge_objects AS object ON object.id = token.object_id
      WHERE object.deleted_at IS NOT NULL
        AND token.consumed_at IS NULL;
    `
  },
  {
    name: "services do not reference deleted live objects",
    sql: `
      SELECT COUNT(*) AS violation_count
      FROM knowledge_services AS service
      WHERE service.status != 'archived'
        AND (
          service.folder_object_id IN (
            SELECT id FROM knowledge_objects WHERE deleted_at IS NOT NULL
          )
          OR service.handbook_object_id IN (
            SELECT id FROM knowledge_objects WHERE deleted_at IS NOT NULL
          )
        );
    `
  },
  {
    name: "namespace usage matches active current file sizes",
    sql: `
      SELECT COUNT(*) AS violation_count
      FROM knowledge_namespaces AS namespace
      WHERE namespace.used_bytes != COALESCE((
        SELECT SUM(object.size_bytes)
        FROM knowledge_objects AS object
        WHERE object.namespace_id = namespace.id
          AND object.deleted_at IS NULL
          AND object.object_kind = 'file'
      ), 0);
    `
  },
  {
    name: "ZIP import job table exists",
    expected: 1,
    sql: `
      SELECT COUNT(*) AS violation_count
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'knowledge_zip_import_jobs';
    `
  },
  {
    name: "ZIP quota trigger exists",
    expected: 1,
    sql: `
      SELECT COUNT(*) AS violation_count
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'trg_knowledge_zip_import_quota';
    `
  }
];

export function verifyKnowledgeDatabase(runQuery) {
  const results = [];
  for (const invariant of knowledgeDbInvariantQueries) {
    const row = runQuery(invariant.sql);
    const actual = Number(row?.violation_count ?? Number.NaN);
    const expected = invariant.expected ?? 0;
    if (!Number.isFinite(actual)) {
      throw new Error(`Knowledge invariant did not return violation_count: ${invariant.name}`);
    }
    results.push({ actual, expected, name: invariant.name });
  }
  const failures = results.filter((result) => result.actual !== result.expected);
  return { failures, results };
}
