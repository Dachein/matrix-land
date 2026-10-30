CREATE TABLE IF NOT EXISTS apps_skills (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'vanilla',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'private',
  visibility TEXT NOT NULL DEFAULT 'private',
  current_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, slug)
);

CREATE TABLE IF NOT EXISTS apps_skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES apps_skills(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'private_current',
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(skill_id, version)
);

CREATE INDEX IF NOT EXISTS idx_apps_skills_org_owner ON apps_skills(org_id, owner_user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_apps_skill_versions_skill ON apps_skill_versions(skill_id, created_at);
CREATE INDEX IF NOT EXISTS idx_apps_skill_versions_state ON apps_skill_versions(state);
