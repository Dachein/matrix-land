PRAGMA foreign_keys=off;

DROP INDEX IF EXISTS idx_auth_users_email;
DROP INDEX IF EXISTS idx_auth_users_department;
DROP INDEX IF EXISTS idx_auth_users_team;

CREATE TABLE auth_users_new (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  job_title TEXT NOT NULL DEFAULT '',
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

INSERT INTO auth_users_new (
  id,
  email,
  job_title,
  name,
  role,
  status,
  department_id,
  department_name,
  department_path_json,
  team_id,
  team_name,
  team_path_json,
  provider,
  provider_subject,
  source,
  first_seen_at,
  last_seen_at,
  updated_at
)
SELECT
  id,
  email,
  job_title,
  name,
  role,
  status,
  department_id,
  department_name,
  department_path_json,
  team_id,
  team_name,
  team_path_json,
  provider,
  provider_subject,
  source,
  first_seen_at,
  last_seen_at,
  updated_at
FROM auth_users;

DROP TABLE auth_users;
ALTER TABLE auth_users_new RENAME TO auth_users;

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_email ON auth_users(lower(email)) WHERE email <> '';
CREATE INDEX IF NOT EXISTS idx_auth_users_department ON auth_users(department_id, status);
CREATE INDEX IF NOT EXISTS idx_auth_users_team ON auth_users(team_id, status);

PRAGMA foreign_keys=on;
