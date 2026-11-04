import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { zipSync } from "fflate";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../../index.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false
});
const schema = await readFile(new URL("../../../db/schema.sql", import.meta.url), "utf8");

test("ZIP imports long Unicode paths with empty files on the actual D1 runtime", async (t) => {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-07-03",
    d1Databases: ["KNOWLEDGE_DB"],
    r2Buckets: ["KNOWLEDGE_OBJECTS"],
    bindings: {
      DEV_AUTH_BYPASS: "1",
      KNOWLEDGE_ORG_ID: "org-1",
      KNOWLEDGE_V2_ROOT_ACL_ENABLED: "1",
      KNOWLEDGE_V2_MUTATION_SPINE_ENABLED: "1"
    }
  }));
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("KNOWLEDGE_DB");
  await db.exec(schema.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  const folderResponse = await runtime.dispatchFetch("http://localhost/api/folders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Existing" })
  });
  assert.equal(folderResponse.status, 201);
  const existingRoot = (await folderResponse.json()).item;

  const entries = {
    "docs/pb_partners/new_RM_QA.md": new Uint8Array(),
    "docs/pb_partners/banks/中文 空格.xlsx": new Uint8Array([1, 2, 3]),
    "docs/pb_partners/说明.docx": new Uint8Array([4, 5, 6])
  };
  for (let index = 0; index < 35; index += 1) {
    entries[`docs/pb_partners/banks/银行 ${index}.md`] = new TextEncoder().encode(`# Synthetic ${index}\n`);
  }
  const bytes = zipSync(entries);
  const fileName = "PB_SupplyChain_Jellyfish原始知识库_2026-07-13.zip";
  const upload = async () => {
    const form = new FormData();
    form.set("file", new File([bytes], fileName, { type: "application/zip" }));
    const request = new Request("http://localhost/api/files/upload", {
      method: "POST", headers: { "idempotency-key": "long-unicode-zip" }, body: form
    });
    return runtime.dispatchFetch(request.url, {
      method: request.method, headers: Object.fromEntries(request.headers), body: await request.arrayBuffer()
    });
  };
  const response = await upload();
  const body = await response.json();
  assert.equal(response.status, 201, body.error);
  assert.equal(body.items.filter(item => item.kind === "file").length, 38);
  assert.ok(body.items.every(item => item.ownerUserId === "local-dev-admin" && item.effectiveRole === "owner"));
  const empty = body.items.find(item => item.name === "new_RM_QA.md");
  assert.equal(empty.sizeBytes, 0);
  const version = await db.prepare("SELECT * FROM knowledge_object_versions WHERE id = ?").bind(empty.currentVersionId).first();
  assert.equal(version.sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const r2 = await runtime.getR2Bucket("KNOWLEDGE_OBJECTS");
  assert.equal((await r2.get(version.r2_key)).size, 0);
  const replay = await upload();
  const replayBody = await replay.json();
  assert.equal(replay.status, 201, replayBody.error);
  assert.equal(replayBody.importJobId, body.importJobId);
  assert.deepEqual(replayBody.items.map(item => item.id), body.items.map(item => item.id));

  // A new key must detect the existing literal root, even beyond D1's LIKE limit.
  const conflictingForm = new FormData();
  conflictingForm.set("file", new File([bytes], fileName));
  const conflictRequest = new Request("http://localhost/api/files/upload", {
    method: "POST", headers: { "idempotency-key": "different-key" }, body: conflictingForm
  });
  const conflictResponse = await runtime.dispatchFetch(conflictRequest.url, {
    method: "POST", headers: Object.fromEntries(conflictRequest.headers), body: await conflictRequest.arrayBuffer()
  });
  assert.equal(conflictResponse.status, 409);
  assert.equal((await conflictResponse.json()).error, "knowledge_zip_root_exists");

  // Nested imports inherit the existing root owner and collaborator ACL.
  await db.prepare(`INSERT INTO knowledge_permissions (
    id, namespace_id, object_id, subject_type, subject_id, role, granted_by_user_id
  ) SELECT 'zip-collaborator', namespace_id, id, 'user', 'zip-editor', 'collaborator', 'local-dev-admin'
    FROM knowledge_objects WHERE id = ?`).bind(existingRoot.id).run();
  const nestedForm = new FormData();
  nestedForm.set("file", new File([bytes], fileName));
  nestedForm.set("parentObjectId", existingRoot.id);
  const nestedRequest = new Request("http://localhost/api/files/upload", {
    method: "POST",
    headers: {
      "idempotency-key": "nested-zip",
      "x-workspace-org-id": "org-1",
      "x-workspace-user-id": "zip-editor",
      "x-workspace-user-email": "zip-editor@example.invalid",
      "x-workspace-role": "member",
      "x-workspace-scopes": "workspace:knowledge:read,workspace:knowledge:write"
    },
    body: nestedForm
  });
  const nestedResponse = await runtime.dispatchFetch(nestedRequest.url, {
    method: "POST", headers: Object.fromEntries(nestedRequest.headers), body: await nestedRequest.arrayBuffer()
  });
  const nested = await nestedResponse.json();
  assert.equal(nestedResponse.status, 201, nested.error);
  assert.ok(nested.items.every(item => item.ownerUserId === "local-dev-admin" && item.effectiveRole === "collaborator"));
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM knowledge_permissions WHERE object_id = ?")
    .bind(nested.item.id).first("count"), 0);
  assert.equal(await db.prepare("SELECT root_object_id FROM knowledge_change_sets WHERE operation = 'zip_import' AND root_object_id = ?")
    .bind(existingRoot.id).first("root_object_id"), existingRoot.id);
});
