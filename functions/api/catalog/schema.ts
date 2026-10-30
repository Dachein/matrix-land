import type { CatalogCoverColumns } from "./types.ts";
import { hasTableColumn } from "../persistence/schema.ts";
export { hasTableColumn } from "../persistence/schema.ts";
export { userProfileColumns } from "../identity/profileSchema.ts";

export async function catalogCoverColumns(db: D1Database): Promise<CatalogCoverColumns> {
  const [skillCatalogMetadata, appCatalogMetadata, publicationListings] = await Promise.all([
    hasTableColumn(db, "skill_catalog_metadata", "cover_image_url"),
    hasTableColumn(db, "app_catalog_metadata", "cover_image_url"),
    hasTableColumn(db, "publication_listings", "cover_image_url")
  ]);

  return {
    skillCatalogMetadata,
    appCatalogMetadata,
    publicationListings
  };
}
