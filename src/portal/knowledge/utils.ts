import type {
  KnowledgeAccessKind,
  KnowledgeApiItem,
  KnowledgeCapabilities,
  KnowledgeItem,
  KnowledgeKind,
  KnowledgeRole,
  KnowledgeSection,
  KnowledgeServiceAccess,
  KnowledgeServiceAccessMode,
  KnowledgeTranslate
} from "./types";

export function normalizeKnowledgeServiceAccess(access: unknown): {
  mode: KnowledgeServiceAccessMode;
  targets: string[];
} | undefined {
  if (!isRecord(access)
    || typeof access.company !== "boolean"
    || !Array.isArray(access.users)
    || access.users.some((id) => typeof id !== "string")
    || !Array.isArray(access.departments)
    || access.departments.some((id) => typeof id !== "string")) {
    return undefined;
  }
  if (access.company) {
    return { mode: "company", targets: [] };
  }
  const targets = [
    ...access.departments.map((id) => `department:${id}`),
    ...access.users.map((id) => `user:${id}`)
  ];
  return {
    mode: targets.length > 0 ? "targeted" : "private",
    targets
  };
}

export function knowledgeServiceAccessPayload(
  mode: KnowledgeServiceAccessMode,
  targets: string[]
): Required<KnowledgeServiceAccess> {
  return {
    company: mode === "company",
    departments: mode === "targeted"
      ? targets.flatMap((value) => value.startsWith("department:") ? [value.slice("department:".length)] : [])
      : [],
    users: mode === "targeted"
      ? targets.flatMap((value) => value.startsWith("user:") ? [value.slice("user:".length)] : [])
      : []
  };
}

