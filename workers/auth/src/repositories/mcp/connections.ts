import {
  type AdminMcpConnection,
  type AdminMcpConnectionList,
  type Env,
  type WorkspaceUser,
  HttpError,
  type McpAgentType,
  type McpConnection,
  type McpConnectionStatus
} from "../../types.ts";
import { jsonStringList, normalizeEmail, optionalText, readNumber, readReturnedIds, requireDb, requiredText } from "../values.ts";
import { ensureMcpClient, normalizeAgentType, readMcpClient, sanitizeScopes } from "./clients.ts";
import {
  DEFAULT_MCP_CLIENT_ID,
  DEFAULT_MCP_IDLE_TTL_SECONDS,
  DEFAULT_MCP_SCOPES,
  MAX_ACTIVE_MCP_CONNECTIONS,
  SUPPORTED_MCP_AGENTS
} from "./constants.ts";

// Own MCP connection lifecycle and expiration of its credentials.
type McpConnectionRow = {
  agent_type: string;
  client_id: string;
  created_at: string;
  display_name: string;
  id: string;
  idle_expires_at: string | null;
  last_seen_at: string | null;
  resource_url: string;
  scopes_json: string;
  status: "active" | "revoked";
  revoked_reason: string | null;
  updated_at: string;
  user_id: string;
};

type AdminMcpConnectionRow = McpConnectionRow & {
  last_active_at: string;
  user_department: string | null;
  user_email: string | null;
  user_name: string | null;
  user_team: string | null;
};

type ListAdminMcpConnectionsInput = {
  limit?: number;
  q?: string;
  status?: "active" | "inactive" | "all";
};

export async function createMcpOAuthConnection(env: Env, input: {
  agentType: McpAgentType;
  displayName?: string;
  resourceUrl: string;
  scopes: string[];
  user: WorkspaceUser;
}) {
  const db = requireDb(env);
  const client = await readMcpClient(env, DEFAULT_MCP_CLIENT_ID)
    ?? await ensureMcpClient(env, { id: DEFAULT_MCP_CLIENT_ID });
  if (client.status !== "active") {
    throw new HttpError(403, "mcp_client_disabled");
  }

  const agentType = normalizeAgentType(input.agentType);
  if (!agentType || !(client.supportedAgents ?? SUPPORTED_MCP_AGENTS).includes(agentType)) {
    throw new HttpError(400, "unsupported_mcp_agent");
  }

  const userId = requiredText(input.user.id || input.user.email, "missing_user_id", 160);
  const connectionId = `mcp-conn-${crypto.randomUUID()}`;
  const scopes = sanitizeScopes(input.scopes, client.allowedScopes ?? DEFAULT_MCP_SCOPES);
  await expireIdleMcpConnections(env, userId);
  const activeConnectionsToKeepBeforeInsert = MAX_ACTIVE_MCP_CONNECTIONS - 1;
  const batchResults = await db.batch([
    db
      .prepare(
        `
        UPDATE auth_mcp_connections
        SET status = 'revoked',
            revoked_at = CURRENT_TIMESTAMP,
            revoked_reason = 'lru_replaced',
            updated_at = CURRENT_TIMESTAMP
        WHERE id IN (
          SELECT id
          FROM auth_mcp_connections
          WHERE user_id = ?
            AND status = 'active'
          ORDER BY COALESCE(last_seen_at, updated_at, created_at) ASC,
                   created_at ASC,
                   id ASC
          LIMIT (
            SELECT CASE
              WHEN COUNT(*) > ? THEN COUNT(*) - ?
              ELSE 0
            END
            FROM auth_mcp_connections
            WHERE user_id = ?
              AND status = 'active'
          )
        )
        RETURNING id
        `
      )
      .bind(
        userId,
        activeConnectionsToKeepBeforeInsert,
        activeConnectionsToKeepBeforeInsert,
        userId
      ),
    db
      .prepare(
        `
        INSERT INTO auth_mcp_connections (
          id,
          client_id,
          user_id,
          agent_type,
          display_name,
          resource_url,
          scopes_json,
          status,
          last_seen_at,
          idle_expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, datetime('now', ?), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `
      )
      .bind(
        connectionId,
        client.id,
        userId,
        agentType,
        optionalText(input.displayName, 120) ?? agentType,
        optionalText(input.resourceUrl, 600) ?? client.resourceUrl ?? "",
        JSON.stringify(scopes),
        `+${mcpIdleTtlSeconds(env)} seconds`
      )
  ]);

  const connection = await readMcpConnection(env, connectionId);
  if (!connection || connection.status !== "active" || connection.userId !== userId) {
    throw new HttpError(409, "mcp_oauth_connection_creation_conflict");
  }

  await revokeRefreshTokensForInactiveConnections(env, userId);
  return {
    autoRevokedConnectionId: readReturnedIds(batchResults[0]?.results)[0],
    clientId: client.id,
    connectionId,
    scopes
  };
}

