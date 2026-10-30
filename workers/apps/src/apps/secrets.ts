import type { AppsApp, AppsAppSecret, AppsAppSecretEnvironment } from "../../../../src/shared/types";
import { audit } from "../core/audit";
import { encryptSecretValue } from "../core/auth";
import { readJson } from "../core/http";
import { normalizeSecretEnvironment, normalizeSecretName } from "../core/normalizers";
import { HttpError, type Env, type Principal } from "../core/types";
import { asRecord, optionalText, randomToken, requireText } from "../core/utils";
import type { AppsAppRow, AppsAppSecretRow } from "../db/rows";
import { WORKSPACE_APP_SESSION_SECRET_NAME, WORKSPACE_AUTH_APP_SECRET_NAME } from "./appAuthSecrets";
import { readApp, canReadApp, requireWritableApp } from "./queries";
import { secretFromRow } from "./mappers";

export async function readAppSecrets(db: D1Database, principal: Principal, appId: string): Promise<AppsAppSecret[]> {
  const row = await db.prepare("SELECT * FROM apps_apps WHERE id = ? LIMIT 1").bind(appId).first<AppsAppRow>();

  if (!row || !canReadApp(row, principal)) {
    throw new HttpError(404, "apps_app_not_found");
  }

  const secrets = await db
    .prepare("SELECT * FROM apps_app_secrets WHERE app_id = ? ORDER BY environment, name")
    .bind(appId)
    .all<AppsAppSecretRow>();

  return (secrets.results ?? []).map(secretFromRow);
}

export async function declareAppSecretRequirements(request: Request, env: Env, principal: Principal, appId: string): Promise<AppsApp> {
  const row = await requireWritableApp(env.APPS_DB, principal, appId);
  const body = await readJson<{ secrets?: Array<{ description?: string; environment?: string; name?: string; required?: boolean }> }>(request);
  const now = new Date().toISOString();
  const requirements = normalizeSecretRequirements(body.secrets);
  const managedAuthSecrets = requirements.filter((secret) => (
    secret.name === WORKSPACE_AUTH_APP_SECRET_NAME || secret.name === WORKSPACE_APP_SESSION_SECRET_NAME || secret.name === "WORKSPACE_STREAM_TOKEN"
  ));

  if (requirements.length === 0) {
    throw new HttpError(400, "missing_secret_requirements");
  }
  if (managedAuthSecrets.length > 0) {
    throw new HttpError(409, "managed_secret_declaration_not_required", {
      managedSecrets: managedAuthSecrets.map((secret) => secret.name),
      management: "platform",
      lifecycle: "created_after_auth_preflight_before_runtime_deploy"
    });
  }

  await env.APPS_DB.batch(requirements.map((secret) => env.APPS_DB
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
        declared_by,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'declared', ?, ?, ?)
      ON CONFLICT(app_id, environment, name) DO UPDATE SET
        description = excluded.description,
        required = excluded.required,
        declared_by = excluded.declared_by,
        updated_at = excluded.updated_at
      `
    )
    .bind(`sec_${randomToken(12)}`, appId, row.org_id, secret.name, secret.environment, secret.description, secret.required ? 1 : 0, principal.sub, now, now)));

  await audit(env.APPS_DB, principal, "declared app secrets", "apps_app", appId, { secrets: requirements.map((secret) => `${secret.environment}:${secret.name}`) });
  return readApp(env.APPS_DB, env, principal, appId);
}

export async function configureAppSecretValue(request: Request, env: Env, principal: Principal, appId: string): Promise<AppsApp> {
  const row = await requireWritableApp(env.APPS_DB, principal, appId);
  const body = await readJson<{
    description?: string;
    environment?: string;
    name?: string;
    required?: boolean;
    value?: string;
  }>(request);
  const name = normalizeSecretName(body.name);
  if (name === "WORKSPACE_STREAM_TOKEN") throw new HttpError(409, "managed_stream_secret_cannot_be_changed");
  const environment = normalizeSecretEnvironment(body.environment);
  const value = requireText(body.value, "missing_secret_value", 12000);
  const description = optionalText(body.description, 500);
  const required = body.required !== false;
  await upsertConfiguredSecret(env, principal, {
    appId,
    description,
    environment,
    name,
    orgId: row.org_id,
    required,
    value
  });
  await audit(env.APPS_DB, principal, "configured app secret", "apps_app", appId, { environment, name });
  return readApp(env.APPS_DB, env, principal, appId);
}

export async function deleteAppSecretValue(request: Request, env: Env, principal: Principal, appId: string): Promise<AppsApp> {
  const row = await requireWritableApp(env.APPS_DB, principal, appId);
  const body = await readJson<{
    environment?: string;
    name?: string;
  }>(request);
  const name = normalizeSecretName(body.name);
  if (name === "WORKSPACE_STREAM_TOKEN") throw new HttpError(409, "managed_stream_secret_cannot_be_changed");
  const environment = normalizeSecretEnvironment(body.environment);

  await env.APPS_DB
    .prepare("DELETE FROM apps_app_secrets WHERE app_id = ? AND org_id = ? AND environment = ? AND name = ?")
    .bind(appId, row.org_id, environment, name)
    .run();

  await audit(env.APPS_DB, principal, "deleted app secret", "apps_app", appId, { environment, name });
  return readApp(env.APPS_DB, env, principal, appId);
}

async function upsertConfiguredSecret(env: Env, principal: Principal, input: {
  appId: string;
  description: string;
  environment: AppsAppSecretEnvironment;
  name: string;
  orgId: string;
  required: boolean;
  value: string;
}) {
  const now = new Date().toISOString();
  const encrypted = await encryptSecretValue(env, input.value);
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
      VALUES (?, ?, ?, ?, ?, ?, ?, 'configured', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_id, environment, name) DO UPDATE SET
        description = CASE WHEN excluded.description = '' THEN apps_app_secrets.description ELSE excluded.description END,
        required = excluded.required,
        status = 'configured',
        cipher_text = excluded.cipher_text,
        cipher_iv = excluded.cipher_iv,
        algorithm = excluded.algorithm,
        configured_by = excluded.configured_by,
        configured_at = excluded.configured_at,
        updated_at = excluded.updated_at
      `
    )
    .bind(
      `sec_${randomToken(12)}`,
      input.appId,
      input.orgId,
      input.name,
      input.environment,
      input.description,
      input.required ? 1 : 0,
      encrypted.cipherText,
      encrypted.cipherIv,
      encrypted.algorithm,
      principal.sub,
      now,
      principal.sub,
      now,
      now
    )
    .run();
}

function normalizeSecretRequirements(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new HttpError(400, "invalid_secret_requirement_shape", {
          how: "Pass secrets as objects, for example [{ name: 'CUSTOM_API_KEY', required: true }]."
        });
      }
      const record = asRecord(item);
      if (typeof record.name !== "string" || !record.name.trim()) {
        throw new HttpError(400, "invalid_secret_requirement_shape", {
          how: "Each secret requirement must be an object with a non-empty name string."
        });
      }
      const name = normalizeSecretName(record.name);
      const environment = normalizeSecretEnvironment(record.environment);
      const key = `${environment}:${name}`;
      if (seen.has(key)) {
        return undefined;
      }
      seen.add(key);
      return {
        description: optionalText(record.description, 500),
        environment,
        name,
        required: record.required !== false
      };
    })
    .filter((item): item is { description: string; environment: AppsAppSecretEnvironment; name: string; required: boolean } => Boolean(item));
}
