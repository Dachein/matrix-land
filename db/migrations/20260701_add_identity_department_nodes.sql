ALTER TABLE user_identity_profiles ADD COLUMN department_id TEXT NOT NULL DEFAULT '';
ALTER TABLE user_identity_profiles ADD COLUMN department_path_json TEXT NOT NULL DEFAULT '[]';
