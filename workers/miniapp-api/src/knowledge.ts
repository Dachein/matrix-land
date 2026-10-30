import { HttpError } from "../../../functions/api/http.ts";
import { readAuthWorkerSessionPrincipal } from "../../../functions/api/identity/authSessionClient.ts";
import type { AuthPrincipal, IdentityEnv } from "../../../functions/api/identity/types.ts";

const READ_SCOPE = "workspace:knowledge:read";
const WRITE_SCOPE = "workspace:knowledge:write";
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface MiniappKnowledgeEnv extends IdentityEnv {
  AUTH_SERVICE_TOKEN?: string;
  KNOWLEDGE_ORG_ID?: string;
  KNOWLEDGE_PUBLIC_URL?: string;
  KNOWLEDGE_RESOURCE_ID?: string;
  KNOWLEDGE_WORKER_URL?: string;
  PORTAL_AUTH_SERVICE_TOKEN?: string;
}

export type MiniappKnowledgeContext = {
  env: MiniappKnowledgeEnv;
  request: Request;
};

type KnowledgeProxyOptions = {
  body?: Record<string, unknown>;
  method?: "GET" | "POST";
};

type KnowledgeRecord = Record<string, unknown>;

type KnowledgeProxyDeps = {
  fetch?: typeof fetch;
  readPrincipal?: (request: Request, env: MiniappKnowledgeEnv) => Promise<AuthPrincipal | undefined>;
};

/**
 * The miniapp mints short-lived knowledge tokens from the user's Workspace session.
 * Uploads are limited to one authenticated file and an optional folder object ID;
 * the Knowledge Worker checks write permission on that folder again.
 */
