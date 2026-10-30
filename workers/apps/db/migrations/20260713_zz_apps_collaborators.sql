-- Keep this migration after the 20260713 parent-table rebuilds so the new
-- columns cannot be dropped when apps_apps or apps_skills is replaced.
ALTER TABLE apps_apps
ADD COLUMN collaborator_user_ids_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE apps_skills
ADD COLUMN collaborator_user_ids_json TEXT NOT NULL DEFAULT '[]';
