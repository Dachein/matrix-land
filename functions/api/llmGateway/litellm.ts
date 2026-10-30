import type { PortalCatalog } from "../../../src/shared/types.ts";
import {
  normalizeWorkspaceModelCapabilities,
  type WorkspaceModelCapabilityAssessment
} from "../../../src/shared/workspaceModelCapabilities.ts";
import { normalizeGatewayUsagePurpose } from "./normalizers.ts";

type CurrentUser = PortalCatalog["currentUser"];

export type LiteLlmModelOption = {
  id: string;
  displayName: string;
  capabilityAssessment?: WorkspaceModelCapabilityAssessment;
  pricing?: {
    currency: string;
    inputPerMillionTokens?: number;
    outputPerMillionTokens?: number;
    cacheReadPerMillionTokens?: number;
  };
};

export type LiteLlmDataSource = {
  provider: "litellm";
  mode: "admin-api";
  fetchedAt: string;
  endpoints: string[];
  range?: {
    from: string;
    to: string;
  };
};

export function liteLlmDataSource(endpoints: string[], range?: LiteLlmDataSource["range"]): LiteLlmDataSource {
  return {
    provider: "litellm",
    mode: "admin-api",
    fetchedAt: new Date().toISOString(),
    endpoints,
    ...(range ? { range } : {})
  };
}

export function liteLlmUserIdForPortalUser(user: CurrentUser) {
  const email = readString(user.email).trim().toLowerCase();
  return email || readString(user.id).trim();
}

export function llmGatewayUserScopeFromPortalUser(user: CurrentUser) {
  return {
    externalOrgId: readString(user.identity?.tenantId),
    externalTeamId: readString(user.team),
    externalUserId: liteLlmUserIdForPortalUser(user),
    externalAppId: ""
  };
}

export function normalizeLiteLlmKeys(value: unknown[]) {
  return value.map(normalizeLiteLlmKey).filter((key) => key.id);
}

export function normalizeLiteLlmKey(value: unknown) {
  const row = normalizeUnknownObject(value);
  const tokenHash = readString(row.token_hash ?? row.key_hash ?? row.api_key ?? row.token_id ?? row.key ?? row.token);
  const metadata = normalizeUnknownObject(row.metadata);
  const workspaceMetadata = normalizeUnknownObject(metadata.workspace);
  const monthlyBudgetPercent = readNumber(workspaceMetadata.monthlyBudgetPercent ?? metadata.monthlyBudgetPercent) || 100;
  const blocked = row.blocked === true;

  return {
    id: tokenHash,
    name: readString(row.key_alias ?? row.key_name).trim() || "Frontier Workspace key",
    tokenPrefix: tokenHash.slice(0, 10),
    tokenLast4: tokenHash.slice(-4),
    environment: "live" as const,
    status: readString(row.status) || "active",
    accessStatus: blocked ? "suspended" : "active",
    accessReason: blocked ? "blocked" : undefined,
    externalOrgId: readOptionalString(row.organization_id ?? row.org_id),
    externalTeamId: readOptionalString(row.team_id),
    externalUserId: readOptionalString(row.user_id ?? row.user),
    externalAppId: readOptionalString(metadata.externalAppId),
    allowedModels: readStringArray(row.models),
    requestLimitPerMinute: readNumber(row.rpm_limit ?? row.rpmLimit),
    tokensPerMinute: readNumber(row.tpm_limit ?? row.tpmLimit),
    monthlyBudgetUsd: readNumber(row.max_budget ?? row.maxBudget),
    spendUsd: readNumber(row.spend),
    budgetId: readOptionalString(row.budget_id ?? row.budgetId),
    budgetDuration: readOptionalString(row.budget_duration ?? row.key_budget_duration ?? row.budgetDuration),
    budgetResetAt: readOptionalString(row.budget_reset_at ?? row.budgetResetAt),
    monthlyBudgetPercent,
    usagePurpose: normalizeGatewayUsagePurpose(workspaceMetadata.usagePurpose),
    expiresAt: readOptionalString(row.expires),
    lastUsedAt: readOptionalString(
      row.last_active ?? row.lastActive ?? row.last_used_at ?? row.lastUsedAt ?? row.last_used
    ),
    createdAt: readString(row.created_at ?? row.createdAt),
    metadata
  };
}

