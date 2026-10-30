import { audit } from "../core/audit";
import { HttpError, type Env, type Principal } from "../core/types";
import { asRecord, randomToken, readString, requireText } from "../core/utils";
import { canReadApp, requireWritableApp } from "./queries";
import type { AppsAppRow } from "../db/rows";

type EnvVarTarget = "runtime" | "pages" | "worker";

type EnvVarRow = {
  app_id: string;
  created_at: string;
  created_by: string;
  environment: string;
  id: string;
  name: string;
  org_id: string;
  target: string;
  updated_at: string;
  updated_by: string;
  value: string;
};

const MAX_ENV_VARS_PER_CALL = 50;
const MAX_ENV_VAR_VALUE_CHARS = 2000;
const SECRET_LIKE_NAME = /(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_KEY|ACCESS_KEY|CLIENT_SECRET)/i;

export async function listAppEnvVars(env: Env, principal: Principal, appId: unknown, targetValue?: unknown) {
  const id = requireText(appId, "missing_app_id", 120);
  const app = await env.APPS_DB.prepare("SELECT * FROM apps_apps WHERE id = ? LIMIT 1").bind(id).first<AppsAppRow>();
  if (!app || !canReadApp(app, principal)) {
    throw new HttpError(404, "apps_app_not_found");
  }

  const target = readOptionalTarget(targetValue);
  const query = target
    ? env.APPS_DB
      .prepare("SELECT * FROM apps_app_env_vars WHERE app_id = ? AND environment = 'production' AND target = ? ORDER BY target, name")
      .bind(id, target)
    : env.APPS_DB
      .prepare("SELECT * FROM apps_app_env_vars WHERE app_id = ? AND environment = 'production' ORDER BY target, name")
      .bind(id);
  const rows = await query.all<EnvVarRow>();
  return { envVars: (rows.results ?? []).map(envVarFromRow) };
}

export async function setAppEnvVars(input: Record<string, unknown>, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const app = await requireWritableApp(env.APPS_DB, principal, appId);
  const target = normalizeTarget(input.target);
  const vars = normalizeVars(input.vars);
  const now = new Date().toISOString();

  await env.APPS_DB.batch(vars.map((item) => env.APPS_DB
    .prepare(
      `
      INSERT INTO apps_app_env_vars (
        id,
        app_id,
        org_id,
        name,
        target,
        environment,
        value,
        created_by,
        updated_by,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'production', ?, ?, ?, ?, ?)
      ON CONFLICT(app_id, environment, target, name) DO UPDATE SET
        value = excluded.value,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
      `
    )
    .bind(`var_${randomToken(12)}`, appId, app.org_id, item.name, target, item.value, principal.sub, principal.sub, now, now)));

  await audit(env.APPS_DB, principal, "updated app env vars", "apps_app", appId, {
    names: vars.map((item) => item.name),
    target
  });

  return listAppEnvVars(env, principal, appId, target);
}

export async function deleteAppEnvVars(input: Record<string, unknown>, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  await requireWritableApp(env.APPS_DB, principal, appId);
  const target = normalizeTarget(input.target);
  const names = normalizeNames(input.names);

  const statements = names.map((name) => env.APPS_DB
    .prepare("DELETE FROM apps_app_env_vars WHERE app_id = ? AND environment = 'production' AND target = ? AND name = ?")
    .bind(appId, target, name));
  await env.APPS_DB.batch(statements);
  await audit(env.APPS_DB, principal, "deleted app env vars", "apps_app", appId, { names, target });
  return listAppEnvVars(env, principal, appId, target);
}

function envVarFromRow(row: EnvVarRow) {
  return {
    appId: row.app_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
    environment: "production",
    id: row.id,
    name: row.name,
    target: normalizeTarget(row.target),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    value: row.value
  };
}

function normalizeVars(value: unknown) {
  const record = asRecord(value);
  const entries = Object.entries(record);
  if (entries.length === 0) {
    throw new HttpError(400, "missing_env_vars");
  }
  if (entries.length > MAX_ENV_VARS_PER_CALL) {
    throw new HttpError(413, "too_many_env_vars");
  }

  return entries.map(([rawName, rawValue]) => ({
    name: normalizeEnvVarName(rawName),
    value: normalizeEnvVarValue(rawValue)
  }));
}

function normalizeNames(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "missing_env_var_names");
  }
  if (value.length > MAX_ENV_VARS_PER_CALL) {
    throw new HttpError(413, "too_many_env_vars");
  }
  return Array.from(new Set(value.map((item) => normalizeEnvVarName(item))));
}

function normalizeEnvVarName(value: unknown) {
  const name = readString(value).trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) {
    throw new HttpError(400, "invalid_env_var_name");
  }
  if (SECRET_LIKE_NAME.test(name)) {
    throw new HttpError(400, "env_var_looks_like_secret");
  }
  return name;
}

function normalizeEnvVarValue(value: unknown) {
  const text = readString(value);
  if (!text || text.length > MAX_ENV_VAR_VALUE_CHARS) {
    throw new HttpError(400, "invalid_env_var_value");
  }
  return text;
}

function normalizeTarget(value: unknown): EnvVarTarget {
  const target = readString(value).trim().toLowerCase().replaceAll("-", "_");
  if (!target || target === "runtime") {
    return "runtime";
  }
  if (target === "pages" || target === "worker") {
    return target;
  }
  throw new HttpError(400, "invalid_env_var_target");
}

function readOptionalTarget(value: unknown) {
  const text = readString(value).trim();
  return text ? normalizeTarget(text) : undefined;
}
