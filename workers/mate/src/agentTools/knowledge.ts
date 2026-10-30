import { missingConfiguration } from "../../../../src/shared/requiredConfiguration.ts";
import { tool } from "ai";
import { z } from "zod";
import { HttpError } from "./http.ts";
import type { MateToolContext, MateToolEnv } from "./types.ts";

export const KNOWLEDGE_READ_SCOPE = "workspace:knowledge:read";
export const KNOWLEDGE_WRITE_SCOPE = "workspace:knowledge:write";
const MAX_SEARCH_SERVICES = 12;
const MAX_INLINE_BINARY_BYTES = 750_000;
const MAX_TEXT_CHARACTERS = 80_000;

export type KnowledgeFetchDeps = {
  fetch?: typeof fetch;
};

export type KnowledgeRequestOptions = {
  body?: BodyInit | Record<string, unknown>;
  headers?: HeadersInit;
  method?: "GET" | "POST";
  scopes?: string[];
  signal?: AbortSignal;
};

export type KnowledgeService = {
  bestFor: string[];
  description: string;
  keywords: string[];
  name: string;
  notFor: string[];
  role: string;
  searchHints: string[];
  serviceId: string;
};

export function createWorkspaceKnowledgeTools(
  env: MateToolEnv,
  context: MateToolContext,
  conversationId: string,
  turnId: string,
  selectedServiceId?: string
) {
  const queryContext = {
    clientSessionId: conversationId,
    clientTurnId: turnId,
    storeOriginalQuestion: false
  };

  return {
    knowledge_base_list: tool({
      description: selectedServiceId
        ? "列出当前用户指定、此刻仍有权访问的单个知识库。当前回答不得扩展到其他知识库。"
        : "列出当前 Workspace 用户此刻有权访问、且允许 Agent 查询的全部知识库。先用它选择相关知识库；不要猜测 serviceId。",
      inputSchema: z.object({}),
      execute: async (_input, options) => listKnowledgeServices(env, context, {
        serviceId: selectedServiceId,
        signal: options.abortSignal
      })
    }),
    knowledge_base_search: tool({
      description: selectedServiceId
        ? "只在用户当前指定的知识库中搜索文档。返回结果只是线索；重要结论应继续调用 knowledge_file_read 阅读原文。"
        : "在一个或多个当前用户有权访问的知识库中搜索文档。serviceIds 省略时会搜索全部可见知识库。返回结果只是线索；重要结论应继续调用 knowledge_file_read 阅读原文。",
      inputSchema: z.object({
        limitPerService: z.number().int().min(1).max(10).default(5),
        query: z.string().trim().min(1).max(500),
        serviceIds: z.array(z.string().trim().min(1).max(180)).max(MAX_SEARCH_SERVICES).optional()
      }),
      execute: async ({ limitPerService, query, serviceIds }, options) => searchKnowledgeServices(
        env,
        context,
        { limitPerService, query, queryContext, scopeServiceId: selectedServiceId, serviceIds },
        { signal: options.abortSignal }
      )
    }),
    knowledge_file_read: tool({
      description: "按 search 返回的 serviceId 与 objectId/relativePath 读取授权文件原文。支持文本和小型图片/二进制文件；图片会作为视觉输入交给模型。",
      inputSchema: z.object({
        objectId: z.string().trim().min(1).max(180).optional(),
        relativePath: z.string().trim().min(1).max(1_024).optional(),
        serviceId: z.string().trim().min(1).max(180)
      }).refine((value) => Boolean(value.objectId || value.relativePath), {
        message: "objectId 或 relativePath 至少提供一个"
      }),
      execute: async ({ objectId, relativePath, serviceId }, options) => readKnowledgeFile(
        env,
        context,
        { objectId, queryContext, relativePath, scopeServiceId: selectedServiceId, serviceId },
        { signal: options.abortSignal }
      ),
      toModelOutput: ({ output }) => knowledgeFileModelOutput(output)
    }),
    knowledge_base_handbook: tool({
      description: "读取一个知识库的使用说明、覆盖范围和查询约束。回答知识库能力边界或不知道如何检索时调用。",
      inputSchema: z.object({
        serviceId: z.string().trim().min(1).max(180)
      }),
      execute: async ({ serviceId }, options) => {
        await assertKnowledgeServiceInScope(env, context, serviceId, selectedServiceId, {
          signal: options.abortSignal
        });
        return knowledgeJson(
          env,
          context,
          `/api/knowledge-services/${encodeURIComponent(serviceId)}/handbook`,
          { signal: options.abortSignal }
        );
      }
    })
  };
}

