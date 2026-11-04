export const SUPPORTED_AGENTS = ["workbuddy", "claude-code", "codex", "cursor"] as const;

export type SupportedAgent = typeof SUPPORTED_AGENTS[number];

export interface Env {
  PLATFORM_BRAND_JSON?: string;
  AI?: Ai;
  DB: D1Database;
  FORUM_MEDIA?: R2Bucket;
  MATE_ARTIFACTS?: R2Bucket;
  AUTH_ISSUER?: string;
  AUTH_PUBLIC_URL?: string;
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  CORS_ALLOWED_ORIGINS?: string;
  DEV_AUTH_BYPASS?: string;
  WORKSPACE_MCP_JWT_SECRET?: string;
  WORKSPACE_SOURCE_SNAPSHOT_ACCEPTANCE_APP_ID?: string;
  WORKSPACE_SOURCE_SNAPSHOT_ACCEPTANCE_EMAIL?: string;
  WORKSPACE_SOURCE_SNAPSHOT_ACCEPTANCE_TOKEN?: string;
  WORKSPACE_SOURCE_SNAPSHOT_ACCEPTANCE_USER_ID?: string;
  KNOWLEDGE_PUBLIC_URL?: string;
  KNOWLEDGE_RESOURCE_ID?: string;
  KNOWLEDGE_WORKER_URL?: string;
  APPS_JWT_SECRET?: string;
  APPS_ORG_ID?: string;
  APPS_ORG_SLUG?: string;
  APPS_WORKER_URL?: string;
  LITELLM_PROVISIONING_KEY?: string;
  LITELLM_URL?: string;
  LIVE_PUBLISH_TOKEN?: string;
  LIVE_WORKER_URL?: string;
  LLM_GATEWAY_WORKER?: Fetcher;
  MCP_ACCESS_JWT_SECRET?: string;
  MCP_RESOURCE_URL?: string;
  MCP_SUPPORTED_AGENTS?: string;
  PORTAL_LIVE_WORKSPACE_ID?: string;
  MCP_INTROSPECTION_TOKEN?: string;
  MATE_RUNTIME?: Fetcher;
  MATE_RUNTIME_JWT_SECRET?: string;
  MATE_RUNTIME_URL?: string;
  MATE_RUNTIME_SERVICE_TOKEN?: string;
  PORTAL_URL?: string;
  WEB_SEARCH?: {
    search(input: { limit: number; query: string }): Promise<{
      items: Array<{ description?: string; lastModifiedDate?: string; title: string; url: string }>;
      metadata?: { query?: string; requestId?: string };
    }>;
  };
}

export type Principal = {
  defaultAgent?: import("../../../sdk/auth/types.ts").DefaultAgentInfo | null;
  // Set only by the authenticated Runtime bridge, never by tool arguments.
  folderEditScope?: string[] | "all";
  mateId?: string;
  runtimeService?: true;
  runtimeAuthServiceToken?: string;
  agentType?: SupportedAgent;
  authenticatedAt?: string;
  clientId?: string;
  connectionId?: string;
  department?: string;
  departmentId?: string;
  departmentPath?: string[];
  email?: string;
  name?: string;
  orgId?: string;
  role?: string;
  scopes: string[];
  sub: string;
  team?: string;
  teamId?: string;
  teamPath?: string[];
};

export class HttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
