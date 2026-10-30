import { type Env, type WorkspaceUser, HttpError } from "../../types.ts";
import { jsonStringList, optionalText, readReturnedIds, requireDb, requiredText } from "../values.ts";
import { ensureMcpClient, normalizeAgentType, readMcpClient, sanitizeScopes } from "./clients.ts";
import {
  expireIdleMcpConnections,
  mcpIdleTtlSeconds,
  readMcpConnection,
  revokeRefreshTokensForInactiveConnections
} from "./connections.ts";
import { DEFAULT_MCP_CLIENT_ID, DEFAULT_MCP_SCOPES, MAX_ACTIVE_MCP_CONNECTIONS, SUPPORTED_MCP_AGENTS } from "./constants.ts";

// Own supported device-grant state transitions and one-use codes.
type McpDeviceCodeRow = {
  agent_type: string;
  client_id: string;
  connection_id: string | null;
  created_at: string;
  device_code: string;
  display_name: string;
  expires_at: string;
  requested_scopes_json: string;
  resource_url: string;
  status: string;
  user_code: string;
  user_department: string | null;
  user_email: string | null;
  user_id: string | null;
  user_name: string | null;
  user_role: string | null;
  user_team: string | null;
};

type DeviceCodeInput = {
  agentType?: string;
  clientId?: string;
  displayName?: string;
  resourceUrl?: string;
  scopes?: unknown;
};

export async function createMcpDeviceCode(env: Env, input: DeviceCodeInput) {
  const db = requireDb(env);
  const clientId = optionalText(input.clientId, 160) ?? DEFAULT_MCP_CLIENT_ID;
  const client = await readMcpClient(env, clientId) ?? await ensureMcpClient(env, { id: clientId });

  if (client.status !== "active") {
    throw new HttpError(403, "mcp_client_disabled");
  }

  const agentType = normalizeAgentType(input.agentType);
  if (!agentType || !(client.supportedAgents ?? SUPPORTED_MCP_AGENTS).includes(agentType)) {
    throw new HttpError(400, "unsupported_mcp_agent");
  }

  const allowedScopes = client.allowedScopes ?? DEFAULT_MCP_SCOPES;
  const scopes = input.scopes === undefined
    ? DEFAULT_MCP_SCOPES.filter((scope) => allowedScopes.includes(scope))
    : sanitizeScopes(input.scopes, allowedScopes);
  const deviceCode = crypto.randomUUID();
  const userCode = await uniqueUserCode(db);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await db
    .prepare(
      `
      INSERT INTO auth_mcp_device_codes (
        device_code,
        user_code,
        client_id,
        agent_type,
        display_name,
        resource_url,
        requested_scopes_json,
        status,
        expires_at,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP)
      `
    )
    .bind(
      deviceCode,
      userCode,
      client.id,
      agentType,
      optionalText(input.displayName, 120) ?? agentType,
      optionalText(input.resourceUrl, 600) ?? client.resourceUrl ?? "",
      JSON.stringify(scopes),
      expiresAt
    )
    .run();

  return {
    deviceCode,
    userCode,
    clientId: client.id,
    agentType,
    displayName: optionalText(input.displayName, 120) ?? agentType,
    resourceUrl: optionalText(input.resourceUrl, 600) ?? client.resourceUrl ?? "",
    scopes,
    expiresAt
  };
}

