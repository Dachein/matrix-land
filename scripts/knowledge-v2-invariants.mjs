export const knowledgeV2FoundationInvariantQueries = [
  ...[
    "knowledge_permission_provenance",
    "knowledge_root_owner_transfers",
    "knowledge_mutation_commands",
    "knowledge_change_sets",
    "knowledge_change_items",
    "knowledge_diff_outbox",
    "knowledge_service_index_state",
    "knowledge_index_documents",
    "knowledge_index_chunks",
    "knowledge_index_fts",
    "knowledge_index_outbox",
    "knowledge_ingestion_states",
    "knowledge_feedback",
    "knowledge_service_profiles",
    "knowledge_query_sessions",
    "knowledge_query_steps",
    "knowledge_feedback_query_links"
  ].map((name) => ({
    expected: 1,
    name: `${name} exists`,
    sql: `
      SELECT COUNT(*) AS violation_count
      FROM sqlite_master
      WHERE name = '${name}'
        AND type IN ('table', 'view');
    `
  })),
  ...[
    "trg_knowledge_index_chunks_ai",
    "trg_knowledge_index_chunks_ad",
    "trg_knowledge_index_chunks_au",
    "trg_knowledge_permissions_root_insert",
    "trg_knowledge_permissions_root_update",
    "trg_knowledge_permissions_owner_user_insert",
    "trg_knowledge_permissions_owner_user_update",
    "trg_knowledge_services_root_insert",
    "trg_knowledge_services_root_update"
  ].map((name) => ({
    expected: 1,
    name: `${name} exists`,
    sql: `
      SELECT COUNT(*) AS violation_count
      FROM sqlite_master
      WHERE name = '${name}'
        AND type = 'trigger';
    `
  })),
  {
    expected: 1,
    name: "one active Root Owner index exists",
    sql: `
      SELECT COUNT(*) AS violation_count
      FROM sqlite_master
      WHERE name = 'idx_knowledge_permissions_one_active_root_owner'
        AND type = 'index';
    `
  },
  ...["feedback_policy_json", "coverage_json", "not_for_json", "maintenance_team"].map((name) => ({
    expected: 1,
    name: `knowledge_service_profiles.${name} exists`,
    sql: `
      SELECT COUNT(*) AS violation_count
      FROM pragma_table_info('knowledge_service_profiles')
      WHERE name = '${name}';
    `
  }))
];

export function verifyKnowledgeV2FoundationDatabase(runQuery) {
  const results = [];
  for (const invariant of knowledgeV2FoundationInvariantQueries) {
    const row = runQuery(invariant.sql);
    const actual = Number(row?.violation_count ?? Number.NaN);
    const expected = invariant.expected ?? 0;
    if (!Number.isFinite(actual)) {
      throw new Error(`Knowledge V2 invariant did not return violation_count: ${invariant.name}`);
    }
    results.push({ actual, expected, name: invariant.name });
  }
  return {
    failures: results.filter((result) => result.actual !== result.expected),
    results
  };
}
