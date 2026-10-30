UPDATE portal_badge_definitions
SET description_zh = '第一次提交 App 或 Skill 到技能中心审核。',
    description_en = 'Submit the first App or Skill listing to Skill Hub review.',
    updated_at = CURRENT_TIMESTAMP
WHERE badge_key = 'market_submitter';

UPDATE portal_badge_definitions
SET description_zh = '第一个 App 或 Skill 能力正式发布。',
    description_en = 'Publish the first reusable App or Skill capability.',
    updated_at = CURRENT_TIMESTAMP
WHERE badge_key = 'first_published_capability';
