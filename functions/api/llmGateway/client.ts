import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
type LlmGatewayEnv = {
  LITELLM_ADMIN_READ_TIMEOUT_MS?: string;
  LITELLM_ADMIN_WRITE_TIMEOUT_MS?: string;
  LITELLM_MASTER_KEY?: string;
  LITELLM_PROVISIONING_KEY?: string;
  LITELLM_URL?: string;
};

type LlmGatewayContext<TEnv extends LlmGatewayEnv> = EventContext<TEnv, string, unknown>;

type LlmGatewayClientDeps = {
  fetch?: typeof fetch;
  httpError(status: number, message: string): Error;
  onAdminError?(event: LlmGatewayAdminErrorEvent): void;
};

type LlmGatewayAdminErrorEvent = {
  code:
    | "gateway_token_name_conflict"
    | "llm_gateway_admin_request_failed"
    | "llm_gateway_admin_request_timeout";
  endpoint: string;
  requestId: string;
  upstreamStatus: number;
};

type LlmGatewayRequestInit = {
  body?: unknown;
  method?: string;
  timeoutMs?: number;
};

const DEFAULT_ADMIN_READ_TIMEOUT_MS = 8_000;
const DEFAULT_ADMIN_WRITE_TIMEOUT_MS = 15_000;
const MIN_CONFIGURED_TIMEOUT_MS = 1_000;
const MAX_CONFIGURED_TIMEOUT_MS = 60_000;

export function createLlmGatewayClient(deps: LlmGatewayClientDeps) {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));

  return {
    baseUrl(env: LlmGatewayEnv) {
      return llmGatewayBaseUrl(env);
    },

    requireSecret(value: string | undefined, name: string) {
      return requireLlmGatewaySecret(value, name, deps);
    },

    parseJson(value: string) {
      return parseLlmGatewayJson(value, deps);
    },

    async adminJson<T = unknown, TEnv extends LlmGatewayEnv = LlmGatewayEnv>(
      context: LlmGatewayContext<TEnv>,
      gatewayPath: string,
      init: LlmGatewayRequestInit = {}
    ): Promise<T> {
      const gatewayUrl = llmGatewayBaseUrl(context.env);
      const adminToken = requireLlmGatewaySecret(liteLlmProvisioningKey(context.env), "litellm_provisioning_key", deps);
      const method = (init.method ?? "GET").toUpperCase();
      const timeoutMs = resolveAdminRequestTimeoutMs(context.env, method, init.timeoutMs);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const endpoint = gatewayPath.split("?", 1)[0];
      const fallbackRequestId = requestIdFromPortalRequest(context.request);
      let response: Response;
      let responseText: string;

      try {
        response = await fetchImpl(`${gatewayUrl}${gatewayPath}`, {
          method,
          headers: {
            Authorization: `Bearer ${adminToken}`,
            Accept: "application/json",
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" })
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: controller.signal
        });
        responseText = await response.text();
      } catch {
        const timedOut = controller.signal.aborted;
        reportAdminError(deps.onAdminError, {
          code: timedOut ? "llm_gateway_admin_request_timeout" : "llm_gateway_admin_request_failed",
          endpoint,
          requestId: fallbackRequestId,
          upstreamStatus: 0
        });
        throw deps.httpError(
          timedOut ? 504 : 502,
          timedOut ? "llm_gateway_admin_timeout" : "llm_gateway_admin_unavailable"
        );
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const keyAliasConflict = isLiteLlmKeyAliasConflict(response.status, gatewayPath, responseText);
        const code = keyAliasConflict ? "gateway_token_name_conflict" : "llm_gateway_admin_request_failed";
        reportAdminError(deps.onAdminError, {
          code,
          endpoint,
          requestId: response.headers.get("x-request-id")
            || response.headers.get("cf-ray")
            || fallbackRequestId,
          upstreamStatus: response.status
        });

        if (keyAliasConflict) {
          throw deps.httpError(409, code);
        }

        const safeStatus = response.status === 401 || response.status === 403 ? 502 : response.status;
        throw deps.httpError(safeStatus, `llm_gateway_admin_request_failed:${response.status}`);
      }

      return parseLlmGatewayJson(responseText, deps) as T;
    }
  };
}

function resolveAdminRequestTimeoutMs(
  env: LlmGatewayEnv,
  method: string,
  explicitTimeoutMs: number | undefined
) {
  if (Number.isFinite(explicitTimeoutMs) && Number(explicitTimeoutMs) > 0) {
    return Number(explicitTimeoutMs);
  }

  const isRead = method === "GET" || method === "HEAD";
  const configured = Number(isRead
    ? env.LITELLM_ADMIN_READ_TIMEOUT_MS
    : env.LITELLM_ADMIN_WRITE_TIMEOUT_MS);
  const fallback = isRead ? DEFAULT_ADMIN_READ_TIMEOUT_MS : DEFAULT_ADMIN_WRITE_TIMEOUT_MS;

  if (!Number.isFinite(configured) || configured <= 0) {
    return fallback;
  }

  return Math.min(MAX_CONFIGURED_TIMEOUT_MS, Math.max(MIN_CONFIGURED_TIMEOUT_MS, configured));
}

function requestIdFromPortalRequest(request: Request) {
  return request.headers.get("x-request-id")
    || request.headers.get("cf-ray")
    || "";
}

export function llmGatewayBaseUrl(env: LlmGatewayEnv) {
  return (env.LITELLM_URL?.trim() || missingConfiguration("LITELLM_URL")).replace(/\/+$/, "");
}

export function liteLlmProvisioningKey(env: LlmGatewayEnv) {
  return env.LITELLM_PROVISIONING_KEY;
}

function requireLlmGatewaySecret(value: string | undefined, name: string, deps: LlmGatewayClientDeps) {
  const normalized = value?.trim();

  if (!normalized) {
    throw deps.httpError(503, `${name}_not_configured`);
  }

  return normalized;
}

function parseLlmGatewayJson(value: string, deps: LlmGatewayClientDeps) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw deps.httpError(502, "llm_gateway_invalid_json");
  }
}

function isLiteLlmKeyAliasConflict(upstreamStatus: number, gatewayPath: string, responseText: string) {
  if (upstreamStatus !== 400 || !(gatewayPath === "/key/generate" || gatewayPath === "/key/update")) {
    return false;
  }

  try {
    return containsKeyAliasConflict(JSON.parse(responseText) as unknown);
  } catch {
    return false;
  }
}

function containsKeyAliasConflict(value: unknown, depth = 0): boolean {
  if (depth > 4 || typeof value !== "object" || value === null) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsKeyAliasConflict(item, depth + 1));
  }

  const record = value as Record<string, unknown>;
  const param = typeof record.param === "string" ? record.param.toLowerCase() : "";
  const message = typeof record.message === "string" ? record.message.toLowerCase() : "";

  if (param === "key_alias" && message.includes("already exists") && message.includes("alias")) {
    return true;
  }

  return Object.values(record).some((item) => containsKeyAliasConflict(item, depth + 1));
}

function reportAdminError(
  handler: LlmGatewayClientDeps["onAdminError"],
  event: LlmGatewayAdminErrorEvent
) {
  try {
    handler?.(event);
  } catch {
    // Logging must not change the gateway response contract.
  }
}
