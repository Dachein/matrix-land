import { knowledgeCapabilities, roleHasKnowledgeCapability } from "../access/policy.ts";
import type { CanonicalKnowledgeRole, KnowledgeServiceAccessSettings, KnowledgeServiceRow, KnowledgeServiceVersionRow } from "../types.ts";
import { safeJsonArray, safeJsonRecord, safeJsonRecordArray } from "../values.ts";

export function knowledgeServiceJson(
  row: KnowledgeServiceRow,
  latestVersion?: KnowledgeServiceVersionRow | null,
  effectiveRole: CanonicalKnowledgeRole | "none" = "viewer",
  access?: KnowledgeServiceAccessSettings
) {
  const agentEnabled = row.status === "active" && row.agent_enabled === 1;
  return {
    id: row.id,
    serviceId: row.id,
    namespaceId: row.namespace_id,
    folderObjectId: row.folder_object_id,
    folderPath: row.folder_path ?? "",
    folderName: row.folder_name ?? "",
    handbookObjectId: row.handbook_object_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    profile: knowledgeServiceProfileJson(row),
    card: knowledgeServiceRoutingCardJson(row),
    category: row.category || "general",
    tags: safeJsonArray(row.tags_json ?? "[]"),
    languages: safeJsonArray(row.languages_json ?? "[]"),
    feedbackEnabled: true,
    feedbackPolicy: safeJsonRecord(row.feedback_policy_json ?? "{}"),
    maintenanceTeam: row.maintenance_team?.trim() || "",
    status: row.status,
    agentEnabled,
    accessModel: "folder_acl",
    access,
    effectiveRole,
    capabilities: knowledgeCapabilities(effectiveRole, agentEnabled, "folder"),
    indexStatus: row.index_status,
    indexGeneration: row.index_generation,
    sourceRevision: row.source_revision,
    indexedAt: row.indexed_at,
    lastError: row.last_error || undefined,
    latestVersion: latestVersion ? knowledgeServiceVersionJson(latestVersion) : undefined,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function knowledgeServiceCardJson(
  row: KnowledgeServiceRow,
  effectiveRole: CanonicalKnowledgeRole | "none"
) {
  const profile = knowledgeServiceProfileJson(row);
  const {
    feedbackEnabled,
    ...registration
  } = profile;
  const enabled = row.status === "active" && row.agent_enabled === 1;
  const indexReady = enabled && row.index_status === "ready";
  return {
    serviceId: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    ...registration,
    card: knowledgeServiceRoutingCardJson(row),
    effectiveRole,
    retrieval: {
      handbook: enabled,
      tree: enabled,
      glob: enabled,
      search: indexReady,
      grep: indexReady,
      read: enabled
    },
    feedback: {
      enabled: feedbackEnabled,
      canSubmit: enabled && feedbackEnabled,
      canViewMine: enabled,
      canManage: enabled
        && roleHasKnowledgeCapability(effectiveRole, "readChangeAudit")
    },
    health: {
      status: row.index_status,
      sourceRevision: row.source_revision,
      indexGeneration: row.index_generation,
      indexedAt: row.indexed_at,
      updatedAt: row.updated_at
    }
  };
}

function knowledgeServiceProfileJson(row: KnowledgeServiceRow) {
  const coverage = safeJsonArray(row.coverage_json ?? "[]");
  return {
    category: row.category?.trim() || "general",
    tags: safeJsonArray(row.tags_json ?? "[]"),
    languages: safeJsonArray(row.languages_json ?? "[]"),
    coverage: coverage.length > 0
      ? coverage
      : row.description.trim()
        ? [row.description.trim()]
        : [],
    notFor: safeJsonArray(row.not_for_json ?? "[]"),
    role: row.role_text?.trim() || "",
    searchHints: safeJsonArray(row.search_hints_json ?? "[]"),
    maintenanceTeam: row.maintenance_team?.trim() || "",
    feedbackEnabled: true
  };
}

function knowledgeServiceRoutingCardJson(row: KnowledgeServiceRow) {
  const profile = knowledgeServiceProfileJson(row);
  return {
    description: row.description,
    role: profile.role,
    bestFor: profile.coverage,
    notFor: profile.notFor,
    keywords: profile.tags,
    searchHints: profile.searchHints
  };
}

export function knowledgeServiceVersionJson(row: KnowledgeServiceVersionRow) {
  return {
    id: row.id,
    serviceId: row.service_id,
    version: row.version,
    handbookVersionId: row.handbook_version_id,
    manifest: safeJsonRecord(row.manifest_json),
    objectVersions: safeJsonRecordArray(row.object_versions_json),
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at
  };
}
