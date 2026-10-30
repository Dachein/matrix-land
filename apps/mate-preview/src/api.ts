import { fetchReadWithRetry } from "./readRetry.ts";
import { modelDisplayName } from "../../../src/shared/modelDisplayName.ts";

const DEFAULT_SESSION_ENDPOINT = "/api/mate-runtime/preview-sessions";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{3,180}$/;

export type MatePreviewSession = {
  accessToken: string;
  conversationId: string;
  conversationState: "draft" | "persisted";
  expiresAt: string;
  mode: "live" | "preview";
  principalKey: string;
  runtimeOrigin: string;
  mate: {
    avatarUrl?: string;
    description?: string;
    displayName: string;
    id: string;
    jobRole?: string;
  };
  user?: {
    avatarUrl?: string;
    name: string;
  };
  release: {
    id: string;
    manifestSha256?: string;
    version?: number;
  };
  surface: MatePreviewSurface;
};

export type MateWeixinBindingState = {
  bindingId?: string;
  boundAt?: string;
  conversationId?: string;
  error?: string;
  expiresAt?: string;
  lastUsedAt?: string;
  qrContent?: string;
  sessionId?: string;
  state: "unbound" | "pending" | "scanned" | "need_verify_code" | "active" | "expired" | "failed";
};

export function requestMateWeixinBinding(input: {
  fetch?: typeof globalThis.fetch;
  method?: "DELETE" | "GET" | "POST";
  session: MatePreviewSession;
  sessionId?: string;
  signal?: AbortSignal;
  verifyCode?: string;
}) {
  if (input.session.mode !== "live") throw new MatePreviewApiError(405, "owner_test_weixin_forbidden");
  const fetcher = input.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new MatePreviewApiError(503, "runtime_weixin_fetch_unavailable");
  const suffix = input.sessionId
    ? `/authorize/${encodeURIComponent(input.sessionId)}${input.verifyCode ? "/verify" : ""}`
    : input.method === "POST" ? "/authorize" : "";
  const url = new URL(
    `/v1/mates/${encodeURIComponent(input.session.mate.id)}/channels/weixin${suffix}`,
    input.session.runtimeOrigin
  );
  return fetcher(url, {
    ...(input.verifyCode ? { body: JSON.stringify({ code: input.verifyCode }) } : {}),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.session.accessToken}`,
      ...(input.verifyCode ? { "content-type": "application/json" } : {})
    },
    method: input.method ?? "GET",
    signal: input.signal
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new MatePreviewApiError(response.status, errorCode(payload.error));
    return normalizeWeixinBinding(payload);
  });
}

export async function freshMateWeixinSession(input: {
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  session: MatePreviewSession;
  signal?: AbortSignal;
  now?: number;
}): Promise<MatePreviewSession> {
  const current = input.session;
  if (current.mode !== "live") throw new MatePreviewApiError(405, "owner_test_weixin_forbidden");
  if (Date.parse(current.expiresAt) > (input.now ?? Date.now()) + 30_000) return current;
  const refreshed = await requestMateLiveSession({
    ...(current.conversationState === "persisted" ? { conversationId: current.conversationId } : {}),
    endpoint: input.endpoint,
    fetch: input.fetch,
    signal: input.signal,
    mateId: current.mate.id
  });
  if (refreshed.principalKey !== current.principalKey
    || refreshed.mate.id !== current.mate.id
    || refreshed.runtimeOrigin !== current.runtimeOrigin) {
    throw new MatePreviewApiError(502, "weixin_session_refresh_mismatch");
  }
  return refreshed;
}

function normalizeWeixinBinding(value: Record<string, unknown>): MateWeixinBindingState {
  const states = new Set<MateWeixinBindingState["state"]>([
    "unbound", "pending", "scanned", "need_verify_code", "active", "expired", "failed"
  ]);
  const state = optionalText(value.state, 40) as MateWeixinBindingState["state"] | undefined;
  if (!state || !states.has(state)) throw new MatePreviewApiError(502, "runtime_weixin_response_invalid");
  return {
    state,
    bindingId: optionalText(value.bindingId, 180),
    boundAt: optionalText(value.boundAt, 80),
    conversationId: optionalText(value.conversationId, 180),
    error: optionalText(value.error, 180),
    expiresAt: optionalText(value.expiresAt, 80),
    lastUsedAt: optionalText(value.lastUsedAt, 80),
    qrContent: optionalText(value.qrContent, 2_000),
    sessionId: optionalText(value.sessionId, 180)
  };
}

export async function createMateConversation(input: {
  fetch?: typeof globalThis.fetch;
  session: MatePreviewSession;
  signal?: AbortSignal;
  title: string;
}) {
  if (input.session.conversationState !== "draft") {
    throw new MatePreviewApiError(409, "conversation_already_persisted");
  }
  const title = boundedText(input.title, 160, "conversation_title_required");
  const fetcher = input.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new MatePreviewApiError(503, "runtime_conversation_fetch_unavailable");
  const url = new URL(
    `/v1/${input.session.mode === "preview" ? "owner-test/" : ""}mates/${encodeURIComponent(input.session.mate.id)}/conversations`,
    input.session.runtimeOrigin
  );
  const response = await fetcher(url, {
    body: JSON.stringify({
      channel: "sdk",
      conversationId: input.session.conversationId,
      title
    }),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.session.accessToken}`,
      "content-type": "application/json"
    },
    method: "POST",
    signal: input.signal
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new MatePreviewApiError(response.status, errorCode(payload.error));
  const conversation = record(payload.conversation, "runtime_conversation_response_invalid");
  const conversationId = identifier(conversation.id, "runtime_conversation_response_invalid");
  if (conversationId !== input.session.conversationId || conversation.channel !== "sdk") {
    throw new MatePreviewApiError(502, "runtime_conversation_response_invalid");
  }
  return {
    id: conversationId,
    title: optionalText(conversation.title, 160) || title
  };
}

