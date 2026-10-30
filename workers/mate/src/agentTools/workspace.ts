import { workspaceThumbnail } from "./workspaceThumbnail.ts";
import { tool } from "ai";
import { z } from "zod";
import { HttpError } from "./http.ts";
import { getMateArtifact, mateArtifactContentDisposition, mateArtifactFileName, putMateArtifact } from "../../../../src/shared/mateArtifacts.ts";
import {
  authorizedKnowledgeRequest,
  KNOWLEDGE_READ_SCOPE,
  KNOWLEDGE_WRITE_SCOPE,
  type KnowledgeFetchDeps
} from "./knowledge.ts";
import type { MateToolContext, MateToolEnv } from "./types.ts";
import { ALL_WRITABLE_FOLDERS, FOLDER_EDIT_SCOPE_HEADER } from "../../../../src/shared/mateFolderEditing.ts";

const MAX_GENERATED_FILE_BYTES = 1_000_000;
const MAX_WORKSPACE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_KNOWLEDGE_ARTIFACT_BYTES = 25_000_000;
const WORKSPACE_SCOPES = [KNOWLEDGE_READ_SCOPE, KNOWLEDGE_WRITE_SCOPE];

const generatedFormat = z.enum(["markdown", "text", "csv", "json", "html"]);

type GeneratedFormat = z.infer<typeof generatedFormat>;

type WorkspaceFile = {
  contentKind: string;
  downloadUrl: string;
  fileName: string;
  mediaType: string;
  objectId: string;
  path: string;
  previewUrl?: string;
  sizeBytes: number;
  workspaceFolder: string;
};

export function createWorkspaceWorkspaceTools(
  env: MateToolEnv,
  context: MateToolContext,
  conversationId: string,
  folderEditScope?: string[] | typeof ALL_WRITABLE_FOLDERS
) {
  return {
    workspace_file_create: tool({
      description: "把用户要求创建的 Markdown、文本、CSV、JSON 或 HTML 保存为当前 Mate 和用户私有的临时产物。返回预览与下载地址；只有用户明确要求加入知识库时才归档。",
      inputSchema: z.object({
        content: z.string().min(1).max(600_000),
        fileName: z.string().trim().min(1).max(160),
        format: generatedFormat,
        summary: z.string().trim().max(300).optional()
      }),
      execute: async ({ content, fileName, format, summary }, options) => createWorkspaceFile(
        env,
        context,
        { content, conversationId, fileName, format, summary },
        { signal: options.abortSignal }
      )
    }),
    workspace_image_generate: tool({
      description: "通过 Cloudflare 使用 GPT Image 2.5 Flare（默认）或 Sunburst 生成图片，并保存为当前 Mate 和用户私有的临时产物。返回平台预览与下载地址。",
      inputSchema: z.object({
        prompt: z.string().trim().min(1).max(8_000),
        model: z.enum(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]).optional(),
        quality: z.enum(["low", "medium", "high", "xhigh", "max", "auto"]).optional(),
        size: z.enum(["1024x1024", "1024x1536", "1536x1024", "auto"]).optional()
      }),
      execute: (args, options) => generateMateMedia(env, context, "tools_image_generation", args, "image", { signal: options.abortSignal })
    }),
    workspace_video_generate: tool({
      description: "按用户要求生成视频，并保存为当前 Mate 和用户私有的临时产物。返回平台预览与下载地址。",
      inputSchema: z.object({
        prompt: z.string().trim().min(1).max(8_000),
        duration: z.number().int().min(4).max(15).optional(),
        resolution: z.enum(["768P", "2K"]).optional(),
        ratio: z.enum(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).optional()
      }),
      execute: (args, options) => generateMateMedia(env, context, "tools_video_generation", args, "video", { signal: options.abortSignal })
    }),
    workspace_audio_generate: tool({
      description: "按用户要求把文本生成语音，并保存为当前 Mate 和用户私有的临时产物。返回平台预览与下载地址。",
      inputSchema: z.object({
        text: z.string().trim().min(1).max(10_000),
        voiceId: z.string().trim().min(1).max(120).optional(),
        format: z.enum(["mp3", "flac", "wav"]).optional()
      }),
      execute: (args, options) => generateMateMedia(env, context, "tools_audio_tts", args, "audio", { signal: options.abortSignal })
    }),
    workspace_folder_list: tool({
      description: "列出当前用户可写入的知识库文件夹。用户要求把临时产物加入指定知识库路径时，用它逐级定位文件夹 ID。",
      inputSchema: z.object({ folderObjectId: z.string().trim().max(180).optional() }),
      execute: async ({ folderObjectId }, options) => {
        const paths = folderObjectId
          ? [`/api/tree?folderObjectId=${encodeURIComponent(folderObjectId)}`]
          : folderEditScope?.length ? ["/api/tree", "/api/shared-with-me"] : ["/api/tree"];
        const listings = await Promise.all(paths.map(async (path) => responseJson(
          await authorizedKnowledgeRequest(env, context, path, {
            scopes: [KNOWLEDGE_READ_SCOPE], signal: options.abortSignal
          }),
          "workspace_folder_list_failed"
        )));
        return { folders: listings.flatMap((payload) => arrayValue(record(payload).items)).map(record).filter((item) => (
          stringValue(item.kind ?? item.objectKind) === "folder"
          && (record(item.capabilities).canEdit === true || item.effectiveRole === "owner" || item.effectiveRole === "collaborator")
        )).map((item) => ({ id: item.id, name: item.name, path: item.path })) };
      }
    }),
    workspace_file_save_to_knowledge: tool({
      description: "用户明确要求保存文件到知识库时，先用 workspace_folder_list 定位指定的可写文件夹，再将当前 Mate 的临时产物归档。必须传入 parentObjectId；返回资料库文件 ID 和路径，供后续分享。",
      inputSchema: z.object({
        artifactId: z.string().regex(/^art_[0-9a-f-]{36}$/),
        parentObjectId: z.string().trim().min(1).max(180)
      }),
      execute: ({ artifactId, parentObjectId }, options) => saveMateArtifactToKnowledge(
        env, context, artifactId, parentObjectId, { signal: options.abortSignal, folderEditScope }
      )
    })
  };
}

