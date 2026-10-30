import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appsDeployArtifactPath, appsSourceSnapshotPath, proxyAppsDeployArtifactRequest, proxyAppsSourceSnapshotRequest, resolveAppsSourceSnapshotPrincipal } from "./sourceSnapshots.ts";

const principal = {
  departmentId: "dept-1",
  departmentPath: ["company", "dept-1"],
  email: "ada@example.invalid",
  orgId: "org-1",
  scopes: ["workspace:apps:read", "workspace:apps:write"],
  sub: "user-1"
};

const env = {
  AUTH_ISSUER: "https://auth.example.test",
  WORKSPACE_MCP_JWT_SECRET: "snapshot-proxy-secret",
  APPS_ORG_ID: "org-1",
  APPS_ORG_SLUG: "workspace",
  APPS_WORKER_URL: "https://apps.example.test"
};

describe("Workspace CLI source snapshot proxy", () => {
  it("streams ZIP bytes outside JSON-RPC and signs a short-lived APPS request", async () => {
    const archive = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const request = new Request("https://mcp.example.test/api/apps/apps/app-1/source-snapshots?version=v1", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-workspace-source-content-sha256": "a".repeat(64),
        "x-workspace-source-file-count": "1",
        "x-workspace-source-metadata": "eyJwdXJwb3NlIjoiYmFja3VwIn0",
        "x-workspace-source-size": "10"
      },
      body: archive
    });
    let downstream;
    const response = await proxyAppsSourceSnapshotRequest(
      request,
      env,
      principal,
      `${appsSourceSnapshotPath("app-1")}?version=v1`,
      async (url, init) => {
        downstream = {
          body: new Uint8Array(await new Response(init.body).arrayBuffer()),
          headers: new Headers(init.headers),
          method: init.method,
          url: String(url)
        };
        return Response.json({ sourceSnapshot: { id: "snap-1" } }, { status: 201 });
      }
    );

    assert.equal(downstream.url, "https://apps.example.test/apps/app-1/source-snapshots?version=v1");
    assert.equal(downstream.method, "POST");
    assert.deepEqual(downstream.body, archive);
    assert.match(downstream.headers.get("authorization"), /^Bearer [^.]+\.[^.]+\.[^.]+$/);
    const payload = JSON.parse(Buffer.from(downstream.headers.get("authorization").slice(7).split(".")[1], "base64url"));
    assert.equal(payload.sub, "user-1");
    assert.deepEqual(payload.scopes, ["apps:apps:write", "apps:apps:read"]);
    assert.equal(downstream.headers.get("x-workspace-source-content-sha256"), "a".repeat(64));
    assert.equal(downstream.headers.get("x-workspace-source-metadata"), "eyJwdXJwb3NlIjoiYmFja3VwIn0");
    assert.equal(response.status, 201);
    assert.equal((await response.json()).sourceSnapshot.id, "snap-1");
  });

  it("builds escaped APPS collection and download paths", () => {
    assert.equal(appsSourceSnapshotPath("app/a"), "/apps/app%2Fa/source-snapshots");
    assert.equal(appsSourceSnapshotPath("app/a", "snap/b"), "/apps/app%2Fa/source-snapshots/snap%2Fb/download");
    assert.equal(appsDeployArtifactPath("app/a"), "/apps/app%2Fa/deploy-artifacts");
    assert.equal(appsDeployArtifactPath("app/a", "artifact/b"), "/apps/app%2Fa/deploy-artifacts/artifact%2Fb/download");
  });

  it("forwards deployment artifact integrity headers and ZIP bytes", async () => {
    const archive = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 9, 8, 7]);
    const request = new Request("https://mcp.example.test/api/apps/apps/app-1/deploy-artifacts?version=v2", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-workspace-deploy-archive-sha256": "b".repeat(64),
        "x-workspace-deploy-content-sha256": "c".repeat(64),
        "x-workspace-deploy-content-size": "7",
        "x-workspace-deploy-entrypoint": "index.js",
        "x-workspace-deploy-file-count": "1",
        "x-workspace-deploy-target": "worker"
      },
      body: archive
    });
    let downstream;
    const response = await proxyAppsDeployArtifactRequest(
      request,
      env,
      principal,
      `${appsDeployArtifactPath("app-1")}?version=v2`,
      async (url, init) => {
        downstream = {
          body: new Uint8Array(await new Response(init.body).arrayBuffer()),
          headers: new Headers(init.headers),
          url: String(url)
        };
        return Response.json({ deployArtifact: { id: "artifact-1" } }, { status: 201 });
      }
    );

    assert.equal(downstream.url, "https://apps.example.test/apps/app-1/deploy-artifacts?version=v2");
    assert.deepEqual(downstream.body, archive);
    assert.equal(downstream.headers.get("x-workspace-deploy-entrypoint"), "index.js");
    assert.equal(downstream.headers.get("x-workspace-deploy-target"), "worker");
    assert.equal(response.status, 201);
    assert.equal((await response.json()).deployArtifact.id, "artifact-1");
  });

  it("accepts the production gate token only for its isolated synthetic app", async () => {
    const acceptanceEnv = {
      ...env,
      WORKSPACE_SOURCE_SNAPSHOT_ACCEPTANCE_APP_ID: "app-acceptance",
      WORKSPACE_SOURCE_SNAPSHOT_ACCEPTANCE_EMAIL: "acceptance@example.invalid",
      WORKSPACE_SOURCE_SNAPSHOT_ACCEPTANCE_TOKEN: "acceptance-secret",
      WORKSPACE_SOURCE_SNAPSHOT_ACCEPTANCE_USER_ID: "acceptance-owner"
    };
    const request = new Request("https://mcp.example.test/api/apps/apps/app-acceptance/source-snapshots", {
      headers: { authorization: "Bearer acceptance-secret" }
    });

    const resolved = await resolveAppsSourceSnapshotPrincipal(request, acceptanceEnv, "app-acceptance", async () => {
      throw new Error("OAuth introspection must not run for the scoped production gate");
    });

    assert.equal(resolved.sub, "acceptance-owner");
    assert.equal(resolved.email, "acceptance@example.invalid");
    assert.deepEqual(resolved.scopes, ["workspace:apps:read", "workspace:apps:write"]);
    await assert.rejects(
      () => resolveAppsSourceSnapshotPrincipal(request, acceptanceEnv, "app-business"),
      (error) => error?.status === 403 && error?.code === "source_snapshot_acceptance_app_forbidden"
    );
  });
});
