export const WORKSPACE_APP_MCP_SCHEMA_VERSION = "workspace.app-mcp/v1" as const;

export type WorkspaceAppMcpRiskLevel = "low" | "medium" | "high" | "critical";
export type WorkspaceAppMcpMethod = "GET" | "POST";
export type WorkspaceAppMcpResourceTokenHeader = "authorization" | "x-workspace-resource-token";
export type WorkspaceAppSystemRole = "app_owner" | "app_collaborator";
export type WorkspaceAppSystemRoleInheritance = Record<WorkspaceAppSystemRole, string[]>;

export const WORKSPACE_APP_SYSTEM_ROLES: WorkspaceAppSystemRole[] = ["app_owner", "app_collaborator"];

export type WorkspaceAppMcpRole = {
  id: string;
  name: string;
  description?: string;
  system?: boolean;
};

export type WorkspaceAppMcpTool = {
  name: string;
  description: string;
  method: WorkspaceAppMcpMethod;
  path: string;
  allowedRoles: string[];
  requiredScopes: string[];
  readOnly: boolean;
  riskLevel: WorkspaceAppMcpRiskLevel;
  requiresConfirmation: boolean;
  inputSchema: Record<string, unknown>;
};

export type WorkspaceAppMcpManifest = {
  schemaVersion: typeof WORKSPACE_APP_MCP_SCHEMA_VERSION;
  appId: string;
  name: string;
  description?: string;
  baseUrl: string;
  audience: string;
  resourceId: string;
  toolDefinitionVersion: string;
  authorization: {
    model: "app-rbac";
    defaultRole: string;
    resourceTokenHeader?: WorkspaceAppMcpResourceTokenHeader;
    systemRoleInheritance: WorkspaceAppSystemRoleInheritance;
    toolsEndpoint: string;
    toolsEndpointScope: string;
    roles: WorkspaceAppMcpRole[];
  };
  tools: WorkspaceAppMcpTool[];
};

export type WorkspaceAppMcpManifestExpectations = {
  appId?: string;
  baseUrl?: string;
  audience?: string;
  resourceId?: string;
};

export class WorkspaceAppMcpManifestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "WorkspaceAppMcpManifestError";
  }
}

export function parseWorkspaceAppMcpManifest(
  value: unknown,
  expectations: WorkspaceAppMcpManifestExpectations = {},
): WorkspaceAppMcpManifest {
  const record = object(value, "app_mcp_manifest_invalid");
  if (record.schemaVersion !== WORKSPACE_APP_MCP_SCHEMA_VERSION) fail("app_mcp_schema_version_unsupported");

  const appId = identifier(record.appId, "app_mcp_app_id_invalid", 160);
  const name = boundedText(record.name, "app_mcp_name_invalid", 160);
  const description = optionalText(record.description, "app_mcp_description_invalid", 1_000);
  const baseUrl = httpsOrigin(record.baseUrl, "app_mcp_base_url_invalid");
  const audience = boundedText(record.audience, "app_mcp_audience_invalid", 500);
  const resourceId = identifier(record.resourceId, "app_mcp_resource_id_invalid", 180);
  const toolDefinitionVersion = identifier(record.toolDefinitionVersion, "app_mcp_tool_version_invalid", 160);

  if (expectations.appId && appId !== expectations.appId) fail("app_mcp_app_id_mismatch");
  if (expectations.baseUrl && baseUrl !== normalizedOrigin(expectations.baseUrl)) fail("app_mcp_base_url_mismatch");
  if (expectations.audience && audience !== expectations.audience) fail("app_mcp_audience_mismatch");
  if (expectations.resourceId && resourceId !== expectations.resourceId) fail("app_mcp_resource_id_mismatch");

  const authorization = object(record.authorization, "app_mcp_authorization_invalid");
  if (authorization.model !== "app-rbac") fail("app_mcp_authorization_model_unsupported");
  const defaultRole = identifier(authorization.defaultRole, "app_mcp_default_role_invalid", 100);
  const resourceTokenHeader = authorization.resourceTokenHeader === undefined
    ? undefined
    : resourceTokenHeaderName(authorization.resourceTokenHeader);
  const toolsEndpoint = relativePath(authorization.toolsEndpoint, "app_mcp_tools_endpoint_invalid");
  const toolsEndpointScope = scopeName(authorization.toolsEndpointScope);
  const roleRecords = boundedArray(authorization.roles, "app_mcp_roles_invalid", 1, 100);
  const roles = roleRecords.map((item) => {
    const role = object(item, "app_mcp_role_invalid");
    return {
      id: identifier(role.id, "app_mcp_role_id_invalid", 100),
      name: boundedText(role.name, "app_mcp_role_name_invalid", 160),
      ...(optionalText(role.description, "app_mcp_role_description_invalid", 1_000) ? { description: optionalText(role.description, "app_mcp_role_description_invalid", 1_000) } : {}),
      ...(role.system === true ? { system: true } : {}),
    } satisfies WorkspaceAppMcpRole;
  });
  unique(roles.map((role) => role.id), "app_mcp_role_duplicate");
  const roleIds = new Set(roles.map((role) => role.id));
  if (!roleIds.has(defaultRole)) fail("app_mcp_default_role_missing");
  const systemRoleInheritance = parseSystemRoleInheritance(authorization.systemRoleInheritance, roleIds);

  const toolRecords = boundedArray(record.tools, "app_mcp_tools_invalid", 1, 100);
  const tools = toolRecords.map((item) => parseTool(item, roleIds));
  unique(tools.map((tool) => tool.name), "app_mcp_tool_duplicate");
  unique(tools.map((tool) => `${tool.method} ${tool.path}`), "app_mcp_tool_route_duplicate");

  return {
    schemaVersion: WORKSPACE_APP_MCP_SCHEMA_VERSION,
    appId,
    name,
    ...(description ? { description } : {}),
    baseUrl,
    audience,
    resourceId,
    toolDefinitionVersion,
    authorization: {
      model: "app-rbac",
      defaultRole,
      ...(resourceTokenHeader ? { resourceTokenHeader } : {}),
      systemRoleInheritance,
      toolsEndpoint,
      toolsEndpointScope,
      roles,
    },
    tools,
  };
}

