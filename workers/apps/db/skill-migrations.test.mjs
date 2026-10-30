import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

const readSql = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

const applyD1Migration = (database, sql) => {
  database.exec(`BEGIN IMMEDIATE;\n${sql}\nCOMMIT;`);
};

const assertVersionIntegrity = (database) => {
  const version = database
    .prepare("SELECT * FROM apps_skill_versions WHERE id = ?")
    .get("skill-version-1");
  const skill = database
    .prepare("SELECT current_version_id FROM apps_skills WHERE id = ?")
    .get("skill-1");

  assert.ok(version);
  assert.equal(version.id, "skill-version-1");
  assert.equal(version.skill_id, "skill-1");
  assert.equal(version.version, "1.0.0");
  assert.equal(version.state, "private_current");
  assert.equal(version.artifact_key, "skills/skill-1/1.0.0/package.zip");
  assert.equal(version.skill_md_key, "skills/skill-1/1.0.0/SKILL.md");
  assert.equal(version.manifest_key, "skills/skill-1/1.0.0/manifest.json");
  assert.equal(version.artifact_sha256, "sha256-value");
  assert.equal(version.manifest_json, '{"name":"Migration Test"}');
  assert.equal(version.frontmatter_json, '{"description":"Preserve me"}');
  assert.equal(version.file_count, 3);
  assert.equal(version.size_bytes, 1024);
  assert.equal(version.changelog, "Initial version");
  assert.equal(version.created_by, "user-1");
  assert.equal(version.created_at, "2026-07-05T00:00:00.000Z");
  assert.equal(skill.current_version_id, version.id);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
};

describe("skill parent-table migrations", () => {
  it("preserves skill versions while rebuilding apps_skills", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys=on;");
    database.exec(readSql("./migrations/20260619_skill_artifacts.sql"));

    database.prepare(`
      INSERT INTO apps_skills (
        id,
        org_id,
        org_slug,
        owner_user_id,
        name,
        slug,
        description,
        kind,
        capabilities_json,
        status,
        visibility,
        current_version_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "skill-1",
      "org-1",
      "workspace",
      "user-1",
      "Migration Test",
      "migration-test",
      "Verifies child row preservation",
      "pure",
      '["documents"]',
      "private",
      "team",
      "skill-version-1",
      "2026-07-05T00:00:00.000Z",
      "2026-07-05T00:00:00.000Z"
    );
    database.prepare(`
      INSERT INTO apps_skill_versions (
        id,
        skill_id,
        version,
        state,
        artifact_key,
        skill_md_key,
        manifest_key,
        artifact_sha256,
        manifest_json,
        frontmatter_json,
        file_count,
        size_bytes,
        changelog,
        created_by,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "skill-version-1",
      "skill-1",
      "1.0.0",
      "private_current",
      "skills/skill-1/1.0.0/package.zip",
      "skills/skill-1/1.0.0/SKILL.md",
      "skills/skill-1/1.0.0/manifest.json",
      "sha256-value",
      '{"name":"Migration Test"}',
      '{"description":"Preserve me"}',
      3,
      1024,
      "Initial version",
      "user-1",
      "2026-07-05T00:00:00.000Z"
    );

    applyD1Migration(database, readSql("./migrations/20260706_skill_kind_taxonomy.sql"));

    assert.equal(database.prepare("SELECT kind FROM apps_skills WHERE id = ?").get("skill-1").kind, "vanilla");
    assertVersionIntegrity(database);

    applyD1Migration(database, readSql("./migrations/20260713_skill_access_scope.sql"));

    const migratedSkill = database
      .prepare("SELECT visibility, access_targets_json, login_required FROM apps_skills WHERE id = ?")
      .get("skill-1");
    assert.deepEqual({ ...migratedSkill }, {
      visibility: "team",
      access_targets_json: "[]",
      login_required: 1
    });
    assertVersionIntegrity(database);
    database.close();
  });
});
