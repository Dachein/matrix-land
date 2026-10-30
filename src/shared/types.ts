import type { AppsHyperdriveDeploymentInput, AppsHyperdriveScheme } from "./appsHyperdrive";

export type UserRole = "member" | "admin";

export type AssignedUserRole = "admin" | "community_admin";

export type IdentityProvider = "microsoft_entra_id" | "dingtalk" | "generic_oidc";

export type AuthenticationMethod = "microsoft_entra_id" | "email_otp" | "wechat_miniapp";

export type WorkspaceIdentity = {
  authenticationMethod?: AuthenticationMethod;
  provider: IdentityProvider;
  tenantId: string;
  objectId: string;
  principalName: string;
};

export type SkillKind = "vanilla" | "knowledge" | "app";

export type AssetLifecycleStatus = "pending_review" | "listed" | "delisted" | "deleted";

export type ReviewStatus = AssetLifecycleStatus;

export type PublicationListingType = "skill" | "app";

export type PublicationStatus = AssetLifecycleStatus;

export type PublicationVisibility = "org" | "team" | "private";

export type AssetTargetType = "skill" | "app";

export type AppStoreStatus = AssetLifecycleStatus;

export type AppRiskLevel = "high" | "medium" | "low";

export type AppKind = "web" | "agent_chat";

export type AppAccessMode = "public" | "request" | "targeted";

export type AppDeploymentProvider = "workspace_ai_cloud" | "cloudflare" | "aws" | "vercel" | "tencent_cloud" | "aliyun" | "replit" | "other";

export type AppDeploymentMethod = "docker" | "serverless" | "vps";

export type AppDataRegion = "hong_kong" | "mainland_china" | "singapore" | "north_america" | "other";

export type AppSensitiveDataType =
  | "customer_information"
  | "transaction_records"
  | "employee_information"
  | "financial_information"
  | "internal_materials"
  | "public_information";

export type AppDeploymentType = "saas" | "private" | "serverless";

export type AppUserScope = "all" | "department" | "management" | "custom";

export type AssetPublisherProfile = {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  department?: string;
  team?: string;
  jobTitle?: string;
  journeyLevelKey?: PortalJourneyLevelKey;
  journeyTotalPoints?: number;
  journeyCommunityContributionPoints?: number;
};

export type HomeAppDisplay = "recommended" | "normal" | "hidden";

export type PublicationListing = {
  homeDisplay?: HomeAppDisplay;
  homeScope?: "public" | "exclusive";
  id: string;
  type: PublicationListingType;
  targetPlane?: "apps" | "portal";
  targetId: string;
  listedVersionId?: string;
  reviewVersionId?: string;
  name: string;
  ownerAliasName?: string;
  ownerProfiles?: AssetPublisherProfile[];
  submittedByProfile?: AssetPublisherProfile;
  status: PublicationStatus;
  desiredStatus?: PublicationStatus;
  effectiveStatus?: PublicationStatus;
  authPublicationStatus?: "failed" | "not_required" | "pending" | "synced";
  publicationErrorCode?: string;
  visibility: PublicationVisibility;
  summary: string;
  description: string;
  coverImageUrl?: string;
  category: string;
  tags: string[];
  installs: number;
  agentAddCount?: number;
  downloadCount?: number;
  visitCount?: number;
  comments: number;
  rating: number;
  likeCount?: number;
  likedByCurrentUser?: boolean;
  riskLevel?: "low" | "medium" | "high";
  reviewNotes?: string;
  artifactType?: string;
  artifactUrl?: string;
  config?: Record<string, unknown>;
  updatedAt: string;
};

export type PublicationInstall = {
  id: string;
  listingId: string;
  listingName: string;
  listingType: PublicationListingType;
  version?: string;
  installType: "user" | "team" | "download" | "bookmark";
  installedAt: string;
};

export type PublicationComment = {
  id: string;
  listingId: string;
  author: string;
  body: string;
  createdAt: string;
};

