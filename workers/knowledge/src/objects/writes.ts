import type { Env, Principal } from "../types.ts";
import { requireObject } from "./repository.ts";

export async function createFileObject(env: Env, namespaceId: string, principal: Principal, parentPath: string, path: string, fileName: string, mimeType: string, contentKind: string) {
  const id = `kobj_${crypto.randomUUID()}`;
  await env.KNOWLEDGE_DB
    .prepare(
      `
      INSERT INTO knowledge_objects (
        id, namespace_id, parent_path, path, file_name, object_kind, mime_type, content_kind,
        title, created_by_user_id, updated_by_user_id
      )
      VALUES (?, ?, ?, ?, ?, 'file', ?, ?, ?, ?, ?)
      `
    )
    .bind(id, namespaceId, parentPath, path, fileName, mimeType, contentKind, fileName, principal.sub, principal.sub)
    .run();
  return requireObject(env, id);
}
