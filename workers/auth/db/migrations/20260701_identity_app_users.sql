CREATE TABLE IF NOT EXISTS auth_departments (
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

CREATE TABLE IF NOT EXISTS auth_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',
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

CREATE TABLE IF NOT EXISTS auth_user_memberships (
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

CREATE TABLE IF NOT EXISTS auth_app_users (
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_email ON auth_users(lower(email)) WHERE email <> '';
CREATE INDEX IF NOT EXISTS idx_auth_users_department ON auth_users(department_id, status);
CREATE INDEX IF NOT EXISTS idx_auth_users_team ON auth_users(team_id, status);
CREATE INDEX IF NOT EXISTS idx_auth_departments_parent ON auth_departments(parent_id, status);
CREATE INDEX IF NOT EXISTS idx_auth_user_memberships_target ON auth_user_memberships(target_type, target_id, status);
CREATE INDEX IF NOT EXISTS idx_auth_app_users_app_last_login ON auth_app_users(app_id, last_login_at);
CREATE INDEX IF NOT EXISTS idx_auth_app_users_user ON auth_app_users(user_id, last_login_at);
