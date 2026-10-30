import type { UsageBreakdownModelRow } from "./usageBreakdown.ts";

export const USAGE_LEDGER_ENDPOINT = "d1:gateway_usage_daily_model_snapshots";

export type UsageLedgerCoverage = {
  available: boolean;
  dataThroughDate?: string;
};

export type UsageLedgerRollup = {
  id: string;
  scopeType: string;
  scopeId: string;
  periodType: "month";
  periodStart: string;
  periodEnd: string;
  requests: number;
  blockedRequests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningOutputTokens: number;
  billableUnits: number;
  estimatedCostUsd: number;
  updatedAt: string;
};

export type UsageLedgerSeries = {
  periodStart: string;
  groupType: string;
  groupId: string;
  requests: number;
  blockedRequests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningOutputTokens: number;
  billableUnits: number;
  estimatedCostUsd: number;
};

export type AdminUsageLedger = {
  available: boolean;
  usage: UsageLedgerRollup[];
  series: UsageLedgerSeries[];
  requestTotal: number;
};

type LedgerRange = {
  fromDate: string;
  toDate: string;
};

type AdminLedgerInput = LedgerRange & {
  groupBy: string;
  scopeType?: string;
  scopeId?: string;
};

const PROVIDER_SQL = `CASE
  WHEN model_group LIKE 'tencent-%' THEN 'tencent-tokenhub-intl'
  WHEN model_group LIKE 'aws-%' OR model_group LIKE '%bedrock%' THEN 'aws-bedrock'
  WHEN model_group LIKE 'openai%' OR model_group LIKE 'gpt-%' THEN 'openai'
  WHEN provider <> '' AND provider <> 'unknown' THEN provider
  ELSE 'litellm'
END`;

/** Read the global nightly watermark. A ready global run closes every date up to it. */
export async function readUsageLedgerCoverage(db?: D1Database): Promise<UsageLedgerCoverage> {
  if (!db) {
    return { available: false };
  }

  try {
    // Probe the model ledger too: a deployment may contain the run table but
    // not yet have applied the model-ledger migration.
    await db.prepare("SELECT 1 FROM gateway_usage_daily_model_snapshots LIMIT 1").first();
    const row = await db.prepare(`
      SELECT data_through_date
      FROM gateway_usage_snapshot_runs
      WHERE external_user_id IS NULL
        AND status = 'ready'
      ORDER BY data_through_date DESC, completed_at DESC
      LIMIT 1
    `).first<{ data_through_date?: string }>();
    const dataThroughDate = validDate(row?.data_through_date);
    return dataThroughDate ? { available: true, dataThroughDate } : { available: true };
  } catch (error) {
    if (isMissingLedgerSchema(error)) {
      return { available: false };
    }
    throw error;
  }
}

export async function readUserUsageModelLedger(
  db: D1Database | undefined,
  input: LedgerRange & { externalUserId: string; tokenId?: string }
): Promise<{ available: boolean; models: UsageBreakdownModelRow[] }> {
  if (!db) {
    return { available: false, models: [] };
  }

  const tokenClause = input.tokenId ? "AND token_id = ?4" : "";
  const bindings: unknown[] = [input.externalUserId, input.fromDate, input.toDate];
  if (input.tokenId) {
    bindings.push(input.tokenId);
  }

  try {
    const result = await db.prepare(`
      SELECT
        model_group AS model,
        SUM(requests) AS requests,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_input_tokens) AS cache_read_input_tokens,
        SUM(cache_write_input_tokens) AS cache_write_input_tokens,
        SUM(tokens) AS total_tokens,
        SUM(billed_cost_usd) AS billed_cost_usd
      FROM gateway_usage_daily_model_snapshots
      WHERE external_user_id = ?1
        AND usage_date >= ?2
        AND usage_date <= ?3
        ${tokenClause}
      GROUP BY model_group
    `).bind(...bindings).all<Record<string, unknown>>();

    return {
      available: true,
      models: (result.results ?? []).map((row) => {
        const model = text(row.model) || "unknown";
        const inputTokens = number(row.input_tokens);
        const cacheReadTokens = number(row.cache_read_input_tokens);
        return {
          model,
          displayName: model,
          requests: number(row.requests),
          inputTokens,
          outputTokens: number(row.output_tokens),
          cacheReadTokens,
          cacheWriteTokens: number(row.cache_write_input_tokens),
          totalTokens: number(row.total_tokens),
          cacheRate: inputTokens > 0 ? Math.min(1, cacheReadTokens / inputTokens) : null,
          estimatedCostUsd: number(row.billed_cost_usd)
        };
      })
    };
  } catch (error) {
    if (isMissingLedgerSchema(error)) {
      return { available: false, models: [] };
    }
    throw error;
  }
}

