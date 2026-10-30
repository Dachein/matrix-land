import type { LiteLlmDataSource } from "./litellm.ts";
import { dateKeyInTimeZone, GATEWAY_USAGE_TIMEZONE } from "./usageSnapshots.ts";

export const USAGE_BREAKDOWN_DEFAULT_HISTORY_START_DATE = "2026-07-13";

export type UsageBreakdownScope = "today" | "week" | "month" | "all" | "date";

export type UsageBreakdownTotals = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cacheRate: number | null;
  estimatedCostUsd: number;
};

export type UsageBreakdownModelRow = UsageBreakdownTotals & {
  model: string;
  displayName: string;
};

export type UsageBreakdownScopeRange = {
  type: UsageBreakdownScope;
  from: string;
  to: string;
};

export type UsageBreakdownResponse = {
  source: LiteLlmDataSource;
  scope: UsageBreakdownScopeRange;
  selectedKey?: {
    id: string;
    name: string;
  };
  models: UsageBreakdownModelRow[];
  total: UsageBreakdownTotals;
};

export function normalizeUsageBreakdownScope(value: string): UsageBreakdownScope | undefined {
  return value === "today" || value === "week" || value === "month" || value === "all" || value === "date"
    ? value
    : undefined;
}

export function resolveUsageBreakdownRange(
  scope: UsageBreakdownScope,
  now: Date,
  timezone: string,
  options: { date?: string; historyStartDate?: string } = {}
): UsageBreakdownScopeRange {
  const today = dateKeyInTimeZone(now, timezone);

  if (scope === "date") {
    const date = validIsoDate(options.date);
    return date ? { type: "date", from: date, to: date } : { type: "date", from: today, to: today };
  }

  if (scope === "today") {
    return { type: "today", from: today, to: today };
  }

  if (scope === "week") {
    const monday = addWeekdays(today, -((dateWeekday(today) + 6) % 7));
    return { type: "week", from: monday, to: today };
  }

  if (scope === "month") {
    return { type: "month", from: today.slice(0, 8) + "01", to: today };
  }

  const historyStart = validIsoDate(options.historyStartDate)
    ?? USAGE_BREAKDOWN_DEFAULT_HISTORY_START_DATE;
  return { type: "all", from: historyStart <= today ? historyStart : today, to: today };
}

export function buildUsageBreakdown(input: {
  logs: unknown[];
  displayNames?: Map<string, string>;
  scope: UsageBreakdownScopeRange;
  selectedKeyId?: string;
}): { models: UsageBreakdownModelRow[]; total: UsageBreakdownTotals } {
  const acc = new Map<string, UsageBreakdownModelRow>();
  const seenRequestIds = new Set<string>();

  for (const log of input.logs) {
    const row = unknownRecord(log);
    const timestamp = readString(
      row.startTime ?? row.start_time ?? row.created_at ?? row.createdAt ?? row.timestamp
    ).trim();
    const timestampMs = Date.parse(timestamp);
    const usageDate = Number.isFinite(timestampMs)
      ? dateKeyInTimeZone(new Date(timestampMs), GATEWAY_USAGE_TIMEZONE)
      : "";
    if (usageDate < input.scope.from || usageDate > input.scope.to) {
      continue;
    }
    const requestId = readString(row.request_id ?? row.requestId).trim();
    if (requestId && seenRequestIds.has(requestId)) {
      continue;
    }
    if (requestId) {
      seenRequestIds.add(requestId);
    }
    const tokenId = readString(row.api_key);
    if (input.selectedKeyId && tokenId !== input.selectedKeyId) {
      continue;
    }

    // The public model group is the stable name shown to clients. LiteLLM's
    // `model` field can be the upstream deployment name, so prefer the group
    // whenever it is present in spend logs.
    const model = readString(row.model_group ?? row.model).trim() || "unknown";
    const promptTokens = readNumber(row.prompt_tokens);
    const completionTokens = readNumber(row.completion_tokens);
    const totalTokens = readNumber(row.total_tokens) || promptTokens + completionTokens;
    const cacheReadTokens = readCacheReadInputTokens(row);
    const cacheWriteTokens = readCacheWriteInputTokens(row);
    const estimatedCostUsd = readNumber(row.spend);
    const current = acc.get(model) ?? emptyUsageBreakdownModelRow(model);

    acc.set(model, {
      ...current,
      requests: current.requests + 1,
      inputTokens: current.inputTokens + promptTokens,
      outputTokens: current.outputTokens + completionTokens,
      cacheReadTokens: current.cacheReadTokens + cacheReadTokens,
      cacheWriteTokens: current.cacheWriteTokens + cacheWriteTokens,
      totalTokens: current.totalTokens + totalTokens,
      estimatedCostUsd: current.estimatedCostUsd + estimatedCostUsd
    });
  }

  return mergeUsageBreakdowns(Array.from(acc.values()), input.displayNames);
}

