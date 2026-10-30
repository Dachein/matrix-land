ALTER TABLE apps ADD COLUMN name_zh TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN name_en TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN app_type TEXT NOT NULL DEFAULT 'web';
ALTER TABLE apps ADD COLUMN description_zh TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN description_en TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN model_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN deployment_provider TEXT NOT NULL DEFAULT 'other';
ALTER TABLE apps ADD COLUMN deployment_method TEXT NOT NULL DEFAULT 'serverless';
ALTER TABLE apps ADD COLUMN data_region TEXT NOT NULL DEFAULT 'hong_kong';
ALTER TABLE apps ADD COLUMN sensitive_data_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE apps ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'public';
ALTER TABLE apps ADD COLUMN access_targets_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE apps ADD COLUMN uses_workspace_auth INTEGER NOT NULL DEFAULT 1;

ALTER TABLE app_catalog_metadata ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_catalog_metadata ADD COLUMN launch_count INTEGER NOT NULL DEFAULT 0;

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
  current_version = '1.0.0',
  changelog = 'Initial formal App Store review entry using the live Workspace Onboarding login surface.',
  review_notes = 'First official external App integration sample. Verify publisher approval email and access activation audit before listing.',
  updated_at = CURRENT_TIMESTAMP
WHERE id = 'app-growth-lab';

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

UPDATE publication_listings
SET
  owner_team_id = 'team-ai-adoption',
  created_by_user_id = '00000000-0000-0000-0000-000000000001',
  name = 'Workspace Onboarding',
  slug = 'workspace-onboarding',
  summary = 'Employee onboarding and account activation App.',
  description = 'Workspace employee onboarding portal for account login, access activation, and HR-assisted onboarding.',
  category_id = 'category-knowledge',
  tags_json = '["app","onboarding","hr","vercel"]',
  install_count = 88,
  comment_count = 4,
  rating = 4.3,
  updated_at = CURRENT_TIMESTAMP
WHERE id = 'listing-app-growth-lab';

UPDATE review_queue
SET
  title = 'Workspace Onboarding access review',
  owner_team_id = 'team-ai-adoption',
  risk_level = 'medium'
WHERE id = 'review-growth-lab';
