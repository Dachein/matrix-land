ALTER TABLE apps_apps
ADD COLUMN directory_read_scope TEXT NOT NULL DEFAULT 'app'
CHECK (directory_read_scope IN ('app', 'company'));
