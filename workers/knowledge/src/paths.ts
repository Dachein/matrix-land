import { HttpError } from "./http.ts";

// Normalize and validate Knowledge object paths consistently across read and mutation paths.
export function normalizePath(value: string) {
  const path = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!path) {
    return "";
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\u0000-\u001f]/.test(part))) {
    throw new HttpError(400, "invalid_knowledge_path");
  }
  return parts.join("/");
}

export function validateFolderName(value: string) {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\\/]/.test(name) || /[\u0000-\u001f]/.test(name)) {
    throw new HttpError(400, "invalid_folder_name");
  }
  return name.slice(0, 180);
}

export function validateFileName(value: string) {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\\/]/.test(name) || /[\u0000-\u001f]/.test(name)) {
    throw new HttpError(400, "invalid_file_name");
  }
  return name.slice(0, 240);
}

export function parentPathFromPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function joinPath(parentPath: string, name: string) {
  return [parentPath, name].filter(Boolean).join("/");
}

export function parentPathsForPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.map((_part, index) => parts.slice(0, index + 1).join("/"));
}

export function relativeKnowledgePath(folderPath: string, filePath: string) {
  return filePath === folderPath ? "" : filePath.startsWith(`${folderPath}/`) ? filePath.slice(folderPath.length + 1) : filePath;
}