export async function listKnowledgeServices(
  env: MateToolEnv,
  context: MateToolContext,
  options: { serviceId?: string; signal?: AbortSignal } = {},
  deps: KnowledgeFetchDeps = {}
) {
  const payload = await knowledgeJson(
    env,
    context,
    "/api/knowledge-services?view=card",
    options,
    deps
  );
  const services = arrayValue(record(payload).services)
    .map(normalizeService)
    .filter((service): service is KnowledgeService => Boolean(service))
    .filter((service) => !options.serviceId || service.serviceId === options.serviceId);
  return { count: services.length, services };
}

export async function searchKnowledgeServices(
  env: MateToolEnv,
  context: MateToolContext,
  input: {
    limitPerService: number;
    query: string;
    queryContext?: Record<string, unknown>;
    scopeServiceId?: string;
    serviceIds?: string[];
  },
  options: { signal?: AbortSignal } = {},
  deps: KnowledgeFetchDeps = {}
) {
  const visible = await listKnowledgeServices(env, context, {
    serviceId: input.scopeServiceId,
    signal: options.signal
  }, deps);
  const allowed = new Map(visible.services.map((service) => [service.serviceId, service]));
  const requested = input.serviceIds?.length
    ? [...new Set(input.serviceIds)].map((serviceId) => allowed.get(serviceId)).filter(Boolean)
    : visible.services;
  const services = requested.slice(0, MAX_SEARCH_SERVICES) as KnowledgeService[];
  if (services.length === 0) {
    return { query: input.query, searchedServices: [], searches: [], totalResults: 0 };
  }
  const searches = await Promise.all(services.map(async (service) => {
    const payload = await knowledgeJson(
      env,
      context,
      `/api/knowledge-services/${encodeURIComponent(service.serviceId)}/query`,
      {
        body: {
          action: "search",
          limit: Math.min(Math.max(Math.floor(input.limitPerService || 5), 1), 10),
          query: input.query,
          queryContext: input.queryContext
        },
        method: "POST",
        signal: options.signal
      },
      deps
    );
    const source = record(payload);
    return {
      results: arrayValue(source.results).map(compactSearchResult),
      service
    };
  }));
  return {
    query: input.query,
    searchedServices: services.map((service) => service.serviceId),
    searches,
    totalResults: searches.reduce((total, search) => total + search.results.length, 0)
  };
}

export async function readKnowledgeFile(
  env: MateToolEnv,
  context: MateToolContext,
  input: {
    objectId?: string;
    queryContext?: Record<string, unknown>;
    relativePath?: string;
    scopeServiceId?: string;
    serviceId: string;
  },
  options: { signal?: AbortSignal } = {},
  deps: KnowledgeFetchDeps = {}
) {
  await assertKnowledgeServiceInScope(
    env,
    context,
    input.serviceId,
    input.scopeServiceId,
    options,
    deps
  );
  const payload = record(await knowledgeJson(
    env,
    context,
    `/api/knowledge-services/${encodeURIComponent(input.serviceId)}/query`,
    {
      body: {
        action: "read",
        objectId: input.objectId,
        queryContext: input.queryContext,
        relativePath: input.relativePath
      },
      method: "POST",
      signal: options.signal
    },
    deps
  ));
  const file = record(payload.file);
  const content = record(payload.content);
  const encoding = text(content.encoding).toLowerCase();
  const sizeBytes = numberValue(content.sizeBytes ?? file.sizeBytes);
  const mediaType = text(content.mimeType ?? file.mimeType) || "application/octet-stream";
  const result: Record<string, unknown> = {
    file: {
      contentKind: text(file.contentKind),
      fileName: text(file.fileName),
      mediaType,
      objectId: text(file.objectId),
      relativePath: text(file.relativePath),
      serviceId: input.serviceId,
      sizeBytes
    }
  };
  if (encoding === "text") {
    const body = text(content.text);
    result.content = {
      encoding: "text",
      text: body.slice(0, MAX_TEXT_CHARACTERS),
      truncated: content.truncated === true || body.length > MAX_TEXT_CHARACTERS
    };
    return result;
  }
  const base64 = text(content.base64);
  if (!base64 || sizeBytes > MAX_INLINE_BINARY_BYTES) {
    result.content = {
      encoding: "unavailable",
      reason: sizeBytes > MAX_INLINE_BINARY_BYTES ? "binary_file_too_large_for_agent" : "binary_content_missing"
    };
    return result;
  }
  result.content = { base64, encoding: "base64" };
  return result;
}

