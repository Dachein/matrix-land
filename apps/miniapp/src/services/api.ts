import Taro from "@tarojs/taro";
import type { AuthSession, ChatMessage, Conversation, KnowledgeLibraryFile, KnowledgeLibraryHome, KnowledgeLibraryItem, LiveSession, RuntimeApproval, RuntimeProfile, Mate, UploadedAttachment } from "../types";
import { state } from "../state";
import { AuthRequiredError, isAuthRequiredError } from "./auth";
import { mockConversations, mockMessages, mockSession, mockMates, mockUser } from "./mock";
import { API_BASE, ApiError, requestJson, requestJsonResponse, USE_MOCKS } from "./request";
import { loadChatHistory } from "./chatHistory";
import { MateProvisionIncompleteError, quickMateCode } from "./quickCreate";
import { hydrateSessionMate, isRuntimeSessionInvalid, shouldRefreshSession } from "./sessionRecovery";
import { resolvedMediaType } from "./fileTypes";

const MINIAPP_API = "/api/miniapp/v1";

/**
 * Guards a page against a missing local web session. Every entry page calls this so
 * an expired session lands on the login page instead of surfacing as a generic
 * "无法加载" error deeper in the flow.
 */
export function requireAuth() {
  if (USE_MOCKS) return true;
  if (state.getUser()) return true;
  void Taro.redirectTo({ url: "/pages/login/index" });
  return false;
}

/** Clears the local session and routes back to login. Used on a 401/403 from any round trip. */
export function redirectToLogin(clear = true) {
  if (clear) state.clearAuth();
  void Taro.redirectTo({ url: "/pages/login/index" });
}

export async function requestEmailCode(email: string) {
  if (USE_MOCKS) return { challengeId: "mock_challenge", expiresIn: 600 };
  return requestJson<{ challengeId: string; expiresIn: number }>({
    url: `${MINIAPP_API}/auth/email/login`,
    method: "POST",
    data: { email, redirect: "/home", returnTo: "/home" }
  });
}

export async function verifyEmailCode(challengeId: string, code: string) {
  if (USE_MOCKS) { state.setUser(mockUser); return mockUser; }
  const payload = await requestJson<AuthSession>({
    url: `${MINIAPP_API}/auth/email/login/verify`,
    method: "POST",
    data: { challengeId, code }
  });
  const user = payload.user || (await requestJson<AuthSession>({ url: `${MINIAPP_API}/auth/session` })).user;
  state.setUser(user);
  return user;
}

export async function loginWithScanTicket(ticket: string) {
  if (USE_MOCKS) { state.setUser(mockUser); return mockUser; }
  const payload = await requestJson<AuthSession>({
    url: `${MINIAPP_API}/auth/scan/exchange`,
    method: "POST",
    data: { ticket }
  });
  state.setUser(payload.user);
  return payload.user;
}

export async function prepareScanLoginTicket(ticket: string) {
  if (USE_MOCKS) return { user: mockUser, expiresAt: new Date(Date.now() + 120_000).toISOString() };
  return requestJson<{ expiresAt: string; user: { email: string; name: string } }>({
    url: `${MINIAPP_API}/auth/scan/prepare`,
    method: "POST",
    data: { ticket }
  });
}

export async function logout() {
  if (!USE_MOCKS) await requestJson<{ authenticated: false }>({ url: `${MINIAPP_API}/auth/logout` });
  state.clearAuth();
}

/** The miniapp auth response omits the portal profile photo, so hydrate it separately. */
export async function refreshCurrentUserProfile() {
  const cached = state.getUser();
  if (!cached || USE_MOCKS) return cached;
  const payload = await requestJson<{ user?: { id?: string; name?: string; avatarUrl?: string } }>({
    url: `/api/users/${encodeURIComponent(cached.id)}/profile`
  });
  if (payload.user?.id !== cached.id) return cached;
  const user = {
    ...cached,
    name: payload.user.name || cached.name,
    avatarUrl: payload.user.avatarUrl || cached.avatarUrl
  };
  state.setUser(user);
  return user;
}

