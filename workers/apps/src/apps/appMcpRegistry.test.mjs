import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let modulePromise;

async function registryModule() {
  modulePromise ??= (async () => {
    const outdir = await mkdtemp(join(tmpdir(), "app-mcp-registry-test-"));
    const outfile = join(outdir, "registry.mjs");
    await build({
      bundle: true,
      entryPoints: [new URL("./appMcpRegistry.ts", import.meta.url).pathname],
      format: "esm",
      logLevel: "silent",
      outfile,
      platform: "neutral",
    });
    const module = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
    await rm(outdir, { force: true, recursive: true });
    return module;
  })();
  return modulePromise;
}

const app = {
  id: "app-1",
  code: "academy",
  slug: "academy",
  type: "web",
  agent_mcp_enabled: 1,
};

const manifest = {
  schemaVersion: "workspace.app-mcp/v1",
  appId: "app-1",
  name: "Academy",
  baseUrl: "https://academy.example.invalid",
  audience: "https://academy.example.invalid",
  resourceId: "app-mcp:app-1",
  toolDefinitionVersion: "1",
  authorization: {
    model: "app-rbac",
    defaultRole: "member",
    toolsEndpoint: "/api/v1/mcp/tools",
    toolsEndpointScope: "app:mcp:discover",
    roles: [{ id: "member", name: "Member" }],
  },
  tools: [{
    name: "academy_list",
    description: "List lessons.",
    method: "GET",
    path: "/api/v1/lessons",
    allowedRoles: ["member"],
    requiredScopes: ["academy:read"],
    readOnly: true,
    riskLevel: "low",
    requiresConfirmation: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }],
};

const env = { APPS_BASE_DOMAIN: "example.invalid" };

