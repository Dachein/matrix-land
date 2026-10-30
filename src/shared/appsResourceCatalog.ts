import type { AppsAppType } from "./types";

export type AppsProvisionedResourceEnvironment = "prod" | "shared";

export type AppsProvisionedResourceType =
  | "pages_project"
  | "pages_function"
  | "worker"
  | "d1_database"
  | "email_sending"
  | "email_routing"
  | "media"
  | "kv_namespace"
  | "r2_bucket"
  | "hyperdrive_config"
  | "schema_registry"
  | "cron_trigger"
  | "queue"
  | "logs_audit";

export type AppsProvisionedResourceDefinition = {
  bindingName?: string;
  detail: string;
  environment: AppsProvisionedResourceEnvironment;
  label: string;
  nameToken: string;
  provider: string;
  type: AppsProvisionedResourceType;
};

export const APPS_RESOURCE_CATALOG = {
  pages_project: {
    type: "pages_project",
    label: "Pages site",
    detail: "Hosts static pages or page-style apps and generates the production URL.",
    provider: "cloudflare-pages",
    nameToken: "pages",
    environment: "prod"
  },
  pages_function: {
    type: "pages_function",
    label: "Pages functions",
    detail: "Lightweight APIs, form submissions, or simple queries for Pages apps.",
    provider: "cloudflare-pages",
    nameToken: "functions",
    environment: "prod"
  },
  worker: {
    type: "worker",
    label: "Worker service",
    detail: "Runs APIs, backend logic, scheduled work, or Agent entry points.",
    provider: "cloudflare",
    nameToken: "worker",
    environment: "prod"
  },
  d1_database: {
    type: "d1_database",
    label: "SQL database (D1)",
    detail: "Stores structured business data, query results, and app state.",
    provider: "cloudflare",
    nameToken: "db",
    bindingName: "DB",
    environment: "prod"
  },
  email_sending: {
    type: "email_sending",
    label: "Email Sending",
    detail: "Sends app-owned transactional emails through the native Cloudflare Email Service binding.",
    provider: "cloudflare-email-service",
    nameToken: "email",
    bindingName: "EMAIL",
    environment: "prod"
  },
  email_routing: {
    type: "email_routing",
    label: "Email Routing",
    detail: "Receives app-owned inbound email through a configured address and the platform mail router.",
    provider: "cloudflare-email-routing",
    nameToken: "inbound-email",
    environment: "prod"
  },
  media: {
    type: "media",
    label: "Stream",
    detail: "App-isolated video uploads and playback through the shared Workspace Stream service. Storage credentials are managed by the platform; clients upload directly to Stream.",
    provider: "workspace-stream",
    nameToken: "media",
    bindingName: "WORKSPACE_STREAM",
    environment: "prod"
  },
  kv_namespace: {
    type: "kv_namespace",
    label: "Config store (KV)",
    detail: "Stores feature flags, lightweight config, short-term cache, and small non-database settings.",
    provider: "cloudflare",
    nameToken: "kv",
    bindingName: "CONFIG",
    environment: "prod"
  },
  r2_bucket: {
    type: "r2_bucket",
    label: "File storage (R2)",
    detail: "Stores uploads, reports, images, and generated artifacts.",
    provider: "cloudflare",
    nameToken: "r2",
    bindingName: "BUCKET",
    environment: "prod"
  },
  hyperdrive_config: {
    type: "hyperdrive_config",
    label: "Custom database (Hyperdrive)",
    detail: "Connects an existing PostgreSQL or MySQL database during MCP deployment. Connection parameters come from the Agent handoff and the password stays in a platform-managed Secret.",
    provider: "cloudflare-hyperdrive",
    nameToken: "hyperdrive",
    bindingName: "HYPERDRIVE",
    environment: "prod"
  },
  schema_registry: {
    type: "schema_registry",
    label: "Agent Schema",
    detail: "Records tool schemas, tables, fields, and Agent-readable invocation notes.",
    provider: "workspace-apps",
    nameToken: "schema",
    environment: "prod"
  },
  cron_trigger: {
    type: "cron_trigger",
    label: "Scheduled trigger",
    detail: "Declares scheduled work. A Cron expression must be configured before the trigger can become ready.",
    provider: "cloudflare",
    nameToken: "cron",
    environment: "prod"
  },
  queue: {
    type: "queue",
    label: "Task queue",
    detail: "Handles async processing, retries, or batch work.",
    provider: "cloudflare",
    nameToken: "queue",
    bindingName: "QUEUE",
    environment: "prod"
  },
  logs_audit: {
    type: "logs_audit",
    label: "Run logs",
    detail: "Records run results, errors, and audit signals.",
    provider: "workspace-apps",
    nameToken: "audit",
    environment: "prod"
  }
} satisfies Record<AppsProvisionedResourceType, AppsProvisionedResourceDefinition>;

