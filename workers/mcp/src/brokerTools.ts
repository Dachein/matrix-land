import { authWorkerUrl, readString } from "./http.ts";
import { filterHubListingsForPrincipal } from "./hubAccess.ts";
import { HttpError, type Env, type Principal } from "./types.ts";

type FetchLike = typeof fetch;

type BrokerToolRow = {
  configJson: string;
  listingId: string;
  listingName: string;
  targetId: string;
  targetPlane: string;
  type: string;
  visibility: string;
};

type BrokerToolMethod = "GET" | "POST";

type BrokerToolDefinition = {
  audience: string;
  baseUrl: string;
  description: string;
  inputSchema: Record<string, unknown>;
  listingId: string;
  listingName: string;
  method: BrokerToolMethod;
  name: string;
  path: string;
  requiresConfirmation: boolean;
  resourceId: string;
  scopes: string[];
};

export type BrokerToolCallResult =
  | { handled: false }
  | { handled: true; result: unknown };

const CONFIRMATION_ARG_KEYS = new Set(["confirm", "confirmation"]);
const MAX_PATH_DECODE_PASSES = 4;
const REDACTED_TOKEN = "[redacted]";
const UNSAFE_HOSTNAMES = new Set(["0.0.0.0", "localhost", "localhost.", "metadata.google.internal"]);
const RESERVED_KNOWLEDGE_TOOL_PREFIX = "knowledge_";

export async function listBrokerTools(env: Env, principal: Principal, deps: { fetch?: FetchLike } = {}) {
  const definitions = await listBrokerToolDefinitions(env, principal, deps.fetch);
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema
  }));
}

export async function callBrokerTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  principal: Principal,
  deps: { fetch?: FetchLike } = {}
): Promise<BrokerToolCallResult> {
  const definition = (await listBrokerToolDefinitions(env, principal, deps.fetch)).find((tool) => tool.name === name);
  if (!definition) {
    return { handled: false };
  }

  return { handled: true, result: await callBrokerDefinition(definition, args, env, principal, deps.fetch) };
}

export async function listAccessibleBrokerResources(
  env: Env,
  principal: Principal,
  deps: { fetch?: FetchLike } = {}
) {
  const definitions = await listBrokerToolDefinitions(env, principal, deps.fetch);
  const resources = new Map<string, {
    listingId: string;
    listingName: string;
    resourceId: string;
    toolCount: number;
  }>();
  for (const definition of definitions) {
    const current = resources.get(definition.listingId);
    resources.set(definition.listingId, {
      listingId: definition.listingId,
      listingName: definition.listingName,
      resourceId: definition.resourceId,
      toolCount: (current?.toolCount ?? 0) + 1
    });
  }
  return { resources: [...resources.values()] };
}

export async function listBrokerResourceTools(
  listingId: string,
  env: Env,
  principal: Principal,
  deps: { fetch?: FetchLike } = {}
) {
  const tools = (await listBrokerToolDefinitions(env, principal, deps.fetch))
    .filter((definition) => definition.listingId === listingId)
    .map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      requiresConfirmation: definition.requiresConfirmation
    }));
  if (tools.length === 0) throw new HttpError(404, "publication_connector_not_found");
  return { listingId, tools };
}

export async function callBrokerResourceTool(
  listingId: string,
  toolName: string,
  args: Record<string, unknown>,
  env: Env,
  principal: Principal,
  deps: { fetch?: FetchLike } = {}
) {
  const definition = (await listBrokerToolDefinitions(env, principal, deps.fetch))
    .find((tool) => tool.listingId === listingId && tool.name === toolName);
  if (!definition) throw new HttpError(404, "publication_connector_tool_not_found");
  return await callBrokerDefinition(definition, args, env, principal, deps.fetch);
}

async function callBrokerDefinition(
  definition: BrokerToolDefinition,
  args: Record<string, unknown>,
  env: Env,
  principal: Principal,
  fetchImpl?: FetchLike
) {

  if (definition.requiresConfirmation && !hasToolConfirmation(args)) {
    throw new HttpError(409, "tool_confirmation_required");
  }

  const outboundArgs = stripConfirmationArgs(args);
  const accessToken = await mintResourceToken(definition, env, principal, fetchImpl);
  return await callResourceApi(definition, outboundArgs, accessToken, principal, fetchImpl);
}

async function listBrokerToolDefinitions(env: Env, principal: Principal, fetchImpl?: FetchLike): Promise<BrokerToolDefinition[]> {
  const rows = await env.DB
    .prepare(
      `
      SELECT
        publication_listings.id AS listingId,
        publication_listings.name AS listingName,
        publication_listings.listing_type AS type,
        publication_listings.target_plane AS targetPlane,
        publication_listings.target_id AS targetId,
        publication_listings.visibility,
        publication_versions.config_json AS configJson
      FROM publication_listings
      JOIN publication_versions ON publication_versions.id = publication_listings.listed_version_id
      WHERE publication_listings.effective_status = 'listed'
        AND publication_listings.listing_type = 'skill'
        AND publication_versions.config_json != '{}'
      ORDER BY publication_listings.updated_at DESC
      LIMIT 100
      `
    )
    .all<BrokerToolRow>();

  const accessibleRows = await filterHubListingsForPrincipal(rows.results ?? [], env, principal, { fetch: fetchImpl });
  return accessibleRows.flatMap(toBrokerToolDefinitions);
}

