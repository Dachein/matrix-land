import type { MateMcpCapacity } from "./mateMcpCapacity.ts";

export const WORKSPACE_AGENT_RUNTIME_SCHEMA_VERSION = "workspace.agentruntime/v1" as const;
export const WORKSPACE_MATE_CALL_TOOL = "mate_call" as const;

export const LEGACY_MATE_INBOX_PROMPT = "Create a task from an active Workspace sender email and reply to that sender with its result.";


export function normalizeMateCodeDraft(value: unknown) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  const localPart = text.split("@", 1)[0] ?? "";
  return localPart
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trimStart()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/g, "")
    .slice(0, 63);
}

export function normalizeMateCode(value: unknown) {
  return normalizeMateCodeDraft(value).replace(/-+$/g, "");
}

export function mateWorkEmail(value: unknown, domain?: string) {
  const code = normalizeMateCode(value);
  const selectedDomain = domain ?? (typeof value === "string" ? value.split("@")[1] : undefined);
  return code && selectedDomain ? `${code}@${selectedDomain}` : "";
}

export function mateCodeFromWorkEmail(value: unknown) {
  return normalizeMateCodeDraft(value);
}

export type WorkspaceBuiltInToolId =
  | "public_web_read"
  | "public_web_search"
  | "ocr"
  | "document_read"
  | "artifact_create"
  | "workspace_knowledge_maintain"
  | "workspace_forum_read"
  | "workspace_forum_post"
  | "todo_manage"
  | "reminder_manage";

/**
 * Runtime-owned, current-user-scoped capabilities. They are part of every
 * Mate rather than optional Release resources, so Builder must not expose
 * them as checkboxes.
 */
export const WORKSPACE_INTRINSIC_BUILT_IN_TOOL_IDS = ["todo_manage", "reminder_manage"] as const satisfies readonly WorkspaceBuiltInToolId[];

export const WORKSPACE_DEFAULT_BUILT_IN_TOOL_IDS = [
  "public_web_read",
  ...WORKSPACE_INTRINSIC_BUILT_IN_TOOL_IDS
] as const satisfies readonly WorkspaceBuiltInToolId[];

export function withWorkspaceIntrinsicBuiltInToolIds(toolIds: readonly string[]) {
  return Array.from(new Set([
    ...toolIds,
    ...WORKSPACE_INTRINSIC_BUILT_IN_TOOL_IDS
  ])) as WorkspaceBuiltInToolId[];
}

export function isWorkspaceIntrinsicBuiltInToolId(toolId: string): toolId is typeof WORKSPACE_INTRINSIC_BUILT_IN_TOOL_IDS[number] {
  return (WORKSPACE_INTRINSIC_BUILT_IN_TOOL_IDS as readonly string[]).includes(toolId);
}

export type MateTaskExecutor = "operations" | "knowledge_qa" | "app_mcp";
export type MateScheduledExecutor = "operations" | "forum_review";

export type MateScheduledJob = {
  cadence: {
    at: string;
    kind: "daily";
    timezone: string;
  };
  delivery?: {
    channel: "email";
    recipient: "owner";
  };
  /** Legacy metadata; all reminders invoke the same Agent. */
  executor?: MateScheduledExecutor;
  forumReview?: {
    cursorKey: string;
    lookbackHours: number;
    maxTopics: number;
  };
  id: string;
  instruction: string;
  title: string;
};

export type MateStatus = "draft" | "deployed" | "published" | "archived";
export type MateVisibility = "private" | "targets" | "organization";

/**
 * Resource access is always evaluated for the user invoking this Mate.
 * Owner-delegated access deliberately is not part of the V1 contract: adding
 * it requires an independently revocable and auditable grant, not a boolean
 * on a Release manifest.
 */
export type MateResourceAuthority = { mode: "invoking_user" };

