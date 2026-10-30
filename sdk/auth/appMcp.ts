import {
  parseWorkspaceAppMcpManifest,
  publicWorkspaceAppMcpTool,
  resolveEffectiveAppRoles,
  toolsAllowedForRoles,
  type WorkspaceAppMcpManifest,
  type WorkspaceAppMcpTool,
} from "./manifest.ts";
import { WorkspaceAuthResource } from "./resource.ts";
import { WorkspaceAuthSdkError, type AuthClaims, type WorkspaceAuthConfig } from "./types.ts";

export type WorkspaceAppRoleResolution = {
  status: "active" | "disabled";
  roles: string[];
  policyVersion?: number | string;
};

export type WorkspaceAppRoleResolver = (input: {
  appId: string;
  principal: AuthClaims;
  userId: string;
}) => Promise<WorkspaceAppRoleResolution>;

export type WorkspaceMcpAuthorizationConfig = {
  auth: WorkspaceAuthConfig | WorkspaceAuthResource;
  manifest: WorkspaceAppMcpManifest | unknown;
  resolveRoles: WorkspaceAppRoleResolver;
};

export type WorkspaceAuthorizedMcpTool = {
  manifest: WorkspaceAppMcpManifest;
  policyVersion?: number | string;
  principal: AuthClaims;
  roles: string[];
  tool: WorkspaceAppMcpTool;
};

/**
 * Storage-independent App-local MCP authorization.
 *
 * Workspace Auth proves the resource-token identity and audience. The App-supplied
 * resolver remains the authority for current local roles and account status.
 * Signed App Center system roles are merged through the Manifest's inheritance
 * policy on every discovery and execution request.
 */
export class WorkspaceMcpAuthorization {
  readonly manifest: WorkspaceAppMcpManifest;
  private readonly auth: WorkspaceAuthResource;
  private readonly resolveRoles: WorkspaceAppRoleResolver;

  constructor(config: WorkspaceMcpAuthorizationConfig) {
    this.manifest = parseWorkspaceAppMcpManifest(config.manifest);
    this.auth = config.auth instanceof WorkspaceAuthResource
      ? config.auth
      : new WorkspaceAuthResource(config.auth);
    this.resolveRoles = config.resolveRoles;
  }

  async listTools(request: Request) {
    const context = await this.resolveContext(request, [this.manifest.authorization.toolsEndpointScope]);
    return {
      appId: this.manifest.appId,
      policyVersion: context.policyVersion,
      tools: toolsAllowedForRoles(this.manifest, context.roles).map(publicWorkspaceAppMcpTool),
    };
  }

  async requireTool(request: Request, toolName: string): Promise<WorkspaceAuthorizedMcpTool> {
    const tool = this.manifest.tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new WorkspaceAuthSdkError("mcp_tool_not_registered", "MCP tool is not registered", 404);
    }

    const context = await this.resolveContext(request, tool.requiredScopes);
    if (!tool.allowedRoles.some((role) => context.roles.includes(role))) {
      throw new WorkspaceAuthSdkError("mcp_tool_role_required", "Current App role cannot use this MCP tool", 403, {
        appId: this.manifest.appId,
        toolName,
      });
    }

    return {
      manifest: this.manifest,
      policyVersion: context.policyVersion,
      principal: context.principal,
      roles: context.roles,
      tool,
    };
  }

  private async resolveContext(request: Request, scopes: string[] = []) {
    const principal = await this.auth.requireAccess(request, {
      audience: this.manifest.audience,
      resourceId: this.manifest.resourceId,
      scopes,
    });
    const resolution = await this.resolveRoles({
      appId: this.manifest.appId,
      principal,
      userId: principal.sub,
    });
    if (resolution.status !== "active") {
      throw new WorkspaceAuthSdkError("app_user_disabled", "App user is disabled", 403);
    }
    const roles = resolveEffectiveAppRoles(
      this.manifest,
      principal.appSystemRoles,
      resolution.roles,
    );
    return {
      principal,
      roles,
      policyVersion: combinedPolicyVersion(principal.appRolePolicyVersion, resolution.policyVersion),
    };
  }
}

export function createWorkspaceMcpAuthorization(config: WorkspaceMcpAuthorizationConfig) {
  return new WorkspaceMcpAuthorization(config);
}

function combinedPolicyVersion(
  systemVersion: string | undefined,
  localVersion: number | string | undefined,
) {
  const parts = [systemVersion, localVersion].filter((part) => part !== undefined && part !== "");
  return parts.length > 1 ? parts.join(":") : parts[0];
}