export type Skill = {
  id: string;
  name: string;
  owner: string;
  status: ReviewStatus;
  description: string;
  coverImageUrl?: string;
  category: string;
  kind: SkillKind;
  riskLevel?: AppRiskLevel;
  reviewNotes?: string;
  version: string;
  scopes: string[];
  mcpTools: string[];
  dependencies: string[];
  rating: number;
  installs: number;
  discussions: number;
  updatedAt: string;
};

export type PortalApp = {
  id: string;
  name: string;
  nameZh?: string;
  nameEn?: string;
  subtitle: string;
  appType: AppKind;
  publisherId: string;
  publisherProfile?: AssetPublisherProfile;
  status: AppStoreStatus;
  description: string;
  descriptionZh?: string;
  descriptionEn?: string;
  iconAssetId?: string;
  coverImageUrl?: string;
  screenshots?: string[];
  sdkStatus: "connected" | "pending";
  scopes: string[];
  launchUrl: string;
  callbackUrl: string;
  category: string;
  tags: string[];
  model: string;
  deploymentType: AppDeploymentType;
  deploymentProvider: AppDeploymentProvider;
  deploymentMethod: AppDeploymentMethod;
  dataRegion: AppDataRegion;
  modelProvider: string;
  dataTypes: string[];
  knowledgeSources: string[];
  userScope: AppUserScope;
  accessMode: AppAccessMode;
  accessTargets: string[];
  usesWorkspaceAuth: boolean;
  sensitiveDataTypes: AppSensitiveDataType[];
  riskLevel: AppRiskLevel;
  riskReason: string;
  permissionNotes: string;
  outputNotes: string;
  reviewNotes?: string;
  version: string;
  changelog: string;
  listedAt?: string;
  delistedAt?: string;
  updatedAt: string;
  viewCount: number;
  launchCount: number;
  downloadCount: number;
  likeCount: number;
  favoriteCount: number;
  rating: number;
  ratingCount: number;
  discussionCount: number;
  activeUserCount: number;
  monthlyUsers: number;
};

export type AppsAppType = "static_page" | "web" | "agent_app" | "automation" | "container";

export type AppsAppStatus = "draft" | "provisioning" | "published" | "archived";

export type AppsVisibility = "private" | "team" | "org" | "public";

export type AppsDirectoryReadScope = "app" | "company";

export type AppsSkillKind = "vanilla" | "app";

export type AppsSkillStatus = "private" | "archived";

export type AppsSkillVersionState =
  | "private_current"
  | "private_superseded"
  | "submitted_for_market"
  | "listed"
  | "rejected"
  | "archived";

export type AppsProvisioningStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

export type AppsProvisioningStepStatus = "queued" | "running" | "ready" | "failed" | "skipped";

export type AppsAppSecretEnvironment = "production";

export type AppsAppSecretStatus = "declared" | "configured";

export type AppsResource = {
  id: string;
  appId: string;
  dataServiceId: string;
  type: string;
  provider: string;
  resourceName: string;
  resourceId?: string;
  bindingName?: string;
  environment: string;
  status: string;
  createdAt: string;
};

export type AppsAppSecret = {
  id: string;
  appId: string;
  name: string;
  environment: AppsAppSecretEnvironment;
  description: string;
  required: boolean;
  status: AppsAppSecretStatus;
  configuredBy?: string;
  configuredAt?: string;
  declaredBy: string;
  createdAt: string;
  updatedAt: string;
};

export type AppsLlmModel = {
  id: string;
  displayName: string;
  provider: string;
  capabilities: string[];
  endpoints: string[];
  contextWindow?: number;
};

export type AppsDeployment = {
  accessTargets?: string[];
  id: string;
  appId: string;
  deployArtifactId?: string;
  sourceSnapshotId?: string;
  environment: "production";
  harnessReportUrl?: string;
  harnessSelfCheckConfirmedAt?: string;
  harnessSelfCheckConfirmedBy?: string;
  loginRequired?: boolean;
  version: string;
  versionName?: string;
  releaseNotes?: string;
  status: string;
  url?: string;
  visibility?: AppsVisibility;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
};

