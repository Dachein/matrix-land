import { testInstallation } from "../../../../tests/helpers/installation.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let modulePromise;
async function handlerModule() {
  modulePromise ??= (async () => {
    const outdir = await mkdtemp(join(tmpdir(), "mate-mcp-test-"));
    const outfile = join(outdir, "handler.mjs");
    await build({ bundle: true, entryPoints: [new URL("../mcp/handler.ts", import.meta.url).pathname], format: "esm", logLevel: "silent", outfile, platform: "neutral" });
    const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
    await rm(outdir, { force: true, recursive: true });
    return mod;
  })();
  return modulePromise;
}

class D1Adapter {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database.prepare(sql)); }
  async batch(statements) { const output = []; for (const statement of statements) output.push(await statement.run()); return output; }
}
class Statement {
  constructor(statement, params = []) { this.statement = statement; this.params = params; }
  bind(...params) { return new Statement(this.statement, params); }
  async all() { return { results: this.statement.all(...this.params) }; }
  async first() { return this.statement.get(...this.params) ?? null; }
  async run() { this.statement.run(...this.params); return { success: true }; }
}

class R2BucketMock {
  constructor() { this.objects = new Map(); }
  async head(key) { return this.objects.get(key)?.metadata ?? null; }
  async get(key) {
    const object = this.objects.get(key);
    return object ? { ...object.metadata, async text() { return object.text; } } : null;
  }
  async put(key, value, options = {}) {
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    const metadata = { customMetadata: options.customMetadata ?? {}, key, size: new TextEncoder().encode(text).byteLength };
    this.objects.set(key, { metadata, text });
    return metadata;
  }
}

function env() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  return { ...testInstallation, DEV_AUTH_BYPASS: "1", APPS_DB: new D1Adapter(database), MATE_DEFINITIONS: new R2BucketMock() };
}

function request(name, args = {}) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-workspace-org-id": "org-1",
      "x-workspace-org-slug": "org-1",
      "x-workspace-scopes": "apps:mates:read,apps:mates:write",
      "x-workspace-user-id": "owner-1",
      "x-workspace-user-name": "Fixture Owner",
      "x-workspace-department-name": "Research"
    },
    body: JSON.stringify({ id: name, jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args } })
  });
}

async function call(handler, bindings, name, args = {}) {
  const response = await handler(request(name, args), bindings, { waitUntil() {} });
  const rpc = await response.json();
  assert.equal(rpc.error, undefined);
  if (rpc.result.isError) return { error: rpc.result.structuredContent.error };
  return JSON.parse(rpc.result.content[0].text);
}

describe("Mate MCP Builder lifecycle", () => {
  it("creates, reviews, updates, deploys Preview, and publishes Soul/Handbook/mail.md through MCP", async () => {
    const { handleMcpRequest } = await handlerModule();
    const bindings = env();
    const created = await call(handleMcpRequest, bindings, "apps_mate_create", {
      avatarUrl: "data:image/png;base64,aGVsbG8=",
      displayName: "Knowledge Mate",
      jobRole: "Answer from authorized internal knowledge",
      knowledgeServiceIds: ["company-knowledge"],
      workEmail: "knowledge@mate.example.invalid"
    });
    assert.equal(created.mate.id, "knowledge");
    assert.equal(created.mate.avatarUrl, "data:image/png;base64,aGVsbG8=");
    assert.equal(created.mate.draftManifest.mate.avatarRef, "data:image/png;base64,aGVsbG8=");

    const identityUpdated = await call(handleMcpRequest, bindings, "apps_mate_update", {
      avatarUrl: "https://assets.example.com/knowledge-mate.png",
      mateId: created.mate.id
    });
    assert.equal(identityUpdated.mate.avatarUrl, "https://assets.example.com/knowledge-mate.png");
    assert.equal(identityUpdated.mate.draftManifest.mate.avatarRef, "https://assets.example.com/knowledge-mate.png");

    const review = await call(handleMcpRequest, bindings, "apps_mate_core_review", { mateId: created.mate.id });
    assert.match(review.soul.content, /Knowledge Mate/);
    assert.match(review.soul.content, /Primary user: "Fixture Owner"/);
    assert.match(review.soul.content, /Department: "Research"/);
    assert.match(review.handbooks[0].content, /current user/);
    assert.equal(review.review.deployAndPublishRequiredToTakeEffect, true);
    assert.equal(review.mail.fileName, "mail.md");
    assert.match(review.mail.content, /get_mail_task_handbook/);
    assert.match(review.mail.content, /reply=none/);
    assert.match(review.mail.ref.digest, /^sha256:/);

    const updated = await call(handleMcpRequest, bindings, "apps_mate_core_update", {
      mateId: created.mate.id,
      expectedRevision: review.mate.draftRevision,
      soul: "# Knowledge Soul v2\n\nUse only authorized sources.",
      handbook: "# Knowledge Handbook v2\n\nSearch and cite authorized knowledge.",
      mail: "# Mail\nStore newsletters; create authorized invoice tasks without replies."
    });
    assert.equal(updated.mate.draftRevision, review.mate.draftRevision + 1);
    assert.match(updated.mate.draftManifest.release.soul.digest, /^sha256:/);
    assert.match(updated.mate.draftDocuments.find(d=>d.kind==='mail').content,/invoice/);
    const stale = await call(handleMcpRequest, bindings, "apps_mate_core_update", {mateId:created.mate.id,expectedRevision:review.mate.draftRevision,mail:"stale"});
    assert.equal(stale.error.code,"mate_draft_revision_conflict");
    const conflict=await call(handleMcpRequest,bindings,"apps_mate_core_update",{mateId:created.mate.id,expectedRevision:updated.mate.draftRevision,mail:'one',inboxPrompt:'two'});
    assert.equal(conflict.error.code,"mate_mail_alias_conflict");

    const validation = await call(handleMcpRequest, bindings, "apps_mate_validate", { mateId: created.mate.id });
    assert.equal(validation.validation.valid, true);

    const denied = await call(handleMcpRequest, bindings, "apps_mate_deploy_preview", { mateId: created.mate.id, confirm: false });
    assert.equal(denied.error.code, "explicit_user_confirmation_required");
    const deployed = await call(handleMcpRequest, bindings, "apps_mate_deploy_preview", { mateId: created.mate.id, confirm: true });
    assert.equal(deployed.release.id, "knowledge-r1");
    assert.equal(deployed.release.status, "candidate");
    assert.match(deployed.adoptionPreview.testUrl, /\/mates\/knowledge/);

    const publishDenied = await call(handleMcpRequest, bindings, "apps_mate_publish", { mateId: created.mate.id, releaseId: deployed.release.id, confirm: false });
    assert.equal(publishDenied.error.code, "explicit_user_confirmation_required");
    const published = await call(handleMcpRequest, bindings, "apps_mate_publish", { mateId: created.mate.id, releaseId: deployed.release.id, confirm: true });
    assert.equal(published.release.status, "published");
    assert.match(published.release.documents.find(d=>d.kind==='mail').content,/invoice/);
  });
});