export async function readMcpConnectionStatus(env: Env, userId: string): Promise<McpConnectionStatus> {
  const normalizedUserId = requiredText(userId, "missing_user_id", 160);
  await expireIdleMcpConnections(env, normalizedUserId);
  const [connections, history, latest] = await Promise.all([
    listMcpConnections(env, normalizedUserId),
    requireDb(env)
      .prepare("SELECT COUNT(*) AS count FROM auth_mcp_connections WHERE user_id = ?")
      .bind(normalizedUserId)
      .first<{ count?: number }>(),
    requireDb(env)
      .prepare(
        `SELECT status, revoked_reason AS revokedReason
         FROM auth_mcp_connections
         WHERE user_id = ?
         ORDER BY COALESCE(last_seen_at, updated_at, created_at) DESC, created_at DESC
         LIMIT 1`
      )
      .bind(normalizedUserId)
      .first<{ revokedReason?: string; status?: string }>()
  ]);
  const activeCount = connections.length;
  const authorizedCount = readNumber(history?.count);

  return {
    activeCount,
    authorizedCount,
    connections,
    connected: activeCount > 0,
    credentialState: activeCount > 0
      ? "active"
      : latest?.revokedReason === "idle_expired" ? "idle_expired" : "reauthorization_required",
    currentTaskAvailability: activeCount > 0 ? "reload_may_be_required" : "unavailable",
    everConnected: authorizedCount > 0,
    maxActiveConnections: MAX_ACTIVE_MCP_CONNECTIONS,
    userId: normalizedUserId
  };
}

export async function readMcpConnection(env: Env, connectionId: string) {
  const db = requireDb(env);
  const row = await db
    .prepare(
      `
      SELECT *
      FROM auth_mcp_connections
      WHERE id = ?
      LIMIT 1
      `
    )
    .bind(connectionId)
    .first<McpConnectionRow>();

  return row ? mcpConnectionFromRow(row) : undefined;
}

export async function touchMcpConnection(env: Env, connectionId: string) {
  const db = requireDb(env);
  const touched = await db
    .prepare(
      `
      UPDATE auth_mcp_connections
      SET status = CASE
            WHEN idle_expires_at IS NOT NULL AND idle_expires_at <= CURRENT_TIMESTAMP THEN 'revoked'
            ELSE status
          END,
          last_seen_at = CASE
            WHEN idle_expires_at IS NULL OR idle_expires_at > CURRENT_TIMESTAMP THEN CURRENT_TIMESTAMP
            ELSE last_seen_at
          END,
          idle_expires_at = CASE
            WHEN idle_expires_at IS NULL OR idle_expires_at > CURRENT_TIMESTAMP THEN datetime('now', ?)
            ELSE idle_expires_at
          END,
          revoked_at = CASE
            WHEN idle_expires_at IS NOT NULL AND idle_expires_at <= CURRENT_TIMESTAMP THEN CURRENT_TIMESTAMP
            ELSE revoked_at
          END,
          revoked_reason = CASE
            WHEN idle_expires_at IS NOT NULL AND idle_expires_at <= CURRENT_TIMESTAMP THEN 'idle_expired'
            ELSE revoked_reason
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'active'
      RETURNING id, status
      `
    )
    .bind(`+${mcpIdleTtlSeconds(env)} seconds`, connectionId)
    .first<{ id: string; status: string }>();

  return touched?.id === connectionId && touched.status === "active";
}