export type AppsSourceSnapshot = {
  id: string;
  appId: string;
  version: string;
  versionName?: string;
  notes?: string;
  contentSha256: string;
  archiveSha256: string;
  archiveFormat: "zip";
  fileCount: number;
  sourceSizeBytes: number;
  archiveSizeBytes: number;
  purpose: "backup" | "deployment" | "both" | "legacy";
  createdBy: string;
  createdByName?: string;
  createdAt: string;
};

export type AppsDomain = {
  id: string;
  appId: string;
  hostname: string;
  type: "production" | "custom";
  environment: "production";
  status: string;
  provider?: string;
  dnsRecordId?: string;
  routeId?: string;
  certificateStatus?: string;
  routeStatus?: string;
  fallbackUrl?: string;
  lastCheckedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
};

export type AppsRuntimeManifest = {
  appId: string;
  dataServiceId: string;
  type: AppsAppType;
  auth: {
    issuer: string;
    origin: string;
    publicOrigin: string;
    clientId: string;
    audience: string;
    required: boolean;
    registration: {
      strategy: "first_login";
      separateSignup: boolean;
      appUserObjectName: string;
      appUserTableRecommendation: string;
      profileUpsert: boolean;
    };
    loginStartPath: string;
    callbackPath: string;
    sessionEndpoint: string;
    logoutEndpoint: string;
    authorizeEndpoint: string;
    tokenExchangeEndpoint: string;
    secrets: {
      appClient: "WORKSPACE_AUTH_APP_SECRET";
      appSession: "WORKSPACE_APP_SESSION_SECRET";
    };
    callbackUrls: {
      production: string;
      fallbackProduction: string;
    };
    loginUrls: {
      production: string;
      fallbackProduction: string;
    };
    env: {
      WORKSPACE_AUTH_AUTHORIZE_ORIGIN: string;
      WORKSPACE_AUTH_ORIGIN: string;
      WORKSPACE_AUTH_CLIENT_ID: string;
      WORKSPACE_AUTH_AUDIENCE: string;
      WORKSPACE_AUTH_CALLBACK_PATH: string;
      WORKSPACE_AUTH_SESSION_ENDPOINT: string;
      WORKSPACE_AUTH_FALLBACK_PRODUCTION_URL: string;
    };
    user: {
      objectName: string;
      requestContextName: string;
      source: "verified_app_session";
      claims: {
        id: string;
        email: string;
        name: string;
        department: string;
        departmentId: string;
        departmentPath: string;
        identityProvider: string;
        tenantId: string;
        objectId: string;
        principalName: string;
      };
    };
  };
  runtime: {
    productionUrl: string;
    fallbackProductionUrl?: string;
  };
  bindings: {
    d1?: string;
    hyperdrive?: string;
    r2?: string;
    kv?: string;
  };
  cli: {
    packageName: string;
    install: string;
    preflight: {
      policy: "before_each_deploy";
      currentVersion: string;
      requiredVersion: string;
      install: string;
      update: string;
      instruction: string;
    };
    authenticate: {
      workbuddy: string;
      codex: string;
      claudeCode: string;
      cursor: string;
    };
    deploy: {
      pages?: string;
      worker?: string;
    };
    publish: string;
  };
  mcp: {
    registered: boolean;
    schemaRequired: boolean;
    platformUrl: string;
    installCommand: string;
    serveCommand: string;
    agentInstallCommands: {
      workbuddy: string;
      codex: string;
      claudeCode: string;
      cursor: string;
    };
    workBuddyInstallCommand: string;
  };
  llm: {
    enabled: boolean;
    defaultModel?: string;
    endpoint?: string;
    gatewayUrl?: string;
    secretName?: string;
  };
  email: {
    sending: {
      bindingName?: string;
      enabled: boolean;
      fromEnv: string;
      senderMailbox?: string;
    };
    routing: {
      address?: string;
      enabled: boolean;
      triggerEnabled?: boolean;
      handler: "email";
      mode: "process";
      routerWorker: string;
      env: {
        WORKSPACE_EMAIL_INBOUND_ADDRESS: string;
        WORKSPACE_EMAIL_ROUTER_WORKER: string;
        WORKSPACE_EMAIL_ROUTING_MODE: string;
      };
    };
  };
  secrets: Array<{
    configured: boolean;
    description: string;
    environment: AppsAppSecretEnvironment;
    name: string;
    required: boolean;
  }>;
};

