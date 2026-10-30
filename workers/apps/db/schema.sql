PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS apps_apps (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  ownership_sync_pending INTEGER NOT NULL DEFAULT 0,
  ownership_sync_lock_until TEXT,
  collaborator_user_ids_json TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('static_page', 'web', 'agent_app', 'automation', 'container')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'provisioning', 'published', 'archived')),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'team', 'org', 'public')),
  login_required INTEGER NOT NULL DEFAULT 1,
  agent_mcp_enabled INTEGER NOT NULL DEFAULT 0,
  llm_enabled INTEGER NOT NULL DEFAULT 0,
  llm_default_model TEXT,
  llm_endpoint TEXT,
  access_targets_json TEXT NOT NULL DEFAULT '[]',
  directory_read_scope TEXT NOT NULL DEFAULT 'app' CHECK (directory_read_scope IN ('app', 'company')),
  data_service_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(org_id, code),
  UNIQUE(org_id, slug)
);

CREATE TABLE IF NOT EXISTS apps_app_resources (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  data_service_id TEXT NOT NULL,
  type TEXT NOT NULL,
  provider TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  resource_id TEXT,
  binding_name TEXT,
  environment TEXT NOT NULL CHECK (environment IN ('shared', 'prod')),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apps_app_secrets (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('production')),
  description TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('declared', 'configured')) DEFAULT 'declared',
  cipher_text TEXT,
  cipher_iv TEXT,
  algorithm TEXT NOT NULL DEFAULT 'AES-GCM',
  configured_by TEXT,
  configured_at TEXT,
  declared_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(app_id, environment, name)
);

CREATE TABLE IF NOT EXISTS apps_app_env_vars (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('runtime', 'pages', 'worker')) DEFAULT 'runtime',
  environment TEXT NOT NULL CHECK (environment IN ('production')) DEFAULT 'production',
  value TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(app_id, environment, target, name)
);

CREATE TABLE IF NOT EXISTS apps_app_source_snapshots (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  version_name TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  content_sha256 TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  archive_format TEXT NOT NULL DEFAULT 'zip' CHECK (archive_format IN ('zip')),
  file_count INTEGER NOT NULL DEFAULT 0,
  source_size_bytes INTEGER NOT NULL DEFAULT 0,
  archive_size_bytes INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  upload_context TEXT NOT NULL DEFAULT 'legacy' CHECK (upload_context IN ('backup', 'deployment', 'both', 'legacy')),
  created_at TEXT NOT NULL,
  UNIQUE(app_id, archive_sha256)
);

CREATE TABLE IF NOT EXISTS apps_app_deploy_artifacts (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('pages', 'worker')),
  entrypoint TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  content_size_bytes INTEGER NOT NULL DEFAULT 0,
  archive_size_bytes INTEGER NOT NULL DEFAULT 0,
  manifest_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(app_id, archive_sha256)
);

CREATE TABLE IF NOT EXISTS apps_deployments (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  source_snapshot_id TEXT REFERENCES apps_app_source_snapshots(id) ON DELETE SET NULL,
  deploy_artifact_id TEXT REFERENCES apps_app_deploy_artifacts(id) ON DELETE SET NULL,
  environment TEXT NOT NULL CHECK (environment IN ('production')),
  version TEXT NOT NULL,
  version_name TEXT NOT NULL DEFAULT '',
  release_notes TEXT NOT NULL DEFAULT '',
  runtime_topology_json TEXT NOT NULL DEFAULT '',
  login_required INTEGER,
  visibility TEXT,
  access_targets_json TEXT,
  status TEXT NOT NULL,
  url TEXT,
  harness_report_url TEXT NOT NULL DEFAULT '',
  harness_self_check_confirmed_at TEXT,
  harness_self_check_confirmed_by TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apps_app_mcp_manifests (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL REFERENCES apps_deployments(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL,
  tool_definition_version TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(app_id, deployment_id)
);

CREATE INDEX IF NOT EXISTS idx_apps_app_mcp_manifests_app
  ON apps_app_mcp_manifests(app_id, created_at DESC);

CREATE TABLE IF NOT EXISTS apps_app_source_versions (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('production')),
  version TEXT NOT NULL,
  deployment_id TEXT REFERENCES apps_deployments(id) ON DELETE SET NULL,
  artifact_key TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  entrypoint TEXT NOT NULL DEFAULT 'index.html',
  file_count INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(app_id, environment, version)
);

CREATE TABLE IF NOT EXISTS apps_domains (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('production', 'custom')),
  environment TEXT NOT NULL CHECK (environment IN ('production')),
  status TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'cloudflare',
  provider_resource_id TEXT,
  dns_record_id TEXT,
  route_id TEXT,
  certificate_status TEXT NOT NULL DEFAULT 'unknown',
  route_status TEXT NOT NULL DEFAULT 'unknown',
  fallback_url TEXT,
  last_checked_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(hostname, type)
);

