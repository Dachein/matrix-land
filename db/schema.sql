PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  avatar_url TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'community_admin')),
  assigned_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_role_user
ON user_roles(role, user_id);

CREATE TABLE IF NOT EXISTS user_identity_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  provider TEXT NOT NULL,
  provider_tenant_id TEXT NOT NULL DEFAULT '',
  provider_subject_id TEXT NOT NULL,
  principal_name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  department_path_json TEXT NOT NULL DEFAULT '[]',
  job_title TEXT NOT NULL DEFAULT '',
  profile_json TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, provider_tenant_id, provider_subject_id)
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  owner_team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  sop_markdown TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending_review',
  visibility TEXT NOT NULL DEFAULT 'internal',
  risk_level TEXT NOT NULL DEFAULT 'low',
  review_notes TEXT NOT NULL DEFAULT '',
  rating REAL NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skill_discussions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  owner_team_id TEXT NOT NULL REFERENCES teams(id),
  publisher_user_id TEXT REFERENCES users(id),
  business_owner_user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  name_zh TEXT NOT NULL DEFAULT '',
  name_en TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  app_type TEXT NOT NULL DEFAULT 'web',
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  description_zh TEXT NOT NULL DEFAULT '',
  description_en TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  model_provider TEXT NOT NULL DEFAULT '',
  deployment_type TEXT NOT NULL DEFAULT 'saas',
  deployment_provider TEXT NOT NULL DEFAULT 'other',
  deployment_method TEXT NOT NULL DEFAULT 'serverless',
  data_region TEXT NOT NULL DEFAULT 'hong_kong',
  data_types_json TEXT NOT NULL DEFAULT '[]',
  sensitive_data_json TEXT NOT NULL DEFAULT '[]',
  knowledge_sources_json TEXT NOT NULL DEFAULT '[]',
  user_scope TEXT NOT NULL DEFAULT 'department',
  access_mode TEXT NOT NULL DEFAULT 'public',
  access_targets_json TEXT NOT NULL DEFAULT '[]',
  uses_workspace_auth INTEGER NOT NULL DEFAULT 1,
  risk_level TEXT NOT NULL DEFAULT 'low',
  risk_reason TEXT NOT NULL DEFAULT '',
  permission_notes TEXT NOT NULL DEFAULT '',
  output_notes TEXT NOT NULL DEFAULT '',
  review_notes TEXT NOT NULL DEFAULT '',
  current_version TEXT NOT NULL DEFAULT '1.0.0',
  changelog TEXT NOT NULL DEFAULT '',
  launch_url TEXT NOT NULL,
  callback_url TEXT NOT NULL DEFAULT '',
  sdk_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'pending_review',
  visibility TEXT NOT NULL DEFAULT 'internal',
  listed_at TEXT,
  delisted_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scopes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'low'
);

CREATE TABLE IF NOT EXISTS app_scopes (
  app_id TEXT NOT NULL REFERENCES apps(id),
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  PRIMARY KEY (app_id, scope_id)
);

