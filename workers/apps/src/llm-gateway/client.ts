import { missingConfiguration } from "../../../../src/shared/requiredConfiguration.ts";
import { HttpError, type Env, type AppsWorkerLlmModel, type Principal } from "../core/types";
import { asRecord, parseStringArray, readString } from "../core/utils";
import { monthlyBudgetUsdForPortalJourneyLevel } from "../../../../src/shared/journey";
import {
  DEFAULT_LLM_GATEWAY_RPM_LIMIT,
  DEFAULT_LLM_GATEWAY_TPM_LIMIT,
  LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION,
  shouldRepairLlmGatewayTpmLimit
} from "../../../../src/shared/llmGatewayLimits";

export const DEFAULT_LLM_ENDPOINT = "/v1/chat/completions";
const DEFAULT_USER_MONTHLY_BUDGET_USD = monthlyBudgetUsdForPortalJourneyLevel("newcomer");
export const LLM_APP_SECRET_NAME = "WORKSPACE_LLM_APP_KEY";

export async function listLlmModels(env: Env) {
  const gatewayUrl = liteLlmUrl(env);
  const fallback = fallbackLlmModels();
  const provisioningKey = readString(env.LITELLM_PROVISIONING_KEY).trim();

  if (!provisioningKey) {
    return {
      defaultEndpoint: DEFAULT_LLM_ENDPOINT,
      endpoint: gatewayUrl,
      endpoints: [DEFAULT_LLM_ENDPOINT],
      models: fallback,
      source: "fallback"
    };
  }

  try {
    const catalog = await liteLlmAdminJson(env, "/v1/model/info");
    const models = normalizeLlmCatalogModels(catalog);
    return {
      defaultEndpoint: DEFAULT_LLM_ENDPOINT,
      endpoint: gatewayUrl,
      endpoints: [DEFAULT_LLM_ENDPOINT],
      models: models.length > 0 ? models : fallback,
      source: models.length > 0 ? "litellm" : "fallback"
    };
  } catch {
    return {
      defaultEndpoint: DEFAULT_LLM_ENDPOINT,
      endpoint: gatewayUrl,
      endpoints: [DEFAULT_LLM_ENDPOINT],
      models: fallback,
      source: "fallback"
    };
  }
}

export async function issueLlmAppToken(env: Env, principal: Principal, input: {
  appCode: string;
  appId: string;
  appName: string;
}): Promise<{ token: string; tokenRecord?: Record<string, unknown> }> {
  requireLiteLlmProvisioningKey(env);
  const userId = liteLlmUserIdForPrincipal(principal);
  const userInfo = await ensureLiteLlmUser(env, principal, userId);
  const models = readStringArray(userInfo.models);
  const budgetDuration = readString(userInfo.budget_duration || userInfo.budgetDuration).trim() || "30d";
  const userMonthlyBudgetUsd = positiveNumber(userInfo.max_budget || userInfo.maxBudget) || DEFAULT_USER_MONTHLY_BUDGET_USD;
  const payload = await liteLlmAdminJson(env, "/key/generate", {
    method: "POST",
    body: {
      budget_duration: budgetDuration,
      key_alias: `${input.appName} LLM App Key`,
      metadata: {
        workspace: {
          appCode: input.appCode,
          appId: input.appId,
          issuedVia: "workspace-apps",
          modelSelection: "runtime",
          monthlyBudgetPercent: 100,
          ownerEmail: principal.email,
          ownerOrgId: principal.orgId,
          ownerOrgSlug: principal.orgSlug,
          ownerUserId: principal.sub,
          rateLimitRepairVersion: LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION
        }
      },
      models,
      max_budget: userMonthlyBudgetUsd,
      rpm_limit: DEFAULT_LLM_GATEWAY_RPM_LIMIT,
      tpm_limit: DEFAULT_LLM_GATEWAY_TPM_LIMIT,
      user_id: userId
    }
  });
  const record = asRecord(payload);
  const token = readString(record.key || record.token).trim();

  if (!token) {
    throw new HttpError(502, "litellm_key_create_failed");
  }

  return {
    token,
    tokenRecord: record
  };
}

