import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/apps/db/schema.sql", "utf8"));
  for (const [id, code] of [["app-1", "app-one"], ["app-2", "app-two"]]) {
    database.prepare(`
      INSERT INTO apps_apps (
        id, org_id, org_slug, owner_user_id, name, code, slug, type, status,
        visibility, data_service_id, created_at, updated_at
      ) VALUES (?, 'org-1', 'workspace', 'owner-1', ?, ?, ?, 'web', 'draft', 'org', ?, ?, ?)
    `).run(id, code, code, code, `ds-${id}`, "2026-08-17T00:00:00.000Z", "2026-08-17T00:00:00.000Z");
  }
  return database;
}

function insertD1(database, { appId, environment = "prod", id, provider = "cloudflare-d1", resourceId }) {
  database.prepare(`
    INSERT INTO apps_app_resources (
      id, app_id, data_service_id, type, provider, resource_name, resource_id,
      binding_name, environment, status, created_at
    ) VALUES (?, ?, ?, 'd1_database', ?, ?, ?, 'DB', ?, 'ready', ?)
  `).run(
    id,
    appId,
    `ds-${appId}`,
    provider,
    `apps-${appId}-db`,
    resourceId,
    environment,
    "2026-08-17T00:00:00.000Z"
  );
}

test("an App can bind only one D1 database in an environment", () => {
  const database = createDatabase();
  insertD1(database, { appId: "app-1", id: "resource-1", resourceId: "d1-1" });
  assert.throws(
    () => insertD1(database, { appId: "app-1", id: "resource-2", resourceId: "d1-2" }),
    /UNIQUE constraint failed/
  );
});

test("a provisioned D1 resource ID can belong to only one App across environments", () => {
  const database = createDatabase();
  insertD1(database, { appId: "app-1", id: "resource-1", resourceId: "d1-shared" });
  assert.throws(
    () => insertD1(database, {
      appId: "app-2",
      environment: "shared",
      id: "resource-2",
      resourceId: "d1-shared"
    }),
    /UNIQUE constraint failed/
  );
});

test("a provider label change cannot bypass D1 resource ownership", () => {
  const database = createDatabase();
  insertD1(database, { appId: "app-1", id: "resource-1", resourceId: "d1-shared" });
  assert.throws(
    () => insertD1(database, {
      appId: "app-2",
      id: "resource-2",
      provider: "unexpected-provider",
      resourceId: "d1-shared"
    }),
    /UNIQUE constraint failed/
  );
});

test("unprovisioned D1 placeholders for different Apps do not collide", () => {
  const database = createDatabase();
  insertD1(database, { appId: "app-1", id: "resource-1", resourceId: "" });
  insertD1(database, { appId: "app-2", id: "resource-2", resourceId: "" });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM apps_app_resources").get().count, 2);
});
