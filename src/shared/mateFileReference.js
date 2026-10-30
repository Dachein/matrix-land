const OBJECT_ID = /^[A-Za-z0-9_.-]{1,180}$/;
const WORKSPACE_URL = /^\/api\/workspace-files\/([^/?#]+)\/(raw|download)$/;

export function mateFileReference(objectId, fileName) {
  if (typeof objectId !== "string" || !OBJECT_ID.test(objectId)) return undefined;
  const name = typeof fileName === "string" && fileName.trim() ? fileName.trim().slice(0, 180) : "文件";
  return {
    fileName: name,
    objectId,
    source: objectId.startsWith("art_") ? "workspace" : "knowledge",
    url: `/api/workspace-files/${encodeURIComponent(objectId)}/download`
  };
}

export function mateFileReferenceFromUrl(url, fileName) {
  if (typeof url !== "string") return undefined;
  const match = url.match(WORKSPACE_URL);
  if (!match) return undefined;
  try {
    return mateFileReference(decodeURIComponent(match[1]), fileName);
  } catch {
    return undefined;
  }
}

export function mateFileReferencesFromCitations(value) {
  return array(record(value).sources).flatMap((entry) => {
    const source = record(entry);
    const path = typeof source.relativePath === "string" ? source.relativePath : "";
    const reference = mateFileReference(source.objectId, source.fileName || path.split(/[\\/]/).pop() || source.title);
    return reference ? [reference] : [];
  });
}

export function mateFileReferencesFromTool(toolName, value) {
  const output = record(value);
  if (["knowledge_folder_list", "knowledge_library_list"].includes(toolName)) {
    return array(output.items).flatMap((entry) => {
      const item = record(entry);
      if (item.kind !== "file") return [];
      const reference = mateFileReference(item.objectId ?? item.id, item.fileName ?? item.name ?? item.path);
      return reference ? [reference] : [];
    });
  }
  if (["knowledge_folder_file_read", "knowledge_library_file_read"].includes(toolName)) {
    const item = record(output.item);
    const reference = mateFileReference(item.objectId ?? item.id, item.fileName ?? item.name ?? item.path);
    return reference ? [reference] : [];
  }
  if (["knowledge_file_read", "knowledge_library_read", "knowledge_query", "knowledge_folder_search"].includes(toolName)) {
    const file = record(output.file);
    const item = record(output.item);
    const reference = mateFileReference(
      file.objectId ?? item.objectId ?? (item.kind === "file" ? item.id : undefined),
      file.fileName ?? file.name ?? file.relativePath ?? item.fileName ?? item.name
    );
    if (reference) return [reference];
    return array(output.results).flatMap((entry) => {
      const result = record(entry);
      const match = mateFileReference(result.objectId, result.fileName ?? result.name ?? result.relativePath);
      return match ? [match] : [];
    });
  }
  if (["knowledge_base_search", "knowledge_library_search"].includes(toolName)) {
    const groups = toolName === "knowledge_base_search"
      ? array(output.searches).flatMap((entry) => array(record(entry).results))
      : array(output.results);
    return groups.flatMap((entry) => {
      const item = record(entry);
      const reference = mateFileReference(item.objectId, item.fileName ?? item.name ?? item.relativePath);
      return reference ? [reference] : [];
    });
  }
  if (["workspace_file_create", "workspace_image_generate", "workspace_video_generate", "workspace_audio_generate"].includes(toolName)) {
    const file = record(output.file);
    const reference = mateFileReference(file.objectId, file.fileName);
    return reference ? [reference] : [];
  }
  if (toolName === "workspace_file_save_to_knowledge") {
    const file = record(output.knowledgeFile);
    const reference = mateFileReference(file.objectId, file.fileName ?? file.path);
    return reference ? [reference] : [];
  }
  if (["tools_image_generation", "tools_video_generation", "tools_audio_tts"].includes(toolName)) {
    const kind = toolName === "tools_image_generation" ? "image" : toolName === "tools_video_generation" ? "video" : "audio";
    const extension = kind === "image" ? "png" : kind === "video" ? "mp4" : typeof output.format === "string" ? output.format : "mp3";
    const reference = mateFileReference(output.artifactId, `generated-${kind}.${extension}`);
    return reference ? [reference] : [];
  }
  return [];
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) { return Array.isArray(value) ? value : []; }
