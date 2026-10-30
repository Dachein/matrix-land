export type MateToolEnv = {
  AI?: Ai;
  WORKSPACE_MCP_SERVICE?: Fetcher;
  AUTH_SERVICE?: Fetcher;
  AUTH_WORKER_URL?: string;
  DEV_AUTH_BYPASS?: string;
  MATE_AUTH_SERVICE_TOKEN?: string;
  MATE_RUNTIME_SERVICE_TOKEN?: string;
  KNOWLEDGE_PUBLIC_URL?: string;
  KNOWLEDGE_RESOURCE_ID?: string;
  KNOWLEDGE_SERVICE?: Fetcher;
  KNOWLEDGE_WORKER_URL?: string;
  LITELLM_URL?: string;
  MATE_ARTIFACTS?: R2Bucket;
  IMAGES?: ImagesBinding;
  WEB_SEARCH?: WebSearch;
};

export type MateToolUser = {
  avatarUrl?: string;
  department?: string;
  email?: string;
  id: string;
  name?: string;
  role?: string;
  team?: string;
};

export type MateToolContext = {
  appCode: string;
  appId: string;
  orgId?: string;
  description: string;
  displayName: string;
  exp: number;
  iat: number;
  user: MateToolUser;
  version: 1;
};