function toBrokerToolDefinitions(row: BrokerToolRow): BrokerToolDefinition[] {
  const config = readJsonObject(row.configJson);
  const resourceApi = readObject(config.resourceApi ?? config.resource_api ?? config.mcpBroker ?? config.mcp_broker);
  const baseUrl = normalizeBaseUrl(resourceApi.baseUrl ?? resourceApi.base_url ?? resourceApi.resourceUrl ?? resourceApi.resource_url);
  const resourceId = readOptionalString(resourceApi.resourceId ?? resourceApi.resource_id ?? resourceApi.id) ?? row.listingId;
  const audience = readOptionalString(resourceApi.audience) ?? baseUrl ?? resourceId;
  const sourceTools = readArray(resourceApi.tools ?? config.tools);

  if (!baseUrl || sourceTools.length === 0) {
    return [];
  }

  return sourceTools
    .map((tool) => readObject(tool))
    .map((tool) => {
      const name = normalizeToolName(tool.name);
      const method = normalizeMethod(tool.method);
      const path = normalizePath(tool.path ?? tool.endpoint);
      // The platform-owned Knowledge namespace must remain the fixed 15-tool
      // contract. Publication resource APIs cannot shadow or extend it.
      if (!name || name.startsWith(RESERVED_KNOWLEDGE_TOOL_PREFIX) || !method || !path) {
        return undefined;
      }

      return {
        audience,
        baseUrl,
        description: readOptionalString(tool.description) ?? `Call ${row.listingName}.`,
        inputSchema: readObject(tool.inputSchema ?? tool.input_schema) || { type: "object", properties: {} },
        listingId: row.listingId,
        listingName: row.listingName,
        method,
        name,
        path,
        requiresConfirmation: toolRequiresConfirmation(tool),
        resourceId,
        scopes: readStringList(tool.scopes ?? tool.requiredScopes ?? tool.required_scopes)
      } satisfies BrokerToolDefinition;
    })
    .filter(Boolean) as BrokerToolDefinition[];
}

async function mintResourceToken(
  definition: BrokerToolDefinition,
  env: Env,
  principal: Principal,
  fetchImpl: FetchLike = fetch
) {
  // Broker auth binds downstream minting to the still-active MCP connection.
  // Keep the service credential only as a rollout fallback.
  const token = env.MCP_INTROSPECTION_TOKEN?.trim() || env.AUTH_SERVICE_TOKEN?.trim();
  if (!token) {
    throw new HttpError(503, "resource_mint_token_not_configured");
  }

  const response = await fetchImpl(`${authWorkerUrl(env)}/v1/resource-tokens/mint`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      resourceId: definition.resourceId,
      audience: definition.audience,
      mcpBrokered: true,
      scopes: definition.scopes,
      toolName: definition.name,
      clientId: principal.clientId ?? "workspace-ai-mcp",
      connectionId: principal.connectionId,
      principal: {
        sub: principal.sub,
        email: principal.email,
        name: principal.name,
        role: principal.role,
        team: principal.team,
        teamId: principal.teamId,
        teamPath: principal.teamPath,
        department: principal.department,
        departmentId: principal.departmentId,
        departmentPath: principal.departmentPath,
        orgId: principal.orgId
      }
    })
  });
  const text = await response.text();

  if (!response.ok) {
    throw new HttpError(response.status, "resource_token_mint_failed", text.slice(0, 240));
  }

  const payload = parseJson(text);
  const accessToken = readOptionalString(payload.access_token);
  if (!accessToken) {
    throw new HttpError(502, "resource_token_missing");
  }
  return accessToken;
}

async function callResourceApi(
  definition: BrokerToolDefinition,
  args: Record<string, unknown>,
  accessToken: string,
  principal: Principal,
  fetchImpl: FetchLike = fetch
) {
  const url = resourceRequestUrl(definition, args);
  const isGet = definition.method === "GET";
  const response = await fetchImpl(url, {
    method: definition.method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "x-workspace-mcp-connection-id": principal.connectionId ?? "",
      "x-workspace-user-id": principal.sub
    },
    body: isGet ? undefined : JSON.stringify(args)
  });
  const text = await response.text();

  if (!response.ok) {
    throw new HttpError(response.status === 401 || response.status === 403 ? 403 : 502, "resource_api_request_failed", text.slice(0, 240));
  }

  const payload = text.trim() ? parseJson(text) : {};
  return redactAccessToken(payload, accessToken);
}

