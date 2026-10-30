-- Keep the App catalog focused on the first live integration: Workspace Onboarding.

INSERT OR IGNORE INTO teams (id, name, slug) VALUES
  ('team-ai-adoption', 'AI Adoption', 'ai-adoption');

INSERT OR IGNORE INTO users (id, team_id, name, email, role, status) VALUES
  ('00000000-0000-0000-0000-000000000001', 'team-ai-adoption', 'Removed Account 1', 'removed-user-0001@example.invalid', 'member', 'deleted');

INSERT OR IGNORE INTO skill_categories (id, name, slug) VALUES
  ('category-knowledge', 'Knowledge', 'knowledge');

INSERT OR IGNORE INTO apps (
  id,
  owner_team_id,
  publisher_user_id,
  business_owner_user_id,
  name,
  name_zh,
  name_en,
  subtitle,
  app_type,
  slug,
  description,
  description_zh,
  description_en,
  launch_url,
  sdk_status,
  status
) VALUES (
  'app-growth-lab',
  'team-ai-adoption',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'Workspace Onboarding',
  'Workspace Onboarding',
  'Workspace Onboarding',
  'Employee onboarding and account activation portal',
  'web',
  'workspace-onboarding',
  'Workspace employee onboarding portal for account login, access activation, and HR-assisted onboarding.',
  'Workspace 员工入职与账号开通门户，用于员工登录、访问激活和 HR 协助开通。',
  'Workspace employee onboarding portal for account login, access activation, and HR-assisted onboarding.',
  'https://workspace-onboarding.vercel.app/login',
  'pending',
  'listed'
);

UPDATE apps
SET
  owner_team_id = 'team-ai-adoption',
  publisher_user_id = '00000000-0000-0000-0000-000000000001',
  business_owner_user_id = '00000000-0000-0000-0000-000000000001',
  name = 'Workspace Onboarding',
  name_zh = 'Workspace Onboarding',
  name_en = 'Workspace Onboarding',
  subtitle = 'Employee onboarding and account activation portal',
  app_type = 'web',
  slug = 'workspace-onboarding',
  description = 'Workspace employee onboarding portal for account login, access activation, and HR-assisted onboarding.',
  description_zh = 'Workspace 员工入职与账号开通门户，用于员工登录、访问激活和 HR 协助开通。',
  description_en = 'Workspace employee onboarding portal for account login, access activation, and HR-assisted onboarding.',
  launch_url = 'https://workspace-onboarding.vercel.app/login',
  callback_url = '',
  sdk_status = 'pending',
  status = 'listed',
  model = 'Manual onboarding workflow',
  model_provider = 'Manual / internal workflow',
  deployment_type = 'saas',
  deployment_provider = 'vercel',
  deployment_method = 'serverless',
  data_region = 'hong_kong',
  data_types_json = '["Employee information","Internal onboarding materials"]',
  sensitive_data_json = '["employee_information","internal_materials"]',
  knowledge_sources_json = '["HR onboarding policy","Internal account activation checklist"]',
  user_scope = 'custom',
  access_mode = 'request',
  access_targets_json = '["Workspace employees","HR approved users"]',
  uses_workspace_auth = 0,
  risk_level = 'medium',
  risk_reason = 'Handles employee login and onboarding data with internal access control. No customer or transaction data is processed.',
  permission_notes = 'Public request flow requires publisher approval by email before access is granted.',
  output_notes = 'Creates account activation and onboarding state for internal employee onboarding.',
  review_notes = 'First official external App integration sample. Verify publisher approval email and access activation audit before listing.',
  current_version = '1.0.0',
  changelog = 'Initial formal App Store review entry using the live Workspace Onboarding login surface.',
  listed_at = '2026-06-18',
  updated_at = CURRENT_TIMESTAMP
WHERE id = 'app-growth-lab';

INSERT OR IGNORE INTO app_catalog_metadata (
  app_id,
  category_id,
  cover_image_url,
  tags_json,
  screenshots_json,
  view_count,
  launch_count,
  download_count,
  like_count,
  favorite_count,
  rating,
  rating_count,
  discussion_count,
  active_user_count,
  monthly_users,
  updated_at
) VALUES (
  'app-growth-lab',
  'category-knowledge',
  '/assets/workspace-onboarding-home-cover.png',
  '["app","onboarding","hr","vercel"]',
  '["/assets/workspace-onboarding-home-cover.png"]',
  312,
  88,
  88,
  16,
  12,
  4.3,
  9,
  4,
  88,
  88,
  CURRENT_TIMESTAMP
);

UPDATE app_catalog_metadata
SET
  category_id = 'category-knowledge',
  cover_image_url = '/assets/workspace-onboarding-home-cover.png',
  tags_json = '["app","onboarding","hr","vercel"]',
  screenshots_json = '["/assets/workspace-onboarding-home-cover.png"]',
  view_count = 312,
  launch_count = 88,
  download_count = 88,
  like_count = 16,
  favorite_count = 12,
  rating = 4.3,
  rating_count = 9,
  discussion_count = 4,
  active_user_count = 88,
  monthly_users = 88,
  updated_at = CURRENT_TIMESTAMP
WHERE app_id = 'app-growth-lab';

