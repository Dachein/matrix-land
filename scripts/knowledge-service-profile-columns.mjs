export const knowledgeServiceProfileColumnMigrations = Object.freeze([
  Object.freeze({
    name: "feedback_policy_json",
    sql: "ALTER TABLE knowledge_service_profiles ADD COLUMN feedback_policy_json TEXT NOT NULL DEFAULT '{}'"
  }),
  Object.freeze({
    name: "coverage_json",
    sql: "ALTER TABLE knowledge_service_profiles ADD COLUMN coverage_json TEXT NOT NULL DEFAULT '[]'"
  }),
  Object.freeze({
    name: "not_for_json",
    sql: "ALTER TABLE knowledge_service_profiles ADD COLUMN not_for_json TEXT NOT NULL DEFAULT '[]'"
  }),
  Object.freeze({
    name: "maintenance_team",
    sql: "ALTER TABLE knowledge_service_profiles ADD COLUMN maintenance_team TEXT NOT NULL DEFAULT ''"
  })
]);

export function findMissingKnowledgeServiceProfileColumns(rows) {
  const existingColumns = new Set(rows.map((row) => String(row?.name ?? "")));
  return knowledgeServiceProfileColumnMigrations.filter(
    (migration) => !existingColumns.has(migration.name)
  );
}

export function ensureKnowledgeServiceProfileColumns(database) {
  const rows = database.prepare("PRAGMA table_info(knowledge_service_profiles)").all();
  if (rows.length === 0) {
    throw new Error(
      "knowledge_service_profiles does not exist; apply the Query Ledger migration first"
    );
  }

  const applied = [];
  for (const migration of findMissingKnowledgeServiceProfileColumns(rows)) {
    database.exec(migration.sql);
    applied.push(migration.name);
  }
  return applied;
}
