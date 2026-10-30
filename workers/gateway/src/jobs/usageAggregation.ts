import {
  addIsoDateDays,
  dateKeyInTimeZone,
  GATEWAY_USAGE_TIMEZONE,
  type UsageDailyModelSnapshotInput,
  type UsageDailySnapshotInput
} from "../../../../functions/api/llmGateway/usageSnapshots.ts";

const UNKNOWN_TOKEN_ID = "__unknown__";

export type RollupWindow = {
  snapshotDate: string;
  dataThroughDate: string;
};

export type AggregateSpendResult = {
  rows: UsageDailySnapshotInput[];
  modelRows: UsageDailyModelSnapshotInput[];
  sourceRowCount: number;
  attributedRowCount: number;
  unattributedRowCount: number;
  userIds: string[];
};

export function usageRollupWindow(scheduledAt: Date): RollupWindow {
  const snapshotDate = dateKeyInTimeZone(scheduledAt, GATEWAY_USAGE_TIMEZONE);
  return {
    snapshotDate,
    dataThroughDate: addIsoDateDays(snapshotDate, -1)
  };
}

export function shanghaiSpendQueryRange(fromDate: string, toDate: string) {
  return {
    startDate: `${addIsoDateDays(fromDate, -1)} 16:00:00`,
    endDate: `${toDate} 16:00:00`
  };
}

export function chunkIsoDateRange(fromDate: string, toDate: string, chunkDays: number) {
  const chunks: Array<{ fromDate: string; toDate: string }> = [];
  const normalizedChunkDays = boundedInteger(chunkDays, 1, 90, 31);
  let cursor = fromDate;

  while (cursor <= toDate) {
    const chunkEnd = minIsoDate(addIsoDateDays(cursor, normalizedChunkDays - 1), toDate);
    chunks.push({ fromDate: cursor, toDate: chunkEnd });
    cursor = addIsoDateDays(chunkEnd, 1);
  }

  return chunks;
}

export function aggregateLiteLlmSpendLogs(
  logs: unknown[],
  tokenUserIds: ReadonlyMap<string, string>,
  fromDate: string,
  toDate: string
): AggregateSpendResult {
  const accumulator = createLiteLlmSpendAccumulator(tokenUserIds, fromDate, toDate);
  accumulator.add(logs);
  return accumulator.result();
}

