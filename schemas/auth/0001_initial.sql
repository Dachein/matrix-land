-- Frontier Workspace v0.1 fresh-install schema; no enterprise data.
PRAGMA foreign_keys = ON;
CREATE TABLE auth_app_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  sdk_status TEXT NOT NULL DEFAULT 'pending',
  access_mode TEXT NOT NULL DEFAULT 'public' CHECK (access_mode IN ('public', 'request', 'targeted')),
  access_targets_json TEXT NOT NULL DEFAULT '[]',
  directory_read_scope TEXT NOT NULL DEFAULT 'app' CHECK (directory_read_scope IN ('app', 'company')),
  collaborator_user_ids_json TEXT NOT NULL DEFAULT '[]',
  publisher_user_id TEXT,
  business_owner_user_id TEXT,
  callback_urls_json TEXT NOT NULL DEFAULT '[]',
  launch_url TEXT,
  app_secret_hash TEXT NOT NULL DEFAULT '',
  app_secret_name TEXT NOT NULL DEFAULT '',
  system_role_policy_version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_app_launch_codes (
  code_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_json TEXT NOT NULL DEFAULT '{}',
  callback_url TEXT NOT NULL DEFAULT '',
  redirect_url TEXT,
  request_id TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_app_users (
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  job_title TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  department_id TEXT,
  department_name TEXT NOT NULL DEFAULT '',
  team_id TEXT,
  team_name TEXT NOT NULL DEFAULT '',
  first_login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  login_count INTEGER NOT NULL DEFAULT 0,
  last_decision TEXT,
  last_decision_reason TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'historical')),
  request_id TEXT,
  PRIMARY KEY (app_id, user_id)
);

CREATE TABLE auth_audit_events (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  actor_user_id TEXT,
  client_app_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  decision TEXT CHECK (decision IN ('allow', 'deny') OR decision IS NULL),
  reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_department_sources (
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  source_status TEXT NOT NULL DEFAULT 'active' CHECK (source_status IN ('active', 'inactive')),
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source, external_id)
);

CREATE TABLE auth_departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  parent_id TEXT,
  path_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  source TEXT NOT NULL DEFAULT 'portal',
  external_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_directory_events (
  source TEXT NOT NULL,
  event_key TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('department', 'employee')),
  action TEXT NOT NULL CHECK (action IN ('create', 'deactivate', 'update')),
  external_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'succeeded', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source, event_key)
);

CREATE TABLE auth_directory_sync_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('department', 'employee', 'directory')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('login_unknown_department', 'manual', 'scheduled', 'webhook')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  seen_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_email_otp_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  recipient_ciphertext TEXT,
  email_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ineligible', 'delivery_failed', 'consumed', 'locked')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consume_nonce TEXT,
  provider_message_id TEXT,
  request_id TEXT,
  redirect_path TEXT NOT NULL DEFAULT '/home',
  return_to TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE auth_grants (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  grant_type TEXT NOT NULL DEFAULT 'app_access',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  requested_by_user_id TEXT,
  approved_by_user_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(app_id, user_id, grant_type)
);

CREATE TABLE auth_login_email_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('open', 'company_email_only')),
  allowed_domains_json TEXT NOT NULL DEFAULT '[]',
  updated_by_user_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_mcp_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  oauth_client_id TEXT NOT NULL REFERENCES auth_mcp_oauth_clients(client_id),
  connection_id TEXT NOT NULL REFERENCES auth_mcp_connections(id),
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  resource_url TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_mcp_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  resource_url TEXT NOT NULL DEFAULT '',
  allowed_scopes_json TEXT NOT NULL DEFAULT '[]',
  supported_agents_json TEXT NOT NULL DEFAULT '["claude-code","codex","workbuddy","cursor"]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_mcp_connections (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES auth_mcp_clients(id),
  user_id TEXT NOT NULL,
  agent_type TEXT NOT NULL CHECK (agent_type IN ('claude-code', 'codex', 'workbuddy', 'cursor')),
  display_name TEXT NOT NULL DEFAULT '',
  resource_url TEXT NOT NULL DEFAULT '',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_seen_at TEXT,
  idle_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  revoked_reason TEXT
);

