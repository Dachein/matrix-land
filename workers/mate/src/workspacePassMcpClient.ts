import { RuntimeHttpError, type RuntimeEnv, type RuntimePrincipal } from "./types.ts";

export type WorkspacePassRuntimeTool = {
  capacity?: { group: "ai_capacity" | "forum_hub"; child: string };
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  runtimePolicy: {
    authorization: "invoking_user";
    readActions?: string[];
    writeActions?: string[];
    writeMode: "never" | "always" | "actions";
    writeRisk?: "medium" | "high" | "critical";
  };
};

export type WorkspacePassRuntimeCatalog = {
  catalogVersion: string;
  domains: ["apps", "knowledge"];
  tools: WorkspacePassRuntimeTool[];
};

export async function listRuntimeWorkspacePassTools(
  env: RuntimeEnv,
  principal: RuntimePrincipal,
  signal?: AbortSignal
): Promise<WorkspacePassRuntimeCatalog> {
  const response = await workspacePassFetch(env, principal, "/internal/runtime/workspace-pass/tools", {
    method: "GET",
    signal
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw bridgeError(response.status, payload, "workspace_pass_tool_catalog_unavailable");
  return runtimeCatalog(payload);
}

export async function callRuntimeWorkspacePassTool(
  env: RuntimeEnv,
  principal: RuntimePrincipal,
  name: string,
  input: Record<string, unknown>,
  options?: { approved?: boolean; mateId?: string; signal?: AbortSignal }
) {
  assertNoCallerAuthority(input);
  if (!/^[a-z][a-z0-9_]{0,95}$/.test(name)) {
    throw new RuntimeHttpError(400, "workspace_pass_tool_name_invalid");
  }
  const response = await workspacePassFetch(
    env,
    principal,
    `/internal/runtime/workspace-pass/tools/${encodeURIComponent(name)}`,
    {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
        ...(options?.approved ? { "x-workspace-runtime-approval": "single-use-approved" } : {})
      },
      method: "POST",
      signal: options?.signal
    },
    options?.mateId
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw bridgeError(response.status, payload, "workspace_pass_tool_call_failed");
  return payload;
}

export function runtimeWorkspacePassWriteRisk(tool: WorkspacePassRuntimeTool, input: Record<string, unknown>) {
  const policy = tool.runtimePolicy;
  if (policy.writeMode === "never") return undefined;
  if (policy.writeMode === "always") return policy.writeRisk;
  return policy.readActions?.includes(text(input.action)) ? undefined : policy.writeRisk;
}

async function workspacePassFetch(
  env: RuntimeEnv,
  principal: RuntimePrincipal,
  path: string,
  init: RequestInit,
  mateId?: string
) {
  const token = env.MATE_RUNTIME_SERVICE_TOKEN?.trim();
  if (!token) throw new RuntimeHttpError(503, "mate_runtime_service_token_not_configured");
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("x-workspace-runtime-user-id", principal.userId);
  headers.set("x-workspace-runtime-org-id", principal.orgId);
  if (path.startsWith("/internal/runtime/workspace-pass/tools/knowledge_") && env.MATE_AUTH_SERVICE_TOKEN?.trim()) {
    headers.set("x-workspace-runtime-auth-service-token", env.MATE_AUTH_SERVICE_TOKEN.trim());
  }
  if (mateId) headers.set("x-workspace-runtime-mate-id", mateId);
  if (principal.orgSlug) headers.set("x-workspace-runtime-org-slug", principal.orgSlug);
  if (principal.departmentId) headers.set("x-workspace-runtime-department-id", principal.departmentId);
  if (principal.departmentPath) headers.set("x-workspace-runtime-department-path", JSON.stringify(principal.departmentPath));
  if (principal.email) headers.set("x-workspace-runtime-user-email", principal.email);
  if (principal.name) headers.set("x-workspace-runtime-user-name", principal.name);
  const request = new Request(`https://mcp.example.invalid${path}`, { ...init, headers });
  return env.WORKSPACE_MCP_SERVICE ? env.WORKSPACE_MCP_SERVICE.fetch(request) : fetch(request);
}

function runtimeCatalog(value: unknown): WorkspacePassRuntimeCatalog {
  const payload = record(value);
  const catalogVersion = text(payload.catalogVersion).trim();
  const domains = array(payload.domains).map(text);
  if (!catalogVersion || domains.length !== 2 || domains[0] !== "apps" || domains[1] !== "knowledge") {
    throw new RuntimeHttpError(502, "workspace_pass_tool_catalog_invalid");
  }
  const tools = array(payload.tools).map(runtimeTool);
  if (tools.length > 64 || new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new RuntimeHttpError(502, "workspace_pass_tool_catalog_invalid");
  }
  return { catalogVersion, domains: ["apps", "knowledge"], tools };
}

function runtimeTool(value: unknown): WorkspacePassRuntimeTool {
  const source = record(value);
  const policy = record(source.runtimePolicy);
  const name = text(source.name).trim();
  const description = text(source.description).trim();
  const writeMode = text(policy.writeMode);
  const writeRisk = text(policy.writeRisk);
  const readActions = array(policy.readActions).map(text).filter(Boolean);
  const writeActions = array(policy.writeActions).map(text).filter(Boolean);
  const capacity = record(source.capacity);
  const capacityGroup = text(capacity.group);
  const capacityChild = text(capacity.child);
  if (
    !/^[a-z][a-z0-9_]{0,95}$/.test(name)
    || !description
    || policy.authorization !== "invoking_user"
    || !["never", "always", "actions"].includes(writeMode)
    || (new Set(readActions).size !== readActions.length)
    || (new Set(writeActions).size !== writeActions.length)
    || readActions.some((action) => writeActions.includes(action))
    || (writeMode === "never" && (writeRisk || readActions.length || writeActions.length))
    || (writeMode === "always" && !["medium", "high", "critical"].includes(writeRisk))
    || (writeMode === "always" && (readActions.length || writeActions.length))
    || (writeMode === "actions" && (!readActions.length || !writeActions.length || !["medium", "high", "critical"].includes(writeRisk)))
    || (source.capacity !== undefined && (!["ai_capacity", "forum_hub"].includes(capacityGroup) || !/^[a-z][a-z0-9_]{0,63}$/.test(capacityChild)))
  ) throw new RuntimeHttpError(502, "workspace_pass_tool_catalog_invalid");
  return {
    ...(source.capacity !== undefined ? { capacity: { group: capacityGroup as "ai_capacity" | "forum_hub", child: capacityChild } } : {}),
    description: description.slice(0, 2_000),
    inputSchema: record(source.inputSchema),
    name,
    runtimePolicy: {
      authorization: "invoking_user",
      ...(readActions.length ? { readActions } : {}),
      ...(writeActions.length ? { writeActions } : {}),
      writeMode: writeMode as WorkspacePassRuntimeTool["runtimePolicy"]["writeMode"],
      ...(writeRisk ? { writeRisk: writeRisk as NonNullable<WorkspacePassRuntimeTool["runtimePolicy"]["writeRisk"]> } : {})
    }
  };
}

function assertNoCallerAuthority(value: unknown) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(assertNoCallerAuthority);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(userId|ownerUserId|orgId|mateId|scopes?|accessToken|refreshToken|authorization|cookie)$/i.test(key)) {
      throw new RuntimeHttpError(400, "caller_authority_field_forbidden", { field: key });
    }
    assertNoCallerAuthority(child);
  }
}

function bridgeError(status: number, value: unknown, fallback: string) {
  const code = text(record(value).error).trim() || fallback;
  return new RuntimeHttpError(status === 401 ? 502 : status, code);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
