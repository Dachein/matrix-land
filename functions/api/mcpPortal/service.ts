import { configuredMcpOrigin } from "../../../src/shared/mcpResource.ts";
import type { PortalCatalog } from "../../../src/shared/types.ts";
import { directMcpInstallPrompt, type McpInstallAgent } from "../../../src/shared/mcpInstallPrompt.ts";
import { authWorkerBaseUrl, authWorkerUser } from "../authBoundary/service.ts";

type CurrentUser = PortalCatalog["currentUser"];

type McpPortalEnv = {
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  MCP_APPROVAL_TOKEN?: string;
  MCP_RESOURCE_URL?: string;
};

type McpPortalContext<TEnv extends McpPortalEnv> = EventContext<TEnv, string, unknown>;

type McpPortalDeps<TEnv extends McpPortalEnv> = {
  fetch?: typeof fetch;
  httpError(status: number, message: string): Error;
  json(body: unknown, init?: ResponseInit): Response;
  parseJson(value: string): unknown;
  requireAdminPortalUser(context: McpPortalContext<TEnv>): Promise<CurrentUser>;
  requireSecret(value: string | undefined, name: string): string;
  requireText(value: unknown, errorCode: string, maxLength: number): string;
  resolveCurrentUser(context: McpPortalContext<TEnv>): Promise<CurrentUser>;
};

export function createMcpPortalApi<TEnv extends McpPortalEnv>(deps: McpPortalDeps<TEnv>) {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));

  return {
    async readAdminConnections(context: McpPortalContext<TEnv>) {
      await deps.requireAdminPortalUser(context);
      const requestUrl = new URL(context.request.url);
      const status = normalizeAdminConnectionStatus(requestUrl.searchParams.get("status"));
      const search = new URLSearchParams({ status, limit: "1000" });
      const query = readOptionalString(requestUrl.searchParams.get("q"));
      if (query) {
        search.set("q", query.slice(0, 160));
      }

      const payload = await authWorkerAdminMcpJson(context.env, `/v1/admin/mcp/connections?${search.toString()}`, {
        errorCode: "admin_mcp_connections_failed",
        fetchImpl,
        method: "GET"
      }, deps);

      return deps.json(payload, { headers: { "cache-control": "no-store" } });
    },

    async disableAdminConnection(context: McpPortalContext<TEnv>, rawConnectionId: string) {
      const currentUser = await deps.requireAdminPortalUser(context);
      const connectionId = deps.requireText(decodeURIComponent(rawConnectionId), "missing_connection_id", 180);
      const payload = await authWorkerAdminMcpJson(context.env, `/v1/admin/mcp/connections/${encodeURIComponent(connectionId)}/disable`, {
        body: { actorUserId: currentUser.id },
        errorCode: "admin_mcp_connection_disable_failed",
        fetchImpl,
        method: "POST"
      }, deps);

      return deps.json(payload, { headers: { "cache-control": "no-store" } });
    },

    async readAdminLoginEmailPolicy(context: McpPortalContext<TEnv>) {
      await deps.requireAdminPortalUser(context);
      const payload = await authWorkerAdminMcpJson(context.env, "/v1/admin/login-email-policy", {
        errorCode: "admin_login_email_policy_load_failed",
        fetchImpl,
        method: "GET"
      }, deps);
      return deps.json(payload, { headers: { "cache-control": "no-store" } });
    },

    async updateAdminLoginEmailPolicy(context: McpPortalContext<TEnv>) {
      const currentUser = await deps.requireAdminPortalUser(context);
      const body = await context.request.json() as { allowedDomains?: unknown; mode?: unknown };
      const payload = await authWorkerAdminMcpJson(context.env, "/v1/admin/login-email-policy", {
        body: {
          allowedDomains: body.allowedDomains,
          mode: body.mode,
          updatedByUserId: currentUser.id
        },
        errorCode: "admin_login_email_policy_update_failed",
        fetchImpl,
        method: "POST"
      }, deps);
      return deps.json(payload, { headers: { "cache-control": "no-store" } });
    },

    async readConnectionStatus(context: McpPortalContext<TEnv>) {
      const currentUser = await deps.resolveCurrentUser(context);
      const payload = await authWorkerMcpJson(context.env, "/v1/mcp/connections/status", {
        body: {
          user: authWorkerUser(currentUser)
        },
        errorCode: "mcp_connection_status_failed",
        fetchImpl,
        method: "POST"
      }, deps);

      return deps.json(payload);
    },

    async revokeConnection(context: McpPortalContext<TEnv>, rawConnectionId: string) {
      const currentUser = await deps.resolveCurrentUser(context);
      const connectionId = deps.requireText(decodeURIComponent(rawConnectionId), "missing_connection_id", 180);
      const payload = await authWorkerMcpJson(context.env, "/v1/mcp/connections/revoke", {
        body: {
          connectionId,
          user: authWorkerUser(currentUser)
        },
        errorCode: "mcp_connection_revoke_failed",
        fetchImpl,
        method: "POST"
      }, deps);

      return deps.json(payload);
    },

    async readInstallConfig(context: McpPortalContext<TEnv>) {
      const resourceUrl = configuredMcpOrigin(context.env.MCP_RESOURCE_URL);
      if (!resourceUrl) throw deps.httpError(503, "mcp_resource_not_configured");

      try {
        const response = await fetchImpl(`${resourceUrl}/.well-known/workspace-mcp`);
        const responseText = await response.text();

        if (!response.ok) {
          throw new Error(`mcp_discovery_failed:${response.status}`);
        }

        const metadata = deps.parseJson(responseText) as Record<string, unknown>;
        return deps.json({
          agents: normalizeMcpInstallAgents(metadata, resourceUrl),
          llmsTxt: `${resourceUrl}/llms.txt`,
          resource: resourceUrl
        });
      } catch {
        return deps.json({
          agents: fallbackMcpInstallAgents(resourceUrl),
          llmsTxt: `${resourceUrl}/llms.txt`,
          resource: resourceUrl
        });
      }
    }
  };
}