export type MatePreviewSurface = {
  channels: Array<"sdk" | "email" | "schedule" | "mate_call">;
  defaultExecutor?: "operations" | "knowledge_qa" | "app_mcp";
  entries: MatePreviewEntry[];
  kind: "conversation" | "task_inbox" | "unavailable";
};

export type MatePreviewEntry = {
  channel: "sdk" | "email" | "schedule" | "mate_call";
  kind: "conversation" | "task_inbox";
};

export type MateRuntimeCapabilityProfile = {
  appMcp: Array<{
    allowedToolNames: string[];
    authorization: "invoking_user";
    description?: string;
    id: string;
    kind: "app_mcp";
    name?: string;
  }>;
  knowledge: Array<{
    allowedOperations: string[];
    authorization: "invoking_user";
    description?: string;
    id: string;
    kind: "knowledge_service";
    name?: string;
  }>;
  models: {
    allowUserSelection: boolean;
    allowed: Array<{ id: string; name: string }>;
    defaultModel: string;
    multimodal: {
      audioInput: boolean;
      documentInput: boolean;
      imageInput: boolean;
    };
  };
  tools: Array<{
    authorization: "current_user_context";
    id: string;
    kind: "built_in_tool";
    provider?: string;
    status: "ready";
    surfaces: string[];
    writeRequiresApproval?: boolean;
  }>;
};

export type MateUploadedAttachment = {
  downloadUrl: string;
  fileName: string;
  mediaType: string;
  objectId: string;
  rawUrl: string;
  sizeBytes: number;
};

