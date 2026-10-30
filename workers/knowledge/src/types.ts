import type { KnowledgeCapability, KnowledgeRole } from "./knowledge-capabilities.ts";

export type Env = {
  KNOWLEDGE_AUDIO_DOWNLOAD_HOSTS?: string;
  KNOWLEDGE_MAX_AUDIO_FILE_BYTES?: string;
  AUTH_PUBLIC_URL?: string;
  AUTH_RESOURCE_INTROSPECTION_TOKEN?: string;
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  CORS_ALLOWED_ORIGINS?: string;
  DEV_AUTH_BYPASS?: string;
  KNOWLEDGE_DB: D1Database;
  KNOWLEDGE_INDEX_QUEUE?: Queue<KnowledgeIndexQueueMessage>;
  KNOWLEDGE_HTML_INTERACTIVE_ENABLED?: string;
  KNOWLEDGE_MAX_FILE_BYTES?: string;
  KNOWLEDGE_MAX_TEXT_INDEX_BYTES?: string;
  KNOWLEDGE_MAX_ZIP_BYTES?: string;
  KNOWLEDGE_MAX_ZIP_ENTRIES?: string;
  KNOWLEDGE_MAX_ZIP_UNCOMPRESSED_BYTES?: string;
  KNOWLEDGE_QUERY_LEDGER_RETENTION_DAYS?: string;
  KNOWLEDGE_QUERY_RAW_RETENTION_DAYS?: string;
  KNOWLEDGE_OBJECTS: R2Bucket;
  KNOWLEDGE_ORG_ID?: string;
  KNOWLEDGE_PUBLIC_URL?: string;
  KNOWLEDGE_V2_INDEX_READ_ENABLED?: string;
  KNOWLEDGE_V2_MUTATION_SPINE_ENABLED?: string;
  KNOWLEDGE_V2_ROOT_ACL_ENABLED?: string;
  KNOWLEDGE_V2_SHADOW_READ_ENABLED?: string;
  PORTAL_URL?: string;
};

export type Principal = {
  folderEditOnly?: boolean;
  breakGlassReason?: string;
  clientId?: string;
  connectionId?: string;
  department?: string;
  departmentId?: string;
  departmentPath: string[];
  email?: string;
  name: string;
  orgId: string;
  role: string;
  scopes: string[];
  sub: string;
  team?: string;
  teamId?: string;
};

export type NamespaceRow = {
  id: string;
  org_id: string;
  owner_user_id: string;
  kind: string;
  name: string;
  slug: string;
  storage_mode: string;
  r2_bucket_name: string;
  r2_prefix: string;
  status: string;
  quota_bytes: number;
  used_bytes: number;
  created_at: string;
  updated_at: string;
};

export type ObjectRow = {
  id: string;
  namespace_id: string;
  parent_path: string;
  path: string;
  file_name: string;
  object_kind: "file" | "folder";
  mime_type: string;
  content_kind: string;
  current_version_id: string;
  title: string;
  description: string;
  tags_json: string;
  metadata_json: string;
  size_bytes: number;
  sha256: string;
  created_by_user_id: string;
  updated_by_user_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  share_mode?: "private" | "team" | "company" | "public";
  skill_ready?: number;
  agent_enabled?: number;
};

export type VersionRow = {
  id: string;
  object_id: string;
  namespace_id: string;
  version: number;
  r2_key: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_by_user_id: string;
  created_at: string;
};

export type KnowledgeZipImportJobRow = {
  id: string;
  namespace_id: string;
  idempotency_key: string;
  archive_sha256: string;
  root_path: string;
  root_object_id: string;
  object_ids_json: string;
  staging_prefix: string;
  total_bytes: number;
  entry_count: number;
  state: "staging" | "committed" | "failed";
  error_code: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type PlannedZipObject = {
  bytes?: Uint8Array;
  contentKind: string;
  fileName: string;
  id: string;
  kind: "file" | "folder";
  mimeType: string;
  parentPath: string;
  path: string;
  r2Key?: string;
  sha256: string;
  versionId?: string;
};

export type KnowledgeMutationSource = "portal" | "mcp" | "api" | "zip" | "sync" | "system";

export type KnowledgeMutationContext = {
  editOperation?: string;
  expectedVersionId: string;
  idempotencyKey: string;
  operation: string;
  requestId: string;
  sourceChannel: KnowledgeMutationSource;
};

export type KnowledgeMutationRecord = {
  changeItemId: string;
  changeSetId: string;
  commandId: string;
  requestHash: string;
  rootObjectId: string;
};

export type KnowledgeMutationCommandRow = {
  id: string;
  idempotency_scope: string;
  idempotency_key: string;
  request_hash: string;
  status: "prepared" | "committed" | "failed";
  version_after_id: string;
  result_json: string;
  error_code: string;
};

export type KnowledgeIndexQueueMessage = {
  kind: "service_reindex";
  serviceId: string;
  sourceRevision: number;
};

export type KnowledgeServiceRow = {
  id: string;
  namespace_id: string;
  folder_object_id: string;
  handbook_object_id: string;
  name: string;
  slug: string;
  description: string;
  status: "draft" | "active" | "archived";
  visibility: "private" | "team" | "company" | "public";
  access_targets_json: string;
  update_mode: "manual" | "auto";
  agent_enabled: number;
  index_status: "disabled" | "queued" | "indexing" | "ready" | "stale" | "error";
  index_generation: number;
  source_revision: number;
  indexed_at: string | null;
  last_error: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  folder_path?: string;
  folder_name?: string;
  category?: string;
  tags_json?: string;
  languages_json?: string;
  coverage_json?: string;
  not_for_json?: string;
  role_text?: string;
  search_hints_json?: string;
  feedback_enabled?: number;
  feedback_policy_json?: string;
  maintenance_team?: string;
};

export type KnowledgeServiceVersionRow = {
  id: string;
  service_id: string;
  version: number;
  handbook_version_id: string;
  manifest_json: string;
  object_versions_json: string;
  status: "active" | "archived";
  created_by_user_id: string;
  created_at: string;
};

export type KnowledgeServiceSnapshot = {
  objectId: string;
  versionId: string;
  path: string;
  relativePath: string;
  fileName: string;
  contentKind: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  isHandbook: boolean;
};

export type KnowledgeServiceAccessSettings = {
  company: boolean;
  users: string[];
  departments: string[];
};

export type PermissionRow = {
  id: string;
  namespace_id: string;
  object_id: string | null;
  subject_type: "user" | "team" | "department" | "company" | "mcp_client";
  subject_id: string;
  // `editor` is the legacy storage representation. API responses always use
  // the canonical `collaborator` name.
  role: "viewer" | "editor" | "collaborator" | "owner";
  can_share: number;
  can_publish_skill: number;
  granted_by_user_id: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  grant_source?: "direct" | "knowledge_service" | "migration" | "system";
  source_id?: string;
  service_grant_active?: number;
};

export type RootOwnerTransferRow = {
  id: string;
  namespace_id: string;
  root_object_id: string;
  from_user_id: string;
  to_user_id: string;
  status: "pending" | "accepted" | "rejected" | "expired" | "cancelled" | "admin_forced";
  initiated_by_user_id: string;
  retain_previous_owner: number;
  decided_by_user_id: string;
  decision_reason: string;
  expires_at: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ShareRow = {
  id: string;
  namespace_id: string;
  object_id: string;
  slug: string;
  visibility: "private" | "team" | "company" | "public";
  role: "viewer" | "editor";
  token_hash: string;
  passcode_hash: string;
  created_by_user_id: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CanonicalKnowledgeRole = "viewer" | "collaborator" | "owner";
