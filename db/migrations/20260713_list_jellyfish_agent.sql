-- Stage the canonical Jellyfish QA app as a Portal catalog projection of a
-- APPS D1 registered app running on the shared Ask Jellyfish Worker.
--
-- Prerequisite: APPS D1 must contain a matching published `jellyfish` app with
-- id `app-jellyfish-agent`, code `jellyfish-agent`, and a configured encrypted
-- `JELLYFISH_SERVICE_API_KEY`. This migration does not deploy the Worker, write
-- a service key, or prove that hostname/origin protection is complete.

INSERT OR IGNORE INTO skill_categories (id, name, slug) VALUES
  ('category-finance', 'Finance', 'finance');

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
  model,
  model_provider,
  deployment_type,
  deployment_provider,
  deployment_method,
  data_region,
  data_types_json,
  sensitive_data_json,
  knowledge_sources_json,
  user_scope,
  access_mode,
  access_targets_json,
  uses_workspace_auth,
  risk_level,
  risk_reason,
  permission_notes,
  output_notes,
  review_notes,
  current_version,
  changelog,
  launch_url,
  callback_url,
  sdk_status,
  status,
  visibility,
  listed_at
) VALUES (
  'app-jellyfish-agent',
  'team-ai-adoption',
  '311de46e-42b1-49ba-86e7-2df910f4ebbe',
  '311de46e-42b1-49ba-86e7-2df910f4ebbe',
  'Jellyfish Agent',
  'Jellyfish Agent',
  'Jellyfish Agent',
  '内置业务知识的智能问答服务',
  'agent_chat',
  'jellyfish-agent',
  '基于 Jellyfish 内置知识库的对话式问答应用，可直接围绕 PB Partners 与私人银行开户相关知识提问。',
  '基于 Jellyfish 内置知识库的对话式问答应用，可直接围绕 PB Partners 与私人银行开户相关知识提问。',
  'A conversational Q&A app backed by the built-in Jellyfish knowledge base for PB Partners and private-banking onboarding topics.',
  '',
  '',
  'saas',
  'other',
  'serverless',
  'other',
  '["Private banking partner knowledge","User-submitted advisory context"]',
  '["customer_information","financial_information","internal_materials"]',
  '["Jellyfish managed knowledge base","PB Partners onboarding guidance"]',
  'all',
  'public',
  '[]',
  1,
  'high',
  '问答可能涉及客户国籍、AUM、资金来源与银行偏好；共享 Worker 应使用 Workspace 应用级准入，源站仍须完成边缘收口。',
  'Service API Key 应由 APPS D1 加密保存并仅由共享 Worker 解密使用。正式发布前必须用 Cloudflare Access/源站防火墙阻止绕过 Worker。',
  '回答仅作内部业务参考，用户应避免输入不必要的客户个人识别信息，并人工复核银行准入与合规结论。',
  '待审核：确认 APPS 注册记录、应用级 Auth、共享 Worker 路由、密钥解密和 Jellyfish 源站 Access 后方可发布。',
  '1.0.0',
  'Catalog projection for a APPS-registered Jellyfish app on the shared Ask runtime.',
  'https://askjellyfish.example.invalid/jellyfish-agent/',
  'https://askjellyfish.example.invalid/jellyfish-agent/auth/workspace/callback',
  'pending',
  'pending_review',
  'internal',
  NULL
);

UPDATE apps
SET
  name = 'Jellyfish Agent',
  name_zh = 'Jellyfish Agent',
  name_en = 'Jellyfish Agent',
  subtitle = '内置业务知识的智能问答服务',
  app_type = 'agent_chat',
  slug = 'jellyfish-agent',
  description = '基于 Jellyfish 内置知识库的对话式问答应用，可直接围绕 PB Partners 与私人银行开户相关知识提问。',
  description_zh = '基于 Jellyfish 内置知识库的对话式问答应用，可直接围绕 PB Partners 与私人银行开户相关知识提问。',
  description_en = 'A conversational Q&A app backed by the built-in Jellyfish knowledge base for PB Partners and private-banking onboarding topics.',
  deployment_type = 'saas',
  deployment_provider = 'other',
  deployment_method = 'serverless',
  data_region = 'other',
  data_types_json = '["Private banking partner knowledge","User-submitted advisory context"]',
  sensitive_data_json = '["customer_information","financial_information","internal_materials"]',
  knowledge_sources_json = '["Jellyfish managed knowledge base","PB Partners onboarding guidance"]',
  user_scope = 'all',
  access_mode = 'public',
  access_targets_json = '[]',
  uses_workspace_auth = 1,
  risk_level = 'high',
  risk_reason = '问答可能涉及客户国籍、AUM、资金来源与银行偏好；共享 Worker 应使用 Workspace 应用级准入，源站仍须完成边缘收口。',
  permission_notes = 'Service API Key 应由 APPS D1 加密保存并仅由共享 Worker 解密使用。正式发布前必须用 Cloudflare Access/源站防火墙阻止绕过 Worker。',
  output_notes = '回答仅作内部业务参考，用户应避免输入不必要的客户个人识别信息，并人工复核银行准入与合规结论。',
  review_notes = '待审核：确认 APPS 注册记录、应用级 Auth、共享 Worker 路由、密钥解密和 Jellyfish 源站 Access 后方可发布。',
  current_version = '1.0.0',
  changelog = 'Catalog projection for a APPS-registered Jellyfish app on the shared Ask runtime.',
  launch_url = 'https://askjellyfish.example.invalid/jellyfish-agent/',
  callback_url = 'https://askjellyfish.example.invalid/jellyfish-agent/auth/workspace/callback',
  sdk_status = 'pending',
  status = 'pending_review',
  visibility = 'internal',
  listed_at = NULL,
  updated_at = CURRENT_TIMESTAMP