export async function uploadMateAttachment(input: {
  accessToken: string;
  fetch?: typeof globalThis.fetch;
  file: File;
  session: MatePreviewSession;
  signal?: AbortSignal;
}): Promise<MateUploadedAttachment> {
  if (input.session.mode !== "live") throw new MatePreviewApiError(405, "owner_test_workspace_write_forbidden");
  const fetcher = input.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new MatePreviewApiError(503, "runtime_attachment_fetch_unavailable");
  const form = new FormData();
  form.set("file", input.file);
  const response = await fetcher(runtimeWorkspaceUrl(input.session, "workspace-attachments"), {
    body: form,
    headers: { accept: "application/json", authorization: `Bearer ${input.accessToken}` },
    method: "POST",
    signal: input.signal
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new MatePreviewApiError(response.status, errorCode(payload.error));
  const stored = record(payload.file, "workspace_attachment_upload_invalid_response");
  const objectId = boundedText(stored.objectId, 180, "workspace_attachment_upload_invalid_response");
  const fileName = boundedText(stored.fileName, 180, "workspace_attachment_upload_invalid_response");
  return {
    downloadUrl: `/api/workspace-files/${encodeURIComponent(objectId)}/download`,
    fileName,
    mediaType: optionalText(stored.mediaType, 260) || input.file.type || "application/octet-stream",
    objectId,
    rawUrl: `/api/workspace-files/${encodeURIComponent(objectId)}/raw`,
    sizeBytes: typeof stored.sizeBytes === "number" && Number.isSafeInteger(stored.sizeBytes) ? stored.sizeBytes : input.file.size
  };
}

export async function downloadMateWorkspaceFile(input: {
  accessToken: string;
  fetch?: typeof globalThis.fetch;
  session: MatePreviewSession;
  url: string;
  previewName?: string;
}) {
  if (input.session.mode !== "live") throw new MatePreviewApiError(405, "owner_test_workspace_write_forbidden");
  const objectId = workspaceObjectIdFromUrl(input.url);
  const fetcher = input.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new MatePreviewApiError(503, "runtime_workspace_fetch_unavailable");
  const requestUrl = new URL(runtimeWorkspaceUrl(input.session, `workspace-files/${encodeURIComponent(objectId)}/download`));
  if (input.previewName) {
    requestUrl.searchParams.set("preview", "markdown");
    requestUrl.searchParams.set("fileName", input.previewName);
  }
  const response = await fetchReadWithRetry(fetcher, requestUrl, {
    headers: { authorization: `Bearer ${input.accessToken}` },
    method: "GET"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    throw new MatePreviewApiError(response.status, errorCode(payload.error));
  }
  return response.blob();
}

export async function saveMateWorkspaceFileToKnowledge(input: {
  accessToken: string;
  fetch?: typeof globalThis.fetch;
  parentObjectId: string;
  session: MatePreviewSession;
  url: string;
}): Promise<{ knowledgeFile: { objectId: string; path: string } }> {
  if (input.session.mode !== "live") throw new MatePreviewApiError(405, "owner_test_workspace_write_forbidden");
  const artifactId = workspaceObjectIdFromUrl(input.url);
  if (!/^art_[0-9a-f-]{36}$/.test(artifactId)) throw new MatePreviewApiError(400, "mate_artifact_reference_invalid");
  const fetcher = input.fetch ?? globalThis.fetch;
  const response = await fetcher(runtimeWorkspaceUrl(input.session, `workspace-files/${artifactId}/knowledge`), {
    body: JSON.stringify({ parentObjectId: input.parentObjectId }),
    headers: { accept: "application/json", authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
    method: "POST"
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new MatePreviewApiError(response.status, errorCode(payload.error));
  const knowledgeFile = record(payload.knowledgeFile, "mate_artifact_knowledge_upload_invalid_response");
  return {
    knowledgeFile: {
      objectId: boundedText(knowledgeFile.objectId, 180, "mate_artifact_knowledge_upload_invalid_response"),
      path: boundedText(knowledgeFile.path, 1200, "mate_artifact_knowledge_upload_invalid_response")
    }
  };
}

export async function requestMateRuntimeProfile(input: {
  fetch?: typeof globalThis.fetch;
  session: MatePreviewSession;
  signal?: AbortSignal;
}): Promise<MateRuntimeCapabilityProfile> {
  const fetcher = input.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new MatePreviewApiError(503, "runtime_profile_fetch_unavailable");
  const url = new URL(
    `/v1/${input.session.mode === "preview" ? "owner-test/" : ""}mates/${encodeURIComponent(input.session.mate.id)}/runtime`,
    input.session.runtimeOrigin
  );
  const response = await fetcher(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.session.accessToken}`
    },
    method: "GET",
    signal: input.signal
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new MatePreviewApiError(response.status, errorCode(payload.error));
  return normalizeRuntimeCapabilities(payload.capabilities);
}

export async function requestMateConversationPage(input: {
  fetch?: typeof globalThis.fetch;
  session: MatePreviewSession;
  signal?: AbortSignal;
  status: "active" | "archived";
  cursor?: string;
}): Promise<{ items: MateRuntimeDirectoryItem[]; nextCursor: string | null }> {
  const url = new URL(
    `/v1/${input.session.mode === "preview" ? "owner-test/" : ""}mates/${encodeURIComponent(input.session.mate.id)}/conversations`,
    input.session.runtimeOrigin
  );
  url.searchParams.set("status", input.status);
  if (input.cursor) url.searchParams.set("cursor", input.cursor);
  const response = await (input.fetch ?? globalThis.fetch)(url, {
    headers: { accept: "application/json", authorization: `Bearer ${input.session.accessToken}` },
    signal: input.signal
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new MatePreviewApiError(response.status, errorCode(payload.error));
  if (!Array.isArray(payload.conversations)) throw new MatePreviewApiError(502, "runtime_collection_response_invalid");
  return { items: normalizeRuntimeDirectoryItems(payload.conversations, "conversations"),
    nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : null };
}

export async function requestMateRuntimeCollection(
  input: {
    fetch?: typeof globalThis.fetch;
    session: MatePreviewSession;
    signal?: AbortSignal;
  },
  resource: "conversations" | "tasks"
): Promise<MateRuntimeDirectoryItem[]> {
  const fetcher = input.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new MatePreviewApiError(503, "runtime_collection_fetch_unavailable");
  const values = await fetchRuntimeCollectionValues(fetcher, input, resource);
  if (!Array.isArray(values)) throw new MatePreviewApiError(502, "runtime_collection_response_invalid");
  const items = normalizeRuntimeDirectoryItems(values, resource);
  if (resource !== "tasks" || input.session.mode !== "live") return items;

  // A future reminder is already a scheduled Task from the user's point of
  // view, even though its execution Task is created only when it becomes due.
  // Keep the execution API strict and merge only this directory projection.
  const reminders = await fetchRuntimeCollectionValues(fetcher, input, "reminders").catch(() => []);
  return [
    ...normalizeScheduledDirectoryItems(reminders),
    ...items
  ];
}

async function fetchRuntimeCollectionValues(
  fetcher: typeof globalThis.fetch,
  input: {
    session: MatePreviewSession;
    signal?: AbortSignal;
  },
  resource: "conversations" | "reminders" | "tasks"
) {
  const url = new URL(
    `/v1/${input.session.mode === "preview" ? "owner-test/" : ""}mates/${encodeURIComponent(input.session.mate.id)}/${resource}`,
    input.session.runtimeOrigin
  );
  const response = await fetcher(url, {
    headers: { accept: "application/json", authorization: `Bearer ${input.session.accessToken}` },
    method: "GET",
    signal: input.signal
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new MatePreviewApiError(response.status, errorCode(payload.error));
  return payload[resource];
}

function normalizeRuntimeDirectoryItems(values: unknown[], resource: "conversations" | "tasks") {
  return values.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (resource === "conversations" && item.channel !== "sdk") return [];
    const id = optionalText(item.id, 180);
    if (!id) return [];
    return [{
      id,
      pinned: item.pinnedAt != null,
      status: optionalText(item.status, 80),
      title: runtimeCollectionTitle(item, resource),
      updatedAt: optionalText(item.updatedAt, 100) || optionalText(item.createdAt, 100)
    }];
  });
}

function normalizeScheduledDirectoryItems(values: unknown) {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value): MateRuntimeDirectoryItem[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const reminder = value as Record<string, unknown>;
    const id = optionalText(reminder.id, 180);
    const title = optionalText(reminder.title, 500);
    if (!id || !title) return [];
    const status = optionalText(reminder.status, 80) || "active";
    const nextDueAt = optionalText(reminder.nextDueAt, 100);
    return [{
      id: `scheduled-${id}`,
      pinned: false,
      status: `scheduled · ${status}`,
      title,
      updatedAt: nextDueAt
    }];
  });
}

export type MateRuntimeDirectoryItem = {
  id: string;
  pinned: boolean;
  status?: string;
  title: string;
  updatedAt?: string;
};

export async function updateMateConversation(input: {
  fetch?: typeof globalThis.fetch;
  patch: { pinned?: boolean; status?: "active" | "archived"; title?: string };
  session: MatePreviewSession;
  signal?: AbortSignal;
  conversationId: string;
}): Promise<MateRuntimeDirectoryItem> {
  const payload = await mutateConversation(input, "PATCH", input.patch);
  return normalizeConversationItem(record(payload.conversation, "runtime_conversation_response_invalid"));
}

export async function deleteMateConversation(input: {
  fetch?: typeof globalThis.fetch;
  session: MatePreviewSession;
  signal?: AbortSignal;
  conversationId: string;
}) {
  const payload = await mutateConversation(input, "DELETE");
  const conversation = record(payload.conversation, "runtime_conversation_response_invalid");
  if (conversation.deleted !== true || conversation.id !== input.conversationId) {
    throw new MatePreviewApiError(502, "runtime_conversation_response_invalid");
  }
  return { id: input.conversationId, deleted: true as const };
}

async function mutateConversation(
  input: {
    fetch?: typeof globalThis.fetch;
    session: MatePreviewSession;
    signal?: AbortSignal;
    conversationId: string;
  },
  method: "DELETE" | "PATCH",
  body?: Record<string, unknown>
) {
  const fetcher = input.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new MatePreviewApiError(503, "runtime_collection_fetch_unavailable");
  const url = new URL(
    `/v1/${input.session.mode === "preview" ? "owner-test/" : ""}mates/${encodeURIComponent(input.session.mate.id)}/conversations/${encodeURIComponent(input.conversationId)}`,
    input.session.runtimeOrigin
  );
  const response = await fetcher(url, {
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.session.accessToken}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    method,
    signal: input.signal
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new MatePreviewApiError(response.status, errorCode(payload.error));
  return payload;
}

function normalizeConversationItem(item: Record<string, unknown>): MateRuntimeDirectoryItem {
  return {
    id: boundedText(item.id, 180, "runtime_conversation_response_invalid"),
    pinned: item.pinnedAt != null,
    status: optionalText(item.status, 80),
    title: runtimeCollectionTitle(item, "conversations"),
    updatedAt: optionalText(item.updatedAt, 100) || optionalText(item.createdAt, 100)
  };
}

export async function clearMatePreviewData(input: {
  fetch?: typeof globalThis.fetch;
  session: MatePreviewSession;
  signal?: AbortSignal;
}) {
  if (input.session.mode !== "preview") {
    throw new MatePreviewApiError(405, "preview_cleanup_only");
  }
  const fetcher = input.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new MatePreviewApiError(503, "runtime_collection_fetch_unavailable");
  }
  const url = new URL(
    `/v1/owner-test/mates/${encodeURIComponent(input.session.mate.id)}/conversations`,
    input.session.runtimeOrigin
  );
  const response = await fetcher(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.session.accessToken}`
    },
    method: "DELETE",
    signal: input.signal
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new MatePreviewApiError(response.status, errorCode(payload.error));
  const cleared = record(payload.cleared, "preview_cleanup_response_invalid");
  return {
    deletedConversations: nonNegativeInteger(cleared.deletedConversations, "preview_cleanup_response_invalid"),
    deletedSessions: nonNegativeInteger(cleared.deletedSessions, "preview_cleanup_response_invalid"),
    scheduledAgentInstances: nonNegativeInteger(cleared.scheduledAgentInstances, "preview_cleanup_response_invalid")
  };
}

function runtimeCollectionTitle(item: Record<string, unknown>, resource: "conversations" | "tasks") {
  const title = optionalText(item.title, 500);
  if (title) return title;
  const instruction = optionalText(item.instruction, 500);
  if (instruction && !instruction.startsWith("agent-do-message:")) return instruction;
  return resource === "conversations" ? "未命名对话" : "未命名任务";
}

function normalizeRuntimeCapabilities(value: unknown): MateRuntimeCapabilityProfile {
  const source = record(value, "runtime_profile_response_invalid");
  const models = record(source.models, "runtime_profile_response_invalid");
  const multimodal = optionalRecord(models.multimodal);
  const allowedModels = Array.isArray(models.allowed) ? models.allowed.map((value) => {
    const model = record(value, "runtime_profile_response_invalid");
    return {
      id: boundedText(model.id, 180, "runtime_profile_response_invalid"),
      name: modelDisplayName(boundedText(model.id, 180, "runtime_profile_response_invalid"), optionalText(model.name, 300))
    };
  }) : [];
  const normalizeResources = <Kind extends "app_mcp" | "knowledge_service">(
    resources: unknown,
    kind: Kind
  ) => Array.isArray(resources) ? resources.flatMap((value) => {
    const resource = record(value, "runtime_profile_response_invalid");
    if (resource.kind !== kind || resource.authorization !== "invoking_user") return [];
    return [{
      allowedOperations: stringList(resource.allowedOperations),
      allowedToolNames: stringList(resource.allowedToolNames),
      authorization: "invoking_user" as const,
      description: optionalText(resource.description, 1_000),
      id: boundedText(resource.id, 180, "runtime_profile_response_invalid"),
      kind,
      name: optionalText(resource.name, 300)
    }];
  }) : [];
  return {
    appMcp: normalizeResources(source.appMcp, "app_mcp").map(({ allowedOperations: _, ...resource }) => resource),
    knowledge: normalizeResources(source.knowledge, "knowledge_service").map(({ allowedToolNames: _, ...resource }) => resource),
    models: {
      allowUserSelection: models.allowUserSelection === true,
      allowed: allowedModels,
      defaultModel: boundedText(models.defaultModel, 180, "runtime_profile_response_invalid"),
      multimodal: {
        audioInput: multimodal?.audioInput === true,
        documentInput: multimodal?.documentInput === true,
        imageInput: multimodal?.imageInput === true
      }
    },
    tools: Array.isArray(source.tools) ? source.tools.flatMap((value) => {
      const item = record(value, "runtime_profile_response_invalid");
      if (item.kind !== "built_in_tool" || item.authorization !== "current_user_context" || item.status !== "ready") return [];
      return [{
        authorization: "current_user_context" as const,
        id: boundedText(item.id, 180, "runtime_profile_response_invalid"),
        kind: "built_in_tool" as const,
        provider: optionalText(item.provider, 180),
        status: "ready" as const,
        surfaces: stringList(item.surfaces),
        writeRequiresApproval: item.writeRequiresApproval === true || undefined
      }];
    }) : []
  };
}

function runtimeWorkspaceUrl(session: MatePreviewSession, suffix: string) {
  return new URL(
    `/v1/${session.mode === "preview" ? "owner-test/" : ""}mates/${encodeURIComponent(session.mate.id)}/${suffix}`,
    session.runtimeOrigin
  );
}

function workspaceObjectIdFromUrl(value: string) {
  const match = typeof value === "string" ? value.match(/^\/api\/workspace-files\/([^/]+)\/(?:raw|download)$/) : null;
  try {
    const objectId = decodeURIComponent(match?.[1] || "");
    if (!/^[A-Za-z0-9_.-]{1,180}$/.test(objectId)) throw new Error();
    return objectId;
  } catch {
    throw new MatePreviewApiError(400, "workspace_file_reference_invalid");
  }
}

export class MatePreviewApiError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly status: number;

  constructor(status: number, code: string, requestId?: string) {
    super(code);
    this.name = "MatePreviewApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export async function requestMatePreviewSession(input: {
  conversationId?: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  newConversation?: boolean;
  releaseId: string;
  signal?: AbortSignal;
  mateId: string;
}): Promise<MatePreviewSession> {
  const mateId = identifier(input.mateId, "mate_id_invalid", 400);
  const releaseId = identifier(input.releaseId, "release_id_invalid", 400);
  const conversationId = input.conversationId
    ? identifier(input.conversationId, "conversation_id_invalid", 400)
    : undefined;
  const fetcher = input.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new MatePreviewApiError(503, "preview_session_fetch_unavailable");
  const endpoint = sameOriginEndpoint(input.endpoint ?? DEFAULT_SESSION_ENDPOINT);
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      body: JSON.stringify({
        ...(conversationId ? { conversationId } : {}),
        ...(input.newConversation ? { newConversation: true } : {}),
        releaseId,
        mateId
      }),
      credentials: "include",
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      signal: input.signal
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new MatePreviewApiError(503, "preview_session_unavailable");
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new MatePreviewApiError(
      response.status,
      errorCode(payload.error),
      optionalText(payload.requestId, 180)
    );
  }
  return normalizeSession(payload.session, {
    ...(conversationId ? { conversationId } : {}),
    mode: "preview",
    releaseId,
    mateId
  });
}

export async function requestMateLiveSession(input: {
  conversationId?: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  newConversation?: boolean;
  signal?: AbortSignal;
  mateId: string;
}): Promise<MatePreviewSession> {
  const mateId = identifier(input.mateId, "mate_id_invalid", 400);
  const conversationId = input.conversationId
    ? identifier(input.conversationId, "conversation_id_invalid", 400)
    : undefined;
  const fetcher = input.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new MatePreviewApiError(503, "live_session_fetch_unavailable");
  const endpoint = sameOriginEndpoint(input.endpoint ?? "/api/mate-runtime/live-sessions");
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      body: JSON.stringify({
        ...(conversationId ? { conversationId } : {}),
        ...(input.newConversation ? { newConversation: true } : {}),
        mateId
      }),
      credentials: "include",
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      signal: input.signal
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new MatePreviewApiError(503, "live_session_unavailable");
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new MatePreviewApiError(response.status, errorCode(payload.error), optionalText(payload.requestId, 180));
  }
  return normalizeSession(payload.session, {
    ...(conversationId ? { conversationId } : {}),
    mode: "live",
    mateId
  });
}

function normalizeSession(
  value: unknown,
  expected: { conversationId?: string; mode: "live" | "preview"; releaseId?: string; mateId: string }
): MatePreviewSession {
  const source = record(value, "preview_session_response_invalid");
  const mate = record(source.mate, "preview_session_response_invalid");
  const release = record(source.release, "preview_session_response_invalid");
  const user = optionalRecord(source.user);
  const mateId = identifier(mate.id, "preview_session_response_invalid");
  const releaseId = identifier(release.id, "preview_session_response_invalid");
  const mateAvatarUrl = optionalAvatarUrl(mate.avatarUrl);
  const userAvatarUrl = optionalAvatarUrl(user?.avatarUrl);
  const userName = optionalText(user?.name, 300);
  const mateDescription = optionalText(mate.description, 1_000);
  const mateJobRole = optionalText(mate.jobRole, 300);
  const manifestSha256 = optionalDigest(release.manifestSha256);
  const releaseVersion = positiveInteger(release.version);
  if (
    mateId !== expected.mateId
    || (expected.releaseId && releaseId !== expected.releaseId)
    || source.mode !== expected.mode
  ) {
    throw new MatePreviewApiError(502, "preview_session_coordinate_mismatch");
  }
  const conversationId = identifier(source.conversationId, "preview_session_response_invalid");
  const conversationState = source.conversationState === "draft" || source.conversationState === "persisted"
    ? source.conversationState
    : undefined;
  if (!conversationState) throw new MatePreviewApiError(502, "preview_session_response_invalid");
  const conversationRecovered = expected.mode === "live" && source.conversationRecovered === true;
  if (
    source.conversationRecovered !== undefined
    && (source.conversationRecovered !== true || expected.mode !== "live")
  ) {
    throw new MatePreviewApiError(502, "preview_session_response_invalid");
  }
  if (expected.conversationId && conversationId !== expected.conversationId && !conversationRecovered) {
    throw new MatePreviewApiError(502, "preview_session_conversation_mismatch");
  }
  const accessToken = boundedText(source.accessToken, 16_384, "preview_session_response_invalid");
  return {
    accessToken,
    conversationId,
    conversationState,
    expiresAt: futureTimestamp(source.expiresAt),
    mode: expected.mode,
    principalKey: boundedText(source.principalKey, 256, "preview_session_response_invalid", 8),
    runtimeOrigin: runtimeOrigin(source.runtimeOrigin),
    mate: {
      ...(mateAvatarUrl ? { avatarUrl: mateAvatarUrl } : {}),
      ...(mateDescription ? { description: mateDescription } : {}),
      displayName: boundedText(mate.displayName, 300, "preview_session_response_invalid"),
      id: mateId,
      ...(mateJobRole ? { jobRole: mateJobRole } : {})
    },
    release: {
      id: releaseId,
      ...(manifestSha256 ? { manifestSha256 } : {}),
      ...(releaseVersion ? { version: releaseVersion } : {})
    },
    surface: normalizeSurface(source.surface),
    ...(userName ? { user: {
      ...(userAvatarUrl ? { avatarUrl: userAvatarUrl } : {}),
      name: userName
    } } : {})
  };
}

function normalizeSurface(value: unknown): MatePreviewSurface {
  const source = record(value, "preview_session_response_invalid");
  const kind = source.kind === "conversation" || source.kind === "task_inbox" || source.kind === "unavailable"
    ? source.kind
    : undefined;
  if (!kind || !Array.isArray(source.channels)) {
    throw new MatePreviewApiError(502, "preview_session_response_invalid");
  }
  const channels = Array.from(new Set(source.channels.map((channel) => {
    if (channel === "sdk" || channel === "email" || channel === "schedule" || channel === "mate_call") return channel;
    throw new MatePreviewApiError(502, "preview_session_response_invalid");
  })));
  const executor = source.defaultExecutor;
  const defaultExecutor = executor === "operations" || executor === "knowledge_qa" || executor === "app_mcp"
    ? executor
    : undefined;
  if (!Array.isArray(source.entries)) {
    throw new MatePreviewApiError(502, "preview_session_response_invalid");
  }
  const entries = source.entries.map((value) => {
    const entry = record(value, "preview_session_response_invalid");
    const channel = entry.channel;
    const entryKind = entry.kind;
    if (
      (channel !== "sdk" && channel !== "email" && channel !== "schedule" && channel !== "mate_call")
      || (entryKind !== "conversation" && entryKind !== "task_inbox")
      || (channel === "sdk") !== (entryKind === "conversation")
    ) throw new MatePreviewApiError(502, "preview_session_response_invalid");
    return { channel, kind: entryKind } as MatePreviewEntry;
  });
  if (new Set(entries.map((entry) => entry.channel)).size !== entries.length) {
    throw new MatePreviewApiError(502, "preview_session_response_invalid");
  }
  if (channels.length !== entries.length || channels.some((channel) => !entries.some((entry) => entry.channel === channel))) {
    throw new MatePreviewApiError(502, "preview_session_response_invalid");
  }
  if (kind === "conversation" && !entries.some((entry) => entry.kind === "conversation")) {
    throw new MatePreviewApiError(502, "preview_session_response_invalid");
  }
  if (kind === "task_inbox" && !entries.some((entry) => entry.kind === "task_inbox")) {
    throw new MatePreviewApiError(502, "preview_session_response_invalid");
  }
  if (kind === "unavailable" && (channels.length > 0 || entries.length > 0)) {
    throw new MatePreviewApiError(502, "preview_session_response_invalid");
  }
  return {
    channels,
    ...(defaultExecutor ? { defaultExecutor } : {}),
    entries,
    kind
  };
}

export function readPreviewConversationCoordinate(
  storage: Pick<Storage, "getItem"> | undefined,
  mateId: string,
  releaseId: string
) {
  if (!storage) return undefined;
  try {
    const value = storage.getItem(previewConversationStorageKey(mateId, releaseId));
    return value ? identifier(value, "conversation_id_invalid") : undefined;
  } catch {
    return undefined;
  }
}

export function storePreviewConversationCoordinate(
  storage: Pick<Storage, "setItem"> | undefined,
  mateId: string,
  releaseId: string,
  conversationId: string
) {
  if (!storage) return;
  try {
    storage.setItem(
      previewConversationStorageKey(mateId, releaseId),
      identifier(conversationId, "conversation_id_invalid")
    );
  } catch {
    // The Host remains usable when managed browsers disable sessionStorage.
  }
}

export function clearPreviewConversationCoordinate(
  storage: Pick<Storage, "removeItem"> | undefined,
  mateId: string,
  releaseId: string
) {
  if (!storage) return;
  try {
    storage.removeItem(previewConversationStorageKey(mateId, releaseId));
  } catch {
    // The Task Inbox surface does not depend on browser storage.
  }
}

function previewConversationStorageKey(mateId: string, releaseId: string) {
  return [
    "workspace.mate-preview.conversation.v1",
    identifier(mateId, "mate_id_invalid"),
    identifier(releaseId, "release_id_invalid")
  ].join(":");
}

function runtimeOrigin(value: unknown) {
  try {
    const url = new URL(boundedText(value, 500, "preview_session_response_invalid"));
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:"))
      || url.origin !== url.toString().replace(/\/$/, "")
      || url.username
      || url.password
    ) throw new Error("invalid_origin");
    return url.origin;
  } catch {
    throw new MatePreviewApiError(502, "preview_session_response_invalid");
  }
}

function identifier(value: unknown, code: string, status = 502) {
  const output = typeof value === "string" ? value.trim() : "";
  if (!IDENTIFIER_PATTERN.test(output)) throw new MatePreviewApiError(status, code);
  return output;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MatePreviewApiError(502, code);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())))
    : [];
}