export function createLiteLlmSpendAccumulator(
  tokenUserIds: ReadonlyMap<string, string>,
  fromDate: string,
  toDate: string
) {
  const usage = new Map<string, UsageDailySnapshotInput>();
  const modelUsage = new Map<string, UsageDailyModelSnapshotInput>();
  const seenRequestIds = new Set<string>();
  const userIds = new Set<string>();
  let sourceRowCount = 0;
  let attributedRowCount = 0;
  let unattributedRowCount = 0;

  return {
    add(logs: unknown[]) {
      sourceRowCount += logs.length;

      for (const value of logs) {
        const row = readRecord(value);
        const timestamp = spendTimestamp(row);
        const usageDate = shanghaiDateForTimestamp(timestamp);
        if (!usageDate || usageDate < fromDate || usageDate > toDate) {
          continue;
        }

        const requestId = readText(row.request_id ?? row.requestId).trim();
        if (requestId && seenRequestIds.has(requestId)) {
          continue;
        }
        if (requestId) {
          seenRequestIds.add(requestId);
        }

        const tokenId = readText(row.api_key ?? row.apiKey ?? row.token_id ?? row.tokenId).trim() || UNKNOWN_TOKEN_ID;
        const externalUserId = normalizeUserId(
          row.user ?? row.user_id ?? row.userId ?? tokenUserIds.get(tokenId)
        );
        if (!externalUserId) {
          unattributedRowCount += 1;
          continue;
        }

        const metrics = spendMetrics(row);
        const key = `${usageDate}\u0000${externalUserId}\u0000${tokenId}`;
        const current = usage.get(key) ?? {
          date: usageDate,
          externalUserId,
          tokenId,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          tokens: 0,
          estimatedCostUsd: 0
        };

        current.requests += 1;
        current.inputTokens += metrics.inputTokens;
        current.outputTokens += metrics.outputTokens;
        current.reasoningOutputTokens += metrics.reasoningOutputTokens;
        current.tokens += metrics.tokens;
        current.estimatedCostUsd += metrics.billedCostUsd;
        usage.set(key, current);

        const modelIdentity = spendModelIdentity(row);
        const modelKey = [
          usageDate,
          externalUserId,
          tokenId,
          modelIdentity.modelGroup,
          modelIdentity.upstreamModel
        ].join("\u0000");
        const currentModel = modelUsage.get(modelKey) ?? {
          date: usageDate,
          externalUserId,
          tokenId,
          ...modelIdentity,
          requests: 0,
          inputTokens: 0,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          tokens: 0,
          inputCostUsd: 0,
          outputCostUsd: 0,
          cacheReadCostUsd: 0,
          cacheWriteCostUsd: 0,
          toolCostUsd: 0,
          originalCostUsd: 0,
          discountUsd: 0,
          billedCostUsd: 0
        };

        currentModel.requests += 1;
        currentModel.inputTokens += metrics.inputTokens;
        currentModel.cacheReadInputTokens += metrics.cacheReadInputTokens;
        currentModel.cacheWriteInputTokens += metrics.cacheWriteInputTokens;
        currentModel.outputTokens += metrics.outputTokens;
        currentModel.reasoningOutputTokens += metrics.reasoningOutputTokens;
        currentModel.tokens += metrics.tokens;
        currentModel.inputCostUsd += metrics.inputCostUsd;
        currentModel.outputCostUsd += metrics.outputCostUsd;
        currentModel.cacheReadCostUsd += metrics.cacheReadCostUsd;
        currentModel.cacheWriteCostUsd += metrics.cacheWriteCostUsd;
        currentModel.toolCostUsd += metrics.toolCostUsd;
        currentModel.originalCostUsd += metrics.originalCostUsd;
        currentModel.discountUsd += metrics.discountUsd;
        currentModel.billedCostUsd += metrics.billedCostUsd;
        modelUsage.set(modelKey, currentModel);

        userIds.add(externalUserId);
        attributedRowCount += 1;
      }
    },

    result(): AggregateSpendResult {
      return {
        rows: Array.from(usage.values()).sort((left, right) => (
          left.date.localeCompare(right.date)
          || left.externalUserId.localeCompare(right.externalUserId)
          || left.tokenId.localeCompare(right.tokenId)
        )),
        modelRows: Array.from(modelUsage.values()).sort((left, right) => (
          left.date.localeCompare(right.date)
          || left.externalUserId.localeCompare(right.externalUserId)
          || left.tokenId.localeCompare(right.tokenId)
          || left.modelGroup.localeCompare(right.modelGroup)
          || left.upstreamModel.localeCompare(right.upstreamModel)
        )),
        sourceRowCount,
        attributedRowCount,
        unattributedRowCount,
        userIds: Array.from(userIds).sort()
      };
    }
  };
}

function spendModelIdentity(row: Record<string, unknown>) {
  const modelGroup = readText(row.model_group ?? row.modelGroup ?? row.model).trim() || "unknown";
  const upstreamModel = readText(row.model ?? row.model_id ?? row.modelId).trim() || modelGroup;
  const provider = readText(row.custom_llm_provider ?? row.customLlmProvider).trim() || "unknown";
  return { modelGroup, upstreamModel, provider };
}

