import type { MateRelease, MateVisibility } from "../../../src/shared/mate.ts";
import type { MateChatAgent } from "./chatAgent.ts";
import type { MateWeixinGateway } from "./weixinGateway.ts";

export type BrowserRunBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  quickAction?(action: "markdown", options: {
    actionTimeout?: number;
    allowRequestPattern?: string[];
    browser?: "kitesurf";
    cacheTTL?: number;
    gotoOptions?: {
      timeout?: number;
      waitUntil?: "domcontentloaded" | "load" | "networkidle0" | "networkidle2";
    };
    url: string;
  }): Promise<Response>;
};

export type RuntimeEnv = {
  WORKSPACE_MAIL?: Fetcher;
  WORKSPACE_MAIL_SECRET?: string;
  REMOTE_MCP_ENABLED?: string;
  MATE_MCP_SERVICE_TOKEN?: string;
  AI?: Ai;
  APP_MCP_SERVICE?: Fetcher;
  AUTH_SERVICE?: Fetcher;
  AUTH_WORKER_URL?: string;
  BROWSER?: BrowserRunBinding;
  DEFAULT_MATE_ID?: string;
  APPS_CONTROL_PLANE?: Fetcher;
  WORKSPACE_MCP_SERVICE?: Fetcher;
  KNOWLEDGE_PUBLIC_URL?: string;
  KNOWLEDGE_RESOURCE_ID?: string;
  KNOWLEDGE_SERVICE?: Fetcher;
  KNOWLEDGE_WORKER_URL?: string;
  LITELLM_URL?: string;
  LITELLM_SERVICE?: Fetcher;
  LITELLM_USER_TOKEN?: string;
  MATE_ARTIFACTS?: R2Bucket;
  IMAGES?: ImagesBinding;
  RUNTIME_DB: D1Database;
  DEV_AUTH_BYPASS?: string;
  APPS_CONTROL_PLANE_URL?: string;
  MATE_AUTH_SERVICE_TOKEN?: string;
  MATE_CHAT_AGENT?: DurableObjectNamespace<MateChatAgent>;
  MATE_TASK_RUNNER?: DurableObjectNamespace;
  MATE_CHAT_GRANT_SECRET?: string;
  MATE_LLM_KEY?: string;
  MATE_MODEL?: string;
  MATE_OPERATOR_TOKEN?: string;
  MATE_PREVIEW_JWT_SECRET?: string;
  MATE_WEB_HOST_URL?: string;
  MATE_RUNTIME_JWT_SECRET?: string;
  MATE_RUNTIME_SERVICE_TOKEN?: string;
  MATE_WEIXIN_CHANNEL_SECRET?: string;
  MATE_WEIXIN_GATEWAY?: DurableObjectNamespace<MateWeixinGateway>;
  WEB_SEARCH?: WebSearch;
};

export type RuntimePrincipal = {
  mailMateId?: string;
  callerKind: "user" | "app" | "mate" | "email_binding";
  departmentId?: string;
  departmentPath?: string[];
  email?: string;
  name?: string;
  orgId: string;
  orgSlug?: string;
  scopes: string[];
  testGrant?: {
    releaseId: string;
    mateId: string;
  };
  userId: string;
};

export type RuntimeMode = "live" | "preview";

export type RuntimeDefinition = {
  release: MateRelease;
  skills?: Array<{ skillId: string; version: string; name: string; markdown: string; files?: string[] }>;
  mate: {
    description: string;
    displayName: string;
    id: string;
    jobRole: string;
    orgId: string;
    ownerUserId: string;
    updatedAt: string;
    visibility: MateVisibility;
    workEmail?: string;
  };
};

export class RuntimeHttpError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(status: number, code: string, details?: Record<string, unknown>) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