export async function listMcpConnections(env: Env, userId: string) {
  const db = requireDb(env);
  await expireIdleMcpConnections(env, userId);
  const rows = await db
    .prepare(
      `
      SELECT *
      FROM auth_mcp_connections
      WHERE user_id = ?
        AND status = 'active'
      ORDER BY COALESCE(last_seen_at, updated_at, created_at) DESC,
               created_at DESC
      LIMIT ?
      `
    )
    .bind(requiredText(userId, "missing_user_id", 160), MAX_ACTIVE_MCP_CONNECTIONS)
    .all<McpConnectionRow>();

  return (rows.results ?? []).map(mcpConnectionFromRow);
}

export async function listAdminMcpConnections(
  env: Env,
  input: ListAdminMcpConnectionsInput = {}
): Promise<AdminMcpConnectionList> {
  const db = requireDb(env);
  await expireIdleMcpConnections(env);
  const status = input.status === "all" || input.status === "inactive" ? input.status : "active";
  const query = optionalText(input.q, 160);
  const searchSql = query
    ? `AND (
        lower(COALESCE(auth_users.name, '')) LIKE lower(?)
        OR lower(COALESCE(auth_users.email, '')) LIKE lower(?)
        OR lower(COALESCE(auth_users.department_name, '')) LIKE lower(?)
        OR lower(COALESCE(auth_users.team_name, '')) LIKE lower(?)
        OR lower(auth_mcp_connections.user_id) LIKE lower(?)
      )`
    : "";
  const searchBinds = query ? Array(5).fill(`%${query}%`) : [];
  const statusSql = status === "all"
    ? ""
    : status === "active"
      ? "AND auth_mcp_connections.status = 'active'"
      : "AND auth_mcp_connections.status != 'active'";
  const limit = Math.min(Math.max(input.limit ?? 1000, 1), 1000);

  const [rows, summary] = await Promise.all([
    db
      .prepare(
        `
        SELECT
          auth_mcp_connections.*,
          COALESCE(auth_mcp_connections.last_seen_at, auth_mcp_connections.created_at) AS last_active_at,
          auth_users.name AS user_name,
          auth_users.email AS user_email,
          auth_users.department_name AS user_department,
          auth_users.team_name AS user_team
        FROM auth_mcp_connections
        LEFT JOIN auth_users ON auth_users.id = auth_mcp_connections.user_id
        WHERE 1 = 1
          ${statusSql}
          ${searchSql}
        ORDER BY
          COALESCE(auth_mcp_connections.last_seen_at, auth_mcp_connections.created_at) DESC,
          auth_mcp_connections.created_at DESC,
          auth_mcp_connections.id
        LIMIT ?
        `
      )
      .bind(...searchBinds, limit)
      .all<AdminMcpConnectionRow>(),
    db
      .prepare(
        `
        SELECT
          COUNT(*) AS total_count,
          SUM(CASE WHEN auth_mcp_connections.status = 'active' THEN 1 ELSE 0 END) AS active_count,
          SUM(CASE WHEN auth_mcp_connections.status != 'active' THEN 1 ELSE 0 END) AS inactive_count,
          COUNT(DISTINCT auth_mcp_connections.user_id) AS user_count
        FROM auth_mcp_connections
        `
      )
      .first<Record<string, unknown>>()
  ]);

  return {
    connections: (rows.results ?? []).map(adminMcpConnectionFromRow),
    summary: {
      activeCount: readNumber(summary?.active_count),
      inactiveCount: readNumber(summary?.inactive_count),
      totalCount: readNumber(summary?.total_count),
      userCount: readNumber(summary?.user_count)
    }
  };
}

export async function disableAdminMcpConnection(env: Env, connectionId: string) {
  const normalizedConnectionId = requiredText(connectionId, "missing_connection_id", 180);
  const connection = await readMcpConnection(env, normalizedConnectionId);

  if (!connection) {
    throw new HttpError(404, "mcp_connection_not_found");
  }

  if (connection.status === "active") {
    await requireDb(env)
      .prepare(
        `
        UPDATE auth_mcp_connections
        SET status = 'revoked',
            revoked_at = CURRENT_TIMESTAMP,
            revoked_reason = 'admin_revoked',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status = 'active'
        `
      )
      .bind(normalizedConnectionId)
      .run();
    await revokeRefreshTokensForInactiveConnections(env, connection.userId);
  }

  return {
    ...connection,
    status: "revoked" as const
  };
}

