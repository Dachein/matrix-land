import type { AssignedUserRole, IdentityProvider, UserRole } from "../../src/shared/types.ts";
import { HttpError } from "./http.ts";

export function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

export function requireText(value: unknown, errorCode: string, maxLength: number) {
  const text = readString(value).trim();

  if (text.length === 0) {
    throw new HttpError(400, errorCode);
  }

  return text.slice(0, maxLength);
}

export function optionalText(value: unknown, maxLength: number) {
  return readString(value).trim().slice(0, maxLength);
}

export function normalizeRole(value: unknown): UserRole {
  const role = Array.isArray(value) ? String(value[0]) : String(value ?? "member");

  if (role === "admin") {
    return "admin";
  }

  return "member";
}

export function normalizeEditableRole(value: unknown): UserRole {
  const role = String(value ?? "").trim();

  if (role === "admin" || role === "member") {
    return role;
  }

  throw new HttpError(400, "invalid_user_role");
}

export function normalizeAssignedRoles(value: unknown, fallbackRole?: unknown): AssignedUserRole[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const roles = new Set<AssignedUserRole>();

  source.forEach((item) => {
    const role = String(item ?? "").trim();
    if (role === "admin") roles.add("admin");
    if (role === "community_admin") roles.add("community_admin");
  });

  if (normalizeRole(fallbackRole) === "admin") {
    roles.add("admin");
  }

  return ["admin", "community_admin"].filter((role): role is AssignedUserRole => roles.has(role as AssignedUserRole));
}

export function normalizeEditableAssignedRoles(value: unknown): AssignedUserRole[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "invalid_user_roles");
  }

  const normalized = normalizeAssignedRoles(value);
  const requested = value.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (requested.some((role) => role !== "admin" && role !== "community_admin")) {
    throw new HttpError(400, "invalid_user_roles");
  }

  return normalized;
}

export function normalizeIdentityProvider(value: unknown): IdentityProvider {
  const provider = String(value ?? "microsoft_entra_id");

  if (provider === "dingtalk" || provider === "generic_oidc") {
    return provider;
  }

  return "microsoft_entra_id";
}

export function normalizeAuthenticationMethod(value: unknown) {
  const method = String(value ?? "");
  if (method === "email_otp" || method === "microsoft_entra_id" || method === "wechat_miniapp") {
    return method;
  }
  return undefined;
}

export function getTtlSeconds(env: { TOKEN_TTL_SECONDS?: string }) {
  const parsed = Number.parseInt(env.TOKEN_TTL_SECONDS ?? "900", 10);
  return Number.isFinite(parsed) ? parsed : 900;
}