INSERT OR IGNORE INTO app_scopes (app_id, scope_id) VALUES
  ('app-growth-lab', 'scope-profile-read');

INSERT OR IGNORE INTO publication_listings (
  id,
  listing_type,
  target_id,
  owner_team_id,
  created_by_user_id,
  name,
  slug,
  summary,
  description,
  cover_image_url,
  category_id,
  tags_json,
  status,
  visibility,
  install_count,
  comment_count,
  rating,
  published_at
) VALUES (
  'listing-app-growth-lab',
  'app',
  'app-growth-lab',
  'team-ai-adoption',
  '00000000-0000-0000-0000-000000000001',
  'Workspace Onboarding',
  'workspace-onboarding',
  'Employee onboarding and account activation App.',
  'Workspace employee onboarding portal for account login, access activation, and HR-assisted onboarding.',
  '/assets/workspace-onboarding-home-cover.png',
  'category-knowledge',
  '["app","onboarding","hr","vercel"]',
  'listed',
  'company',
  88,
  4,
  4.3,
  '2026-06-18'
);

UPDATE publication_listings
SET
  owner_team_id = 'team-ai-adoption',
  created_by_user_id = '00000000-0000-0000-0000-000000000001',
  name = 'Workspace Onboarding',
  slug = 'workspace-onboarding',
  summary = 'Employee onboarding and account activation App.',
  description = 'Workspace employee onboarding portal for account login, access activation, and HR-assisted onboarding.',
  cover_image_url = '/assets/workspace-onboarding-home-cover.png',
  category_id = 'category-knowledge',
  tags_json = '["app","onboarding","hr","vercel"]',
  status = 'listed',
  visibility = 'company',
  install_count = 88,
  comment_count = 4,
  rating = 4.3,
  published_at = '2026-06-18',
  updated_at = CURRENT_TIMESTAMP
WHERE id = 'listing-app-growth-lab';

UPDATE review_queue
SET
  title = 'Workspace Onboarding access review',
  owner_team_id = 'team-ai-adoption',
  risk_level = 'medium',
  status = 'open'
WHERE id = 'review-growth-lab';

DELETE FROM publication_comments
WHERE listing_id IN (
  SELECT id FROM publication_listings
  WHERE listing_type = 'app' AND target_id <> 'app-growth-lab'
);

DELETE FROM publication_installations
WHERE listing_id IN (
  SELECT id FROM publication_listings
  WHERE listing_type = 'app' AND target_id <> 'app-growth-lab'
);

DELETE FROM publication_versions
WHERE listing_id IN (
  SELECT id FROM publication_listings
  WHERE listing_type = 'app' AND target_id <> 'app-growth-lab'
);

DELETE FROM publication_listings
WHERE listing_type = 'app' AND target_id <> 'app-growth-lab';

DELETE FROM forum_notifications
WHERE topic_id IN (
  SELECT id FROM forum_topics
  WHERE linked_app_id IS NOT NULL AND linked_app_id <> 'app-growth-lab'
);

DELETE FROM forum_mentions
WHERE topic_id IN (
  SELECT id FROM forum_topics
  WHERE linked_app_id IS NOT NULL AND linked_app_id <> 'app-growth-lab'
);

DELETE FROM forum_content_plugins
WHERE target_type = 'app' AND target_id <> 'app-growth-lab';

DELETE FROM forum_content_plugins
WHERE topic_id IN (
  SELECT id FROM forum_topics
  WHERE linked_app_id IS NOT NULL AND linked_app_id <> 'app-growth-lab'
);

DELETE FROM forum_link_embeds
WHERE topic_id IN (
  SELECT id FROM forum_topics
  WHERE linked_app_id IS NOT NULL AND linked_app_id <> 'app-growth-lab'
);

DELETE FROM forum_attachments
WHERE topic_id IN (
  SELECT id FROM forum_topics
  WHERE linked_app_id IS NOT NULL AND linked_app_id <> 'app-growth-lab'
);

DELETE FROM forum_posts
WHERE topic_id IN (
  SELECT id FROM forum_topics
  WHERE linked_app_id IS NOT NULL AND linked_app_id <> 'app-growth-lab'
);

DELETE FROM forum_topic_tags
WHERE topic_id IN (
  SELECT id FROM forum_topics
  WHERE linked_app_id IS NOT NULL AND linked_app_id <> 'app-growth-lab'
);

DELETE FROM forum_topics
WHERE linked_app_id IS NOT NULL AND linked_app_id <> 'app-growth-lab';

DELETE FROM review_queue
WHERE item_type = 'app' AND id <> 'review-growth-lab';

DELETE FROM audit_logs
WHERE (actor_type = 'app' AND actor_id <> 'app-growth-lab')
   OR (target_type = 'app' AND target_id <> 'app-growth-lab');

DELETE FROM access_tokens
WHERE subject_type = 'app' AND subject_id <> 'app-growth-lab';

DELETE FROM grants
WHERE app_id IS NOT NULL AND app_id <> 'app-growth-lab';

DELETE FROM app_scopes
WHERE app_id <> 'app-growth-lab';

DELETE FROM app_catalog_metadata
WHERE app_id <> 'app-growth-lab';

DELETE FROM apps
WHERE id <> 'app-growth-lab';