export type AppsApp = {
  id: string;
  orgId: string;
  ownerUserId: string;
  collaboratorUserIds?: string[];
  ownerTeamId: string;
  name: string;
  appCode: string;
  slug: string;
  description: string;
  type: AppsAppType;
  status: AppsAppStatus;
  visibility: AppsVisibility;
  accessTargets: string[];
  directoryReadScope?: AppsDirectoryReadScope;
  loginRequired: boolean;
  agentMcpEnabled: boolean;
  llmEnabled: boolean;
  llmDefaultModel?: string;
  llmEndpoint?: string;
  createdAt: string;
  updatedAt: string;
  lastDeployedAt?: string;
  productionUrl: string;
  dataServiceId: string;
  resources: AppsResource[];
  secrets: AppsAppSecret[];
  deployments: AppsDeployment[];
  domains: AppsDomain[];
  manifest: AppsRuntimeManifest;
};

export type AppsDeveloperReadinessState = "blocked" | "pending" | "ready" | "unknown" | "unsafe";
export type AppsDeveloperGate = "build" | "deploy" | "preview" | "publish" | "rollback";

export type AppsDeveloperContext = {
  schemaVersion: "workspace.apps.app-context.v2";
  contractVersion: "apps-dev-v2";
  generatedAt: string;
  instruction: string;
  app: Pick<AppsApp, "appCode" | "dataServiceId" | "id" | "loginRequired" | "name" | "slug" | "status" | "type" | "visibility">;
  readiness: {
    overall: AppsDeveloperReadinessState;
    gates: {
      build: AppsDeveloperReadinessState;
      deploy: AppsDeveloperReadinessState;
      preview: AppsDeveloperReadinessState;
      publish: AppsDeveloperReadinessState;
      rollback: AppsDeveloperReadinessState;
    };
    sourceAssessment: {
      status: "not_supplied";
      reason: string;
    };
  };
  auth: AppsRuntimeManifest["auth"] & {
    contractVersion: "app-session-v1";
    implementationTool: "apps_app_read";
    implementationAction: "auth_sdk";
    migrationAssessment: "not_required" | "source_check_required";
    managedSecrets: Array<{
      creationStage: "after_auth_preflight_before_runtime_deploy";
      description: string;
      management: "platform";
      manualConfigurationRequired: false;
      name: "WORKSPACE_APP_SESSION_SECRET" | "WORKSPACE_AUTH_APP_SECRET";
      status: "configured" | "pending_auto_creation";
    }>;
  };
  deployment: {
    latest?: AppsDeployment;
    latestPublished?: AppsDeployment;
    latestReady?: AppsDeployment;
    readyCount: number;
    rollbackCandidateCount: number;
    liveConsistency: {
      status: "not_checked";
      reason: string;
    };
  };
  guidance: {
    dataContract: string[];
    deploymentContract: string[];
    implementationContract: string[];
  };
  mcpBuild: {
    tablePrefix: string;
    tools: Record<string, string>;
    actions: Record<string, string>;
  };
  runtime: AppsRuntimeManifest["runtime"];
  llm: AppsRuntimeManifest["llm"];
  mail: Record<string, unknown>;
  stream: {
    enabled: boolean;
    status: "disabled" | "provisioning" | "ready";
    bindingName: "WORKSPACE_STREAM";
    secretName: "WORKSPACE_STREAM_TOKEN";
    developmentPrompt?: string;
  };
  emailSending: Record<string, unknown>;
  emailRouting: Record<string, unknown>;
  customDatabase: {
    bindingName?: string;
    enabled: boolean;
    passwordSecretName: string;
    requiredDeploymentFields: Array<keyof AppsHyperdriveDeploymentInput>;
    status: "configuration_required" | "disabled" | "ready";
    supportedSchemes: AppsHyperdriveScheme[];
  };
  bindings: AppsRuntimeManifest["bindings"];
  secrets: Array<{
    description: string;
    environment: AppsAppSecretEnvironment;
    name: string;
    required: boolean;
    status: AppsAppSecretStatus;
  }>;
  resources: Array<{
    bindingName?: string;
    environment: string;
    label: string;
    provider: string;
    resourceId?: string;
    resourceName: string;
    status: string;
    type: string;
  }>;
  domains: Array<{
    certificateStatus?: string;
    environment: "production";
    fallbackUrl?: string;
    hostname: string;
    routeStatus?: string;
    status: string;
    type: "custom" | "production";
  }>;
  blockers: Array<{
    code: string;
    gate: AppsDeveloperGate;
    message: string;
    resourceType?: string;
  }>;
  nextActions: Array<{
    arguments?: Record<string, unknown>;
    kind: "local_action" | "tool_call";
    reason: string;
    requiresUserApproval: boolean;
    tool?: string;
  }>;
};