export async function listMates(options: { force?: boolean } = {}): Promise<Mate[]> {
  const cached = state.getMates().filter((mate) => mate.status !== "archived");
  if (!options.force && state.hasMatesCache()) {
    if (cached.length !== state.getMates().length) state.setMates(cached);
    return cached;
  }
  if (USE_MOCKS) { state.setMates(mockMates); return mockMates; }
  const payload = await requestJson<{ mates?: Mate[] }>({ url: `${MINIAPP_API}/mates` });
  const mates = (Array.isArray(payload.mates) ? payload.mates : []).filter((mate) => mate.status !== "archived");
  state.setMates(mates);
  return mates;
}

export async function getMate(mateId: string): Promise<Mate> {
  if (USE_MOCKS) {
    const cached = state.getMates().find((item) => item.id === mateId);
    if (cached) return cached;
    throw new Error("mate_not_found");
  }
  const payload = await requestJson<{ mate: Mate }>({ url: `${MINIAPP_API}/mates/${encodeURIComponent(mateId)}` });
  return payload.mate;
}

export async function getDefaultMate(): Promise<Mate | null> {
  if (USE_MOCKS) return state.getMates().find((mate) => mate.isDefault) || null;
  const payload = await requestJson<{ mate: Mate | null }>({ url: `${MINIAPP_API}/mates/default` });
  return payload.mate;
}

export async function activateDefaultMate(input: { displayName: string; avatarUrl: string }): Promise<Mate> {
  if (USE_MOCKS) {
    const mate = { id: "default-mate", displayName: input.displayName, avatarUrl: input.avatarUrl, jobRole: "个人工作秘书", description: "", isDefault: true, status: "published" };
    state.setMates([mate, ...state.getMates().filter((mate) => mate.id !== mate.id)]);
    return mate;
  }
  const payload = await requestJson<{ mate: Mate }>({ url: `${MINIAPP_API}/mates/default`, method: "POST", data: input, timeoutMs: 70_000 });
  state.requestMatesRefresh();
  return payload.mate;
}

export async function createQuickMate(input: { displayName: string; jobRole: string; description: string; avatarUrl?: string }) {
  if (USE_MOCKS) return { ...input, id: `mate_${Date.now()}`, status: "准备中" } satisfies Mate;
  type ProvisionedMate = Mate & { activeReleaseId?: string; previewReleaseId?: string };
  const code = quickMateCode(input.displayName);
  const created = await requestJson<{ mate: ProvisionedMate }>({
    url: `${MINIAPP_API}/mates`,
    method: "POST",
    data: {
      ...input,
      creationProfile: "personal_mate",
      avatarUrl: input.avatarUrl || "",
      workEmail: `${code}@mate.example.invalid`
    }
  });
  try { return await deployAndPublishMate(created.mate.id); }
  catch (caught) {
    if (isAuthRequiredError(caught)) throw caught;
    throw new MateProvisionIncompleteError(created.mate.id, caught);
  }
}

export async function updateMateIdentity(mate: Mate, input: { displayName: string; jobRole: string; avatarUrl: string }) {
  if (USE_MOCKS) return { ...mate, ...input };
  await requestJson({
    url: `${MINIAPP_API}/mates/${encodeURIComponent(mate.id)}`,
    method: "PATCH",
    data: input
  });
  try { return await deployAndPublishMate(mate.id); }
  catch (caught) {
    if (isAuthRequiredError(caught)) throw caught;
    throw new MateProvisionIncompleteError(mate.id, caught);
  }
}

export async function deleteMate(mateId: string) {
  if (!USE_MOCKS) await requestJson<{ archived: boolean }>({
    url: `${MINIAPP_API}/mates/${encodeURIComponent(mateId)}`,
    method: "DELETE"
  });
}

async function deployAndPublishMate(mateId: string) {
  type ProvisionedMate = Mate & { activeReleaseId?: string; previewReleaseId?: string };
  const deployed = await requestJson<{ release?: { id?: string } }>({
    url: `${MINIAPP_API}/mates/${encodeURIComponent(mateId)}/deploy`, method: "POST"
  });
  const releaseId = deployed.release?.id;
  if (!releaseId) throw new Error("mate_deploy_failed");
  await requestJson({
    url: `${MINIAPP_API}/mates/${encodeURIComponent(mateId)}/releases/${encodeURIComponent(releaseId)}/publish`, method: "POST"
  });
  const refreshed = await requestJson<{ mate: ProvisionedMate }>({
    url: `${MINIAPP_API}/mates/${encodeURIComponent(mateId)}`
  });
  return refreshed.mate;
}