async function generateMateMedia(
  env: MateToolEnv,
  context: MateToolContext,
  toolName: "tools_image_generation" | "tools_video_generation" | "tools_audio_tts",
  args: Record<string, unknown>,
  kind: "image" | "video" | "audio",
  options: { signal?: AbortSignal }
) {
  const token = env.MATE_RUNTIME_SERVICE_TOKEN?.trim();
  if (!token) throw new HttpError(503, "mate_artifact_generation_unavailable");
  const request = new Request(`https://mcp.example.invalid/internal/runtime/ai/tools/${toolName}`, {
    body: JSON.stringify(args),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-workspace-runtime-mate-id": context.appId,
      "x-workspace-runtime-org-id": artifactOwner(context).orgId,
      "x-workspace-runtime-user-id": context.user.id
    },
    method: "POST",
    signal: options.signal
  });
  const response = env.WORKSPACE_MCP_SERVICE ? await env.WORKSPACE_MCP_SERVICE.fetch(request) : await fetch(request);
  const payload = record(await responseJson(response, "mate_artifact_generation_failed"));
  const artifactId = stringValue(payload.artifactId);
  if (!/^art_[0-9a-f-]{36}$/.test(artifactId)) throw new HttpError(502, "mate_artifact_generation_invalid_response");
  const extension = kind === "image" ? "png" : kind === "video" ? "mp4" : stringValue(payload.format) || "mp3";
  const mediaType = kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : extension === "wav" ? "audio/wav" : extension === "flac" ? "audio/flac" : "audio/mpeg";
  const fileName = `generated-${kind}.${extension}`;
  return {
    expiresAt: payload.expiresAt,
    file: {
      contentKind: kind,
      downloadUrl: `/api/workspace-files/${artifactId}/download`,
      fileName,
      mediaType,
      objectId: artifactId,
      path: `mate/${context.appId}/user/${context.user.id}/Artifact/${fileName}`,
      previewUrl: `/api/workspace-files/${artifactId}/raw`,
      sizeBytes: Number(payload.sizeBytes) || 0,
      workspaceFolder: "Artifact"
    },
    saved: true,
    storage: "temporary"
  };
}

