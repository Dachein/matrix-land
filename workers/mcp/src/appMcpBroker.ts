import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import { signJwt } from "./auth.ts";
import { authWorkerUrl, readString } from "./http.ts";
import { HttpError, type Env, type Principal } from "./types.ts";
import {
  parseWorkspaceAppMcpManifest,
  publicWorkspaceAppMcpTool,
  type WorkspaceAppMcpManifest,
  type WorkspaceAppMcpTool,
} from "../../../src/shared/appMcpManifest.ts";

type FetchLike = typeof fetch;

export async function listAccessibleAppMcpResources(env: Env, principal: Principal, fetchImpl: FetchLike = fetch) {
  return appsJson(env, principal, "/mcp-apps", fetchImpl);
}

export async function listAppMcpTools(appId: string, env: Env, principal: Principal, fetchImpl: FetchLike = fetch) {
  const registered = await registeredApp(appId, env, principal, fetchImpl);
  const token = await mintResourceToken(
    registered.manifest,
    [registered.manifest.authorization.toolsEndpointScope],
    undefined,
    env,
    principal,
    fetchImpl,
  );
  const effective = await fetchAppTools(registered.manifest, token, fetchImpl);
  const allowedNames = new Set(effective.tools.map((tool) => readString(tool.name)));
  return {
    appId: registered.manifest.appId,
    policyVersion: effective.policyVersion,
    toolDefinitionVersion: registered.manifest.toolDefinitionVersion,
    manifestSha256: registered.manifestSha256,
    tools: registered.manifest.tools.filter((tool) => allowedNames.has(tool.name)).map(publicWorkspaceAppMcpTool),
  };
}

export async function callAppMcpTool(input: {
  appId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  confirmation?: boolean;
}, env: Env, principal: Principal, fetchImpl: FetchLike = fetch) {
  const registered = await registeredApp(input.appId, env, principal, fetchImpl);
  const tool = registered.manifest.tools.find((candidate) => candidate.name === input.toolName);
  if (!tool) throw new HttpError(404, "app_mcp_tool_not_registered");
  validateInput(input.arguments, tool.inputSchema);
  if (tool.requiresConfirmation && input.confirmation !== true) throw new HttpError(409, "tool_confirmation_required");

  const discoveryToken = await mintResourceToken(
    registered.manifest,
    [registered.manifest.authorization.toolsEndpointScope],
    undefined,
    env,
    principal,
    fetchImpl,
  );
  const effective = await fetchAppTools(registered.manifest, discoveryToken, fetchImpl);
  if (!effective.tools.some((candidate) => readString(candidate.name) === tool.name)) {
    throw new HttpError(403, "app_mcp_tool_role_required");
  }

  const token = await mintResourceToken(registered.manifest, tool.requiredScopes, tool.name, env, principal, fetchImpl);
  return callRegisteredTool(registered.manifest, tool, input.arguments, token, fetchImpl);
}

async function registeredApp(appId: string, env: Env, principal: Principal, fetchImpl: FetchLike) {
  if (!appId.trim()) throw new HttpError(400, "missing_app_id");
  const payload = await appsJson(env, principal, `/mcp-apps/${encodeURIComponent(appId)}`, fetchImpl) as Record<string, unknown>;
  let manifest: WorkspaceAppMcpManifest;
  try {
    manifest = parseWorkspaceAppMcpManifest(payload.manifest, { appId });
  } catch {
    throw new HttpError(502, "app_mcp_manifest_snapshot_invalid");
  }
  return { manifest, manifestSha256: readString(payload.manifestSha256) };
}

async function fetchAppTools(manifest: WorkspaceAppMcpManifest, token: string, fetchImpl: FetchLike) {
  const url = registeredUrl(manifest, manifest.authorization.toolsEndpoint);
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", ...resourceTokenHeaders(manifest, token) },
  });
  const text = await response.text();
  if (!response.ok) throw resourceError(response.status, "app_mcp_tools_query_failed", text);
  const payload = parseJson(text);
  const tools = Array.isArray(payload.tools) ? payload.tools.filter(isRecord) : [];
  return { tools, policyVersion: payload.policyVersion };
}

async function callRegisteredTool(
  manifest: WorkspaceAppMcpManifest,
  tool: WorkspaceAppMcpTool,
  args: Record<string, unknown>,
  token: string,
  fetchImpl: FetchLike,
) {
  const url = new URL(registeredUrl(manifest, tool.path));
  if (tool.method === "GET") {
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  const response = await fetchImpl(url.toString(), {
    method: tool.method,
    headers: {
      Accept: "application/json",
      ...resourceTokenHeaders(manifest, token),
      "Content-Type": "application/json",
    },
    body: tool.method === "GET" ? undefined : JSON.stringify(args),
  });
  const text = await response.text();
  if (!response.ok) throw resourceError(response.status, "app_mcp_tool_call_failed", text);
  return redactToken(text.trim() ? parseJson(text) : {}, token);
}

async function mintResourceToken(
  manifest: WorkspaceAppMcpManifest,
  scopes: string[],
  toolName: string | undefined,
  env: Env,
  principal: Principal,
  fetchImpl: FetchLike,
) {
  const serviceToken = env.MCP_INTROSPECTION_TOKEN?.trim() || env.AUTH_SERVICE_TOKEN?.trim();
  if (!serviceToken) throw new HttpError(503, "resource_mint_token_not_configured");
  const response = await fetchImpl(`${authWorkerUrl(env)}/v1/resource-tokens/mint`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      resourceId: manifest.resourceId,
      audience: manifest.audience,
      mcpBrokered: true,
      scopes,
      toolName,
      clientId: principal.clientId ?? "workspace-ai-mcp",
      connectionId: principal.connectionId,
      principal: {
        sub: principal.sub,
        email: principal.email,
        name: principal.name,
        role: principal.role,
        orgId: principal.orgId,
        department: principal.department,
        departmentId: principal.departmentId,
        departmentPath: principal.departmentPath,
        team: principal.team,
        teamId: principal.teamId,
        teamPath: principal.teamPath,
      },
    }),
  });
  const text = await response.text();
  if (!response.ok) throw resourceError(response.status, "resource_token_mint_failed", text);
  const token = readString(parseJson(text).access_token).trim();
  if (!token) throw new HttpError(502, "resource_token_missing");
  return token;
}

