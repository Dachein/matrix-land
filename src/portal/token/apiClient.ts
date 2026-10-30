import type {
  GatewayAccessResponse,
  GatewayAccessToken,
  GatewayTokenTestResponse,
  GatewayUsageRefreshResponse,
  GatewayUsageSummary,
  TokenDraft,
  UsageBreakdownResponse,
  UsageBreakdownScope
} from "./types";
import { payloadFromDraft } from "./models";

const KNOWN_GATEWAY_TOKEN_ERROR_CODES = new Set([
  "gateway_token_name_conflict",
  "invalid_gateway_token_name"
]);

const KNOWN_GATEWAY_USAGE_REFRESH_ERROR_CODES = new Set([
  "usage_refresh_in_progress"
]);

const KNOWN_GATEWAY_TOKEN_TEST_ERROR_CODES = new Set([
  "gateway_model_unavailable",
  "gateway_test_request_rejected",
  "gateway_token_access_denied",
  "gateway_token_auth_rejected",
  "gateway_token_budget_exceeded",
  "gateway_token_hash_unavailable",
  "gateway_token_inactive",
  "gateway_token_model_not_allowed",
  "gateway_token_not_found",
  "gateway_token_rate_limited",
  "gateway_token_secret_mismatch",
  "gateway_token_suspended",
  "llm_gateway_test_invalid_response",
  "llm_gateway_test_timeout",
  "llm_gateway_test_unavailable"
]);

export class GatewayTokenApiError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly status: number;

  constructor(status: number, code: string, requestId = "") {
    super(code);
    this.code = code;
    this.requestId = requestId;
    this.status = status;
  }
}

export async function fetchGatewayAccess() {
  const response = await fetch("/api/llm-gateway/access", { cache: "no-store" });

  if (!response.ok) {
    throw new Error("access_unavailable");
  }

  const payload = await response.json() as GatewayAccessResponse;
  if (payload.source?.provider !== "litellm") {
    throw new Error("access_source_not_litellm");
  }
  return payload;
}

export async function fetchGatewayUsageSummary(signal?: AbortSignal): Promise<GatewayUsageSummary> {
  const response = await fetch("/api/llm-gateway/access/usage/summary", {
    cache: "no-store",
    signal
  });

  if (!response.ok) {
    throw new Error("usage_summary_unavailable");
  }

  const payload = objectValue(await response.json());
  const cumulativeTokens = payload.cumulativeTokens;
  if (
    payload.source !== "snapshot"
    || typeof payload.hasSnapshot !== "boolean"
    || typeof cumulativeTokens !== "number"
    || !Number.isFinite(cumulativeTokens)
    || cumulativeTokens < 0
    || typeof payload.refreshScheduled !== "boolean"
  ) {
    throw new Error("usage_summary_invalid_response");
  }

  return {
    source: "snapshot",
    hasSnapshot: payload.hasSnapshot,
    cumulativeTokens: Math.floor(cumulativeTokens),
    ...(typeof payload.updatedAt === "string" ? { updatedAt: payload.updatedAt } : {}),
    ...(typeof payload.dataThroughAt === "string" ? { dataThroughAt: payload.dataThroughAt } : {}),
    ...(typeof payload.lastRefreshRequestedAt === "string"
      ? { lastRefreshRequestedAt: payload.lastRefreshRequestedAt }
      : {}),
    refreshScheduled: payload.refreshScheduled
  };
}

export async function refreshGatewayUsage(options: { trigger?: "automatic" } = {}) {
  const endpoint = options.trigger === "automatic"
    ? "/api/llm-gateway/access/usage/refresh?trigger=automatic"
    : "/api/llm-gateway/access/usage/refresh";
  const response = await fetch(endpoint, {
    method: "POST",
    cache: "no-store"
  });

  if (!response.ok) {
    const payload = await readJson(response);
    const serverCode = readErrorCandidates(payload)
      .find((candidate) => KNOWN_GATEWAY_USAGE_REFRESH_ERROR_CODES.has(candidate));
    throw new GatewayTokenApiError(response.status, serverCode ?? "usage_refresh_failed");
  }

  const payload = await response.json() as GatewayUsageRefreshResponse;
  if (payload.source?.provider !== "litellm" || !payload.analytics) {
    throw new Error("usage_refresh_invalid_response");
  }
  return payload;
}