CREATE TABLE IF NOT EXISTS skill_scopes (
  skill_id TEXT NOT NULL REFERENCES skills(id),
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  PRIMARY KEY (skill_id, scope_id)
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  owner_team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  endpoint_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  risk_level TEXT NOT NULL DEFAULT 'low',
  review_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mcp_tools (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  input_schema_json TEXT NOT NULL DEFAULT '{}',
  risk_level TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'pending_review',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(server_id, name)
);

CREATE TABLE IF NOT EXISTS mcp_tool_scopes (
  tool_id TEXT NOT NULL REFERENCES mcp_tools(id),
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  PRIMARY KEY (tool_id, scope_id)
);

CREATE TABLE IF NOT EXISTS skill_mcp_tools (
  skill_id TEXT NOT NULL REFERENCES skills(id),
  tool_id TEXT NOT NULL REFERENCES mcp_tools(id),
  PRIMARY KEY (skill_id, tool_id)
);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  app_id TEXT REFERENCES apps(id),
  skill_id TEXT REFERENCES skills(id),
  tool_id TEXT REFERENCES mcp_tools(id),
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  grant_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  expires_at TEXT,
  approved_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS access_tokens (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  token_kind TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

CREATE INDEX IF NOT EXISTS idx_users_team_id ON users(team_id);
CREATE INDEX IF NOT EXISTS idx_user_identity_profiles_provider_subject ON user_identity_profiles(provider, provider_tenant_id, provider_subject_id);
CREATE INDEX IF NOT EXISTS idx_user_identity_profiles_principal_name ON user_identity_profiles(provider, principal_name);
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status);
CREATE INDEX IF NOT EXISTS idx_grants_lookup ON grants(user_id, app_id, skill_id, tool_id, scope_id, status);
CREATE INDEX IF NOT EXISTS idx_access_tokens_subject ON access_tokens(subject_type, subject_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_target_created
ON audit_logs(action, target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_scenario_created ON activity_events(scenario, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_events_actor_created ON activity_events(actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_events_target_created ON activity_events(target_type, target_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_source_event ON activity_events(source, source_event_id) WHERE source_event_id IS NOT NULL;

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
  community_contribution_points INTEGER NOT NULL DEFAULT 0 CHECK (community_contribution_points >= 0),
  badge_count INTEGER NOT NULL DEFAULT 0,
  category_counts_json TEXT NOT NULL DEFAULT '{}',
  next_badges_json TEXT NOT NULL DEFAULT '[]',
  profile_json TEXT NOT NULL DEFAULT '{}',
  recomputed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_portal_badge_definitions_active ON portal_badge_definitions(journey_key, version, active, sort_order);
CREATE INDEX IF NOT EXISTS idx_portal_user_badges_awarded ON portal_user_badges(user_id, awarded_at);

CREATE TABLE IF NOT EXISTS skill_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skill_catalog_metadata (
  skill_id TEXT PRIMARY KEY REFERENCES skills(id),
  category_id TEXT NOT NULL REFERENCES skill_categories(id),
  kind TEXT NOT NULL DEFAULT 'vanilla',
  current_version TEXT NOT NULL DEFAULT '1.0.0',
  cover_image_url TEXT NOT NULL DEFAULT '',
  install_count INTEGER NOT NULL DEFAULT 0,
  discussion_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  version TEXT NOT NULL,
  changelog TEXT NOT NULL DEFAULT '',
  artifact_type TEXT NOT NULL DEFAULT 'skill_md',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(skill_id, version)
);

CREATE TABLE IF NOT EXISTS skill_mcp_dependencies (
  skill_id TEXT NOT NULL REFERENCES skills(id),
  server_id TEXT NOT NULL REFERENCES mcp_servers(id),
  required_version TEXT,
  PRIMARY KEY (skill_id, server_id)
);

CREATE TABLE IF NOT EXISTS app_catalog_metadata (
  app_id TEXT PRIMARY KEY REFERENCES apps(id),
  category_id TEXT NOT NULL REFERENCES skill_categories(id),
  cover_image_url TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  screenshots_json TEXT NOT NULL DEFAULT '[]',
  view_count INTEGER NOT NULL DEFAULT 0,
  launch_count INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  favorite_count INTEGER NOT NULL DEFAULT 0,
  rating REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  discussion_count INTEGER NOT NULL DEFAULT 0,
  active_user_count INTEGER NOT NULL DEFAULT 0,
  monthly_users INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS portal_discussions (
  id TEXT PRIMARY KEY,
  author_user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  tag TEXT NOT NULL,
  linked_skill_id TEXT REFERENCES skills(id),
  excerpt TEXT NOT NULL,
  replies INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  last_active TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forum_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  owner_team_id TEXT REFERENCES teams(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forum_topics (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES forum_categories(id),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  is_anonymous INTEGER NOT NULL DEFAULT 0 CHECK (is_anonymous IN (0, 1)),
  anonymous_persona TEXT,
  title TEXT NOT NULL,
  topic_type TEXT NOT NULL DEFAULT 'question',
  bu_team_id TEXT REFERENCES teams(id),
  linked_skill_id TEXT REFERENCES skills(id),
  linked_app_id TEXT REFERENCES apps(id),
  linked_mcp_server_id TEXT REFERENCES mcp_servers(id),
  excerpt TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'portal',
  idempotency_key TEXT,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  is_pinned INTEGER NOT NULL DEFAULT 0,
  pinned_by_user_id TEXT REFERENCES users(id),
  pinned_at TEXT,
  reply_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_forum_topics_author_idempotency
ON forum_topics(author_user_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_forum_topics_author_content_created
ON forum_topics(author_user_id, content_hash, created_at)
WHERE content_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS forum_posts (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES forum_topics(id),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  is_anonymous INTEGER NOT NULL DEFAULT 0 CHECK (is_anonymous IN (0, 1)),
  anonymous_persona TEXT,
  body_markdown TEXT NOT NULL,
  body_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'portal' CHECK (source IN ('portal', 'mcp')),
  parent_post_id TEXT REFERENCES forum_posts(id),
  is_pinned INTEGER NOT NULL DEFAULT 0,
  pinned_by_user_id TEXT REFERENCES users(id),
  pinned_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forum_contributor_awards (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  post_id TEXT NOT NULL UNIQUE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id),
  awarded_by_user_id TEXT NOT NULL REFERENCES users(id),
  points INTEGER NOT NULL DEFAULT 10 CHECK (points BETWEEN 1 AND 100),
  note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_forum_contributor_awards_recipient_created
ON forum_contributor_awards(recipient_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_forum_contributor_awards_topic_created
ON forum_contributor_awards(topic_id, created_at DESC);

CREATE TABLE IF NOT EXISTS forum_post_likes (
  post_id TEXT NOT NULL REFERENCES forum_posts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  reaction TEXT NOT NULL DEFAULT 'thumbsup',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS forum_topic_tags (
  topic_id TEXT NOT NULL REFERENCES forum_topics(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (topic_id, tag)
);

CREATE TABLE IF NOT EXISTS forum_attachments (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES forum_topics(id),
  post_id TEXT REFERENCES forum_posts(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  storage_provider TEXT NOT NULL DEFAULT 'r2',
  storage_key TEXT NOT NULL,
  public_url TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forum_link_embeds (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES forum_topics(id),
  post_id TEXT REFERENCES forum_posts(id),
  url TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'link',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  preview_image_url TEXT,
  embed_type TEXT NOT NULL DEFAULT 'link',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forum_content_plugins (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES forum_topics(id),
  post_id TEXT REFERENCES forum_posts(id),
  plugin_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forum_mentions (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES forum_topics(id),
  post_id TEXT REFERENCES forum_posts(id),
  mentioned_user_id TEXT NOT NULL REFERENCES users(id),
  mention_text TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forum_notifications (
  id TEXT PRIMARY KEY,
  recipient_user_id TEXT NOT NULL REFERENCES users(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  topic_id TEXT REFERENCES forum_topics(id),
  post_id TEXT REFERENCES forum_posts(id),
  notification_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_user_id TEXT NOT NULL REFERENCES users(id),
  actor_user_id TEXT REFERENCES users(id),
  notification_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  parent_type TEXT,
  parent_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  href TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS user_usage (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  quota_limit INTEGER NOT NULL DEFAULT 0,
  quota_used INTEGER NOT NULL DEFAULT 0,
  reset_date TEXT NOT NULL,
  api_keys INTEGER NOT NULL DEFAULT 0,
  active_tokens INTEGER NOT NULL DEFAULT 0,
  last_token_refresh TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_usage_snapshot_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'ready', 'error')),
  external_user_id TEXT,
  trigger_type TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  source_from_date TEXT NOT NULL,
  source_to_date TEXT NOT NULL,
  data_through_date TEXT NOT NULL,
  data_through_at TEXT,
  activity_watermark_at TEXT,
  keyset_fingerprint TEXT,
  source_row_count INTEGER NOT NULL DEFAULT 0,
  attributed_row_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS gateway_usage_daily_snapshots (
  usage_date TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  run_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, external_user_id, token_id)
);

CREATE TABLE IF NOT EXISTS gateway_usage_daily_snapshot_staging (
  run_id TEXT NOT NULL REFERENCES gateway_usage_snapshot_runs(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, usage_date, external_user_id, token_id)
);

CREATE TABLE IF NOT EXISTS gateway_usage_daily_model_snapshots (
  usage_date TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  model_group TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'unknown',
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  input_cost_usd REAL NOT NULL DEFAULT 0,
  output_cost_usd REAL NOT NULL DEFAULT 0,
  cache_read_cost_usd REAL NOT NULL DEFAULT 0,
  cache_write_cost_usd REAL NOT NULL DEFAULT 0,
  tool_cost_usd REAL NOT NULL DEFAULT 0,
  original_cost_usd REAL NOT NULL DEFAULT 0,
  discount_usd REAL NOT NULL DEFAULT 0,
  billed_cost_usd REAL NOT NULL DEFAULT 0,
  run_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, external_user_id, token_id, model_group, upstream_model)
);

CREATE TABLE IF NOT EXISTS gateway_usage_daily_model_snapshot_staging (
  run_id TEXT NOT NULL REFERENCES gateway_usage_snapshot_runs(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  model_group TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'unknown',
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  input_cost_usd REAL NOT NULL DEFAULT 0,
  output_cost_usd REAL NOT NULL DEFAULT 0,
  cache_read_cost_usd REAL NOT NULL DEFAULT 0,
  cache_write_cost_usd REAL NOT NULL DEFAULT 0,
  tool_cost_usd REAL NOT NULL DEFAULT 0,
  original_cost_usd REAL NOT NULL DEFAULT 0,
  discount_usd REAL NOT NULL DEFAULT 0,
  billed_cost_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, usage_date, external_user_id, token_id, model_group, upstream_model)
);

CREATE TABLE IF NOT EXISTS gateway_usage_user_snapshot_staging (
  run_id TEXT NOT NULL REFERENCES gateway_usage_snapshot_runs(id) ON DELETE CASCADE,
  external_user_id TEXT NOT NULL,
  monthly_budget_usd REAL,
  PRIMARY KEY (run_id, external_user_id)
);

CREATE TABLE IF NOT EXISTS gateway_usage_user_snapshots (
  external_user_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'error')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  updated_at TEXT NOT NULL,
  data_through_date TEXT NOT NULL,
  data_through_at TEXT,
  last_checked_at TEXT,
  activity_watermark_at TEXT,
  last_reconciled_at TEXT,
  keyset_fingerprint TEXT,
  trigger_type TEXT,
  cumulative_tokens INTEGER NOT NULL DEFAULT 0,
  peak_daily_tokens INTEGER NOT NULL DEFAULT 0,
  monthly_budget_usd REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS gateway_usage_summary_refresh_state (
  external_user_id TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_health_runs (
  id TEXT PRIMARY KEY,
  scheduled_at TEXT NOT NULL UNIQUE,
  slot_local TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  status TEXT NOT NULL CHECK (status IN ('running', 'operational', 'degraded', 'outage', 'error')),
  model_count INTEGER NOT NULL DEFAULT 0,
  operational_count INTEGER NOT NULL DEFAULT 0,
  degraded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS model_health_results (
  run_id TEXT NOT NULL REFERENCES model_health_runs(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('operational', 'degraded', 'failed')),
  latency_ms INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  response_excerpt TEXT NOT NULL DEFAULT '',
  tested_at TEXT NOT NULL,
  PRIMARY KEY (run_id, model_id)
);

CREATE TABLE IF NOT EXISTS review_queue (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  title TEXT NOT NULL,
  owner_team_id TEXT NOT NULL REFERENCES teams(id),
  risk_level TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'open',
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_skill_catalog_kind ON skill_catalog_metadata(kind);
CREATE INDEX IF NOT EXISTS idx_portal_discussions_last_active ON portal_discussions(last_active);
CREATE INDEX IF NOT EXISTS idx_forum_topics_category_active ON forum_topics(category_id, last_active_at);
CREATE INDEX IF NOT EXISTS idx_forum_topics_pinned_active ON forum_topics(is_pinned, pinned_at, last_active_at);
CREATE INDEX IF NOT EXISTS idx_forum_topics_bu_active ON forum_topics(bu_team_id, last_active_at);
CREATE INDEX IF NOT EXISTS idx_forum_posts_topic_created ON forum_posts(topic_id, created_at);
CREATE INDEX IF NOT EXISTS idx_forum_posts_topic_pinned_created ON forum_posts(topic_id, is_pinned, pinned_at, created_at);
CREATE INDEX IF NOT EXISTS idx_forum_attachments_topic_order ON forum_attachments(topic_id, display_order);
CREATE INDEX IF NOT EXISTS idx_forum_link_embeds_topic ON forum_link_embeds(topic_id);
CREATE INDEX IF NOT EXISTS idx_forum_plugins_topic ON forum_content_plugins(topic_id);
CREATE INDEX IF NOT EXISTS idx_forum_mentions_user_created ON forum_mentions(mentioned_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_forum_notifications_recipient_status ON forum_notifications(recipient_user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_status_created ON notifications(recipient_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_entity ON notifications(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue(status);
CREATE INDEX IF NOT EXISTS idx_gateway_usage_snapshot_runs_started ON gateway_usage_snapshot_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_gateway_usage_snapshot_runs_user_started ON gateway_usage_snapshot_runs(external_user_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_usage_snapshot_runs_user_running ON gateway_usage_snapshot_runs(external_user_id) WHERE external_user_id IS NOT NULL AND status = 'running';
CREATE INDEX IF NOT EXISTS idx_gateway_usage_daily_user_date ON gateway_usage_daily_snapshots(external_user_id, usage_date);
CREATE INDEX IF NOT EXISTS idx_gateway_usage_daily_user_token_date ON gateway_usage_daily_snapshots(external_user_id, token_id, usage_date);
CREATE INDEX IF NOT EXISTS idx_gateway_usage_daily_model_user_date ON gateway_usage_daily_model_snapshots(external_user_id, usage_date);
CREATE INDEX IF NOT EXISTS idx_gateway_usage_daily_model_group_date ON gateway_usage_daily_model_snapshots(model_group, usage_date);
CREATE INDEX IF NOT EXISTS idx_gateway_usage_daily_model_user_token_date ON gateway_usage_daily_model_snapshots(external_user_id, token_id, usage_date);
CREATE INDEX IF NOT EXISTS idx_gateway_usage_daily_model_token_date ON gateway_usage_daily_model_snapshots(token_id, usage_date);
CREATE INDEX IF NOT EXISTS idx_model_health_runs_scheduled ON model_health_runs(scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_health_results_model_run ON model_health_results(model_id, run_id);

CREATE TABLE IF NOT EXISTS publication_listings (
  id TEXT PRIMARY KEY,
  listing_type TEXT NOT NULL CHECK (listing_type IN ('skill', 'app')),
  target_plane TEXT NOT NULL DEFAULT 'portal' CHECK (target_plane IN ('portal', 'apps')),
  target_id TEXT NOT NULL,
  listed_version_id TEXT NOT NULL DEFAULT '',
  review_version_id TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  owner_alias_name TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  cover_image_url TEXT NOT NULL DEFAULT '',
  category_id TEXT REFERENCES skill_categories(id),
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'listed', 'delisted', 'deleted')),
  desired_status TEXT NOT NULL DEFAULT 'pending_review' CHECK (desired_status IN ('pending_review', 'listed', 'delisted', 'deleted')),
  effective_status TEXT NOT NULL DEFAULT 'pending_review' CHECK (effective_status IN ('pending_review', 'listed', 'delisted', 'deleted')),
  publication_status TEXT NOT NULL DEFAULT 'synced' CHECK (publication_status IN ('synced', 'pending', 'failed', 'not_required')),
  publication_error_code TEXT NOT NULL DEFAULT '',
  publication_updated_at TEXT,
  visibility TEXT NOT NULL DEFAULT 'org' CHECK (visibility IN ('org', 'team', 'private')),
  home_display TEXT NOT NULL DEFAULT '' CHECK (home_display IN ('', 'recommended', 'normal', 'hidden')),
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
  review_notes TEXT NOT NULL DEFAULT '',
  builder_snapshot_json TEXT NOT NULL DEFAULT '{}',
  install_count INTEGER NOT NULL DEFAULT 0,
  agent_add_count INTEGER NOT NULL DEFAULT 0,
  zip_download_count INTEGER NOT NULL DEFAULT 0,
  visit_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  rating REAL NOT NULL DEFAULT 0,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(listing_type, target_id)
);

CREATE TABLE IF NOT EXISTS publication_publication_outbox (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES publication_listings(id) ON DELETE RESTRICT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('app', 'resource', 'none')),
  target_id TEXT NOT NULL,
  desired_status TEXT NOT NULL CHECK (desired_status IN ('pending_review', 'listed', 'delisted', 'deleted')),
  endpoint_path TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'completed', 'failed', 'superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_http_status INTEGER,
  last_request_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE(listing_id, desired_status, payload_hash)
);

CREATE TABLE IF NOT EXISTS publication_installations (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES publication_listings(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  version TEXT,
  install_type TEXT NOT NULL DEFAULT 'user' CHECK (install_type IN ('user', 'team', 'download', 'bookmark')),
  source TEXT NOT NULL DEFAULT 'publication',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(listing_id, user_id, install_type)
);

CREATE TABLE IF NOT EXISTS publication_comments (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES publication_listings(id),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  parent_comment_id TEXT REFERENCES publication_comments(id),
  body_markdown TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'deleted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS publication_versions (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES publication_listings(id),
  version TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('skill_md', 'app_config', 'document', 'package')),
  artifact_url TEXT,
  artifact_body TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  changelog TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(listing_id, version)
);

CREATE INDEX IF NOT EXISTS idx_publication_listings_type_status ON publication_listings(listing_type, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_publication_listings_effective_status ON publication_listings(listing_type, effective_status, updated_at);
CREATE INDEX IF NOT EXISTS idx_publication_publication_outbox_ready ON publication_publication_outbox(state, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_publication_publication_outbox_listing ON publication_publication_outbox(listing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_publication_installations_user ON publication_installations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_publication_installations_listing ON publication_installations(listing_id, created_at);
CREATE INDEX IF NOT EXISTS idx_publication_comments_listing ON publication_comments(listing_id, created_at);
CREATE INDEX IF NOT EXISTS idx_publication_versions_listing ON publication_versions(listing_id, created_at);