export async function readAdminUsageLedger(
  db: D1Database | undefined,
  input: AdminLedgerInput
): Promise<AdminUsageLedger> {
  if (!db) {
    return emptyAdminLedger(false);
  }

  const filter = adminScopeFilter(input.scopeType, input.scopeId);
  const group = adminGroupExpression(input.groupBy);
  const bindings: unknown[] = [input.fromDate, input.toDate, ...filter.bindings];
  const where = `usage_date >= ?1 AND usage_date <= ?2 ${filter.sql}`;
  const metricColumns = `
    SUM(requests) AS requests,
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cache_read_input_tokens) AS cache_read_input_tokens,
    SUM(cache_write_input_tokens) AS cache_write_input_tokens,
    SUM(reasoning_output_tokens) AS reasoning_output_tokens,
    SUM(tokens) AS total_tokens,
    SUM(billed_cost_usd) AS billed_cost_usd
  `;
  const rollupQueries = [
    ["user", "external_user_id"],
    ["token", "token_id"],
    ["model", "model_group"],
    ["provider", PROVIDER_SQL]
  ] as const;

  try {
    const statements = rollupQueries.map(([scopeType, expression]) => db.prepare(`
      SELECT '${scopeType}' AS scope_type, ${expression} AS scope_id, ${metricColumns}
      FROM gateway_usage_daily_model_snapshots
      WHERE ${where}
      GROUP BY ${expression}
    `).bind(...bindings));
    statements.push(db.prepare(`
      SELECT
        usage_date,
        '${group.type}' AS group_type,
        ${group.expression} AS group_id,
        ${metricColumns}
      FROM gateway_usage_daily_model_snapshots
      WHERE ${where}
      GROUP BY usage_date, ${group.expression}
      ORDER BY usage_date, group_id
    `).bind(...bindings));
    const results = await db.batch<Record<string, unknown>>(statements);
    const now = new Date().toISOString();
    const usage = results.slice(0, 4).flatMap((result) => (result.results ?? []).map((row) => rollupRow(row, input, now)));
    const series = (results[4]?.results ?? []).map(seriesRow);
    const requestTotal = usage
      .filter((row) => row.scopeType === "user")
      .reduce((sum, row) => sum + row.requests, 0);

    return { available: true, usage, series, requestTotal };
  } catch (error) {
    if (isMissingLedgerSchema(error)) {
      return emptyAdminLedger(false);
    }
    throw error;
  }
}

function rollupRow(row: Record<string, unknown>, input: LedgerRange, updatedAt: string): UsageLedgerRollup {
  const scopeType = text(row.scope_type);
  const scopeId = text(row.scope_id);
  return {
    id: `d1:${scopeType}:${scopeId}:${input.fromDate}:${input.toDate}`,
    scopeType,
    scopeId,
    periodType: "month",
    periodStart: `${input.fromDate} 00:00:00`,
    periodEnd: `${input.toDate} 23:59:59`,
    ...commonMetrics(row),
    updatedAt
  };
}

function seriesRow(row: Record<string, unknown>): UsageLedgerSeries {
  return {
    periodStart: `${text(row.usage_date).slice(0, 10)} 00:00:00`,
    groupType: text(row.group_type),
    groupId: text(row.group_id),
    ...commonMetrics(row)
  };
}

function commonMetrics(row: Record<string, unknown>) {
  return {
    requests: number(row.requests),
    blockedRequests: 0,
    failedRequests: 0,
    inputTokens: number(row.input_tokens),
    outputTokens: number(row.output_tokens),
    cachedInputTokens: number(row.cache_read_input_tokens),
    cacheWriteInputTokens: number(row.cache_write_input_tokens),
    reasoningOutputTokens: number(row.reasoning_output_tokens),
    billableUnits: number(row.total_tokens),
    estimatedCostUsd: number(row.billed_cost_usd)
  };
}

function adminScopeFilter(scopeType?: string, scopeId?: string) {
  if (!scopeId) {
    return { sql: "", bindings: [] as unknown[] };
  }
  const expression = scopeType === "user"
    ? "external_user_id"
    : scopeType === "token"
      ? "token_id"
      : scopeType === "model"
        ? "model_group"
        : scopeType === "provider"
          ? PROVIDER_SQL
          : "";
  return expression
    ? { sql: `AND ${expression} = ?3`, bindings: [scopeId] }
    : { sql: "", bindings: [] as unknown[] };
}

function adminGroupExpression(groupBy: string) {
  if (groupBy === "user") {
    return { type: "user", expression: "external_user_id" };
  }
  if (groupBy === "provider") {
    return { type: "provider", expression: PROVIDER_SQL };
  }
  if (groupBy === "token") {
    return { type: "token", expression: "token_id" };
  }
  return { type: "model", expression: "model_group" };
}

function emptyAdminLedger(available: boolean): AdminUsageLedger {
  return { available, usage: [], series: [], requestTotal: 0 };
}

function isMissingLedgerSchema(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /no such table|does not exist|gateway_usage_daily_model_snapshots/i.test(message);
}

function validDate(value: unknown) {
  const date = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function number(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}