function resourceRequestUrl(definition: BrokerToolDefinition, args: Record<string, unknown>) {
  const base = parseBaseUrl(definition.baseUrl);
  const path = normalizePath(definition.path);
  if (!base || !path) {
    throw new HttpError(502, "invalid_resource_tool_url");
  }

  const url = new URL(base.toString());
  url.pathname = joinUrlPath(base.pathname, path);
  url.search = "";
  url.hash = "";

  if (url.origin !== base.origin || !isPathUnderBasePath(url.pathname, base.pathname)) {
    throw new HttpError(502, "resource_tool_url_outside_base");
  }

  if (definition.method === "GET") {
    Object.entries(args).forEach(([key, value]) => {
      if (!CONFIRMATION_ARG_KEYS.has(key) && isSerializableGetPrimitive(value)) {
        url.searchParams.set(key, readString(value));
      }
    });
  }
  return url.toString();
}

function normalizeToolName(value: unknown) {
  const name = readString(value).trim();
  return /^[a-zA-Z][a-zA-Z0-9_]{1,96}$/.test(name) ? name : undefined;
}

function normalizeMethod(value: unknown): BrokerToolMethod | undefined {
  const method = readOptionalString(value)?.toUpperCase();
  if (!method) {
    return "POST";
  }
  return method === "GET" || method === "POST" ? method : undefined;
}

function normalizePath(value: unknown) {
  const path = readOptionalString(value);
  if (!path || hasUnsafePathSyntax(path)) {
    return undefined;
  }

  const relativePath = path.replace(/^\/+/, "");
  if (!relativePath || hasUnsafeDecodedPathContent(relativePath)) {
    return undefined;
  }
  return relativePath;
}

function normalizeBaseUrl(value: unknown) {
  const url = parseBaseUrl(value);
  return url?.toString();
}

function parseBaseUrl(value: unknown) {
  const text = readOptionalString(value);
  if (!text || hasControlCharacter(text)) {
    return undefined;
  }

  try {
    const url = new URL(text);
    if (
      url.protocol !== "https:" ||
      Boolean(url.username || url.password) ||
      Boolean(url.search || url.hash) ||
      isUnsafeResourceHost(url.hostname)
    ) {
      return undefined;
    }
    url.pathname = normalizeBasePath(url.pathname);
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

function normalizeBasePath(pathname: string) {
  const withoutTrailingSlashes = pathname.replace(/\/+$/, "");
  return withoutTrailingSlashes || "/";
}

function joinUrlPath(basePath: string, relativePath: string) {
  const normalizedBasePath = normalizeBasePath(basePath);
  return normalizedBasePath === "/" ? `/${relativePath}` : `${normalizedBasePath}/${relativePath}`;
}

function isPathUnderBasePath(pathname: string, basePath: string) {
  const normalizedBasePath = normalizeBasePath(basePath);
  return normalizedBasePath === "/" || pathname === normalizedBasePath || pathname.startsWith(`${normalizedBasePath}/`);
}

function toolRequiresConfirmation(tool: Record<string, unknown>) {
  const readOnly = readOptionalBoolean(tool.readOnly ?? tool.read_only);
  const requiresConfirmation = readOptionalBoolean(tool.requiresConfirmation ?? tool.requires_confirmation);
  const riskLevel = readOptionalString(tool.riskLevel ?? tool.risk_level)?.toLowerCase();
  return readOnly === false || requiresConfirmation === true || riskLevel === "high" || riskLevel === "critical";
}

function hasToolConfirmation(args: Record<string, unknown>) {
  return args.confirm === true || args.confirmation === true;
}

function stripConfirmationArgs(args: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => !CONFIRMATION_ARG_KEYS.has(key))
  );
}

function isSerializableGetPrimitive(value: unknown) {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function hasControlCharacter(value: string) {
  return /[\u0000-\u001F\u007F]/.test(value);
}

function hasUnsafePathSyntax(value: string) {
  return (
    hasControlCharacter(value) ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("..") ||
    value.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  );
}

function hasUnsafeDecodedPathContent(value: string) {
  let decoded = value;
  for (let index = 0; index < MAX_PATH_DECODE_PASSES; index += 1) {
    if (decoded.startsWith("/") || hasUnsafePathSyntax(decoded)) {
      return true;
    }
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        return false;
      }
      decoded = next;
    } catch {
      return true;
    }
  }
  return true;
}

function readOptionalBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true") {
      return true;
    }
    if (text === "false") {
      return false;
    }
  }
  return undefined;
}

function isUnsafeResourceHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (UNSAFE_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }

  const ipv4 = parseIpv4(host);
  if (ipv4) {
    const [a, b] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  return host.includes(":") && (
    host === "::1" ||
    host === "::" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:")
  );
}

function parseIpv4(hostname: string): [number, number, number, number] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet, index) => !Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== parts[index])) {
    return undefined;
  }
  return octets as [number, number, number, number];
}

function redactAccessToken(value: unknown, accessToken: string): unknown {
  if (!accessToken) {
    return value;
  }
  if (typeof value === "string") {
    return value.includes(accessToken) ? value.split(accessToken).join(REDACTED_TOKEN) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactAccessToken(item, accessToken));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactAccessToken(item, accessToken)])
    );
  }
  return value;
}

function readJsonObject(value: unknown) {
  try {
    return readObject(JSON.parse(readString(value)));
  } catch {
    return {};
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

function readStringList(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => readString(item).trim()).filter(Boolean)
    : [];
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new HttpError(502, "invalid_json_response");
  }
}
