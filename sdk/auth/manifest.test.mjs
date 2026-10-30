import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WorkspaceAppMcpManifestError,
  parseWorkspaceAppMcpManifest,
  resolveEffectiveAppRoles,
  toolsAllowedForRoles,
} from "./manifest.ts";

function manifest(overrides = {}) {
  return {
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
        { id: "member", name: "Member", system: true },
        { id: "editor", name: "Editor" },
        { id: "owner", name: "Owner", system: true },
      ],
    },
    tools: [{
      name: "academy_publish",
      description: "Publish a lesson.",
      method: "POST",
      path: "/api/v1/lessons/publish",
      allowedRoles: ["editor", "owner"],
      requiredScopes: ["academy:write"],
      readOnly: false,
      riskLevel: "high",
      requiresConfirmation: true,
      inputSchema: {
        type: "object",
        required: ["lessonId"],
        properties: { lessonId: { type: "string" } },
        additionalProperties: false,
      },
    }],
    ...overrides,
  };
}

describe("Workspace App MCP manifest", () => {
  it("allows App-defined roles and filters tools by the resolved roles", () => {
    const parsed = parseWorkspaceAppMcpManifest(manifest(), {
      appId: "app-academy",
      baseUrl: "https://academy.example.com/",
    });

    assert.deepEqual(toolsAllowedForRoles(parsed, ["member"]), []);
    assert.deepEqual(toolsAllowedForRoles(parsed, ["editor"]).map((tool) => tool.name), ["academy_publish"]);
    assert.equal(parsed.authorization.toolsEndpointScope, "app:mcp:discover");
    assert.deepEqual(parsed.authorization.systemRoleInheritance, {
      app_owner: ["owner"],
      app_collaborator: [],
    });
  });

  it("uses the standard owner/admin inheritance defaults and supports an explicit independent policy", () => {
    const integrated = manifest();
    integrated.authorization.roles.push({ id: "admin", name: "Admin" });
    const parsedIntegrated = parseWorkspaceAppMcpManifest(integrated);
    assert.deepEqual(parsedIntegrated.authorization.systemRoleInheritance, {
      app_owner: ["owner"],
      app_collaborator: ["admin"],
    });
    assert.deepEqual(
      resolveEffectiveAppRoles(parsedIntegrated, ["app_collaborator"], ["member"]),
      ["member", "admin"],
    );

    const independent = manifest();
    independent.authorization.systemRoleInheritance = { app_owner: [], app_collaborator: [] };
    const parsedIndependent = parseWorkspaceAppMcpManifest(independent);
    assert.deepEqual(resolveEffectiveAppRoles(parsedIndependent, ["app_owner"], []), ["member"]);
  });

  it("supports partial overrides and custom multi-role mappings without an implicit role hierarchy", () => {
    const partial = manifest();
    partial.authorization.roles.push({ id: "admin", name: "Admin" });
    partial.authorization.systemRoleInheritance = { app_collaborator: [] };
    const parsedPartial = parseWorkspaceAppMcpManifest(partial);
    assert.deepEqual(parsedPartial.authorization.systemRoleInheritance, {
      app_owner: ["owner"],
      app_collaborator: [],
    });
    assert.deepEqual(resolveEffectiveAppRoles(parsedPartial, ["app_owner"], []), ["owner"]);
    assert.deepEqual(toolsAllowedForRoles(parsedPartial, ["owner"]).map((tool) => tool.name), ["academy_publish"]);
    assert.deepEqual(toolsAllowedForRoles(parsedPartial, ["admin"]), []);

    const custom = manifest();
    custom.authorization.roles.push(
      { id: "admin", name: "Admin" },
      { id: "reviewer", name: "Reviewer" },
    );
    custom.authorization.systemRoleInheritance = {
      app_owner: ["owner", "admin", "reviewer"],
      app_collaborator: ["admin"],
    };
    const parsedCustom = parseWorkspaceAppMcpManifest(custom);
    assert.deepEqual(
      resolveEffectiveAppRoles(parsedCustom, ["app_owner", "app_collaborator"], ["member", "reviewer"]),
      ["member", "reviewer", "owner", "admin"],
    );
  });

  it("accepts the opt-in Workspace Resource Token header without changing the default", () => {
    const customHeader = manifest();
    customHeader.authorization.resourceTokenHeader = "x-workspace-resource-token";

    const parsedCustom = parseWorkspaceAppMcpManifest(customHeader);
    const parsedDefault = parseWorkspaceAppMcpManifest(manifest());

    assert.equal(parsedCustom.authorization.resourceTokenHeader, "x-workspace-resource-token");
    assert.equal(parsedDefault.authorization.resourceTokenHeader, undefined);
  });

  it("rejects unknown roles, unsafe routes, and unconfirmed high-risk writes", () => {
    const invalidRole = manifest();
    invalidRole.tools[0].allowedRoles = ["missing"];
    assert.throws(() => parseWorkspaceAppMcpManifest(invalidRole), isCode("app_mcp_tool_role_unknown"));

    const unsafePath = manifest();
    unsafePath.tools[0].path = "/api/%2e%2e/admin";
    assert.throws(() => parseWorkspaceAppMcpManifest(unsafePath), isCode("app_mcp_tool_path_invalid"));

    const noConfirmation = manifest();
    noConfirmation.tools[0].requiresConfirmation = false;
    assert.throws(() => parseWorkspaceAppMcpManifest(noConfirmation), isCode("app_mcp_high_risk_confirmation_required"));

    const invalidTokenHeader = manifest();
    invalidTokenHeader.authorization.resourceTokenHeader = "x-custom-token";
    assert.throws(
      () => parseWorkspaceAppMcpManifest(invalidTokenHeader),
      isCode("app_mcp_resource_token_header_invalid"),
    );

    const unknownInheritedRole = manifest();
    unknownInheritedRole.authorization.systemRoleInheritance = { app_owner: ["missing"] };
    assert.throws(
      () => parseWorkspaceAppMcpManifest(unknownInheritedRole),
      isCode("app_mcp_system_role_target_unknown"),
    );
  });
});

function isCode(code) {
  return (error) => error instanceof WorkspaceAppMcpManifestError && error.code === code;
}