export async function createWorkspaceFile(
  env: MateToolEnv,
  context: MateToolContext,
  input: {
    content: string;
    conversationId: string;
    fileName: string;
    format: GeneratedFormat;
    summary?: string;
  },
  options: { signal?: AbortSignal } = {},
  deps: KnowledgeFetchDeps = {}
) {
  const format = formatDefinition(input.format);
  const fileName = normalizeGeneratedFileName(input.fileName, format.extension);
  const content = normalizeGeneratedContent(input.content, input.format);
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_GENERATED_FILE_BYTES) {
    throw new HttpError(413, "workspace_generated_file_too_large");
  }

  if (!env.MATE_ARTIFACTS) throw new HttpError(503, "mate_artifact_storage_not_configured");
  const stored = await putMateArtifact(env.MATE_ARTIFACTS, artifactOwner(context), {
    body: bytes,
    fileName,
    kind: "file",
    mediaType: format.mediaType
  });
  const previewable = isWorkspacePreviewable(format.mediaType, fileName);
  const file: WorkspaceFile = {
    contentKind: format.contentKind,
    downloadUrl: `/api/workspace-files/${stored.artifactId}/download`,
    fileName,
    mediaType: format.mediaType,
    objectId: stored.artifactId,
    path: `mate/${context.appId}/user/${context.user.id}/Artifact/${fileName}`,
    previewUrl: previewable ? `/api/workspace-files/${stored.artifactId}/raw` : undefined,
    sizeBytes: stored.sizeBytes,
    workspaceFolder: "Artifact"
  };
  return { expiresAt: stored.expiresAt, file, saved: true, storage: "temporary", summary: input.summary?.trim() || undefined };

}

export async function uploadWorkspaceAttachment(
  env: MateToolEnv,
  context: MateToolContext,
  file: File,
  options: { signal?: AbortSignal } = {},
  deps: KnowledgeFetchDeps = {}
) {
  if (!file.name.trim() || file.size <= 0) throw new HttpError(400, "workspace_attachment_invalid");
  if (file.size > MAX_WORKSPACE_ATTACHMENT_BYTES) throw new HttpError(413, "workspace_attachment_too_large");
  const fileName = normalizeUploadedFileName(file.name);
  if (!env.MATE_ARTIFACTS) throw new HttpError(503, "mate_artifact_storage_not_configured");
  let stored;
  try {
    stored = await putMateArtifact(env.MATE_ARTIFACTS, artifactOwner(context), {
      body: await file.arrayBuffer(),
      fileName,
      kind: "file",
      mediaType: file.type || "application/octet-stream"
    });
  } catch {
    throw new HttpError(502, "workspace_attachment_upload_failed");
  }
  return {
    file: {
      fileName,
      mediaType: file.type || "application/octet-stream",
      objectId: stored.artifactId,
      path: `mate/${context.appId}/user/${context.user.id}/Artifact/Attachments/${fileName}`,
      rawUrl: `/api/workspace-files/${stored.artifactId}/raw`,
      downloadUrl: `/api/workspace-files/${stored.artifactId}/download`,
      sizeBytes: stored.sizeBytes
    },
    expiresAt: stored.expiresAt,
    saved: true,
    storage: "temporary"
  };
}

