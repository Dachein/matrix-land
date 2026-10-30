import type {
  AppSensitiveDataType,
  AppsApp,
  AppsSourceSnapshot,
  AppsAppSecretEnvironment,
  AppsAppType,
  AppsVisibility,
  AppsSkill,
  PublicationListing,
  PortalApp,
  Skill
} from "../../shared/types";
import type { Mate, MateAdoptionPreview, MateRelease } from "../../shared/mate";
import type { MateMcpCapacity } from "../../shared/mateMcpCapacity";
import type { AppsProvisionedResourceType } from "../../shared/appsResourceCatalog";

export type AppsKindFilter = "all" | "apps" | "skills" | "mates";
export type AppsStatusFilter = "all" | "published" | "private" | "listed" | "pending_review";
export type AppsDetailTab = "basic" | "config" | "security" | "review" | "history";
export type AppsAccessMode = "public" | "company" | "targeted" | "private";

export type CreateInput = {
  emailEnabled?: boolean;
  emailPrefix?: string;
  emailTriggerEnabled?: boolean;
  accessMode: AppsAccessMode;
  accessTargets: string[];
  agentMcpEnabled: boolean;
  appCode: string;
  description: string;
  loginRequired: boolean;
  llmEnabled: boolean;
  name: string;
  resourceTypes: AppsProvisionedResourceType[];
  type: AppsAppType;
};

export type ApiAppsInventoryPayload = {
  apps: AppsApp[];
  skills: AppsSkill[];
  mates?: Mate[];
};

export type ApiMatePayload = {
  mate?: Mate;
};

export type ApiMateReleasePayload = {
  adoptionPreview?: MateAdoptionPreview;
  release?: MateRelease;
};

export type MateCreateInput = {
  mcpCapacity: MateMcpCapacity;
  allAppMcp: boolean;
  allFolderEdit: boolean;
  allKnowledgeServices: boolean;
  allowedModels: string[];
  appMcpBindings: Array<{ appId: string; manifestVersion: string }>;
  avatarUrl: string;
  builtInToolIds: string[];
  defaultTimezone: string;
  description: string;
  displayName: string;
  emailEnabled: boolean;
  embeddedEnabled: boolean;
  workspacePassMcpEnabled: boolean;
  jobRole: string;
  knowledgeServiceIds: string[];
  folderEditIds?: string[];
  standaloneEnabled: boolean;
  taskModeEnabled: boolean;
  targetIds: string[];
  mateCallEnabled: boolean;
  visibility: "private" | "targets" | "organization";
  workEmail: string;
};

export type ApiAppPayload = {
  app?: AppsApp;
};

export type ApiSourceSnapshotsPayload = {
  sourceSnapshots: AppsSourceSnapshot[];
};

export type ApiHandoffLinkPayload = {
  expiresAt?: number;
  url?: string;
};

export type AppsProductItem = {
  app?: AppsApp;
  authors?: AppsProductAuthor[];
  coverImageUrl?: string;
  id: string;
  kind: string;
  appsSkill?: AppsSkill;
  listing?: PublicationListing;
  marketListing?: PublicationListing;
  name: string;
  owner: string;
  portalApp?: PortalApp;
  skill?: Skill;
  status: string;
  subtitle: string;
  type: "app" | "skill";
  updatedAt: string;
};

export type AppsProductAuthor = {
  avatarUrl?: string;
  id: string;
  name: string;
};

export type AppsDetailRow = {
  format?: "code" | "primary" | "prose" | "tags";
  href?: string;
  label: string;
  span?: 3 | 4 | 5 | 7 | 12;
  value: string;
  wide?: boolean;
};

export type AppsProductProgressState = "idle" | "pending" | "ready";

export type AppsAppHandoffMode = "environment" | "source-collaboration";

export type AppsProductProgressStep = {
  detail: string;
  label: string;
  state: AppsProductProgressState;
};

export type AppsDevelopmentResourceItem = {
  copyValue?: string;
  detail: string;
  environment?: string;
  label: string;
  state: AppsProductProgressState;
  status: string;
  type?: string;
};

export type AppsSkillStructureFile = {
  kind?: string;
  path: string;
  sizeBytes?: number;
};

export type AppsSkillStructureGroup = {
  files: AppsSkillStructureFile[];
  fileCount: number;
  label: string;
  path: string;
  sizeBytes: number;
};

export type AppsSkillProjectStructureModel = {
  currentVersionLabel: string;
  fileCount: number;
  groups: AppsSkillStructureGroup[];
  totalSize: number;
};

export type AppsAccessTargetNode = {
  children?: AppsAccessTargetNode[];
  detail?: string;
  label: string;
  searchText?: string;
  tagDetail?: string;
  type: "department" | "user";
  value: string;
};

export type AppsCopyNotice = {
  detail: string;
  title: string;
};

export type AppsAppInfoInput = {
  appCode: string;
  name: string;
  note: string;
};

export type AppsSkillInfoInput = {
  capabilities: string;
  description: string;
  kind: "vanilla" | "app";
  name: string;
  slug: string;
};

export type AppsSecretInput = {
  description: string;
  environment: AppsAppSecretEnvironment;
  name: string;
  required: boolean;
  value: string;
};

export type AppsAppConfigInput = {
  emailEnabled?: boolean;
  emailPrefix?: string;
  emailTriggerEnabled?: boolean;
  addResourceTypes?: AppsProvisionedResourceType[];
  agentMcpEnabled?: boolean;
  emailRoutingEnabled?: boolean;
  emailRoutingPrefix?: string;
  emailSenderMailbox?: string;
  emailSendingEnabled?: boolean;
  llmEnabled?: boolean;
};

export type AppsAccessInput = {
  accessMode: AppsAccessMode;
  accessTargets: string[];
  loginRequired: boolean;
  visibility: AppsVisibility;
};

export type AppsAppAccessInput = AppsAccessInput;
export type AppsSkillAccessInput = AppsAccessInput;

export type AppsAppPublishDraft = {
  accessMode: "public" | "request" | "targeted";
  accessTargets: string;
  category: string;
  changelog: string;
  coverImageUrl: string;
  dataRegion: "hong_kong" | "mainland_china" | "singapore" | "north_america" | "other";
  dataTypes: string;
  deploymentMethod: "docker" | "serverless" | "vps";
  deploymentProvider: "workspace_ai_cloud" | "cloudflare" | "aws" | "vercel" | "tencent_cloud" | "aliyun" | "replit" | "other";
  descriptionEn: string;
  descriptionZh: string;
  harnessReportUrl: string;
  harnessSelfCheckConfirmed: boolean;
  knowledgeSources: string;
  modelProvider: string;
  nameEn: string;
  nameZh: string;
  outputNotes: string;
  permissionNotes: string;
  riskLevel: "low" | "medium" | "high";
  riskReason: string;
  sensitiveDataTypes: AppSensitiveDataType[];
  subtitle: string;
  tags: string;
  usesWorkspaceAuth: boolean;
  version: string;
};

export type AppsSkillPublishDraft = {
  category: string;
  coverImageUrl: string;
  description: string;
  installNotes: string;
  name: string;
  overviewMarkdown: string;
  riskLevel: "low" | "medium" | "high";
  riskReason: string;
  version: string;
};
