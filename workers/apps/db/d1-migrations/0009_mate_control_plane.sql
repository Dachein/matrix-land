-- Mate is a stable cloud identity. Deploying Preview creates an immutable
-- workspace.agentruntime/v1 candidate; publishing separately activates that exact release.
CREATE TABLE IF NOT EXISTS apps_mates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
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
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE(mate_id, version)
);

CREATE INDEX IF NOT EXISTS idx_apps_mates_org_owner
  ON apps_mates(org_id, owner_user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_apps_mate_releases_mate
  ON apps_mate_releases(mate_id, version DESC);
