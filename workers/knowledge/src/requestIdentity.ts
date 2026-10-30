import type { Env, Principal, ObjectRow } from "./types.ts";
import { objectJsonListForPrincipal } from "./objects/representation.ts";
import { resolveUnrestrictedPrincipal } from "./identity.ts";
import { assertFolderEditRequest, FolderEditScopeError } from "./folder-edit-scope.ts";
import { requireWritableObject, requireReadableObject } from "./objects/access.ts";
import { HttpError } from "./http.ts";
import { requireNamespaceForPrincipal } from "./objects/repository.ts";

export async function listWritableFolderRows(env: Env, principal: Principal, includeDescendants: boolean): Promise<ObjectRow[]> {
  const result = await env.KNOWLEDGE_DB.prepare(`
    SELECT object.* FROM knowledge_objects AS object
    JOIN knowledge_namespaces AS namespace ON namespace.id = object.namespace_id
    WHERE namespace.org_id = ? AND namespace.status != 'archived'
      AND object.object_kind = 'folder' AND object.deleted_at IS NULL
      ${includeDescendants ? "" : "AND object.parent_path = ''"}
    ORDER BY object.namespace_id, object.path
  `).bind(principal.orgId).all<ObjectRow>();
  const rows = result.results ?? [];
  const projected = await objectJsonListForPrincipal(env, rows, principal);
  const editableIds = new Set(projected.filter((item) => item.capabilities.canEdit).map((item) => item.id));
  return rows.filter((row) => editableIds.has(row.id));
}

export async function resolvePrincipal(request: Request, env: Env): Promise<Principal> {
  const principal = await resolveUnrestrictedPrincipal(request, env);
  try {
    const scope = await assertFolderEditRequest(request, {
      writableFolder: (id) => requireWritableObject(env, principal, id),
      // Only top-level ACL roots are bindings. Their descendants inherit access
      // and must remain eligible for structural edits.
      writableFolders: () => listWritableFolderRows(env, principal, false),
      object: async (id, includeDeleted) => {
        if (!includeDeleted) return requireReadableObject(env, principal, id);
        const object = await env.KNOWLEDGE_DB.prepare("SELECT * FROM knowledge_objects WHERE id = ?").bind(id).first<ObjectRow>();
        if (!object) throw new HttpError(404, "knowledge_object_not_found");
        await requireNamespaceForPrincipal(env, object.namespace_id, principal);
        return object;
      }
    });
    return scope ? { ...principal, folderEditOnly: true } : principal;
  } catch (error) {
    if (error instanceof FolderEditScopeError) throw new HttpError(error.status, error.code);
    throw error;
  }
}