/**
 * Merge already-aggregated historical ledger rows with a live, unclosed tail.
 * Rates are deliberately recalculated from the combined token totals instead
 * of averaging daily percentages.
 */
export function mergeUsageBreakdowns(
  rows: readonly UsageBreakdownModelRow[],
  displayNames?: Map<string, string>
): { models: UsageBreakdownModelRow[]; total: UsageBreakdownTotals } {
  const acc = new Map<string, UsageBreakdownModelRow>();

  for (const row of rows) {
    const model = row.model.trim() || "unknown";
    const current = acc.get(model) ?? emptyUsageBreakdownModelRow(model);
    acc.set(model, {
      ...current,
      requests: current.requests + nonNegative(row.requests),
      inputTokens: current.inputTokens + nonNegative(row.inputTokens),
      outputTokens: current.outputTokens + nonNegative(row.outputTokens),
      cacheReadTokens: current.cacheReadTokens + nonNegative(row.cacheReadTokens),
      cacheWriteTokens: current.cacheWriteTokens + nonNegative(row.cacheWriteTokens),
      totalTokens: current.totalTokens + nonNegative(row.totalTokens),
      estimatedCostUsd: current.estimatedCostUsd + nonNegative(row.estimatedCostUsd)
    });
  }

  const models = Array.from(acc.values())
    .map((row) => ({
      ...row,
      displayName: displayNames?.get(row.model)?.trim() || row.displayName,
      cacheRate: cacheRate(row.inputTokens, row.cacheReadTokens)
    }))
    .sort((left, right) =>
      right.estimatedCostUsd - left.estimatedCostUsd
      || right.totalTokens - left.totalTokens
      || left.model.localeCompare(right.model)
    );
  const total = aggregateUsageBreakdownTotals(models);

  return { models, total };
}

function nonNegative(value: unknown) {
  return Math.max(0, readNumber(value));
}

function emptyUsageBreakdownModelRow(model: string): UsageBreakdownModelRow {
  return {
    model,
    displayName: model,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cacheRate: null,
    estimatedCostUsd: 0
  };
}

function aggregateUsageBreakdownTotals(rows: readonly UsageBreakdownModelRow[]): UsageBreakdownTotals {
  const totals: UsageBreakdownTotals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cacheRate: null,
    estimatedCostUsd: 0
  };

  for (const row of rows) {
    totals.requests += row.requests;
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.cacheReadTokens += row.cacheReadTokens;
    totals.cacheWriteTokens += row.cacheWriteTokens;
    totals.totalTokens += row.totalTokens;
    totals.estimatedCostUsd += row.estimatedCostUsd;
  }
  totals.cacheRate = cacheRate(totals.inputTokens, totals.cacheReadTokens);

  return totals;
}

function cacheRate(inputTokens: number, cacheReadTokens: number) {
  return inputTokens > 0 ? Math.min(1, Math.max(0, cacheReadTokens / inputTokens)) : null;
}

function readCacheReadInputTokens(row: Record<string, unknown>) {
  const sources = usageDetailSources(row);
  return maxNonNegativeNumber([
    row.cache_read_input_tokens,
    row.cached_input_tokens,
    ...sources.flatMap((source) => [
      source.cache_read_input_tokens,
      source.cached_input_tokens,
      unknownRecord(source.prompt_tokens_details).cached_tokens,
      unknownRecord(source.input_tokens_details).cached_tokens
    ])
  ]);
}

function readCacheWriteInputTokens(row: Record<string, unknown>) {
  const sources = usageDetailSources(row);
  return maxNonNegativeNumber([
    row.cache_creation_input_tokens,
    row.cache_write_input_tokens,
    ...sources.flatMap((source) => [
      source.cache_creation_input_tokens,
      source.cache_write_input_tokens,
      unknownRecord(source.prompt_tokens_details).cache_creation_tokens,
      unknownRecord(source.prompt_tokens_details).cache_write_tokens,
      unknownRecord(source.input_tokens_details).cache_creation_tokens,
      unknownRecord(source.input_tokens_details).cache_write_tokens
    ])
  ]);
}

function usageDetailSources(row: Record<string, unknown>) {
  const metadata = unknownRecord(row.metadata);
  return [
    row,
    unknownRecord(row.usage),
    unknownRecord(metadata.usage_object),
    unknownRecord(metadata.additional_usage_values)
  ];
}

function maxNonNegativeNumber(values: unknown[]) {
  return values.reduce<number>((maximum, value) => Math.max(maximum, Math.max(0, readNumber(value))), 0);
}

function validIsoDate(value: unknown) {
  const date = readString(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return undefined;
  }
  try {
    return new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date ? date : undefined;
  } catch {
    return undefined;
  }
}

function dateWeekday(date: string) {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function addWeekdays(date: string, days: number) {
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(timestamp + Math.trunc(days) * 86_400_000).toISOString().slice(0, 10);
}

function unknownRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}
