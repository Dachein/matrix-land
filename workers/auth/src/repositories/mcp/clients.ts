import { canonicalMcpResource } from "../../../../../src/shared/mcpResource.ts";
import { platformBrandFromEnv } from "../../../../../src/shared/platformBrand.ts";
import { type Env, HttpError, type McpAgentType, type McpClient } from "../../types.ts";
import { jsonStringList, optionalText, requireDb, requiredText, stringList } from "../values.ts";
import { DEFAULT_MCP_CLIENT_ID, SUPPORTED_MCP_AGENTS, SUPPORTED_MCP_SCOPES } from "./constants.ts";

// MCP registered clients and supported scope normalization.
type McpClientRow = {
  allowed_scopes_json: string;
  id: string;
  name: string;
  resource_url: string;
  status: string;
  supported_agents_json: string;
};

type McpOAuthClientRow = {
  agent_type: string;
  client_id: string;
  client_name: string;
  redirect_uris_json: string;
};

export async function ensureMcpClient(env: Env, input: Partial<McpClient> = {}) {
  const db = requireDb(env);
  const resourceUrl = canonicalMcpResource(input.resourceUrl, env.MCP_RESOURCE_URL);
  if (!resourceUrl) throw new HttpError(503, "mcp_resource_not_configured_or_invalid");
  const client: McpClient = {
    id: optionalText(input.id, 160) ?? DEFAULT_MCP_CLIENT_ID,
    name: optionalText(input.name, 240) ?? `${platformBrandFromEnv(env).name} MCP`,
    status: input.status === "disabled" ? "disabled" : "active",
    resourceUrl,
    allowedScopes: sanitizeScopes(input.allowedScopes ?? SUPPORTED_MCP_SCOPES, SUPPORTED_MCP_SCOPES),
    supportedAgents: sanitizeAgents(input.supportedAgents ?? SUPPORTED_MCP_AGENTS)
  };

  await db
    .prepare(
      `
      INSERT INTO auth_mcp_clients (
        id,
        name,
        status,
        resource_url,
        allowed_scopes_json,
        supported_agents_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        status = excluded.status,
        resource_url = excluded.resource_url,
        allowed_scopes_json = excluded.allowed_scopes_json,
        supported_agents_json = excluded.supported_agents_json,
        updated_at = CURRENT_TIMESTAMP
      `
    )
    .bind(
      client.id,
      client.name ?? "",
      client.status ?? "active",
      client.resourceUrl ?? "",
      JSON.stringify(client.allowedScopes ?? []),
      JSON.stringify(client.supportedAgents ?? [])
    )
    .run();

  return client;
}

export async function readMcpClient(env: Env, clientId = DEFAULT_MCP_CLIENT_ID) {
  const db = requireDb(env);
  const row = await db
    .prepare(
      `
      SELECT id, name, status, resource_url, allowed_scopes_json, supported_agents_json
      FROM auth_mcp_clients
      WHERE id = ?
      LIMIT 1
      `
    )
    .bind(clientId)
    .first<McpClientRow>();

  return row ? mcpClientFromRow(row) : undefined;
}

export async function registerMcpOAuthClient(env: Env, input: {
  agentType?: McpAgentType;
  clientName?: string;
  redirectUris: string[];
}) {
  const clientId = `mcp-oauth-${crypto.randomUUID()}`;
  const redirectUris = Array.from(new Set(input.redirectUris)).slice(0, 12);
  const agentType = normalizeAgentType(input.agentType) ?? "codex";
  const clientName = optionalText(input.clientName, 160) ?? "Workspace MCP client";
  await requireDb(env)
    .prepare(
      `
      INSERT INTO auth_mcp_oauth_clients (
        client_id, client_name, redirect_uris_json, agent_type, created_at, updated_at
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `
    )
    .bind(clientId, clientName, JSON.stringify(redirectUris), agentType)
    .run();
  return { agentType, clientId, clientName, redirectUris };
}

export async function ensureMcpOAuthClient(env: Env, input: {
  agentType: McpAgentType;
  clientId: string;
  clientName: string;
}) {
  const clientId = requiredText(input.clientId, "invalid_client", 200);
  const clientName = requiredText(input.clientName, "invalid_client", 160);
  const agentType = normalizeAgentType(input.agentType);
  if (!agentType) {
    throw new HttpError(400, "invalid_client");
  }
  await requireDb(env)
    .prepare(
      `
      INSERT INTO auth_mcp_oauth_clients (
        client_id, client_name, redirect_uris_json, agent_type, created_at, updated_at
      ) VALUES (?, ?, '[]', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(client_id) DO UPDATE SET
        client_name = excluded.client_name,
        agent_type = excluded.agent_type,
        updated_at = CURRENT_TIMESTAMP
      `
    )
    .bind(clientId, clientName, agentType)
    .run();
  return { agentType, clientId, clientName, redirectUris: [] as string[] };
}

export async function readMcpOAuthClient(env: Env, clientId: string) {
  const row = await requireDb(env)
    .prepare("SELECT agent_type, client_id, client_name, redirect_uris_json FROM auth_mcp_oauth_clients WHERE client_id = ? LIMIT 1")
    .bind(requiredText(clientId, "invalid_client", 200))
    .first<McpOAuthClientRow>();
  return row ? {
    agentType: normalizeAgentType(row.agent_type) ?? "codex",
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: jsonStringList(row.redirect_uris_json)
  } : undefined;
}

function mcpClientFromRow(row: McpClientRow): McpClient {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    resourceUrl: row.resource_url,
    allowedScopes: jsonStringList(row.allowed_scopes_json),
    supportedAgents: sanitizeAgents(jsonStringList(row.supported_agents_json))
  };
}

export function normalizeAgentType(value: unknown): McpAgentType | undefined {
  const agent = optionalText(value, 80)?.toLowerCase().replaceAll("_", "-");
  return agent === "claude-code" || agent === "codex" || agent === "cursor" || agent === "workbuddy" ? agent : undefined;
}

function sanitizeAgents(value: unknown): McpAgentType[] {
  const agents = stringList(value, 8, 80)
    .map((agent) => normalizeAgentType(agent))
    .filter(Boolean) as McpAgentType[];
  return agents.length > 0 ? Array.from(new Set(agents)) : SUPPORTED_MCP_AGENTS;
}

export function sanitizeScopes(value: unknown, allowedScopes: string[]) {
  const requested = stringList(value, 32, 120);
  if (requested.length === 0) {
    return allowedScopes;
  }

  const allowed = new Set(allowedScopes);
  const invalid = requested.filter((scope) => !allowed.has(scope));
  if (invalid.length > 0) {
    throw new HttpError(400, "invalid_mcp_scope");
  }

  return Array.from(new Set(requested));
}
