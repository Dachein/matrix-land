import { imageContentVersion as avatarContentVersion } from "../../../src/shared/imageContentVersion.ts";
export { imageContentVersion as avatarContentVersion } from "../../../src/shared/imageContentVersion.ts";
const DATA_IMAGE_PATTERN = /^data:image\/(png|jpe?g|webp|gif);base64,([a-z0-9+/=\s]+)$/i;

export function cacheableUserAvatarUrl(userId: unknown, avatarUrl: unknown) {
  const id = readString(userId).trim();
  const url = readString(avatarUrl).trim();
  if (!id || !DATA_IMAGE_PATTERN.test(url)) {
    return url || undefined;
  }

  return `/api/users/${encodeURIComponent(id)}/avatar?v=${avatarContentVersion(url)}`;
}


export function userAvatarImageResponse(
  avatarUrl: unknown,
  requestedVersion: string | null,
  requestHeaders: Headers
) {
  const url = readString(avatarUrl).trim();
  const match = url.match(DATA_IMAGE_PATTERN);
  if (!match) return undefined;

  const version = avatarContentVersion(url);
  if (requestedVersion !== version) return undefined;

  const etag = `"user-avatar-${version}"`;
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

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