export async function revokeLlmAppToken(env: Env, token: string, reason = "apps_app_delete") {
  const value = readString(token).trim();
  if (!value) {
    throw new HttpError(400, "litellm_key_missing");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const tokenId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const result = await liteLlmAdminJson(env, "/key/delete", {
    acceptedStatuses: [404],
    method: "POST",
    body: { keys: [tokenId], reason }
  });
  return {
    revoked: !isHttpStatus(result, 404),
    tokenId
  };
}

export function llmGatewayUrl(env: Env) {
  return liteLlmUrl(env);
}

export function liteLlmUrl(env: Env) {
  return (env.LITELLM_URL || missingConfiguration("LITELLM_URL")).replace(/\/+$/, "");
}

async function ensureLiteLlmUser(env: Env, principal: Principal, userId: string): Promise<Record<string, unknown>> {
  const infoPath = `/user/info?user_id=${encodeURIComponent(userId)}`;
  const existing = await liteLlmAdminJson(env, infoPath, {
    acceptedStatuses: [404]
  });

  if (!isHttpStatus(existing, 404)) {
    const userInfo = normalizeLiteLlmUserInfo(existing);
    const repairBudget = positiveNumber(userInfo.max_budget || userInfo.maxBudget) <= 0;
    const repairRpm = positiveNumber(userInfo.rpm_limit || userInfo.rpmLimit) <= 0;
    const metadata = asRecord(userInfo.metadata);
    const workspaceMetadata = asRecord(metadata.workspace);
    const repairTpm = shouldRepairLlmGatewayTpmLimit(
      userInfo.tpm_limit ?? userInfo.tpmLimit,
      workspaceMetadata.rateLimitRepairVersion
    );

    if (!repairBudget && !repairRpm && !repairTpm) {
      return userInfo;
    }

    const updated = await liteLlmAdminJson(env, "/user/update", {
      method: "POST",
      body: {
        ...(repairBudget
          ? {
              budget_duration: "30d",
              max_budget: DEFAULT_USER_MONTHLY_BUDGET_USD
            }
          : {}),
        ...(repairBudget || repairTpm
          ? {
              metadata: {
                ...metadata,
                workspace: {
                  ...workspaceMetadata,
                  ...(repairBudget
                    ? {
                        baseMonthlyBudgetUsd: DEFAULT_USER_MONTHLY_BUDGET_USD,
                        budgetManagedBy: "journey-level",
                        journeyLevelKey: "newcomer"
                      }
                    : {}),
                  rateLimitRepairVersion: LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION
                }
              }
            }
          : {}),
        ...(repairRpm ? { rpm_limit: DEFAULT_LLM_GATEWAY_RPM_LIMIT } : {}),
        ...(repairTpm ? { tpm_limit: DEFAULT_LLM_GATEWAY_TPM_LIMIT } : {}),
        user_id: userId
      }
    });

    return withDefaultLiteLlmUserLimits({
      ...userInfo,
      ...normalizeLiteLlmUserInfo(updated)
    });
  }

  const created = await liteLlmAdminJson(env, "/user/new", {
    method: "POST",
    body: {
      auto_create_key: false,
      budget_duration: "30d",
      max_budget: DEFAULT_USER_MONTHLY_BUDGET_USD,
      metadata: {
        workspace: {
          baseMonthlyBudgetUsd: DEFAULT_USER_MONTHLY_BUDGET_USD,
          budgetManagedBy: "journey-level",
          journeyLevelKey: "newcomer",
          orgId: principal.orgId,
          orgSlug: principal.orgSlug,
          ownerUserId: principal.sub,
          rateLimitRepairVersion: LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION
        }
      },
      user_alias: principal.email || principal.sub,
      user_email: principal.email || userId,
      user_id: userId,
      user_role: "internal_user",
      rpm_limit: DEFAULT_LLM_GATEWAY_RPM_LIMIT,
      tpm_limit: DEFAULT_LLM_GATEWAY_TPM_LIMIT
    }
  });

  return withDefaultLiteLlmUserLimits(normalizeLiteLlmUserInfo(created));
}

async function liteLlmAdminJson(env: Env, path: string, options: {
  acceptedStatuses?: number[];
  body?: unknown;
  method?: string;
} = {}) {
  const provisioningKey = requireLiteLlmProvisioningKey(env);
  const response = await fetch(`${liteLlmUrl(env)}${path}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${provisioningKey}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  if (options.acceptedStatuses?.includes(response.status)) {
    return { status: response.status };
  }

  const text = await response.text();
  let payload: unknown = {};

  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new HttpError(502, "litellm_invalid_json");
    }
  }

  if (!response.ok) {
    throw new HttpError(response.status >= 400 ? response.status : 502, "litellm_admin_request_failed");
  }

  return payload;
}

function requireLiteLlmProvisioningKey(env: Env) {
  const provisioningKey = readString(env.LITELLM_PROVISIONING_KEY).trim();
  if (!provisioningKey) {
    throw new HttpError(503, "litellm_provisioning_key_not_configured");
  }
  return provisioningKey;
}

function liteLlmUserIdForPrincipal(principal: Principal) {
  const email = readString(principal.email).trim().toLowerCase();
  return email || principal.sub;
}

function normalizeLiteLlmUserInfo(value: unknown) {
  const record = asRecord(value);
  return asRecord(record.user_info || record.user || record);
}

function withDefaultLiteLlmUserLimits(userInfo: Record<string, unknown>): Record<string, unknown> {
  return {
    ...userInfo,
    budget_duration: readString(userInfo.budget_duration || userInfo.budgetDuration).trim() || "30d",
    max_budget: positiveNumber(userInfo.max_budget || userInfo.maxBudget) || DEFAULT_USER_MONTHLY_BUDGET_USD,
    rpm_limit: positiveNumber(userInfo.rpm_limit || userInfo.rpmLimit) || DEFAULT_LLM_GATEWAY_RPM_LIMIT,
    tpm_limit: positiveNumber(userInfo.tpm_limit || userInfo.tpmLimit) || DEFAULT_LLM_GATEWAY_TPM_LIMIT
  };
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isHttpStatus(value: unknown, status: number) {
  return Number(asRecord(value).status) === status;
}

function normalizeLlmCatalogModels(models: unknown) {
  const rows = Array.isArray(models) ? models : Array.isArray(asRecord(models).data) ? asRecord(models).data : [];
  if (!Array.isArray(rows)) {
    return [];
  }

  const normalized: AppsWorkerLlmModel[] = [];

  for (const model of rows) {
    const record = asRecord(model);
    const modelInfo = asRecord(record.model_info || record.modelInfo);
    const litellmParams = asRecord(record.litellm_params || record.litellmParams);
    const modelId = readString(record.model_name || record.modelName || record.id || litellmParams.model).trim();
    const blocked = record.blocked === true || modelInfo.blocked === true;
    const mode = readString(record.mode || modelInfo.mode || litellmParams.mode).trim();

    if (!modelId || blocked || (mode && !["chat", "completion", "responses"].includes(mode))) {
      continue;
    }

    normalized.push({
      capabilities: normalizeLiteLlmCapabilities(record, modelInfo),
      contextWindow: Number(modelInfo.max_input_tokens || modelInfo.max_tokens) || undefined,
      displayName: readString(modelInfo.display_name || record.display_name || record.displayName) || modelId,
      endpoints: normalizeLlmEndpoints(modelInfo.endpoints || record.endpoints),
      id: modelId,
      provider: liteLlmProvider(record, modelInfo, litellmParams)
    });
  }

  return normalized;
}

function normalizeLlmEndpoints(value: unknown) {
  if (!Array.isArray(value)) {
    return [DEFAULT_LLM_ENDPOINT];
  }

  const endpoints = value
    .map((endpoint) => {
      if (typeof endpoint === "string") {
        return endpoint;
      }
      const record = asRecord(endpoint);
      return readString(record.path);
    })
    .map((endpoint) => endpoint.replace("{model}", "").trim())
    .filter((endpoint) => endpoint === DEFAULT_LLM_ENDPOINT || endpoint === "/v1/responses");

  return endpoints.length > 0 ? endpoints : [DEFAULT_LLM_ENDPOINT];
}

function normalizeLiteLlmCapabilities(record: Record<string, unknown>, modelInfo: Record<string, unknown>) {
  const capabilities = new Set<string>(["chat"]);
  parseStringArray(record.capabilities || modelInfo.capabilities).forEach((capability) => capabilities.add(capability));

  if (record.supports_function_calling === true || modelInfo.supports_function_calling === true || record.supports_tool_choice === true || modelInfo.supports_tool_choice === true) {
    capabilities.add("tool_calling");
  }

  if (record.supports_vision === true || modelInfo.supports_vision === true) {
    capabilities.add("multimodal_input");
  }

  if (record.supports_reasoning === true || modelInfo.supports_reasoning === true) {
    capabilities.add("reasoning");
  }

  return [...capabilities];
}

function liteLlmProvider(record: Record<string, unknown>, modelInfo: Record<string, unknown>, litellmParams: Record<string, unknown>) {
  const explicit = readString(modelInfo.provider || modelInfo.litellm_provider || litellmParams.litellm_provider || litellmParams.custom_llm_provider || record.provider).trim();
  if (explicit) {
    return explicit;
  }

  const routedModel = readString(litellmParams.model).trim();
  if (routedModel.includes("/")) {
    return routedModel.split("/")[0] || "litellm";
  }

  return "litellm";
}

function readStringArray(value: unknown) {
  return parseStringArray(value).map((item) => item.trim()).filter(Boolean);
}

function fallbackLlmModels(): AppsWorkerLlmModel[] {
  return [
    {
      capabilities: ["chat", "tool_calling", "reasoning"],
      contextWindow: 400000,
      displayName: "GPT 5.4 Mini",
      endpoints: [DEFAULT_LLM_ENDPOINT],
      id: "gpt-5.4-mini",
      provider: "litellm"
    },
    {
      capabilities: ["chat", "tool_calling", "reasoning", "multimodal_input"],
      contextWindow: 1050000,
      displayName: "GPT 5.4",
      endpoints: [DEFAULT_LLM_ENDPOINT],
      id: "gpt-5.4",
      provider: "litellm"
    },
    {
      capabilities: ["chat", "tool_calling", "content_cache", "multimodal_input"],
      contextWindow: 200000,
      displayName: "Claude Sonnet 4.6",
      endpoints: [DEFAULT_LLM_ENDPOINT],
      id: "claude-sonnet-4-6",
      provider: "litellm"
    }
  ];
}
