export type User = { id: string; name: string; email: string; avatarUrl?: string };
export type AuthSession = { authenticated: true; user: User };
export type Mate = { id: string; displayName: string; jobRole: string; description: string; avatarUrl?: string; workEmail?: string; isDefault?: boolean; status?: string };
export type Conversation = { id: string; title: string; updatedAt?: string; pinned?: boolean; status?: string };
/** Short-lived credential authorising one conversation's chat transport. */
export type ChatGrant = { grant: string; expiresAt: string };
export type ChatPart = {
  approval?: { approved?: boolean; id: string; reason?: string };
  data?: unknown;
  errorText?: string;
  filename?: string;
  id?: string;
  input?: unknown;
  mediaType?: string;
  sizeBytes?: number;
  output?: unknown;
  sourceId?: string;
  state?: string;
  text?: string;
  title?: string;
  toolCallId?: string;
  toolName?: string;
  type: string;
  url?: string;
};
export type ChatMessage = { id: string; role: "assistant" | "system" | "user"; parts: ChatPart[]; metadata?: unknown };
export type ChatCapabilitySelection = { appIds: string[]; knowledgeServiceIds: string[]; modelId?: string };
export type RuntimeCapability = { id: string; name?: string; description?: string };
export type KnowledgeLibraryItem = {
  id: string;
  kind: "folder" | "file";
  name: string;
  description?: string;
  collaboratorCount?: number;
  collaboratorUserIds?: string[];
  effectiveRole?: "owner" | "collaborator" | "viewer";
  access?: "owner" | "collaborator" | "viewer";
  parentPath?: string;
  path?: string;
  modifiedAt?: string;
  sizeBytes?: number;
  mimeType?: string;
};
export type KnowledgeLibraryRecentFile = {
  serviceName?: string;
  item: { objectId: string; fileName: string; relativePath?: string; mimeType?: string; sizeBytes?: number; updatedAt?: string };
};
export type KnowledgeLibraryHome = {
  items: KnowledgeLibraryItem[];
  recentFiles: KnowledgeLibraryRecentFile[];
};
export type KnowledgeLibraryFile = {
  file: { fileName: string; mimeType: string; modifiedAt?: string };
  content: { encoding: "text"; text: string } | { encoding: "base64"; base64: string };
};
export type RuntimeProfile = {
  appMcp: RuntimeCapability[];
  knowledge: RuntimeCapability[];
  models: {
    allowUserSelection: boolean;
    allowed: Array<{ id: string; name: string }>;
    defaultModel: string;
    multimodal: { audioInput: boolean; documentInput: boolean; imageInput: boolean };
  };
  tools: Array<RuntimeCapability & { writeRequiresApproval?: boolean }>;
};
export type UploadedAttachment = { downloadUrl?: string; fileName: string; mediaType: string; objectId: string; rawUrl: string; sizeBytes: number; localPath?: string };
export type { RuntimeApproval } from "../../../src/shared/mateApprovalPresentation";
export type LiveSession = {
  accessToken: string;
  conversationId: string;
  conversations?: Conversation[];
  conversationState: "draft" | "persisted";
  expiresAt: string;
  principalKey: string;
  release?: { id: string };
  mate: Mate;
};
