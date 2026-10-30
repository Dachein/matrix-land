CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL,
  action_type TEXT NOT NULL,
  actor_user_id TEXT,
  actor_name TEXT NOT NULL,
  actor_avatar_url TEXT NOT NULL DEFAULT '',
  actor_team TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_title TEXT NOT NULL,
  parent_type TEXT,
  parent_id TEXT,
  parent_title TEXT,
  summary TEXT NOT NULL,
  href TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'org',
  team_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'portal',
  source_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_events_scenario_created ON activity_events(scenario, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_events_actor_created ON activity_events(actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_events_target_created ON activity_events(target_type, target_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_source_event ON activity_events(source, source_event_id) WHERE source_event_id IS NOT NULL;
