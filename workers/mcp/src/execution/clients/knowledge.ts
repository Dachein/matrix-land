import { missingConfiguration } from "../../../../../src/shared/requiredConfiguration.ts";
import { FOLDER_EDIT_SCOPE_HEADER } from "../../../../../src/shared/mateFolderEditing.ts";
import { authWorkerUrl, readString } from "../../http.ts";
import { type Env, HttpError, type Principal } from "../../types.ts";

// Forward Knowledge calls with resource-scoped credentials and the existing folder edit boundary.
export async function callKnowledgeWorkerJson(
  env: Env,
  principal: Principal,
  path: string,
  options: {
    body?: Record<string, unknown> | FormData;
    idempotencyKey?: string;
    method?: "DELETE" | "GET" | "PATCH" | "POST";
    scopes: string[];
    toolName: string;
    toolAlias?: string;
  }
) {
  const response = await callKnowledgeWorker(env, principal, path, options);
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status === 401 ? 502 : response.status, "knowledge_worker_request_failed", text.slice(0, 240));
  }
  try {
    return text ? JSON.parse(text) as unknown : {};
  } catch {
    throw new HttpError(502, "knowledge_worker_invalid_json");
  }
}

export async function callKnowledgeWorkerRaw(
  env: Env,
  principal: Principal,
  path: string,
  options: {
    scopes: string[];
    toolName: string;
    toolAlias?: string;
  }
) {
  const response = await callKnowledgeWorker(env, principal, path, options);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    throw new HttpError(response.status === 401 ? 502 : response.status, "knowledge_worker_request_failed", new TextDecoder().decode(bytes.slice(0, 240)));
  }
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  return {
    bytes,
    contentType,
    isText: contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("markdown") || contentType.includes("xml")
  };
}

async function callKnowledgeWorker(
  env: Env,
  principal: Principal,
  path: string,
  options: {
    body?: Record<string, unknown> | FormData;
    idempotencyKey?: string;
    method?: "DELETE" | "GET" | "PATCH" | "POST";
    scopes: string[];
    toolName: string;
    toolAlias?: string;
  }
) {
  const baseUrl = (env.KNOWLEDGE_WORKER_URL?.trim() || missingConfiguration("KNOWLEDGE_WORKER_URL")).replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Accept: "application/json",
    "x-workspace-source-channel": "mcp"
  };
  if (principal.folderEditScope !== undefined) {
    headers[FOLDER_EDIT_SCOPE_HEADER] = JSON.stringify(principal.folderEditScope);
  }
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  const isFormData = options.body instanceof FormData;
  if (!isFormData) {
    headers["Content-Type"] = "application/json";
  }

  if (env.DEV_AUTH_BYPASS === "1" && isLocalKnowledgeWorker(baseUrl)) {
    headers["x-workspace-user-id"] = principal.sub;
    headers["x-workspace-user-email"] = principal.email ?? "";
    headers["x-workspace-user-name"] = principal.name ?? principal.email ?? principal.sub;
    headers["x-workspace-role"] = principal.role ?? "member";
    headers["x-workspace-scopes"] = options.scopes.join(",");
    if (principal.orgId) headers["x-workspace-org-id"] = principal.orgId;
    if (principal.teamId) headers["x-workspace-team-id"] = principal.teamId;
    if (principal.team) headers["x-workspace-team-name"] = principal.team;
    if (principal.teamPath?.length) headers["x-workspace-team-path"] = JSON.stringify(principal.teamPath);
    if (principal.departmentId) headers["x-workspace-department-id"] = principal.departmentId;
    if (principal.department) headers["x-workspace-department-name"] = principal.department;
    if (principal.departmentPath?.length) headers["x-workspace-department-path"] = JSON.stringify(principal.departmentPath);
  } else {
    headers.Authorization = `Bearer ${await mintKnowledgeResourceToken(env, principal, options.scopes, options.toolName, options.toolAlias)}`;
  }

  const requestBody: BodyInit | undefined = options.body instanceof FormData
    ? options.body
    : options.body
      ? JSON.stringify(options.body)
      : undefined;

  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: requestBody
  });
}

async function mintKnowledgeResourceToken(env: Env, principal: Principal, scopes: string[], toolName: string, toolAlias?: string) {
  // Runtime calls are authenticated at the internal bridge and have no OAuth
  // connection ID. Auth requires its service credential for delegated user minting.
  const runtimeService = principal.runtimeService === true;
  const mintToken = runtimeService
    ? principal.runtimeAuthServiceToken?.trim() || env.AUTH_SERVICE_TOKEN?.trim()
    : env.MCP_INTROSPECTION_TOKEN?.trim() || env.AUTH_SERVICE_TOKEN?.trim();
  if (!mintToken) {
    throw new HttpError(503, "knowledge_resource_mint_token_not_configured");
  }
  const audience = (env.KNOWLEDGE_PUBLIC_URL?.trim() || env.KNOWLEDGE_WORKER_URL?.trim() || missingConfiguration("KNOWLEDGE_WORKER_URL")).replace(/\/+$/, "");
  const response = await fetch(`${authWorkerUrl(env)}/v1/resource-tokens/mint`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mintToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      resourceId: env.KNOWLEDGE_RESOURCE_ID?.trim() || "workspace-knowledge",
      audience,
      mcpBrokered: !runtimeService,
      scopes,
      toolName,
      toolAlias,
      connectionId: principal.connectionId,
      clientId: runtimeService ? "workspace-mate-runtime" : principal.clientId ?? "workspace-ai-mcp",
      principal: {
        sub: principal.sub,
        email: principal.email,
        name: principal.name,
        role: principal.role,
        team: principal.team,
        teamId: principal.teamId,
        teamPath: principal.teamPath,
        department: principal.department,
        departmentId: principal.departmentId,
        departmentPath: principal.departmentPath,
        orgId: principal.orgId,
        scopes: principal.scopes
      }
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status === 401 ? 502 : response.status, "knowledge_resource_token_mint_failed", text.slice(0, 240));
  }
  const payload = JSON.parse(text) as Record<string, unknown>;
  const token = readString(payload.access_token);
  if (!token) {
    throw new HttpError(502, "knowledge_resource_token_missing");
  }
  return token;
}

function isLocalKnowledgeWorker(baseUrl: string) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}
