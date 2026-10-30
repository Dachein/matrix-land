export type AdminKnowledgePermissionType = "company" | "private" | "targeted";

export type AdminKnowledgeService = {
  access: {
    company: boolean;
    departments: string[];
    users: string[];
  };
  agentEnabled: boolean;
  category: string;
  collaboratorUserIds: string[];
  createdAt: string;
  description: string;
  feedbackEnabled: boolean;
  fileCount: number;
  folderName: string;
  folderObjectId: string;
  folderPath: string;
  id: string;
  indexStatus: string;
  indexedAt?: string;
  languages: string[];
  lastActiveAt?: string;
  name: string;
  namespaceId: string;
  ownerUserId: string;
  permissionType: AdminKnowledgePermissionType;
  requestCount: number;
  slug: string;
  sourceRevision: number;
  tags: string[];
  updatedAt: string;
};

export type AdminKnowledgeServiceSummary = {
  companyVisibleCount: number;
  fileCount: number;
  requestCount: number;
  serviceCount: number;
};

export type AdminKnowledgeServiceData = {
  services: AdminKnowledgeService[];
  summary: AdminKnowledgeServiceSummary;
};