export const APPS_CUSTOM_RUNTIME_RESOURCE_TYPES = ["worker"] as const;

export const APPS_CUSTOM_OPTIONAL_RESOURCE_TYPES = [
  "d1_database",
  "kv_namespace",
  "r2_bucket",
  "hyperdrive_config",
  "media",
  "cron_trigger",
  "queue"
] as const;

export const APPS_PAGES_APPENDABLE_RESOURCE_TYPES = [
  "d1_database",
  "kv_namespace",
  "r2_bucket"
] as const;

export const APPS_CUSTOM_RESOURCE_TYPES = [
  ...APPS_CUSTOM_RUNTIME_RESOURCE_TYPES,
  ...APPS_CUSTOM_OPTIONAL_RESOURCE_TYPES
] as const;

export const APPS_APPENDABLE_RESOURCE_TYPES_BY_APP_TYPE = {
  agent_app: [...APPS_CUSTOM_OPTIONAL_RESOURCE_TYPES],
  automation: [...APPS_CUSTOM_OPTIONAL_RESOURCE_TYPES],
  container: [...APPS_CUSTOM_OPTIONAL_RESOURCE_TYPES],
  static_page: [...APPS_PAGES_APPENDABLE_RESOURCE_TYPES],
  web: [...APPS_CUSTOM_OPTIONAL_RESOURCE_TYPES]
} satisfies Record<AppsAppType, readonly AppsProvisionedResourceType[]>;

export function appsAppendableResourceTypes(type: string): readonly AppsProvisionedResourceType[] {
  return APPS_APPENDABLE_RESOURCE_TYPES_BY_APP_TYPE[type as AppsAppType] ?? [];
}

export const APPS_APP_MCP_OPTIONAL_TYPES = ["web", "automation", "container"] as const;

export type AppsAppMcpOptionalType = typeof APPS_APP_MCP_OPTIONAL_TYPES[number];
export type AppsAppMcpSupportedType = AppsAppMcpOptionalType | "agent_app";

export function isAppsAppMcpSupportedType(type: string): type is AppsAppMcpSupportedType {
  return type === "agent_app" || (APPS_APP_MCP_OPTIONAL_TYPES as readonly string[]).includes(type);
}

export function isAppsAppMcpRequiredType(type: string): type is "agent_app" {
  return type === "agent_app";
}

export const APPS_FIXED_RESOURCE_TYPES_BY_APP_TYPE: Record<AppsAppType, AppsProvisionedResourceType[]> = {
  agent_app: ["worker", "d1_database", "schema_registry"],
  automation: ["worker", "cron_trigger"],
  container: [],
  static_page: ["pages_project"],
  web: ["worker", "d1_database"]
};

export function appsResourceDefinition(type: string): AppsProvisionedResourceDefinition | undefined {
  return APPS_RESOURCE_CATALOG[type as AppsProvisionedResourceType];
}

export function appsResourceDefinitions(types: string[]): AppsProvisionedResourceDefinition[] {
  return types
    .map((type) => appsResourceDefinition(type))
    .filter((definition): definition is AppsProvisionedResourceDefinition => Boolean(definition));
}

export function isAppsCustomRuntimeResourceType(type: string): type is typeof APPS_CUSTOM_RUNTIME_RESOURCE_TYPES[number] {
  return (APPS_CUSTOM_RUNTIME_RESOURCE_TYPES as readonly string[]).includes(type);
}