export async function fetchUsageBreakdown(query: {
  scope: UsageBreakdownScope;
  date?: string;
  key?: string;
}) {
  const search = new URLSearchParams({ scope: query.scope });
  if (query.date) {
    search.set("date", query.date);
  }
  if (query.key) {
    search.set("key", query.key);
  }
  const response = await fetch(`/api/llm-gateway/access/usage/breakdown?${search.toString()}`, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error("usage_breakdown_failed");
  }

  const payload = await response.json() as UsageBreakdownResponse;
  if (payload.source?.provider !== "litellm" || !Array.isArray(payload.models) || !payload.total) {
    throw new Error("usage_breakdown_invalid_response");
  }
  return payload;
}

export async function createGatewayToken(draft: TokenDraft) {
  const response = await fetch("/api/llm-gateway/access/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payloadFromDraft(draft))
  });
  const payload = await readJson(response);

  if (!response.ok) {
    throw gatewayTokenResponseError(response, payload, "token_create_failed");
  }

  return payload as { token?: string; tokenRecord?: GatewayAccessToken };
}

export async function rotateGatewayToken(tokenId: string) {
  const response = await fetch(`/api/llm-gateway/access/tokens/${encodeURIComponent(tokenId)}/rotate`, {
    method: "POST"
  });
  const payload = await readJson(response);

  if (!response.ok) {
    throw gatewayTokenResponseError(response, payload, "token_rotate_failed");
  }

  return payload as {
    token?: string;
    tokenRecord?: GatewayAccessToken;
    warning?: "gateway_token_rotation_alias_pending"
      | "gateway_token_rotation_archive_pending"
      | "gateway_token_rotation_old_key_state_unknown";
  };
}

export async function testGatewayToken({
  apiKey,
  input,
  model,
  signal,
  tokenId
}: {
  apiKey: string;
  input: string;
  model: string;
  signal?: AbortSignal;
  tokenId: string;
}): Promise<GatewayTokenTestResponse> {
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(`/api/llm-gateway/access/tokens/${encodeURIComponent(tokenId)}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        apiKey,
        messages: [{ role: "user", content: input }],
        model
      })
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new GatewayTokenApiError(0, "llm_gateway_test_unavailable");
  }
  const { payload, validJson } = await readTestJson(response);

  if (!response.ok) {
    throw gatewayTokenTestResponseError(response, payload);
  }
  if (!validJson || !isGatewayTokenTestPayload(payload)) {
    throw new GatewayTokenApiError(response.status, "llm_gateway_test_invalid_response");
  }

  return normalizeTestResponse(payload, {
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    requestId: response.headers.get("x-request-id") || response.headers.get("cf-ray") || "",
    status: response.status
  });
}

export async function updateGatewayToken(tokenId: string, draft: TokenDraft) {
  const response = await fetch(`/api/llm-gateway/access/tokens/${encodeURIComponent(tokenId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payloadFromDraft(draft))
  });

  if (!response.ok) {
    throw gatewayTokenResponseError(response, await readJson(response), "token_update_failed");
  }
}

export async function suspendGatewayToken(tokenId: string) {
  const response = await fetch(`/api/llm-gateway/access/tokens/${encodeURIComponent(tokenId)}/suspend`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "user_disabled" })
  });

  if (!response.ok) {
    throw new Error("token_suspend_failed");
  }
}