CREATE TABLE IF NOT EXISTS apps_migration_registry (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('production')),
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  content_sha256 TEXT,
  file_name TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(app_id, environment, version)
);

CREATE TABLE IF NOT EXISTS apps_provisioning_jobs (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('create_app', 'publish_production')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed', 'cancelled')),
  progress INTEGER NOT NULL DEFAULT 0,
  current_step TEXT,
  error_code TEXT,
  error_message TEXT,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS apps_provisioning_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES apps_provisioning_jobs(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  step_key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed', 'skipped')),
  progress INTEGER NOT NULL DEFAULT 0,
  resource_type TEXT,
  resource_id TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, step_key)
);

CREATE TABLE IF NOT EXISTS apps_audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apps_handoff_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '["apps:apps:handoff"]',
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workbuddy_app_users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  identity_provider TEXT NOT NULL DEFAULT '',
  identity_object_id TEXT NOT NULL DEFAULT '',
  first_login_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT NOT NULL DEFAULT (datetime('now')),
  profile_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS workbuddy_admins (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'business_admin',
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_by TEXT NOT NULL DEFAULT '',
  revoked_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workbuddy_admin_seeds (
  seed_key TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workbuddy_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  company_region TEXT NOT NULL DEFAULT '',
  role_profile TEXT NOT NULL DEFAULT '',
  primary_use_case TEXT NOT NULL DEFAULT '',
  use_case_detail TEXT NOT NULL DEFAULT '',
  current_pain TEXT NOT NULL DEFAULT '',
  urgency TEXT NOT NULL DEFAULT 'normal',
  manager_name TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted',
  admin_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS apps_skills (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  ownership_sync_pending INTEGER NOT NULL DEFAULT 0,
  ownership_sync_lock_until TEXT,
  collaborator_user_ids_json TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('vanilla', 'app')),
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('private', 'archived')),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'team', 'org')),
  access_targets_json TEXT NOT NULL DEFAULT '[]',
  login_required INTEGER NOT NULL DEFAULT 1,
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(org_id, slug)
);

CREATE TABLE IF NOT EXISTS apps_skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES apps_skills(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('private_current', 'private_superseded', 'submitted_for_market', 'listed', 'rejected', 'archived')),
  artifact_key TEXT NOT NULL,
  skill_md_key TEXT NOT NULL,
  manifest_key TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  file_count INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  changelog TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(skill_id, version)
);

CREATE TABLE IF NOT EXISTS apps_mates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  display_name TEXT NOT NULL,
  job_role TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  work_email TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'deployed', 'published', 'archived')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'targets', 'organization')),
  draft_revision INTEGER NOT NULL DEFAULT 1,
  draft_manifest_json TEXT NOT NULL,
  draft_documents_json TEXT NOT NULL DEFAULT '[]',
  preview_release_id TEXT,
  active_release_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(org_id, id),
  UNIQUE(work_email)
);

CREATE TABLE IF NOT EXISTS apps_mate_releases (
  id TEXT PRIMARY KEY,
  mate_id TEXT NOT NULL REFERENCES apps_mates(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'published', 'retired', 'revoked')),
  schema_version TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  documents_json TEXT NOT NULL DEFAULT '[]',
  storage_mode TEXT NOT NULL DEFAULT 'inline',
  manifest_r2_key TEXT,
  manifest_size_bytes INTEGER,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE(mate_id, version)
);

