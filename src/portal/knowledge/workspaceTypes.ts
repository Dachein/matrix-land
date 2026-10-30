import type { KnowledgeApiItem, KnowledgeItem, KnowledgeRole, KnowledgeServiceAccess } from "./types";

export type KnowledgeContextMenu = {
  item: KnowledgeItem;
  propertiesOnly?: boolean;
  x: number;
  y: number;
};

export type KnowledgePublicShareResponse = {
  active?: boolean;
  item?: KnowledgeApiItem;
  share?: {
    expiresAt?: string | null;
    id: string;
    slug: string;
    url: string;
  };
  url?: string;
};

export type KnowledgePublicShareExpiry = "24h" | "permanent";

export type KnowledgeFolderCreationMode = "folder" | "knowledgeBase";

export type KnowledgeServiceHandbookStatus = "checking" | "error" | "missing" | "present";

export type KnowledgeZipUploadMode = "extract" | "store";

export type KnowledgeAccessGrant = {
  canShare?: boolean;
  expiresAt?: string | null;
  id: string;
  objectId?: string | null;
  role: KnowledgeRole;
  subjectId: string;
  subjectType: "company" | "department" | "mcp_client" | "team" | "user";
};

export type KnowledgeAccessResponse = {
  access?: {
    grants?: Array<Omit<KnowledgeAccessGrant, "role"> & { role: KnowledgeRole | "editor" }>;
  };
};

export type KnowledgeCollaboratorsResponse = {
  collaborators?: Array<Omit<KnowledgeAccessGrant, "role"> & { role: KnowledgeRole | "editor" }>;
  userIds?: string[];
};

export type KnowledgeServiceCard = {
  bestFor?: string[];
  keywords?: string[];
  notFor?: string[];
  role?: string;
  searchHints?: string[];
};

export type KnowledgeServiceSettingsResponse = {
  access?: KnowledgeServiceAccess;
  folder?: KnowledgeApiItem;
  service?: {
    access?: KnowledgeServiceAccess;
    agentEnabled?: boolean;
    description?: string;
    enabled?: boolean;
    handbookObjectId?: string;
    id?: string;
    indexStatus?: string;
    category?: string;
    card?: KnowledgeServiceCard;
    coverage?: string[];
    feedbackEnabled?: boolean;
    feedbackPolicy?: Record<string, unknown>;
    languages?: string[];
    maintenanceTeam?: string;
    name?: string;
    notFor?: string[];
    role?: string;
    searchHints?: string[];
    tags?: string[];
  };
};

export type KnowledgeServiceListEntry = {
  agentEnabled?: boolean;
  capabilities?: KnowledgeApiItem["capabilities"];
  category?: string;
  card?: KnowledgeServiceCard;
  coverage?: string[];
  description?: string;
  effectiveRole?: KnowledgeApiItem["effectiveRole"];
  feedbackEnabled?: boolean;
  folder?: KnowledgeApiItem;
  folderName?: string;
  folderObjectId?: string;
  folderPath?: string;
  handbookObjectId?: string;
  id?: string;
  indexStatus?: string;
  languages?: string[];
  maintenanceTeam?: string;
  collaboratorCount?: number;
  collaboratorUserIds?: string[];
  name?: string;
  notFor?: string[];
  role?: string;
  searchHints?: string[];
  tags?: string[];
  updatedAt?: string;
};

export type KnowledgeServicesResponse = {
  services?: KnowledgeServiceListEntry[];
};

export type KnowledgeServicePreflightResponse = {
  ready?: boolean;
  status?: "invalid" | "missing" | "ready";
};

export type KnowledgeChangeSummary = {
  actor?: { email?: string; type?: string; userId?: string };
  createdAt?: string;
  id: string;
  itemCount?: number;
  operation?: string;
  requestId?: string;
  sourceChannel?: string;
  summary?: string;
};

export type KnowledgeChangeItem = {
  action?: string;
  diff?: { status?: string };
  editOperation?: string;
  id: string;
  objectId?: string;
  pathAfter?: string;
  pathBefore?: string;
  versionAfterId?: string;
  versionBeforeId?: string;
};

export type KnowledgeChangeListResponse = {
  changes?: KnowledgeChangeSummary[];
  nextCursor?: string | null;
  scope?: KnowledgeAuditScope;
};

export type KnowledgeAuditCategory = "all" | "create" | "edit" | "import" | "lifecycle" | "structure";

export type KnowledgeAuditScope = {
  includesDescendants: boolean;
  kind: "file" | "folder";
  objectId: string;
  path: string;
};

export type KnowledgeChangeDetailResponse = {
  change?: KnowledgeChangeSummary;
  items?: KnowledgeChangeItem[];
};

export type KnowledgeDiffResponse = {
  diff?: string;
  diffStatus?: string;
  truncated?: boolean;
};
