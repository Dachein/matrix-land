-- Keep the retirement guard idempotent for databases that recorded the first
-- version of migration 0017 before its unsafe parent-table rebuild was fixed.
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
