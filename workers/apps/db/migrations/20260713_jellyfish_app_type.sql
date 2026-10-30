PRAGMA foreign_keys = OFF;

-- D1 applies migrations inside a transaction. SQLite does not change the
-- foreign_keys pragma while a transaction is active, so rebuilding the parent
-- table would otherwise cascade-delete every app-owned row. Preserve all
-- direct children before replacing apps_apps and restore them afterwards.
DROP TABLE IF EXISTS apps_app_resources_jellyfish_type_backup;
CREATE TABLE apps_app_resources_jellyfish_type_backup AS SELECT * FROM apps_app_resources;

DROP TABLE IF EXISTS apps_app_secrets_jellyfish_type_backup;
CREATE TABLE apps_app_secrets_jellyfish_type_backup AS SELECT * FROM apps_app_secrets;

DROP TABLE IF EXISTS apps_app_env_vars_jellyfish_type_backup;
CREATE TABLE apps_app_env_vars_jellyfish_type_backup AS SELECT * FROM apps_app_env_vars;

DROP TABLE IF EXISTS apps_app_kv_items_jellyfish_type_backup;
CREATE TABLE apps_app_kv_items_jellyfish_type_backup AS SELECT * FROM apps_app_kv_items;

DROP TABLE IF EXISTS apps_app_r2_objects_jellyfish_type_backup;
CREATE TABLE apps_app_r2_objects_jellyfish_type_backup AS SELECT * FROM apps_app_r2_objects;

DROP TABLE IF EXISTS apps_deployments_jellyfish_type_backup;
CREATE TABLE apps_deployments_jellyfish_type_backup AS SELECT * FROM apps_deployments;

DROP TABLE IF EXISTS apps_app_source_versions_jellyfish_type_backup;
CREATE TABLE apps_app_source_versions_jellyfish_type_backup AS SELECT * FROM apps_app_source_versions;

DROP TABLE IF EXISTS apps_domains_jellyfish_type_backup;
CREATE TABLE apps_domains_jellyfish_type_backup AS SELECT * FROM apps_domains;

DROP TABLE IF EXISTS apps_migration_registry_jellyfish_type_backup;
CREATE TABLE apps_migration_registry_jellyfish_type_backup AS SELECT * FROM apps_migration_registry;

DROP TABLE IF EXISTS apps_provisioning_jobs_jellyfish_type_backup;
CREATE TABLE apps_provisioning_jobs_jellyfish_type_backup AS SELECT * FROM apps_provisioning_jobs;

DROP TABLE IF EXISTS apps_provisioning_steps_jellyfish_type_backup;
CREATE TABLE apps_provisioning_steps_jellyfish_type_backup AS SELECT * FROM apps_provisioning_steps;

DROP TABLE IF EXISTS apps_handoff_links_jellyfish_type_backup;
CREATE TABLE apps_handoff_links_jellyfish_type_backup AS SELECT * FROM apps_handoff_links;

DROP TABLE IF EXISTS apps_apps_next;
CREATE TABLE apps_apps_next (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('static_page', 'web', 'agent_app', 'automation', 'jellyfish', 'container')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'provisioning', 'published', 'archived')),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'team', 'org', 'public')),
  login_required INTEGER NOT NULL DEFAULT 1,
  agent_mcp_enabled INTEGER NOT NULL DEFAULT 0,
  llm_enabled INTEGER NOT NULL DEFAULT 0,
  llm_default_model TEXT,
  llm_endpoint TEXT,
  access_targets_json TEXT NOT NULL DEFAULT '[]',
  data_service_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(org_id, code),
  UNIQUE(org_id, slug)
);

INSERT INTO apps_apps_next (
  id,
  org_id,
  org_slug,
  owner_user_id,
  name,
  code,
  slug,
  description,
  type,
  status,
  visibility,
  login_required,
  agent_mcp_enabled,
  llm_enabled,
  llm_default_model,
  llm_endpoint,
  access_targets_json,
  data_service_id,
  created_at,
  updated_at
)
SELECT
  id,
  org_id,
  org_slug,
  owner_user_id,
  name,
  code,
  slug,
  description,
  type,
  status,
  visibility,
  login_required,
  agent_mcp_enabled,
  llm_enabled,
  llm_default_model,
  llm_endpoint,
  access_targets_json,
  data_service_id,
  created_at,
  updated_at
FROM apps_apps;

DROP TABLE apps_apps;
ALTER TABLE apps_apps_next RENAME TO apps_apps;

INSERT INTO apps_app_resources SELECT * FROM apps_app_resources_jellyfish_type_backup;
INSERT INTO apps_app_secrets SELECT * FROM apps_app_secrets_jellyfish_type_backup;
INSERT INTO apps_app_env_vars SELECT * FROM apps_app_env_vars_jellyfish_type_backup;
INSERT INTO apps_app_kv_items SELECT * FROM apps_app_kv_items_jellyfish_type_backup;
INSERT INTO apps_app_r2_objects SELECT * FROM apps_app_r2_objects_jellyfish_type_backup;
INSERT INTO apps_deployments SELECT * FROM apps_deployments_jellyfish_type_backup;
INSERT INTO apps_app_source_versions SELECT * FROM apps_app_source_versions_jellyfish_type_backup;
INSERT INTO apps_domains SELECT * FROM apps_domains_jellyfish_type_backup;
INSERT INTO apps_migration_registry SELECT * FROM apps_migration_registry_jellyfish_type_backup;
INSERT INTO apps_provisioning_jobs SELECT * FROM apps_provisioning_jobs_jellyfish_type_backup;
INSERT INTO apps_provisioning_steps SELECT * FROM apps_provisioning_steps_jellyfish_type_backup;
INSERT INTO apps_handoff_links SELECT * FROM apps_handoff_links_jellyfish_type_backup;

DROP TABLE apps_app_resources_jellyfish_type_backup;
DROP TABLE apps_app_secrets_jellyfish_type_backup;
DROP TABLE apps_app_env_vars_jellyfish_type_backup;
DROP TABLE apps_app_kv_items_jellyfish_type_backup;
DROP TABLE apps_app_r2_objects_jellyfish_type_backup;
DROP TABLE apps_deployments_jellyfish_type_backup;
DROP TABLE apps_app_source_versions_jellyfish_type_backup;
DROP TABLE apps_domains_jellyfish_type_backup;
DROP TABLE apps_migration_registry_jellyfish_type_backup;
DROP TABLE apps_provisioning_jobs_jellyfish_type_backup;
DROP TABLE apps_provisioning_steps_jellyfish_type_backup;
DROP TABLE apps_handoff_links_jellyfish_type_backup;

CREATE INDEX IF NOT EXISTS idx_apps_apps_org_owner ON apps_apps(org_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_apps_apps_public ON apps_apps(status, visibility, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_apps_jellyfish_code ON apps_apps(code) WHERE type = 'jellyfish';

PRAGMA foreign_keys = ON;
