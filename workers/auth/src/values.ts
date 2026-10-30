import { HttpError } from "./types.ts";

// Input normalization has no route, session or persistence ownership.
export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizeRole(value: unknown) {
  const role = Array.isArray(value) ? String(value[0]) : String(value ?? "member");

  if (role === "admin") {
    return "admin";
  }

  return "member";
}

export function headerValue(request: Request, name: string) {
  const value = request.headers.get(name);
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

export function normalizeEmailAddress(value: unknown) {
  const email = readString(value).trim().toLowerCase();
  return email.length <= 240 && /^[^@\s]+@[^@\s]+$/.test(email) ? email : "";
}

export function requireText(value: unknown, errorCode: string, maxLength: number) {
  const text = readString(value).trim();

  if (!text) {
    throw new HttpError(400, errorCode);
  }

  return text.slice(0, maxLength);
}

export function readStringList(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => readString(item).trim()).filter(Boolean);
  }

  try {
    const parsed = JSON.parse(readString(value || "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => readString(item).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function readHeaderPath(request: Request, name: string) {
  const value = headerValue(request, name);
  if (!value) {
    return [];
  }

  const parsed = readStringList(value);
  if (parsed.length > 0) {
    return parsed;
  }

  return value
    .split(/[>/,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function readLimit(value: unknown, fallback: number) {
  const limit = Number.parseInt(readString(value), 10);
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : fallback;
}