export async function approveMcpDeviceCode(env: Env, userCode: string, user: WorkspaceUser) {
  const db = requireDb(env);
  const normalizedCode = normalizeUserCode(userCode);
  const row = await readMcpDeviceCodeByUserCode(env, normalizedCode);

  assertPendingDeviceCode(row);

  const scopes = jsonStringList(row.requested_scopes_json);
  const connectionId = row.connection_id ?? `mcp-conn-${crypto.randomUUID()}`;
  const userId = requiredText(user.id || user.email, "missing_user_id", 160);
  await expireIdleMcpConnections(env, userId);
  const approvedAt = new Date().toISOString();
  const activeConnectionsToKeepBeforeInsert = MAX_ACTIVE_MCP_CONNECTIONS - 1;
  const batchResults = await db.batch([
    db
      .prepare(
        `
        UPDATE auth_mcp_device_codes
        SET status = 'approved',
            user_id = ?,
            user_email = ?,
            user_name = ?,
            user_role = ?,
            user_team = ?,
            user_department = ?,
            connection_id = ?,
            approved_at = ?
        WHERE device_code = ?
          AND status = 'pending'
          AND expires_at > ?
        `
      )
      .bind(
        userId,
        optionalText(user.email, 240) ?? null,
        optionalText(user.name, 240) ?? null,
        optionalText(user.role, 80) ?? null,
        optionalText(user.team, 160) ?? null,
        optionalText(user.department, 160) ?? null,
        connectionId,
        approvedAt,
        row.device_code,
        approvedAt
      ),
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
            AND EXISTS (
              SELECT 1
              FROM auth_mcp_device_codes
              WHERE device_code = ?
                AND status = 'approved'
                AND connection_id = ?
                AND user_id = ?
            )
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
        row.device_code,
        connectionId,
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
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, datetime('now', ?), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        WHERE EXISTS (
          SELECT 1
          FROM auth_mcp_device_codes
          WHERE device_code = ?
            AND status = 'approved'
            AND connection_id = ?
            AND user_id = ?
        )
        ON CONFLICT(id) DO UPDATE SET
          status = 'active',
          display_name = excluded.display_name,
          resource_url = excluded.resource_url,
          scopes_json = excluded.scopes_json,
          last_seen_at = CURRENT_TIMESTAMP,
          idle_expires_at = excluded.idle_expires_at,
          updated_at = CURRENT_TIMESTAMP,
          revoked_at = NULL,
          revoked_reason = NULL
        `
      )
      .bind(
        connectionId,
        row.client_id,
        userId,
        normalizeAgentType(row.agent_type),
        row.display_name,
        row.resource_url,
        JSON.stringify(scopes),
        `+${mcpIdleTtlSeconds(env)} seconds`,
        row.device_code,
        connectionId,
        userId
      )
  ]);

  const finalized = await readMcpDeviceCodeByUserCode(env, normalizedCode);
  if (finalized.status !== "approved" || finalized.connection_id !== connectionId || finalized.user_id !== userId) {
    assertPendingDeviceCode(finalized);
    throw new HttpError(409, "mcp_device_code_approval_conflict");
  }

  const autoRevokedConnectionId = readReturnedIds(batchResults[1]?.results)[0];
  await revokeRefreshTokensForInactiveConnections(env, userId);

  return {
    autoRevokedConnectionId,
    clientId: row.client_id,
    connectionId,
    scopes,
    status: "approved" as const,
    userCode: normalizedCode
  };
}

export async function inspectMcpDeviceCode(env: Env, userCode: string) {
  const row = await readMcpDeviceCodeByUserCode(env, normalizeUserCode(userCode));
  const expired = isExpired(row.expires_at);
  const status = expired && row.status === "pending" ? "expired" : row.status;

  return {
    agentType: normalizeAgentType(row.agent_type) ?? "codex",
    clientId: row.client_id,
    displayName: row.display_name,
    expiresAt: row.expires_at,
    expiresIn: Math.max(0, Math.floor((Date.parse(row.expires_at) - Date.now()) / 1000)),
    resourceUrl: row.resource_url,
    scopes: jsonStringList(row.requested_scopes_json),
    status,
    userCode: row.user_code
  };
}

export async function denyMcpDeviceCode(env: Env, userCode: string) {
  const db = requireDb(env);
  const normalizedCode = normalizeUserCode(userCode);
  const row = await readMcpDeviceCodeByUserCode(env, normalizedCode);

  assertPendingDeviceCode(row);

  await db
    .prepare("UPDATE auth_mcp_device_codes SET status = 'denied' WHERE user_code = ?")
    .bind(normalizedCode)
    .run();

  return {
    agentType: normalizeAgentType(row.agent_type) ?? "codex",
    clientId: row.client_id,
    displayName: row.display_name,
    scopes: jsonStringList(row.requested_scopes_json),
    status: "denied" as const,
    userCode: normalizedCode
  };
}

export async function consumeMcpDeviceCode(env: Env, deviceCode: string) {
  const db = requireDb(env);
  const row = await db
    .prepare(
      `
      SELECT *
      FROM auth_mcp_device_codes
      WHERE device_code = ?
      LIMIT 1
      `
    )
    .bind(deviceCode)
    .first<McpDeviceCodeRow>();

  if (!row) {
    throw new HttpError(400, "invalid_device_code");
  }

  if (isExpired(row.expires_at)) {
    await db.prepare("UPDATE auth_mcp_device_codes SET status = 'expired' WHERE device_code = ?").bind(deviceCode).run();
    throw new HttpError(400, "expired_token");
  }

  if (row.status === "pending") {
    throw new HttpError(428, "authorization_pending");
  }

  if (row.status === "denied") {
    throw new HttpError(403, "access_denied");
  }

  if (row.status === "consumed") {
    throw new HttpError(400, "device_code_already_consumed");
  }

  if (row.status !== "approved" || !row.connection_id || !row.user_id) {
    throw new HttpError(400, "invalid_device_code_state");
  }

  const consumedAt = new Date().toISOString();
  const batchResults = await db.batch([
    db
      .prepare(
        `
        UPDATE auth_mcp_device_codes
        SET status = 'consumed',
            consumed_at = ?
        WHERE device_code = ?
          AND status = 'approved'
          AND expires_at > ?
          AND EXISTS (
            SELECT 1
            FROM auth_mcp_connections
            WHERE id = auth_mcp_device_codes.connection_id
              AND status = 'active'
              AND user_id = auth_mcp_device_codes.user_id
              AND client_id = auth_mcp_device_codes.client_id
          )
        RETURNING device_code AS id
        `
      )
      .bind(consumedAt, deviceCode, consumedAt),
    db
      .prepare(
        `
        UPDATE auth_mcp_connections
        SET last_seen_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status = 'active'
          AND EXISTS (
            SELECT 1
            FROM auth_mcp_device_codes
            WHERE device_code = ?
              AND status = 'consumed'
              AND consumed_at = ?
          )
        `
      )
      .bind(row.connection_id, deviceCode, consumedAt)
  ]);

  if (!readReturnedIds(batchResults[0]?.results).includes(deviceCode)) {
    const finalized = await readMcpDeviceCodeByDeviceCode(env, deviceCode);
    if (isExpired(finalized.expires_at)) {
      await db.prepare("UPDATE auth_mcp_device_codes SET status = 'expired' WHERE device_code = ? AND status = 'approved'").bind(deviceCode).run();
      throw new HttpError(400, "expired_token");
    }
    if (finalized.status === "consumed") {
      throw new HttpError(400, "device_code_already_consumed");
    }

    const connection = finalized.connection_id
      ? await readMcpConnection(env, finalized.connection_id)
      : undefined;
    if (
      !connection
      || connection.status !== "active"
      || connection.userId !== finalized.user_id
      || connection.clientId !== finalized.client_id
    ) {
      throw new HttpError(401, "mcp_connection_revoked");
    }

    throw new HttpError(409, "mcp_device_code_consumption_conflict");
  }

  return {
    agentType: normalizeAgentType(row.agent_type) ?? "codex",
    clientId: row.client_id,
    connectionId: row.connection_id,
    resourceUrl: row.resource_url,
    scopes: jsonStringList(row.requested_scopes_json),
    user: {
      id: row.user_id,
      email: row.user_email ?? undefined,
      name: row.user_name ?? undefined,
      role: row.user_role ?? undefined,
      team: row.user_team ?? undefined,
      department: row.user_department ?? undefined,
      status: "active"
    }
  };
}

async function readMcpDeviceCodeByUserCode(env: Env, userCode: string) {
  const db = requireDb(env);
  const row = await db
    .prepare(
      `
      SELECT *
      FROM auth_mcp_device_codes
      WHERE user_code = ?
      LIMIT 1
      `
    )
    .bind(userCode)
    .first<McpDeviceCodeRow>();

  if (!row) {
    throw new HttpError(404, "mcp_device_code_not_found");
  }

  return row;
}

async function readMcpDeviceCodeByDeviceCode(env: Env, deviceCode: string) {
  const db = requireDb(env);
  const row = await db
    .prepare(
      `
      SELECT *
      FROM auth_mcp_device_codes
      WHERE device_code = ?
      LIMIT 1
      `
    )
    .bind(deviceCode)
    .first<McpDeviceCodeRow>();

  if (!row) {
    throw new HttpError(400, "invalid_device_code");
  }

  return row;
}

function assertPendingDeviceCode(row: McpDeviceCodeRow) {
  if (isExpired(row.expires_at)) {
    throw new HttpError(410, "mcp_device_code_expired");
  }

  if (row.status !== "pending") {
    throw new HttpError(409, `mcp_device_code_${row.status}`);
  }
}

function isExpired(expiresAt: string) {
  return Date.parse(expiresAt) <= Date.now();
}

function normalizeUserCode(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function uniqueUserCode(db: D1Database) {
  for (let index = 0; index < 6; index += 1) {
    const code = randomUserCode();
    const existing = await db
      .prepare("SELECT user_code FROM auth_mcp_device_codes WHERE user_code = ? LIMIT 1")
      .bind(code)
      .first<{ user_code: string }>();
    if (!existing) {
      return code;
    }
  }

  return randomUserCode(10);
}

function randomUserCode(length = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let code = "";
  bytes.forEach((byte) => {
    code += alphabet[byte % alphabet.length];
  });
  return code;
}
