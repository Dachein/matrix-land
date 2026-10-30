import { ALL_WRITABLE_FOLDERS, FOLDER_EDIT_SCOPE_HEADER, parseRuntimeFolderEditScope } from "../../../src/shared/mateFolderEditing.ts";

type FolderObject = {
  id: string;
  namespace_id: string;
  path: string;
  object_kind: string;
  deleted_at?: string | null;
  metadata_json?: string;
};

export class FolderEditScopeError extends Error {
  status = 403;
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

/** A restriction carried from the trusted Runtime bridge, never an ACL grant.
 * All IDs are resolved in the Knowledge Worker immediately before dispatch.
 * Normal route authorization still runs and retains CAS/idempotency checks.
 */
export async function assertFolderEditRequest(
  request: Request,
  deps: {
    writableFolder: (id: string) => Promise<FolderObject>;
    writableFolders: () => Promise<FolderObject[]>;
    object: (id: string, includeDeleted?: boolean) => Promise<FolderObject>;
  }
): Promise<string[] | undefined> {
  const header = request.headers.get(FOLDER_EDIT_SCOPE_HEADER);
  if (header === null) return undefined;
  let requestedScope: string[] | typeof ALL_WRITABLE_FOLDERS;
  try { requestedScope = parseRuntimeFolderEditScope(header); }
  catch { throw new FolderEditScopeError("folder_edit_scope_required"); }
  const roots: FolderObject[] = [];
  if (requestedScope === ALL_WRITABLE_FOLDERS) {
    roots.push(...(await deps.writableFolders()).filter((root) => root.object_kind === "folder" && !root.deleted_at));
  } else {
    for (const id of requestedScope) {
      try {
        const root = await deps.writableFolder(id);
        if (root.object_kind === "folder" && !root.deleted_at) roots.push(root);
      } catch (error) {
        if (![403, 404].includes(Number((error as { status?: number }).status))) throw error;
      }
    }
  }
  const folderIds = roots.map((root) => root.id);
  if (!roots.length) throw new FolderEditScopeError("folder_edit_access_denied");
  const check = async (id: unknown, options: { parent?: boolean; structure?: boolean; restore?: boolean } = {}) => {
    if (typeof id !== "string" || !id.trim()) throw new FolderEditScopeError("folder_edit_object_id_required");
    const object = await deps.object(id, options.restore);
    let path = object.path;
    if (options.restore && object.deleted_at) {
      try { path = JSON.parse(object.metadata_json ?? "{}").deletedOriginalPath; }
      catch { throw new FolderEditScopeError("folder_edit_restore_path_invalid"); }
    }
    if (typeof path !== "string" || !path || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new FolderEditScopeError("folder_edit_path_invalid");
    }
    if (!roots.some((root) => root.namespace_id === object.namespace_id
      && (path === root.path || path.startsWith(`${root.path}/`)))) {
      throw new FolderEditScopeError("folder_edit_outside_scope");
    }
    if (options.parent && object.object_kind !== "folder") throw new FolderEditScopeError("folder_edit_parent_not_folder");
    // A binding grants maintenance inside a folder, not control of that folder
    // itself. This also protects nested bindings selected alongside their root.
    if (options.structure && folderIds.includes(object.id)) throw new FolderEditScopeError("folder_edit_bound_folder_protected");
  };
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  if (method === "GET" && path === "/api/tree") {
    await check(url.searchParams.get("folderObjectId") ?? url.searchParams.get("folder_object_id"), { parent: true });
  } else if (method === "POST" && /^\/api\/knowledge-folders\/[^/]+\/query$/.test(path)) {
    await check(decodeURIComponent(path.split("/")[3]), { parent: true });
  } else if (method === "GET" && /^\/api\/files\/[^/]+(?:\/(?:raw|download|versions))?$/.test(path)) {
    await check(decodeURIComponent(path.split("/")[3]));
  } else if (method === "POST" && path === "/api/files/upload") {
    const form = await request.clone().formData();
    await check(form.get("parentObjectId") ?? form.get("parent_object_id"), { parent: true });
  } else if (method === "POST" && path === "/api/folders") {
    const body = await request.clone().json() as Record<string, unknown>;
    await check(body.parentObjectId ?? body.parent_object_id, { parent: true });
  } else if (method === "POST" && path === "/api/edit/batch") {
    const body = await request.clone().json() as { items?: Array<Record<string, unknown>> };
    if (!Array.isArray(body.items) || !body.items.length) throw new FolderEditScopeError("folder_edit_batch_invalid");
    for (const item of body.items) await check(item?.objectId ?? item?.object_id);
  } else if (method === "POST" && /^\/api\/files\/[^/]+\/(?:edit|versions(?:\/[^/]+\/restore)?)$/.test(path)) {
    await check(decodeURIComponent(path.split("/")[3]));
  } else if (["POST", "PATCH", "DELETE"].includes(method) && /^\/api\/objects\/[^/]+(?:\/(?:rename|move|restore))?$/.test(path)) {
    const action = path.split("/")[4];
    if ((!action && method !== "DELETE") || (action && method === "DELETE")) throw new FolderEditScopeError("folder_edit_content_only");
    await check(decodeURIComponent(path.split("/")[3]), { structure: true, restore: action === "restore" });
    if (action === "move") {
      const body = await request.clone().json() as Record<string, unknown>;
      await check(body.parentObjectId ?? body.parent_object_id, { parent: true });
    }
  } else {
    throw new FolderEditScopeError("folder_edit_content_only");
  }
  return folderIds;
}
