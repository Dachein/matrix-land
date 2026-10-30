UPDATE portal_journey_levels
SET description_zh = '开始创建并发布 APPS App 或 APPS Skill。',
    description_en = 'Creates and publishes APPS Apps or APPS Skills.',
    min_points = 500,
    criteria_json = '{"category":"builder","count":1,"requiredBadge":"first_published_capability"}',
    updated_at = CURRENT_TIMESTAMP
WHERE journey_key = 'default'
  AND version = 'v1'
  AND level_key = 'builder';

UPDATE portal_journey_levels
SET description_zh = '持续发布、推动团队复用并参与跨项目协作。',
    description_en = 'Publishes repeatedly, drives team reuse, and collaborates across projects.',
    min_points = 700,
    criteria_json = '{"category":"impact","count":1,"requiredBadge":"first_published_capability"}',
    updated_at = CURRENT_TIMESTAMP
WHERE journey_key = 'default'
  AND version = 'v1'
  AND level_key = 'master';

UPDATE portal_badge_definitions
SET name_zh = '工作流探索者',
    name_en = 'Workflow Explorer',
    description_zh = '同时使用过 App 和 APPS Skill。',
    description_en = 'Use both an App and a APPS Skill.',
    trigger_type = 'computed',
    trigger_config_json = '{"kind":"workflow_explorer","surfaces":2}',
    active = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE badge_key = 'workflow_explorer';

UPDATE portal_badge_definitions
SET name_zh = '首个 APPS 草稿',
    name_en = 'First APPS Draft',
    description_zh = '创建第一个 APPS App 或 APPS Skill 草稿。',
    description_en = 'Create the first APPS App or APPS Skill draft.',
    points = 50,
    trigger_type = 'apps',
    trigger_config_json = '{"kind":"first_apps_draft"}',
    active = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE badge_key = 'first_apps_draft';

UPDATE portal_badge_definitions
SET name_zh = 'Skill 创作者',
    name_en = 'Skill Maker',
    description_zh = '创建第一个 APPS Skill。',
    description_en = 'Create the first APPS Skill.',
    points = 100,
    trigger_type = 'apps',
    trigger_config_json = '{"kind":"first_apps_skill"}',
    active = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE badge_key = 'skill_maker';

UPDATE portal_badge_definitions
SET category = 'builder',
    name_zh = '首次正式发布',
    name_en = 'First APPS Published',
    description_zh = '正式发布第一个 APPS App 或 APPS Skill。',
    description_en = 'Publish the first APPS App or APPS Skill.',
    points = 150,
    trigger_type = 'market',
    trigger_config_json = '{"kind":"first_published_apps","published":1}',
    sort_order = 340,
    active = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE badge_key = 'first_published_capability';

UPDATE portal_badge_definitions
SET name_zh = '被团队复用',
    name_en = 'Reused by Team',
    description_zh = '一个已发布 APPS 项目被至少 5 名其他用户使用。',
    description_en = 'A published APPS project is used by at least five other users.',
    trigger_type = 'market',
    trigger_config_json = '{"kind":"reused_by_team","distinctUsers":5}',
    sort_order = 420,
    active = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE badge_key = 'reused_by_team';

UPDATE portal_badge_definitions
SET active = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE badge_key IN (
  'mcp_skill_user',
  'mcp_skill_maker',
  'market_submitter',
  'maintainer',
  'mentor',
  'helpful_reply'
);

INSERT OR IGNORE INTO portal_badge_definitions (
  badge_key,
  journey_key,
  version,
  category,
  name_zh,
  name_en,
  description_zh,
  description_en,
  points,
  trigger_type,
  trigger_config_json,
  sort_order,
  active
) VALUES
  (
    'forum_active',
    'default',
    'v1',
    'community',
    '论坛活跃者',
    'Forum Regular',
    '累计发起至少 5 个论坛帖子。',
    'Start at least five forum topics.',
    100,
    'forum',
    '{"kind":"forum_active","topics":5}',
    130,
    1
  ),
  (
    'apps_skill_user',
    'default',
    'v1',
    'usage',
    'APPS Skill 用户',
    'APPS Skill User',
    '首次安装或使用一个 APPS Skill。',
    'Install or use the first APPS Skill.',
    60,
    'market',
    '{"kind":"first_apps_skill_use"}',
    230,
    1
  ),
  (
    'app_maker',
    'default',
    'v1',
    'builder',
    'App 创作者',
    'App Maker',
    '创建第一个 APPS App。',
    'Create the first APPS App.',
    100,
    'apps',
    '{"kind":"first_apps_app"}',
    330,
    1
  ),
  (
    'published_two_appss',
    'default',
    'v1',
    'impact',
    '发布两个 APPS',
    'Two APPS Projects Published',
    '至少正式发布两个 APPS App 或 APPS Skill。',
    'Publish at least two APPS Apps or APPS Skills.',
    200,
    'market',
    '{"kind":"published_appss","published":2}',
    410,
    1
  ),
  (
    'collaboration_master',
    'default',
    'v1',
    'impact',
    '协作大师',
    'Collaboration Master',
    '作为协作者参与至少 3 个不同的 APPS 项目。',
    'Be a collaborator on at least three different APPS projects.',
    200,
    'apps',
    '{"kind":"apps_collaborator","projects":3}',
    430,
    1
  );

UPDATE portal_badge_definitions
SET points = 100,
    updated_at = CURRENT_TIMESTAMP
WHERE badge_key = 'app_maker';

UPDATE portal_badge_definitions
SET name_zh = '论坛活跃者',
    name_en = 'Forum Regular',
    description_zh = '累计发起至少 5 个论坛帖子。',
    description_en = 'Start at least five forum topics.',
    points = 100,
    trigger_type = 'forum',
    trigger_config_json = '{"kind":"forum_active","topics":5}',
    sort_order = 130,
    active = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE badge_key = 'forum_active';

UPDATE portal_badge_definitions
SET points = 200,
    updated_at = CURRENT_TIMESTAMP
WHERE badge_key = 'published_two_appss';