/**
 * Combines App-local roles with live App Center owner/collaborator roles.
 * System memberships are never persisted by the App; only the declarative
 * inheritance mapping belongs to the Manifest.
 */
export function resolveEffectiveAppRoles(
  manifest: WorkspaceAppMcpManifest,
  systemRoles: readonly string[] = [],
  localRoles: readonly string[] = [],
) {
  const effective = new Set(localRoles.map(normalizedRole).filter(Boolean));
  for (const systemRole of normalizedSystemRoles(systemRoles)) {
    for (const inheritedRole of manifest.authorization.systemRoleInheritance[systemRole]) {
      effective.add(inheritedRole);
    }
  }
  if (effective.size === 0) effective.add(manifest.authorization.defaultRole);
  return Array.from(effective);
}

export function toolsAllowedForRoles(manifest: WorkspaceAppMcpManifest, roles: string[]) {
  const activeRoles = new Set(roles);
  return manifest.tools.filter((tool) => tool.allowedRoles.some((role) => activeRoles.has(role)));
}

export function publicWorkspaceAppMcpTool(tool: WorkspaceAppMcpTool) {
  return {
    name: tool.name,
    description: tool.description,
    readOnly: tool.readOnly,
    riskLevel: tool.riskLevel,
    requiresConfirmation: tool.requiresConfirmation,
    inputSchema: tool.inputSchema,
  };
}

function parseTool(value: unknown, roleIds: Set<string>): WorkspaceAppMcpTool {
  const tool = object(value, "app_mcp_tool_invalid");
  const name = toolName(tool.name);
  const method = String(tool.method || "").toUpperCase();
  if (method !== "GET" && method !== "POST") fail("app_mcp_tool_method_invalid");
  const path = relativePath(tool.path, "app_mcp_tool_path_invalid");
  const allowedRoles = boundedArray(tool.allowedRoles, "app_mcp_tool_roles_invalid", 1, 100)
    .map((role) => identifier(role, "app_mcp_tool_role_invalid", 100));
  unique(allowedRoles, "app_mcp_tool_role_duplicate");
  if (allowedRoles.some((role) => !roleIds.has(role))) fail("app_mcp_tool_role_unknown");
  const requiredScopes = boundedArray(tool.requiredScopes ?? [], "app_mcp_tool_scopes_invalid", 0, 32)
    .map((scope) => scopeName(scope));
  unique(requiredScopes, "app_mcp_tool_scope_duplicate");
  const readOnly = tool.readOnly === true;
  const riskLevel = String(tool.riskLevel || "");
  if (!new Set(["low", "medium", "high", "critical"]).has(riskLevel)) fail("app_mcp_tool_risk_invalid");
  const requiresConfirmation = tool.requiresConfirmation === true;
  if (!readOnly && (riskLevel === "high" || riskLevel === "critical") && !requiresConfirmation) {
    fail("app_mcp_high_risk_confirmation_required");
  }
  const inputSchema = object(tool.inputSchema, "app_mcp_tool_schema_invalid");
  if (inputSchema.type !== "object") fail("app_mcp_tool_schema_object_required");

  return {
    name,
    description: boundedText(tool.description, "app_mcp_tool_description_invalid", 1_000),
    method,
    path,
    allowedRoles,
    requiredScopes,
    readOnly,
    riskLevel: riskLevel as WorkspaceAppMcpRiskLevel,
    requiresConfirmation,
    inputSchema,
  };
}

