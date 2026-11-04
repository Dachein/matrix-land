export type AccessAction = "visibility" | "launch" | "token";

export type AccessDecision = "allow" | "deny";

export type AccessMode = "public" | "request" | "targeted";

export type DirectoryReadScope = "app" | "company";

export type McpAgentType = "claude-code" | "codex" | "cursor" | "workbuddy";

export type EmailSendingBinding = {
  send(message: {
    cc?: string[];
    from: string;
    html?: string;
    subject: string;
    text?: string;
    to: string;
  }): Promise<{
    messageId?: string;
    providerResult?: string;
    status?: string;
  }>;
};

export interface Env {
  MCP_RESOURCE_URL?: string;
  /** Existing Workspace directory reconciliation only; never enabled for new installs. */
  MINIAPP_REVIEW_EMAIL?: string;
  PLATFORM_BRAND_JSON?: string;
  APPS_CONTROL_PLANE?: Fetcher;
  APPS_CONTROL_PLANE_URL?: string;
  REMOTE_MCP_ENABLED?: string;
  REMOTE_MCP_ALLOWED_HOSTS?: string;
  REMOTE_MCP_CLIENTS_JSON?: string;
  MATE_MCP_SERVICE_TOKEN?: string;
  THIRD_PARTY_CREDENTIAL_KEY?: string;
  AUTH_INVITATION_EMAIL_ENABLED?: string;
  AUTH_EMAIL?: EmailSendingBinding;
  AUTH_DB: D1Database;
  AUTH_EMAIL_OTP_SECRET?: string;
  AUTH_ISSUER?: string;
  AUTH_LOGIN_ALLOWED_EMAILS_JSON?: string;
  AUTH_JWT_SECRET?: string;
  AUTH_PUBLIC_URL?: string;
  AUTH_CODE_TTL_SECONDS?: string;
  AUTH_RESOURCE_INTROSPECTION_TOKEN?: string;
  AUTH_SERVICE_TOKEN?: string;
  AUTH_SERVICE_TOKEN_SECONDARY?: string;
  APPS_AUTH_SERVICE_TOKEN?: string;
  PUBLICATION_AUTH_SERVICE_TOKEN?: string;
  PORTAL_AUTH_SERVICE_TOKEN?: string;
  CORS_ALLOWED_ORIGINS?: string;
  DEFAULT_TEAM_NAME?: string;
  EMAIL_OTP_COOLDOWN_SECONDS?: string;
  EMAIL_OTP_EMAIL_HOURLY_LIMIT?: string;
  EMAIL_OTP_ENABLED?: string;
  EMAIL_OTP_ALLOW_SIGNUP?: string;
  EMAIL_OTP_FROM?: string;
  EMAIL_OTP_GLOBAL_HOURLY_LIMIT?: string;
  EMAIL_OTP_IP_HOURLY_LIMIT?: string;
  EMAIL_OTP_MAX_ATTEMPTS?: string;
  EMAIL_OTP_SESSION_TTL_SECONDS?: string;
  EMAIL_OTP_TTL_SECONDS?: string;
  EMAIL_OTP_VERIFY_HOURLY_LIMIT?: string;
  ENTRA_AUTHORITY?: string;
  ENTRA_CLIENT_ID?: string;
  ENTRA_CLIENT_SECRET?: string;
  ENTRA_REDIRECT_URI?: string;
  ENTRA_SCOPES?: string;
  ENTRA_TENANT_ID?: string;
  WORKSPACE_ORG_ID?: string;
  MATE_RUNTIME_AUTH_SERVICE_TOKEN?: string;
  WECHAT_MINIAPP_APP_ID?: string;
  WECHAT_MINIAPP_APP_SECRET?: string;
  WECHAT_MINIAPP_ENV_VERSION?: string;
  MINIAPP_SCAN_LOGIN_TTL_SECONDS?: string;
  MINIAPP_REVIEW_OTP_CODE?: string;
  MCP_APPROVAL_TOKEN?: string;
  MCP_ACCESS_JWT_SECRET?: string;
  MCP_ACCESS_TOKEN_TTL_SECONDS?: string;
  MCP_INTROSPECTION_TOKEN?: string;
  MCP_IDLE_TTL_SECONDS?: string;
  MOKA_CONNECTOR?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  MOKA_CONNECTOR_SERVICE_TOKEN?: string;
  MOKA_DIRECTORY_ENABLED?: string;
  POST_LOGIN_REDIRECT_PATH?: string;
  PORTAL_URL?: string;
  SESSION_TTL_SECONDS?: string;
  RESOURCE_TOKEN_TTL_SECONDS?: string;
  TOKEN_TTL_SECONDS?: string;
}

