import { avatarContentVersion } from "../users/avatar.ts";

const DATA_IMAGE_PATTERN = /^data:image\/(png|jpe?g|webp|gif);base64,([a-z0-9+/=\s]+)$/i;

export type CatalogImageAssetType = "app" | "skill";

export { cacheableCatalogImageUrl, restoreCatalogImageSource } from "../../../src/shared/catalogImageReference.ts";

export async function readCatalogImageResponse(
  db: D1Database,
  assetType: CatalogImageAssetType,
  assetId: string,
  requestedVersion: string | null,
  requestHeaders: Headers
) {
  if (!requestedVersion) return undefined;
  const candidates = await readCatalogImageCandidates(db, assetType, assetId);
  const imageUrl = candidates.find((candidate) => avatarContentVersion(candidate) === requestedVersion);
  if (!imageUrl) return undefined;

  return inlineImageResponse(imageUrl, requestedVersion, requestHeaders);
}

async function readCatalogImageCandidates(
  db: D1Database,
  assetType: CatalogImageAssetType,
  assetId: string
) {
  const metadataTable = assetType === "app" ? "app_catalog_metadata" : "skill_catalog_metadata";
  const metadataIdColumn = assetType === "app" ? "app_id" : "skill_id";
  const screenshotsColumn = assetType === "app" ? "screenshots_json" : "'[]'";
  const rows = await db.prepare(
    `
      SELECT cover_image_url AS imageUrl, '[]' AS screenshotsJson
      FROM publication_listings
      WHERE listing_type = ? AND target_id = ?
      UNION ALL
      SELECT cover_image_url AS imageUrl, ${screenshotsColumn} AS screenshotsJson
      FROM ${metadataTable}
      WHERE ${metadataIdColumn} = ?
    `
  ).bind(assetType, assetId, assetId).all<Record<string, unknown>>();

  const candidates: string[] = [];
  for (const row of rows.results ?? []) {
    const imageUrl = readString(row.imageUrl).trim();
    if (DATA_IMAGE_PATTERN.test(imageUrl)) candidates.push(imageUrl);
    for (const screenshot of readStringArray(row.screenshotsJson)) {
      if (DATA_IMAGE_PATTERN.test(screenshot)) candidates.push(screenshot);
    }
  }
  return Array.from(new Set(candidates));
}

function inlineImageResponse(imageUrl: string, version: string, requestHeaders: Headers) {
  const match = imageUrl.match(DATA_IMAGE_PATTERN);
  if (!match) return undefined;

  const etag = `"catalog-image-${version}"`;
  const headers = new Headers({
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Type": normalizedImageType(match[1]),
    ETag: etag,
    "X-Content-Type-Options": "nosniff"
  });
  if (requestHeaders.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  try {
    const binary = atob(match[2].replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    headers.set("Content-Length", String(bytes.byteLength));
    return new Response(bytes, { headers });
  } catch {
    return undefined;
  }
}

function normalizedImageType(value: string) {
  return `image/${value.toLowerCase() === "jpg" ? "jpeg" : value.toLowerCase()}`;
}

function readStringArray(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.map(readString).map((item) => item.trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
