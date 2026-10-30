import { type Env, HttpError } from "../../types.ts";
import { hashOpaqueToken, randomOpaqueCode } from "../crypto.ts";
import { jsonStringList, readReturnedIds, requireDb } from "../values.ts";
import { mcpIdleTtlSeconds } from "./connections.ts";

// Own OAuth one-use authorization codes and refresh-token rotation.
type McpAuthorizationCodeRow = {
  code_challenge: string;
  connection_id: string;
  oauth_client_id: string;
  redirect_uri: string;
  resource_url: string;
  scopes_json: string;
  user_id: string;
};

type McpRefreshTokenRow = {
  connection_id: string;
  oauth_client_id: string;
  resource_url: string;
  scopes_json: string;
  user_id: string;
};

export async function createMcpOAuthAuthorizationCode(env: Env, input: {
  codeChallenge: string;
  connectionId: string;
  oauthClientId: string;
  redirectUri: string;
  resourceUrl: string;
  scopes: string[];
  userId: string;
}) {
  const code = randomOpaqueCode("fmc");
  const codeHash = await hashOpaqueToken(code);
  await requireDb(env)
    .prepare(
      `
      INSERT INTO auth_mcp_authorization_codes (
        code_hash, oauth_client_id, connection_id, user_id, redirect_uri,
        code_challenge, scopes_json, resource_url, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+5 minutes'), CURRENT_TIMESTAMP)
      `
    )
    .bind(
      codeHash,
      input.oauthClientId,
      input.connectionId,
      input.userId,
      input.redirectUri,
      input.codeChallenge,
      JSON.stringify(input.scopes),
      input.resourceUrl
    )
    .run();
  return code;
}

export async function consumeMcpOAuthAuthorizationCode(env: Env, input: {
  code: string;
  codeChallenge: string;
  oauthClientId: string;
  redirectUri: string;
}) {
  const codeHash = await hashOpaqueToken(input.code);
  const consumed = await requireDb(env)
    .prepare(
      `
      UPDATE auth_mcp_authorization_codes
      SET consumed_at = CURRENT_TIMESTAMP
      WHERE code_hash = ?
        AND oauth_client_id = ?
        AND redirect_uri = ?
        AND code_challenge = ?
        AND consumed_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP
      RETURNING code_challenge, connection_id, oauth_client_id, redirect_uri,
                resource_url, scopes_json, user_id
      `
    )
    .bind(codeHash, input.oauthClientId, input.redirectUri, input.codeChallenge)
    .first<McpAuthorizationCodeRow>();
  if (!consumed) {
    throw new HttpError(400, "invalid_grant");
  }
  return {
    codeChallenge: consumed.code_challenge,
    connectionId: consumed.connection_id,
    oauthClientId: consumed.oauth_client_id,
    resourceUrl: consumed.resource_url,
    scopes: jsonStringList(consumed.scopes_json),
    userId: consumed.user_id
  };
}

export async function issueMcpRefreshToken(env: Env, input: {
  connectionId: string;
  oauthClientId: string;
  resourceUrl: string;
  scopes: string[];
  userId: string;
}) {
  const token = randomOpaqueCode("fmr");
  const tokenHash = await hashOpaqueToken(token);
  await requireDb(env)
    .prepare(
      `
      INSERT INTO auth_mcp_refresh_tokens (
        token_hash, oauth_client_id, connection_id, user_id, scopes_json,
        resource_url, status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now', ?), CURRENT_TIMESTAMP)
      `
    )
    .bind(
      tokenHash,
      input.oauthClientId,
      input.connectionId,
      input.userId,
      JSON.stringify(input.scopes),
      input.resourceUrl,
      `+${mcpIdleTtlSeconds(env)} seconds`
    )
    .run();
  return token;
}

export async function readMcpRefreshTokenGrant(env: Env, token: string, oauthClientId: string) {
  const tokenHash = await hashOpaqueToken(token);
  const row = await requireDb(env)
    .prepare(
      `
      SELECT oauth_client_id, connection_id, user_id, scopes_json, resource_url
      FROM auth_mcp_refresh_tokens
      WHERE token_hash = ?
        AND oauth_client_id = ?
        AND status = 'active'
        AND expires_at > CURRENT_TIMESTAMP
      LIMIT 1
      `
    )
    .bind(tokenHash, oauthClientId)
    .first<McpRefreshTokenRow>();
  if (!row) {
    throw new HttpError(400, "invalid_grant");
  }
  return {
    connectionId: row.connection_id,
    oauthClientId: row.oauth_client_id,
    resourceUrl: row.resource_url,
    scopes: jsonStringList(row.scopes_json),
    userId: row.user_id
  };
}

export async function rotateMcpRefreshToken(
  env: Env,
  token: string,
  expected: { connectionId: string; oauthClientId: string; userId: string }
) {
  const db = requireDb(env);
  const tokenHash = await hashOpaqueToken(token);
  const replacementToken = randomOpaqueCode("fmr");
  const replacementHash = await hashOpaqueToken(replacementToken);
  const results = await db.batch([
    db
      .prepare(
        `
        INSERT INTO auth_mcp_refresh_tokens (
          token_hash, oauth_client_id, connection_id, user_id, scopes_json,
          resource_url, status, expires_at, created_at
        )
        SELECT ?, oauth_client_id, connection_id, user_id, scopes_json,
               resource_url, 'active', datetime('now', ?), CURRENT_TIMESTAMP
        FROM auth_mcp_refresh_tokens
        WHERE token_hash = ?
          AND oauth_client_id = ?
          AND connection_id = ?
          AND user_id = ?
          AND status = 'active'
          AND expires_at > CURRENT_TIMESTAMP
          AND EXISTS (
            SELECT 1 FROM auth_mcp_connections
            WHERE id = auth_mcp_refresh_tokens.connection_id
              AND user_id = auth_mcp_refresh_tokens.user_id
              AND status = 'active'
          )
        RETURNING token_hash AS id
        `
      )
      .bind(
        replacementHash,
        `+${mcpIdleTtlSeconds(env)} seconds`,
        tokenHash,
        expected.oauthClientId,
        expected.connectionId,
        expected.userId
      ),
    db
      .prepare(
        `
        UPDATE auth_mcp_refresh_tokens
        SET status = 'rotated', rotated_at = CURRENT_TIMESTAMP
        WHERE token_hash = ?
          AND oauth_client_id = ?
          AND connection_id = ?
          AND user_id = ?
          AND status = 'active'
          AND expires_at > CURRENT_TIMESTAMP
          AND EXISTS (
            SELECT 1 FROM auth_mcp_refresh_tokens replacement
            WHERE replacement.token_hash = ?
              AND replacement.status = 'active'
          )
        RETURNING token_hash AS id
        `
      )
      .bind(
        tokenHash,
        expected.oauthClientId,
        expected.connectionId,
        expected.userId,
        replacementHash
      )
  ]);

  if (
    !readReturnedIds(results[0]?.results).includes(replacementHash)
    || !readReturnedIds(results[1]?.results).includes(tokenHash)
  ) {
    throw new HttpError(400, "invalid_grant");
  }
  return replacementToken;
}
