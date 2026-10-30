import { callRuntimeWorkspacePassTool } from "./workspacePassMcpClient.ts";
import type { RuntimeDefinition, RuntimeEnv, RuntimePrincipal } from "./types.ts";

const MAX_TEXT_CHARACTERS = 80_000;
const MAX_READ_BYTES = 1_000_000;

export async function listReadableKnowledgeFolders(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  folderObjectId?: string,
  signal?: AbortSignal
) {
  const payload = await callRuntimeWorkspacePassTool(env, principal, "knowledge_list", {
    ...(folderObjectId ? { folderObjectId } : {})
  }, { mateId: definition.mate.id, signal });
  const result = record(payload);
  return {
    ...result,
    items: array(result.items).filter((value) => record(record(value).capabilities).canRead === true)
  };
}

export async function searchReadableKnowledgeFolder(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  folderObjectId: string,
  action: "search" | "grep",
  query: string,
  limit: number,
  signal?: AbortSignal
) {
  return callRuntimeWorkspacePassTool(env, principal, "knowledge_query", {
    action,
    folderObjectId,
    limit,
    ...(action === "search" ? { query } : { pattern: query })
  }, { mateId: definition.mate.id, signal });
}

export async function readReadableKnowledgeFile(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  objectId: string,
  signal?: AbortSignal
) {
  const metadata = record(await callRuntimeWorkspacePassTool(env, principal, "knowledge_file_read", {
    includeContent: false, objectId
  }, { mateId: definition.mate.id, signal }));
  const item = record(metadata.item);
  const sizeBytes = Number(item.sizeBytes);
  const mimeType = text(item.mimeType).toLowerCase();
  const contentKind = text(item.contentKind).toLowerCase();
  if (!Number.isFinite(sizeBytes) || sizeBytes > MAX_READ_BYTES || !isTextContent(contentKind, mimeType)) {
    return {
      ...metadata,
      content: { encoding: "unavailable", reason: sizeBytes > MAX_READ_BYTES ? "file_too_large_for_agent" : "binary_content_not_inlined" }
    };
  }
  const payload = record(await callRuntimeWorkspacePassTool(env, principal, "knowledge_file_read", {
    includeContent: true, objectId
  }, { mateId: definition.mate.id, signal }));
  const content = record(payload.content);
  if (content.encoding === "text") {
    const body = text(content.text);
    return {
      ...payload,
      content: { ...content, text: body.slice(0, MAX_TEXT_CHARACTERS), truncated: body.length > MAX_TEXT_CHARACTERS }
    };
  }
  const withoutContent = { ...payload };
  delete withoutContent.content;
  return { ...withoutContent, content: { encoding: "unavailable", reason: "binary_content_not_inlined" } };
}

function isTextContent(contentKind: string, mimeType: string) {
  return ["csv", "html", "markdown", "text"].includes(contentKind)
    || mimeType.startsWith("text/") || mimeType.includes("json") || mimeType.includes("markdown") || mimeType.includes("xml");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