export async function readWorkspaceFileBytes(
  env: MateToolEnv,
  context: MateToolContext,
  objectId: string,
  options: { signal?: AbortSignal } = {},
  deps: KnowledgeFetchDeps = {}
) {
  if (objectId.startsWith("art_")) {
    if (!env.MATE_ARTIFACTS) throw new HttpError(503, "mate_artifact_storage_not_configured");
    const object = await getMateArtifact(env.MATE_ARTIFACTS, artifactOwner(context), objectId);
    if (!object) throw new HttpError(404, "mate_artifact_not_found");
    if (object.size > MAX_WORKSPACE_ATTACHMENT_BYTES) throw new HttpError(413, "workspace_attachment_too_large");
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      mediaType: object.httpMetadata?.contentType || "application/octet-stream"
    };
  }
  const response = await authorizedKnowledgeRequest(
    env,
    context,
    `/api/files/${encodeURIComponent(objectId)}/raw`,
    { scopes: [KNOWLEDGE_READ_SCOPE], signal: options.signal },
    deps
  );
  if (!response.ok) {
    const upstream = await response.text();
    console.error("workspace_agent_workspace_attachment_read_failed", { status: response.status, upstream: upstream.slice(0, 240) });
    throw new HttpError(response.status === 401 ? 502 : response.status, "workspace_attachment_read_failed");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WORKSPACE_ATTACHMENT_BYTES) {
    throw new HttpError(413, "workspace_attachment_too_large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_WORKSPACE_ATTACHMENT_BYTES) throw new HttpError(413, "workspace_attachment_too_large");
  return {
    bytes,
    mediaType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream"
  };
}

export async function proxyWorkspaceFile(
  env: MateToolEnv,
  context: MateToolContext,
  objectId: string,
  disposition: "download" | "raw" | "thumbnail",
  request: Request,
  deps: KnowledgeFetchDeps = {}
): Promise<Response> {
  if (disposition === "thumbnail") {
    // Reuse the original authorization path, stripping conditional/range headers.
    const source = await proxyWorkspaceFile(env, context, objectId, "download", new Request(request.url, { signal: request.signal }), deps);
    return workspaceThumbnail(source, env.IMAGES, JSON.stringify([artifactOwner(context), objectId]),
      typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default);
  }
  if (objectId.startsWith("art_")) {
    if (!env.MATE_ARTIFACTS) throw new HttpError(503, "mate_artifact_storage_not_configured");
    const object = await getMateArtifact(env.MATE_ARTIFACTS, artifactOwner(context), objectId);
    if (!object) throw new HttpError(404, "mate_artifact_not_found");
    const contentType = object.httpMetadata?.contentType || "application/octet-stream";
    if (disposition === "raw" && !isWorkspacePreviewContentType(contentType.split(";", 1)[0]!.toLowerCase())) {
      throw new HttpError(415, "workspace_file_preview_type_unsupported");
    }
    return new Response(object.body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": mateArtifactContentDisposition(object, disposition === "raw" ? "inline" : "attachment"),
        "Content-Length": String(object.size),
        ...(object.httpEtag ? { ETag: object.httpEtag } : {}),
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff"
      }
    });
  }
  const forwarded = new Headers();
  for (const name of ["accept", "if-none-match", "if-range", "range"] as const) {
    const value = request.headers.get(name);
    if (value) forwarded.set(name, value);
  }
  const response = await authorizedKnowledgeRequest(
    env,
    context,
    `/api/files/${encodeURIComponent(objectId)}/${disposition === "download" ? "download" : "raw"}`,
    {
      headers: forwarded,
      scopes: [KNOWLEDGE_READ_SCOPE],
      signal: request.signal
    },
    deps
  );
  if (!response.ok && response.status !== 304) {
    const upstream = await response.text();
    console.error("workspace_agent_workspace_file_proxy_failed", {
      status: response.status,
      upstream: upstream.slice(0, 240)
    });
    throw new HttpError(response.status === 401 ? 502 : response.status, "workspace_file_proxy_failed");
  }
  const headers = new Headers();
  for (const name of [
    "accept-ranges", "content-disposition", "content-length", "content-range",
    "content-type", "etag", "last-modified"
  ] as const) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  const contentType = (headers.get("content-type") ?? "application/octet-stream").split(";", 1)[0]?.toLowerCase();
  if (disposition === "raw" && !isWorkspacePreviewContentType(contentType)) {
    throw new HttpError(415, "workspace_file_preview_type_unsupported");
  }
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  if (contentType === "application/pdf") headers.set("X-Workspace-Allow-Same-Origin-Frame", "1");
  return new Response(response.status === 304 ? null : response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}

export async function saveMateArtifactToKnowledge(
  env: MateToolEnv,
  context: MateToolContext,
  artifactId: string,
  parentObjectId?: string,
  options: { signal?: AbortSignal; folderEditScope?: string[] | typeof ALL_WRITABLE_FOLDERS } = {},
  deps: KnowledgeFetchDeps = {}
) {
  if (!env.MATE_ARTIFACTS) throw new HttpError(503, "mate_artifact_storage_not_configured");
  const object = await getMateArtifact(env.MATE_ARTIFACTS, artifactOwner(context), artifactId);
  if (!object) throw new HttpError(404, "mate_artifact_not_found");
  if (object.size > MAX_KNOWLEDGE_ARTIFACT_BYTES) throw new HttpError(413, "mate_artifact_knowledge_upload_too_large");
  const fileName = mateArtifactFileName(object);
  const mediaType = object.httpMetadata?.contentType || "application/octet-stream";
  const form = new FormData();
  const targetFolderId = parentObjectId?.trim();
  if (!targetFolderId) throw new HttpError(400, "knowledge_folder_id_required");
  let folderScopeHeader: string | undefined;
  if (options.folderEditScope && options.folderEditScope !== ALL_WRITABLE_FOLDERS) {
    const listing = record(await responseJson(await authorizedKnowledgeRequest(env, context,
      `/api/tree?folderObjectId=${encodeURIComponent(targetFolderId)}`, {
        scopes: [KNOWLEDGE_READ_SCOPE], signal: options.signal
      }, deps), "workspace_folder_check_failed"));
    if (stringValue(record(listing.namespace).ownerUserId) !== context.user.id) {
      if (!options.folderEditScope.length) throw new HttpError(403, "folder_edit_scope_required");
      folderScopeHeader = JSON.stringify(options.folderEditScope);
    }
  } else if (options.folderEditScope === ALL_WRITABLE_FOLDERS) {
    folderScopeHeader = JSON.stringify(ALL_WRITABLE_FOLDERS);
  }
  form.set("parentObjectId", targetFolderId);
  form.set("file", new File([await object.arrayBuffer()], fileName, { type: mediaType }));
  const targetDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(targetFolderId)));
  const targetKey = Array.from(targetDigest.slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const response = await authorizedKnowledgeRequest(env, context, "/api/files/upload", {
    body: form,
    headers: {
      Accept: "application/json",
      "Idempotency-Key": `mate-artifact-${artifactId}-${targetKey}`,
      ...(folderScopeHeader ? { [FOLDER_EDIT_SCOPE_HEADER]: folderScopeHeader } : {})
    },
    method: "POST",
    scopes: WORKSPACE_SCOPES,
    signal: options.signal
  }, deps);
  const payload = await responseJson(response, "mate_artifact_knowledge_upload_failed");
  const item = record(payload.item);
  const objectId = stringValue(item.id);
  if (!objectId) throw new HttpError(502, "mate_artifact_knowledge_upload_invalid_response");
  return {
    artifactId,
    knowledgeFile: {
      fileName: stringValue(item.name) || fileName,
      objectId,
      path: stringValue(item.path),
      previewUrl: `/api/workspace-files/${encodeURIComponent(objectId)}/raw`
    },
    saved: true
  };
}

