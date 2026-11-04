export interface Env {
  WORKSPACE_MATE_EMAIL_DOMAIN?: string;
  WORKSPACE_EMAIL_ROUTING_DOMAIN?: string;
  WORKSPACE_MAIL_URL?: string;
  PLATFORM_BRAND_JSON?: string;
  APP_CREATION_EMAIL_CC?: string;
  APP_CREATION_EMAIL_INSTRUCTIONS?: string;
  WORKSPACE_STREAM?: Fetcher;
  WORKSPACE_STREAM_WORKER_NAME?: string;
  WORKSPACE_AUTH_WORKER_NAME?: string;
  WORKSPACE_MAIL?: Fetcher;
  WORKSPACE_MAIL_SECRET?: string;
  MATE_MCP_SERVICE_TOKEN?: string;
  EMAIL?: EmailSendingBinding;
  AUTH_SERVICE?: Fetcher;
  APPS_DB: D1Database;
  MODEL_HEALTH_DB: D1Database;
  APPS_ARTIFACTS?: R2Bucket;
  MATE_DEFINITIONS?: R2Bucket;
  AUTH_ISSUER?: string;
  AUTH_PUBLIC_URL?: string;
  AUTH_APP_SYNC_TIMEOUT_MS?: string;
  APPS_AUTH_SERVICE_TOKEN?: string;
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  CORS_ALLOWED_ORIGINS?: string;
  DEV_AUTH_BYPASS?: string;
  WORKSPACE_APP_SESSION_SECRET?: string;
  WORKSPACE_AUTH_APP_SECRET?: string;
  WORKSPACE_EMAIL_FROM?: string;
  WORKSPACE_EMAIL_ROUTER_WORKER?: string;

  APPS_BASE_DOMAIN?: string;
  APPS_APP_HOST_PREFIX?: string;
  WORKSPACE_MCP_JWT_SECRET?: string;
  WORKSPACE_RELEASE_READINESS_REPORT_REQUIRED?: string;
  APPS_JWT_SECRET?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ZONE_ID?: string;
  CF_ZONE_NAME?: string;
  CF_APPS_WORKER_NAME?: string;
  APPS_RUNTIME_HOST_MODE?: string;
  APPS_SECRET_ENCRYPTION_KEY?: string;
  LITELLM_PROVISIONING_KEY?: string;
  LITELLM_USER_TOKEN?: string;
  LITELLM_URL?: string;
  MODEL_HEALTH_CONCURRENCY?: string;
  MODEL_HEALTH_DEGRADED_MS?: string;
  MODEL_HEALTH_TIMEOUT_MS?: string;
  PLATFORM_MCP_URL?: string;
  MATE_RUNTIME_SERVICE_TOKEN?: string;
  MATE_RUNTIME_PREVIEW_URL?: string;
  PORTAL_URL?: string;
  MATE_WEB_HOST_URL?: string;
  USAGE_HISTORY_START_DATE?: string;
  USAGE_REFRESH_LOOKBACK_DAYS?: string;
  USAGE_SOURCE_CHUNK_DAYS?: string;
}

export type EmailSendingBinding = {
  send(message: {
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

export type Principal = {
  platformRole?: string;
  appId?: string;
  departmentId?: string;
  departmentName?: string;
  departmentPath?: string[];
  email?: string;
  name?: string;
  skillId?: string;
  sub: string;
  orgId: string;
  orgSlug: string;
  scopes: string[];
  tokenType?: string;
};

export type AppsWorkerLlmModel = {
  capabilities: string[];
  contextWindow?: number;
  displayName: string;
  endpoints: string[];
  id: string;
  provider: string;
};

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(code);
  }
}