CREATE TABLE IF NOT EXISTS apps_mate_definition_revisions (
  id TEXT PRIMARY KEY,
  mate_id TEXT NOT NULL REFERENCES apps_mates(id) ON DELETE CASCADE,
  definition_type TEXT NOT NULL CHECK (definition_type IN ('soul', 'handbook', 'mail')),
  version INTEGER NOT NULL CHECK (version >= 1),
  digest TEXT NOT NULL,
  r2_object_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  source TEXT NOT NULL DEFAULT 'native' CHECK (source IN ('native', 'legacy_inline_import')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(mate_id, definition_type, digest),
  UNIQUE(r2_object_key)
);

CREATE TABLE IF NOT EXISTS apps_mate_release_definitions (
  release_id TEXT NOT NULL REFERENCES apps_mate_releases(id) ON DELETE CASCADE,
  definition_revision_id TEXT NOT NULL REFERENCES apps_mate_definition_revisions(id),
  definition_type TEXT NOT NULL CHECK (definition_type IN ('soul', 'handbook', 'mail')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  document_id TEXT NOT NULL,
  document_version INTEGER NOT NULL CHECK (document_version >= 1),
  document_digest TEXT NOT NULL,
  PRIMARY KEY (release_id, definition_type, ordinal),
  UNIQUE(release_id, definition_revision_id)
);

CREATE INDEX IF NOT EXISTS idx_apps_apps_org_owner ON apps_apps(org_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_apps_apps_public ON apps_apps(status, visibility, updated_at);
CREATE INDEX IF NOT EXISTS idx_apps_resources_app ON apps_app_resources(app_id, environment, type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_resources_app_d1_unique
  ON apps_app_resources(app_id, environment)
  WHERE type = 'd1_database';
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_resources_d1_resource_id_unique
  ON apps_app_resources(resource_id)
  WHERE type = 'd1_database' AND resource_id IS NOT NULL AND resource_id <> '';
CREATE INDEX IF NOT EXISTS idx_apps_app_secrets_app ON apps_app_secrets(app_id, environment, name);
CREATE INDEX IF NOT EXISTS idx_apps_app_env_vars_app ON apps_app_env_vars(app_id, environment, target, name);
CREATE INDEX IF NOT EXISTS idx_apps_deployments_app_env ON apps_deployments(app_id, environment, created_at);
CREATE INDEX IF NOT EXISTS idx_apps_app_source_versions_app ON apps_app_source_versions(app_id, environment, created_at);
CREATE INDEX IF NOT EXISTS idx_apps_app_source_snapshots_app ON apps_app_source_snapshots(app_id, created_at);
CREATE INDEX IF NOT EXISTS idx_apps_app_deploy_artifacts_app ON apps_app_deploy_artifacts(app_id, created_at);
CREATE INDEX IF NOT EXISTS idx_apps_domains_hostname ON apps_domains(hostname);
CREATE INDEX IF NOT EXISTS idx_apps_provisioning_jobs_app ON apps_provisioning_jobs(app_id, created_at);
CREATE INDEX IF NOT EXISTS idx_apps_provisioning_jobs_status ON apps_provisioning_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_apps_provisioning_steps_job ON apps_provisioning_steps(job_id, step_order);
CREATE INDEX IF NOT EXISTS idx_apps_audit_target ON apps_audit_logs(target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_apps_handoff_links_app ON apps_handoff_links(app_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_workbuddy_app_users_email ON workbuddy_app_users(email);
CREATE INDEX IF NOT EXISTS idx_workbuddy_admins_active ON workbuddy_admins(revoked_at, granted_at);
CREATE INDEX IF NOT EXISTS idx_workbuddy_admins_role_email ON workbuddy_admins(role, email, revoked_at);
CREATE INDEX IF NOT EXISTS idx_workbuddy_requests_user ON workbuddy_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workbuddy_requests_status ON workbuddy_requests(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_apps_skills_org_owner ON apps_skills(org_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_apps_skill_versions_skill ON apps_skill_versions(skill_id, created_at);
CREATE INDEX IF NOT EXISTS idx_apps_skill_versions_state ON apps_skill_versions(state, created_at);
CREATE INDEX IF NOT EXISTS idx_apps_mates_org_owner ON apps_mates(org_id, owner_user_id, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_mates_one_default_per_owner ON apps_mates(org_id, owner_user_id) WHERE is_default = 1;
CREATE INDEX IF NOT EXISTS idx_apps_mate_releases_mate ON apps_mate_releases(mate_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_mate_definition_revisions_version ON apps_mate_definition_revisions(mate_id, definition_type, version DESC);
CREATE INDEX IF NOT EXISTS idx_mate_release_definitions_release ON apps_mate_release_definitions(release_id, definition_type, ordinal);

CREATE TABLE IF NOT EXISTS apps_owner_transfers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('app', 'skill')),
  asset_id TEXT NOT NULL,
  asset_name TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  initiated_by_user_id TEXT NOT NULL,
  retain_previous_owner INTEGER NOT NULL CHECK (retain_previous_owner IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'expired', 'admin_forced')),
  reason TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  decided_by_user_id TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_owner_transfer_pending ON apps_owner_transfers(asset_type, asset_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_apps_owner_transfer_inbox ON apps_owner_transfers(org_id, to_user_id, status);

-- Stream is account-wide; these tables are the platform's App isolation boundary.
CREATE TABLE IF NOT EXISTS apps_stream_app_grants (
  app_id TEXT PRIMARY KEY REFERENCES apps_apps(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apps_stream_videos (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  max_duration_seconds INTEGER NOT NULL,
  stream_uid TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('creating', 'uploading', 'failed', 'deleted')),
  upload_url TEXT,
  protocol TEXT CHECK (protocol IN ('post', 'tus')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(app_id, object_id)
);
CREATE INDEX IF NOT EXISTS idx_apps_stream_app_videos ON apps_stream_videos(app_id, org_id, created_at);