WHERE id = 'app-jellyfish-agent';

INSERT OR IGNORE INTO app_catalog_metadata (
  app_id,
  category_id,
  cover_image_url,
  tags_json,
  screenshots_json
) VALUES (
  'app-jellyfish-agent',
  'category-finance',
  '',
  '["app","agent-chat","jellyfish","knowledge","private-banking"]',
  '[]'
);

UPDATE app_catalog_metadata
SET
  category_id = 'category-finance',
  tags_json = '["app","agent-chat","jellyfish","knowledge","private-banking"]',
  updated_at = CURRENT_TIMESTAMP
WHERE app_id = 'app-jellyfish-agent';

INSERT OR IGNORE INTO publication_listings (
  id,
  listing_type,
  target_plane,
  target_id,
  listed_version_id,
  review_version_id,
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
  risk_level,
  review_notes,
  builder_snapshot_json,
  published_at
) VALUES (
  'listing-app-jellyfish-agent',
  'app',
  'apps',
  'app-jellyfish-agent',
  '',
  '1.0.0',
  '311de46e-42b1-49ba-86e7-2df910f4ebbe',
  'Jellyfish Agent',
  'jellyfish-agent',
  '内置业务知识的智能问答服务',
  '基于 Jellyfish 内置知识库的对话式问答应用，可直接围绕 PB Partners 与私人银行开户相关知识提问。',
  '',
  'category-finance',
  '["app","agent-chat","jellyfish","knowledge","private-banking"]',
  'pending_review',
  'company',
  'high',
  '待审核：APPS D1 注册、按应用 Auth、加密凭据读取及 Jellyfish hostname/原始端口收口均须通过发布验收。',
  '{"source":"apps-worker","targetPlane":"apps","targetType":"app","targetId":"app-jellyfish-agent","appCode":"jellyfish-agent","runtime":"shared_ask_jellyfish_worker","registry":"apps_d1","credentialStore":"apps_app_secrets","authBoundary":"per_app_workspace_session","sourceProtectionRequired":true,"deploymentStatus":"not_asserted"}',
  NULL
);

UPDATE publication_listings
SET
  target_plane = 'apps',
  target_id = 'app-jellyfish-agent',
  listed_version_id = '',
  review_version_id = '1.0.0',
  name = 'Jellyfish Agent',
  slug = 'jellyfish-agent',
  summary = '内置业务知识的智能问答服务',
  description = '基于 Jellyfish 内置知识库的对话式问答应用，可直接围绕 PB Partners 与私人银行开户相关知识提问。',
  category_id = 'category-finance',
  tags_json = '["app","agent-chat","jellyfish","knowledge","private-banking"]',
  visibility = 'company',
  risk_level = 'high',
  status = 'pending_review',
  review_notes = '待审核：APPS D1 注册、按应用 Auth、加密凭据读取及 Jellyfish hostname/原始端口收口均须通过发布验收。',
  builder_snapshot_json = '{"source":"apps-worker","targetPlane":"apps","targetType":"app","targetId":"app-jellyfish-agent","appCode":"jellyfish-agent","runtime":"shared_ask_jellyfish_worker","registry":"apps_d1","credentialStore":"apps_app_secrets","authBoundary":"per_app_workspace_session","sourceProtectionRequired":true,"deploymentStatus":"not_asserted"}',
  published_at = NULL,
  updated_at = CURRENT_TIMESTAMP
WHERE id = 'listing-app-jellyfish-agent';

