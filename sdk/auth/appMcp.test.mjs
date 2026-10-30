import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkspaceMcpAuthorization, WorkspaceAuthSdkError } from "./index.ts";

const manifest = {
  schemaVersion: "workspace.app-mcp/v1",
  appId: "app-academy",
  name: "Academy",
  baseUrl: "https://academy.example.com",
  audience: "https://academy.example.com",
  resourceId: "resource-academy",
  toolDefinitionVersion: "1",
  authorization: {
    model: "app-rbac",
    defaultRole: "member",
    toolsEndpoint: "/api/v1/mcp/tools",
    toolsEndpointScope: "app:mcp:discover",
    roles: [
      { id: "member", name: "Member" },
      { id: "admin", name: "Admin" },
    ],
  },
  tools: [
    {
      name: "academy_list",
      description: "List lessons.",
      method: "GET",
      path: "/api/v1/lessons",
      allowedRoles: ["member", "admin"],
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
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
};

function authorization(resolveRoles, scopes = ["app:mcp:discover", "academy:read", "academy:write"], claims = {}) {
  return createWorkspaceMcpAuthorization({
    manifest,
    resolveRoles,
    auth: {
      authOrigin: "https://auth.example.com",
      introspectionToken: "introspection-token",
      async fetcher(_url, init) {
        const body = JSON.parse(init.body);
        return Response.json({
          active: true,
          aud: "https://academy.example.com",
          resource_id: "resource-academy",
          scopes,
          sub: "user-1",
          principal: { sub: "user-1", scopes, ...claims },
          requestedScopes: body.scopes,
        });
      },
    },
  });
}

const request = new Request("https://academy.example.com/api/v1/mcp/tools", {
  headers: { authorization: "Bearer resource-token" },
});

describe("Workspace App MCP authorization", () => {
  it("lists only tools allowed by the App-local role resolver", async () => {
    const sdk = authorization(async ({ appId, userId }) => {
      assert.equal(appId, "app-academy");
      assert.equal(userId, "user-1");
      return { status: "active", roles: ["member"], policyVersion: 7 };
    });

    const result = await sdk.listTools(request);
    assert.equal(result.policyVersion, 7);
    assert.deepEqual(result.tools.map((tool) => tool.name), ["academy_list"]);
  });

  it("rechecks role and tool scopes on execution", async () => {
    const sdk = authorization(async () => ({ status: "active", roles: ["member"] }));
    await assert.rejects(
      () => sdk.requireTool(request, "academy_publish"),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "mcp_tool_role_required" && error.status === 403,
    );

    const missingScope = authorization(async () => ({ status: "active", roles: ["admin"] }), ["app:mcp:discover"]);
    await assert.rejects(
      () => missingScope.requireTool(request, "academy_publish"),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "token_scope_missing" && error.status === 403,
    );
  });

  it("inherits the live App collaborator role without copying it into the local resolver", async () => {
    const sdk = authorization(
      async () => ({ status: "active", roles: ["member"], policyVersion: "member-7" }),
      undefined,
      { appSystemRoles: ["app_collaborator"], appRolePolicyVersion: "app-42" },
    );
    const authorized = await sdk.requireTool(request, "academy_publish");
    assert.deepEqual(authorized.roles, ["member", "admin"]);
    assert.equal(authorized.policyVersion, "app-42:member-7");
  });

  it("denies App users marked disabled", async () => {
    const sdk = authorization(async () => ({ status: "disabled", roles: ["admin"] }));
    await assert.rejects(
      () => sdk.listTools(request),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "app_user_disabled" && error.status === 403,
    );
  });

  it("binds every discovery and execution token to the Manifest Resource ID", async () => {
    const sdk = createWorkspaceMcpAuthorization({
      manifest,
      resolveRoles: async () => ({ status: "active", roles: ["admin"] }),
      auth: {
        authOrigin: "https://auth.example.com",
        async fetcher() {
          return Response.json({
            active: true,
            aud: "https://academy.example.com",
            resource_id: "resource-other-app",
            scopes: ["app:mcp:discover", "academy:write"],
            sub: "user-1",
          });
        },
      },
    });

    await assert.rejects(
      () => sdk.listTools(request),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "token_resource_mismatch" && error.status === 403,
    );
  });
});
