CREATE TABLE IF NOT EXISTS portal_journey_levels (
  journey_key TEXT NOT NULL DEFAULT 'default',
  version TEXT NOT NULL DEFAULT 'v1',
  level_key TEXT NOT NULL,
  rank INTEGER NOT NULL,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL,
  description_zh TEXT NOT NULL DEFAULT '',
  description_en TEXT NOT NULL DEFAULT '',
  min_points INTEGER NOT NULL DEFAULT 0,
  criteria_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (journey_key, version, level_key)
);

CREATE TABLE IF NOT EXISTS portal_badge_definitions (
  badge_key TEXT PRIMARY KEY,
  journey_key TEXT NOT NULL DEFAULT 'default',
  version TEXT NOT NULL DEFAULT 'v1',
  category TEXT NOT NULL CHECK (category IN ('foundation', 'community', 'usage', 'builder', 'impact')),
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL,
  description_zh TEXT NOT NULL DEFAULT '',
  description_en TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 0,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('computed', 'profile', 'gateway', 'forum', 'market', 'apps', 'manual')),
  trigger_config_json TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS portal_user_badges (
  user_id TEXT NOT NULL REFERENCES users(id),
  badge_key TEXT NOT NULL REFERENCES portal_badge_definitions(badge_key),
  source TEXT NOT NULL DEFAULT 'computed',
  source_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  awarded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, badge_key)
);

CREATE TABLE IF NOT EXISTS portal_user_journey_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  journey_key TEXT NOT NULL DEFAULT 'default',
  version TEXT NOT NULL DEFAULT 'v1',
  current_level_key TEXT NOT NULL DEFAULT 'newcomer',
  total_points INTEGER NOT NULL DEFAULT 0,
  badge_count INTEGER NOT NULL DEFAULT 0,
  category_counts_json TEXT NOT NULL DEFAULT '{}',
  next_badges_json TEXT NOT NULL DEFAULT '[]',
  profile_json TEXT NOT NULL DEFAULT '{}',
  recomputed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_portal_badge_definitions_active ON portal_badge_definitions(journey_key, version, active, sort_order);
CREATE INDEX IF NOT EXISTS idx_portal_user_badges_awarded ON portal_user_badges(user_id, awarded_at);
