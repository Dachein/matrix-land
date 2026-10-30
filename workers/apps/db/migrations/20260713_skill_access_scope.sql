PRAGMA foreign_keys=off;

DROP TABLE IF EXISTS apps_skill_versions_access_scope_backup;

CREATE TABLE apps_skill_versions_access_scope_backup AS
SELECT * FROM apps_skill_versions;

DROP TABLE IF EXISTS apps_skills_new;

CREATE TABLE apps_skills_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
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

INSERT INTO apps_skills_new (
  id,
  org_id,
  org_slug,
  owner_user_id,
  name,
  slug,
  description,
  kind,
  capabilities_json,
  status,
  visibility,
  access_targets_json,
  login_required,
  current_version_id,
  created_at,
  updated_at
)
SELECT
  id,
  org_id,
  org_slug,
  owner_user_id,
  name,
  slug,
  description,
  kind,
  capabilities_json,
  status,
  visibility,
  '[]',
  1,
  current_version_id,
  created_at,
  updated_at
FROM apps_skills;

DROP TABLE apps_skills;

ALTER TABLE apps_skills_new RENAME TO apps_skills;

CREATE INDEX IF NOT EXISTS idx_apps_skills_org_owner ON apps_skills(org_id, owner_user_id, status);

DELETE FROM apps_skill_versions;

INSERT INTO apps_skill_versions
SELECT * FROM apps_skill_versions_access_scope_backup;

DROP TABLE apps_skill_versions_access_scope_backup;

PRAGMA foreign_keys=on;
