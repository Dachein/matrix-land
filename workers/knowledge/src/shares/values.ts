import { knowledgeAudience } from "../configuration.ts";
import { HttpError } from "../http.ts";
import type { Env, ShareRow } from "../types.ts";
import { readString } from "../values.ts";

export function shareJson(row: ShareRow, env: Env) {
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    objectId: row.object_id,
    slug: row.slug,
    visibility: row.visibility,
    role: row.role,
    url: publicShareUrl(env, row.slug),
    createdByUserId: row.created_by_user_id,
    expiry: row.expires_at ? "24h" : "permanent",
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function publicShareUrl(env: Env, slug: string) {
  return `${knowledgeAudience(env).replace(/\/+$/, "")}/public/${encodeURIComponent(slug)}`;
}

export function randomShareSlug() {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function normalizePublicShareExpiry(value: unknown): "24h" | "permanent" {
  const expiry = readString(value).trim().toLowerCase();
  if (!expiry || expiry === "24h" || expiry === "24_hours") return "24h";
  if (expiry === "permanent" || expiry === "forever") return "permanent";
  throw new HttpError(400, "invalid_public_share_expiry");
}

export function publicShareExpiresAt(expiry: "24h" | "permanent") {
  return expiry === "permanent" ? null : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

export function validateShareSlug(value: string) {
  const slug = value.trim();
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(slug)) {
    throw new HttpError(404, "knowledge_public_share_not_found");
  }
  return slug;
}

export function isUniqueConstraintError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unique|constraint/i.test(message);
}