export async function activateGatewayToken(tokenId: string) {
  const response = await fetch(`/api/llm-gateway/access/tokens/${encodeURIComponent(tokenId)}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" }
  });

  if (!response.ok) {
    throw new Error("token_activate_failed");
  }
}

export async function deleteGatewayToken(tokenId: string) {
  const response = await fetch(`/api/llm-gateway/access/tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    throw new Error("token_delete_failed");
  }
}

function normalizeTestResponse(payload: unknown, transport: { latencyMs: number; requestId: string; status: number }): GatewayTokenTestResponse {
  const root = objectValue(payload);
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice = objectValue(choices[0]);
  const message = objectValue(choice.message);
  const usage = objectValue(root.usage);

  return {
    content: contentText(message.content),
    finishReason: stringValue(choice.finish_reason),
    latencyMs: transport.latencyMs,
    model: stringValue(root.model),
    raw: payload,
    requestId: transport.requestId || stringValue(root.id),
    status: transport.status,
    usage: {
      completionTokens: numberValue(usage.completion_tokens),
      promptTokens: numberValue(usage.prompt_tokens),
      totalTokens: numberValue(usage.total_tokens)
    }
  };
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => typeof part === "string" ? part : stringValue(objectValue(part).text)).filter(Boolean).join("\n");
  }
  return "";
}

async function readJson(response: Response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 500) };
  }
}

async function readTestJson(response: Response) {
  const text = await response.text();
  if (!text) return { payload: undefined, validJson: false };
  try {
    return { payload: JSON.parse(text) as unknown, validJson: true };
  } catch {
    return { payload: undefined, validJson: false };
  }
}

function readErrorCandidates(value: unknown) {
  const root = objectValue(value);
  const error = objectValue(root.error);
  const detail = objectValue(root.detail);
  return [
    root.error,
    error.code,
    error.type,
    error.message,
    detail.code,
    detail.type,
    detail.message,
    root.code,
    root.message
  ].filter((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate));
}

function gatewayTokenResponseError(response: Response, payload: unknown, fallbackCode: string) {
  const serverCode = readErrorCandidates(payload).find((candidate) => KNOWN_GATEWAY_TOKEN_ERROR_CODES.has(candidate));
  const code = serverCode ?? fallbackCode;
  return new GatewayTokenApiError(response.status, code);
}

function gatewayTokenTestResponseError(response: Response, payload: unknown) {
  const serverCode = readErrorCandidates(payload).find((candidate) => KNOWN_GATEWAY_TOKEN_TEST_ERROR_CODES.has(candidate));
  const code = serverCode ?? legacyLiteLlmTestErrorCode(response.status, payload);
  const requestId = stringValue(objectValue(payload).requestId)
    || response.headers.get("x-request-id")
    || response.headers.get("cf-ray")
    || "";
  return new GatewayTokenApiError(response.status, code, requestId);
}

function legacyLiteLlmTestErrorCode(status: number, payload: unknown) {
  const error = objectValue(objectValue(payload).error);
  const classifier = [error.type, error.code, error.param]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (status === 401) return "gateway_token_auth_rejected";
  if (status === 403) return "gateway_token_access_denied";
  if (status === 400 || status === 422) return "gateway_test_request_rejected";
  if (status === 404) return "gateway_model_unavailable";
  if (status === 429) {
    return /budget|quota|spend|credit/.test(classifier)
      ? "gateway_token_budget_exceeded"
      : "gateway_token_rate_limited";
  }
  if (/model[_ -]?(not[_ -]?found|unavailable|invalid)/.test(classifier)) {
    return "gateway_model_unavailable";
  }
  if (status === 408 || status === 504) return "llm_gateway_test_timeout";
  if (status >= 500) return "llm_gateway_test_unavailable";
  return "llm_gateway_test_invalid_response";
}

function isGatewayTokenTestPayload(value: unknown) {
  const root = objectValue(value);
  return Array.isArray(root.choices);
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function numberValue(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}
