import { fileURLToPath } from "node:url";
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
import { upgradedDefaultMateModelPolicy } from "../../../../src/shared/mateModelOptions.ts";

it("upgrades inherited model options idempotently while preserving custom policies and multimodal settings", () => {
  const policy = { allowUserSelection: true, defaultModel: "cf-openai-gpt-6-luna",
    allowedModels: ["cf-openai-gpt-6-luna", "cf-anthropic-claude-haiku-5.5"], multimodal: { audioInput: false, imageInput: true, documentInput: true } };
  const original = JSON.stringify(policy);
  const upgraded = upgradedDefaultMateModelPolicy(policy);
  assert.deepEqual(upgraded.allowedModels, [...policy.allowedModels, "tencent-deepseek-v4.1-flash"]);
  assert.equal(upgraded.defaultModel, policy.defaultModel);
  assert.deepEqual(upgraded.multimodal, policy.multimodal);
  assert.equal(upgradedDefaultMateModelPolicy(upgraded), undefined);
  assert.equal(upgradedDefaultMateModelPolicy({ ...policy, defaultModel: "cf-anthropic-claude-haiku-5.5" }), undefined);
  assert.equal(upgradedDefaultMateModelPolicy({ ...policy, allowedModels: [...policy.allowedModels, "custom-model"] }), undefined);
  assert.equal(upgradedDefaultMateModelPolicy({ ...policy, allowedModels: [] }), undefined);
  assert.equal(JSON.stringify(policy), original);
});

let workerModulePromise;

async function workerModule() {
  workerModulePromise ??= (async () => {
    const outdir = await mkdtemp(join(tmpdir(), "apps-mate-worker-test-"));
    const outfile = join(outdir, "worker.mjs");
    await build({
      bundle: true,
      entryPoints: [fileURLToPath(new URL("../worker.ts", import.meta.url))],
      format: "esm",
      logLevel: "silent",
      outfile,
      platform: "neutral"
    });
    const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
    await rm(outdir, { force: true, recursive: true });
    return mod;
  })();
  return workerModulePromise;
}

class D1Adapter {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1StatementAdapter(this.database.prepare(sql)); }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class D1StatementAdapter {
  constructor(statement, params = []) { this.params = params; this.statement = statement; }
  bind(...params) { return new D1StatementAdapter(this.statement, params); }
  async all() { return { results: this.statement.all(...this.params) }; }
  async first() { return this.statement.get(...this.params) ?? null; }
  async run() { this.statement.run(...this.params); return { success: true }; }
}

class R2BucketMock {
  constructor() { this.objects = new Map(); }
  async head(key) { return this.objects.get(key)?.metadata ?? null; }
  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { ...object.metadata, async text() { return object.text; }, async arrayBuffer() { return object.bytes.slice().buffer; } };
  }
  async put(key, value, options = {}) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    const text = new TextDecoder().decode(bytes);
    const metadata = {
      customMetadata: options.customMetadata ?? {},
      key,
      size: bytes.byteLength
    };
    this.objects.set(key, { metadata, text, bytes });
    return metadata;
  }
}

function env() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  const definitions = new R2BucketMock();
  return { ...testInstallation,
    DEV_AUTH_BYPASS: "1",
    APPS_DB: new D1Adapter(database),
    MODEL_HEALTH_DB: new D1Adapter(database),
    APPS_ARTIFACTS: new R2BucketMock(),
    MATE_DEFINITIONS: definitions,
    MATE_RUNTIME_SERVICE_TOKEN: "runtime-service-token"
  };
}