export async function previewKnowledgeSource(
  env: MateToolEnv,
  context: MateToolContext,
  input: { objectId: string; serviceId: string },
  request: Request,
  deps: KnowledgeFetchDeps = {}
) {
  await assertKnowledgeServiceInScope(
    env,
    context,
    input.serviceId,
    input.serviceId,
    { signal: request.signal },
    deps
  );
  const forwardedHeaders = new Headers();
  for (const name of ["accept", "if-none-match", "if-range", "range"] as const) {
    const value = request.headers.get(name);
    if (value) forwardedHeaders.set(name, value);
  }
  const response = await knowledgeRequest(
    env,
    context,
    `/api/files/${encodeURIComponent(input.objectId)}/raw`,
    { headers: forwardedHeaders, signal: request.signal },
    deps
  );
  if (!response.ok && response.status !== 304) {
    const responseText = await response.text();
    console.error("workspace_agent_knowledge_preview_failed", {
      status: response.status,
      upstream: responseText.slice(0, 240)
    });
    throw new HttpError(response.status === 401 ? 502 : response.status, "knowledge_preview_request_failed");
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0]?.trim();
  if (!isPreviewContentType(contentType)) {
    throw new HttpError(415, "knowledge_preview_type_unsupported");
  }
  const headers = new Headers();
  for (const name of ["accept-ranges", "content-disposition", "content-length", "content-range", "content-type", "etag", "last-modified"] as const) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  if (contentType === "application/pdf") headers.set("X-Workspace-Allow-Same-Origin-Frame", "1");
  return new Response(response.status === 304 ? null : response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}

async function assertKnowledgeServiceInScope(
  env: MateToolEnv,
  context: MateToolContext,
  serviceId: string,
  scopeServiceId: string | undefined,
  options: { signal?: AbortSignal },
  deps: KnowledgeFetchDeps = {}
) {
  if (!scopeServiceId) return;
  if (serviceId !== scopeServiceId) {
    throw new HttpError(403, "knowledge_base_outside_selected_scope");
  }
  const visible = await listKnowledgeServices(env, context, {
    serviceId: scopeServiceId,
    signal: options.signal
  }, deps);
  if (visible.services.length !== 1) {
    throw new HttpError(403, "selected_knowledge_base_not_visible");
  }
}

export function knowledgeFileModelOutput(value: unknown) {
  const output = record(value);
  const file = record(output.file);
  const content = record(output.content);
  const mediaType = text(file.mediaType) || "application/octet-stream";
  const fileName = text(file.fileName) || text(file.relativePath) || "knowledge-file";
  const citation = JSON.stringify({
    fileName,
    objectId: text(file.objectId),
    relativePath: text(file.relativePath),
    serviceId: text(file.serviceId)
  });
  if (content.encoding === "text") {
    return {
      type: "text" as const,
      value: `Knowledge source: ${citation}\n\n${text(content.text)}`
    };
  }
  if (content.encoding === "base64" && text(content.base64)) {
    return {
      type: "content" as const,
      value: [
        { type: "text" as const, text: `Knowledge source: ${citation}` },
        {
          type: "file" as const,
          data: { data: text(content.base64), type: "data" as const },
          filename: fileName,
          mediaType
        }
      ]
    };
  }
  return {
    type: "text" as const,
    value: `Knowledge file metadata: ${citation}. Binary body was not inlined because it exceeded the safe Agent limit.`
  };
}

async function knowledgeJson(
  env: MateToolEnv,
  context: MateToolContext,
  path: string,
  options: KnowledgeRequestOptions = {},
  deps: KnowledgeFetchDeps = {}
) {
  const response = await knowledgeRequest(env, context, path, options, deps);
  const responseText = await response.text();
  if (!response.ok) {
    console.error("workspace_agent_knowledge_request_failed", {
      status: response.status,
      upstream: responseText.slice(0, 240)
    });
    throw new HttpError(response.status === 401 ? 502 : response.status, "knowledge_worker_request_failed");
  }
  try {
    return responseText ? JSON.parse(responseText) as unknown : {};
  } catch {
    throw new HttpError(502, "knowledge_worker_invalid_json");
  }
}

export async function authorizedKnowledgeRequest(
  env: MateToolEnv,
  context: MateToolContext,
  path: string,
  options: KnowledgeRequestOptions = {},
  deps: KnowledgeFetchDeps = {}
) {
  const baseUrl = knowledgeOrigin(env);
  const headers = new Headers(options.headers);
  const scopes = normalizedKnowledgeScopes(options.scopes);
  const jsonBody = options.body !== undefined && isJsonKnowledgeBody(options.body);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  headers.set("x-workspace-source-channel", "agent");
  if (jsonBody) headers.set("Content-Type", "application/json");
  if (String(env.DEV_AUTH_BYPASS ?? "") === "1" && isLocalOrigin(baseUrl)) {
    headers.set("x-workspace-user-id", context.user.id);
    headers.set("x-workspace-user-email", context.user.email ?? "");
    headers.set("x-workspace-user-name", context.user.name ?? context.user.id);
    headers.set("x-workspace-role", context.user.role ?? "member");
    headers.set("x-workspace-scopes", scopes.join(","));
    if (context.user.team) headers.set("x-workspace-team-name", context.user.team);
    if (context.user.department) headers.set("x-workspace-department-name", context.user.department);
  } else {
    headers.set("Authorization", `Bearer ${await mintKnowledgeToken(env, context, scopes, deps)}`);
  }
  const request = new Request(`${baseUrl}${path}`, {
    body: options.body === undefined
      ? undefined
      : jsonBody
        ? JSON.stringify(options.body)
        : options.body as BodyInit,
    headers,
    method: options.method ?? "GET",
    signal: options.signal
  });
  if (!deps.fetch && env.KNOWLEDGE_SERVICE) {
    return env.KNOWLEDGE_SERVICE.fetch(request);
  }
  return (deps.fetch ?? fetch)(request);
}

async function knowledgeRequest(
  env: MateToolEnv,
  context: MateToolContext,
  path: string,
  options: KnowledgeRequestOptions,
  deps: KnowledgeFetchDeps
) {
  return authorizedKnowledgeRequest(env, context, path, options, deps);
}

function isPreviewContentType(value: string | undefined) {
  return value === "application/pdf"
    || value === "text/markdown"
    || value === "text/x-markdown"
    || value === "text/plain";
}

async function mintKnowledgeToken(
  env: MateToolEnv,
  context: MateToolContext,
  scopes: string[],
  deps: KnowledgeFetchDeps
) {
  const serviceToken = env.MATE_AUTH_SERVICE_TOKEN?.trim();
  if (!serviceToken) throw new HttpError(503, "knowledge_resource_mint_token_not_configured");
  const audience = (env.KNOWLEDGE_PUBLIC_URL?.trim() || knowledgeOrigin(env)).replace(/\/+$/, "");
  const request = new Request(`${authOrigin(env)}/v1/resource-tokens/mint`, {
    body: JSON.stringify({
      audience,
      clientId: "workspace-mate-runtime",
      mcpBrokered: false,
      principal: { sub: context.user.id },
      resourceId: env.KNOWLEDGE_RESOURCE_ID?.trim() || "workspace-knowledge",
      scopes,
      toolName: scopes.includes(KNOWLEDGE_WRITE_SCOPE)
        ? "workspace_mate_workspace_write"
        : "workspace_mate_knowledge_read"
    }),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  });
  const response = !deps.fetch && env.AUTH_SERVICE
    ? await env.AUTH_SERVICE.fetch(request)
    : await (deps.fetch ?? fetch)(request);
  const responseText = await response.text();
  if (!response.ok) {
    console.error("workspace_agent_knowledge_token_mint_failed", {
      status: response.status,
      upstream: responseText.slice(0, 240)
    });
    throw new HttpError(response.status === 401 ? 502 : response.status, "knowledge_resource_token_mint_failed");
  }
  try {
    const token = text(record(JSON.parse(responseText)).access_token);
    if (!token) throw new Error("missing_token");
    return token;
  } catch {
    throw new HttpError(502, "knowledge_resource_token_missing");
  }
}

function normalizedKnowledgeScopes(value: string[] | undefined) {
  const scopes = [...new Set((value?.length ? value : [KNOWLEDGE_READ_SCOPE])
    .map((scope) => scope.trim())
    .filter(Boolean))];
  return scopes.length ? scopes : [KNOWLEDGE_READ_SCOPE];
}

function isJsonKnowledgeBody(value: BodyInit | Record<string, unknown>): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !(value instanceof FormData)
    && !(value instanceof Blob)
    && !(value instanceof URLSearchParams)
    && !(value instanceof ArrayBuffer)
    && !ArrayBuffer.isView(value)
    && !(value instanceof ReadableStream);
}