export function createMiniappKnowledgeApi(deps: KnowledgeProxyDeps = {}) {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const readPrincipal = deps.readPrincipal ?? readAuthWorkerSessionPrincipal;

  return {
    async uploadFile(context: MiniappKnowledgeContext) {
      const principal = await readPrincipal(context.request, context.env);
      if (!principal) throw new HttpError(401, "not_authenticated");
      const declaredLength = Number(context.request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES + 1024 * 1024) {
        throw new HttpError(413, "knowledge_file_too_large");
      }
      if (!(context.request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data;")) {
        throw new HttpError(415, "knowledge_upload_content_type_unsupported");
      }
      const incoming = await context.request.formData();
      const file = incoming.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "missing_file");
      if (!file.size || file.size > MAX_UPLOAD_BYTES) throw new HttpError(file.size ? 413 : 400, file.size ? "knowledge_file_too_large" : "empty_file");
      const parentObjectId = text(incoming.get("parentObjectId"));
      const fileName = text(incoming.get("fileName"));
      if (fileName && (fileName.length > 255 || /[\\/\u0000-\u001f]/.test(fileName) || fileName === "." || fileName === "..")) {
        throw new HttpError(400, "knowledge_file_name_invalid");
      }
      const form = new FormData();
      const mediaType = text(incoming.get("mediaType"));
      form.set("file", fileName ? new File([file], fileName, { type: /^[\w.+-]+\/[\w.+-]+$/.test(mediaType) ? mediaType : file.type }) : file);
      if (parentObjectId) form.set("parentObjectId", parentObjectId);
      form.set("extractZip", "false");
      const token = await mintKnowledgeToken(context, principal, [WRITE_SCOPE]);
      const baseUrl = configuredOrigin(context.env.KNOWLEDGE_WORKER_URL, "knowledge_worker_url_not_configured");
      const response = await fetchImpl(`${baseUrl}/api/files/upload`, {
        method: "POST",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "x-workspace-source-channel": "miniapp" },
        body: form
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 240);
        throw new HttpError(response.status === 401 ? 502 : response.status, `knowledge_worker_request_failed:${detail}`);
      }
      try { return await response.json() as unknown; }
      catch { throw new HttpError(502, "knowledge_worker_invalid_json"); }
    },

    async listServices(context: MiniappKnowledgeContext) {
      return proxyJson(context, "/api/knowledge-services?view=card", { method: "GET" });
    },

    async readLibraryHome(context: MiniappKnowledgeContext) {
      const principal = await readPrincipal(context.request, context.env);
      if (!principal) throw new HttpError(401, "not_authenticated");
      const token = await mintKnowledgeToken(context, principal);
      const [personal, shared, published] = await Promise.all([
        proxyJsonWithToken(context, token, "/api/tree?prefix=", { method: "GET" }),
        proxyJsonWithToken(context, token, "/api/shared-with-me", { method: "GET" }),
        proxyJsonWithToken(context, token, "/api/knowledge-services", { method: "GET" })
      ]);
      const services = recordArray(isRecord(published) ? published.services : undefined);
      const recentFilesByService = await Promise.all(services.map(async (service) => {
        const serviceId = text(service.id);
        if (!serviceId) return [] as KnowledgeRecord[];
        try {
          const tree = await proxyJsonWithToken(
            context,
            token,
            `/api/knowledge-services/${encodeURIComponent(serviceId)}/tree`,
            { method: "POST", body: { relativePath: "", depth: 10, limit: 1_000 } }
          );
          return recordArray(isRecord(tree) ? tree.items : undefined)
            .filter((item) => item.kind === "file" && text(item.objectId) && text(item.fileName))
            .map((item) => ({
              serviceId,
              serviceName: text(service.name),
              item: {
                objectId: text(item.objectId),
                kind: "file",
                fileName: text(item.fileName),
                relativePath: text(item.relativePath),
                contentKind: text(item.contentKind),
                mimeType: text(item.mimeType),
                sizeBytes: Number(item.sizeBytes) || 0,
                updatedAt: text(item.updatedAt)
              }
            }));
        } catch {
          return [] as KnowledgeRecord[];
        }
      }));
      const recentFilesFromServices = recentFilesByService.flat();
      const roots = new Map<string, KnowledgeRecord>();
      for (const item of [...recordArray(isRecord(personal) ? personal.items : undefined), ...recordArray(isRecord(shared) ? shared.items : undefined)]) {
        const id = text(item.id);
        if (id) roots.set(id, item);
      }
      for (const service of services) {
        const folder = isRecord(service.folder) ? service.folder : undefined;
        const id = text(folder?.id ?? service.folderObjectId);
        if (!id) continue;
        const collaboratorUserIds = Array.isArray(service.collaboratorUserIds)
          ? service.collaboratorUserIds.map((entry) => text(entry)).filter(Boolean)
          : [];
        roots.set(id, {
          ...(roots.get(id) ?? {}),
          ...(folder ?? {}),
          id,
          kind: "folder",
          knowledgeServiceId: text(service.id),
          agentEnabled: true,
          collaboratorCount: Number(service.collaboratorCount) || collaboratorUserIds.length || Number(folder?.collaboratorCount) || 0,
          description: service.description ?? folder?.description
        });
      }
      const serviceRootIds = new Set(services.map((service) => {
        const folder = isRecord(service.folder) ? service.folder : undefined;
        return text(folder?.id ?? service.folderObjectId);
      }).filter(Boolean));
      const latestLibraryFiles: KnowledgeRecord[] = [];
      const pendingFolders = [...roots.values()]
        .filter((item) => item.kind === "folder" && !serviceRootIds.has(text(item.id)))
        .map((item) => ({ id: text(item.id), rootName: text(item.name) || "知识库" }))
        .filter((folder) => folder.id);
      const scannedFolderIds = new Set(serviceRootIds);
      for (const root of roots.values()) {
        if (root.kind === "file") latestLibraryFiles.push(toRecentLibraryFile(root, "知识库"));
      }
      let foldersScanned = 0;
      while (pendingFolders.length && foldersScanned < 35) {
        const batch = pendingFolders.splice(0, Math.min(8, 35 - foldersScanned));
        const folderResults = await Promise.all(batch.map(async (folder) => {
          if (scannedFolderIds.has(folder.id)) return { folder, items: [] as KnowledgeRecord[] };
          scannedFolderIds.add(folder.id);
          try {
            const payload = await proxyJsonWithToken(context, token, `/api/tree?folderObjectId=${encodeURIComponent(folder.id)}`, { method: "GET" });
            return { folder, items: recordArray(isRecord(payload) ? payload.items : undefined) };
          } catch {
            return { folder, items: [] as KnowledgeRecord[] };
          }
        }));
        foldersScanned += batch.length;
        for (const { folder, items } of folderResults) {
          for (const item of items) {
            if (item.kind === "folder") {
              const id = text(item.id);
              if (id && !scannedFolderIds.has(id)) pendingFolders.push({ id, rootName: folder.rootName });
            } else if (item.kind === "file") {
              latestLibraryFiles.push(toRecentLibraryFile(item, folder.rootName));
            }
          }
        }
      }
      const recentFiles = [...new Map([...recentFilesFromServices, ...latestLibraryFiles].map((entry) => {
        const item = isRecord(entry.item) ? entry.item : {};
        return [text(item.objectId), entry] as const;
      }).filter(([id]) => id)).values()]
        .sort((left, right) => {
          const leftItem = isRecord(left.item) ? left.item : {};
          const rightItem = isRecord(right.item) ? right.item : {};
          const leftTime = Date.parse(text(leftItem.updatedAt));
          const rightTime = Date.parse(text(rightItem.updatedAt));
          return (Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY)
            - (Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY);
        })
        .slice(0, 5);
      return {
        services: services.map((service) => ({
          serviceId: text(service.id), name: text(service.name), description: text(service.description),
          effectiveRole: text(service.effectiveRole), retrieval: { search: service.indexStatus === "ready", tree: true, read: true },
          health: { status: text(service.indexStatus), updatedAt: text(service.updatedAt) }
        })),
        items: [...roots.values()].sort((a, b) => {
          if (a.kind === "folder" && b.kind !== "folder") return -1;
          if (a.kind !== "folder" && b.kind === "folder") return 1;
          return text(a.name).localeCompare(text(b.name), "zh-Hans-CN");
        }),
        recentFiles
      };
    },

    async readLibraryFolder(context: MiniappKnowledgeContext, folderObjectId: string) {
      return proxyJson(context, `/api/tree?folderObjectId=${encodeURIComponent(folderObjectId)}`, { method: "GET" });
    },

    async readLibraryFile(context: MiniappKnowledgeContext, fileId: string) {
      const principal = await readPrincipal(context.request, context.env);
      if (!principal) throw new HttpError(401, "not_authenticated");
      const token = await mintKnowledgeToken(context, principal);
      const encodedId = encodeURIComponent(fileId);
      const metadata = await proxyJsonWithToken(context, token, `/api/files/${encodedId}`, { method: "GET" });
      const file = isRecord(metadata) && isRecord(metadata.item) ? metadata.item : undefined;
      if (!file || file.kind !== "file") throw new HttpError(404, "knowledge_file_not_found");
      const response = await knowledgeFetch(context, token, `/api/files/${encodedId}/raw`, { method: "GET" });
      const maxBytes = MAX_UPLOAD_BYTES;
      if (Number(response.headers.get("content-length")) > maxBytes) throw new HttpError(413, "knowledge_file_too_large");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new HttpError(413, "knowledge_file_too_large");
      const mimeType = text(response.headers.get("content-type")) || text(file.mimeType) || "application/octet-stream";
      const fileName = text(file.name);
      const textual = mimeType.startsWith("text/") || /(?:json|xml|javascript)/i.test(mimeType) || /\.(?:md|markdown|txt|csv|tsv|json|html|htm|yaml|yml|xml|sql|js|ts|tsx|jsx|css)$/i.test(fileName);
      return {
        file: { objectId: fileId, fileName, relativePath: text(file.path), mimeType, sizeBytes: bytes.byteLength, modifiedAt: text(file.modifiedAt ?? file.updatedAt) },
        content: textual
          ? { encoding: "text", mimeType, sizeBytes: bytes.byteLength, text: new TextDecoder().decode(bytes) }
          : { encoding: "base64", mimeType, sizeBytes: bytes.byteLength, base64: bytesToBase64(bytes) }
      };
    },

    async readService(context: MiniappKnowledgeContext, serviceId: string) {
      return proxyJson(context, `/api/knowledge-services/${encodeURIComponent(serviceId)}`, { method: "GET" });
    },

    async readHandbook(context: MiniappKnowledgeContext, serviceId: string) {
      return proxyJson(context, `/api/knowledge-services/${encodeURIComponent(serviceId)}/handbook`, { method: "GET" });
    },

    async queryService(
      context: MiniappKnowledgeContext,
      serviceId: string,
      action: "tree" | "search" | "read",
      body: Record<string, unknown>
    ) {
      return proxyJson(
        context,
        `/api/knowledge-services/${encodeURIComponent(serviceId)}/${action}`,
        { method: "POST", body }
      );
    },

    async resolvePreviewTarget(context: MiniappKnowledgeContext, body: Record<string, unknown>) {
      const serviceId = text(body.serviceId ?? body.service_id);
      if (!serviceId) throw new HttpError(400, "knowledge_preview_service_id_required");

      // Resolve the service through the same authenticated upstream used by
      // preview requests. Object-level access is checked again by `read` when
      // the actual file is opened; the resolver never grants access itself.
      const serviceResponse = await proxyJson(
        context,
        `/api/knowledge-services/${encodeURIComponent(serviceId)}`,
        { method: "GET" }
      );

      const service = isRecord(serviceResponse) ? serviceResponse.service : undefined;
      return {
        target: {
          type: "knowledge",
          serviceId,
          objectId: text(body.objectId ?? body.object_id) || undefined,
          path: text(body.path) || undefined,
          conversationId: text(body.conversationId ?? body.conversation_id) || undefined,
          messageId: text(body.messageId ?? body.message_id) || undefined
        },
        service
      };
    }
  };

  async function proxyJson(
    context: MiniappKnowledgeContext,
    path: string,
    options: KnowledgeProxyOptions
  ) {
    const principal = await readPrincipal(context.request, context.env);
    if (!principal) throw new HttpError(401, "not_authenticated");

    const token = await mintKnowledgeToken(context, principal);
    return proxyJsonWithToken(context, token, path, options);
  }

  async function proxyJsonWithToken(context: MiniappKnowledgeContext, token: string, path: string, options: KnowledgeProxyOptions) {
    const response = await knowledgeFetch(context, token, path, options);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new HttpError(502, "knowledge_worker_invalid_json");
    }
  }

  async function knowledgeFetch(context: MiniappKnowledgeContext, token: string, path: string, options: KnowledgeProxyOptions) {
    const baseUrl = configuredOrigin(context.env.KNOWLEDGE_WORKER_URL, "knowledge_worker_url_not_configured");
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-workspace-source-channel": "miniapp"
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240);
      throw new HttpError(response.status === 401 ? 502 : response.status, `knowledge_worker_request_failed:${detail}`);
    }
    return response;
  }

  async function mintKnowledgeToken(context: MiniappKnowledgeContext, principal: AuthPrincipal, scopes = [READ_SCOPE]) {
    const serviceToken = context.env.PORTAL_AUTH_SERVICE_TOKEN?.trim()
      || context.env.AUTH_SERVICE_TOKEN?.trim();
    if (!serviceToken) throw new HttpError(503, "knowledge_resource_mint_token_not_configured");

    const authWorkerUrl = configuredOrigin(context.env.AUTH_WORKER_URL, "auth_worker_url_not_configured");
    const audience = configuredOrigin(
      context.env.KNOWLEDGE_PUBLIC_URL || context.env.KNOWLEDGE_WORKER_URL,
      "knowledge_public_url_not_configured"
    );
    const response = await fetchImpl(`${authWorkerUrl}/v1/resource-tokens/mint`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${serviceToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        resourceId: context.env.KNOWLEDGE_RESOURCE_ID?.trim() || "workspace-knowledge",
        audience,
        scopes,
        clientId: "workspace-miniapp",
        principal: {
          sub: principal.userId,
          email: principal.email,
          name: principal.name,
          role: principal.role,
          team: principal.team,
          department: principal.department,
          departmentId: principal.departmentId,
          departmentPath: principal.departmentPath,
          orgId: context.env.KNOWLEDGE_ORG_ID?.trim() || "example-org",
          scopes
        }
      })
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240);
      throw new HttpError(response.status === 401 ? 502 : response.status, `knowledge_resource_token_mint_failed:${detail}`);
    }

    const payload = await response.json() as Record<string, unknown>;
    const token = text(payload.access_token);
    if (!token) throw new HttpError(502, "knowledge_resource_token_missing");
    return token;
  }
}

function configuredOrigin(value: string | undefined, errorCode: string) {
  try {
    const url = new URL(value?.trim() || "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new HttpError(503, errorCode);
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordArray(value: unknown): KnowledgeRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function toRecentLibraryFile(item: KnowledgeRecord, rootName: string): KnowledgeRecord {
  return {
    serviceId: "",
    serviceName: rootName,
    item: {
      objectId: text(item.id),
      kind: "file",
      fileName: text(item.name),
      relativePath: text(item.path),
      contentKind: text(item.contentKind),
      mimeType: text(item.mimeType),
      sizeBytes: Number(item.sizeBytes) || 0,
      updatedAt: text(item.modifiedAt)
    }
  };
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