export function normalizeLiteLlmUserLimit(userId: string, value: unknown) {
  const row = liteLlmUserInfoObject(value);

  return {
    id: `litellm:user:${userId}`,
    userId,
    status: row.blocked === true ? "disabled" : "active",
    allowedModels: readStringArray(row.models),
    requestLimitPerMinute: readNumber(row.rpm_limit ?? row.rpmLimit),
    tokensPerMinute: readNumber(row.tpm_limit ?? row.tpmLimit),
    monthlyBudgetUsd: readNumber(row.max_budget ?? row.maxBudget),
    spendUsd: readNumber(row.spend),
    createdAt: readString(row.created_at ?? row.createdAt),
    updatedAt: readString(row.updated_at ?? row.updatedAt)
  };
}

export function liteLlmUserInfoObject(value: unknown): Record<string, unknown> {
  const row = normalizeUnknownObject(value);
  const userInfo = normalizeUnknownObject(row.user_info);
  return Object.keys(userInfo).length > 0 ? userInfo : row;
}

export function normalizeLiteLlmModelOptions(value: unknown[]): LiteLlmModelOption[] {
  const models = normalizeLiteLlmVisibleModelEntries(value)
    .map(({ id, displayName, capabilityAssessment, pricing }) => ({
      id,
      displayName,
      ...(capabilityAssessment ? { capabilityAssessment } : {}),
      ...(pricing ? { pricing } : {})
    }));
  const seen = new Set<string>();

  return models.filter((model) => {
    if (seen.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  }).sort(compareModelNames);
}

/**
 * Returns the same visible, supported chat model set used by user selectors.
 * LiteLLM's /v1/model/info response is the visibility source of truth;
 * /v1/models does not reliably preserve hidden/blocked metadata.
 */
export function normalizeLiteLlmVisibleModelEntries(value: unknown[]) {
  const models = value
    .map(normalizeLiteLlmModelEntry)
    .filter((model) => model.id && model.supported && !model.hidden);
  const seen = new Set<string>();

  return models.filter((model) => {
    if (seen.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  }).sort(compareModelNames);
}

export function normalizeLiteLlmModelCatalog(value: unknown[]) {
  const models = value
    .map(normalizeLiteLlmModelEntry)
    .filter((model) => model.id && !model.hidden)
    .map((model) => {
      const vendor = model.provider || "litellm";

      return {
        id: model.id,
        displayName: model.displayName,
        category: "chat",
        supported: model.supported,
        defaultVendor: vendor,
        description: model.description,
        capabilities: model.tags,
        limits: {
          maxPromptTokens: model.maxInputTokens,
          maxCompletionTokens: model.maxOutputTokens
        },
        pricing: {
          modelRatio: model.inputCostPerMillion ?? 0,
          completionRatio: model.outputCostPerMillion ?? 0,
          modelPrice: 0
        },
        vendorRoutes: {
          [vendor]: {
            status: model.supported ? "active" : "blocked",
            vendorModelCode: model.baseModel || model.id,
            supportedEndpointTypes: ["openai"],
            endpoints: [{ type: "openai", path: "/v1/chat/completions", method: "POST" }]
          }
        }
      };
    })
    .sort(compareModelNames);
  const vendors = Array.from(new Set(models.map((model) => model.defaultVendor))).map((vendor) => ({
    id: vendor,
    displayName: vendorLabel(vendor),
    kind: vendor.includes("tencent") ? "tencent" : vendor.includes("bedrock") || vendor.includes("aws") ? "aws" : "litellm",
    status: "active"
  }));

  return {
    version: "litellm",
    source: {
      provider: "litellm",
      importedFrom: "/v1/model/info",
      importedAt: new Date().toISOString(),
      modelCount: models.length
    },
    vendors,
    upstreamVendors: [],
    models
  };
}

export function normalizeLiteLlmSpendRollups(logs: unknown[], keys: ReturnType<typeof normalizeLiteLlmKeys>, periodStart: string) {
  const keyUserByHash = new Map(keys.map((key) => [key.id, key.externalUserId ?? ""]));
  const acc = new Map<string, ReturnType<typeof emptyUsage>>();

  for (const log of logs) {
    const row = normalizeUnknownObject(log);
    const tokenId = readString(row.api_key);
    const userId = readString(row.user) || keyUserByHash.get(tokenId) || "";

    addUsage(acc, "token", tokenId, periodStart, row);
    addUsage(acc, "user", userId, periodStart, row);
    addUsage(acc, "model", readString(row.model), periodStart, row);
    addUsage(acc, "provider", providerForModel(readString(row.model)), periodStart, row);
  }

  return Array.from(acc.values());
}

export function normalizeLiteLlmSpendSeries(logs: unknown[], keys: ReturnType<typeof normalizeLiteLlmKeys>, groupBy: string = "token") {
  const keyUserByHash = new Map(keys.map((key) => [key.id, key.externalUserId ?? ""]));
  const acc = new Map<string, ReturnType<typeof emptySeriesUsage>>();

  for (const log of logs) {
    const row = normalizeUnknownObject(log);
    const tokenId = readString(row.api_key);
    const userId = readString(row.user) || keyUserByHash.get(tokenId) || "";
    const date = readString(row.startTime).slice(0, 10) || new Date().toISOString().slice(0, 10);
    const groupId = groupIdForSpendLog(groupBy, row, tokenId, userId);

    if (!groupId) {
      continue;
    }

    const key = `${date}:${groupBy}:${groupId}`;
    const current = acc.get(key) ?? emptySeriesUsage(`${date} 00:00:00`, groupBy, groupId);

    acc.set(key, mergeUsage(current, row));
  }

  return Array.from(acc.values()).sort((left, right) => left.periodStart.localeCompare(right.periodStart));
}

export function normalizeLiteLlmSpendRequests(logs: unknown[]) {
  return logs.map((log) => {
    const row = normalizeUnknownObject(log);
    const totalTokens = readNumber(row.total_tokens);

    return {
      id: readString(row.request_id),
      request_id: readString(row.request_id),
      token_id: readString(row.api_key),
      external_user_id: readString(row.user),
      provider: providerForModel(readString(row.model)),
      model: readString(row.model),
      status: "completed",
      input_tokens: readNumber(row.prompt_tokens),
      output_tokens: readNumber(row.completion_tokens),
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: Math.max(0, totalTokens - readNumber(row.prompt_tokens) - readNumber(row.completion_tokens)),
      billable_units: totalTokens,
      estimated_cost_usd: readNumber(row.spend),
      latency_ms: 0,
      created_at: readString(row.startTime),
      completed_at: readString(row.endTime)
    };
  });
}

export function normalizeLiteLlmActivityUsage(
  value: unknown,
  keys: ReturnType<typeof normalizeLiteLlmKeys>,
  periodStart: string
) {
  const keyUserByHash = new Map(keys.map((key) => [key.id, key.externalUserId ?? ""]));
  const acc = new Map<string, ReturnType<typeof emptyUsage>>();

  for (const result of liteLlmActivityResults(value)) {
    const row = normalizeUnknownObject(result);
    const breakdown = normalizeUnknownObject(row.breakdown);

    addActivityBreakdownUsage(acc, "model", breakdown.models, periodStart);
    addActivityBreakdownUsage(acc, "provider", breakdown.providers, periodStart);
    addActivityBreakdownUsage(acc, "token", breakdown.api_keys, periodStart);
    addActivityUserUsage(acc, breakdown.api_keys, keyUserByHash, periodStart);
  }

  return Array.from(acc.values());
}

export function normalizeLiteLlmActivitySeries(
  value: unknown,
  keys: ReturnType<typeof normalizeLiteLlmKeys>,
  groupBy: string = "token"
) {
  const keyUserByHash = new Map(keys.map((key) => [key.id, key.externalUserId ?? ""]));
  const acc = new Map<string, ReturnType<typeof emptySeriesUsage>>();

  for (const result of liteLlmActivityResults(value)) {
    const row = normalizeUnknownObject(result);
    const date = readString(row.date).slice(0, 10);
    if (!date) {
      continue;
    }
    const breakdown = normalizeUnknownObject(row.breakdown);
    const periodStart = `${date} 00:00:00`;

    if (groupBy === "user") {
      addActivityUserSeries(acc, breakdown.api_keys, keyUserByHash, periodStart);
      continue;
    }

    const [groupType, collection] = groupBy === "model"
      ? ["model", breakdown.models]
      : groupBy === "provider"
        ? ["provider", breakdown.providers]
        : ["token", breakdown.api_keys];
    addActivityBreakdownSeries(acc, groupType, collection, periodStart);
  }

  return Array.from(acc.values()).sort((left, right) =>
    left.periodStart.localeCompare(right.periodStart)
    || left.groupId.localeCompare(right.groupId)
  );
}

export function liteLlmActivityRequestTotal(value: unknown) {
  const metadata = normalizeUnknownObject(normalizeUnknownObject(value).metadata);
  return readNumber(metadata.total_api_requests);
}

export function readLiteLlmDataArray(value: unknown) {
  const row = normalizeUnknownObject(value);
  if (Array.isArray(row.data)) {
    return row.data;
  }
  if (Array.isArray(row.models)) {
    return row.models;
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function normalizeLiteLlmModelEntry(value: unknown) {
  const row = normalizeUnknownObject(value);
  const modelInfo = normalizeUnknownObject(row.model_info);
  const litellmParams = normalizeUnknownObject(row.litellm_params);
  const publishedPricing = normalizeUnknownObject(modelInfo.pricing_usd_per_million_tokens);
  const capabilityAssessment = normalizeWorkspaceModelCapabilities(modelInfo.workspace_capabilities);
  const modelName = readString(row.model_name ?? modelInfo.id ?? row.id).trim();
  const blocked = modelInfo.blocked === true || row.blocked === true;
  const hidden = modelInfo.hidden === true || row.hidden === true;
  const mode = readString(modelInfo.mode ?? row.mode);
  const inputCostPerMillion = readOptionalNumber(publishedPricing.input)
    ?? perTokenCostPerMillion(modelInfo.input_cost_per_token)
    ?? perTokenCostPerMillion(litellmParams.input_cost_per_token);
  const outputCostPerMillion = readOptionalNumber(publishedPricing.output)
    ?? perTokenCostPerMillion(modelInfo.output_cost_per_token)
    ?? perTokenCostPerMillion(litellmParams.output_cost_per_token);
  const cacheCostPerMillion = readOptionalNumber(publishedPricing.cache)
    ?? perTokenCostPerMillion(modelInfo.cache_read_input_token_cost)
    ?? perTokenCostPerMillion(litellmParams.cache_read_input_token_cost)
    ?? perTokenCostPerMillion(litellmParams.input_cost_per_token_cache_hit);
  const hasPricing = inputCostPerMillion !== undefined
    || outputCostPerMillion !== undefined
    || cacheCostPerMillion !== undefined;

  return {
    id: modelName,
    displayName: readString(modelInfo.display_name ?? row.display_name).trim() || modelName,
    baseModel: readString(modelInfo.base_model ?? litellmParams.model).replace(/^openai\//, ""),
    provider: readString(modelInfo.provider ?? modelInfo.litellm_provider ?? row.provider).trim() || providerForModel(modelName),
    description: readString(modelInfo.description ?? row.description),
    tags: readStringArray(modelInfo.tags),
    hidden,
    supported: !blocked && !hidden && (!mode || mode === "chat"),
    ...(capabilityAssessment ? {
      capabilityAssessment
    } : {}),
    maxInputTokens: readNumber(modelInfo.max_input_tokens),
    maxOutputTokens: readNumber(modelInfo.max_output_tokens ?? modelInfo.max_tokens),
    inputCostPerMillion,
    outputCostPerMillion,
    pricing: hasPricing ? {
      currency: readString(modelInfo.currency).trim().toUpperCase() || "USD",
      inputPerMillionTokens: inputCostPerMillion,
      outputPerMillionTokens: outputCostPerMillion,
      cacheReadPerMillionTokens: cacheCostPerMillion
    } : undefined
  };
}

function compareModelNames(left: { displayName: string; id: string }, right: { displayName: string; id: string }) {
  return left.displayName.localeCompare(right.displayName, "en", { sensitivity: "base" })
    || left.id.localeCompare(right.id, "en", { sensitivity: "base" });
}

function addUsage(acc: Map<string, ReturnType<typeof emptyUsage>>, scopeType: string, scopeId: string, periodStart: string, row: Record<string, unknown>) {
  if (!scopeId) {
    return;
  }

  const key = `${scopeType}:${scopeId}`;
  const current = acc.get(key) ?? emptyUsage(scopeType, scopeId, periodStart);
  acc.set(key, mergeUsage(current, row));
}

function addActivityBreakdownUsage(
  acc: Map<string, ReturnType<typeof emptyUsage>>,
  scopeType: string,
  value: unknown,
  periodStart: string
) {
  for (const [scopeId, entry] of Object.entries(normalizeUnknownObject(value))) {
    if (!scopeId) {
      continue;
    }
    const key = `${scopeType}:${scopeId}`;
    const current = acc.get(key) ?? emptyUsage(scopeType, scopeId, periodStart);
    acc.set(key, mergeActivityUsage(current, activityMetrics(entry)));
  }
}

function addActivityUserUsage(
  acc: Map<string, ReturnType<typeof emptyUsage>>,
  value: unknown,
  keyUserByHash: Map<string, string>,
  periodStart: string
) {
  for (const [tokenId, entry] of Object.entries(normalizeUnknownObject(value))) {
    const userId = keyUserByHash.get(tokenId) ?? "";
    if (!userId) {
      continue;
    }
    const key = `user:${userId}`;
    const current = acc.get(key) ?? emptyUsage("user", userId, periodStart);
    acc.set(key, mergeActivityUsage(current, activityMetrics(entry)));
  }
}

function addActivityBreakdownSeries(
  acc: Map<string, ReturnType<typeof emptySeriesUsage>>,
  groupType: string,
  value: unknown,
  periodStart: string
) {
  for (const [groupId, entry] of Object.entries(normalizeUnknownObject(value))) {
    if (!groupId) {
      continue;
    }
    const key = `${periodStart}:${groupType}:${groupId}`;
    const current = acc.get(key) ?? emptySeriesUsage(periodStart, groupType, groupId);
    acc.set(key, mergeActivityUsage(current, activityMetrics(entry)));
  }
}

function addActivityUserSeries(
  acc: Map<string, ReturnType<typeof emptySeriesUsage>>,
  value: unknown,
  keyUserByHash: Map<string, string>,
  periodStart: string
) {
  for (const [tokenId, entry] of Object.entries(normalizeUnknownObject(value))) {
    const userId = keyUserByHash.get(tokenId) ?? "";
    if (!userId) {
      continue;
    }
    const key = `${periodStart}:user:${userId}`;
    const current = acc.get(key) ?? emptySeriesUsage(periodStart, "user", userId);
    acc.set(key, mergeActivityUsage(current, activityMetrics(entry)));
  }
}

function mergeActivityUsage<
  T extends ReturnType<typeof emptyUsage> | ReturnType<typeof emptySeriesUsage>
>(current: T, metrics: Record<string, unknown>): T {
  const promptTokens = readNumber(metrics.prompt_tokens);
  const completionTokens = readNumber(metrics.completion_tokens);
  const totalTokens = readNumber(metrics.total_tokens) || promptTokens + completionTokens;

  return {
    ...current,
    requests: current.requests + readNumber(metrics.api_requests),
    failedRequests: current.failedRequests + readNumber(metrics.failed_requests),
    inputTokens: current.inputTokens + promptTokens,
    outputTokens: current.outputTokens + completionTokens,
    cachedInputTokens: current.cachedInputTokens + readNumber(metrics.cache_read_input_tokens),
    cacheWriteInputTokens: current.cacheWriteInputTokens + readNumber(metrics.cache_creation_input_tokens),
    reasoningOutputTokens: current.reasoningOutputTokens + Math.max(0, totalTokens - promptTokens - completionTokens),
    billableUnits: current.billableUnits + totalTokens,
    estimatedCostUsd: current.estimatedCostUsd + readNumber(metrics.spend)
  };
}

function activityMetrics(value: unknown) {
  const row = normalizeUnknownObject(value);
  const metrics = normalizeUnknownObject(row.metrics);
  return Object.keys(metrics).length > 0 ? metrics : row;
}

function liteLlmActivityResults(value: unknown) {
  const results = normalizeUnknownObject(value).results;
  return Array.isArray(results) ? results : [];
}

function mergeUsage<T extends ReturnType<typeof emptyUsage> | ReturnType<typeof emptySeriesUsage>>(current: T, row: Record<string, unknown>): T {
  const promptTokens = readNumber(row.prompt_tokens);
  const completionTokens = readNumber(row.completion_tokens);
  const totalTokens = readNumber(row.total_tokens) || promptTokens + completionTokens;

  return {
    ...current,
    requests: current.requests + 1,
    inputTokens: current.inputTokens + promptTokens,
    outputTokens: current.outputTokens + completionTokens,
    reasoningOutputTokens: current.reasoningOutputTokens + Math.max(0, totalTokens - promptTokens - completionTokens),
    billableUnits: current.billableUnits + totalTokens,
    estimatedCostUsd: current.estimatedCostUsd + readNumber(row.spend)
  };
}

function emptyUsage(scopeType: string, scopeId: string, periodStart: string) {
  return {
    id: `litellm:${scopeType}:${scopeId}:${periodStart.slice(0, 10)}`,
    scopeType,
    scopeId,
    periodType: "month",
    periodStart,
    periodEnd: "",
    requests: 0,
    blockedRequests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
    billableUnits: 0,
    estimatedCostUsd: 0,
    updatedAt: new Date().toISOString()
  };
}

function emptySeriesUsage(periodStart: string, groupType: string, groupId: string) {
  return {
    periodStart,
    groupType,
    groupId,
    requests: 0,
    blockedRequests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
    billableUnits: 0,
    estimatedCostUsd: 0
  };
}

function groupIdForSpendLog(groupBy: string, row: Record<string, unknown>, tokenId: string, userId: string) {
  if (groupBy === "user") {
    return userId;
  }
  if (groupBy === "model") {
    return readString(row.model);
  }
  if (groupBy === "provider") {
    return providerForModel(readString(row.model));
  }
  return tokenId;
}

function providerForModel(model: string) {
  if (model.startsWith("tencent-")) {
    return "tencent-tokenhub-intl";
  }
  if (model.startsWith("aws-") || model.includes("bedrock")) {
    return "aws-bedrock";
  }
  if (model.startsWith("openai") || model.startsWith("gpt-")) {
    return "openai";
  }
  return "litellm";
}

function vendorLabel(vendor: string) {
  if (vendor.includes("tencent")) {
    return "Tencent Cloud";
  }
  if (vendor.includes("bedrock") || vendor.includes("aws")) {
    return "AWS Bedrock";
  }
  if (vendor === "openai") {
    return "OpenAI";
  }
  return vendor;
}

function readStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => readString(item).trim()).filter(Boolean);
  }

  try {
    const parsed = JSON.parse(readString(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => readString(item).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

function readNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function readOptionalNumber(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function perTokenCostPerMillion(value: unknown) {
  const cost = readOptionalNumber(value);
  return cost === undefined ? undefined : Number((cost * 1_000_000).toFixed(9));
}

function normalizeUnknownObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