function spendMetrics(row: Record<string, unknown>) {
  const metadata = readRecord(row.metadata);
  const usage = readRecord(metadata.usage_object ?? row.usage);
  const promptDetails = readRecord(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const completionDetails = readRecord(usage.completion_tokens_details ?? usage.output_tokens_details);
  const costBreakdown = readRecord(metadata.cost_breakdown ?? row.cost_breakdown);
  const inputTokens = nonNegativeInteger(row.prompt_tokens ?? row.input_tokens ?? row.inputTokens);
  const outputTokens = nonNegativeInteger(row.completion_tokens ?? row.output_tokens ?? row.outputTokens);
  const explicitTokens = nonNegativeInteger(row.total_tokens ?? row.totalTokens);
  const tokens = explicitTokens || inputTokens + outputTokens;
  const explicitReasoningTokens = nonNegativeInteger(
    completionDetails.reasoning_tokens
      ?? row.reasoning_output_tokens
      ?? row.reasoningOutputTokens
  );
  const reasoningOutputTokens = explicitReasoningTokens || Math.max(0, tokens - inputTokens - outputTokens);
  const billedCostUsd = nonNegativeNumber(
    row.spend
      ?? row.estimated_cost_usd
      ?? row.estimatedCostUsd
      ?? costBreakdown.total_cost
  );

  return {
    inputTokens,
    cacheReadInputTokens: maxNonNegativeInteger([
      row.cache_read_input_tokens,
      row.cached_input_tokens,
      promptDetails.cached_tokens,
      promptDetails.cache_read_input_tokens
    ]),
    cacheWriteInputTokens: maxNonNegativeInteger([
      row.cache_creation_input_tokens,
      row.cache_write_input_tokens,
      promptDetails.cache_creation_tokens,
      promptDetails.cache_write_tokens
    ]),
    outputTokens,
    reasoningOutputTokens,
    tokens,
    inputCostUsd: nonNegativeNumber(costBreakdown.input_cost),
    outputCostUsd: nonNegativeNumber(costBreakdown.output_cost),
    cacheReadCostUsd: nonNegativeNumber(
      costBreakdown.cache_read_input_cost ?? costBreakdown.cache_read_cost
    ),
    cacheWriteCostUsd: nonNegativeNumber(
      costBreakdown.cache_creation_input_cost
        ?? costBreakdown.cache_write_input_cost
        ?? costBreakdown.cache_write_cost
    ),
    toolCostUsd: nonNegativeNumber(costBreakdown.tool_usage_cost),
    originalCostUsd: nonNegativeNumber(costBreakdown.original_cost ?? costBreakdown.total_cost ?? billedCostUsd),
    discountUsd: nonNegativeNumber(costBreakdown.discount_amount),
    billedCostUsd
  };
}

function maxNonNegativeInteger(values: unknown[]) {
  return values.reduce<number>((maximum, value) => Math.max(maximum, nonNegativeInteger(value)), 0);
}

export function normalizeUserBudgetMap(value: unknown) {
  const payload = readRecord(value);
  const users = Array.isArray(value)
    ? value
    : Array.isArray(payload.users)
      ? payload.users
      : Array.isArray(payload.data)
        ? payload.data
        : [];
  const budgets = new Map<string, number>();

  for (const item of users) {
    const root = readRecord(item);
    const wrapped = readRecord(root.user_info);
    const row = Object.keys(wrapped).length > 0 ? wrapped : root;
    const userId = normalizeUserId(row.user_id ?? row.userId ?? row.user_email ?? row.email);
    if (userId && userId !== "default_user_id") {
      budgets.set(userId, nonNegativeNumber(row.max_budget ?? row.maxBudget));
    }
  }

  return budgets;
}

export function normalizeTokenUserMap(value: unknown) {
  const payload = readRecord(value);
  const keys = Array.isArray(value)
    ? value
    : Array.isArray(payload.keys)
      ? payload.keys
      : Array.isArray(payload.data)
        ? payload.data
        : [];
  const userByToken = new Map<string, string>();

  for (const item of keys) {
    const row = readRecord(item);
    const tokenId = readText(
      row.token_hash ?? row.key_hash ?? row.api_key ?? row.token_id ?? row.key ?? row.token
    ).trim();
    const userId = normalizeUserId(row.user_id ?? row.user);
    if (tokenId && userId) {
      userByToken.set(tokenId, userId);
    }
  }

  return userByToken;
}

export function mergeMaps<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>) {
  source.forEach((value, key) => target.set(key, value));
  return target;
}

export function configuredPositiveInteger(value: unknown, fallback: number, max: number) {
  return boundedInteger(Number(value), 1, max, fallback);
}

export function configuredHistoryStartDate(value: unknown, fallback = "2020-01-01") {
  const text = readText(value).slice(0, 10);
  return isIsoDate(text) ? text : fallback;
}

export function errorCode(error: unknown) {
  const text = error instanceof Error ? error.message : readText(error);
  return (text || "usage_snapshot_failed").replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 240);
}

function shanghaiDateForTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? dateKeyInTimeZone(new Date(timestamp), GATEWAY_USAGE_TIMEZONE)
    : "";
}

function spendTimestamp(row: Record<string, unknown>) {
  return readText(
    row.startTime
      ?? row.start_time
      ?? row.created_at
      ?? row.createdAt
      ?? row.timestamp
  ).trim();
}

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  try {
    return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  } catch {
    return false;
  }
}

function minIsoDate(left: string, right: string) {
  return left <= right ? left : right;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(min, Math.min(max, Math.round(number)))
    : fallback;
}

function normalizeUserId(value: unknown) {
  return readText(value).trim().toLowerCase();
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function nonNegativeNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function readText(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