export async function createLiveSession(
  mate: Mate,
  conversationId?: string,
  options: { includeConversations?: boolean; newConversation?: boolean } = {}
): Promise<LiveSession> {
  if (USE_MOCKS) {
    const session = mockSession(mate, conversationId);
    if (options.includeConversations) session.conversations = mockConversations;
    return session;
  }
  const newConversation = options.newConversation ?? !conversationId;
  const payload = await requestJson<{ conversations?: Array<Record<string, unknown>>; session: LiveSession }>({
    url: `${MINIAPP_API}/sessions`,
    method: "POST",
    data: {
      mateId: mate.id,
      ...(conversationId ? { conversationId } : {}),
      ...(newConversation ? { newConversation: true } : {}),
      ...(options.includeConversations ? { includeConversations: true } : {})
    }
  });
  const session = hydrateSessionMate(payload.session, mate);
  if (Array.isArray(payload.conversations)) {
    session.conversations = normalizeConversations(payload.conversations);
  }
  state.setLiveSession(session);
  return session;
}

export async function listConversations(session: LiveSession, options: { force?: boolean } = {}): Promise<Conversation[]> {
  if (USE_MOCKS) return mockConversations;
  if (session.conversations && !options.force) return session.conversations;
  const payload = await requestJson<{ conversations?: Array<Record<string, unknown>> }>({
    url: miniappRuntimePath(session, ""),
    headers: { authorization: `Bearer ${session.accessToken}` }
  });
  return normalizeConversations(payload.conversations || []);
}

function normalizeConversations(items: Array<Record<string, unknown>>): Conversation[] {
  return items.filter((item) => item.channel === "sdk").map((item) => ({
    id: String(item.id), title: String(item.title || "未命名对话"),
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
    pinned: Boolean(item.pinnedAt), status: typeof item.status === "string" ? item.status : undefined
  }));
}

export type ChatGrant = { grant: string; expiresAt: string };

