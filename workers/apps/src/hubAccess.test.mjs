import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let workerModulePromise;
let hubAccessModulePromise;

async function loadWorkerModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-hub-access-test-"));
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

async function hubAccessModule() {
  if (!hubAccessModulePromise) {
    hubAccessModulePromise = (async () => {
      const outdir = await mkdtemp(join(tmpdir(), "apps-hub-access-model-test-"));
      const outfile = join(outdir, "hubAccess.mjs");
      await build({
        bundle: true,
        entryPoints: [fileURLToPath(new URL("./hubAccess.ts", import.meta.url))],
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
  return hubAccessModulePromise;
}

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementAdapter(this.database.prepare(sql));
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

function createEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const now = "2026-07-15T00:00:00.000Z";

  const insertApp = database.prepare(`
    INSERT INTO apps_apps (
      id, org_id, org_slug, owner_user_id, name, code, slug, description, type,
      status, visibility, login_required, access_targets_json, data_service_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 'static_page', ?, ?, 1, ?, ?, ?, ?)
  `);
  const apps = [
    ["app-owner-targeted", "org-1", "owner-1", "published", "team", ["user:someone-else"]],
    ["app-user-targeted", "org-1", "another-owner", "published", "team", ["user:viewer@example.com"]],
    ["app-department-targeted", "org-1", "another-owner", "published", "private", ["department:wealth"]],
    ["app-org", "org-1", "another-owner", "published", "org", []],
    ["app-public", "org-1", "another-owner", "published", "public", []],
    ["app-draft-org", "org-1", "another-owner", "draft", "org", []],
    ["app-other-org", "org-2", "owner-1", "published", "public", []]
  ];
  for (const [id, orgId, ownerId, status, visibility, targets] of apps) {
    insertApp.run(
      id,
      orgId,
      orgId,
      ownerId,
      id,
      id,
      id,
      status,
      visibility,
      JSON.stringify(targets),
      `data-${id}`,
      now,
      now
    );
  }

  const insertSkill = database.prepare(`
    INSERT INTO apps_skills (
      id, org_id, org_slug, owner_user_id, name, slug, description, kind,
      capabilities_json, status, visibility, access_targets_json, login_required,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '', 'vanilla', '[]', ?, ?, ?, 1, ?, ?)
  `);
  const skills = [
    ["skill-owner-targeted", "org-1", "owner-1", "private", "team", ["user:someone-else"]],
    ["skill-user-targeted", "org-1", "another-owner", "private", "team", ["user:viewer@example.com"]],
    ["skill-department-targeted", "org-1", "another-owner", "private", "private", ["department:wealth"]],
    ["skill-org", "org-1", "another-owner", "private", "org", []],
    ["skill-archived-org", "org-1", "another-owner", "archived", "org", []],
    ["skill-other-org", "org-2", "owner-1", "private", "org", []]
  ];
  for (const [id, orgId, ownerId, status, visibility, targets] of skills) {
    insertSkill.run(
      id,
      orgId,
      orgId,
      ownerId,
      id,
      id,
      status,
      visibility,
      JSON.stringify(targets),
      now,
      now
    );
  }

  return {
    DEV_AUTH_BYPASS: "1",
    APPS_BASE_DOMAIN: "example.invalid",
    PLATFORM_MCP_URL: "https://apps.example.invalid/mcp",
    APPS_DB: new D1Adapter(database),
    MATE_RUNTIME_SERVICE_TOKEN: "runtime-service-token",
    database
  };
}

function seedAppMcp(env, appId = "app-user-targeted") {
  const manifest = {
    schemaVersion: "workspace.app-mcp/v1",
    appId,
    name: "Targeted App",
    baseUrl: "https://targeted.example.com",
    audience: "https://targeted.example.com",
    resourceId: `app-mcp:${appId}`,
    toolDefinitionVersion: "tools-v1",
    authorization: {
      model: "app-rbac",
      defaultRole: "member",
      toolsEndpoint: "/mcp/tools",
      toolsEndpointScope: "app:tools:read",
      roles: [{ id: "member", name: "Member" }],
      systemRoleInheritance: { app_owner: ["member"], app_collaborator: ["member"] }
    },
    tools: [{
      name: "record_read",
      description: "Read a record",
      method: "GET",
      path: "/mcp/records/read",
      allowedRoles: ["member"],
      requiredScopes: ["record:read"],
      readOnly: true,
      riskLevel: "low",
      requiresConfirmation: false,
      inputSchema: { type: "object", additionalProperties: false, properties: {} }
    }]
  };
  env.database.prepare("UPDATE apps_apps SET agent_mcp_enabled = 1 WHERE id = ?").run(appId);
  env.database.prepare(`
    INSERT INTO apps_deployments (
      id, app_id, environment, version, version_name, release_notes, status, url,
      created_by, created_by_name, created_at
    ) VALUES ('deploy-mcp-1', ?, 'production', '1', '', '', 'published', ?, 'owner-1', '', '2026-07-15T00:00:00.000Z')
  `).run(appId, manifest.baseUrl);
  env.database.prepare(`
    INSERT INTO apps_app_mcp_manifests (
      id, app_id, deployment_id, schema_version, tool_definition_version,
      manifest_sha256, manifest_json, created_by, created_at
    ) VALUES ('manifest-mcp-1', ?, 'deploy-mcp-1', 'workspace.app-mcp/v1', 'tools-v1', ?, ?, 'owner-1', '2026-07-15T00:00:00.000Z')
  `).run(appId, `sha256:${"a".repeat(64)}`, JSON.stringify(manifest));
  return manifest;
}

function context() {
  return {
    passThroughOnException() {},
    waitUntil() {}
  };
}

function hubAccessRequest({
  departmentId,
  departmentPath,
  email,
  ids,
  orgId = "org-1",
  scopes = "apps:apps:read,apps:skills:read",
  type,
  userId
}) {
  const url = new URL("http://localhost:8791/hub-access");
  if (ids) url.searchParams.set("ids", ids.join(","));
  if (type) url.searchParams.set("type", type);
  return new Request(url, {
    headers: {
      ...(departmentId ? { "x-workspace-department-id": departmentId } : {}),
      ...(departmentPath ? { "x-workspace-department-path": JSON.stringify(departmentPath) } : {}),
      ...(email ? { "x-workspace-user-email": email } : {}),
      "x-workspace-org-id": orgId,
      "x-workspace-scopes": scopes,
      "x-workspace-user-id": userId
    }
  });
}

function sortedAccess(payload) {
  return {
    appIds: [...payload.appIds].sort(),
    skillIds: [...payload.skillIds].sort()
  };
}

describe("APPS Hub consumption access", () => {
  it("accepts company as an organization-wide visibility alias", async () => {
    const { canConsumeAppsAsset } = await hubAccessModule();
    const principal = {
      orgId: "org-1",
      orgSlug: "org-1",
      scopes: [],
      sub: "viewer-1"
    };

    assert.equal(canConsumeAppsAsset({
      access_targets_json: "[]",
      id: "legacy-company-asset",
      org_id: "org-1",
      visibility: "company"
    }, principal), true);
    assert.equal(canConsumeAppsAsset({
      access_targets_json: "[]",
      id: "cross-org-company-asset",
      org_id: "org-2",
      visibility: "company"
    }, principal), false);
  });

  it("does not treat owner or admin scope as consumption access", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const response = await handleAppsWorkerRequest(hubAccessRequest({
      scopes: "apps:apps:admin,apps:skills:admin",
      userId: "owner-1"
    }), createEnv(), context());

    assert.equal(response.status, 200);
    assert.deepEqual(sortedAccess(await response.json()), {
      appIds: ["app-org", "app-public"],
      skillIds: ["skill-org"]
    });
  });

  it("includes targeted user and same-org broad visibility assets", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const response = await handleAppsWorkerRequest(hubAccessRequest({
      email: "VIEWER@EXAMPLE.COM",
      userId: "viewer-id"
    }), createEnv(), context());

    assert.equal(response.status, 200);
    assert.deepEqual(sortedAccess(await response.json()), {
      appIds: ["app-org", "app-public", "app-user-targeted"],
      skillIds: ["skill-org", "skill-user-targeted"]
    });
  });

  it("matches a targeted department through principal lineage", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const response = await handleAppsWorkerRequest(hubAccessRequest({
      departmentId: "private-banking",
      departmentPath: ["wealth", "wealth/private-banking"],
      userId: "department-viewer"
    }), createEnv(), context());

    assert.equal(response.status, 200);
    assert.deepEqual(sortedAccess(await response.json()), {
      appIds: ["app-department-targeted", "app-org", "app-public"],
      skillIds: ["skill-department-targeted", "skill-org"]
    });
  });

  it("queries only requested home App ids and skips the Skill projection", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const response = await handleAppsWorkerRequest(hubAccessRequest({
      ids: ["app-public"],
      type: "app",
      userId: "viewer-id"
    }), createEnv(), context());

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      publicAppIds: ["app-public"],
      appIds: ["app-public"],
      skillIds: []
    });
  });

  it("never leaks assets across organizations, even to their owner", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const response = await handleAppsWorkerRequest(hubAccessRequest({
      orgId: "org-2",
      userId: "owner-1"
    }), createEnv(), context());

    assert.equal(response.status, 200);
    assert.deepEqual(sortedAccess(await response.json()), {
      appIds: ["app-other-org"],
      skillIds: ["skill-other-org"]
    });
  });

  it("requires read access to both APPS asset domains", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const response = await handleAppsWorkerRequest(hubAccessRequest({
      scopes: "apps:apps:read",
      userId: "viewer-id"
    }), createEnv(), context());

    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "insufficient_apps_scope");
  });

  it("serves Runtime App MCP snapshots only for the derived current user", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const env = createEnv();
    const manifest = seedAppMcp(env);
    const runtimeRequest = (userId, email, token = "runtime-service-token", appId = "app-user-targeted") => new Request(
      `http://localhost:8791/internal/runtime/app-mcp${appId ? `/${appId}` : ""}`,
      { headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-runtime-org-id": "org-1",
        "x-workspace-runtime-user-email": email,
        "x-workspace-runtime-user-id": userId
      } }
    );

    const allowed = await handleAppsWorkerRequest(runtimeRequest("viewer-id", "viewer@example.com"), env, context());
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).manifest.toolDefinitionVersion, manifest.toolDefinitionVersion);
    const listed = await handleAppsWorkerRequest(runtimeRequest("viewer-id", "viewer@example.com", "runtime-service-token", ""), env, context());
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).apps.map((app) => app.appId), ["app-user-targeted"]);

    const unrelatedList = await handleAppsWorkerRequest(runtimeRequest("unrelated-id", "unrelated@example.com", "runtime-service-token", ""), env, context());
    assert.deepEqual((await unrelatedList.json()).apps, []);

    const unrelated = await handleAppsWorkerRequest(runtimeRequest("unrelated-id", "unrelated@example.com"), env, context());
    assert.equal(unrelated.status, 404);
    assert.equal((await unrelated.json()).error, "app_mcp_not_accessible");

    const invalidService = await handleAppsWorkerRequest(runtimeRequest("viewer-id", "viewer@example.com", "wrong-token"), env, context());
    assert.equal(invalidService.status, 401);
  });
});
