import { HttpError } from "../../http.ts";
import { contentKindFromMime, contentTypeFromName, sha256Hex } from "../../objects/content.ts";
import { joinPath, normalizePath, parentPathFromPath, validateFileName, validateFolderName } from "../../paths.ts";
import type { PlannedZipObject } from "../../types.ts";
import { slugPart } from "../../values.ts";

export async function buildKnowledgeZipImportPlan(
  entries: Array<{
    bytes: Uint8Array;
    isDirectory: boolean;
    originalPath: string;
    path: string;
  }>,
  rootName: string,
  rootPath: string
): Promise<PlannedZipObject[]> {
  const stripPrefix = archiveRootPrefix(entries.map((entry) => entry.path), rootName);
  const folderPaths = new Set<string>();
  const fileEntries = new Map<string, Uint8Array>();
  const normalizedKinds = new Map<string, "file" | "folder">();

  for (const entry of entries) {
    const relativePath = normalizePath(
      stripPrefix
        ? entry.path.slice(stripPrefix.length).replace(/^\/+/, "")
        : entry.path
    );
    if (!relativePath) {
      continue;
    }
    const parts = relativePath.split("/").filter(Boolean);
    if (entry.isDirectory) {
      parts.forEach(validateFolderName);
    } else {
      parts.slice(0, -1).forEach(validateFolderName);
      validateFileName(parts.at(-1) ?? "");
    }
    const normalizedRelativePath = parts.join("/");
    const kind = entry.isDirectory ? "folder" : "file";
    const previousKind = normalizedKinds.get(normalizedRelativePath);
    if (previousKind) {
      throw new HttpError(409, previousKind === kind ? "knowledge_zip_duplicate_path" : "knowledge_zip_file_folder_conflict");
    }
    normalizedKinds.set(normalizedRelativePath, kind);
    parts.slice(0, entry.isDirectory ? parts.length : -1).forEach((_part, index) => {
      folderPaths.add(parts.slice(0, index + 1).join("/"));
    });
    if (entry.isDirectory) {
      folderPaths.add(normalizedRelativePath);
    } else {
      fileEntries.set(normalizedRelativePath, entry.bytes);
    }
  }

  for (const filePath of fileEntries.keys()) {
    if (folderPaths.has(filePath)) {
      throw new HttpError(409, "knowledge_zip_file_folder_conflict");
    }
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = parts.slice(0, index).join("/");
      if (fileEntries.has(ancestor)) {
        throw new HttpError(409, "knowledge_zip_file_folder_conflict");
      }
    }
  }

  const root: PlannedZipObject = {
    contentKind: "folder",
    fileName: rootName,
    id: `kobj_${crypto.randomUUID()}`,
    kind: "folder",
    mimeType: "application/x-directory",
    parentPath: parentPathFromPath(rootPath),
    path: rootPath,
    sha256: ""
  };
  const folders: PlannedZipObject[] = [...folderPaths]
    .sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth || left.localeCompare(right);
    })
    .map((relativePath) => {
      const path = joinPath(rootPath, relativePath);
      return {
        contentKind: "folder",
        fileName: relativePath.split("/").at(-1) ?? relativePath,
        id: `kobj_${crypto.randomUUID()}`,
        kind: "folder",
        mimeType: "application/x-directory",
        parentPath: parentPathFromPath(path),
        path,
        sha256: ""
      };
    });
  const files = await Promise.all([...fileEntries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(async ([relativePath, entryBytes]): Promise<PlannedZipObject> => {
      const fileName = relativePath.split("/").at(-1) ?? relativePath;
      const mimeType = contentTypeFromName(fileName);
      return {
        bytes: entryBytes,
        contentKind: contentKindFromMime(mimeType, fileName),
        fileName,
        id: `kobj_${crypto.randomUUID()}`,
        kind: "file",
        mimeType,
        parentPath: parentPathFromPath(joinPath(rootPath, relativePath)),
        path: joinPath(rootPath, relativePath),
        sha256: await sha256Hex(entryBytes),
        versionId: `kov_${crypto.randomUUID()}`
      };
    }));

  if (files.length === 0) {
    throw new HttpError(400, "knowledge_zip_contains_no_files");
  }
  return [root, ...folders, ...files];
}

export function archiveFolderName(fileName: string) {
  return fileName.replace(/\.zip$/i, "").trim() || "uploaded-folder";
}

export function normalizeZipEntryPath(value: string) {
  const path = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!path || path.includes("\u0000")) {
    return "";
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || /[\u0000-\u001f]/.test(part))) {
    return "";
  }
  return parts.join("/");
}

export function ignoredZipEntry(path: string) {
  const parts = path.split("/");
  return parts.some((part) => part === "__MACOSX") || parts.at(-1) === ".DS_Store";
}

function archiveRootPrefix(paths: string[], rootName: string) {
  const filePaths = paths.filter(Boolean);
  if (filePaths.length === 0) {
    return "";
  }
  const firstParts = filePaths.map((path) => path.split("/")[0]).filter(Boolean);
  const first = firstParts[0];
  if (!first || !firstParts.every((part) => part === first)) {
    return "";
  }
  return slugPart(first) === slugPart(rootName) ? first : "";
}