function parseSystemRoleInheritance(value: unknown, roleIds: Set<string>): WorkspaceAppSystemRoleInheritance {
  const defaults: WorkspaceAppSystemRoleInheritance = {
    app_owner: roleIds.has("owner") ? ["owner"] : [],
    app_collaborator: roleIds.has("admin") ? ["admin"] : [],
  };
  if (value === undefined || value === null) return defaults;
  const record = object(value, "app_mcp_system_role_inheritance_invalid");
  const unknown = Object.keys(record).find((key) => !WORKSPACE_APP_SYSTEM_ROLES.includes(key as WorkspaceAppSystemRole));
  if (unknown) fail("app_mcp_system_role_unknown");
  return Object.fromEntries(WORKSPACE_APP_SYSTEM_ROLES.map((systemRole) => {
    const inherited = record[systemRole] === undefined
      ? defaults[systemRole]
      : boundedArray(record[systemRole], "app_mcp_system_role_inheritance_invalid", 0, 100)
        .map((role) => identifier(role, "app_mcp_system_role_target_invalid", 100));
    unique(inherited, "app_mcp_system_role_target_duplicate");
    if (inherited.some((role) => !roleIds.has(role))) fail("app_mcp_system_role_target_unknown");
    return [systemRole, inherited];
  })) as WorkspaceAppSystemRoleInheritance;
}

function normalizedSystemRoles(value: readonly string[]) {
  return Array.from(new Set(value.map(normalizedRole)))
    .filter((role): role is WorkspaceAppSystemRole => WORKSPACE_APP_SYSTEM_ROLES.includes(role as WorkspaceAppSystemRole));
}

function normalizedRole(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function boundedArray(value: unknown, code: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(code);
  return value;
}

function boundedText(value: unknown, code: string, max: number) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) fail(code);
  return text;
}

function optionalText(value: unknown, code: string, max: number) {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedText(value, code, max);
}

function identifier(value: unknown, code: string, max: number) {
  const text = boundedText(value, code, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) fail(code);
  return text;
}

function toolName(value: unknown) {
  const text = boundedText(value, "app_mcp_tool_name_invalid", 96);
  if (!/^[a-z][a-z0-9_]*$/.test(text)) fail("app_mcp_tool_name_invalid");
  return text;
}

function scopeName(value: unknown) {
  const text = boundedText(value, "app_mcp_tool_scope_invalid", 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(text)) fail("app_mcp_tool_scope_invalid");
  return text;
}

function resourceTokenHeaderName(value: unknown): WorkspaceAppMcpResourceTokenHeader {
  const name = String(value || "").trim().toLowerCase();
  if (name !== "authorization" && name !== "x-workspace-resource-token") {
    fail("app_mcp_resource_token_header_invalid");
  }
  return name;
}

function relativePath(value: unknown, code: string) {
  const path = boundedText(value, code, 500);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("?") || path.includes("#")) fail(code);
  let decoded = path;
  for (let pass = 0; pass < 4; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      fail(code);
    }
  }
  if (decoded.split("/").some((segment) => segment === ".." || segment === ".")) fail(code);
  return path;
}

function httpsOrigin(value: unknown, code: string) {
  const text = boundedText(value, code, 500);
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail(code);
    return url.origin;
  } catch {
    fail(code);
  }
}

function normalizedOrigin(value: string) {
  return new URL(value).origin;
}

function unique(values: string[], code: string) {
  if (new Set(values).size !== values.length) fail(code);
}

function fail(code: string): never {
  throw new WorkspaceAppMcpManifestError(code);
}
