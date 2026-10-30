import { HttpError } from "../http.ts";
import type { Env, ObjectRow, VersionRow } from "../types.ts";

export async function listObjectVersions(env: Env, objectId: string) {
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT * FROM knowledge_object_versions
       WHERE object_id = ?
       ORDER BY version DESC
       LIMIT 200`
    )
    .bind(objectId)
    .all<VersionRow>();
  return rows.results ?? [];
}

export async function knowledgeObjectIncludingDeleted(env: Env, objectId: string) {
  const object = await env.KNOWLEDGE_DB
    .prepare("SELECT * FROM knowledge_objects WHERE id = ?")
    .bind(objectId)
    .first<ObjectRow>();
  if (!object) {
    throw new HttpError(404, "knowledge_object_not_found");
  }
  return object;
}