export type MokaDirectoryEvent = {
  action: "create" | "deactivate" | "update";
  apiCode: string;
  entityType: "department" | "employee";
  eventKey: string;
  occurredAt?: string;
  receivedAt: string;
  sourceId: string;
  sourceType: "1" | "2";
};

export type WorkspaceUser = {
  defaultAgent?: import("../../../sdk/auth/types.ts").DefaultAgentInfo | null;
  departmentId?: string;
  departmentPath?: string[];
  id: string;
  email?: string;
  jobTitle?: string;
  name?: string;
  role?: string;
  source?: string;
  teamId?: string;
  teamPath?: string[];
  team?: string;
  department?: string;
  identityProvider?: string;
  providerSubject?: string;
  status?: string;
};

export type AppClient = {
  id: string;
  name?: string;
  status?: string;
  sdkStatus?: string;
  accessMode?: AccessMode;
  accessTargets?: string[];
  directoryReadScope?: DirectoryReadScope;
  collaboratorUserIds?: string[];
  publisherUserId?: string;
  businessOwnerUserId?: string;
  callbackUrls?: string[];
  appSecretName?: string;
  launchUrl?: string;
  systemRolePolicyVersion?: string;
};

export type McpClient = {
  allowedScopes?: string[];
  id: string;
  name?: string;
  resourceUrl?: string;
  status?: string;
  supportedAgents?: McpAgentType[];
};

export type ResourceClient = {
  accessMode?: AccessMode;
  accessTargets?: string[];
  allowedScopes?: string[];
  audience?: string;
  businessOwnerUserId?: string;
  collaboratorUserIds?: string[];
  id: string;
  name?: string;
  publisherUserId?: string;
  status?: string;
  systemRolePolicyVersion?: string;
};

export type McpConnection = {
  agentType: McpAgentType;
  clientId: string;
  createdAt?: string;
  displayName?: string;
  id: string;
  idleExpiresAt?: string;
  lastSeenAt?: string;
  resourceUrl?: string;
  scopes: string[];
  status: "active" | "revoked";
  statusReason?: string;
  updatedAt?: string;
  userId: string;
};

export type McpConnectionStatus = {
  activeCount: number;
  authorizedCount: number;
  connections?: McpConnection[];
  connected: boolean;
  credentialState: "active" | "idle_expired" | "reauthorization_required";
  currentTaskAvailability: "reload_may_be_required" | "unavailable";
  everConnected: boolean;
  maxActiveConnections: number;
  userId: string;
};

export type AdminMcpConnection = {
  agentType: McpAgentType;
  clientId: string;
  createdAt: string;
  displayName?: string;
  id: string;
  lastActiveAt: string;
  resourceUrl?: string;
  scopes: string[];
  status: "active" | "inactive";
  updatedAt: string;
  user: {
    department?: string;
    email?: string;
    id: string;
    name?: string;
    team?: string;
  };
};

export type AdminMcpConnectionList = {
  connections: AdminMcpConnection[];
  summary: {
    activeCount: number;
    inactiveCount: number;
    totalCount: number;
    userCount: number;
  };
};

export type AppAccessInput = {
  action?: AccessAction;
  app: AppClient;
  grantStatus?: "approved" | "pending" | "rejected" | "revoked";
  requestId?: string;
  user: WorkspaceUser;
};

export type AppAccessResult = {
  action: AccessAction;
  appId: string;
  decision: AccessDecision;
  policyVersion: string;
  reason: string;
};

export type AuditEventInput = {
  action: string;
  actorUserId?: string;
  clientAppId?: string;
  decision?: AccessDecision;
  metadata?: Record<string, unknown>;
  reason?: string;
  requestId?: string;
  resourceId?: string;
  resourceType?: string;
};

export class HttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    status: number,
    code: string,
    message = code
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
