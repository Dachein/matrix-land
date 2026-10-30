PRAGMA foreign_keys = OFF;

CREATE TABLE knowledge_objects (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL,
  parent_path TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  UNIQUE(namespace_id, path)
);

CREATE TABLE knowledge_services (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL,
  folder_object_id TEXT NOT NULL,
  handbook_object_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  visibility TEXT NOT NULL DEFAULT 'private',
  access_targets_json TEXT NOT NULL DEFAULT '[]',
  update_mode TEXT NOT NULL DEFAULT 'manual',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE knowledge_permissions (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL,
  object_id TEXT,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  role TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

CREATE UNIQUE INDEX idx_knowledge_permissions_unique_active
  ON knowledge_permissions(namespace_id, IFNULL(object_id, ''), subject_type, subject_id, role)
  WHERE revoked_at IS NULL;

CREATE TABLE knowledge_shares (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  visibility TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

INSERT INTO knowledge_objects (id, namespace_id, parent_path, path, file_name, object_kind)
VALUES
  ('folder-private', 'ns-1', '', 'Private', 'Private', 'folder'),
  ('handbook-private', 'ns-1', 'Private', 'Private/skill.md', 'skill.md', 'file'),
  ('folder-company', 'ns-1', '', 'Company', 'Company', 'folder'),
  ('handbook-company', 'ns-1', 'Company', 'Company/skill.md', 'skill.md', 'file'),
  ('folder-conflict', 'ns-1', '', 'Conflict', 'Conflict', 'folder'),
  ('legacy-conflict', 'ns-1', 'Conflict', 'Conflict/skill.md', 'skill.md', 'file'),
  ('handbook-conflict', 'ns-1', 'Conflict', 'Conflict/handbook.md', 'handbook.md', 'file');

INSERT INTO knowledge_services (
  id, namespace_id, folder_object_id, handbook_object_id, status, visibility, access_targets_json
)
VALUES
  ('service-private', 'ns-1', 'folder-private', 'handbook-private', 'active', 'private', '[]'),
  ('service-company', 'ns-1', 'folder-company', 'handbook-company', 'active', 'company', '["company:org-a"]'),
  ('service-conflict', 'ns-1', 'folder-conflict', 'legacy-conflict', 'active', 'private', '[]');

INSERT INTO knowledge_permissions (id, namespace_id, object_id, subject_type, subject_id, role, updated_at)
VALUES
  ('grant-old', 'ns-1', 'folder-private', 'user', 'user-1', 'viewer', '2026-07-01 00:00:00'),
  ('grant-new', 'ns-1', 'folder-private', 'user', 'user-1', 'editor', '2026-07-02 00:00:00'),
  ('grant-owner', 'ns-1', 'folder-private', 'user', 'user-2', 'owner', '2026-07-02 00:00:00');

INSERT INTO knowledge_shares (id, namespace_id, object_id, visibility, created_at)
VALUES
  ('share-old', 'ns-1', 'file-1', 'public', '2026-07-01 00:00:00'),
  ('share-new', 'ns-1', 'file-1', 'public', '2026-07-02 00:00:00');
