import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { callAppMcpTool, listAppMcpTools } from "./appMcpBroker.ts";

const manifest = {
  schemaVersion: "workspace.app-mcp/v1",
  appId: "app-academy",
  name: "Academy",
  baseUrl: "https://academy.example.com",
  audience: "https://academy.example.com",
  resourceId: "resource-academy",
  toolDefinitionVersion: "3",
  authorization: {
    model: "app-rbac",
    defaultRole: "user",
    toolsEndpoint: "/api/v1/mcp/tools",
    toolsEndpointScope: "app:mcp:discover",
    roles: [
      { id: "user", name: "User" },
      { id: "admin", name: "Admin" },
    ],
  },
  tools: [
    {
      name: "academy_list",
      description: "List lessons.",
      method: "GET",
      path: "/api/v1/lessons",
      allowedRoles: ["user", "admin"],
      requiredScopes: ["academy:read"],
      readOnly: true,
      riskLevel: "low",
      requiresConfirmation: false,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "academy_publish",
      description: "Publish a lesson.",
      method: "POST",
      path: "/api/v1/lessons/publish",
      allowedRoles: ["admin"],
      requiredScopes: ["academy:write"],
      readOnly: false,
      riskLevel: "high",
      requiresConfirmation: true,
      inputSchema: {
        type: "object",
        required: ["lessonId"],
        properties: { lessonId: { type: "string", maxLength: 100 } },
        additionalProperties: false,
      },
    },
  ],
};

const env = { AUTH_ISSUER: "https://auth.example.com",
  AUTH_WORKER_URL: "https://auth.example.com",
  WORKSPACE_MCP_JWT_SECRET: "test-apps-signing-secret",
  APPS_ORG_ID: "org-1",
  APPS_WORKER_URL: "https://apps.example.com",
  MCP_INTROSPECTION_TOKEN: "broker-service-token",
};

const principal = {
  clientId: "workspace-ai-mcp",
  connectionId: "connection-1",
  email: "ada@example.com",
  name: "Ada",
  orgId: "org-1",
  role: "member",
  scopes: ["apps:apps:read"],
  sub: "user-1",
};

function response(value, status = 200) {
  return Response.json(value, { status });
}

function registeredApp() {
  return { manifest, manifestSha256: "sha256-snapshot" };
}

describe("Workspace App MCP broker", () => {
  it("routes same-zone App custom domains through Cloudflare's public front door", async () => {
    const wrangler = await readFile(new URL("../../../packages/installer/src/render.mjs", import.meta.url), "utf8");
    assert.match(wrangler, /global_fetch_strictly_public/);
  });

  it("intersects the published manifest with the App's current role response", async () => {
    const calls = [];
    const result = await listAppMcpTools("app-academy", env, principal, async (input, init) => {
      calls.push({ input: String(input), init });
      if (String(input) === "https://apps.example.com/mcp-apps/app-academy") return response(registeredApp());
      if (String(input) === "https://auth.example.com/v1/resource-tokens/mint") {
        const body = JSON.parse(init.body);
        assert.deepEqual(body.scopes, ["app:mcp:discover"]);
        return response({ access_token: "discovery-token" });
      }
      if (String(input) === "https://academy.example.com/api/v1/mcp/tools") {
        assert.equal(init.headers.Authorization, "Bearer discovery-token");
        return response({ policyVersion: 9, tools: [{ name: "academy_list" }] });
      }
      throw new Error(`unexpected request ${input}`);
    });

    assert.equal(calls.length, 3);
    assert.equal(result.policyVersion, 9);
    assert.deepEqual(result.tools.map((tool) => tool.name), ["academy_list"]);
  });

  it("rechecks live role access, mints a tool-scoped token, and calls only the registered route", async () => {
    const mintBodies = [];
    const result = await callAppMcpTool({
      appId: "app-academy",
      toolName: "academy_publish",
      arguments: { lessonId: "lesson-1" },
      confirmation: true,
    }, env, principal, async (input, init) => {
      const url = String(input);
      if (url === "https://apps.example.com/mcp-apps/app-academy") return response(registeredApp());
      if (url === "https://auth.example.com/v1/resource-tokens/mint") {
        const body = JSON.parse(init.body);
        mintBodies.push(body);
        return response({ access_token: body.toolName ? "tool-token" : "discovery-token" });
      }
      if (url === "https://academy.example.com/api/v1/mcp/tools") {
        return response({ tools: [{ name: "academy_publish" }] });
      }
      if (url === "https://academy.example.com/api/v1/lessons/publish") {
        assert.equal(init.method, "POST");
        assert.equal(init.headers.Authorization, "Bearer tool-token");
        assert.deepEqual(JSON.parse(init.body), { lessonId: "lesson-1" });
        return response({ ok: true, echoedToken: "tool-token" });
      }
      throw new Error(`unexpected request ${input}`);
    });

    assert.deepEqual(mintBodies.map((body) => body.scopes), [
      ["app:mcp:discover"],
      ["academy:write"],
    ]);
    assert.deepEqual(result, { ok: true, echoedToken: "[redacted]" });
  });

  it("uses the Manifest-selected Workspace Resource Token header for discovery and tool calls", async () => {
    const customManifest = {
      ...manifest,
      authorization: {
        ...manifest.authorization,
        resourceTokenHeader: "x-workspace-resource-token",
      },
    };
    const result = await callAppMcpTool({
      appId: "app-academy",
      toolName: "academy_publish",
      arguments: { lessonId: "lesson-custom-header" },
      confirmation: true,
    }, env, principal, async (input, init) => {
      const url = String(input);
      if (url === "https://apps.example.com/mcp-apps/app-academy") {
        return response({ manifest: customManifest, manifestSha256: "sha256-custom-header" });
      }
      if (url === "https://auth.example.com/v1/resource-tokens/mint") {
        const body = JSON.parse(init.body);
        return response({ access_token: body.toolName ? "tool-token" : "discovery-token" });
      }
      if (url === "https://academy.example.com/api/v1/mcp/tools") {
        assert.equal(init.headers["X-Workspace-Resource-Token"], "discovery-token");
        assert.equal(init.headers.Authorization, undefined);
        return response({ tools: [{ name: "academy_publish" }] });
      }
      if (url === "https://academy.example.com/api/v1/lessons/publish") {
        assert.equal(init.headers["X-Workspace-Resource-Token"], "tool-token");
        assert.equal(init.headers.Authorization, undefined);
        return response({ ok: true });
      }
      throw new Error(`unexpected request ${input}`);
    });

    assert.deepEqual(result, { ok: true });
  });

  it("requires confirmation and rejects arguments outside the registered schema", async () => {
    const fetchRegistered = async (input) => {
      assert.equal(String(input), "https://apps.example.com/mcp-apps/app-academy");
      return response(registeredApp());
    };

    await assert.rejects(
      () => callAppMcpTool({
        appId: "app-academy",
        toolName: "academy_publish",
        arguments: { lessonId: "lesson-1" },
      }, env, principal, fetchRegistered),
      (error) => error.code === "tool_confirmation_required" && error.status === 409,
    );
    await assert.rejects(
      () => callAppMcpTool({
        appId: "app-academy",
        toolName: "academy_publish",
        arguments: { lessonId: "lesson-1", targetUrl: "https://evil.example.com" },
        confirmation: true,
      }, env, principal, fetchRegistered),
      (error) => error.code === "app_mcp_tool_argument_unknown" && error.status === 400,
    );
  });
});
