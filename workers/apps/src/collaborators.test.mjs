import { fileURLToPath } from "node:url";
import { testInstallation } from "../../../tests/helpers/installation.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let workerModulePromise;
let publicationAuthorsModulePromise;
let originalFetch;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === "https://auth.example.test" && url.pathname === "/v1/admin/apps") {
      return Response.json({ id: JSON.parse(String(init?.body || "{}")).id, status: "draft" });
    }
    return originalFetch(input, init);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
});

async function loadWorkerModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-collaborators-test-"));
  const outfile = join(outdir, "worker.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function workerModule() {
  workerModulePromise ??= loadWorkerModule();
  return workerModulePromise;
}

async function publicationAuthorsModule() {
  if (!publicationAuthorsModulePromise) {
    publicationAuthorsModulePromise = (async () => {
      const outdir = await mkdtemp(join(tmpdir(), "apps-publication-authors-test-"));
      const outfile = join(outdir, "publicationAuthors.mjs");
      await build({
        bundle: true,
        entryPoints: [fileURLToPath(new URL("./publicationAuthors.ts", import.meta.url))],
        format: "esm",
        logLevel: "silent",
        outfile,
        platform: "neutral"
      });
      const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
      await rm(outdir, { force: true, recursive: true });
      return mod;
    })();
  }
  return publicationAuthorsModulePromise;
}

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementAdapter(this.database.prepare(sql));
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }
}

class D1StatementAdapter {
  constructor(statement, params = []) {
    this.params = params;
    this.statement = statement;
  }

  bind(...params) {
    return new D1StatementAdapter(this.statement, params);
  }

  async all() {
    return { results: this.statement.all(...this.params) };
  }

  async first() {
    return this.statement.get(...this.params) ?? null;
  }

  async run() {
    this.statement.run(...this.params);
    return { success: true };
  }
}

class R2BucketMock {
  constructor() {
    this.objects = new Map();
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }

  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      body: bytes,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
    };
  }

  async put(key, body) {
    const bytes = typeof body === "string"
      ? new TextEncoder().encode(body)
      : new Uint8Array(body);
    this.objects.set(key, bytes);
  }
}

function createEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const now = "2026-07-13T00:00:00.000Z";

  database.prepare(`
    INSERT INTO apps_apps (
      id, org_id, org_slug, owner_user_id, name, code, slug, description, type,
      status, visibility, login_required, data_service_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "app-1", "org-1", "org-1", "owner-1", "Private App", "private-app", "private-app", "",
    "static_page", "draft", "private", 1, "data-app-1", now, now
  );

  database.prepare(`
    INSERT INTO apps_skills (
      id, org_id, org_slug, owner_user_id, name, slug, description, kind,
      capabilities_json, status, visibility, access_targets_json, login_required,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "skill-1", "org-1", "org-1", "owner-1", "Private Skill", "private-skill", "", "vanilla",
    "[]", "private", "private", "[]", 1, now, now
  );

  database.prepare(`
    INSERT INTO apps_skill_versions (
      id, skill_id, version, state, artifact_key, skill_md_key, manifest_key,
      artifact_sha256, manifest_json, frontmatter_json, file_count, size_bytes,
      changelog, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "version-1", "skill-1", "1.0.0", "private_current", "skills/skill-1/1.0.0.zip",
    "skills/skill-1/SKILL.md", "skills/skill-1/pintail.json", "", "{}", "{}", 1, 7, "",
    "owner-1", now
  );
  database.prepare("UPDATE apps_skills SET current_version_id = ? WHERE id = ?").run("version-1", "skill-1");

  const artifacts = new R2BucketMock();
  artifacts.objects.set("skills/skill-1/1.0.0.zip", new TextEncoder().encode("zip-v1"));

  return { ...testInstallation,
    AUTH_SERVICE_TOKEN: "auth-service-token",
    AUTH_WORKER_URL: "https://auth.example.test",
    DEV_AUTH_BYPASS: "1",
    APPS_ARTIFACTS: artifacts,
    APPS_BASE_DOMAIN: "example.test",
    APPS_DB: new D1Adapter(database),
    APPS_SECRET_ENCRYPTION_KEY: "collaborator-test-secret-key-at-least-32-bytes",
    PLATFORM_MCP_URL: "https://apps.example.test/mcp"
  };
}

function context() {
  return {
    passThroughOnException() {},
    waitUntil() {}
  };
}

function appsRequest(path, { body, email, method = "GET", orgId = "org-1", scopes = "apps:apps:read,apps:skills:read", userId }) {
  return new Request(`http://localhost:8791${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-workspace-org-id": orgId,
      "x-workspace-scopes": scopes,
      "x-workspace-user-id": userId,
      ...(email ? { "x-workspace-user-email": email } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function mcpRequest(name, args, options = {}) {
  return appsRequest("/mcp", {
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args }
    },
    method: "POST",
    ...options
  });
}

function mcpPayload(responsePayload) {
  assert.equal(responsePayload.error, undefined);
  return JSON.parse(responsePayload.result.content[0].text);
}

const updatedSkillMarkdown = `---
name: Private Skill
description: Updated collaboratively.
version: 1.1.0
---

# Private Skill

Updated by a co-author.
`;

describe("APPS collaborators", () => {
  it("exposes only a target-bound author projection to publication review credentials", async () => {
    const { readPublicationAuthorProjection } = await publicationAuthorsModule();
    const env = createEnv();
    env.APPS_DB.database.prepare(
      "UPDATE apps_apps SET collaborator_user_ids_json = ? WHERE id = ?"
    ).run(JSON.stringify(["COLLAB-1", "collab-1"]), "app-1");
    env.APPS_DB.database.prepare(
      "UPDATE apps_skills SET collaborator_user_ids_json = ? WHERE id = ?"
    ).run(JSON.stringify(["skill-collab-1"]), "skill-1");
    const reviewer = {
      appId: "app-1",
      orgId: "org-1",
      orgSlug: "org-1",
      scopes: ["apps:apps:read"],
      sub: "admin-reviewer",
      tokenType: "apps_publication_review"
    };

    assert.deepEqual(
      await readPublicationAuthorProjection(env.APPS_DB, reviewer, "app", "app-1"),
      { ownerUserId: "owner-1", collaboratorUserIds: ["collab-1"] }
    );
    assert.deepEqual(
      await readPublicationAuthorProjection(env.APPS_DB, {
        ...reviewer,
        appId: undefined,
        skillId: "skill-1",
        scopes: ["apps:skills:read"]
      }, "skill", "skill-1"),
      { ownerUserId: "owner-1", collaboratorUserIds: ["skill-collab-1"] }
    );
    await assert.rejects(
      () => readPublicationAuthorProjection(env.APPS_DB, { ...reviewer, tokenType: "apps_access" }, "app", "app-1"),
      (error) => error.status === 403 && error.message === "publication_review_token_required"
    );
    await assert.rejects(
      () => readPublicationAuthorProjection(env.APPS_DB, { ...reviewer, appId: "app-other" }, "app", "app-1"),
      (error) => error.status === 403 && error.message === "publication_review_target_mismatch"
    );
    await assert.rejects(
      () => readPublicationAuthorProjection(env.APPS_DB, { ...reviewer, orgId: "org-2" }, "app", "app-1"),
      (error) => error.status === 404 && error.message === "apps_app_not_found"
    );
  });

  it("uses one owner-or-collaborator inventory contract for REST and MCP", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const env = createEnv();

    const ownerResponse = await handleAppsWorkerRequest(appsRequest("/inventory", {
      userId: "owner-1"
    }), env, context());
    assert.equal(ownerResponse.status, 200);
    const ownerInventory = await ownerResponse.json();
    assert.deepEqual(ownerInventory.apps.map((app) => app.id), ["app-1"]);
    assert.deepEqual(ownerInventory.skills.map((skill) => skill.id), ["skill-1"]);

    env.APPS_DB.database.prepare(
      "UPDATE apps_apps SET collaborator_user_ids_json = ? WHERE id = ?"
    ).run(JSON.stringify(["coauthor-1"]), "app-1");
    env.APPS_DB.database.prepare(
      "UPDATE apps_skills SET collaborator_user_ids_json = ?, visibility = 'org' WHERE id = ?"
    ).run(JSON.stringify(["coauthor-1"]), "skill-1");

    const collaboratorResponse = await handleAppsWorkerRequest(appsRequest("/inventory", {
      userId: "COAUTHOR-1"
    }), env, context());
    const collaboratorInventory = await collaboratorResponse.json();
    assert.deepEqual(collaboratorInventory.apps.map((app) => app.id), ["app-1"]);
    assert.deepEqual(collaboratorInventory.skills.map((skill) => skill.id), ["skill-1"]);

    const readableSkillsResponse = await handleAppsWorkerRequest(appsRequest("/skills", {
      userId: "org-reader-1"
    }), env, context());
    assert.deepEqual((await readableSkillsResponse.json()).skills.map((skill) => skill.id), ["skill-1"]);

    const unrelatedInventoryResponse = await handleAppsWorkerRequest(appsRequest("/inventory", {
      userId: "org-reader-1"
    }), env, context());
    assert.deepEqual(await unrelatedInventoryResponse.json(), { apps: [], skills: [], mates: [] });

    const crossOrgResponse = await handleAppsWorkerRequest(appsRequest("/inventory", {
      orgId: "org-2",
      userId: "owner-1"
    }), env, context());
    assert.deepEqual(await crossOrgResponse.json(), { apps: [], skills: [], mates: [] });

    const mcpResponse = await handleAppsWorkerRequest(mcpRequest("apps_list_inventory", {}, {
      userId: "coauthor-1"
    }), env, context());
    const mcpInventory = mcpPayload(await mcpResponse.json());
    assert.deepEqual(mcpInventory.apps.map((app) => app.id), ["app-1"]);
    assert.deepEqual(mcpInventory.skills.map((skill) => skill.id), ["skill-1"]);

    const partialScopeResponse = await handleAppsWorkerRequest(appsRequest("/inventory", {
      scopes: "apps:apps:read",
      userId: "owner-1"
    }), env, context());
    assert.equal(partialScopeResponse.status, 403);
    assert.equal((await partialScopeResponse.json()).error, "insufficient_apps_scope");
  });

  it("gives same-org App collaborators the same route and MCP management rights as the owner", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const env = createEnv();

    const updateResponse = await handleAppsWorkerRequest(appsRequest("/apps/app-1/collaborators", {
      body: { collaboratorUserIds: ["OWNER-1", "COLLAB-1", "collab-1"] },
      method: "PATCH",
      scopes: "apps:apps:write",
      userId: "owner-1"
    }), env, context());
    const updated = await updateResponse.json();

    assert.equal(updateResponse.status, 200);
    assert.deepEqual(updated.app.collaboratorUserIds, ["collab-1"]);

    const listResponse = await handleAppsWorkerRequest(appsRequest("/apps", { userId: "COLLAB-1" }), env, context());
    const list = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.deepEqual(list.apps.map((app) => app.id), ["app-1"]);

    const detailResponse = await handleAppsWorkerRequest(appsRequest("/apps/app-1", { userId: "collab-1" }), env, context());
    assert.equal(detailResponse.status, 200);

    const writeResponse = await handleAppsWorkerRequest(appsRequest("/apps/app-1", {
      body: { name: "Collaborator edit" },
      method: "PATCH",
      scopes: "apps:apps:write",
      userId: "collab-1"
    }), env, context());
    assert.equal(writeResponse.status, 200);
    assert.equal((await writeResponse.json()).app.name, "Collaborator edit");

    const visibilityResponse = await handleAppsWorkerRequest(appsRequest("/apps/app-1/visibility", {
      body: { accessTargets: [], loginRequired: true, visibility: "org" },
      method: "PATCH",
      scopes: "apps:apps:write",
      userId: "collab-1"
    }), env, context());
    assert.equal(visibilityResponse.status, 200);
    assert.equal((await visibilityResponse.json()).app.visibility, "org");

    const secretDeclarationResponse = await handleAppsWorkerRequest(appsRequest("/apps/app-1/secrets/requirements", {
      body: { secrets: [{ name: "SHARED_KEY", description: "Managed by co-authors" }] },
      method: "POST",
      scopes: "apps:apps:write",
      userId: "collab-1"
    }), env, context());
    assert.equal(secretDeclarationResponse.status, 200);

    const secretValueResponse = await handleAppsWorkerRequest(appsRequest("/apps/app-1/secrets/value", {
      body: { name: "SHARED_KEY", value: "secret-value" },
      method: "POST",
      scopes: "apps:secrets:write",
      userId: "collab-1"
    }), env, context());
    assert.equal(secretValueResponse.status, 200);
    assert.equal((await secretValueResponse.json()).app.secrets[0].status, "configured");

    const handoffLinkResponse = await handleAppsWorkerRequest(appsRequest("/apps/app-1/handoff-link", {
      method: "POST",
      scopes: "apps:apps:read",
      userId: "collab-1"
    }), env, context());
    assert.equal(handoffLinkResponse.status, 200);
    assert.match((await handoffLinkResponse.json()).url, /^https:\/\/apps\.example\.test\/apps\/app-1\/handoff\.md\?h=/);

    const collaboratorManagementResponse = await handleAppsWorkerRequest(appsRequest("/apps/app-1/collaborators", {
      body: { collaboratorUserIds: ["collab-1", "coauthor-2"] },
      method: "PATCH",
      scopes: "apps:apps:write",
      userId: "collab-1"
    }), env, context());
    assert.equal(collaboratorManagementResponse.status, 200);
    assert.deepEqual((await collaboratorManagementResponse.json()).app.collaboratorUserIds, ["collab-1", "coauthor-2"]);

    const mcpUpdateResponse = await handleAppsWorkerRequest(mcpRequest("apps_update_app_config", {
      appId: "app-1",
      llmEnabled: false
    }, {
      scopes: "apps:apps:write",
      userId: "collab-1"
    }), env, context());
    assert.equal(mcpUpdateResponse.status, 200);
    assert.equal(mcpPayload(await mcpUpdateResponse.json()).app.id, "app-1");

    const publishResponse = await handleAppsWorkerRequest(appsRequest("/apps/app-1/publish", {
      body: { visibility: "org" },
      method: "POST",
      scopes: "apps:deploy:production",
      userId: "collab-1"
    }), env, context());
    assert.equal(publishResponse.status, 409);
    assert.equal((await publishResponse.json()).error, "production_domain_not_configured");

    const unrelatedList = await handleAppsWorkerRequest(appsRequest("/apps", { userId: "unrelated-1" }), env, context());
    assert.deepEqual((await unrelatedList.json()).apps, []);

    const crossOrgList = await handleAppsWorkerRequest(appsRequest("/apps", {
      orgId: "org-2",
      userId: "collab-1"
    }), env, context());
    assert.deepEqual((await crossOrgList.json()).apps, []);

    const crossOrgDetail = await handleAppsWorkerRequest(appsRequest("/apps/app-1", {
      orgId: "org-2",
      userId: "collab-1"
    }), env, context());
    assert.equal(crossOrgDetail.status, 404);

    const crossOrgOwnerWrite = await handleAppsWorkerRequest(appsRequest("/apps/app-1", {
      body: { name: "Cross-org owner edit" },
      method: "PATCH",
      orgId: "org-2",
      scopes: "apps:apps:write",
      userId: "owner-1"
    }), env, context());
    assert.equal(crossOrgOwnerWrite.status, 404);

    const revokeResponse = await handleAppsWorkerRequest(appsRequest("/apps/app-1/collaborators", {
      body: { collaboratorUserIds: [] },
      method: "PATCH",
      scopes: "apps:apps:write",
      userId: "owner-1"
    }), env, context());
    assert.equal(revokeResponse.status, 200);

    const revokedList = await handleAppsWorkerRequest(appsRequest("/apps", { userId: "collab-1" }), env, context());
    assert.deepEqual((await revokedList.json()).apps, []);
    const revokedDetail = await handleAppsWorkerRequest(appsRequest("/apps/app-1", { userId: "collab-1" }), env, context());
    assert.equal(revokedDetail.status, 404);
  });

  it("rejects non-collaborator App updates even when the proxy supplies an admin scope", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const env = createEnv();

    const adminResponse = await handleAppsWorkerRequest(appsRequest("/apps/app-1/collaborators", {
      body: { collaboratorUserIds: ["admin-added-1"] },
      method: "PATCH",
      scopes: "apps:apps:admin",
      userId: "admin-1"
    }), env, context());
    assert.equal(adminResponse.status, 404);

    const crossOrgResponse = await handleAppsWorkerRequest(appsRequest("/apps/app-1/collaborators", {
      body: { collaboratorUserIds: [] },
      method: "PATCH",
      orgId: "org-2",
      scopes: "apps:apps:admin",
      userId: "admin-2"
    }), env, context());
    assert.equal(crossOrgResponse.status, 404);
  });

  it("rejects a matching email prefix from a different owner identity", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const env = createEnv();
    await env.APPS_DB.prepare("UPDATE apps_apps SET owner_user_id = ? WHERE id = ?")
      .bind("owner@example.invalidhk", "app-1")
      .run();

    const response = await handleAppsWorkerRequest(appsRequest("/apps/app-1/collaborators", {
      body: {
        collaboratorUserIds: [
          "owner-uuid",
          "OWNER@example.invalid",
          "owner@example.invalidhk",
          "collab-1"
        ]
      },
      email: "owner@example.invalid",
      method: "PATCH",
      scopes: "apps:apps:write",
      userId: "owner-uuid"
    }), env, context());
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.equal(payload.app, undefined);
  });

  it("lets co-authors delete an App or Skill with the same confirmation rules as the owner", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const env = createEnv();

    await handleAppsWorkerRequest(appsRequest("/apps/app-1/collaborators", {
      body: { collaboratorUserIds: ["coauthor-1"] },
      method: "PATCH",
      scopes: "apps:apps:write",
      userId: "owner-1"
    }), env, context());
    const appDeleteResponse = await handleAppsWorkerRequest(appsRequest("/apps/app-1", {
      body: { appCode: "private-app" },
      method: "DELETE",
      scopes: "apps:apps:write",
      userId: "coauthor-1"
    }), env, context());
    assert.equal(appDeleteResponse.status, 200);
    assert.equal((await appDeleteResponse.json()).deleted, true);

    await handleAppsWorkerRequest(appsRequest("/skills/skill-1/collaborators", {
      body: { collaboratorUserIds: ["coauthor-1"] },
      method: "PATCH",
      scopes: "apps:skills:write",
      userId: "owner-1"
    }), env, context());
    const skillDeleteResponse = await handleAppsWorkerRequest(appsRequest("/skills/skill-1", {
      body: { slug: "private-skill" },
      method: "DELETE",
      scopes: "apps:skills:write",
      userId: "coauthor-1"
    }), env, context());
    assert.equal(skillDeleteResponse.status, 200);
    assert.equal((await skillDeleteResponse.json()).deleted, true);
    assert.equal(env.APPS_ARTIFACTS.objects.has("skills/skill-1/1.0.0.zip"), false);
  });

  it("gives same-org Skill collaborators metadata, visibility, version, download, and management rights", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const env = createEnv();

    const updateResponse = await handleAppsWorkerRequest(appsRequest("/skills/skill-1/collaborators", {
      body: { collaboratorUserIds: ["skill-collab-1"] },
      method: "PATCH",
      scopes: "apps:skills:write",
      userId: "owner-1"
    }), env, context());
    assert.equal(updateResponse.status, 200);
    assert.deepEqual((await updateResponse.json()).skill.collaboratorUserIds, ["skill-collab-1"]);

    const listResponse = await handleAppsWorkerRequest(appsRequest("/skills", { userId: "skill-collab-1" }), env, context());
    const list = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.deepEqual(list.skills.map((skill) => skill.id), ["skill-1"]);

    const detailResponse = await handleAppsWorkerRequest(appsRequest("/skills/skill-1", { userId: "skill-collab-1" }), env, context());
    assert.equal(detailResponse.status, 200);

    const downloadResponse = await handleAppsWorkerRequest(appsRequest("/skills/skill-1/versions/1.0.0/download.zip", {
      userId: "skill-collab-1"
    }), env, context());
    assert.equal(downloadResponse.status, 200);
    assert.equal(await downloadResponse.text(), "zip-v1");

    const crossOrgDetail = await handleAppsWorkerRequest(appsRequest("/skills/skill-1", {
      orgId: "org-2",
      userId: "skill-collab-1"
    }), env, context());
    assert.equal(crossOrgDetail.status, 404);

    const writeResponse = await handleAppsWorkerRequest(appsRequest("/skills/skill-1", {
      body: { description: "Edited by a co-author", name: "Collaborator edit" },
      method: "PATCH",
      scopes: "apps:skills:write",
      userId: "skill-collab-1"
    }), env, context());
    assert.equal(writeResponse.status, 200);
    assert.equal((await writeResponse.json()).skill.name, "Collaborator edit");

    const visibilityResponse = await handleAppsWorkerRequest(appsRequest("/skills/skill-1/visibility", {
      body: { visibility: "org" },
      method: "PATCH",
      scopes: "apps:skills:write",
      userId: "skill-collab-1"
    }), env, context());
    assert.equal(visibilityResponse.status, 200);
    assert.equal((await visibilityResponse.json()).skill.visibility, "org");

    const collaboratorManagementResponse = await handleAppsWorkerRequest(appsRequest("/skills/skill-1/collaborators", {
      body: { collaboratorUserIds: ["skill-collab-1", "skill-coauthor-2"] },
      method: "PATCH",
      scopes: "apps:skills:write",
      userId: "skill-collab-1"
    }), env, context());
    assert.equal(collaboratorManagementResponse.status, 200);
    assert.deepEqual((await collaboratorManagementResponse.json()).skill.collaboratorUserIds, ["skill-collab-1", "skill-coauthor-2"]);

    const mcpVersionResponse = await handleAppsWorkerRequest(mcpRequest("apps_skill_update", {
      skillId: "skill-1",
      skillMarkdown: updatedSkillMarkdown,
      version: "1.1.0"
    }, {
      scopes: "apps:skills:write",
      userId: "skill-collab-1"
    }), env, context());
    assert.equal(mcpVersionResponse.status, 200);
    const mcpVersionPayload = mcpPayload(await mcpVersionResponse.json());
    assert.equal(mcpVersionPayload.skill.currentVersion, "1.1.0");
    assert.equal(mcpVersionPayload.skill.versions[0].createdBy, "skill-collab-1");

    const updatedDownloadResponse = await handleAppsWorkerRequest(appsRequest("/skills/skill-1/versions/1.1.0/download.zip", {
      userId: "skill-collab-1"
    }), env, context());
    assert.equal(updatedDownloadResponse.status, 200);
    assert.match(updatedDownloadResponse.headers.get("content-disposition"), /private-skill-1\.1\.0\.zip/);

    const crossOrgOwnerWrite = await handleAppsWorkerRequest(appsRequest("/skills/skill-1", {
      body: { name: "Cross-org owner edit" },
      method: "PATCH",
      orgId: "org-2",
      scopes: "apps:skills:write",
      userId: "owner-1"
    }), env, context());
    assert.equal(crossOrgOwnerWrite.status, 404);

    const revokeResponse = await handleAppsWorkerRequest(appsRequest("/skills/skill-1/collaborators", {
      body: { collaboratorUserIds: [] },
      method: "PATCH",
      scopes: "apps:skills:write",
      userId: "owner-1"
    }), env, context());
    assert.equal(revokeResponse.status, 200);

    const revokedList = await handleAppsWorkerRequest(appsRequest("/skills", { userId: "skill-collab-1" }), env, context());
    assert.deepEqual((await revokedList.json()).skills.map((skill) => skill.id), ["skill-1"]);
    const revokedDetail = await handleAppsWorkerRequest(appsRequest("/skills/skill-1", { userId: "skill-collab-1" }), env, context());
    assert.equal(revokedDetail.status, 200);
    const revokedWrite = await handleAppsWorkerRequest(appsRequest("/skills/skill-1", {
      body: { name: "No longer a co-author" },
      method: "PATCH",
      scopes: "apps:skills:write",
      userId: "skill-collab-1"
    }), env, context());
    assert.equal(revokedWrite.status, 404);
  });

  it("validates collaborator payloads and rejects non-collaborator Skill admins", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const env = createEnv();

    const invalidResponse = await handleAppsWorkerRequest(appsRequest("/skills/skill-1/collaborators", {
      body: { collaboratorUserIds: "user-1" },
      method: "PATCH",
      scopes: "apps:skills:write",
      userId: "owner-1"
    }), env, context());
    assert.equal(invalidResponse.status, 400);

    const invalidObjectResponse = await handleAppsWorkerRequest(appsRequest("/skills/skill-1/collaborators", {
      body: { collaboratorUserIds: [{ id: "user-1" }] },
      method: "PATCH",
      scopes: "apps:skills:write",
      userId: "owner-1"
    }), env, context());
    assert.equal(invalidObjectResponse.status, 400);

    const invalidNumberResponse = await handleAppsWorkerRequest(appsRequest("/skills/skill-1/collaborators", {
      body: { collaboratorUserIds: [123] },
      method: "PATCH",
      scopes: "apps:skills:write",
      userId: "owner-1"
    }), env, context());
    assert.equal(invalidNumberResponse.status, 400);

    const tooManyResponse = await handleAppsWorkerRequest(appsRequest("/skills/skill-1/collaborators", {
      body: { collaboratorUserIds: Array.from({ length: 201 }, (_, index) => `user-${index}`) },
      method: "PATCH",
      scopes: "apps:skills:write",
      userId: "owner-1"
    }), env, context());
    assert.equal(tooManyResponse.status, 400);

    const adminResponse = await handleAppsWorkerRequest(appsRequest("/skills/skill-1/collaborators", {
      body: { collaboratorUserIds: ["admin-added-1"] },
      method: "PATCH",
      scopes: "apps:skills:admin",
      userId: "admin-1"
    }), env, context());
    assert.equal(adminResponse.status, 404);
  });
});
