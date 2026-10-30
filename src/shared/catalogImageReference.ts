import { imageContentVersion as avatarContentVersion } from "./imageContentVersion.ts";

const DATA_IMAGE_PATTERN = /^data:image\/(png|jpe?g|webp|gif);base64,([a-z0-9+/=\s]+)$/i;

export function cacheableCatalogImageUrl(
  assetType: unknown,
  assetId: unknown,
  imageUrl: unknown
) {
  const type = assetType === "app" || assetType === "skill" ? assetType : undefined;
  const id = readString(assetId).trim();
  const url = readString(imageUrl).trim();
  if (!type || !id || !DATA_IMAGE_PATTERN.test(url)) {
    return url || undefined;
  }

  return `/api/assets/${type}/${encodeURIComponent(id)}/image?v=${avatarContentVersion(url)}`;
}

// Accept read projections only for this asset's current inline source. A
// stale or cross-asset internal URL is returned as a relative URL so callers'
// existing image validators reject it rather than store a self-reference.
export function restoreCatalogImageSource(
  assetType: unknown,
  assetId: unknown,
  imageUrl: unknown,
  storedImageUrl: unknown,
  portalUrl?: string
) {
  const submitted = readString(imageUrl).trim();
  const stored = readString(storedImageUrl).trim();
  let reference = submitted;
  if (portalUrl && /^https?:\/\//i.test(submitted)) {
    try {
      const candidate = new URL(submitted);
      if (candidate.host === new URL(portalUrl).host && candidate.pathname.startsWith("/api/assets/")) {
        reference = candidate.pathname + candidate.search + candidate.hash;
      }
    } catch {
      return imageUrl;
    }
  }
  if (!reference.startsWith("/api/assets/")) return imageUrl;
  return DATA_IMAGE_PATTERN.test(stored)
    && reference === cacheableCatalogImageUrl(assetType, assetId, stored)
    ? stored
    : reference;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}