function artifactOwner(context: MateToolContext) {
  return { orgId: context.orgId || context.user.team || "example-org", userId: context.user.id, mateId: context.appId };
}

function formatDefinition(format: GeneratedFormat) {
  const formats = {
    csv: { contentKind: "text", extension: ".csv", mediaType: "text/csv; charset=utf-8" },
    html: { contentKind: "html", extension: ".html", mediaType: "text/html; charset=utf-8" },
    json: { contentKind: "text", extension: ".json", mediaType: "application/json; charset=utf-8" },
    markdown: { contentKind: "markdown", extension: ".md", mediaType: "text/markdown; charset=utf-8" },
    text: { contentKind: "text", extension: ".txt", mediaType: "text/plain; charset=utf-8" }
  } as const;
  return formats[format];
}

function normalizeGeneratedContent(value: string, format: GeneratedFormat) {
  if (format !== "json") return value;
  try {
    return `${JSON.stringify(JSON.parse(value), null, 2)}\n`;
  } catch {
    throw new HttpError(400, "workspace_generated_json_invalid");
  }
}

function normalizeGeneratedFileName(value: string, extension: string) {
  const leaf = value.trim().replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  const safe = leaf
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "-")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .slice(0, Math.max(1, 150 - extension.length))
    .trim();
  if (!safe || safe === "." || safe === "..") throw new HttpError(400, "workspace_file_name_invalid");
  return safe.toLowerCase().endsWith(extension) ? safe : `${safe.replace(/\.[a-z0-9]{1,8}$/i, "")}${extension}`;
}

function normalizeUploadedFileName(value: string) {
  const leaf = value.trim().replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  const safe = leaf
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "-")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .slice(0, 160)
    .trim();
  if (!safe || safe === "." || safe === "..") throw new HttpError(400, "workspace_attachment_name_invalid");
  return safe;
}

function isWorkspacePreviewable(mediaType: string, fileName: string) {
  return isWorkspacePreviewContentType(mediaType.toLowerCase().split(";", 1)[0])
    && !/\.html?$/i.test(fileName);
}

function isWorkspacePreviewContentType(value: string | undefined) {
  return value === "application/pdf"
    || value === "application/json"
    || value === "text/csv"
    || value === "text/markdown"
    || value === "text/plain"
    || value === "text/x-markdown"
    || value === "video/mp4"
    || value === "audio/mpeg"
    || value === "audio/mp3"
    || value === "audio/wav"
    || value === "audio/flac"
    || Boolean(value?.startsWith("image/"));
}

async function responseJson(response: Response, code: string) {
  const text = await response.text();
  if (!response.ok) {
    console.error("workspace_agent_workspace_request_failed", { code, status: response.status, upstream: text.slice(0, 240) });
    throw new HttpError(response.status === 401 ? 502 : response.status, code);
  }
  try {
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    throw new HttpError(502, `${code}_invalid_json`);
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown) { return Array.isArray(value) ? value : []; }
function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
function numberValue(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
