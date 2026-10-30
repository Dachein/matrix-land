import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

describe("APPS collaborator migration", () => {
  it("adds empty collaborator lists without changing existing App or Skill rows", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE apps_apps (id TEXT PRIMARY KEY);
      CREATE TABLE apps_skills (id TEXT PRIMARY KEY);
      INSERT INTO apps_apps (id) VALUES ('app-1');
      INSERT INTO apps_skills (id) VALUES ('skill-1');
    `);

    database.exec(readFileSync(new URL("./migrations/20260713_zz_apps_collaborators.sql", import.meta.url), "utf8"));

    assert.equal(
      database.prepare("SELECT collaborator_user_ids_json FROM apps_apps WHERE id = ?").get("app-1").collaborator_user_ids_json,
      "[]"
    );
    assert.equal(
      database.prepare("SELECT collaborator_user_ids_json FROM apps_skills WHERE id = ?").get("skill-1").collaborator_user_ids_json,
      "[]"
    );
    database.close();
  });
});