function request(path, { body, email, method = "GET", scopes = "apps:mates:read,apps:mates:write", userId = "owner-1" } = {}) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      "x-workspace-org-id": "org-1",
      "x-workspace-org-slug": "org-1",
      "x-workspace-scopes": scopes,
      "x-workspace-user-id": userId,
      ...(email ? { "x-workspace-user-email": email } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

const context = { waitUntil() {} };

describe("Mate control plane", () => {
  it("lets only the owner publish a self-definition update through the Runtime service", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const owner = { userId: "owner-1", email: "owner@example.test" };
    const created = await handleAppsWorkerRequest(request("/mates/default", {
      ...owner, method: "POST", body: {
        displayName: "Owner Mate",
        avatarUrl: "https://ai.example.invalid/assets/mate-pets/hoots.webp"
      }
    }), bindings, context);
    assert.equal(created.status, 200, await created.clone().text());
    const mate = (await created.json()).mate;
    const selfPath = `/internal/runtime/mates/${mate.id}/self-definition`;
    const runtimeRequest = (userId, method = "GET", body) => new Request(`http://localhost${selfPath}`, {
      method,
      headers: {
        Authorization: "Bearer runtime-service-token",
        "Content-Type": "application/json",
        "x-workspace-runtime-user-id": userId,
        "x-workspace-runtime-org-id": "org-1"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const denied = await handleAppsWorkerRequest(runtimeRequest("other-user"), bindings, context);
    assert.equal(denied.status, 404);
    const reviewResponse = await handleAppsWorkerRequest(runtimeRequest(owner.userId), bindings, context);
    assert.equal(reviewResponse.status, 200);
    const review = await reviewResponse.json();
    assert.equal(review.activeReleaseId, mate.activeReleaseId);
    const change = {
      expectedReleaseId: review.activeReleaseId,
      expectedDraftRevision: review.draftRevision,
      soul: "# Updated Soul\n\nOwner approved.",
      handbook: "# Updated Handbook\n\nFollow the new policy.",
      builtInToolIds: review.builtInToolIds.filter((id) => id !== "ocr"),
      mcpCapacity: { ai_capacity: { mode: "none" }, forum_hub: { mode: "all" } },
      skill: {
        skillMarkdown: "---\nname: Owner Review\ndescription: Review owner requests\n---\n\n# Owner Review\n\nCheck the request.",
        files: [{ path: 'references/guide.md', content: 'Check the actual source before making a decision.' }],
        version: "1.0.0"
      }
    };
    const appliedResponse = await handleAppsWorkerRequest(runtimeRequest(owner.userId, "POST", change), bindings, context);
    assert.equal(appliedResponse.status, 200, await appliedResponse.clone().text());
    const applied = await appliedResponse.json();
    assert.notEqual(applied.release.id, mate.activeReleaseId);
    assert.equal(applied.release.documents.find((item) => item.kind === "soul").content, change.soul);
    assert.equal(applied.release.manifest.resources.builtInToolBindings.some((item) => item.toolId === "ocr"), false);
    assert.equal(applied.release.manifest.resources.mcpCapacity.ai_capacity.mode, "none");
    assert.equal(applied.release.manifest.release.skills.length, 1);
    const runtimeResponse = await handleAppsWorkerRequest(new Request(`http://localhost/internal/runtime/mates/${mate.id}`, {
      headers: {
        Authorization: "Bearer runtime-service-token",
        "x-workspace-runtime-user-id": owner.userId,
        "x-workspace-runtime-org-id": "org-1"
      }
    }), bindings, context);
    assert.equal(runtimeResponse.status, 200, await runtimeResponse.clone().text());
    const runtime = await runtimeResponse.json();
    assert.equal(runtime.skills[0].markdown, change.skill.skillMarkdown);
    assert.ok(runtime.skills[0].files.includes('references/guide.md'));
    const skillFile = (path, userId = owner.userId) => new Request(`http://localhost/internal/runtime/mates/${mate.id}/skill-file?` +
      new URLSearchParams({ releaseId: applied.release.id, skillId: applied.skill.id, path }), { headers: {
        Authorization: 'Bearer runtime-service-token', 'x-workspace-runtime-user-id': userId, 'x-workspace-runtime-org-id': 'org-1'
      } });
    const resource = await handleAppsWorkerRequest(skillFile('references/guide.md'), bindings, context);
    assert.equal(resource.status, 200, await resource.clone().text());
    assert.equal((await resource.json()).content, change.skill.files[0].content);
    assert.equal((await handleAppsWorkerRequest(skillFile('../guide.md'), bindings, context)).status, 400);
    assert.equal((await handleAppsWorkerRequest(skillFile('references/guide.md', 'shared-user'), bindings, context)).status, 404);
    const otherRuntimeResponse = await handleAppsWorkerRequest(new Request(`http://localhost/internal/runtime/mates/${mate.id}`, {
      headers: {
        Authorization: "Bearer runtime-service-token",
        "x-workspace-runtime-user-id": "other-user",
        "x-workspace-runtime-org-id": "org-1"
      }
    }), bindings, context);
    assert.deepEqual((await otherRuntimeResponse.json()).skills, []);
    const stale = await handleAppsWorkerRequest(runtimeRequest(owner.userId, "POST", change), bindings, context);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "mate_active_release_changed");
    const nextReview = await (await handleAppsWorkerRequest(runtimeRequest(owner.userId), bindings, context)).json();
    const revisedSkillMarkdown = "---\nname: Owner Review\ndescription: Review owner requests\n---\n\n# Owner Review\n\nCheck the updated request.";
    const revised = await handleAppsWorkerRequest(runtimeRequest(owner.userId, "POST", {
      expectedReleaseId: nextReview.activeReleaseId,
      expectedDraftRevision: nextReview.draftRevision,
      skill: { skillId: applied.skill.id, skillMarkdown: revisedSkillMarkdown, version: "1.0.1" }
    }), bindings, context);
    assert.equal(revised.status, 200, await revised.clone().text());
    const revisedBody = await revised.json();
    assert.equal(revisedBody.release.manifest.release.skills[0].version, "1.0.1");
    assert.equal(revisedBody.skill.id, applied.skill.id);
    const pluginPath = `/mates/${mate.id}/plugins`;
    assert.equal((await handleAppsWorkerRequest(request(pluginPath, { ...owner, userId: 'shared-user' }), bindings, context)).status, 404);
    const pluginReview = await (await handleAppsWorkerRequest(request(pluginPath, owner), bindings, context)).json();
    assert.equal(pluginReview.skills[0].name, 'Owner Review');
    const removed = await handleAppsWorkerRequest(request(pluginPath, { ...owner, method: 'POST', body: {
      expectedReleaseId: pluginReview.activeReleaseId, expectedDraftRevision: pluginReview.draftRevision, removeSkillIds: [applied.skill.id]
    } }), bindings, context);
    assert.equal(removed.status, 200, await removed.clone().text());
    assert.deepEqual((await removed.json()).release.manifest.release.skills, []);
    const afterRemoval = await (await handleAppsWorkerRequest(runtimeRequest(owner.userId), bindings, context)).json();
    const pinned = revisedBody.release.manifest.release.skills[0];
    const invalid = await handleAppsWorkerRequest(runtimeRequest(owner.userId, 'POST', {
      expectedReleaseId: afterRemoval.activeReleaseId, expectedDraftRevision: afterRemoval.draftRevision,
      installSkill: { ...pinned, digest: `sha256:${'0'.repeat(64)}` }
    }), bindings, context);
    assert.equal(invalid.status, 409);
    const reinstalled = await handleAppsWorkerRequest(runtimeRequest(owner.userId, 'POST', {
      expectedReleaseId: afterRemoval.activeReleaseId, expectedDraftRevision: afterRemoval.draftRevision, installSkill: pinned
    }), bindings, context);
    assert.equal(reinstalled.status, 200, await reinstalled.clone().text());
    assert.equal((await reinstalled.json()).release.manifest.release.skills[0].skillId, applied.skill.id);
    bindings.MATE_MCP_SERVICE_TOKEN = 'plugins-token';
    const access = userId => new Request(`http://localhost/internal/mate-plugins/${mate.id}/owner`, { headers: {
      Authorization: 'Bearer plugins-token', 'x-workspace-runtime-user-id': userId, 'x-workspace-runtime-org-id': 'org-1'
    } });
    assert.equal((await handleAppsWorkerRequest(access(owner.userId), bindings, context)).status, 200);
    assert.equal((await handleAppsWorkerRequest(access('shared-user'), bindings, context)).status, 404);
    // Updating an identity creates a valid pending draft without publishing it.
    await handleAppsWorkerRequest(request(`/mates/${mate.id}`, { ...owner, method: 'PATCH', body: { description: 'Pending unrelated identity edit' } }), bindings, context);
    const dirtyReview = await (await handleAppsWorkerRequest(request(pluginPath, owner), bindings, context)).json();
    assert.equal(dirtyReview.hasUnpublishedChanges, true);
    const blocked = await handleAppsWorkerRequest(request(pluginPath, { ...owner, method: 'POST', body: {
      expectedReleaseId: dirtyReview.activeReleaseId, expectedDraftRevision: dirtyReview.draftRevision, removeSkillIds: [applied.skill.id]
    } }), bindings, context);
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error, 'mate_unpublished_draft_changes');
  });
  it("uses one personal Mate Runtime definition for default and Agent/Web quick creation", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const owner = { userId: "owner-1", email: "sam@example.invalid" };
    const avatarUrl = "https://ai.example.invalid/assets/mate-pets/hoots.webp";
    const defaultResponse = await handleAppsWorkerRequest(request("/mates/default", {
      ...owner, method: "POST", body: { displayName: "Sam", avatarUrl }
    }), bindings, context);
    assert.equal(defaultResponse.status, 200);
    const defaultMate = (await defaultResponse.json()).mate;
    const quickResponse = await handleAppsWorkerRequest(request("/mates", {
      ...owner, method: "POST", body: {
        creationProfile: "personal_mate", avatarUrl, displayName: "Quick Mate",
        jobRole: "Personal assistant", workEmail: "quick-sam@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(quickResponse.status, 201, await quickResponse.clone().text());
    const quickMate = (await quickResponse.json()).mate;
    const defaultDetail = (await (await handleAppsWorkerRequest(request(`/mates/${defaultMate.id}`, owner), bindings, context)).json()).mate;
    assert.deepEqual(quickMate.draftManifest.resources, defaultDetail.draftManifest.resources);
    assert.deepEqual(quickMate.draftManifest.modelPolicy, defaultDetail.draftManifest.modelPolicy);
    assert.equal(defaultDetail.draftManifest.modelPolicy.defaultModel, "cf-openai-gpt-6-luna");
    assert.deepEqual(defaultDetail.draftManifest.modelPolicy.allowedModels, ["cf-openai-gpt-6-luna", "cf-anthropic-claude-haiku-5.5", "tencent-deepseek-v4.1-flash"]);
    assert.equal(defaultDetail.draftManifest.modelPolicy.allowUserSelection, true);
    assert.deepEqual(quickMate.draftManifest.channels, defaultDetail.draftManifest.channels);
    assert.equal(quickMate.draftManifest.resources.builtInToolBindings.some((item) => item.toolId === "public_web_search"), true);
  });

  it("activates one editable, non-archivable default Mate with a fixed user mailbox", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const owner = { userId: "owner-1", email: "jane.doe@example.invalid" };
    const before = await handleAppsWorkerRequest(request("/mates/default", owner), bindings, context);
    assert.deepEqual(await before.json(), { mate: null });
    const input = { displayName: "Jane's Mate", avatarUrl: "https://ai.example.invalid/assets/mate-pets/hoots.webp" };
    const first = await handleAppsWorkerRequest(request("/mates/default", { ...owner, method: "POST", body: input }), bindings, context);
    assert.equal(first.status, 200);
    const mate = (await first.json()).mate;
    assert.equal(mate.isDefault, true);
    assert.equal(mate.status, "published");
    assert.equal(mate.workEmail, "jane.doe@mate.example.invalid");
    const again = await handleAppsWorkerRequest(request("/mates/default", { ...owner, method: "POST", body: input }), bindings, context);
    assert.equal((await again.json()).mate.id, mate.id);
    const rows = await bindings.APPS_DB.prepare("SELECT id FROM apps_mates WHERE owner_user_id = ?").bind(owner.userId).all();
    assert.equal(rows.results.length, 1);
    const archive = await handleAppsWorkerRequest(request(`/mates/${mate.id}`, { ...owner, method: "DELETE" }), bindings, context);
    assert.equal(archive.status, 409);
    assert.equal((await archive.json()).error, "default_mate_cannot_archive");
    const detail = (await (await handleAppsWorkerRequest(request(`/mates/${mate.id}`, owner), bindings, context)).json()).mate;
    assert.equal(detail.draftManifest.resources.appMcpScope.mode, "all_visible_to_invoking_user");
    assert.equal(detail.draftManifest.resources.knowledgeServiceScope.mode, "all_visible_to_invoking_user");
    assert.equal(detail.draftManifest.resources.folderEditScope.mode, "all_visible_to_invoking_user");
    assert.equal(detail.draftManifest.resources.mcpCapacity.ai_capacity.mode, "all");
    assert.equal(detail.draftManifest.resources.mcpCapacity.forum_hub.mode, "all");
    const changed = await handleAppsWorkerRequest(request(`/mates/${mate.id}`, { ...owner, method: "PATCH", body: {
      displayName: "Changed", avatarUrl: "https://ai.example.invalid/assets/mate-pets/workspace-bot.webp"
    } }), bindings, context);
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).mate.displayName, "Changed");
    const codeChange = await handleAppsWorkerRequest(request(`/mates/${mate.id}`, { ...owner, method: "PATCH", body: {
      workEmail: "different@mate.example.invalid"
    } }), bindings, context);
    assert.equal(codeChange.status, 409);
    assert.equal((await codeChange.json()).error, "mate_code_immutable");
    const changedAddress = structuredClone(detail.draftManifest);
    changedAddress.mate.addresses.find((address) => address.type === "email").address = "different@mate.example.invalid";
    const draftCodeChange = await handleAppsWorkerRequest(request(`/mates/${mate.id}/draft`, { ...owner, method: "PUT", body: {
      documents: detail.draftDocuments, expectedRevision: detail.draftRevision + 1, manifest: changedAddress
    } }), bindings, context);
    assert.equal(draftCodeChange.status, 422);
    const draft = await handleAppsWorkerRequest(request(`/mates/${mate.id}/draft`, { ...owner, method: "PUT", body: {
      documents: detail.draftDocuments, expectedRevision: detail.draftRevision + 1,
      manifest: { ...detail.draftManifest, mate: { ...detail.draftManifest.mate, displayName: "Changed" } }
    } }), bindings, context);
    assert.equal(draft.status, 200);
    const deployed = await handleAppsWorkerRequest(request(`/mates/${mate.id}/deploy`, { ...owner, method: "POST" }), bindings, context);
    assert.equal(deployed.status, 201);
    const release = (await deployed.json()).release;
    const published = await handleAppsWorkerRequest(request(`/mates/${mate.id}/releases/${release.id}/publish`, { ...owner, method: "POST" }), bindings, context);
    assert.equal(published.status, 200);
    const restored = await handleAppsWorkerRequest(request(`/mates/${mate.id}/releases/${mate.activeReleaseId}/activate`, { ...owner, method: "POST" }), bindings, context);
    assert.equal(restored.status, 200);
    const activatedAgain = await handleAppsWorkerRequest(request("/mates/default", { ...owner, method: "POST", body: input }), bindings, context);
    assert.equal(activatedAgain.status, 200);
    assert.equal((await activatedAgain.json()).mate.displayName, "Changed");
    const extra = await handleAppsWorkerRequest(request("/mates", { ...owner, method: "POST", body: {
      displayName: "Extra Mate", jobRole: "Other work", workEmail: "extra-mate@mate.example.invalid"
    } }), bindings, context);
    assert.equal(extra.status, 201);
    await assert.rejects(() => bindings.APPS_DB.prepare("UPDATE apps_mates SET is_default = 1 WHERE id = ?")
      .bind("extra-mate").run(), /UNIQUE constraint failed/);
  });

  it("exposes the default identity during provisioning and resumes it after deployment fails", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const owner = { userId: "owner-progress", email: "progress@example.invalid" };
    const input = { displayName: "Progress Mate", avatarUrl: "https://ai.example.invalid/assets/mate-pets/hoots.webp" };
    const bucket = bindings.MATE_DEFINITIONS;
    const originalPut = bucket.put.bind(bucket);
    let observed;
    bucket.put = async () => {
      const response = await handleAppsWorkerRequest(request("/mates/default", owner), bindings, context);
      observed = (await response.json()).mate;
      throw new Error("storage temporarily unavailable");
    };
    const failed = await handleAppsWorkerRequest(request("/mates/default", { ...owner, method: "POST", body: input }), bindings, context);
    assert.equal(failed.status, 500);
    assert.equal(observed.isDefault, true);
    assert.equal(observed.status, "draft");
    bucket.put = originalPut;
    const retry = await handleAppsWorkerRequest(request("/mates/default", { ...owner, method: "POST", body: input }), bindings, context);
    assert.equal(retry.status, 200);
    const published = (await retry.json()).mate;
    assert.equal(published.id, observed.id);
    assert.equal(published.status, "published");
    const rows = await bindings.APPS_DB.prepare("SELECT id FROM apps_mates WHERE owner_user_id = ?").bind(owner.userId).all();
    assert.equal(rows.results.length, 1);
  });

  it("adopts the owner's existing Mate at the reserved email", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const owner = { userId: "owner-1", email: "alex@example.invalid" };
    const existing = await handleAppsWorkerRequest(request("/mates", { ...owner, method: "POST", body: {
      displayName: "Alex", jobRole: "Assistant", visibility: "public", workEmail: "alex@mate.example.invalid"
    } }), bindings, context);
    assert.equal(existing.status, 201);
    const oldId = (await existing.json()).mate.id;
    const activated = await handleAppsWorkerRequest(request("/mates/default", { ...owner, method: "POST", body: {
      displayName: "My Mate", avatarUrl: "https://ai.example.invalid/assets/mate-pets/codex.webp"
    } }), bindings, context);
    assert.equal(activated.status, 200);
    const mate = (await activated.json()).mate;
    assert.equal(mate.id, oldId);
    assert.equal(mate.displayName, "My Mate");
    assert.equal(mate.avatarUrl, "https://ai.example.invalid/assets/mate-pets/codex.webp");
    assert.equal(mate.isDefault, true);
    assert.equal(mate.status, "published");
    const detail = await handleAppsWorkerRequest(request(`/mates/${mate.id}`, owner), bindings, context);
    const definition = (await detail.json()).mate.draftManifest;
    assert.equal(definition.resources.workspacePassMcpScope, undefined);
    assert.equal(definition.resources.knowledgeServiceScope.mode, "all_visible_to_invoking_user");
    assert.deepEqual(definition.resources.mcpCapacity, { ai_capacity: { mode: "all" }, forum_hub: { mode: "all" } });
    assert.equal(definition.invocationPolicy.visibility, "private");
    assert.equal(definition.mate.jobRole, "个人工作秘书");
  });
  it("archives a Mate by revoking active releases and retaining its definition history", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const createdResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        displayName: "Archive Test Mate",
        jobRole: "Verify reversible removal",
        workEmail: "archive-test-mate@mate.example.invalid"
      }
    }), bindings, context);
    const created = (await createdResponse.json()).mate;
    const release = (await (await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`, { method: "POST" }), bindings, context)).json()).release;
    await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${release.id}/publish`, { method: "POST" }), bindings, context);

    const archivedResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}`, { method: "DELETE" }), bindings, context);
    assert.equal(archivedResponse.status, 200);
    assert.deepEqual(await archivedResponse.json(), { archived: true });
    const stored = await bindings.APPS_DB.prepare("SELECT status, active_release_id FROM apps_mates WHERE id = ?").bind(created.id).first();
    const storedRelease = await bindings.APPS_DB.prepare("SELECT status FROM apps_mate_releases WHERE id = ?").bind(release.id).first();
    assert.equal(stored.status, "archived");
    assert.equal(stored.active_release_id, null);
    assert.equal(storedRelease.status, "revoked");
    assert.ok(bindings.MATE_DEFINITIONS.objects.size > 0, "archival preserves retained definitions");
  });

  it("binds Runtime-owned private task tools while preserving public web opt-out", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const defaultResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        displayName: "Web Reader",
        jobRole: "Read and summarize public webpages",
        workEmail: "web-reader@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(defaultResponse.status, 201);
    const defaultManifest = (await defaultResponse.json()).mate.draftManifest;
    assert.deepEqual(defaultManifest.resources.builtInToolBindings.map((binding) => binding.toolId), [
      "public_web_read",
      "todo_manage",
      "reminder_manage"
    ]);

    const optOutResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        builtInToolIds: [],
        displayName: "No Web Reader",
        jobRole: "Operate without public web access",
        workEmail: "no-web-reader@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(optOutResponse.status, 201);
    assert.deepEqual(
      (await optOutResponse.json()).mate.draftManifest.resources.builtInToolBindings.map((binding) => binding.toolId),
      ["todo_manage", "reminder_manage"]
    );
  });

  it("creates an identity, deploys an isolated Preview, then publishes that exact Runtime release", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const createResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        builtInToolIds: ["document_read"],
        description: "Answers from authorized internal sources.",
        displayName: "Knowledge Mate",
        jobRole: "Find and explain authorized internal knowledge",
        knowledgeServiceIds: ["company-knowledge"],
        folderEditIds: ["pb-root"],
        visibility: "organization",
        workEmail: "knowledge@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()).mate;
    assert.equal(created.id, "knowledge");
    assert.equal(created.status, "draft");
    assert.equal(created.activeReleaseId, undefined);
    assert.equal(created.draftManifest.schemaVersion, "workspace.agentruntime/v1");
    assert.equal(created.draftManifest.mate.mateId, created.id);
    assert.equal(created.draftManifest.channels.inbox.mateCall.tool, "mate_call");
    assert.equal(created.draftManifest.channels.standalone.enabled, true);
    assert.equal(created.draftManifest.channels.embedded.enabled, true);
    assert.equal(created.draftManifest.channels.inbox.mateCall.enabled, false);
    assert.equal(created.draftManifest.channels.inbox.email.enabled, false);
    assert.equal(created.draftManifest.experiencePolicy.taskInbox.enabled, false);
    assert.equal(created.draftManifest.channels.inbox.webhook.enabled, false);
    assert.equal(created.draftManifest.resources.knowledgeServiceBindings[0].requiresCurrentUserAuthorization, true);
    assert.deepEqual(created.draftManifest.resources.folderEditBindings, [{
      folderObjectId: "pb-root", authority: { mode: "invoking_user" }, requiresCurrentUserAuthorization: true
    }]);
    assert.ok(created.draftManifest.resources.builtInToolBindings.some((binding) => binding.toolId === "workspace_knowledge_maintain"));
    assert.match(created.draftDocuments.find((document) => document.kind === "handbook").content, /configured Knowledge scope with the current user's Knowledge ACL/);

    const templatesResponse = await handleAppsWorkerRequest(request("/mate-templates"), bindings, context);
    assert.equal(templatesResponse.status, 410);
    assert.equal((await templatesResponse.json()).error, "mate_templates_removed");

    const legacyCreateResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        displayName: "Legacy Template Request",
        jobRole: "Must migrate",
        templateId: "knowledge-qa-v1",
        workEmail: "legacy-template@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(legacyCreateResponse.status, 410);
    assert.equal((await legacyCreateResponse.json()).error, "mate_templates_removed");

    const validationResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}/validate`, { method: "POST" }), bindings, context);
    assert.equal(validationResponse.status, 200);
    assert.equal((await validationResponse.json()).validation.valid, true);

    const deployResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`, { method: "POST" }), bindings, context);
    assert.equal(deployResponse.status, 201);
    const deployed = await deployResponse.json();
    const release = deployed.release;
    assert.equal(release.id, "knowledge-r1");
    assert.equal(release.status, "candidate");
    assert.equal(release.manifest.release.status, "candidate");
    assert.match(release.manifestSha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(release.manifest.release.soul.version, 1);
    assert.equal(bindings.MATE_DEFINITIONS.objects.size, 4);
    const storedRelease = await bindings.APPS_DB.prepare("SELECT storage_mode, manifest_r2_key, manifest_json, documents_json FROM apps_mate_releases WHERE id = ?")
      .bind(release.id).first();
    assert.equal(storedRelease.storage_mode, "r2");
    assert.match(storedRelease.manifest_r2_key, /^mates\/knowledge\/releases\/knowledge-r1\/[a-f0-9]{64}\.json$/);
    assert.equal(storedRelease.manifest_json, "{}");
    assert.equal(storedRelease.documents_json, "[]");
    assert.equal(deployed.adoptionPreview.available, true);
    assert.equal(deployed.adoptionPreview.testUrl, "https://ai.example.invalid/mates/knowledge/preview?release=knowledge-r1");
    assert.equal(deployed.adoptionPreview.embedUrl, "https://ai.example.invalid/mates/knowledge/preview?release=knowledge-r1&presentation=embedded");
    assert.equal(deployed.adoptionPreview.conversationUrl, "https://ai.example.invalid/mates/knowledge");

    const liveBeforePublish = await handleAppsWorkerRequest(new Request(
      `http://localhost/internal/runtime/mates/${created.id}`,
      { headers: { authorization: "Bearer runtime-service-token" } }
    ), bindings, context);
    assert.equal(liveBeforePublish.status, 404);

    const ownerTestDefinition = await handleAppsWorkerRequest(new Request(
      `http://localhost/internal/runtime/mates/${created.id}/releases/${release.id}`,
      { headers: { authorization: "Bearer runtime-service-token", "x-workspace-runtime-owner-user-id": "owner-1" } }
    ), bindings, context);
    assert.equal(ownerTestDefinition.status, 200);
    assert.equal((await ownerTestDefinition.json()).release.id, release.id);

    const wrongOwnerDefinition = await handleAppsWorkerRequest(new Request(
      `http://localhost/internal/runtime/mates/${created.id}/releases/${release.id}`,
      { headers: { authorization: "Bearer runtime-service-token", "x-workspace-runtime-owner-user-id": "other-user" } }
    ), bindings, context);
    assert.equal(wrongOwnerDefinition.status, 404);

    const deployedIdentity = (await (await handleAppsWorkerRequest(request(`/mates/${created.id}`), bindings, context)).json()).mate;
    assert.equal(deployedIdentity.activeReleaseId, undefined);
    assert.equal(deployedIdentity.previewReleaseId, release.id);
    assert.equal(deployedIdentity.status, "deployed");

    const publishResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${release.id}/publish`, { method: "POST" }), bindings, context);
    assert.equal(publishResponse.status, 200);
    assert.equal((await publishResponse.json()).release.status, "published");

    const identity = (await (await handleAppsWorkerRequest(request(`/mates/${created.id}`), bindings, context)).json()).mate;
    assert.equal(identity.activeReleaseId, release.id);
    assert.equal(identity.previewReleaseId, undefined);
    assert.equal(identity.status, "published");
    assert.equal(identity.draftRevision, 1);
  });

  it("publishes an all-visible Knowledge scope only with invoking-user authorization", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const createdResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        builtInToolIds: [],
        displayName: "Platform Knowledge",
        jobRole: "Answer from every Knowledge Service visible to the caller",
        workEmail: "platform-knowledge@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()).mate;
    const manifest = structuredClone(created.draftManifest);
    manifest.resources.knowledgeServiceScope = {
      allowedOperations: ["search", "read"],
      authority: { mode: "invoking_user" },
      mode: "all_visible_to_invoking_user",
      requiresCurrentUserAuthorization: true
    };
    manifest.taskPolicy.defaultExecutor = "knowledge_qa";

    const savedResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}/draft`, {
      method: "PUT",
      body: {
        documents: created.draftDocuments,
        expectedRevision: created.draftRevision,
        manifest
      }
    }), bindings, context);
    assert.equal(savedResponse.status, 200);
    const saved = (await savedResponse.json()).mate;

    const validationResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}/validate`, { method: "POST" }), bindings, context);
    assert.equal(validationResponse.status, 200);
    const validation = (await validationResponse.json()).validation;
    assert.equal(validation.valid, true);
    assert.equal(validation.warnings.some((warning) => warning.code === "knowledge_access_checked_at_runtime"), true);

    const deployResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`, { method: "POST" }), bindings, context);
    assert.equal(deployResponse.status, 201);
    assert.equal((await deployResponse.json()).release.manifest.resources.knowledgeServiceScope.mode, "all_visible_to_invoking_user");

    const ambiguousManifest = structuredClone(saved.draftManifest);
    ambiguousManifest.resources.knowledgeServiceBindings = [{
      allowedOperations: ["search", "read"],
      authority: { mode: "invoking_user" },
      requiresCurrentUserAuthorization: true,
      serviceId: "publisher-visible-service"
    }];
    const ambiguousResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}/draft`, {
      method: "PUT",
      body: {
        documents: saved.draftDocuments,
        expectedRevision: saved.draftRevision,
        manifest: ambiguousManifest
      }
    }), bindings, context);
    assert.equal(ambiguousResponse.status, 422);
    const ambiguous = await ambiguousResponse.json();
    assert.equal(ambiguous.validation.errors.some((error) => error.code === "ambiguous_knowledge_scope"), true);
  });

  it("maps the legacy Workspace MCP flag to dynamic App and Knowledge read scopes while preserving folder bindings", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const response = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        allKnowledgeServices: true,
        appMcpBindings: [{ appId: "publisher-visible-app", manifestVersion: "workspace.app-mcp/v1" }],
        builtInToolIds: [],
        displayName: "Dynamic Workspace MCP",
        workspacePassMcpEnabled: true,
        folderEditIds: ["publisher-visible-folder"],
        jobRole: "Use the caller's current APPS and Knowledge access",
        knowledgeServiceIds: ["publisher-visible-knowledge"],
        workEmail: "dynamic-pass@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(response.status, 201, await response.clone().text());
    const created = (await response.json()).mate;
    assert.deepEqual(created.draftManifest.resources.appMcpBindings, []);
    assert.deepEqual(created.draftManifest.resources.appMcpScope, {
      authority: { mode: "invoking_user" },
      mode: "all_visible_to_invoking_user",
      requiresCurrentUserAuthorization: true
    });
    assert.deepEqual(created.draftManifest.resources.knowledgeServiceBindings, []);
    assert.equal(created.draftManifest.resources.folderEditBindings[0].folderObjectId, "publisher-visible-folder");
    assert.equal(created.draftManifest.resources.workspacePassMcpScope, undefined);
    assert.deepEqual(created.draftManifest.resources.knowledgeServiceScope, {
      authority: { mode: "invoking_user" },
      allowedOperations: ["search", "read"],
      mode: "all_visible_to_invoking_user",
      requiresCurrentUserAuthorization: true
    });

    const validationResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}/validate`, { method: "POST" }), bindings, context);
    const validation = (await validationResponse.json()).validation;
    assert.equal(validation.valid, true);
    assert.equal(validation.warnings.some((warning) => warning.code === "knowledge_access_checked_at_runtime"), true);

    const invalidManifest = structuredClone(created.draftManifest);
    invalidManifest.resources.knowledgeServiceScope.authority = { mode: "owner_delegated", grantId: "grant-1" };
    const invalidResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}/draft`, {
      method: "PUT",
      body: {
        documents: created.draftDocuments,
        expectedRevision: created.draftRevision,
        manifest: invalidManifest
      }
    }), bindings, context);
    assert.equal(invalidResponse.status, 422);
    const invalid = await invalidResponse.json();
    assert.equal(invalid.validation.errors.some((error) => error.path === "/resources/knowledgeServiceScope/authority"), true);

    const invalidCapacityManifest = structuredClone(created.draftManifest);
    invalidCapacityManifest.resources.mcpCapacity.ai_capacity = { mode: "selected", children: ["unknown"] };
    const invalidCapacityResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}/draft`, {
      method: "PUT",
      body: {
        documents: created.draftDocuments,
        expectedRevision: created.draftRevision,
        manifest: invalidCapacityManifest
      }
    }), bindings, context);
    assert.equal(invalidCapacityResponse.status, 422);
    const invalidCapacity = await invalidCapacityResponse.json();
    assert.equal(invalidCapacity.validation.errors.some((error) => error.code === "invalid_mcp_capacity"), true);
  });

  it("stores, lists, replaces, validates, and removes a Mate avatar in the draft Manifest", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const createResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        avatarUrl: dataUrl,
        displayName: "Avatar Mate",
        jobRole: "Exercise the shared avatar lifecycle",
        workEmail: "avatar@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()).mate;
    assert.equal(created.avatarUrl, dataUrl);
    assert.equal(created.draftManifest.mate.avatarRef, dataUrl);

    const listResponse = await handleAppsWorkerRequest(request("/mates"), bindings, context);
    assert.equal(listResponse.status, 200);
    const listed = (await listResponse.json()).mates.find((item) => item.id === created.id);
    assert.equal(listed.avatarUrl, dataUrl);

    const httpsAvatar = "https://assets.example.com/avatar-mate.png";
    const updateResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}`, {
      method: "PATCH",
      body: { avatarUrl: httpsAvatar }
    }), bindings, context);
    assert.equal(updateResponse.status, 200);
    const updated = (await updateResponse.json()).mate;
    assert.equal(updated.avatarUrl, httpsAvatar);
    assert.equal(updated.draftManifest.mate.avatarRef, httpsAvatar);

    const invalidResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}`, {
      method: "PATCH",
      body: { avatarUrl: "javascript:alert(1)" }
    }), bindings, context);
    assert.equal(invalidResponse.status, 400);
    assert.equal((await invalidResponse.json()).error, "mate_avatar_invalid");

    const removeResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}`, {
      method: "PATCH",
      body: { avatarUrl: "" }
    }), bindings, context);
    assert.equal(removeResponse.status, 200);
    const removed = (await removeResponse.json()).mate;
    assert.equal(removed.avatarUrl, undefined);
    assert.equal(removed.draftManifest.mate.avatarRef, undefined);
  });

  it("publishes immutable mail.md only with its release and restores the previous document on rollback",async()=>{
    const {handleAppsWorkerRequest}=await workerModule();const bindings=env();
    const created=(await (await handleAppsWorkerRequest(request('/mates',{method:'POST',body:{displayName:'Inbox policy',jobRole:'Process inbox',workEmail:'inbox-policy@mate.example.invalid'}}),bindings,context)).json()).mate;
    assert.deepEqual(created.draftDocuments.map(d=>d.kind),['soul','handbook','mail']);
    assert.equal(created.draftManifest.channels.inbox.email.inboxPrompt,undefined);
    const first=(await (await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`,{method:'POST'}),bindings,context)).json()).release;
    await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${first.id}/publish`,{method:'POST'}),bindings,context);
    const current=(await (await handleAppsWorkerRequest(request(`/mates/${created.id}`),bindings,context)).json()).mate;
    const manifest=structuredClone(current.draftManifest), documents=structuredClone(current.draftDocuments);
    const mail=documents.find(d=>d.kind==='mail');mail.content='# Mail\nCreate invoice tasks silently; send results only to the mailbox owner.';
    mail.digest='sha256:'+Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(mail.content))).toString('hex');manifest.release.mail.digest=mail.digest;
    const saved=await handleAppsWorkerRequest(request(`/mates/${created.id}/draft`,{method:'PUT',body:{documents,manifest,expectedRevision:current.draftRevision}}),bindings,context);assert.equal(saved.status,200,await saved.clone().text());
    const stale=await handleAppsWorkerRequest(request(`/mates/${created.id}/draft`,{method:'PUT',body:{documents,manifest,expectedRevision:current.draftRevision}}),bindings,context);assert.equal(stale.status,409);
    const review=(await (await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${first.id}`),bindings,context)).json()).release;assert.equal(review.documents.find(d=>d.kind==='mail').content,first.documents.find(d=>d.kind==='mail').content);
    const second=(await (await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`,{method:'POST'}),bindings,context)).json()).release;
    assert.equal(second.documents.find(d=>d.kind==='mail').content,mail.content);assert.notEqual(second.manifestSha256,first.manifestSha256);
    assert.equal(second.manifest.release.mail.version,2);assert.equal(second.manifest.release.soul.id,first.manifest.release.soul.id);assert.deepEqual(second.manifest.release.handbooks,first.manifest.release.handbooks);
    await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${second.id}/publish`,{method:'POST'}),bindings,context);
    const rollback=await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${first.id}/activate`,{method:'POST'}),bindings,context);assert.equal(rollback.status,200);assert.equal((await rollback.json()).release.documents.find(d=>d.kind==='mail').content,first.documents.find(d=>d.kind==='mail').content);
    const latest=(await saved.json()).mate;
    for(const alter of [d=>{d.find(x=>x.kind==='mail').content='tampered'},d=>d.splice(d.findIndex(x=>x.kind==='mail'),1),d=>d.push(structuredClone(d.find(x=>x.kind==='mail')))]){
      const invalid=structuredClone(documents);alter(invalid);
      const result=await handleAppsWorkerRequest(request(`/mates/${created.id}/draft`,{method:'PUT',body:{documents:invalid,manifest,expectedRevision:latest.draftRevision}}),bindings,context);assert.equal(result.status,422,await result.clone().text());
    }
    const revision=await bindings.APPS_DB.prepare("SELECT r2_object_key FROM apps_mate_definition_revisions WHERE definition_type='mail' AND version=2").first();
    bindings.MATE_DEFINITIONS.objects.get(revision.r2_object_key).text='tampered R2 content';
    const corrupt=await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${second.id}`),bindings,context);assert.equal(corrupt.status,500);
    const deniedRollback=await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${second.id}/activate`,{method:'POST'}),bindings,context);assert.equal(deniedRollback.status,500);
    const active=(await(await handleAppsWorkerRequest(request(`/mates/${created.id}`),bindings,context)).json()).mate;assert.equal(active.activeReleaseId,first.id);
  });

  it("creates independent immutable Soul and Handbook revisions and reuses unchanged content", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const created = (await (await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        builtInToolIds: ["document_read"],
        displayName: "Versioned Mate",
        jobRole: "Exercise definition revisions",
        workEmail: "versioned@mate.example.invalid"
      }
    }), bindings, context)).json()).mate;
    const first = (await (await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`, { method: "POST" }), bindings, context)).json()).release;
    await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${first.id}/publish`, { method: "POST" }), bindings, context);

    const current = (await (await handleAppsWorkerRequest(request(`/mates/${created.id}`), bindings, context)).json()).mate;
    const handbook = `${current.draftDocuments.find((document) => document.kind === "handbook").content}\n\n## Revision 2\n\nUse the reviewed escalation path.`;
    const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(handbook)));
    const handbookDigest = `sha256:${Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const documents = structuredClone(current.draftDocuments);
    documents.find((document) => document.kind === "handbook").content = handbook;
    documents.find((document) => document.kind === "handbook").digest = handbookDigest;
    const manifest = structuredClone(current.draftManifest);
    manifest.release.handbooks[0].digest = handbookDigest;
    const update = await handleAppsWorkerRequest(request(`/mates/${created.id}/draft`, {
      method: "PUT",
      body: { documents, expectedRevision: current.draftRevision, manifest }
    }), bindings, context);
    assert.equal(update.status, 200, await update.clone().text());
    const second = (await (await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`, { method: "POST" }), bindings, context)).json()).release;
    assert.equal(second.manifest.release.soul.id, first.manifest.release.soul.id);
    assert.equal(second.manifest.release.soul.version, 1);
    assert.notEqual(second.manifest.release.handbooks[0].id, first.manifest.release.handbooks[0].id);
    assert.equal(second.manifest.release.handbooks[0].version, 2);
    assert.equal(second.documents.find((document) => document.kind === "handbook").content, handbook);
    const revisions = await bindings.APPS_DB.prepare("SELECT definition_type, version FROM apps_mate_definition_revisions WHERE mate_id = ? ORDER BY definition_type, version")
      .bind(created.id).all();
    assert.deepEqual(revisions.results.map((row) => ({ ...row })), [
      { definition_type: "handbook", version: 1 },
      { definition_type: "handbook", version: 2 },
      { definition_type: "mail", version: 1 },
      { definition_type: "soul", version: 1 }
    ]);
  });

  it("reuses an unchanged legacy definition object whose sha256 metadata is missing", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const created = (await (await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        builtInToolIds: ["document_read"],
        displayName: "Legacy Definition Mate",
        jobRole: "Exercise legacy immutable object reuse",
        mateId: "legacy-definition",
        workEmail: "legacy-definition@mate.example.invalid"
      }
    }), bindings, context)).json()).mate;
    const first = (await (await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`, { method: "POST" }), bindings, context)).json()).release;
    await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${first.id}/publish`, { method: "POST" }), bindings, context);

    const soulRevision = await bindings.APPS_DB.prepare(`
      SELECT r2_object_key
      FROM apps_mate_definition_revisions
      WHERE mate_id = ? AND definition_type = 'soul'
      LIMIT 1
    `).bind(created.id).first();
    const storedSoul = bindings.MATE_DEFINITIONS.objects.get(soulRevision.r2_object_key);
    delete storedSoul.metadata.customMetadata.sha256;

    const updateResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}`, {
      method: "PATCH",
      body: { avatarUrl: "https://assets.example.com/legacy-definition-avatar.png" }
    }), bindings, context);
    assert.equal(updateResponse.status, 200);

    const secondResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`, { method: "POST" }), bindings, context);
    assert.equal(secondResponse.status, 201, await secondResponse.clone().text());
    const second = (await secondResponse.json()).release;
    assert.equal(second.manifest.release.soul.id, first.manifest.release.soul.id);
    assert.equal(second.manifest.release.soul.version, first.manifest.release.soul.version);
    assert.equal(storedSoul.metadata.customMetadata.sha256, undefined);
  });

  it("rejects a legacy definition object whose stored body conflicts with its key", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const created = (await (await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        builtInToolIds: ["document_read"],
        displayName: "Conflicting Definition Mate",
        jobRole: "Reject conflicting immutable object content",
        mateId: "conflicting-definition",
        workEmail: "conflicting-definition@mate.example.invalid"
      }
    }), bindings, context)).json()).mate;
    const first = (await (await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`, { method: "POST" }), bindings, context)).json()).release;
    await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${first.id}/publish`, { method: "POST" }), bindings, context);

    const soulRevision = await bindings.APPS_DB.prepare(`
      SELECT r2_object_key
      FROM apps_mate_definition_revisions
      WHERE mate_id = ? AND definition_type = 'soul'
      LIMIT 1
    `).bind(created.id).first();
    const storedSoul = bindings.MATE_DEFINITIONS.objects.get(soulRevision.r2_object_key);
    delete storedSoul.metadata.customMetadata.sha256;
    storedSoul.text = `${storedSoul.text.slice(0, -1)}${storedSoul.text.endsWith("x") ? "y" : "x"}`;

    const updateResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}`, {
      method: "PATCH",
      body: { avatarUrl: "https://assets.example.com/conflicting-definition-avatar.png" }
    }), bindings, context);
    assert.equal(updateResponse.status, 200);

    const secondResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`, { method: "POST" }), bindings, context);
    assert.equal(secondResponse.status, 409);
    assert.equal((await secondResponse.json()).error, "mate_definition_object_conflict");
  });

  it("fails closed when an immutable R2 definition body no longer matches its digest", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const created = (await (await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        builtInToolIds: ["document_read"],
        displayName: "Digest Mate",
        jobRole: "Verify immutable release bodies",
        workEmail: "digest@mate.example.invalid"
      }
    }), bindings, context)).json()).mate;
    const release = (await (await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`, { method: "POST" }), bindings, context)).json()).release;
    const stored = await bindings.APPS_DB.prepare("SELECT manifest_r2_key FROM apps_mate_releases WHERE id = ?").bind(release.id).first();
    bindings.MATE_DEFINITIONS.objects.get(stored.manifest_r2_key).text = "{}";
    const response = await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${release.id}`), bindings, context);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error, "mate_definition_digest_mismatch");
  });

  it("keeps Conversation collaboration on while enabling configured Task ingress", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const response = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        builtInToolIds: ["workspace_forum_read", "todo_manage", "reminder_manage"],
        defaultExecutor: "operations",
        defaultTimezone: "Asia/Shanghai",
        displayName: "Cortana",
        embeddedEnabled: false,
        jobRole: "Review Forum updates and manage AI Adoption work",
        scheduleEnabled: true,
        scheduledJobs: [{
          cadence: { at: "09:00", kind: "daily", timezone: "Asia/Shanghai" },
          delivery: { channel: "email", recipient: "owner" },
          executor: "forum_review",
          forumReview: { cursorKey: "forum.last_successful_review_at", lookbackHours: 24, maxTopics: 40 },
          id: "forum_daily_review",
          instruction: "Review Forum updates and create concrete action items.",
          title: "Workspace Forum 每日巡检"
        }],
        standaloneEnabled: false,
        taskModeEnabled: true,
        mateId: "cortana",
        visibility: "organization",
        workEmail: "cortana@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(response.status, 201, await response.clone().text());
    const mate = (await response.json()).mate;
    const manifest = mate.draftManifest;
    assert.equal(mate.id, "cortana");
    assert.equal(manifest.channels.standalone.enabled, true);
    assert.equal(manifest.channels.embedded.enabled, true);
    assert.equal(manifest.channels.inbox.email.enabled, true);
    assert.equal(manifest.channels.inbox.schedule.enabled, true);
    assert.equal(manifest.experiencePolicy.conversation.enabled, true);
    assert.deepEqual(manifest.experiencePolicy.conversation.channels, ["web", "sdk"]);
    assert.deepEqual(manifest.experiencePolicy.taskInbox.channels, ["mate_call", "email", "schedule"]);
    assert.deepEqual(manifest.resources.builtInToolBindings.map((binding) => binding.toolId), [
      "todo_manage",
      "reminder_manage"
    ]);
    assert.deepEqual(manifest.resources.mcpCapacity.forum_hub, { mode: "selected", children: ["forum_read"] });
    assert.equal(manifest.taskPolicy.defaultExecutor, undefined);
    assert.equal(manifest.taskPolicy.scheduledJobs[0].executor, undefined);
    assert.equal(manifest.taskPolicy.scheduledJobs[0].forumReview, undefined);
    assert.doesNotMatch(JSON.stringify(manifest), /cortana-admin-v1/);

    const invalid = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        displayName: "No Task Entry",
        emailEnabled: false,
        jobRole: "Reject an unusable Task mode",
        taskModeEnabled: true,
        mateCallEnabled: false,
        workEmail: "no-task-entry@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error, "mate_task_entry_required");
  });

  it("derives model switching from the ordered model Target List", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const multipleResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        allowModelSelection: false,
        allowedModels: ["model-alpha", "model-beta"],
        defaultModel: "model-beta",
        displayName: "Multi Model Mate",
        jobRole: "Switch between configured models",
        workEmail: "multi-model@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(multipleResponse.status, 201, await multipleResponse.clone().text());
    const multiplePolicy = (await multipleResponse.json()).mate.draftManifest.modelPolicy;
    assert.deepEqual(multiplePolicy.allowedModels, ["model-beta", "model-alpha"]);
    assert.equal(multiplePolicy.defaultModel, "model-beta");
    assert.equal(multiplePolicy.allowUserSelection, true);

    const singleResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        allowModelSelection: true,
        allowedModels: ["model-only"],
        displayName: "Single Model Mate",
        jobRole: "Use one configured model",
        workEmail: "single-model@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(singleResponse.status, 201, await singleResponse.clone().text());
    const singlePolicy = (await singleResponse.json()).mate.draftManifest.modelPolicy;
    assert.deepEqual(singlePolicy.allowedModels, ["model-only"]);
    assert.equal(singlePolicy.defaultModel, "model-only");
    assert.equal(singlePolicy.allowUserSelection, false);
  });

  it("stores selected people and departments in the versioned invocation policy", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const missingTargets = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        displayName: "Restricted Mate",
        jobRole: "Serve selected users",
        visibility: "targets",
        workEmail: "restricted@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(missingTargets.status, 400);
    assert.equal((await missingTargets.json()).error, "mate_invocation_targets_required");

    const createdResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        displayName: "Restricted Mate",
        jobRole: "Serve selected users",
        targetIds: ["user:user-a", "department:wealth/portfolio", "user:user-a"],
        visibility: "targets",
        workEmail: "restricted@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
    const mate = (await createdResponse.json()).mate;
    assert.equal(mate.visibility, "targets");
    assert.deepEqual(mate.draftManifest.invocationPolicy.targetIds, ["user:user-a", "department:wealth/portfolio"]);
  });

  it("normalizes Mate Code casing, enforces the fixed email domain, and rejects duplicates", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const firstResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        displayName: "First Email Mate",
        jobRole: "Own the first address",
        workEmail: "Unique-Mate@Mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(firstResponse.status, 201, await firstResponse.clone().text());
    const first = (await firstResponse.json()).mate;
    assert.equal(first.id, "unique-mate");
    assert.equal(first.workEmail, "unique-mate@mate.example.invalid");
    assert.equal(first.draftManifest.mate.mateId, "unique-mate");
    const retiredDomain = await handleAppsWorkerRequest(request("/mates", {
      method: "POST", body: { displayName: "Retired domain", jobRole: "Test", workEmail: "legacy@example.invalid" }
    }), bindings, context);
    assert.equal(retiredDomain.status, 400);

    const immutableCodeResponse = await handleAppsWorkerRequest(request(`/mates/${first.id}`, {
      method: "PATCH",
      body: {
        displayName: "Renamed Mate",
        workEmail: "renamed-mate@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(immutableCodeResponse.status, 409);
    assert.equal((await immutableCodeResponse.json()).error, "mate_code_immutable");

    const mutableNameResponse = await handleAppsWorkerRequest(request(`/mates/${first.id}`, {
      method: "PATCH",
      body: { displayName: "Renamed Mate" }
    }), bindings, context);
    assert.equal(mutableNameResponse.status, 200);
    assert.equal((await mutableNameResponse.json()).mate.workEmail, "unique-mate@mate.example.invalid");

    const duplicateResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        displayName: "Second Email Mate",
        jobRole: "Try to reuse the address",
        workEmail: "unique-mate@mate.example.invalid"
      }
    }), bindings, context);
    assert.equal(duplicateResponse.status, 409);
    assert.equal((await duplicateResponse.json()).error, "mate_email_conflict");

    const foreignDomainResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        displayName: "Foreign Domain Mate",
        jobRole: "Try to use a non-platform address",
        workEmail: "foreign@agents.example.com"
      }
    }), bindings, context);
    assert.equal(foreignDomainResponse.status, 400);
    assert.equal((await foreignDomainResponse.json()).error, "mate_work_email_invalid");
  });

  it("isolates owner control-plane access and rejects caller identity or credentials in definitions", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const createResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        displayName: "Portfolio Banker Mate",
        jobRole: "Review authorized portfolios",
        workEmail: "portfolio@mate.example.invalid"
      }
    }), bindings, context);
    const created = (await createResponse.json()).mate;

    const otherUserResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}`, { userId: "other-user" }), bindings, context);
    assert.equal(otherUserResponse.status, 404);

    const forbiddenManifest = structuredClone(created.draftManifest);
    forbiddenManifest.resources.credentials = { username: "enterprise-account" };
    const updateResponse = await handleAppsWorkerRequest(request(`/mates/${created.id}/draft`, {
      method: "PUT",
      body: {
        documents: created.draftDocuments,
        expectedRevision: created.draftRevision,
        manifest: forbiddenManifest
      }
    }), bindings, context);
    assert.equal(updateResponse.status, 422);
    const validation = (await updateResponse.json()).validation;
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((issue) => issue.code === "forbidden_identity_or_credential_field"));
  });

  it("requires optimistic Draft revisions and can roll back by activating an older release", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const createResponse = await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        builtInToolIds: ["document_read"],
        displayName: "Release Mate",
        jobRole: "Exercise release controls",
        workEmail: "release@mate.example.invalid"
      }
    }), bindings, context);
    const created = (await createResponse.json()).mate;
    const firstDeploy = await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`, { method: "POST" }), bindings, context);
    const firstRelease = (await firstDeploy.json()).release;
    const firstPublish = await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${firstRelease.id}/publish`, { method: "POST" }), bindings, context);
    assert.equal(firstPublish.status, 200);

    const staleUpdate = await handleAppsWorkerRequest(request(`/mates/${created.id}/draft`, {
      method: "PUT",
      body: { documents: created.draftDocuments, expectedRevision: 0, manifest: created.draftManifest }
    }), bindings, context);
    assert.equal(staleUpdate.status, 409);

    const current = (await (await handleAppsWorkerRequest(request(`/mates/${created.id}`), bindings, context)).json()).mate;
    const secondManifest = structuredClone(current.draftManifest);
    secondManifest.mate.description = "Second release.";
    const update = await handleAppsWorkerRequest(request(`/mates/${created.id}/draft`, {
      method: "PUT",
      body: { documents: current.draftDocuments, expectedRevision: current.draftRevision, manifest: secondManifest }
    }), bindings, context);
    assert.equal(update.status, 200);
    const secondDeploy = await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`, { method: "POST" }), bindings, context);
    assert.equal(secondDeploy.status, 201);
    const secondRelease = (await secondDeploy.json()).release;
    assert.equal(secondRelease.id, "release-r2");
    assert.equal(secondRelease.status, "candidate");
    const stillLive = (await (await handleAppsWorkerRequest(new Request(
      `http://localhost/internal/runtime/mates/${created.id}`,
      { headers: { authorization: "Bearer runtime-service-token" } }
    ), bindings, context)).json()).release;
    assert.equal(stillLive.id, firstRelease.id);

    const secondPublish = await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${secondRelease.id}/publish`, { method: "POST" }), bindings, context);
    assert.equal(secondPublish.status, 200);

    const activate = await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${firstRelease.id}/activate`, { method: "POST" }), bindings, context);
    assert.equal(activate.status, 200);
    assert.equal((await activate.json()).release.status, "published");
  });

  it("never treats a superseded, untested candidate as a rollback Release", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const bindings = env();
    const created = (await (await handleAppsWorkerRequest(request("/mates", {
      method: "POST",
      body: {
        builtInToolIds: ["document_read"],
        displayName: "Candidate Safety Mate",
        jobRole: "Verify candidate lifecycle safety",
        workEmail: "candidate-safety@mate.example.invalid"
      }
    }), bindings, context)).json()).mate;

    const firstCandidate = (await (await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`, { method: "POST" }), bindings, context)).json()).release;
    await handleAppsWorkerRequest(request(`/mates/${created.id}/deploy`, { method: "POST" }), bindings, context);
    const invalidRollback = await handleAppsWorkerRequest(request(`/mates/${created.id}/releases/${firstCandidate.id}/activate`, { method: "POST" }), bindings, context);
    assert.equal(invalidRollback.status, 409);
    assert.equal((await invalidRollback.json()).error, "mate_release_not_previously_published");
  });
});