export async function revokeMcpConnection(env: Env, userId: string, connectionId: string) {
  const db = requireDb(env);
  const normalizedUserId = requiredText(userId, "missing_user_id", 160);
  const normalizedConnectionId = requiredText(connectionId, "missing_connection_id", 180);
  const connection = await readMcpConnection(env, normalizedConnectionId);

  if (!connection || connection.userId !== normalizedUserId || connection.status !== "active") {
    throw new HttpError(404, "mcp_connection_not_found");
  }

  await db
    .prepare(
      `
      UPDATE auth_mcp_connections
      SET status = 'revoked',
          revoked_at = CURRENT_TIMESTAMP,
          revoked_reason = 'user_revoked',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND user_id = ?
        AND status = 'active'
      `
    )
    .bind(normalizedConnectionId, normalizedUserId)
    .run();
  await revokeRefreshTokensForInactiveConnections(env, normalizedUserId);

  return {
    ...connection,
    status: "revoked" as const
  };
}

function mcpConnectionFromRow(row: McpConnectionRow): McpConnection {
  return {
    agentType: normalizeAgentType(row.agent_type) ?? "codex",
    clientId: row.client_id,
    createdAt: row.created_at,
    displayName: row.display_name,
    id: row.id,
    idleExpiresAt: row.idle_expires_at ?? undefined,
    lastSeenAt: row.last_seen_at ?? undefined,
    resourceUrl: row.resource_url,
    scopes: jsonStringList(row.scopes_json),
    status: row.status,
    statusReason: row.revoked_reason ?? undefined,
    updatedAt: row.updated_at,
    userId: row.user_id
  };
}

export async function expireIdleMcpConnections(env: Env, userId?: string) {
  const userFilter = userId ? "AND user_id = ?" : "";
  await requireDb(env)
    .prepare(
      `
      UPDATE auth_mcp_connections
      SET status = 'revoked',
          revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
          revoked_reason = 'idle_expired',
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'active'
        AND idle_expires_at IS NOT NULL
        AND idle_expires_at <= CURRENT_TIMESTAMP
        ${userFilter}
      `
    )
    .bind(...(userId ? [requiredText(userId, "missing_user_id", 160)] : []))
    .run();
  await revokeRefreshTokensForInactiveConnections(env, userId);
}

export async function revokeRefreshTokensForInactiveConnections(env: Env, userId?: string) {
  const userFilter = userId ? "AND user_id = ?" : "";
  await requireDb(env)
    .prepare(
      `
      UPDATE auth_mcp_refresh_tokens
      SET status = 'revoked'
      WHERE status = 'active'
        AND connection_id IN (
          SELECT id FROM auth_mcp_connections
          WHERE status != 'active' ${userFilter}
        )
      `
    )
    .bind(...(userId ? [requiredText(userId, "missing_user_id", 160)] : []))
    .run();
}

export function mcpIdleTtlSeconds(env: Env) {
  const parsed = Number.parseInt(env.MCP_IDLE_TTL_SECONDS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MCP_IDLE_TTL_SECONDS;
}

function adminMcpConnectionFromRow(row: AdminMcpConnectionRow): AdminMcpConnection {
  return {
    agentType: normalizeAgentType(row.agent_type) ?? "codex",
    clientId: row.client_id,
    createdAt: row.created_at,
    displayName: optionalText(row.display_name, 240),
    id: row.id,
    lastActiveAt: row.last_active_at,
    resourceUrl: optionalText(row.resource_url, 600),
    scopes: jsonStringList(row.scopes_json),
    status: row.status === "active" ? "active" : "inactive",
    updatedAt: row.updated_at,
    user: {
      department: optionalText(row.user_department, 240),
      email: normalizeEmail(row.user_email),
      id: row.user_id,
      name: optionalText(row.user_name, 240),
      team: optionalText(row.user_team, 240)
    }
  };
}