function knowledgeOrigin(env: MateToolEnv) {
  return requireOrigin(env.KNOWLEDGE_WORKER_URL?.trim() || missingConfiguration("KNOWLEDGE_WORKER_URL"), "knowledge_worker_url_invalid");
}

function authOrigin(env: MateToolEnv) {
  return requireOrigin(env.AUTH_WORKER_URL?.trim() || missingConfiguration("AUTH_WORKER_URL"), "auth_worker_url_invalid");
}

function requireOrigin(value: string, code: string) {
  try {
    const url = new URL(value);
    const local = isLocalOrigin(url.origin);
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:"))
      || url.pathname !== "/"
      || url.search
      || url.hash
      || url.username
      || url.password
    ) throw new Error(code);
    return url.origin;
  } catch {
    throw new HttpError(503, code);
  }
}

function isLocalOrigin(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

function normalizeService(value: unknown): KnowledgeService | undefined {
  const service = record(value);
  const card = record(service.card);
  const serviceId = text(service.serviceId ?? service.id);
  if (!serviceId) return undefined;
  return {
    bestFor: stringArray(card.bestFor ?? service.coverage, 30, 240),
    description: text(service.description).slice(0, 1_000),
    keywords: stringArray(card.keywords ?? service.tags, 30, 64),
    name: text(service.name) || serviceId,
    notFor: stringArray(card.notFor ?? service.notFor, 30, 240),
    role: text(card.role ?? service.role).slice(0, 500),
    searchHints: stringArray(card.searchHints ?? service.searchHints, 30, 240),
    serviceId
  };
}

function stringArray(value: unknown, maxItems: number, maxLength: number) {
  return arrayValue(value)
    .filter((item): item is string => typeof item === "string")
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLength));
}

function compactSearchResult(value: unknown) {
  const result = record(value);
  return {
    contentKind: text(result.contentKind),
    fileName: text(result.fileName),
    lineNumber: numberValue(result.lineNumber),
    mimeType: text(result.mimeType),
    objectId: text(result.objectId),
    relativePath: text(result.relativePath ?? result.path),
    snippet: text(result.snippet ?? result.line).slice(0, 1_200)
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
