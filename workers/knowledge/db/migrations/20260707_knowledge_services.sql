CREATE TABLE IF NOT EXISTS knowledge_services (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES knowledge_namespaces(id) ON DELETE CASCADE,
  folder_object_id TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  handbook_object_id TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team', 'company', 'public')),
  update_mode TEXT NOT NULL DEFAULT 'manual' CHECK (update_mode IN ('manual', 'auto')),
  created_by_user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(namespace_id, folder_object_id)
);

CREATE TABLE IF NOT EXISTS knowledge_service_versions (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES knowledge_services(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  handbook_version_id TEXT NOT NULL REFERENCES knowledge_object_versions(id) ON DELETE RESTRICT,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  object_versions_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by_user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(service_id, version)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_services_folder ON knowledge_services(folder_object_id, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_service_versions_service ON knowledge_service_versions(service_id, status, version);
