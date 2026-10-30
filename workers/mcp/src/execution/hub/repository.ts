import { marketCategorySlug, marketCategoryStableId, normalizeMarketCategoryName } from "../../../../../src/shared/marketCategories.ts";
import { HttpError } from "../../types.ts";
import { shortId, slugify } from "../values.ts";

export async function auditHubSubmission(db: D1Database, actorId: string, listingId: string, metadata: Record<string, unknown>) {
  await db
    .prepare(
      `
      INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES (?, 'user', ?, 'submitted publication listing from MCP', 'publication_listing', ?, ?)
      `
    )
    .bind(crypto.randomUUID(), actorId, listingId, JSON.stringify(metadata))
    .run();
}

export async function readLatestHubListingVersion(db: D1Database, listingId: string) {
  const version = await db
    .prepare(
      `
      SELECT id, version, config_json AS configJson
      FROM publication_versions
      WHERE listing_id = ?
      ORDER BY created_at DESC
      LIMIT 1
      `
    )
    .bind(listingId)
    .first<Record<string, unknown>>();

  if (!version) {
    throw new HttpError(404, "hub_skill_version_not_found");
  }

  return version;
}

export async function ensureHubCategory(db: D1Database, value: string) {
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

export async function uniqueHubSlug(db: D1Database, value: string) {
  const base = slugify(value) || "listing";
  const candidate = base.slice(0, 72);
  const existing = await db
    .prepare("SELECT slug FROM publication_listings WHERE slug = ? LIMIT 1")
    .bind(candidate)
    .first<{ slug: string }>();

  return existing ? `${candidate}-${shortId()}` : candidate;
}

export async function uniqueHubPublicationVersion(db: D1Database, listingId: string, value: string) {
  const candidate = (value || "1.0.0").trim().slice(0, 80);
  const existing = await db
    .prepare("SELECT id FROM publication_versions WHERE listing_id = ? AND version = ? LIMIT 1")
    .bind(listingId, candidate)
    .first<{ id: string }>();

  return existing ? `${candidate}-${shortId()}` : candidate;
}