export type AppsBackupFrequency = "daily" | "weekly" | "monthly";

export type AppsBackupPolicy = {
  appId: string;
  enabled: boolean;
  frequency: AppsBackupFrequency;
  scheduleTime: string;
  scheduleTimezone: string;
  scheduleWeekday: number;
  scheduleMonthday: number;
  complianceRetentionEnabled: boolean;
  complianceRetentionYears: number;
  backupNodeId?: string;
  backupNodeName?: string;
  localCopyLimit: 10;
  nextRunAt?: string;
  lastRunAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type AppsBackupNode = {
  id: string;
  orgId: string;
  name: string;
  protocol: "sftp";
  host: string;
  port: number;
  username: string;
  remotePath: string;
  hostKeyFingerprint?: string;
  passwordConfigured: boolean;
  isDefault: boolean;
  status: "active" | "disabled";
  lastTestStatus?: "reachable" | "unreachable";
  lastTestLatencyMs?: number;
  lastTestError?: string;
  lastTestedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AppsBackupJobStatus =
  | "queued"
  | "exporting_d1"
  | "copying_r2"
  | "packaging"
  | "waiting_for_node"
  | "uploading_sftp"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AppsBackupJob = {
  id: string;
  appId: string;
  appName?: string;
  appCode?: string;
  orgId: string;
  backupNodeId?: string;
  backupNodeName?: string;
  triggerType: "scheduled" | "manual";
  status: AppsBackupJobStatus;
  sourceTypes: Array<"d1" | "r2">;
  artifactPrefix: string;
  manifestKey?: string;
  objectCount: number;
  totalBytes: number;
  archiveAvailable?: boolean;
  retained: boolean;
  complianceRetentionEnabled: boolean;
  complianceRetentionYears: number;
  retainUntil?: string;
  currentStep?: string;
  errorCode?: string;
  errorMessage?: string;
  requestedBy: string;
  deliveryStatus?: "waiting_for_node" | "pending_agent" | "uploading" | "succeeded" | "failed";
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type AppsBackupArtifact = {
  id: string;
  jobId: string;
  appId: string;
  kind: "d1_export" | "r2_object" | "manifest" | "archive";
  sourceResourceId?: string;
  sourceKey?: string;
  artifactKey: string;
  contentType: string;
  sizeBytes: number;
  checksum?: string;
  createdAt: string;
};

export type AppsBackupAppAdminItem = {
  appId: string;
  appName: string;
  appCode: string;
  orgId: string;
  ownerUserId: string;
  resourceTypes: Array<"d1" | "r2">;
  policy: AppsBackupPolicy;
  lastJob?: AppsBackupJob;
};

export type AppsSkillVersion = {
  id: string;
  skillId: string;
  version: string;
  state: AppsSkillVersionState;
  artifactKey: string;
  skillMdKey: string;
  manifestKey: string;
  artifactSha256: string;
  manifest: Record<string, unknown>;
  frontmatter: Record<string, unknown>;
  fileCount: number;
  sizeBytes: number;
  changelog: string;
  createdBy: string;
  createdAt: string;
};

export type AppsSkill = {
  id: string;
  orgId: string;
  orgSlug: string;
  ownerUserId: string;
  collaboratorUserIds?: string[];
  name: string;
  slug: string;
  description: string;
  kind: AppsSkillKind;
  capabilities: string[];
  status: AppsSkillStatus;
  visibility: Extract<AppsVisibility, "private" | "team" | "org">;
  accessTargets: string[];
  loginRequired: boolean;
  currentVersionId?: string;
  currentVersion?: string;
  createdAt: string;
  updatedAt: string;
  versions: AppsSkillVersion[];
};

export type AppsProvisioningStep = {
  id: string;
  jobId: string;
  appId: string;
  order: number;
  key: string;
  label: string;
  status: AppsProvisioningStepStatus;
  progress: number;
  resourceType?: string;
  resourceId?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AppsProvisioningJob = {
  id: string;
  appId: string;
  orgId: string;
  type: "create_app" | "publish_production";
  status: AppsProvisioningStatus;
  progress: number;
  currentStep?: string;
  errorCode?: string;
  errorMessage?: string;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  steps: AppsProvisioningStep[];
};

export type DataService = {
  id: string;
  name: string;
  owner: string;
  status: ReviewStatus;
  description: string;
  endpoint: string;
  risk: "low" | "medium" | "high";
  reviewNotes?: string;
  scopes: string[];
  tools: string[];
  boundSkills: string[];
  freshness: string;
  monthlyCalls: number;
};

export type McpTool = {
  id: string;
  server: string;
  name: string;
  risk: "low" | "medium" | "high";
  scopes: string[];
  boundSkill: string;
};

export type DiscussionAttachment = {
  id: string;
  type: "image" | "file";
  url: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  alt?: string;
};

export type DiscussionLinkEmbed = {
  id: string;
  url: string;
  provider: string;
  title: string;
  description: string;
  embedType: "link" | "video" | "social";
  previewImageUrl?: string;
};

export type DiscussionContentPlugin = {
  id: string;
  pluginType: "app_card" | "app_launch" | "app_release" | "app_support";
  targetType: "app" | "skill";
  targetId: string;
  title: string;
  description: string;
  status?: string;
  actionLabel?: string;
  category?: string;
  iconUrl?: string;
  installs?: number;
  owner?: string;
};

export type DiscussionUserProfile = {
  department?: string;
  team?: string;
  jobTitle?: string;
  bio?: string;
  location?: string;
  journeyLevelKey?: PortalJourneyLevelKey;
  journeyTotalPoints?: number;
  journeyCommunityContributionPoints?: number;
};

export type DiscussionMention = DiscussionUserProfile & {
  id: string;
  userId: string;
  postId?: string;
  name: string;
  email?: string;
  emailPrefix: string;
  avatarUrl?: string;
  text: string;
};

export type DiscussionReaction = {
  reaction: string;
  count: number;
};

export type DiscussionContributorAward = {
  id: string;
  awardedByName: string;
  awardedByUserId: string;
  createdAt: string;
  note: string;
  points: number;
};

export type DiscussionReply = DiscussionUserProfile & {
  id: string;
  authorId?: string;
  author: string;
  authorEmail?: string;
  authorAvatar?: string;
  authorAvatarUrl?: string;
  body: string;
  source?: "portal" | "mcp";
  createdAt: string;
  updatedAt?: string;
  attachments?: DiscussionAttachment[];
  parentPostId?: string;
  likes?: number;
  likedByCurrentUser?: boolean;
  reactions?: DiscussionReaction[];
  currentUserReaction?: string;
  pinned?: boolean;
  contributorAward?: DiscussionContributorAward;
};

export type Discussion = DiscussionUserProfile & {
  id: string;
  rootPostId?: string;
  title: string;
  authorId?: string;
  author: string;
  authorEmail?: string;
  authorAvatar?: string;
  authorAvatarUrl?: string;
  category?: string;
  categorySlug?: string;
  topicType?: "help" | "question" | "idea" | "showcase" | "official" | "release";
  source?: "portal" | "mcp";
  bu?: string;
  tag: string;
  tags?: string[];
  linkedSkill?: string;
  linkedApp?: string;
  linkedMcp?: string;
  createdAt?: string;
  updatedAt?: string;
  replies: number;
  views: number;
  likes?: number;
  likedByCurrentUser?: boolean;
  reactions?: DiscussionReaction[];
  currentUserReaction?: string;
  lastActive: string;
  excerpt: string;
  body?: string;
  attachments?: DiscussionAttachment[];
  linkEmbeds?: DiscussionLinkEmbed[];
  contentPlugins?: DiscussionContentPlugin[];
  mentions?: DiscussionMention[];
  replyPosts?: DiscussionReply[];
  pinned?: boolean;
  contributorAward?: DiscussionContributorAward;
};

export type ForumDiscussionQuery = {
  category?: string;
  cursor?: string;
  limit?: number;
  owner?: "all" | "mine";
  query?: string;
};

export type ForumDiscussionPage = {
  discussions: Discussion[];
  pinnedDiscussions: Discussion[];
  nextCursor?: string;
};

export type UsageSummary = {
  quotaLimit: number;
  quotaUsed: number;
  resetDate: string;
  apiKeys: number;
  activeTokens: number;
  lastTokenRefresh: string;
};

export type AuditEvent = {
  id: string;
  actor: string;
  action: string;
  target: string;
  time: string;
};

export type ActivityScenario = "agent" | "community" | "apps";

export type ActivityActionType =
  | `agent.${string}`
  | "community.member.joined"
  | "journey.badge.awarded"
  | "journey.level.upgraded"
  | "forum.topic.created"
  | "forum.reply.created"
  | "forum.reaction.created"
  | "forum.contribution.awarded"
  | "apps.app.published";

export type ActivityTargetType =
  | "agent"
  | "community"
  | "knowledge_file"
  | "knowledge_folder"
  | "knowledge_object"
  | "knowledge_service"
  | "journey_badge"
  | "journey_level"
  | "forum_topic"
  | "forum_post"
  | "apps_app"
  | "apps_deployment"
  | "apps_skill"
  | "publication_listing"
  | "mcp_tool";

export type ActivityEvent = {
  id: string;
  scenario: ActivityScenario;
  actionType: ActivityActionType;
  actorUserId?: string;
  actorName: string;
  actorAvatarUrl?: string;
  actorTeam?: string;
  targetType: ActivityTargetType;
  targetId: string;
  targetTitle: string;
  parentType?: ActivityTargetType;
  parentId?: string;
  parentTitle?: string;
  summary: string;
  href?: string;
  visibility: "org" | "team" | "private";
  metadata?: Record<string, unknown>;
  source: "agent" | "workspace-mcp-worker" | "apps-worker" | "mcp" | "portal";
  sourceEventId?: string;
  createdAt: string;
};

export type PortalJourneyLevelKey = "newcomer" | "explorer" | "contributor" | "builder" | "master";

export type PortalJourneyBadgeCategory =
  | "foundation"
  | "community"
  | "usage"
  | "builder"
  | "impact";

export type PortalJourneyBadgeTriggerType =
  | "computed"
  | "profile"
  | "gateway"
  | "forum"
  | "market"
  | "apps"
  | "manual";

export type PortalJourneyLevelDefinition = {
  key: PortalJourneyLevelKey;
  rank: number;
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  descriptionEn: string;
  minPoints: number;
  criteria: Record<string, unknown>;
};

export type PortalJourneyBadgeDefinition = {
  key: string;
  category: PortalJourneyBadgeCategory;
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  descriptionEn: string;
  points: number;
  triggerType: PortalJourneyBadgeTriggerType;
  triggerConfig: Record<string, unknown>;
  sortOrder: number;
};

export type PortalJourneyUserBadge = {
  badgeKey: string;
  category: PortalJourneyBadgeCategory;
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  descriptionEn: string;
  points: number;
  source: string;
  sourceEventId?: string;
  metadata?: Record<string, unknown>;
  awardedAt: string;
};

export type PortalJourneyProfile = {
  agentPreference?: "workbuddy" | "codex" | "claude-code" | "cursor";
  mcpInstallConfirmedAt?: string;
};

export type PortalJourneyCommunityContributionBreakdown = {
  topicPoints: number;
  replyPoints: number;
  contributionTagPoints: number;
};

export type PortalJourney = {
  level: PortalJourneyLevelDefinition;
  levels: PortalJourneyLevelDefinition[];
  badgeDefinitions: PortalJourneyBadgeDefinition[];
  badges: PortalJourneyUserBadge[];
  profile: PortalJourneyProfile;
  communityContributionBreakdown: PortalJourneyCommunityContributionBreakdown;
  communityContributionPoints: number;
  totalPoints: number;
  badgeCount: number;
  categoryCounts: Record<PortalJourneyBadgeCategory, number>;
  nextBadges: PortalJourneyBadgeDefinition[];
  updatedAt: string;
};

export type PortalCurrentUserStatus = {
  journeyLevelKey: PortalJourneyLevelKey;
  mcpConnected: boolean;
  tokenApplied: boolean;
  updatedAt?: string;
};

export type AdminUserProfile = {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  team: string;
  department?: string;
  departmentId?: string;
  departmentPath?: string[];
  jobTitle?: string;
  journeyLevelKey?: PortalJourneyLevelKey;
  journeyTotalPoints?: number;
  journeyBadgeCount?: number;
  bio?: string;
  location?: string;
  role: UserRole;
  roles?: AssignedUserRole[];
  status: string;
  lastSeenAt?: string;
  createdAt?: string;
  identityProvider?: IdentityProvider;
  principalName?: string;
};

export type ReviewQueueItem = {
  id: string;
  type: "skill" | "app" | "scope" | "mcp";
  title: string;
  owner: string;
  risk: "low" | "medium" | "high";
  submittedAt: string;
};

export type PortalThemeSeries = {
  "50": string;
  "100": string;
  "200": string;
  "500": string;
  "600": string;
  "700": string;
  "900": string;
};

export type PortalThemeConfig = {
  id: string;
  label: string;
  primary: string;
  primaryStrong: string;
  primarySoft: string;
  primarySurface: string;
  primaryInk: string;
  primaryRgb: string;
  primaryStrongRgb: string;
  series: PortalThemeSeries;
};

export type PortalBrandConfig = {
  name: string;
  shortName: string;
  productName: string;
  tagline: string;
  logoUrl?: string;
  logoMark?: {
    text: string;
    backgroundColor?: string;
    foregroundColor?: string;
  };
  adminName: string;
  userSpaceName: string;
  theme: PortalThemeConfig;
};

export type PortalCatalog = {
  portal: PortalBrandConfig;
  currentUser: {
    defaultAgent?: { id: string; name: string; email: string } | null;
    id: string;
    name: string;
    email: string;
    avatarUrl?: string;
    team: string;
    department?: string;
    departmentDisplayPath?: string;
    departmentId?: string;
    departmentPath?: string[];
    jobTitle?: string;
    bio?: string;
    location?: string;
    role: UserRole;
    roles?: AssignedUserRole[];
    identity: WorkspaceIdentity;
    status?: PortalCurrentUserStatus;
  };
  categories: string[];
  hubListings: PublicationListing[];
  publicationListings: PublicationListing[];
  skills: Skill[];
  dataServices: DataService[];
  apps: PortalApp[];
  discussions: Discussion[];
  usage: UsageSummary;
  mcpTools: McpTool[];
  activityEvents: ActivityEvent[];
  journey: PortalJourney;
  audit: AuditEvent[];
  reviewQueue: ReviewQueueItem[];
};
