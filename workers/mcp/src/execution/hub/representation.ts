import { HttpError } from "../../types.ts";
import { assertHttpUrl, readOptionalString } from "../values.ts";

export function withoutHubPolicyFields(listing: Record<string, unknown>) {
  const { configJson: _configJson, ...publicListing } = listing;
  return publicListing;
}

export function normalizeAssetImageUrlForHub(value: unknown) {
  const url = readOptionalString(value);

  if (!url) {
    return "";
  }

  if (url.startsWith("/assets/") || url.startsWith("/api/forum/media/")) {
    return url.slice(0, 600);
  }

  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(url)) {
    if (url.length > 1_200_000) {
      throw new HttpError(400, "cover_image_too_large");
    }
    return url;
  }

  return assertHttpUrl(url, "invalid_cover_image_url").toString().slice(0, 600);
}