/**
 * Platform Knowledge Mates may discover every Knowledge Service visible
 * to the invoking user instead of pinning publisher-visible service IDs into
 * a Release. This is a selector, never a grant: Knowledge ACL remains the
 * authority for every list, search, and read operation.
 */
export type MateKnowledgeServiceScope = {
  allowedOperations: Array<"search" | "read">;
  authority?: MateResourceAuthority;
  mode: "all_visible_to_invoking_user";
  requiresCurrentUserAuthorization: true;
};

export type MateAllResourceScope = {
  authority: { mode: "invoking_user" };
  mode: "all_visible_to_invoking_user";
  requiresCurrentUserAuthorization: true;
};

export function isMateAllResourceScope(value: unknown): value is MateAllResourceScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  const authority = scope.authority;
  return scope.mode === "all_visible_to_invoking_user"
    && scope.requiresCurrentUserAuthorization === true
    && authority !== null && typeof authority === "object" && !Array.isArray(authority)
    && (authority as Record<string, unknown>).mode === "invoking_user"
    && Object.keys(authority).length === 1
    && Object.keys(scope).length === 3;
}

/**
 * Dynamically exposes the Workspace MCP APPS + Knowledge tool surface for the
 * invoking user. This is a selector, not a grant: every tool call is still
 * authorized against the caller's live Workspace identity and resource ACLs.
 */
export type MateWorkspacePassMcpScope = {
  authority: MateResourceAuthority;
  domains: ["apps", "knowledge"];
  mode: "all_authorized_for_invoking_user";
  requiresCurrentUserAuthorization: true;
};

export type MateModelPolicy = {
  allowUserSelection: boolean;
  allowedModels: string[];
  defaultModel: string;
  multimodal: {
    audioInput: boolean;
    documentInput: boolean;
    imageInput: boolean;
  };
};

export type MateDocument = {
  content: string;
  digest: string;
  id: string;
  kind: "soul" | "handbook" | "mail";
  version: number;
};

