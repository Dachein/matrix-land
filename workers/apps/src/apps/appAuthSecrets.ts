import { decryptSecretValue, encryptSecretValue } from "../core/auth";
import { HttpError, type Env } from "../core/types";
import { randomToken } from "../core/utils";
import type { AppsAppRow, AppsAppSecretRow } from "../db/rows";

export const WORKSPACE_AUTH_APP_SECRET_NAME = "WORKSPACE_AUTH_APP_SECRET";
export const WORKSPACE_APP_SESSION_SECRET_NAME = "WORKSPACE_APP_SESSION_SECRET";

export type ManagedAppAuthSecrets = {
  appSecret: string;
  sessionSecret: string;
};

/**
 * Creates one independent confidential-client secret and one App-session
 * signing secret for a APPS App. Values remain encrypted in APPS D1 and are
 * projected only into that App's runtime during deployment.
 */
export async function ensureManagedAppAuthSecrets(env: Env, app: AppsAppRow): Promise<ManagedAppAuthSecrets> {
  const rows = await env.APPS_DB
    .prepare(
      `
      SELECT *
      FROM apps_app_secrets
      WHERE app_id = ?
        AND environment = 'production'
        AND name IN (?, ?)
      ORDER BY name
      `
    )
    .bind(app.id, WORKSPACE_AUTH_APP_SECRET_NAME, WORKSPACE_APP_SESSION_SECRET_NAME)
    .all<AppsAppSecretRow>();
  const byName = new Map((rows.results ?? []).map((row) => [row.name, row]));

  const appSecret = await readOrCreateSecret(env, app, byName.get(WORKSPACE_AUTH_APP_SECRET_NAME), {
    description: "Workspace Auth confidential App client secret",
    name: WORKSPACE_AUTH_APP_SECRET_NAME
  });
  const sessionSecret = await readOrCreateSecret(env, app, byName.get(WORKSPACE_APP_SESSION_SECRET_NAME), {
    description: "Workspace App local session signing secret",
    name: WORKSPACE_APP_SESSION_SECRET_NAME
  });

  return { appSecret, sessionSecret };
}

export async function ensureManagedAppSecret(env: Env, app: AppsAppRow, input: { name: string; description: string; generateValue?: () => string }) {
  const row = await env.APPS_DB.prepare("SELECT * FROM apps_app_secrets WHERE app_id = ? AND environment = 'production' AND name = ? LIMIT 1")
    .bind(app.id, input.name).first<AppsAppSecretRow>();
  return readOrCreateSecret(env, app, row ?? undefined, input);
}

async function readOrCreateSecret(
  env: Env,
  app: AppsAppRow,
  row: AppsAppSecretRow | undefined,
  input: { description: string; name: string; generateValue?: () => string }
) {
  if (row?.status === "configured") {
    return decryptSecretValue(env, {
      algorithm: row.algorithm,
      cipherIv: row.cipher_iv,
      cipherText: row.cipher_text
    });
  }

  const value = input.generateValue?.() ?? `${randomToken(32)}${randomToken(32)}`;
  const encrypted = await encryptSecretValue(env, value);
  const now = new Date().toISOString();
  await env.APPS_DB
    .prepare(
      `
      INSERT INTO apps_app_secrets (
        id,
        app_id,
        org_id,
        name,
        environment,
        description,
        required,
        status,
        cipher_text,
        cipher_iv,
        algorithm,
        configured_by,
        configured_at,
        declared_by,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, 'production', ?, 1, 'configured', ?, ?, ?, 'workspace-apps', ?, ?, ?, ?)
      ON CONFLICT(app_id, environment, name) DO UPDATE SET
        description = excluded.description,
        required = 1,
        status = 'configured',
        cipher_text = excluded.cipher_text,
        cipher_iv = excluded.cipher_iv,
        algorithm = excluded.algorithm,
        configured_by = excluded.configured_by,
        configured_at = excluded.configured_at,
        updated_at = excluded.updated_at
      WHERE apps_app_secrets.status != 'configured'
      `
    )
    .bind(
      `sec_${randomToken(12)}`,
      app.id,
      app.org_id,
      input.name,
      input.description,
      encrypted.cipherText,
      encrypted.cipherIv,
      encrypted.algorithm,
      now,
      app.owner_user_id,
      now,
      now
    )
    .run();
  const stored = await env.APPS_DB
    .prepare(
      `
      SELECT *
      FROM apps_app_secrets
      WHERE app_id = ? AND environment = 'production' AND name = ?
      LIMIT 1
      `
    )
    .bind(app.id, input.name)
    .first<AppsAppSecretRow>();
  if (!stored || stored.status !== "configured") {
    throw new HttpError(503, "managed_app_auth_secret_not_configured");
  }
  return decryptSecretValue(env, {
    algorithm: stored.algorithm,
    cipherIv: stored.cipher_iv,
    cipherText: stored.cipher_text
  });
}