async function authWorkerMcpJson<TEnv extends McpPortalEnv>(
  env: TEnv,
  path: string,
  init: {
    body?: unknown;
    errorCode: string;
    fetchImpl: typeof fetch;
    method?: string;
  },
  deps: McpPortalDeps<TEnv>
) {
  const token = deps.requireSecret(env.MCP_APPROVAL_TOKEN, "mcp_approval_token");
  const response = await init.fetchImpl(`${authWorkerBaseUrl(env, deps)}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw deps.httpError(response.status, `${init.errorCode}:${responseText.slice(0, 160)}`);
  }

  return deps.parseJson(responseText);
}

async function authWorkerAdminMcpJson<TEnv extends McpPortalEnv>(
  env: TEnv,
  path: string,
  init: {
    body?: unknown;
    errorCode: string;
    fetchImpl: typeof fetch;
    method: string;
  },
  deps: McpPortalDeps<TEnv>
) {
  const token = deps.requireSecret(env.AUTH_SERVICE_TOKEN, "auth_service_token");
  const response = await init.fetchImpl(`${authWorkerBaseUrl(env, deps)}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw deps.httpError(response.status, `${init.errorCode}:${responseText.slice(0, 160)}`);
  }

  return deps.parseJson(responseText);
}

function normalizeAdminConnectionStatus(value: unknown): "active" | "inactive" | "all" {
  return value === "inactive" || value === "all" ? value : "active";
}

function normalizeMcpInstallAgents(metadata: Record<string, unknown>, resourceUrl: string) {
  const configuredAgents = Array.isArray(metadata.agents)
    ? metadata.agents.map((agent) => normalizeMcpInstallAgent(agent, resourceUrl)).filter(Boolean)
    : [];
  if (configuredAgents.length > 0) {
    return configuredAgents;
  }

  const supportedAgents = Array.isArray(metadata.supportedAgents) ? metadata.supportedAgents : [];
  const normalized = supportedAgents
    .map((agent) => mcpInstallAgentFromId(readString(agent), resourceUrl))
    .filter(Boolean);

  return normalized.length > 0 ? normalized : fallbackMcpInstallAgents(resourceUrl);
}

function normalizeMcpInstallAgent(value: unknown, resourceUrl: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = normalizeMcpAgentId(record.id);
  if (!id) {
    return undefined;
  }
  const llmsTxt = mcpAgentLlmsTxt(id, readOptionalString(record.llmsTxt), resourceUrl);

  return {
    id,
    label: mcpAgentLabel(id),
    detail: mcpAgentDetail(id),
    installPrompt: directMcpInstallPrompt(id, "en", resourceUrl),
    llmsTxt
  };
}

function fallbackMcpInstallAgents(resourceUrl: string) {
  return ["workbuddy", "claude-code", "codex", "cursor"]
    .map((agent) => mcpInstallAgentFromId(agent, resourceUrl))
    .filter(Boolean);
}

function mcpInstallAgentFromId(value: string, resourceUrl: string) {
  const id = normalizeMcpAgentId(value);
  if (!id) {
    return undefined;
  }

  return {
    id,
    label: mcpAgentLabel(id),
    detail: mcpAgentDetail(id),
    installPrompt: directMcpInstallPrompt(id, "en", resourceUrl),
    llmsTxt: `${resourceUrl}/llms.txt?for=${id}`
  };
}

function normalizeMcpAgentId(value: unknown): McpInstallAgent | "" {
  const id = readString(value).trim().toLowerCase().replaceAll("_", "-");
  return id === "workbuddy" || id === "claude-code" || id === "codex" || id === "cursor" ? id : "";
}

function mcpAgentLlmsTxt(id: string, value: string | undefined, resourceUrl: string) {
  const fallback = `${resourceUrl}/llms.txt?for=${id}`;

  try {
    const url = new URL(value ?? fallback);
    if (url.origin !== resourceUrl || url.username || url.password) return fallback;
    url.searchParams.set("for", id);
    return url.toString();
  } catch {
    return fallback;
  }
}

function mcpAgentLabel(id: string) {
  if (id === "claude-code") {
    return "Claude Code";
  }

  if (id === "workbuddy") {
    return "WorkBuddy";
  }

  if (id === "cursor") {
    return "Cursor";
  }

  return "Codex";
}

function mcpAgentDetail(id: string) {
  if (id === "claude-code") {
    return "把安装提示词贴给 Claude Code。Workspace CLI 会一次完成 OAuth 并写入用户级 stdio MCP 连接。";
  }

  if (id === "workbuddy") {
    return "把安装提示词贴给 WorkBuddy。Workspace CLI 会一次完成 OAuth、写入 stdio MCP 连接并自动刷新凭据。";
  }

  if (id === "cursor") {
    return "把安装提示词贴给 Cursor。Workspace CLI 会一次完成 OAuth 并安全合并用户级 mcp.json。";
  }

  return "把安装提示词贴给 Codex。Workspace CLI 会一次完成 OAuth 并写入 stdio MCP 连接。";
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}
