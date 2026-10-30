import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

const readSql = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8");
const schema = readSql("./schema.sql");
const migration = readSql("./d1-migrations/0017_remove_jellyfish_app_type.sql");
const enforcementMigration = readSql("./d1-migrations/0018_enforce_retired_app_type.sql");

function legacySchema() {
  return schema
    .replace("'automation', 'container'", "'automation', 'jellyfish', 'container'")
    .replace(
      "CREATE INDEX IF NOT EXISTS idx_apps_apps_public ON apps_apps(status, visibility, updated_at);",
      "CREATE INDEX IF NOT EXISTS idx_apps_apps_public ON apps_apps(status, visibility, updated_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_apps_apps_jellyfish_code ON apps_apps(code) WHERE type = 'jellyfish';"
    );
}

function insertApp(database, type) {
  database.prepare(`
    INSERT INTO apps_apps (
      id, org_id, org_slug, owner_user_id, name, code, slug, description,
      type, status, visibility, login_required, data_service_id, created_at, updated_at
    ) VALUES ('app-1', 'org-1', 'workspace', 'user-1', 'Example', 'example', 'example', '', ?, 'published', 'org', 1, 'ds-1', '2026-09-28', '2026-09-28')
  `).run(type);
}

describe("remove Jellyfish app type migration", () => {
  it("preserves app data and child rows, and removes the retired index", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(legacySchema());
    insertApp(database, "web");
    database.prepare(`
      INSERT INTO apps_app_resources (
        id, app_id, data_service_id, type, provider, resource_name,
        environment, status, created_at
      ) VALUES ('resource-1', 'app-1', 'ds-1', 'worker', 'cloudflare', 'example-worker', 'prod', 'ready', '2026-09-28')
    `).run();
    database.exec(migration);

    assert.equal(database.prepare("SELECT type FROM apps_apps WHERE id = 'app-1'").get().type, "web");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM apps_app_resources WHERE app_id = 'app-1'").get().count, 1);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_apps_apps_jellyfish_code'").get(), undefined);
    assert.throws(() => insertApp(database, "jellyfish"), /retired apps app type: jellyfish/);
    assert.doesNotMatch(migration, /DROP TABLE(?: IF EXISTS)? apps_apps(?:\s|;)/i);
  });

  it("fails closed without dropping an unexpected Jellyfish row", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(legacySchema());
    insertApp(database, "jellyfish");

    assert.throws(() => database.exec(migration), /CHECK constraint failed/);
    assert.equal(database.prepare("SELECT type FROM apps_apps WHERE id = 'app-1'").get().type, "jellyfish");
  });

  it("backfills the retirement guard for databases that already recorded 0017", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(legacySchema());
    insertApp(database, "web");

    database.exec(enforcementMigration);

    assert.throws(() => insertApp(database, "jellyfish"), /retired apps app type: jellyfish/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM apps_apps").get().count, 1);
  });
});