export type WorkspaceAgentRuntimeManifest = {
  schemaVersion: typeof WORKSPACE_AGENT_RUNTIME_SCHEMA_VERSION;
  mate: {
    addresses?: Array<
      | { address: string; type: "email" }
      | { tool: typeof WORKSPACE_MATE_CALL_TOOL; type: "pass_mcp" }
    >;
    avatarRef?: string;
    description?: string;
    displayName: string;
    jobRole: string;
    ownerUserId: string;
    mateId: string;
  };
  release: {
    /** Optional only for immutable releases created before mail.md. */
    mail?: { digest: string; id: string; version: number };
    handbooks: Array<{ digest: string; id: string; version: number }>;
    releaseId: string;
    skills: Array<{ digest: string; skillId: string; version: string }>;
    soul: { digest: string; id: string; version: number };
    status: "draft" | "candidate" | "published" | "retired" | "revoked";
    version: number;
  };
  resources: {
    mcpCapacity?: MateMcpCapacity;
    appMcpScope?: MateAllResourceScope;
    folderEditScope?: MateAllResourceScope;
    workspacePassMcpScope?: MateWorkspacePassMcpScope;
    folderEditBindings?: Array<{
      folderObjectId: string;
      authority: { mode: "invoking_user" };
      requiresCurrentUserAuthorization: true;
    }>;
    appMcpBindings: Array<{
      allowedToolNames?: string[];
      appId: string;
      authority?: MateResourceAuthority;
      manifestVersion: string;
      requiresCurrentUserDelegation: true;
    }>;
    builtInToolBindings: Array<{
      requiresCurrentUserContext: true;
      toolId: WorkspaceBuiltInToolId;
    }>;
    knowledgeServiceBindings: Array<{
      allowedOperations: Array<"search" | "read">;
      authority?: MateResourceAuthority;
      requiresCurrentUserAuthorization: true;
      serviceId: string;
    }>;
    knowledgeServiceScope?: MateKnowledgeServiceScope;
    skillDiscoveryPolicy: {
      autoInstall: false;
      discoverAndRecommend: boolean;
      installationRequests: false;
    };
  };
  modelPolicy: MateModelPolicy;
  channels: {
    embedded: { enabled: boolean };
    inbox: {
      email: { enabled: boolean; taskAuthority?: "owner" | "verified_sender"; /** Legacy releases only. */ inboxPrompt?: string };
      schedule: { enabled: boolean };
      mateCall: { enabled: boolean; tool: typeof WORKSPACE_MATE_CALL_TOOL; transport: "workspace_pass_mcp" };
      webhook: { enabled: false };
    };
    standalone: { enabled: boolean };
  };
  invocationPolicy: {
    allowedCallerKinds: Array<"user" | "app" | "mate" | "email_binding">;
    requireAuthenticatedUser: true;
    targetIds?: string[];
    visibility: MateVisibility;
  };
  eligibilityPolicy: Record<string, unknown>;
  preferenceSchema: Record<string, unknown>;
  taskPolicy: {
    approvals: {
      revalidateDelegation: true;
      singleUse: true;
      writeRiskLevels: Array<"medium" | "high" | "critical">;
    };
    conclusionRequired: true;
    /** Legacy Release metadata, ignored by the unified task agent. */
    defaultExecutor?: MateTaskExecutor;
    defaultTimezone: string;
    requireUserOwnership: true;
    scheduledJobs: MateScheduledJob[];
    mateCallLimits: {
      maxChildrenPerTask: number;
      maxDepth: number;
      maxRunSeconds: number;
      maxTasksPerRoot: number;
    };
  };
  memoryPolicy?: {
    conversationHistory: {
      compaction: {
        enabled: boolean;
        maxSummaryTokens: number;
        minTailMessages: number;
        protectHeadMessages: number;
        strategy: "non_destructive_overlay";
        tailTokenBudget: number;
        triggerEstimatedTokens: number;
      };
      enabled: boolean;
      preserveOriginals: true;
    };
    userMemory: {
      automaticConversationExtraction: false;
      freeformFiles: false;
      storage: "structured_runtime_api";
    };
  };
  experiencePolicy: {
    automaticHandbookMutation: false;
    requiresSanitization: true;
    requiresReview: true;
    conversation: {
      enabled: boolean;
      channels: Array<"web" | "sdk">;
    };
    taskInbox: {
      enabled: boolean;
      channels: Array<"mate_call" | "email" | "schedule">;
    };
    ownerTesting: {
      enabled: boolean;
      candidateReleaseOnly: true;
      isolatedFromLiveData: true;
    };
  };
};

export type MateRelease = {
  activatedAt?: string;
  createdAt: string;
  createdBy: string;
  documents?: MateDocument[];
  id: string;
  manifest: WorkspaceAgentRuntimeManifest;
  manifestSha256: string;
  status: "candidate" | "published" | "retired" | "revoked";
  mateId: string;
  version: number;
};

export type Mate = {
  activeReleaseId?: string;
  avatarUrl?: string;
  createdAt: string;
  description: string;
  displayName: string;
  isDefault?: boolean;
  draftDocuments?: MateDocument[];
  draftManifest?: WorkspaceAgentRuntimeManifest;
  draftRevision: number;
  id: string;
  jobRole: string;
  orgId: string;
  ownerUserId: string;
  previewReleaseId?: string;
  status: MateStatus;
  updatedAt: string;
  visibility: MateVisibility;
  workEmail?: string;
};

export type MateValidationIssue = {
  code: string;
  message: string;
  path: string;
};

export type MateValidationResult = {
  errors: MateValidationIssue[];
  valid: boolean;
  warnings: MateValidationIssue[];
};

export type MateAdoptionPreview = {
  available: boolean;
  conversationUrl?: string;
  embedUrl?: string;
  mode: "shared-runtime-preview";
  releaseId: string;
  mateId: string;
  testUrl?: string;
};