export async function loadMessages(session: LiveSession, grant?: ChatGrant): Promise<ChatMessage[]> {
  if (USE_MOCKS) return mockMessages;
  if (session.conversationState === "draft") return [];
  const activeGrant = grant ?? await createChatGrant(session);
  return loadChatHistory(activeGrant, {
    page: (current, cursor) => requestJsonResponse<unknown>({
      url: `${chatUrl(session, "chat/get-messages", current.grant, "https")}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    }),
    refreshGrant: () => createChatGrant(session)
  });
}

export async function createChatGrant(session: LiveSession) {
  if (USE_MOCKS) return { grant: "mock_chat_grant", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
  return requestJson<ChatGrant>({
    url: miniappRuntimePath(session, `/${encodeURIComponent(session.conversationId)}/chat-grants`),
    method: "POST",
    headers: { authorization: `Bearer ${session.accessToken}` }
  });
}

export async function loadRuntimeProfile(session: LiveSession): Promise<RuntimeProfile> {
  if (USE_MOCKS) return {
    appMcp: [{ id: "crm", name: "客户关系管理", description: "读取和更新客户信息" }],
    knowledge: [{ id: "investment-research", name: "投研知识库", description: "内部研究与产品资料" }],
    models: { allowUserSelection: true, allowed: [{ id: "cf-openai-gpt-6-luna", name: "GPT-6 Luna" }], defaultModel: "cf-openai-gpt-6-luna", multimodal: { audioInput: false, documentInput: true, imageInput: true } },
    tools: [{ id: "public_web_search", name: "网页搜索" }, { id: "document_read", name: "文档读取" }]
  };
  const payload = await requestJson<{ capabilities: RuntimeProfile }>({
    url: `${MINIAPP_API}/mates/${encodeURIComponent(session.mate.id)}/runtime`,
    headers: runtimeHeaders(session)
  });
  return payload.capabilities;
}

export async function loadKnowledgeLibraryHome(): Promise<KnowledgeLibraryHome> {
  if (USE_MOCKS) return { items: [{ id: "investment-research", kind: "folder", name: "投研知识库", description: "内部研究与产品资料", effectiveRole: "owner" }], recentFiles: [] };
  const payload = await requestJson<KnowledgeLibraryHome>({ url: `${MINIAPP_API}/knowledge-library/home`, timeoutMs: 60_000 });
  return { items: Array.isArray(payload.items) ? payload.items : [], recentFiles: Array.isArray(payload.recentFiles) ? payload.recentFiles : [] };
}

export async function loadKnowledgeLibraryFolder(folderId: string): Promise<KnowledgeLibraryItem[]> {
  if (USE_MOCKS) return [];
  const payload = await requestJson<{ items?: KnowledgeLibraryItem[] }>({ url: `${MINIAPP_API}/knowledge-library/folders/${encodeURIComponent(folderId)}` });
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function readKnowledgeLibraryFile(fileId: string): Promise<KnowledgeLibraryFile> {
  if (USE_MOCKS) return { file: { fileName: "example.md", mimeType: "text/markdown" }, content: { encoding: "text", text: "# Example" } };
  return requestJson<KnowledgeLibraryFile>({ url: `${MINIAPP_API}/knowledge-library/files/${encodeURIComponent(fileId)}`, timeoutMs: 60_000 });
}

export async function uploadAttachment(session: LiveSession, file: { path: string; name: string; size?: number; type?: string }): Promise<UploadedAttachment> {
  validateUploadFile(file);
  return withFileSession(session, (active) => uploadAttachmentOnce(active, file));
}

async function uploadAttachmentOnce(session: LiveSession, file: { path: string; name: string; size?: number; type?: string }): Promise<UploadedAttachment> {
  if (USE_MOCKS) return { fileName: file.name, mediaType: resolvedMediaType(file), objectId: `mock_${Date.now()}`, rawUrl: `/api/workspace-files/mock_${Date.now()}/raw`, sizeBytes: file.size || 0, localPath: file.path };
  if (file.size && file.size > 20 * 1024 * 1024) throw new Error("upload_file_too_large");
  if (file.size && file.size > 8 * 1024 * 1024) {
    const payload = await uploadLargeFile(file, "mate", session.mate.id, session.accessToken) as { file?: UploadedAttachment };
    if (!payload?.file || typeof payload.file.objectId !== "string" || !/^[A-Za-z0-9_.-]{1,180}$/.test(payload.file.objectId) || [".", ".."].includes(payload.file.objectId)) throw new Error("upload_response_invalid");
    return { ...payload.file, rawUrl: `/api/workspace-files/${encodeURIComponent(payload.file.objectId)}/raw`, localPath: file.path };
  }
  const cookie = state.getCookie();
  const response = await Taro.uploadFile({
    url: `${API_BASE}${MINIAPP_API}/mates/${encodeURIComponent(session.mate.id)}/workspace-attachments`,
    filePath: file.path,
    name: "file",
    formData: { fileName: file.name, mediaType: resolvedMediaType(file) },
    header: { accept: "application/json", authorization: `Bearer ${session.accessToken}`, ...(cookie ? { cookie } : {}) }
  });
  let payload: { error?: string; file?: UploadedAttachment } | null = null;
  try { payload = JSON.parse(response.data); } catch { /* Invalid 2xx bodies fail validation below. */ }
  assertFileResponse(response.statusCode, payload, "upload");
  if (!payload?.file || typeof payload.file.objectId !== "string" || !/^[A-Za-z0-9_.-]{1,180}$/.test(payload.file.objectId) || [".", ".."].includes(payload.file.objectId)) throw new Error("upload_response_invalid");
  return { ...payload.file, rawUrl: `/api/workspace-files/${encodeURIComponent(payload.file.objectId)}/raw`, localPath: file.path };
}

export async function uploadKnowledgeFile(file: { path: string; name: string; size?: number; type?: string }, parentObjectId?: string) {
  validateUploadFile(file);
  if (USE_MOCKS) return { item: { id: `mock_${Date.now()}`, name: file.name } };
  if (file.size && file.size > 20 * 1024 * 1024) throw new Error("upload_file_too_large");
  if (file.size && file.size > 8 * 1024 * 1024) {
    return uploadLargeFile(file, "knowledge", undefined, undefined, parentObjectId) as Promise<{ item: { id: string; name: string } }>;
  }
  const cookie = state.getCookie();
  const response = await Taro.uploadFile({
    url: `${API_BASE}${MINIAPP_API}/knowledge-library/files`,
    filePath: file.path,
    name: "file",
    formData: { fileName: file.name, mediaType: resolvedMediaType(file), ...(parentObjectId ? { parentObjectId } : {}) },
    header: { accept: "application/json", ...(cookie ? { cookie } : {}) }
  });
  let payload: { error?: string; item?: { id: string; name: string } } | null = null;
  try { payload = JSON.parse(response.data); } catch { /* handled below */ }
  if (response.statusCode < 200 || response.statusCode >= 300 || !payload?.item?.id) {
    const code = String(payload?.error || (response.statusCode >= 200 && response.statusCode < 300 ? "upload_response_invalid" : `upload_http_${response.statusCode}`));
    if (response.statusCode === 403) throw new Error("knowledge_upload_forbidden");
    if (isAuthRequiredError({ code, status: response.statusCode })) throw new AuthRequiredError(code);
    throw new Error(code);
  }
  return payload;
}

async function uploadLargeFile(
  file: { path: string; name: string; size?: number; type?: string },
  target: "knowledge" | "mate",
  mateId?: string,
  accessToken?: string,
  parentObjectId?: string
) {
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error("upload_file_too_large");
  const started = await requestJson<{ uploadId: string; chunkBytes: number }>({
    url: `${MINIAPP_API}/file-uploads`, method: "POST",
    data: { target, fileName: file.name, mediaType: resolvedMediaType(file), sizeBytes: file.size, ...(mateId ? { mateId } : {}), ...(parentObjectId ? { parentObjectId } : {}) }
  });
  if (typeof started?.uploadId !== "string" || !/^[0-9a-f-]{36}$/.test(started.uploadId)) throw new Error("upload_response_invalid");
  const chunkBytes = started.chunkBytes;
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 8 * 1024 * 1024) throw new Error("upload_chunk_size_invalid");
  const fs = Taro.getFileSystemManager();
  for (let index = 0, position = 0; position < file.size; index += 1, position += chunkBytes) {
    const length = Math.min(chunkBytes, file.size - position);
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => fs.readFile({
      filePath: file.path, position, length,
      success: (result) => result.data instanceof ArrayBuffer ? resolve(result.data) : reject(new Error("upload_chunk_read_invalid")),
      fail: reject
    }));
    if (bytes.byteLength !== length) throw new Error("upload_chunk_read_invalid");
    const response = await Taro.request<{ error?: string }>({
      url: `${API_BASE}${MINIAPP_API}/file-uploads/${encodeURIComponent(started.uploadId)}/chunks/${index}`,
      method: "PUT", data: bytes, timeout: 60_000,
      header: { "content-type": "application/octet-stream", ...(state.getCookie() ? { cookie: state.getCookie() } : {}) }
    });
    assertFileResponse(response.statusCode, response.data, "upload_chunk");
  }
  const response = await Taro.request<Record<string, unknown> & { error?: string }>({
    url: `${API_BASE}${MINIAPP_API}/file-uploads/${encodeURIComponent(started.uploadId)}/complete`,
    method: "POST", timeout: 90_000,
    header: { accept: "application/json", ...(state.getCookie() ? { cookie: state.getCookie() } : {}), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) }
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const code = String(response.data?.error || `upload_http_${response.statusCode}`);
    if (target === "knowledge" && response.statusCode === 403) throw new Error("knowledge_upload_forbidden");
    assertFileResponse(response.statusCode, response.data, "upload");
  }
  if (target === "knowledge" && !(response.data?.item as { id?: string } | undefined)?.id) throw new Error("upload_response_invalid");
  return response.data;
}

export async function downloadWorkspaceFile(session: LiveSession, url: string) {
  return downloadWorkspaceVariant(session, url, "download");
}
export async function downloadWorkspaceThumbnail(session: LiveSession, url: string) {
  return downloadWorkspaceVariant(session, url, "thumbnail");
}
async function downloadWorkspaceVariant(session: LiveSession, url: string, variant: "download" | "thumbnail") {
  const objectId = workspaceObjectId(url);
  return withFileSession(session, async (active) => {
    const response = await Taro.downloadFile({
      url: `${API_BASE}${MINIAPP_API}/mates/${encodeURIComponent(active.mate.id)}/workspace-files/${encodeURIComponent(objectId)}/${variant}`,
      header: runtimeHeaders(active), timeout: 60_000
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      let body: unknown;
      try {
        const text = await new Promise<string>((resolve, reject) => Taro.getFileSystemManager().readFile({
          filePath: response.tempFilePath, encoding: "utf8", length: 4096,
          success: (result) => resolve(String(result.data)), fail: reject
        }));
        body = JSON.parse(text);
      } catch { /* A bare unauthorized response still routes to login. */ }
      assertFileResponse(response.statusCode, body, "download");
    }
    if (typeof response.tempFilePath !== "string" || !response.tempFilePath) throw new Error("download_response_invalid");
    return response.tempFilePath;
  });
}

export async function listApprovals(session: LiveSession): Promise<RuntimeApproval[]> {
  if (USE_MOCKS) return [];
  const payload = await requestJson<{ approvals?: RuntimeApproval[] }>({
    url: `${MINIAPP_API}/mates/${encodeURIComponent(session.mate.id)}/approvals`, headers: runtimeHeaders(session)
  });
  return payload.approvals || [];
}

export async function listApprovalTasks(session: LiveSession): Promise<NonNullable<RuntimeApproval["task"]>[]> {
  if (USE_MOCKS) return [];
  const payload = await requestJson<{ tasks?: NonNullable<RuntimeApproval["task"]>[] }>({
    url: `${MINIAPP_API}/mates/${encodeURIComponent(session.mate.id)}/tasks?conversationId=${encodeURIComponent(session.conversationId)}`,
    headers: runtimeHeaders(session)
  });
  return payload.tasks || [];
}

export async function saveWorkspaceFileToKnowledge(session: LiveSession, url: string, parentObjectId: string) {
  const objectId = workspaceObjectId(url);
  if (!/^art_[0-9a-f-]{36}$/.test(objectId)) throw new Error("mate_artifact_reference_invalid");
  return withFileSession(session, async (active) => {
    const response = await Taro.request<{ error?: string; knowledgeFile?: { objectId: string; path: string } }>({
      url: `${API_BASE}${MINIAPP_API}/mates/${encodeURIComponent(active.mate.id)}/workspace-files/${encodeURIComponent(objectId)}/knowledge`,
      method: "POST", timeout: 60_000,
      header: { ...runtimeHeaders(active), "content-type": "application/json", ...(state.getCookie() ? { cookie: state.getCookie() } : {}) }, data: { parentObjectId }
    });
    assertFileResponse(response.statusCode, response.data, "knowledge_save");
    if (!response.data?.knowledgeFile?.objectId) throw new Error("knowledge_save_not_confirmed");
    return response.data as { knowledgeFile: { objectId: string; path: string } };
  });
}

export async function decideRuntimeApproval(session: LiveSession, approvalId: string, decision: "approve" | "deny") {
  return requestJson({
    url: `${MINIAPP_API}/mates/${encodeURIComponent(session.mate.id)}/approvals/${encodeURIComponent(approvalId)}/decision`,
    method: "POST", headers: runtimeHeaders(session), data: { decision }
  });
}

/**
 * Pin / rename / delete a conversation. The mini-program drives these from the chat
 * session drawer (`useConversationActions`); the server routes are in
 * `workers/miniapp-api/src/routes.ts`.
 */
export async function updateConversation(session: LiveSession, conversationId: string, patch: { pinned?: boolean; title?: string }) {
  return requestJson({ url: miniappRuntimePath(session, `/${encodeURIComponent(conversationId)}`), method: "PATCH", headers: runtimeHeaders(session), data: patch });
}

export async function deleteConversation(session: LiveSession, conversationId: string) {
  return requestJson({ url: miniappRuntimePath(session, `/${encodeURIComponent(conversationId)}`), method: "DELETE", headers: runtimeHeaders(session) });
}

export function chatUrl(session: LiveSession, action: string, grant: string, protocol: "https" | "wss") {  const httpUrl = `${API_BASE}${miniappRuntimePath(
    session,
    `/${encodeURIComponent(session.conversationId)}/${action}?grant=${encodeURIComponent(grant)}`
  )}`;
  return protocol === "wss" ? httpUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") : httpUrl;
}

export async function createConversation(session: LiveSession, title: string) {
  if (session.conversationState !== "draft") return session;
  const payload = await requestJson<{ conversation?: { channel?: string; id?: string } }>({
    url: miniappRuntimePath(session, ""),
    method: "POST",
    headers: { authorization: `Bearer ${session.accessToken}` },
    data: {
      channel: "sdk",
      conversationId: session.conversationId,
      title: title.trim().slice(0, 160)
    }
  });
  if (payload.conversation?.id !== session.conversationId || payload.conversation.channel !== "sdk") {
    throw new Error("conversation_create_failed");
  }
  session.conversationState = "persisted";
  state.setLiveSession(session);
  return session;
}

function miniappRuntimePath(session: LiveSession, suffix: string) {
  return `${MINIAPP_API}/mates/${encodeURIComponent(session.mate.id)}/conversations${suffix}`;
}

function runtimeHeaders(session: LiveSession) { return { authorization: `Bearer ${session.accessToken}` }; }
function workspaceObjectId(value: string) {
  const match = value.match(/^\/api\/workspace-files\/([^/]+)\/(?:raw|download)$/);
  if (!match) throw new Error("workspace_file_reference_invalid");
  try {
    const id = decodeURIComponent(match[1]);
    if (/^[A-Za-z0-9_.-]{1,180}$/.test(id) && id !== "." && id !== "..") return id;
  } catch { /* Reject malformed escapes before attaching credentials. */ }
  throw new Error("workspace_file_reference_invalid");
}

function validateUploadFile(file: { name: string; size?: number }) {
  if (!file.name || file.name.length > 255 || file.name === "." || file.name === ".." || /[\\/\u0000-\u001f]/.test(file.name)) throw new Error("upload_file_name_invalid");
  if (file.size !== undefined && (!Number.isInteger(file.size) || file.size <= 0)) throw new Error("upload_file_size_invalid");
  if (file.size !== undefined && file.size > 20 * 1024 * 1024) throw new Error("upload_file_too_large");
}

function assertFileResponse(status: number, data: unknown, operation: string) {
  if (status >= 200 && status < 300) return;
  const body = data as { error?: unknown } | undefined;
  const code = typeof body?.error === "string" ? body.error : `${operation}_http_${status}`;
  if ((status === 401 && code !== "runtime_token_invalid") || isAuthRequiredError({ code })) throw new AuthRequiredError(code);
  if (status === 403) throw new FileAccessDeniedError(code);
  throw new ApiError(status, code);
}

/** A file permission denial is not an expired login session. */
export class FileAccessDeniedError extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = "FileAccessDeniedError"; this.code = code; }
}

const fileSessionRenewals = new Map<string, Promise<LiveSession>>();
function sameFileSession(left: LiveSession | undefined, right: LiveSession) {
  return left?.principalKey === right.principalKey && left?.mate.id === right.mate.id && left?.conversationId === right.conversationId;
}
async function renewFileSession(session: LiveSession) {
  const key = `${session.principalKey}:${session.mate.id}:${session.conversationId}:${session.accessToken}`;
  const pending = fileSessionRenewals.get(key);
  if (pending) return pending;
  const renewal = (async () => {
    const payload = await requestJson<{ session: LiveSession }>({
      url: `${MINIAPP_API}/sessions`, method: "POST", data: { mateId: session.mate.id, ...(session.conversationState === "draft" ? { newConversation: true } : { conversationId: session.conversationId }) }
    });
    const hydrated = hydrateSessionMate(payload.session, session.mate);
    const next = session.conversationState === "draft" ? { ...hydrated, conversationId: session.conversationId, conversationState: "draft" as const } : hydrated;
    if (!sameFileSession(next, session)) throw new Error("file_session_mismatch");
    if (sameFileSession(state.getLiveSession(), session)) state.setLiveSession(next);
    return next;
  })();
  fileSessionRenewals.set(key, renewal);
  try { return await renewal; } finally { fileSessionRenewals.delete(key); }
}
async function withFileSession<T>(session: LiveSession, run: (active: LiveSession) => Promise<T>): Promise<T> {
  if (USE_MOCKS) return run(session);
  const cached = state.getLiveSession();
  let active = sameFileSession(cached, session) ? cached! : session;
  if (shouldRefreshSession(active)) active = await renewFileSession(active);
  try { return await run(active); }
  catch (error) {
    // Only an explicit rejected token is safe to retry; uncertain writes are not replayed.
    if (!isRuntimeSessionInvalid(error)) throw error;
    return run(await renewFileSession(active));
  }
}