export async function knowledgeFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${knowledgeApiBase()}${path}`, {
    credentials: "include",
    ...init,
    headers: init.headers
  });
  const text = await response.text();
  const payload = text ? parseJson(text) : {};

  if (!response.ok) {
    const message = typeof payload.message === "string" ? payload.message : typeof payload.error === "string" ? payload.error : response.statusText;
    throw new Error(message || `HTTP ${response.status}`);
  }

  return payload as T;
}

export function knowledgeApiBase() {
  const configured = import.meta.env.VITE_KNOWLEDGE_WORKER_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  if (isLocalHost(window.location.hostname)) {
    return "http://127.0.0.1:8794/k";
  }

  return "/k";
}

export function knowledgeViewerUrl(item: KnowledgeItem, options: { embedded: boolean }) {
  const suffix = options.embedded ? "?embed=modal" : "";
  return `${knowledgeApiBase()}/view/${encodeURIComponent(item.id)}${suffix}`;
}

export function knowledgeAgentHandoffText(
  item: Pick<KnowledgeItem, "id" | "kind" | "name">,
  displayPath: string,
  locale: "en" | "zh-CN"
) {
  const isFolder = item.kind === "folder";
  const path = displayPath.trim() || item.name;
  const lines = locale === "zh-CN"
    ? [
        `请通过 Workspace MCP 接手这个知识库${isFolder ? "文件夹" : "文件"}。`,
        "",
        `${isFolder ? "文件夹" : "文件"}路径：${path}`,
        `Object ID：${item.id}`,
        "",
        isFolder
          ? `请先调用 knowledge_list，传入 folderObjectId="${item.id}"，列出当前文件夹内容。`
          : `请先调用 knowledge_file_read，传入 objectId="${item.id}"，读取这个文件的最新内容。`,
        "先向我确认你理解的任务目标；后续只围绕这个目标和路径工作。涉及上传、编辑、重命名、移动、删除或分享等写入操作时，执行前先征得我的明确同意。"
      ]
    : [
        `Take over this Knowledge ${isFolder ? "folder" : "file"} through Workspace MCP.`,
        "",
        `${isFolder ? "Folder" : "File"} path: ${path}`,
        `Object ID: ${item.id}`,
        "",
        isFolder
          ? `First call knowledge_list with folderObjectId="${item.id}" to list the current folder.`
          : `First call knowledge_file_read with objectId="${item.id}" to read the latest file content.`,
        "Confirm your understanding of my goal first, then stay within that goal and path. Ask for my explicit approval before uploading, editing, renaming, moving, deleting, sharing, or taking any other write action."
      ];

  return lines.join("\n");
}

export function knowledgeWorkspaceAgentPrompt(locale: "en" | "zh-CN") {
  const lines = locale === "zh-CN"
    ? [
        "请通过 Workspace MCP 帮我使用知识库，并始终以当前连接用户的权限为边界。",
        "",
        "1. 先调用 knowledge_list 列出我有权读取的知识库文件夹；如果有 serviceId，需要使用说明时再调用 knowledge_service_handbook。",
        "2. 回答问题时，使用 knowledge_query 按 folderObjectId 搜索文本，再用 knowledge_file_read 按 objectId 读取相关原文，给出基于来源的答案。",
        "3. 创建或维护我的知识库时，先用 knowledge_list、knowledge_file_read 和 knowledge_file_versions 确认目标文件夹和当前版本，再按需使用 knowledge_library_write。",
        "4. 上传、编辑、重命名、移动、分享或删除前，先说明目标和影响；删除必须获得我的明确确认。",
        "",
        "请先问我今天要提问、创建还是维护什么内容。需要完整示例时，请查询 Frontier Workspace How To 知识库中的 Workspace MCP 知识库指南。"
      ]
    : [
        "Help me use Knowledge through Workspace MCP, always within the current connected user's permissions.",
        "",
        "1. First call knowledge_list to list Knowledge folders I may read. If a folder has a serviceId, call knowledge_service_handbook when guidance is needed.",
        "2. For questions, use knowledge_query with folderObjectId to search text, then knowledge_file_read with objectId to read relevant source content. Answer from those sources.",
        "3. To create or maintain my Knowledge library, first use knowledge_list, knowledge_file_read, and knowledge_file_versions to confirm the target folder and current version, then use knowledge_library_write as needed.",
        "4. Explain the target and impact before uploading, editing, renaming, moving, sharing, or deleting. Deletion always requires my explicit confirmation.",
        "",
        "Start by asking whether I want to ask, create, or maintain something today. For complete examples, query the Workspace MCP Knowledge guide in the Frontier Workspace How To knowledge base."
      ];

  return lines.join("\n");
}

export function downloadKnowledgeItem(item: KnowledgeItem) {
  if (item.kind === "folder") {
    return;
  }

  window.open(`${knowledgeApiBase()}/api/files/${encodeURIComponent(item.id)}/download`, "_blank", "noopener,noreferrer");
}

export function normalizeApiItem(item: KnowledgeApiItem): KnowledgeItem {
  const access = normalizeRole(item.effectiveRole ?? item.access);
  const kind = normalizeKind(item.kind ?? item.contentKind ?? item.objectKind);
  const parentPath = item.parentPath ?? "";
  const isRootFolder = kind === "folder" && !parentPath;
  const reportedAgentEnabled = Boolean(item.agentEnabled ?? item.knowledgeService?.enabled ?? item.skillReady);
  const agentEnabled = isRootFolder && reportedAgentEnabled;
  const withinKnowledgeService = isRootFolder
    ? reportedAgentEnabled
    : Boolean(
      item.withinKnowledgeService
        || item.knowledgeServiceAvailable
        || reportedAgentEnabled
        || item.knowledgeServiceId
    );
  const knowledgeServiceAccess = item.accessKind === "knowledge_service"
    || item.accessKinds?.includes("knowledge_service")
    || (access === "viewer" && withinKnowledgeService);
  const accessKinds = normalizeAccessKinds(item.accessKinds, item.accessKind, access, knowledgeServiceAccess);
  const ownerUserId = item.ownerUserId ?? item.owner ?? "";
  return {
    access,
    accessKind: accessKinds.length === 1 ? accessKinds[0] : undefined,
    accessKinds,
    agentEnabled,
    capabilities: normalizeCapabilities(item.capabilities, access, withinKnowledgeService, isRootFolder),
    collaboratorCount: normalizedCollaboratorCount(item, access),
    collaboratorUserIds: Array.isArray(item.collaboratorUserIds) ? item.collaboratorUserIds.map(String) : [],
    currentVersionId: stringValue(item.currentVersionId),
    description: item.description ?? "",
    knowledgeServiceCard: item.knowledgeServiceCard,
    feedbackEnabled: item.feedbackEnabled,
    handbookObjectId: stringValue(item.handbookObjectId ?? item.knowledgeService?.handbookObjectId),
    id: item.id,
    indexStatus: stringValue(item.indexStatus ?? item.knowledgeService?.indexStatus),
    kind,
    knowledgeServiceId: stringValue(item.knowledgeServiceId ?? item.knowledgeService?.id),
    maintenanceTeam: item.maintenanceTeam?.trim() ?? "",
    modifiedAt: item.modifiedAt ?? new Date().toISOString(),
    mimeType: item.mimeType ?? "",
    name: item.name,
    owner: item.owner ?? ownerUserId,
    ownerUserId,
    parentPath,
    path: item.path ?? joinKnowledgePath(parentPath, item.name),
    shareMode: normalizeShareMode(item.shareMode),
    sizeBytes: Number(item.sizeBytes ?? 0),
    skillReady: item.skillReady,
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    version: item.version ?? "",
    withinKnowledgeService
  };
}

export function knowledgeVersionUploadFormData(file: File, expectedCurrentVersionId: string) {
  if (!expectedCurrentVersionId) {
    throw new Error("knowledge_current_version_missing");
  }

  const formData = new FormData();
  formData.set("expectedCurrentVersionId", expectedCurrentVersionId);
  formData.set("file", file);
  return formData;
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? `${fallback} (${error.message})` : fallback;
}

export function filteredItems(items: KnowledgeItem[], activeSection: KnowledgeSection, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  let scoped = items;

  if (activeSection === "recent") {
    scoped = [...items].sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt)).slice(0, 10);
  }

  const filtered = normalizedQuery
    ? scoped.filter((item) => [item.name, item.path, item.owner, item.description, item.maintenanceTeam, ...item.tags].some((value) => value.toLowerCase().includes(normalizedQuery)))
    : scoped;

  return [...filtered].sort((left, right) => {
    if (left.kind === "folder" && right.kind !== "folder") {
      return -1;
    }
    if (left.kind !== "folder" && right.kind === "folder") {
      return 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export function pathBreadcrumbs(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.map((label, index) => ({
    label,
    path: parts.slice(0, index + 1).join("/")
  }));
}

export function folderPathLabel(item: KnowledgeItem, t: KnowledgeTranslate) {
  const root = t("knowledge.nav.myFiles");
  return item.parentPath ? `${root} / ${item.parentPath}` : root;
}

export function knowledgeRelativePathLabel(item: KnowledgeItem, basePath = "") {
  const path = normalizeDisplayPath(item.path || joinKnowledgePath(item.parentPath, item.name));
  const base = normalizeDisplayPath(basePath);

  if (base && (path === base || path.startsWith(`${base}/`))) {
    return path.slice(base.length).replace(/^\/+/, "") || item.name;
  }

  return path || item.name;
}

export function joinKnowledgePath(parentPath: string, name: string) {
  return [parentPath, name].filter(Boolean).join("/");
}

export function knowledgeSectionFromPath(): KnowledgeSection {
  const path = (window.location.hash.replace(/^#/, "") || window.location.pathname).split("?")[0] ?? "/knowledge";
  if (path === "/knowledge/recent" || path.startsWith("/knowledge/recent/")) {
    return "recent";
  }
  return "my";
}

export function folderNameError(name: string) {
  if (!name) {
    return "knowledge.folderNameRequired" as const;
  }
  if (name === "." || name === ".." || /[\\/]/.test(name) || /[\u0000-\u001f]/.test(name)) {
    return "knowledge.folderNameInvalid" as const;
  }
  return "";
}

export function knowledgeItemNameError(name: string) {
  if (!name) {
    return "knowledge.nameRequired" as const;
  }
  if (name === "." || name === ".." || /[\\/]/.test(name) || /[\u0000-\u001f]/.test(name)) {
    return "knowledge.nameInvalid" as const;
  }
  return "";
}

export function kindLabel(kind: KnowledgeKind, t: KnowledgeTranslate) {
  return {
    binary: t("knowledge.kind.binary"),
    folder: t("knowledge.kind.folder"),
    html: t("knowledge.kind.html"),
    image: t("knowledge.kind.image"),
    markdown: t("knowledge.kind.markdown"),
    pdf: t("knowledge.kind.pdf"),
    text: t("knowledge.kind.text")
  }[kind];
}

export function accessLabel(access: KnowledgeRole, t: KnowledgeTranslate) {
  return {
    collaborator: t("knowledge.access.collaborator"),
    owner: t("knowledge.access.owner"),
    viewer: t("knowledge.access.viewer")
  }[access];
}

export function canEditKnowledgeItem(item: KnowledgeItem) {
  return item.capabilities.canEdit;
}

export function canDeleteKnowledgeItem(item: KnowledgeItem) {
  return item.capabilities.canEdit
    && !item.agentEnabled
    && (item.kind !== "folder" || Boolean(item.parentPath) || item.capabilities.canManageProtectedStructure);
}

export function canRenameKnowledgeItem(item: KnowledgeItem) {
  return canDeleteKnowledgeItem(item);
}

export function canDirectlyEditKnowledgeItem(item: KnowledgeItem) {
  return item.kind !== "folder"
    && item.capabilities.canEdit
    && /\.(txt|md|markdown|csv|json|jsonl|ndjson|html|htm)$/i.test(item.name);
}

export function canCreateKnowledgePublicShare(item: KnowledgeItem) {
  return item.kind !== "folder" && item.capabilities.canCreatePublicShare;
}

export function canManageKnowledgeAccess(item: KnowledgeItem) {
  return item.kind === "folder" && !item.parentPath && item.capabilities.canManageAccess;
}

export function canManageKnowledgeService(item: KnowledgeItem) {
  return item.kind === "folder" && !item.parentPath && item.capabilities.canManageKnowledgeService;
}

export function canUpdateKnowledgeServiceInfo(item: KnowledgeItem) {
  return item.kind === "folder"
    && !item.parentPath
    && item.agentEnabled
    && item.capabilities.canUpdateKnowledgeServiceInfo;
}

export function knowledgeAccessScopeLabel(item: KnowledgeItem, t: KnowledgeTranslate) {
  const role = accessLabel(item.access, t);
  return item.parentPath
    ? t("knowledge.accessInheritedFromRoot", { role })
    : role;
}

export function knowledgeSharingScope(item: Pick<KnowledgeItem, "access" | "collaboratorCount" | "collaboratorUserIds">) {
  if (item.access === "viewer") {
    return { count: 0, kind: "shared" as const };
  }
  const count = Math.max(
    item.collaboratorCount,
    item.collaboratorUserIds.length,
    item.access === "collaborator" ? 1 : 0
  );
  return count > 0
    ? { count, kind: "collaboration" as const }
    : { count: 0, kind: "private" as const };
}

export function knowledgeAgentAccessLabel(item: KnowledgeItem, t: KnowledgeTranslate) {
  if (item.agentEnabled) {
    return t("knowledge.agentAccessEnabled");
  }
  if (item.withinKnowledgeService) {
    return t("knowledge.agentAccessIncluded");
  }
  if (item.parentPath) {
    return t("knowledge.agentAccessManagedByRoot");
  }
  return t("knowledge.agentAccessDisabled");
}

export function knowledgeIndexStatusLabel(status: string | undefined, t: KnowledgeTranslate) {
  const key = status?.trim().toLowerCase();
  if (key === "ready") return t("knowledge.indexStatusReady");
  if (key === "indexing") return t("knowledge.indexStatusIndexing");
  if (key === "stale") return t("knowledge.indexStatusStale");
  if (key === "error" || key === "failed") return t("knowledge.indexStatusError");
  if (key === "disabled") return t("knowledge.indexStatusDisabled");
  return t("knowledge.indexStatusPending");
}

export function shareModeLabel(mode: KnowledgeItem["shareMode"], t: KnowledgeTranslate) {
  return {
    company: t("knowledge.share.company"),
    private: t("knowledge.share.private"),
    public: t("knowledge.share.public"),
    team: t("knowledge.share.team")
  }[mode];
}

export function formatDate(value: string, locale: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(timestamp)
    : value;
}

export function formatBytes(value: number, locale: string) {
  if (value <= 0) {
    return "0 KB";
  }

  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: "unit", unit: value >= 1_000_000 ? "megabyte" : "kilobyte", unitDisplay: "short" }).format(value >= 1_000_000 ? value / 1_000_000 : value / 1_000);
}

function normalizeKind(value: unknown): KnowledgeKind {
  const kind = String(value ?? "binary");
  if (kind === "folder" || kind === "html" || kind === "markdown" || kind === "image" || kind === "pdf" || kind === "text" || kind === "binary") {
    return kind;
  }
  return "binary";
}

function normalizeRole(value: unknown): KnowledgeRole {
  if (value === "owner") {
    return "owner";
  }
  if (value === "collaborator" || value === "editor") {
    return "collaborator";
  }
  // Capability fallbacks must fail closed when an older or malformed API
  // response omits the effective role. The current API always returns owner
  // explicitly for a user's own objects.
  return "viewer";
}

function normalizeAccessKinds(
  values: unknown,
  value: unknown,
  access: KnowledgeRole,
  agentEnabled: boolean
): KnowledgeAccessKind[] {
  const candidates = Array.isArray(values) ? values : [value];
  const kinds = candidates.filter((candidate): candidate is KnowledgeAccessKind => (
    candidate === "collaboration" || candidate === "knowledge_service"
  ));
  if (access === "collaborator" && !kinds.includes("collaboration")) {
    kinds.push("collaboration");
  }
  if (agentEnabled && !kinds.includes("knowledge_service")) {
    kinds.push("knowledge_service");
  }
  return kinds;
}

function normalizeCapabilities(
  value: unknown,
  access: KnowledgeRole,
  knowledgeServiceAvailable: boolean,
  isRootFolder: boolean
): KnowledgeCapabilities {
  const capabilities = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const canEdit = booleanValue(capabilities.canEdit, access !== "viewer");
  const isOwner = access === "owner";
  return {
    canCreatePublicShare: booleanValue(capabilities.canCreatePublicShare ?? capabilities.canShare, access !== "viewer"),
    canEdit,
    canManageAccess: isRootFolder && booleanValue(capabilities.canManageAccess, isOwner),
    canManageKnowledgeService: isRootFolder && booleanValue(capabilities.canManageKnowledgeService, isOwner),
    canUpdateKnowledgeServiceInfo: isRootFolder && booleanValue(capabilities.canUpdateKnowledgeServiceInfo, access !== "viewer"),
    canManageProtectedStructure: booleanValue(capabilities.canManageProtectedStructure, isOwner),
    canReadChangeAudit: booleanValue(capabilities.canReadChangeAudit, access !== "viewer"),
    canTransferOwnership: isRootFolder && booleanValue(capabilities.canTransferOwnership, isOwner),
    canUseKnowledgeService: booleanValue(capabilities.canUseKnowledgeService, knowledgeServiceAvailable)
  };
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function normalizeShareMode(value: unknown): KnowledgeItem["shareMode"] {
  return value === "team" || value === "company" || value === "public" ? value : "private";
}

function normalizedCollaboratorCount(item: KnowledgeApiItem, access: KnowledgeRole) {
  const explicitCount = Number(item.collaboratorCount);
  const listedCount = Array.isArray(item.collaboratorUserIds) ? item.collaboratorUserIds.length : 0;
  return Math.max(
    Number.isFinite(explicitCount) && explicitCount >= 0 ? Math.floor(explicitCount) : 0,
    listedCount,
    access === "collaborator" ? 1 : 0
  );
}

function normalizeDisplayPath(value: string) {
  return value.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string) {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isLocalHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

export function portalMutationHeaders(json = false) {
  const headers: Record<string, string> = {
    "Idempotency-Key": `portal:${crypto.randomUUID()}`,
    "x-workspace-source-channel": "portal"
  };
  if (json) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}