async function appsJson(env: Env, principal: Principal, path: string, fetchImpl: FetchLike) {
  const secret = env.WORKSPACE_MCP_JWT_SECRET ?? env.APPS_JWT_SECRET;
  if (!secret) throw new HttpError(503, "apps_jwt_secret_not_configured");
  const token = await signJwt({
    typ: "mcp_access",
    iss: env.AUTH_ISSUER ?? missingConfiguration("AUTH_ISSUER"),
    sub: principal.sub,
    org_id: env.APPS_ORG_ID ?? principal.orgId ?? missingConfiguration("WORKSPACE_ORG_ID"),
    org_slug: env.APPS_ORG_SLUG ?? "workspace",
    email: principal.email,
    name: principal.name,
    department_id: principal.departmentId,
    department_path: principal.departmentPath ?? [],
    scopes: ["apps:apps:read"],
    exp: Math.floor(Date.now() / 1000) + 300,
  }, secret);
  const baseUrl = (env.APPS_WORKER_URL?.trim() || missingConfiguration("APPS_WORKER_URL")).replace(/\/+$/, "");
  const response = await fetchImpl(`${baseUrl}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(response.status === 401 || response.status === 403 ? 502 : response.status, "apps_worker_request_failed", text.slice(0, 240));
  return parseJson(text);
}

function registeredUrl(manifest: WorkspaceAppMcpManifest, path: string) {
  const base = new URL(manifest.baseUrl);
  const url = new URL(path, `${base.origin}/`);
  if (url.origin !== base.origin) throw new HttpError(502, "app_mcp_tool_url_invalid");
  return url.toString();
}

function resourceTokenHeaders(manifest: WorkspaceAppMcpManifest, token: string): Record<string, string> {
  return manifest.authorization.resourceTokenHeader === "x-workspace-resource-token"
    ? { "X-Workspace-Resource-Token": token }
    : { Authorization: `Bearer ${token}` };
}

function validateInput(value: Record<string, unknown>, schema: Record<string, unknown>) {
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const key of required) if (!Object.hasOwn(value, key)) throw new HttpError(400, "app_mcp_tool_argument_required", key);
  if (schema.additionalProperties === false) {
    const extra = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
    if (extra) throw new HttpError(400, "app_mcp_tool_argument_unknown", extra);
  }
  for (const [key, candidate] of Object.entries(value)) {
    const property = isRecord(properties[key]) ? properties[key] as Record<string, unknown> : undefined;
    if (!property) continue;
    const allowedTypes = Array.isArray(property.type) ? property.type.map(String) : [readString(property.type)].filter(Boolean);
    if (allowedTypes.length > 0 && !allowedTypes.some((type) => matchesType(candidate, type))) {
      throw new HttpError(400, "app_mcp_tool_argument_type_invalid", key);
    }
    if (Array.isArray(property.enum) && !property.enum.some((item) => Object.is(item, candidate))) {
      throw new HttpError(400, "app_mcp_tool_argument_enum_invalid", key);
    }
    if (typeof candidate === "string") {
      if (typeof property.maxLength === "number" && candidate.length > property.maxLength) throw new HttpError(400, "app_mcp_tool_argument_too_long", key);
      if (typeof property.pattern === "string" && !new RegExp(property.pattern).test(candidate)) throw new HttpError(400, "app_mcp_tool_argument_pattern_invalid", key);
    }
    if (typeof candidate === "number") {
      if (typeof property.minimum === "number" && candidate < property.minimum) throw new HttpError(400, "app_mcp_tool_argument_too_small", key);
      if (typeof property.maximum === "number" && candidate > property.maximum) throw new HttpError(400, "app_mcp_tool_argument_too_large", key);
    }
  }
}

function matchesType(value: unknown, type: string) {
  if (type === "null") return value === null;
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  return typeof value === type;
}

function resourceError(status: number, code: string, text: string) {
  return new HttpError(status === 401 || status === 403 ? 403 : status >= 400 && status < 500 ? status : 502, code, text.slice(0, 240));
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value)) throw new Error("not_object");
    return value;
  } catch {
    throw new HttpError(502, "upstream_invalid_json");
  }
}

function redactToken(value: unknown, token: string): unknown {
  if (typeof value === "string") return value.replaceAll(token, "[redacted]");
  if (Array.isArray(value)) return value.map((item) => redactToken(item, token));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactToken(item, token)]));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
