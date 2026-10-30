import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let handlerModulePromise;

async function handlerModule() {
  if (!handlerModulePromise) {
    handlerModulePromise = (async () => {
      const outdir = await mkdtemp(join(tmpdir(), "apps-mcp-handler-test-"));
      const outfile = join(outdir, "handler.mjs");
      await build({
        bundle: true,
        entryPoints: [new URL("./handler.ts", import.meta.url).pathname],
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
  return handlerModulePromise;
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

  async first() {
    return this.statement.get(...this.params) ?? null;
  }
}

function createEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  const now = "2026-07-31T00:00:00.000Z";
  database.prepare(`
    INSERT INTO apps_apps (
      id, org_id, org_slug, owner_user_id, name, code, slug, description, type,
      status, visibility, login_required, data_service_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "app-1",
    "org-1",
    "org-1",
    "owner-1",
    "Compliance App",
    "compliance-app",
    "compliance-app",
    "",
    "container",
    "draft",
    "private",
    1,
    "data-app-1",
    now,
    now
  );

  return {
    DEV_AUTH_BYPASS: "1",
    APPS_DB: new D1Adapter(database)
  };
}

function mcpRequest(name, args) {
  return new Request("http://localhost/mcp", {
    body: JSON.stringify({
      id: "deploy",
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: args, name }
    }),
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-auth-preflight-1",
      "x-workspace-org-id": "org-1",
      "x-workspace-org-slug": "org-1",
      "x-workspace-scopes": "apps:apps:write,apps:deploy:production",
      "x-workspace-user-id": "owner-1"
    },
    method: "POST"
  });
}

describe("APPS MCP error responses", () => {
  it("returns actionable Auth preflight failures as MCP tool error results", async () => {
    const { handleMcpRequest } = await handlerModule();
    const originalWarn = console.warn;
    console.warn = () => {};

    try {
      const response = await handleMcpRequest(mcpRequest("apps_worker_deploy", {
        appId: "app-1",
        entrypoint: "index.js",
        files: [{
          content: `export default { fetch() { return new Response("unique-source-body-7429"); } };`,
          path: "index.js"
        }],
        version: "blocked-v1"
      }), createEnv(), { waitUntil() {} });
      const rpc = await response.json();

      assert.equal(rpc.error, undefined);
      assert.equal(rpc.result.isError, true);
      assert.equal(rpc.result.structuredContent.error.schemaVersion, "workspace.mcp.error.v1");
      assert.equal(rpc.result.structuredContent.error.code, "auth_security_preflight_failed");
      assert.equal(rpc.result.structuredContent.error.status, 422);
      assert.equal(rpc.result.structuredContent.error.retryable, false);
      assert.equal(rpc.result.structuredContent.error.requestId, "request-auth-preflight-1");
      assert.equal(rpc.result.structuredContent.error.details.security.auth.status, "blocked");
      assert.deepEqual(
        rpc.result.structuredContent.error.details.security.auth.findings.map((finding) => finding.code),
        ["AUTH_PLATFORM_INTEGRATION_MISSING"]
      );
      const finding = rpc.result.structuredContent.error.details.security.auth.findings[0];
      assert.equal(finding.why.length > 0, true);
      assert.equal(finding.how.length > 100, true);
      assert.match(rpc.result.content[0].text, /apps_get_app/);
      assert.match(rpc.result.content[0].text, new RegExp(finding.how.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.deepEqual(rpc.result.structuredContent.error.handoff.nextAction, {
        kind: "tool_call",
        tool: "apps_get_app",
        arguments: { appId: "app-1" },
        reason: "Refresh the canonical App context, readiness, managed-secret lifecycle, blockers, and next actions before changing Auth implementation.",
        requiresUserApproval: false
      });
      assert.deepEqual(rpc.result.structuredContent.error.handoff.retry, {
        tool: "apps_worker_deploy",
        requiresUserApproval: true,
        reuseOriginalArguments: true
      });
      assert.equal(JSON.stringify(rpc.result).includes("unique-source-body-7429"), false);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("keeps unknown tools as JSON-RPC protocol errors", async () => {
    const { handleMcpRequest } = await handlerModule();
    for (const name of [
      "apps_apply_app_migration",
      "apps_deploy_app_source",
      "apps_deploy_pages",
      "apps_get_skill_install_prompt",
      "apps_not_a_tool",
      "apps_publish_production",
      "apps_publish_skill",
      "apps_publish_skill_private",
      "apps_update_skill",
      "apps_update_skill_private",
      "apps_validate_skill",
      "apps_validate_skill_package"
    ]) {
      const response = await handleMcpRequest(mcpRequest(name, {}), createEnv(), { waitUntil() {} });
      const rpc = await response.json();

      assert.equal(rpc.result, undefined);
      assert.equal(rpc.error.code, -32602);
      assert.equal(rpc.error.message, "unknown_mcp_tool");
    }
  });
});
