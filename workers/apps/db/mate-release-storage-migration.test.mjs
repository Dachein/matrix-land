import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

test("adds R2-backed Mate Release metadata without changing legacy inline rows", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("./d1-migrations/0009_mate_control_plane.sql", import.meta.url), "utf8"));
  database.prepare(`
    INSERT INTO apps_mates (
      id, org_id, org_slug, owner_user_id, display_name, job_role, description,
      work_email, status, visibility, draft_revision, draft_manifest_json,
      draft_documents_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '', ?, 'published', 'private', 1, '{}', '[]', ?, ?)
  `).run("legacy-mate", "org-1", "org-1", "owner-1", "Legacy", "Legacy role", "legacy@example.com", "2026-08-22", "2026-08-22");
  database.prepare(`
    INSERT INTO apps_mate_releases (
      id, mate_id, version, status, schema_version, manifest_sha256,
      manifest_json, documents_json, created_by, created_at
    ) VALUES (?, ?, 1, 'published', 'workspace.agentruntime/v1', ?, ?, ?, ?, ?)
  `).run("legacy-mate-r1", "legacy-mate", `sha256:${"a".repeat(64)}`, "{\"legacy\":true}", "[]", "owner-1", "2026-08-22");

  database.exec(readFileSync(new URL("./d1-migrations/0010_mate_release_object_storage.sql", import.meta.url), "utf8"));

  const legacy = database.prepare("SELECT storage_mode, manifest_r2_key, manifest_json FROM apps_mate_releases WHERE id = ?")
    .get("legacy-mate-r1");
  assert.equal(legacy.storage_mode, "inline");
  assert.equal(legacy.manifest_r2_key, null);
  assert.equal(legacy.manifest_json, "{\"legacy\":true}");
  assert.deepEqual(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'apps_mate_%' ORDER BY name").all().map((row) => row.name),
    [
      "apps_mate_definition_revisions",
      "apps_mate_release_definitions",
      "apps_mate_releases",
      "apps_mates"
    ]
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});


test("mail migration preserves existing rows, foreign keys and immutable release bytes", () => {
  const db=new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./d1-migrations/0009_mate_control_plane.sql",import.meta.url),"utf8"));
  db.exec(readFileSync(new URL("./d1-migrations/0010_mate_release_object_storage.sql",import.meta.url),"utf8"));
  db.prepare("INSERT INTO apps_mates(id,org_id,org_slug,owner_user_id,display_name,job_role,work_email,status,visibility,draft_revision,draft_manifest_json,draft_documents_json,created_at,updated_at) VALUES('mate','org','org','owner','Mate','Assistant','mate@example.com','published','private',1,'{}','[]','now','now')").run();
  db.prepare("INSERT INTO apps_mate_releases(id,mate_id,version,status,schema_version,manifest_sha256,manifest_json,documents_json,created_by,created_at) VALUES('mate-r1','mate',1,'published','workspace.agentruntime/v1','original-digest','original-manifest','original-documents','owner','now')").run();
  db.prepare("INSERT INTO apps_mate_definition_revisions(id,mate_id,definition_type,version,digest,r2_object_key,size_bytes,source,created_by,created_at) VALUES('soul-v1','mate','soul',1,'digest','immutable-soul',5,'native','owner','now')").run();
  db.prepare("INSERT INTO apps_mate_release_definitions VALUES('mate-r1','soul-v1','soul',0,'soul-v1',1,'digest')").run();
  const before=Object.fromEntries(['apps_mate_releases','apps_mate_definition_revisions','apps_mate_release_definitions'].map(name=>[name,db.prepare('SELECT * FROM '+name).all()]));
  db.exec('BEGIN');db.exec(readFileSync(new URL('./d1-migrations/0020_mate_mail_document.sql',import.meta.url),'utf8'));db.exec('COMMIT');
  for(const [name,rows] of Object.entries(before)) assert.deepEqual(db.prepare('SELECT * FROM '+name).all(),rows);
  db.prepare("INSERT INTO apps_mate_definition_revisions(id,mate_id,definition_type,version,digest,r2_object_key,size_bytes,source,created_by,created_at) VALUES('mail-v1','mate','mail',1,'mail-digest','immutable-mail',0,'native','owner','now')").run();
  db.prepare("INSERT INTO apps_mate_release_definitions VALUES('mate-r1','mail-v1','mail',0,'mail-v1',1,'mail-digest')").run();
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.throws(()=>db.prepare("DELETE FROM apps_mate_definition_revisions WHERE id='mail-v1'").run(),/FOREIGN KEY/);
  assert.throws(()=>db.prepare("INSERT INTO apps_mate_release_definitions VALUES('missing','mail-v1','mail',0,'mail-v1',1,'mail-digest')").run(),/FOREIGN KEY/);
});
