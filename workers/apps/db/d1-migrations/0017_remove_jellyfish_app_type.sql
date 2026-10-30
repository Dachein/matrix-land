-- D1 keeps foreign-key enforcement enabled for every migration. Rebuilding
-- apps_apps with DROP TABLE would therefore fire every ON DELETE CASCADE and
-- erase the App's resources, domains, deployments, secrets, and source history.
-- Keep the existing table and enforce the retired type at the database edge.

CREATE TABLE apps_jellyfish_migration_guard (
  remaining_count INTEGER NOT NULL CHECK (remaining_count = 0)
);

INSERT INTO apps_jellyfish_migration_guard (remaining_count)
SELECT COUNT(*)
FROM apps_apps
WHERE type = 'jellyfish';

DROP TABLE apps_jellyfish_migration_guard;
DROP INDEX IF EXISTS idx_apps_apps_jellyfish_code;

CREATE TRIGGER IF NOT EXISTS trg_apps_apps_reject_jellyfish_insert
BEFORE INSERT ON apps_apps
WHEN NEW.type = 'jellyfish'
BEGIN
  SELECT RAISE(ABORT, 'retired apps app type: jellyfish');
END;

CREATE TRIGGER IF NOT EXISTS trg_apps_apps_reject_jellyfish_update
BEFORE UPDATE OF type ON apps_apps
WHEN NEW.type = 'jellyfish'
BEGIN
  SELECT RAISE(ABORT, 'retired apps app type: jellyfish');
END;
