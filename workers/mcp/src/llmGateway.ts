import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import { monthlyBudgetUsdForPortalJourneyLevel } from "../../../src/shared/journey.ts";
import {
  DEFAULT_LLM_GATEWAY_RPM_LIMIT,
  DEFAULT_LLM_GATEWAY_TPM_LIMIT,
  LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION,
  shouldRepairLlmGatewayTpmLimit
} from "../../../src/shared/llmGatewayLimits.ts";
import { HttpError, type Env, type Principal } from "./types.ts";
import { WORKSPACE_MCP_VERSION } from "../../../src/shared/mcpHandbook.ts";

const DEFAULT_MONTHLY_BUDGET_USD = monthlyBudgetUsdForPortalJourneyLevel("newcomer");
const DEFAULT_BUDGET_DURATION = "30d";

export async function listGatewayModelCatalog(env: Env) {
  if (!env.LLM_GATEWAY_WORKER) {
    throw new HttpError(503, "llm_gateway_worker_not_configured");
  }
  const response = await env.LLM_GATEWAY_WORKER.fetch("https://llm-gateway-worker.internal/internal/models");
  const text = await response.text();
  if (!response.ok) throw new HttpError(502, "llm_gateway_model_catalog_failed");
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    return {
      ...payload,
      notes: Array.isArray(payload.notes)
        ? payload.notes
        : ["Capability declarations may be incomplete; consult /model_group/info for the provider source."],
      catalogVersion: payload.catalogVersion ?? WORKSPACE_MCP_VERSION
    };
  } catch {
    throw new HttpError(502, "llm_gateway_model_catalog_invalid_json");
  }
}

export async function ensureMcpLiteLlmUser(
  env: Env,
  principal: Principal,
  userId: string
) {
  const normalizedUserId = userId.trim().toLowerCase();
  const existing = await getLiteLlmUser(env, normalizedUserId);

  if (existing) {
    return await repairLiteLlmUserDefaults(env, principal, normalizedUserId, existing);
  }

  const createBody = {
    user_id: normalizedUserId,
    user_email: normalizedUserId,
    user_alias: principal.name?.trim() || normalizedUserId,
    user_role: "internal_user",
    auto_create_key: false,
    max_budget: DEFAULT_MONTHLY_BUDGET_USD,
    rpm_limit: DEFAULT_LLM_GATEWAY_RPM_LIMIT,
    tpm_limit: DEFAULT_LLM_GATEWAY_TPM_LIMIT,
    budget_duration: DEFAULT_BUDGET_DURATION,
    metadata: {
      workspace: journeyBudgetMetadata(principal)
    }
  };

  try {
    return await liteLlmAdminJson(env, "/user/new", {
      method: "POST",
      body: createBody
    });
  } catch (error) {
    const recovered = await getLiteLlmUser(env, normalizedUserId);
    if (recovered) {
      return await repairLiteLlmUserDefaults(env, principal, normalizedUserId, recovered);
    }
    throw error;
  }
}

async function repairLiteLlmUserDefaults(
  env: Env,
  principal: Principal,
  userId: string,
  payload: Record<string, unknown>
) {
  const userInfo = liteLlmUserInfo(payload);
  const repairBudget = positiveNumber(userInfo.max_budget) <= 0
    && positiveNumber(userInfo.maxBudget) <= 0;
  const repairRpm = positiveNumber(userInfo.rpm_limit) <= 0
    && positiveNumber(userInfo.rpmLimit) <= 0;
  const metadata = readRecord(userInfo.metadata);
  const workspaceMetadata = readRecord(metadata.workspace);
  const repairTpm = shouldRepairLlmGatewayTpmLimit(
    userInfo.tpm_limit ?? userInfo.tpmLimit,
    workspaceMetadata.rateLimitRepairVersion
  );

  if (!repairBudget && !repairRpm && !repairTpm) {
    return payload;
  }

  return await liteLlmAdminJson(env, "/user/update", {
    method: "POST",
    body: {
      user_id: userId,
      user_email: readString(userInfo.user_email) || userId,
      user_alias: readString(userInfo.user_alias) || principal.name?.trim() || userId,
      ...(repairBudget ? {
        max_budget: DEFAULT_MONTHLY_BUDGET_USD,
        budget_duration: DEFAULT_BUDGET_DURATION
      } : {}),
      ...(repairBudget || repairTpm ? {
        metadata: {
          ...metadata,
          workspace: {
            ...workspaceMetadata,
            ...(repairBudget ? journeyBudgetMetadata(principal) : {}),
            rateLimitRepairVersion: LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION
          }
        }
      } : {}),
      ...(repairRpm ? { rpm_limit: DEFAULT_LLM_GATEWAY_RPM_LIMIT } : {}),
      ...(repairTpm ? { tpm_limit: DEFAULT_LLM_GATEWAY_TPM_LIMIT } : {})
    }
  });
}

async function getLiteLlmUser(env: Env, userId: string) {
  const response = await liteLlmAdminResponse(
    env,
    `/user/info?user_id=${encodeURIComponent(userId)}`,
    { acceptedStatuses: [404] }
  );

  return response.status === 404 ? undefined : response.payload;
}

async function liteLlmAdminJson(
  env: Env,
  path: string,
  options: { body?: unknown; method?: string } = {}
) {
  const response = await liteLlmAdminResponse(env, path, options);
  return response.payload;
}

async function liteLlmAdminResponse(
  env: Env,
  path: string,
  options: { acceptedStatuses?: number[]; body?: unknown; method?: string } = {}
) {
  const provisioningKey = readString(env.LITELLM_PROVISIONING_KEY).trim();
  if (!provisioningKey) {
    throw new HttpError(503, "litellm_provisioning_key_not_configured");
  }

  const baseUrl = (readString(env.LITELLM_URL).trim() || missingConfiguration("LITELLM_URL")).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${provisioningKey}`,
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  const payload = parseJsonObject(text);

  if (!response.ok && !options.acceptedStatuses?.includes(response.status)) {
    throw new HttpError(response.status >= 400 ? response.status : 502, "litellm_admin_request_failed");
  }

  if (response.ok && !payload) {
    throw new HttpError(502, "litellm_invalid_json");
  }

  return {
    status: response.status,
    payload: payload ?? {}
  };
}

function journeyBudgetMetadata(principal: Principal) {
  return {
    portalUserId: principal.sub,
    ownerTeam: principal.team,
    journeyLevelKey: "newcomer",
    baseMonthlyBudgetUsd: DEFAULT_MONTHLY_BUDGET_USD,
    budgetManagedBy: "journey-level",
    issuedVia: "workspace-mcp",
    rateLimitRepairVersion: LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION
  };
}

function liteLlmUserInfo(value: Record<string, unknown>) {
  const wrapped = readRecord(value.user_info);
  return Object.keys(wrapped).length > 0 ? wrapped : value;
}

function parseJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return readRecord(parsed);
  } catch {
    return undefined;
  }
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