INSERT OR IGNORE INTO publication_versions (
  id,
  listing_id,
  version,
  artifact_type,
  artifact_url,
  artifact_body,
  config_json,
  changelog,
  created_by_user_id
) VALUES (
  'market-version-app-jellyfish-agent-1-0-0',
  'listing-app-jellyfish-agent',
  '1.0.0',
  'app_config',
  'https://askjellyfish.example.invalid/jellyfish-agent/',
  '',
  '{"source":"apps-worker","targetPlane":"apps","targetType":"app","targetId":"app-jellyfish-agent","appCode":"jellyfish-agent","runtime":"shared_ask_jellyfish_worker","registry":"apps_d1","credentialStore":"apps_app_secrets","authBoundary":"per_app_workspace_session","sourceProtectionRequired":true,"deploymentStatus":"not_asserted","launchUrl":"https://askjellyfish.example.invalid/jellyfish-agent/","callbackUrl":"https://askjellyfish.example.invalid/jellyfish-agent/auth/workspace/callback","overviewMarkdown":"# Jellyfish Agent\n\n内置 PB Partners 业务知识的共享问答应用。\n\n- 通过 appCode 路径进入共享 Ask Jellyfish Runtime\n- Workspace 登录和准入按 APPS 应用隔离\n- Service API Key 由 APPS D1 加密保存，不进入浏览器\n- 浏览器只保存与当前应用及账户绑定的加密会话句柄\n- 生成文件由共享 Worker 同源代理预览或下载\n- 输出仅作内部参考，重要结论需人工复核"}',
  'Catalog projection for a APPS-registered Jellyfish app on the shared Ask runtime.',
  '311de46e-42b1-49ba-86e7-2df910f4ebbe'
);

UPDATE publication_versions
SET
  artifact_url = 'https://askjellyfish.example.invalid/jellyfish-agent/',
  config_json = '{"source":"apps-worker","targetPlane":"apps","targetType":"app","targetId":"app-jellyfish-agent","appCode":"jellyfish-agent","runtime":"shared_ask_jellyfish_worker","registry":"apps_d1","credentialStore":"apps_app_secrets","authBoundary":"per_app_workspace_session","sourceProtectionRequired":true,"deploymentStatus":"not_asserted","launchUrl":"https://askjellyfish.example.invalid/jellyfish-agent/","callbackUrl":"https://askjellyfish.example.invalid/jellyfish-agent/auth/workspace/callback","overviewMarkdown":"# Jellyfish Agent\n\n内置 PB Partners 业务知识的共享问答应用。\n\n- 通过 appCode 路径进入共享 Ask Jellyfish Runtime\n- Workspace 登录和准入按 APPS 应用隔离\n- Service API Key 由 APPS D1 加密保存，不进入浏览器\n- 浏览器只保存与当前应用及账户绑定的加密会话句柄\n- 生成文件由共享 Worker 同源代理预览或下载\n- 输出仅作内部参考，重要结论需人工复核"}',
  changelog = 'Catalog projection for a APPS-registered Jellyfish app on the shared Ask runtime.'
WHERE id = 'market-version-app-jellyfish-agent-1-0-0';

INSERT OR IGNORE INTO review_queue (
  id,
  item_type,
  title,
  owner_team_id,
  risk_level,
  status
) VALUES (
  'review-app-jellyfish-agent',
  'app',
  'Jellyfish Agent access review',
  'team-ai-adoption',
  'high',
  'open'
);

UPDATE review_queue
SET
  title = 'Jellyfish Agent access review',
  owner_team_id = 'team-ai-adoption',
  risk_level = 'high'
WHERE id = 'review-app-jellyfish-agent';

INSERT OR IGNORE INTO audit_logs (
  id,
  actor_type,
  actor_id,
  action,
  target_type,
  target_id,
  metadata_json
) VALUES (
  'audit-list-jellyfish-agent-20260713',
  'user',
  '311de46e-42b1-49ba-86e7-2df910f4ebbe',
  'staged APPS Jellyfish Agent catalog projection for review',
  'app',
  'app-jellyfish-agent',
  '{"launchUrl":"https://askjellyfish.example.invalid/jellyfish-agent/","callbackUrl":"https://askjellyfish.example.invalid/jellyfish-agent/auth/workspace/callback","appCode":"jellyfish-agent","runtime":"shared_ask_jellyfish_worker","registry":"apps_d1","usesDatabase":true,"databaseRole":"configuration_and_encrypted_credential_registry_only","conversationStorage":"jellyfish","deploymentStatus":"not_asserted","sourceProtectionRequired":true}'
);

UPDATE audit_logs
SET
  action = 'staged APPS Jellyfish Agent catalog projection for review',
  target_type = 'app',
  target_id = 'app-jellyfish-agent',
  metadata_json = '{"launchUrl":"https://askjellyfish.example.invalid/jellyfish-agent/","callbackUrl":"https://askjellyfish.example.invalid/jellyfish-agent/auth/workspace/callback","appCode":"jellyfish-agent","runtime":"shared_ask_jellyfish_worker","registry":"apps_d1","usesDatabase":true,"databaseRole":"configuration_and_encrypted_credential_registry_only","conversationStorage":"jellyfish","deploymentStatus":"not_asserted","sourceProtectionRequired":true}'
WHERE id = 'audit-list-jellyfish-agent-20260713';
