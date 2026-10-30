import { validForumStorageKey as isValidForumStorageKey } from "./forum/service.ts";
import { HttpError } from "./http.ts";
import { readOptionalString, requireText } from "./values.ts";
import { marketCategoryStableId, normalizeMarketCategoryName, marketCategorySlug } from "../../src/shared/marketCategories.ts";

export function assertHttpUrl(value: string, errorCode: string) {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported_protocol");
    }

    return url;
  } catch {
    throw new HttpError(400, errorCode);
  }
}

export function normalizeCoverImageUrl(value: unknown) {
  const url = readOptionalString(value);

  if (!url) {
    return "";
  }

  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(url)) {
    if (url.length > 1200000) {
      throw new HttpError(400, "cover_image_too_large");
    }

    return url;
  }

  if (url.startsWith("/api/forum/media/")) {
    const storageKey = decodeURIComponent(url.slice("/api/forum/media/".length));

    if (!isValidForumStorageKey(storageKey)) {
      throw new HttpError(400, "invalid_cover_image_url");
    }

    return url.slice(0, 600);
  }

  return assertHttpUrl(url, "invalid_cover_image_url").toString().slice(0, 600);
}

export function normalizeAssetImageUrl(value: unknown) {
  const url = readOptionalString(value);

  if (!url) {
    return "";
  }

  if (url.startsWith("/assets/")) {
    return url.slice(0, 600);
  }

  return normalizeCoverImageUrl(url);
}

export function normalizeAvatarUrl(value: unknown) {
  const url = readOptionalString(value);

  if (!url) {
    return "";
  }

  if (url.startsWith("/api/forum/media/")) {
    const storageKey = decodeURIComponent(url.slice("/api/forum/media/".length));

    if (!isValidForumStorageKey(storageKey)) {
      throw new HttpError(400, "invalid_avatar_url");
    }

    return url.slice(0, 1200);
  }

  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(url)) {
    if (url.length > 1200000) {
      throw new HttpError(400, "avatar_too_large");
    }

    return url;
  }

  return assertHttpUrl(url, "invalid_avatar_url").toString().slice(0, 1200);
}

export function normalizeProfileDepartment(value: unknown) {
  const text = requireText(value, "missing_profile_department", 120);
  const parts = text
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0 || parts.length > 2) {
    throw new HttpError(400, "invalid_profile_department_depth");
  }

  return parts.join(" / ");
}

export async function ensureCategory(db: D1Database, value: string) {
  const name = normalizeMarketCategoryName(value).slice(0, 80);
  const id = marketCategoryStableId(value);
  const slug = marketCategorySlug(value);
  const existing = await db.prepare("SELECT id FROM skill_categories WHERE id = ? LIMIT 1").bind(id).first<{ id: string }>();

  if (existing) {
    return existing.id;
  }

  const existingByName = await db.prepare("SELECT id FROM skill_categories WHERE lower(name) = lower(?) LIMIT 1").bind(name).first<{ id: string }>();

  if (existingByName) {
    return existingByName.id;
  }

  await db
    .prepare(
      `
      INSERT INTO skill_categories (id, name, slug)
      VALUES (?, ?, ?)
      `
    )
    .bind(id, name, slug)
    .run();

  return id;
}

export async function uniqueSlug(db: D1Database, value: string) {
  const base = slugify(value) || "listing";
  const candidate = base.slice(0, 72);
  const existing = await db
    .prepare(
      `
      SELECT slug FROM publication_listings WHERE slug = ?
      UNION SELECT slug FROM skills WHERE slug = ?
      UNION SELECT slug FROM apps WHERE slug = ?
      UNION SELECT slug FROM mcp_servers WHERE slug = ?
      LIMIT 1
      `
    )
    .bind(candidate, candidate, candidate, candidate)
    .first<{ slug: string }>();

  return existing ? `${candidate}-${shortId()}` : candidate;
}

export async function uniquePublicationVersion(db: D1Database, listingId: string, value: string) {
  const candidate = (value || "1.0.0").trim().slice(0, 80);
  const existing = await db
    .prepare("SELECT id FROM publication_versions WHERE listing_id = ? AND version = ? LIMIT 1")
    .bind(listingId, candidate)
    .first<{ id: string }>();

  return existing ? `${candidate}-${shortId()}` : candidate;
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function shortId() {
  return crypto.randomUUID().split("-")[0];
}

export function sanitizeTags(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => /^[a-z0-9][a-z0-9._-]{0,31}$/.test(tag))
    )
  ).slice(0, 8);
}

export function excerpt(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}