describe("APPS App MCP registration", () => {
  it("requires a versioned manifest artifact when MCP is enabled", async () => {
    const { inspectAppMcpRegistration } = await registryModule();
    await assert.rejects(
      () => inspectAppMcpRegistration(app, [], env),
      (error) => error.code === "app_mcp_manifest_required" && error.status === 422,
    );
  });

  it("validates App identity and production origin before snapshotting", async () => {
    const { inspectAppMcpRegistration } = await registryModule();
    const registration = await inspectAppMcpRegistration(app, [{
      path: ".well-known/workspace-mcp-manifest.json",
      encoding: "text",
      content: JSON.stringify(manifest),
    }], env);

    assert.equal(registration.manifest.appId, "app-1");
    assert.equal(registration.manifest.baseUrl, "https://academy.example.invalid");
    assert.equal(registration.manifest.resourceId, "app-mcp:app-1");
    assert.match(registration.manifestSha256, /^[a-f0-9]{64}$/);

    const wrongOrigin = structuredClone(manifest);
    wrongOrigin.baseUrl = "https://evil.example.com";
    await assert.rejects(
      () => inspectAppMcpRegistration(app, [{
        path: ".well-known/workspace-mcp-manifest.json",
        encoding: "text",
        content: JSON.stringify(wrongOrigin),
      }], env),
      (error) => error.code === "app_mcp_base_url_mismatch" && error.status === 422,
    );
  });

  it("does not require a manifest for Apps that did not opt in", async () => {
    const { inspectAppMcpRegistration } = await registryModule();
    assert.equal(await inspectAppMcpRegistration({ ...app, agent_mcp_enabled: 0 }, [], env), undefined);
  });

  it("registers the published App as a deterministic Auth Resource", async () => {
    const { syncPublishedAppMcpResource } = await registryModule();
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ input: String(input), init });
      return Response.json({ resource: { id: "app-mcp:app-1" } }, { status: 201 });
    };

    try {
      await syncPublishedAppMcpResource({
        AUTH_WORKER_URL: "https://auth.example.com",
        APPS_AUTH_SERVICE_TOKEN: "apps-service-token",
        APPS_DB: {
          prepare() {
            return {
              bind() {
                return {
                  async first() {
                    return { manifest_json: JSON.stringify(manifest) };
                  },
                };
              },
            };
          },
        },
      }, {
        ...app,
        agent_mcp_enabled: 1,
        collaborator_user_ids_json: JSON.stringify(["editor-1"]),
        owner_user_id: "owner-1",
        updated_at: "2026-08-17T09:30:00.000Z",
      }, "deployment-1", {
        accessTargets: ["department:dept-learning"],
        visibility: "team",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requests[0].input, "https://auth.example.com/v1/admin/resources");
    assert.equal(requests[0].init.headers.Authorization, "Bearer apps-service-token");
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.id, "app-mcp:app-1");
    assert.deepEqual(body.allowedScopes, ["app:mcp:discover", "academy:read"]);
    assert.deepEqual(body.accessTargets, ["department:dept-learning", "user:editor-1"]);
    assert.equal(body.accessMode, "targeted");
    assert.equal(body.status, "listed");
    assert.deepEqual(body.collaboratorUserIds, ["editor-1"]);
    assert.equal(body.systemRolePolicyVersion, "2026-08-17T09:30:00.000Z");
  });

  it("delists the current Auth Resource when App MCP is disabled", async () => {
    const { delistPublishedAppMcpResource } = await registryModule();
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ input: String(input), init });
      return Response.json({ resource: { id: "app-mcp:app-1" } }, { status: 201 });
    };

    try {
      await delistPublishedAppMcpResource({
        AUTH_WORKER_URL: "https://auth.example.com",
        APPS_AUTH_SERVICE_TOKEN: "apps-service-token",
        APPS_DB: {
          prepare() {
            return {
              bind() {
                return {
                  async first() {
                    return { manifest_json: JSON.stringify(manifest) };
                  },
                };
              },
            };
          },
        },
      }, {
        ...app,
        access_targets_json: JSON.stringify(["department:dept-learning"]),
        collaborator_user_ids_json: JSON.stringify(["editor-1"]),
        owner_user_id: "owner-1",
        visibility: "team",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requests.length, 1);
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.id, "app-mcp:app-1");
    assert.equal(body.status, "draft");
    assert.deepEqual(body.allowedScopes, ["app:mcp:discover", "academy:read"]);
    assert.deepEqual(body.accessTargets, ["department:dept-learning", "user:editor-1"]);
  });

  it("relists the current Auth Resource when App MCP is re-enabled", async () => {
    const { relistPublishedAppMcpResource } = await registryModule();
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ input: String(input), init });
      return Response.json({ resource: { id: "app-mcp:app-1" } }, { status: 201 });
    };

    try {
      await relistPublishedAppMcpResource({
        AUTH_WORKER_URL: "https://auth.example.com",
        APPS_AUTH_SERVICE_TOKEN: "apps-service-token",
        APPS_DB: {
          prepare() {
            return {
              bind() {
                return {
                  async first() {
                    return { manifest_json: JSON.stringify(manifest) };
                  },
                };
              },
            };
          },
        },
      }, {
        ...app,
        access_targets_json: JSON.stringify(["department:dept-learning"]),
        collaborator_user_ids_json: JSON.stringify(["editor-1"]),
        owner_user_id: "owner-1",
        visibility: "team",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requests.length, 1);
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.id, "app-mcp:app-1");
    assert.equal(body.status, "listed");
    assert.deepEqual(body.allowedScopes, ["app:mcp:discover", "academy:read"]);
    assert.deepEqual(body.accessTargets, ["department:dept-learning", "user:editor-1"]);
  });

  it("resyncs changed visibility targets only for a published MCP-enabled App", async () => {
    const { resyncPublishedAppMcpResource } = await registryModule();
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ input: String(input), init });
      return Response.json({ resource: { id: "app-mcp:app-1" } }, { status: 201 });
    };
    const database = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return { manifest_json: JSON.stringify(manifest) };
              },
            };
          },
        };
      },
    };
    const publishedApp = {
      ...app,
      agent_mcp_enabled: 1,
      collaborator_user_ids_json: JSON.stringify(["editor-2"]),
      owner_user_id: "owner-1",
      status: "published",
      visibility: "team",
    };

    try {
      assert.equal(await resyncPublishedAppMcpResource({
        AUTH_WORKER_URL: "https://auth.example.com",
        APPS_AUTH_SERVICE_TOKEN: "apps-service-token",
        APPS_DB: database,
      }, publishedApp, {
        accessTargets: ["user:viewer-2"],
        visibility: "private",
      }), true);
      assert.equal(await resyncPublishedAppMcpResource({
        AUTH_WORKER_URL: "https://auth.example.com",
        APPS_AUTH_SERVICE_TOKEN: "apps-service-token",
        APPS_DB: database,
      }, { ...publishedApp, agent_mcp_enabled: 0 }), false);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requests.length, 1);
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.status, "listed");
    assert.equal(body.accessMode, "targeted");
    assert.deepEqual(body.accessTargets, ["user:viewer-2", "user:editor-2"]);
  });
});
