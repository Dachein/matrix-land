import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("./migrations/20260727_knowledge_ingestion_policy.sql", import.meta.url),
  "utf8"
);

test("ingestion policy migration is retry-safe and quarantines complex binary versions", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(schema);
  database.exec(`
    INSERT INTO knowledge_namespaces (id, owner_user_id) VALUES ('ns-1', 'owner-1');
    INSERT INTO knowledge_objects (
      id, namespace_id, path, file_name, object_kind, content_kind, current_version_id
    ) VALUES
      ('text-1', 'ns-1', 'Root/guide.md', 'guide.md', 'file', 'markdown', 'version-text'),
      ('binary-1', 'ns-1', 'Root/archive.bin', 'archive.bin', 'file', 'binary', 'version-binary');
    INSERT INTO knowledge_object_versions (
      id, object_id, namespace_id, version, r2_key
    ) VALUES
      ('version-text', 'text-1', 'ns-1', 1, 'text-key'),
      ('version-binary', 'binary-1', 'ns-1', 1, 'binary-key');
  `);
  database.exec(migration);
  database.exec(migration);
  assert.deepEqual(
    database.prepare(
      "SELECT object_id, scan_status FROM knowledge_ingestion_states ORDER BY object_id"
    ).all().map((row) => ({ ...row })),
    [
      { object_id: "binary-1", scan_status: "pending" },
      { object_id: "text-1", scan_status: "clean" }
    ]
  );
  database.close();
});
