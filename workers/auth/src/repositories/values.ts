import { type AppClient, type Env, HttpError } from "../types.ts";

// Persistence input and D1 result normalization only.
export function normalizeEmail(value: unknown) {
  return optionalText(String(value ?? "").toLowerCase(), 240);
}

export function requireDb(env: Env) {
  if (!env.AUTH_DB) {
    throw new HttpError(503, "auth_db_not_configured");
  }

  return env.AUTH_DB;
}

export function normalizeAccessMode(value: unknown): AppClient["accessMode"] {
  const mode = String(value ?? "public");
  return mode === "request" || mode === "targeted" ? mode : "public";
}

export function normalizeDirectoryReadScope(value: unknown): AppClient["directoryReadScope"] {
  return String(value ?? "app") === "company" ? "company" : "app";
}

export function normalizeStatus(value: unknown) {
  const status = optionalText(value, 80);
  return status || "draft";
}

export function normalizeSdkStatus(value: unknown) {
  const status = optionalText(value, 80);
  return status || "pending";
}

export function normalizeGrantStatus(value: unknown): "approved" | "pending" | "rejected" | "revoked" {
  const status = optionalText(value, 80);
  return status === "approved" || status === "rejected" || status === "revoked" ? status : "pending";
}

export function normalizeActiveStatus(value: unknown): "active" | "inactive" {
  return optionalText(value, 80) === "inactive" ? "inactive" : "active";
}

export function optionalText(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength) || undefined;
}

export function requiredText(value: unknown, errorCode: string, maxLength: number) {
  const text = optionalText(value, maxLength);
  if (!text) {
    throw new HttpError(400, errorCode);
  }

  return text;
}

export function readNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function stringList(value: unknown, maxItems: number, maxLength: number) {
  const source = Array.isArray(value) ? value : jsonStringList(value);
  return Array.from(new Set(source.map((item) => optionalText(item, maxLength)).filter(Boolean) as string[])).slice(0, maxItems);
}

export function jsonStringList(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

export function readReturnedIds(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((row) => row && typeof row === "object" && !Array.isArray(row) ? optionalText((row as { id?: unknown }).id, 180) : undefined)
    .filter(Boolean) as string[];
}

export function readJsonRecord(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
