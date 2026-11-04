import type { useI18n } from "../i18n";

export type KnowledgeTranslate = ReturnType<typeof useI18n>["t"];
export type KnowledgeNoticeTone = "info" | "success" | "warning" | "error";
export type KnowledgeMessageSetter = (message: string, tone?: KnowledgeNoticeTone) => void;
export type KnowledgeSection = "my" | "services" | "recent";
export type KnowledgeViewMode = "list" | "grid";
export type KnowledgeKind = "folder" | "html" | "markdown" | "image" | "pdf" | "text" | "binary";
export type KnowledgeRole = "owner" | "collaborator" | "viewer";
export type KnowledgeAccessKind = "collaboration" | "knowledge_service";
export type KnowledgeServiceAccessMode = "private" | "company" | "targeted";

export type KnowledgeServiceAccess = {
  company?: boolean;
  departments?: string[];
  users?: string[];
};

export type KnowledgeCapabilities = {
  canCreatePublicShare: boolean;
  canEdit: boolean;
  canManageAccess: boolean;
  canManageKnowledgeService: boolean;
  canUpdateKnowledgeServiceInfo: boolean;
  canManageProtectedStructure: boolean;
  canReadChangeAudit: boolean;
  canTransferOwnership: boolean;
  canUseKnowledgeService: boolean;
};

export type KnowledgeItem = {
  access: KnowledgeRole;
  accessKind?: KnowledgeAccessKind;
  accessKinds: KnowledgeAccessKind[];
  agentEnabled: boolean;
  capabilities: KnowledgeCapabilities;
  collaboratorCount: number;
  collaboratorUserIds: string[];
  currentVersionId?: string;
  description: string;
  knowledgeServiceCard?: {
    bestFor: string[];
    keywords: string[];
    notFor: string[];
    role: string;
    searchHints: string[];
  };
  feedbackEnabled?: boolean;
  handbookObjectId?: string;
  id: string;
  indexStatus?: string;
  kind: KnowledgeKind;
  knowledgeServiceId?: string;
  maintenanceTeam: string;
  modifiedAt: string;
  mimeType: string;
  name: string;
  owner: string;
  ownerUserId: string;
  parentPath: string;
  path: string;
  shareMode: "private" | "team" | "company" | "public";
  sizeBytes: number;
  skillReady?: boolean;
  tags: string[];
  version: string;
  withinKnowledgeService: boolean;
};

export type KnowledgeNamespace = {
  id: string;
  name: string;
  ownerUserId: string;
  r2BucketName: string;
  r2Prefix: string;
  slug: string;
  status: string;
  usedBytes: number;
};

export type KnowledgeApiItem = Partial<Omit<KnowledgeItem, "id" | "kind" | "name">> & {
  capabilities?: Partial<KnowledgeCapabilities> & { canShare?: boolean };
  contentKind?: string;
  effectiveRole?: KnowledgeRole | "editor" | "none";
  id: string;
  kind?: string;
  knowledgeService?: {
    enabled?: boolean;
    handbookObjectId?: string;
    id?: string;
    indexStatus?: string;
  };
  knowledgeServiceAvailable?: boolean;
  name: string;
  objectKind?: string;
};

export type KnowledgeTreeResponse = {
  items?: KnowledgeApiItem[];
  namespace?: KnowledgeNamespace;
};