CREATE TABLE auth_mcp_device_codes (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES auth_mcp_clients(id),
  agent_type TEXT NOT NULL CHECK (agent_type IN ('claude-code', 'codex', 'workbuddy', 'cursor')),
  display_name TEXT NOT NULL DEFAULT '',
  resource_url TEXT NOT NULL DEFAULT '',
  requested_scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
  user_id TEXT,
  user_email TEXT,
  user_name TEXT,
  user_role TEXT,
  user_team TEXT,
  user_department TEXT,
  connection_id TEXT,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_mcp_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL DEFAULT '',
  redirect_uris_json TEXT NOT NULL DEFAULT '[]',
  agent_type TEXT NOT NULL DEFAULT 'codex' CHECK (agent_type IN ('claude-code', 'codex', 'cursor', 'workbuddy')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_mcp_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  oauth_client_id TEXT NOT NULL REFERENCES auth_mcp_oauth_clients(client_id),
  connection_id TEXT NOT NULL REFERENCES auth_mcp_connections(id),
  user_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  resource_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotated', 'revoked')),
  expires_at TEXT NOT NULL,
  rotated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_microsoft365_connections (
  user_id TEXT PRIMARY KEY REFERENCES auth_users(id),
  generation TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  credential_ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reauthorize')),
  refresh_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_microsoft365_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(id),
  claimed INTEGER NOT NULL DEFAULT 0,
  credential_ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE auth_miniapp_bind_tickets (
  scene_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired')),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE auth_miniapp_identities (
  app_id TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  bound_at INTEGER NOT NULL,
  last_login_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, subject_hash)
);

CREATE TABLE auth_miniapp_login_tickets (
  ticket_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired')),
  expires_at INTEGER NOT NULL,
  scanned_at INTEGER,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE auth_moka_employee_sync_exclusions (
  external_id TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  excluded INTEGER NOT NULL DEFAULT 1 CHECK (excluded IN (0, 1)),
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_moka_validation_exemptions (
  email TEXT PRIMARY KEY,
  skip_validation INTEGER NOT NULL DEFAULT 1 CHECK (skip_validation IN (0, 1)),
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_oauth_states (
  state_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE auth_remote_mcp_bindings (
  connection_id TEXT NOT NULL REFERENCES auth_remote_mcp_connections(id),
  mate_id TEXT NOT NULL,
  approved_tools_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(connection_id,mate_id)
);

CREATE TABLE auth_remote_mcp_connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES auth_users(id),
  name TEXT NOT NULL,
  server_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK(status IN ('disconnected','connecting','connected','needs_reauth')),
  generation INTEGER NOT NULL DEFAULT 0,
  credential_ciphertext TEXT,
  credential_expires_at INTEGER NOT NULL DEFAULT 0,
  refresh_lease_until INTEGER NOT NULL DEFAULT 0,
  connected_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,user_id,server_url)
);

CREATE TABLE auth_remote_mcp_installations (
  connection_id TEXT NOT NULL REFERENCES auth_remote_mcp_connections(id),
  mate_id TEXT NOT NULL,
  installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_tested_at TEXT,
  last_error_code TEXT,
  tool_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(connection_id, mate_id)
);

CREATE TABLE auth_remote_mcp_states (
  state_hash TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES auth_remote_mcp_connections(id),
  user_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  context_ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE auth_resource_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  audience TEXT NOT NULL DEFAULT '',
  access_mode TEXT NOT NULL DEFAULT 'public' CHECK (access_mode IN ('public', 'request', 'targeted')),
  access_targets_json TEXT NOT NULL DEFAULT '[]',
  collaborator_user_ids_json TEXT NOT NULL DEFAULT '[]',
  allowed_scopes_json TEXT NOT NULL DEFAULT '[]',
  publisher_user_id TEXT,
  business_owner_user_id TEXT,
  system_role_policy_version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_user_invitation_emails (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','uncertain','cancelled')),
  recipient TEXT,
  message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT
);

CREATE TABLE auth_user_memberships (
  user_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('department', 'team', 'group')),
  target_id TEXT NOT NULL,
  target_name TEXT NOT NULL DEFAULT '',
  target_path_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  source TEXT NOT NULL DEFAULT 'portal',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE TABLE auth_user_sources (
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  canonical_email TEXT NOT NULL DEFAULT '',
  source_status TEXT NOT NULL DEFAULT 'active' CHECK (source_status IN ('active', 'inactive')),
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source, external_id)
);

CREATE TABLE auth_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  job_title TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'auth_admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'invited', 'suspended')),
  department_id TEXT,
  department_name TEXT NOT NULL DEFAULT '',
  department_path_json TEXT NOT NULL DEFAULT '[]',
  team_id TEXT,
  team_name TEXT NOT NULL DEFAULT '',
  team_path_json TEXT NOT NULL DEFAULT '[]',
  provider TEXT,
  provider_subject TEXT,
  source TEXT NOT NULL DEFAULT 'portal',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX auth_microsoft365_identity ON auth_microsoft365_connections(tenant_id, object_id);

CREATE INDEX auth_microsoft365_states_expiry ON auth_microsoft365_states(expires_at);

CREATE INDEX idx_auth_app_clients_status ON auth_app_clients(status);

CREATE INDEX idx_auth_app_launch_codes_app_user ON auth_app_launch_codes(app_id, user_id, created_at);

CREATE INDEX idx_auth_app_launch_codes_expires ON auth_app_launch_codes(expires_at);

CREATE INDEX idx_auth_app_users_app_last_login ON auth_app_users(app_id, last_login_at);

CREATE INDEX idx_auth_app_users_user ON auth_app_users(user_id, last_login_at);

CREATE INDEX idx_auth_audit_events_actor_created ON auth_audit_events(actor_user_id, created_at);

CREATE INDEX idx_auth_audit_events_app_created ON auth_audit_events(client_app_id, created_at);

CREATE INDEX idx_auth_audit_events_created ON auth_audit_events(created_at);

CREATE UNIQUE INDEX idx_auth_department_sources_department ON auth_department_sources(source, department_id);

CREATE INDEX idx_auth_departments_parent ON auth_departments(parent_id, status);

CREATE INDEX idx_auth_directory_events_status ON auth_directory_events(source, status, updated_at);

CREATE INDEX idx_auth_directory_sync_runs_lookup ON auth_directory_sync_runs(source, entity_type, started_at);

CREATE INDEX idx_auth_email_otp_email_created ON auth_email_otp_challenges(email_hash, created_at);

CREATE INDEX idx_auth_email_otp_expires ON auth_email_otp_challenges(expires_at, status);

CREATE INDEX idx_auth_email_otp_ip_created ON auth_email_otp_challenges(ip_hash, created_at);

CREATE INDEX idx_auth_grants_lookup ON auth_grants(app_id, user_id, grant_type, status);

CREATE INDEX idx_auth_mcp_connections_client ON auth_mcp_connections(client_id, status, updated_at);

CREATE INDEX idx_auth_mcp_connections_idle ON auth_mcp_connections(status, idle_expires_at);

CREATE INDEX idx_auth_mcp_connections_user ON auth_mcp_connections(user_id, status, updated_at);

CREATE INDEX idx_auth_mcp_device_codes_device_code ON auth_mcp_device_codes(device_code, status);

CREATE INDEX idx_auth_mcp_device_codes_user_code ON auth_mcp_device_codes(user_code, status);

CREATE INDEX idx_auth_mcp_oauth_codes_expiry ON auth_mcp_authorization_codes(expires_at, consumed_at);

CREATE INDEX idx_auth_mcp_refresh_connection ON auth_mcp_refresh_tokens(connection_id, status, expires_at);

CREATE INDEX idx_auth_miniapp_bind_expiry ON auth_miniapp_bind_tickets(expires_at, status);

CREATE INDEX idx_auth_miniapp_bind_user ON auth_miniapp_bind_tickets(user_id, created_at);

CREATE INDEX idx_auth_miniapp_identity_user ON auth_miniapp_identities(user_id, status);

CREATE INDEX idx_auth_miniapp_login_expiry
  ON auth_miniapp_login_tickets(expires_at, status);

CREATE INDEX idx_auth_miniapp_login_user
  ON auth_miniapp_login_tickets(user_id, created_at);

CREATE INDEX idx_auth_oauth_states_expiry ON auth_oauth_states(expires_at);

CREATE INDEX idx_auth_resource_clients_status ON auth_resource_clients(status, updated_at);

CREATE INDEX idx_auth_user_invitation_pending ON auth_user_invitation_emails(status,created_at);

CREATE INDEX idx_auth_user_memberships_target ON auth_user_memberships(target_type, target_id, status);

CREATE UNIQUE INDEX idx_auth_user_sources_email ON auth_user_sources(source, lower(canonical_email)) WHERE canonical_email <> '';

CREATE UNIQUE INDEX idx_auth_user_sources_user ON auth_user_sources(source, user_id);

CREATE INDEX idx_auth_users_department ON auth_users(department_id, status);

CREATE UNIQUE INDEX idx_auth_users_email ON auth_users(lower(email)) WHERE email <> '';

CREATE INDEX idx_auth_users_team ON auth_users(team_id, status);

CREATE TRIGGER auth_user_invitation_insert
AFTER INSERT ON auth_users
WHEN NEW.status='invited' AND trim(NEW.email)<>''
BEGIN
  INSERT OR IGNORE INTO auth_user_invitation_emails(user_id) VALUES(NEW.id);
END;

CREATE TRIGGER auth_user_invitation_transition
AFTER UPDATE OF status,email ON auth_users
WHEN NEW.status='invited' AND trim(NEW.email)<>'' AND (OLD.status<>'invited' OR trim(OLD.email)='')
BEGIN
  INSERT OR IGNORE INTO auth_user_invitation_emails(user_id) VALUES(NEW.id);
END;

CREATE TRIGGER trg_auth_app_launch_codes_personnel_team_empty_ai
AFTER INSERT ON auth_app_launch_codes
WHEN json_valid(NEW.user_json)
  AND (
    json_extract(NEW.user_json, '$.team') IS NOT NULL
    OR json_extract(NEW.user_json, '$.teamId') IS NOT NULL
    OR json_extract(NEW.user_json, '$.teamPath') IS NOT NULL
  )
BEGIN
  UPDATE auth_app_launch_codes
  SET user_json = json_remove(user_json, '$.team', '$.teamId', '$.teamPath')
  WHERE code_hash = NEW.code_hash;
END;

CREATE TRIGGER trg_auth_app_launch_codes_personnel_team_empty_au
AFTER UPDATE OF user_json ON auth_app_launch_codes
WHEN json_valid(NEW.user_json)
  AND (
    json_extract(NEW.user_json, '$.team') IS NOT NULL
    OR json_extract(NEW.user_json, '$.teamId') IS NOT NULL
    OR json_extract(NEW.user_json, '$.teamPath') IS NOT NULL
  )
BEGIN
  UPDATE auth_app_launch_codes
  SET user_json = json_remove(user_json, '$.team', '$.teamId', '$.teamPath')
  WHERE code_hash = NEW.code_hash;
END;

CREATE TRIGGER trg_auth_app_users_personnel_team_empty_ai
AFTER INSERT ON auth_app_users
WHEN NEW.team_id IS NOT NULL OR trim(NEW.team_name) <> ''
BEGIN
  UPDATE auth_app_users
  SET team_id = NULL,
      team_name = ''
  WHERE app_id = NEW.app_id AND user_id = NEW.user_id;
END;

CREATE TRIGGER trg_auth_app_users_personnel_team_empty_au
AFTER UPDATE OF team_id, team_name ON auth_app_users
WHEN NEW.team_id IS NOT NULL OR trim(NEW.team_name) <> ''
BEGIN
  UPDATE auth_app_users
  SET team_id = NULL,
      team_name = ''
  WHERE app_id = NEW.app_id AND user_id = NEW.user_id;
END;

CREATE TRIGGER trg_auth_mcp_device_codes_personnel_team_empty_ai
AFTER INSERT ON auth_mcp_device_codes
WHEN trim(COALESCE(NEW.user_team, '')) <> ''
BEGIN
  UPDATE auth_mcp_device_codes
  SET user_team = NULL
  WHERE device_code = NEW.device_code;
END;

CREATE TRIGGER trg_auth_mcp_device_codes_personnel_team_empty_au
AFTER UPDATE OF user_team ON auth_mcp_device_codes
WHEN trim(COALESCE(NEW.user_team, '')) <> ''
BEGIN
  UPDATE auth_mcp_device_codes
  SET user_team = NULL
  WHERE device_code = NEW.device_code;
END;

CREATE TRIGGER trg_auth_user_memberships_no_team_ai
AFTER INSERT ON auth_user_memberships
WHEN NEW.target_type = 'team'
BEGIN
  DELETE FROM auth_user_memberships
  WHERE user_id = NEW.user_id
    AND target_type = NEW.target_type
    AND target_id = NEW.target_id;
END;

CREATE TRIGGER trg_auth_user_memberships_no_team_au
AFTER UPDATE OF target_type ON auth_user_memberships
WHEN NEW.target_type = 'team'
BEGIN
  DELETE FROM auth_user_memberships
  WHERE user_id = NEW.user_id
    AND target_type = NEW.target_type
    AND target_id = NEW.target_id;
END;

CREATE TRIGGER trg_auth_users_personnel_team_empty_ai
AFTER INSERT ON auth_users
WHEN NEW.team_id IS NOT NULL
  OR trim(NEW.team_name) <> ''
  OR NEW.team_path_json <> '[]'
BEGIN
  UPDATE auth_users
  SET team_id = NULL,
      team_name = '',
      team_path_json = '[]'
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_auth_users_personnel_team_empty_au
AFTER UPDATE OF team_id, team_name, team_path_json ON auth_users
WHEN NEW.team_id IS NOT NULL
  OR trim(NEW.team_name) <> ''
  OR NEW.team_path_json <> '[]'
BEGIN
  UPDATE auth_users
  SET team_id = NULL,
      team_name = '',
      team_path_json = '[]'
  WHERE id = NEW.id;
END;
INSERT INTO auth_login_email_policy (id,mode,allowed_domains_json) VALUES (1,'company_email_only','[]');
