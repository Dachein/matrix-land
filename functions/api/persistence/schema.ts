import { readString } from "../values.ts";

export async function hasTableColumn(
  db: D1Database,
  tableName: "skill_catalog_metadata" | "app_catalog_metadata" | "publication_listings" | "users" | "user_identity_profiles",
  columnName: string
) {
  const result = await db.prepare(`PRAGMA table_info(${tableName})`).all();
  return (result.results ?? []).some((row) => readString(row.name) === columnName);
}
