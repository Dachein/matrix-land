// Folder bindings narrow the invoking user's existing access; they never grant
// an identity, an ACL role, or knowledge-service administration rights.
export const FOLDER_EDIT_SCOPE_HEADER = "x-workspace-folder-edit-scope";
export const ALL_WRITABLE_FOLDERS = "all" as const;

export function parseRuntimeFolderEditScope(value: string): string[] | typeof ALL_WRITABLE_FOLDERS {
  if (value === JSON.stringify(ALL_WRITABLE_FOLDERS)) return ALL_WRITABLE_FOLDERS;
  return parseFolderEditScope(value);
}

export function validFolderEditBindings(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 64) return false;
  const ids = new Set<string>();
  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const binding = item as Record<string, unknown>;
    const authority = binding.authority as Record<string, unknown> | undefined;
    if (Object.keys(binding).some((key) => !["folderObjectId", "authority", "requiresCurrentUserAuthorization"].includes(key))
      || typeof binding.folderObjectId !== "string"
      || !binding.folderObjectId.trim()
      || binding.folderObjectId !== binding.folderObjectId.trim()
      || binding.folderObjectId.length > 180
      || /[\u0000-\u001f]/.test(binding.folderObjectId)
      || ids.has(binding.folderObjectId)
      || binding.requiresCurrentUserAuthorization !== true
      || !authority || authority.mode !== "invoking_user"
      || Object.keys(authority).length !== 1) return false;
    ids.add(binding.folderObjectId);
    return true;
  });
}

export function parseFolderEditScope(value: string): string[] {
  const ids: unknown = JSON.parse(value);
  if (!Array.isArray(ids) || !ids.length || ids.length > 64
    || ids.some((id) => typeof id !== "string" || !id.trim() || id !== id.trim()
      || id.length > 180 || /[\u0000-\u001f]/.test(id))
    || new Set(ids).size !== ids.length) throw new Error("invalid_folder_edit_scope");
  return ids as string[];
}
