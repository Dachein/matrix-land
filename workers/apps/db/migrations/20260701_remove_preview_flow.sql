PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS apps_apps_next (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
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
  data_service_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(org_id, code),
  UNIQUE(org_id, slug)
);

INSERT OR IGNORE INTO apps_apps_next (
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
  CASE WHEN status = 'preview' THEN 'draft' ELSE status END,
  visibility,
  login_required,
  COALESCE(agent_mcp_enabled, 0),
  COALESCE(llm_enabled, 0),
  llm_default_model,
  llm_endpoint,
  data_service_id,
  created_at,
  updated_at
FROM apps_apps;

CREATE TABLE IF NOT EXISTS apps_app_resources_next (
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

INSERT OR IGNORE INTO apps_app_resources_next (
  id,
  app_id,
  data_service_id,
  type,
  provider,
  resource_name,
  resource_id,
  binding_name,
  environment,
  status,
  created_at
)
SELECT
  id,
  app_id,
  data_service_id,
  type,
  provider,
  resource_name,
  resource_id,
  binding_name,
  CASE WHEN environment = 'shared' THEN 'shared' ELSE 'prod' END,
  status,
  created_at
FROM apps_app_resources
WHERE app_id IN (SELECT id FROM apps_apps_next);

CREATE TABLE IF NOT EXISTS apps_app_secrets_next (
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

INSERT OR IGNORE INTO apps_app_secrets_next (
  id,
  app_id,
  org_id,
  name,
  environment,
  description,
  required,
  status,
  cipher_text,
  cipher_iv,
  algorithm,
  configured_by,
  configured_at,
  declared_by,
  created_at,
  updated_at
)
SELECT
  id,
  app_id,
  org_id,
  name,
  'production',
  description,
  required,
  status,
  cipher_text,
  cipher_iv,
  algorithm,
  configured_by,
  configured_at,
  declared_by,
  created_at,
  updated_at
FROM apps_app_secrets
WHERE app_id IN (SELECT id FROM apps_apps_next)
ORDER BY CASE WHEN environment = 'production' THEN 0 ELSE 1 END;

CREATE TABLE IF NOT EXISTS apps_deployments_next (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('production')),
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  url TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO apps_deployments_next (
  id,
  app_id,
  environment,
  version,
  status,
  url,
  created_by,
  created_at
)
SELECT
  id,
  app_id,
  'production',
  version,
  status,
  url,
  created_by,
  created_at
FROM apps_deployments
WHERE environment = 'production'
  AND status <> 'placeholder'
  AND app_id IN (SELECT id FROM apps_apps_next);

CREATE TABLE IF NOT EXISTS apps_domains_next (
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

INSERT OR IGNORE INTO apps_domains_next (
  id,
  app_id,
  hostname,
  type,
  environment,
  status,
  provider,
  provider_resource_id,
  dns_record_id,
  route_id,
  certificate_status,
  route_status,
  fallback_url,
  last_checked_at,
  error_code,
  error_message,
  created_at
)
SELECT
  id,
  app_id,
  hostname,
  type,
  'production',
  status,
  provider,
  provider_resource_id,
  dns_record_id,
  route_id,
  certificate_status,
  route_status,
  fallback_url,
  last_checked_at,
  error_code,
  error_message,
  created_at
FROM apps_domains
WHERE type IN ('production', 'custom')
  AND app_id IN (SELECT id FROM apps_apps_next);

CREATE TABLE IF NOT EXISTS apps_migration_registry_next (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('production')),
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(app_id, environment, version)
);

INSERT OR IGNORE INTO apps_migration_registry_next (
  id,
  app_id,
  environment,
  version,
  status,
  created_by,
  created_at
)
SELECT
  id,
  app_id,
  'production',
  version,
  status,
  created_by,
  created_at
FROM apps_migration_registry
WHERE app_id IN (SELECT id FROM apps_apps_next)
ORDER BY CASE WHEN environment = 'production' THEN 0 ELSE 1 END;

CREATE TABLE IF NOT EXISTS apps_provisioning_jobs_next (
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

INSERT OR IGNORE INTO apps_provisioning_jobs_next (
  id,
  app_id,
  org_id,
  type,
  status,
  progress,
  current_step,
  error_code,
  error_message,
  requested_by,
  created_at,
  updated_at,
  started_at,
  completed_at
)
SELECT
  id,
  app_id,
  org_id,
  type,
  status,
  progress,
  CASE WHEN current_step = 'deploy_preview' THEN 'health_check' ELSE current_step END,
  error_code,
  error_message,
  requested_by,
  created_at,
  updated_at,
  started_at,
  completed_at
FROM apps_provisioning_jobs
WHERE type IN ('create_app', 'publish_production')
  AND app_id IN (SELECT id FROM apps_apps_next);

CREATE TABLE IF NOT EXISTS apps_provisioning_steps_next (
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

INSERT OR IGNORE INTO apps_provisioning_steps_next (
  id,
  job_id,
  app_id,
  step_order,
  step_key,
  label,
  status,
  progress,
  resource_type,
  resource_id,
  error_code,
  error_message,
  started_at,
  completed_at,
  created_at,
  updated_at
)
SELECT
  id,
  job_id,
  app_id,
  step_order,
  step_key,
  CASE
    WHEN step_key = 'configure_routes' THEN '配置正式与 MCP 入口'
    WHEN step_key = 'finalize_manifest' THEN '生成资源清单'
    ELSE label
  END,
  status,
  CASE WHEN step_key = 'configure_routes' THEN 82 ELSE progress END,
  resource_type,
  resource_id,
  error_code,
  error_message,
  started_at,
  completed_at,
  created_at,
  updated_at
FROM apps_provisioning_steps
WHERE step_key <> 'deploy_preview'
  AND job_id IN (SELECT id FROM apps_provisioning_jobs_next)
  AND app_id IN (SELECT id FROM apps_apps_next);

DROP TABLE IF EXISTS apps_provisioning_steps;
DROP TABLE IF EXISTS apps_provisioning_jobs;
DROP TABLE IF EXISTS apps_migration_registry;
DROP TABLE IF EXISTS apps_domains;
DROP TABLE IF EXISTS apps_deployments;
DROP TABLE IF EXISTS apps_app_secrets;
DROP TABLE IF EXISTS apps_app_resources;
DROP TABLE IF EXISTS apps_apps;

ALTER TABLE apps_apps_next RENAME TO apps_apps;
ALTER TABLE apps_app_resources_next RENAME TO apps_app_resources;
ALTER TABLE apps_app_secrets_next RENAME TO apps_app_secrets;
ALTER TABLE apps_deployments_next RENAME TO apps_deployments;
ALTER TABLE apps_domains_next RENAME TO apps_domains;
ALTER TABLE apps_migration_registry_next RENAME TO apps_migration_registry;
ALTER TABLE apps_provisioning_jobs_next RENAME TO apps_provisioning_jobs;
ALTER TABLE apps_provisioning_steps_next RENAME TO apps_provisioning_steps;

CREATE INDEX IF NOT EXISTS idx_apps_apps_org_owner ON apps_apps(org_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_apps_apps_public ON apps_apps(status, visibility, updated_at);
CREATE INDEX IF NOT EXISTS idx_apps_resources_app ON apps_app_resources(app_id, environment, type);
CREATE INDEX IF NOT EXISTS idx_apps_app_secrets_app ON apps_app_secrets(app_id, environment, name);
CREATE INDEX IF NOT EXISTS idx_apps_deployments_app_env ON apps_deployments(app_id, environment, created_at);
CREATE INDEX IF NOT EXISTS idx_apps_domains_hostname ON apps_domains(hostname);
CREATE INDEX IF NOT EXISTS idx_apps_provisioning_jobs_app ON apps_provisioning_jobs(app_id, created_at);
CREATE INDEX IF NOT EXISTS idx_apps_provisioning_jobs_status ON apps_provisioning_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_apps_provisioning_steps_job ON apps_provisioning_steps(job_id, step_order);

PRAGMA foreign_keys = ON;