function boundedText(value: unknown, maximum: number, code: string, minimum = 1) {
  const output = typeof value === "string" ? value.trim() : "";
  if (output.length < minimum || output.length > maximum || /[\u0000-\u001f\u007f]/.test(output)) {
    throw new MatePreviewApiError(502, code);
  }
  return output;
}

function optionalText(value: unknown, maximum: number) {
  if (value === undefined || value === null || value === "") return undefined;
  try { return boundedText(value, maximum, "preview_session_response_invalid"); }
  catch { throw new MatePreviewApiError(502, "preview_session_response_invalid"); }
}

function optionalAvatarUrl(value: unknown) {
  const text = optionalText(value, 1_200_000);
  if (!text) return undefined;
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/]+=*$/i.test(text)) return text;
  if (text.startsWith("/") && !text.startsWith("//")) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") throw new Error("invalid_url");
    return url.toString();
  } catch {
    throw new MatePreviewApiError(502, "preview_session_response_invalid");
  }
}

function optionalDigest(value: unknown) {
  const text = optionalText(value, 80);
  if (!text) return undefined;
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) throw new MatePreviewApiError(502, "preview_session_response_invalid");
  return text;
}

function positiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function nonNegativeInteger(value: unknown, code: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new MatePreviewApiError(502, code);
  }
  return value;
}

function futureTimestamp(value: unknown) {
  const text = boundedText(value, 80, "preview_session_response_invalid");
  const epoch = Date.parse(text);
  if (!Number.isFinite(epoch) || epoch <= Date.now()) {
    throw new MatePreviewApiError(502, "preview_session_response_invalid");
  }
  return text;
}

function sameOriginEndpoint(value: string) {
  const endpoint = typeof value === "string" ? value.trim() : "";
  if (!endpoint.startsWith("/") || endpoint.startsWith("//") || /[\\?#\u0000-\u001f\u007f]/.test(endpoint)) {
    throw new MatePreviewApiError(400, "preview_session_endpoint_invalid");
  }
  return endpoint;
}

function errorCode(value: unknown) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{2,95}$/.test(value)
    ? value
    : "preview_session_request_failed";
}
