import type { PortalCatalog } from "../../../src/shared/types.ts";
import {
  liteLlmDataSource,
  normalizeLiteLlmKeys,
  normalizeLiteLlmSpendRequests
} from "./litellm.ts";
import {
  readAdminUsageLedger,
  readUsageLedgerCoverage,
  USAGE_LEDGER_ENDPOINT,
  type UsageLedgerRollup,
  type UsageLedgerSeries
} from "./usageLedger.ts";

type CurrentUser = PortalCatalog["currentUser"];

const MAX_ADMIN_USAGE_RANGE_DAYS = 31;
const EXPORT_PAGE_SIZE = 100;
const MAX_EXPORT_PAGES = 10;

type LlmGatewayAdminUsageEnv = {
  DB?: D1Database;
  LITELLM_URL?: string;
  PORTAL_KV?: KVNamespace;
};

type LlmGatewayAdminUsageContext<TEnv extends LlmGatewayAdminUsageEnv> = EventContext<TEnv, string, unknown>;

type LlmGatewayAdminUsageDeps<TEnv extends LlmGatewayAdminUsageEnv> = {
  adminJson<T = unknown>(context: LlmGatewayAdminUsageContext<TEnv>, gatewayPath: string, init?: { method?: string; body?: unknown }): Promise<T>;
  clock?: () => Date;
  httpError(status: number, message: string): Error;
  json(body: unknown, init?: ResponseInit): Response;
  optionalText(value: unknown, maxLength: number): string;
  readBody<T>(request: Request): Promise<T>;
  requireAdminPortalUser(context: LlmGatewayAdminUsageContext<TEnv>): Promise<CurrentUser>;
  readAdminUsageLedger?: typeof readAdminUsageLedger;
  readUsageLedgerCoverage?: typeof readUsageLedgerCoverage;
};

export function createLlmGatewayAdminUsageApi<TEnv extends LlmGatewayAdminUsageEnv>(deps: LlmGatewayAdminUsageDeps<TEnv>) {
  const clock = deps.clock ?? (() => new Date());
  const loadAdminUsageLedger = deps.readAdminUsageLedger ?? readAdminUsageLedger;
  const loadUsageLedgerCoverage = deps.readUsageLedgerCoverage ?? readUsageLedgerCoverage;

  return {
    async getAdminUsage(context: LlmGatewayAdminUsageContext<TEnv>) {
      const totalStartedAt = Date.now();
      const authStartedAt = Date.now();
      await deps.requireAdminPortalUser(context);
      const authDuration = Date.now() - authStartedAt;

      const url = new URL(context.request.url);
      const {
        recentSearch,
        groupBy,
        scopeType,
        scopeId,
        fromDate,
        toDate
      } = adminUsageQueryFromSearch(url.searchParams, clock());
      assertBoundedDateRange(fromDate, toDate, MAX_ADMIN_USAGE_RANGE_DAYS, "admin_usage_range_too_large", deps);
      const recentPath = `/spend/logs/v2?${recentSearch.toString()}`;
      const dataStartedAt = Date.now();
      const coverage = await loadUsageLedgerCoverage(context.env.DB);
      let history: Awaited<ReturnType<typeof readAdminUsageLedger>> = {
        available: false,
        usage: [],
        series: [],
        requestTotal: 0
      };
      if (coverage.available && coverage.dataThroughDate) {
        const historyToDate = minIsoDate(toDate, coverage.dataThroughDate);
        if (fromDate <= historyToDate) {
          history = await loadAdminUsageLedger(context.env.DB, {
            fromDate,
            toDate: historyToDate,
            groupBy,
            scopeType,
            scopeId
          });
        } else {
          // The complete requested range is newer than the closed watermark.
          // There is no historical segment to query, but the schema is ready.
          history.available = true;
        }
      }
      if (!history.available) {
        // Historical usage must come from the compact D1 ledger. Falling back
        // to LiteLLM here can execute an unpaginated GROUPING SETS query over
        // the complete global DailyUserSpend table and exhaust Prisma memory.
        throw deps.httpError(503, "usage_ledger_unavailable");
      }
      const [recentPayload, keyCollection] = await Promise.all([
        deps.adminJson<unknown>(context, recentPath),
        readAllAdminLiteLlmKeys(context, deps)
      ]);
      const dataDuration = Date.now() - dataStartedAt;
      const recentRoot = readRecord(recentPayload);
      if (!Array.isArray(recentRoot.data)) {
        throw deps.httpError(502, "litellm_spend_logs_invalid_payload");
      }
      const tokens = normalizeLiteLlmKeys(keyCollection.keys);
      const recentLogs = filterSpendLogs(recentRoot.data, scopeType, scopeId);
      const requestRows = normalizeLiteLlmSpendRequests(recentLogs);
      const sourceEndpoints = [
        USAGE_LEDGER_ENDPOINT,
        recentPath,
        ...keyCollection.endpoints
      ];

      const responseBody = {
        source: liteLlmDataSource(sourceEndpoints, { from: fromDate, to: toDate }),
        usage: mergeUsageRollups(history.usage, [], fromDate, toDate),
        requests: requestRows.slice(0, 10),
        requestTotal: history.requestTotal,
        series: mergeUsageSeries(history.series, []),
        tokens
      };
      const totalDuration = Date.now() - totalStartedAt;

      return deps.json(responseBody, {
        headers: {
          "cache-control": "no-store",
          "server-timing": `auth;dur=${authDuration}, data;dur=${dataDuration}, total;dur=${totalDuration}`
        }
      });
    },

    async createUsageExportLink(context: LlmGatewayAdminUsageContext<TEnv>) {
      const currentUser = await deps.requireAdminPortalUser(context);

      if (!context.env.PORTAL_KV) {
        throw deps.httpError(503, "portal_kv_not_configured");
      }

      const body = await deps.readBody<{
        from?: string;
        to?: string;
        scopeType?: string;
        scopeId?: string;
      }>(context.request);
      const params = usageRequestExportParams(body, deps);
      const spendParams = liteLlmSpendQueryFromExportParams(params);
      assertBoundedDateRange(
        spendParams.fromDate,
        spendParams.toDate,
        MAX_ADMIN_USAGE_RANGE_DAYS,
        "admin_usage_range_too_large",
        deps
      );
      const ticket = crypto.randomUUID().replaceAll("-", "");
      const now = Date.now();
      const expiresAt = new Date(now + 10 * 60 * 1000).toISOString();

      await context.env.PORTAL_KV.put(`llm_usage_export:${ticket}`, JSON.stringify({
        params: Object.fromEntries(params),
        requestedBy: currentUser.email,
        createdAt: new Date(now).toISOString(),
        expiresAt
      }), { expirationTtl: 600 });

      const exportUrl = new URL("/api/llm-gateway/admin/usage/export", context.request.url);
      exportUrl.searchParams.set("ticket", ticket);

      return deps.json({
        url: exportUrl.toString(),
        expiresAt
      });
    },

    async downloadUsageExport(context: LlmGatewayAdminUsageContext<TEnv>) {
      if (!context.env.PORTAL_KV) {
        throw deps.httpError(503, "portal_kv_not_configured");
      }

      const url = new URL(context.request.url);
      const ticket = deps.optionalText(url.searchParams.get("ticket"), 80);

      if (!ticket) {
        throw deps.httpError(400, "missing_export_ticket");
      }

      const key = `llm_usage_export:${ticket}`;
      const rawTicket = await context.env.PORTAL_KV.get(key);

      if (!rawTicket) {
        throw deps.httpError(410, "export_ticket_expired_or_used");
      }

      await context.env.PORTAL_KV.delete(key);
      const payload = parseUsageExportTicket(rawTicket, deps);
      const params = new URLSearchParams(payload.params);
      const rows = await listAllLlmGatewayRequestRows(context, params, deps);
      const csv = gatewayRequestsCsv(rows);
      const fileDate = new Date().toISOString().slice(0, 10);

      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="workspace-llm-gateway-requests-${fileDate}.csv"`,
          "Cache-Control": "no-store"
        }
      });
    }
  };
}

async function listAllLlmGatewayRequestRows<TEnv extends LlmGatewayAdminUsageEnv>(
  context: LlmGatewayAdminUsageContext<TEnv>,
  params: URLSearchParams,
  deps: Pick<LlmGatewayAdminUsageDeps<TEnv>, "adminJson" | "httpError">
) {
  const spendParams = liteLlmSpendQueryFromExportParams(params);
  assertBoundedDateRange(
    spendParams.fromDate,
    spendParams.toDate,
    MAX_ADMIN_USAGE_RANGE_DAYS,
    "admin_usage_range_too_large",
    deps
  );
  const logs: unknown[] = [];
  let totalPages = 1;

  for (let page = 1; page <= totalPages; page += 1) {
    const search = new URLSearchParams(spendParams.spendSearch);
    search.set("page", String(page));
    search.set("page_size", String(EXPORT_PAGE_SIZE));
    search.set("sort_by", "startTime");
    search.set("sort_order", "asc");
    const payload = await deps.adminJson<unknown>(context, `/spend/logs/v2?${search.toString()}`);
    const root = readRecord(payload);
    const pageRows = root.data;
    const reportedPage = nonNegativeInteger(root.page);
    const reportedTotalPages = nonNegativeInteger(root.total_pages ?? root.totalPages);
    if (!Array.isArray(pageRows)
      || reportedPage !== page
      || reportedTotalPages === undefined) {
      throw deps.httpError(502, "litellm_spend_logs_invalid_payload");
    }
    if (reportedTotalPages > MAX_EXPORT_PAGES) {
      throw deps.httpError(413, "usage_export_too_large");
    }
    totalPages = Math.max(totalPages, reportedTotalPages);
    logs.push(...filterSpendLogs(pageRows, spendParams.scopeType, spendParams.scopeId));
  }

  return normalizeLiteLlmSpendRequests(logs);
}

export function usageRequestExportParams<TEnv extends LlmGatewayAdminUsageEnv>(
  input: {
    from?: string;
    to?: string;
    scopeType?: string;
    scopeId?: string;
  },
  deps: Pick<LlmGatewayAdminUsageDeps<TEnv>, "optionalText">
) {
  const params = new URLSearchParams();
  const from = deps.optionalText(input.from, 32);
  const to = deps.optionalText(input.to, 32);
  const scopeType = normalizeUsageScopeType(input.scopeType);
  const scopeId = deps.optionalText(input.scopeId, 240);

  if (from) {
    params.set("from", from);
  }

  if (to) {
    params.set("to", to);
  }

  if (scopeType && scopeId) {
    params.set("scopeType", scopeType);
    params.set("scopeId", scopeId);
  }

  return params;
}

function adminUsageQueryFromSearch(searchParams: URLSearchParams, now: Date = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const from = searchParams.get("from") || `${today.slice(0, 8)}01`;
  const to = searchParams.get("to") || today;
  const fromDate = normalizeSpendDate(from);
  const toDate = normalizeSpendDate(to);
  const groupBy = normalizeUsageScopeType(searchParams.get("groupBy")) || "model";
  const scopeType = normalizeUsageScopeType(searchParams.get("scopeType"));
  const scopeId = searchParams.get("scopeId") || "";
  const recentSearch = new URLSearchParams({
    start_date: `${fromDate} 00:00:00`,
    end_date: `${toDate} 23:59:59`,
    page: "1",
    page_size: scopeType === "provider" ? "100" : "10",
    sort_by: "startTime",
    sort_order: "desc"
  });
  const upstreamFilter = scopeType === "model"
    ? ["model", scopeId]
    : scopeType === "token"
      ? ["api_key", scopeId]
      : scopeType === "user"
        ? ["user_id", scopeId]
        : undefined;
  if (upstreamFilter?.[1]) {
    recentSearch.set(upstreamFilter[0], upstreamFilter[1]);
  }

  return {
    recentSearch,
    groupBy,
    scopeType,
    scopeId,
    fromDate,
    toDate
  };
}

async function readAllAdminLiteLlmKeys<TEnv extends LlmGatewayAdminUsageEnv>(
  context: LlmGatewayAdminUsageContext<TEnv>,
  deps: Pick<LlmGatewayAdminUsageDeps<TEnv>, "adminJson" | "httpError">
) {
  const keys: unknown[] = [];
  const endpoints: string[] = [];
  const seen = new Set<string>();
  const pageSize = 100;
  const maxPages = 100;

  for (let page = 1; page <= maxPages; page += 1) {
    const search = new URLSearchParams({
      return_full_object: "true",
      page: String(page),
      size: String(pageSize)
    });
    const path = `/key/list?${search.toString()}`;
    const payload = await deps.adminJson<unknown>(context, path);
    const root = readRecord(payload);
    const pageKeys = root.keys ?? root.data;
    if (!Array.isArray(pageKeys)) {
      throw deps.httpError(502, "litellm_key_list_invalid_payload");
    }
    endpoints.push(path);
    for (const item of pageKeys) {
      const row = readRecord(item);
      const id = readString(row.token_hash ?? row.key_hash ?? row.api_key ?? row.token_id ?? row.key ?? row.token);
      const dedupeKey = id || JSON.stringify(item);
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      keys.push(item);
    }

    const totalPages = positiveInteger(root.total_pages ?? root.totalPages ?? root.pages);
    const totalRows = nonNegativeInteger(root.total_count ?? root.totalCount ?? root.total);
    const explicitHasMore = root.has_more ?? root.hasMore;
    const hasMore = typeof explicitHasMore === "boolean"
      ? explicitHasMore
      : totalPages !== undefined
        ? page < totalPages
        : totalRows !== undefined
          ? page * pageSize < totalRows
          : pageKeys.length >= pageSize;
    if (!hasMore) {
      return { keys, endpoints };
    }
  }

  throw deps.httpError(502, "litellm_key_list_truncated");
}

function mergeUsageRollups(
  history: readonly UsageLedgerRollup[],
  live: readonly unknown[],
  fromDate: string,
  toDate: string
) {
  const acc = new Map<string, UsageLedgerRollup>();
  const updatedAt = new Date().toISOString();
  for (const value of [...history, ...live]) {
    const row = value as Record<string, unknown>;
    const scopeType = readString(row.scopeType);
    const scopeId = readString(row.scopeId);
    if (!scopeType || !scopeId) {
      continue;
    }
    const key = `${scopeType}:${scopeId}`;
    const current = acc.get(key) ?? {
      id: `ledger:${scopeType}:${scopeId}:${fromDate}:${toDate}`,
      scopeType,
      scopeId,
      periodType: "month",
      periodStart: `${fromDate} 00:00:00`,
      periodEnd: `${toDate} 23:59:59`,
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
      updatedAt
    };
    acc.set(key, addUsageMetrics(current, row));
  }
  return Array.from(acc.values());
}

function mergeUsageSeries(
  history: readonly UsageLedgerSeries[],
  live: readonly unknown[]
) {
  const acc = new Map<string, UsageLedgerSeries>();
  for (const value of [...history, ...live]) {
    const row = value as Record<string, unknown>;
    const periodStart = readString(row.periodStart);
    const groupType = readString(row.groupType);
    const groupId = readString(row.groupId);
    if (!periodStart || !groupType || !groupId) {
      continue;
    }
    const key = `${periodStart}:${groupType}:${groupId}`;
    const current = acc.get(key) ?? {
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
    acc.set(key, addUsageMetrics(current, row));
  }
  return Array.from(acc.values()).sort((left, right) =>
    left.periodStart.localeCompare(right.periodStart)
    || left.groupId.localeCompare(right.groupId)
  );
}

function addUsageMetrics<T extends UsageLedgerRollup | UsageLedgerSeries>(current: T, row: Record<string, unknown>): T {
  return {
    ...current,
    requests: current.requests + readNumber(row.requests),
    blockedRequests: current.blockedRequests + readNumber(row.blockedRequests),
    failedRequests: current.failedRequests + readNumber(row.failedRequests),
    inputTokens: current.inputTokens + readNumber(row.inputTokens),
    outputTokens: current.outputTokens + readNumber(row.outputTokens),
    cachedInputTokens: current.cachedInputTokens + readNumber(row.cachedInputTokens),
    cacheWriteInputTokens: current.cacheWriteInputTokens + readNumber(row.cacheWriteInputTokens),
    reasoningOutputTokens: current.reasoningOutputTokens + readNumber(row.reasoningOutputTokens),
    billableUnits: current.billableUnits + readNumber(row.billableUnits),
    estimatedCostUsd: current.estimatedCostUsd + readNumber(row.estimatedCostUsd)
  } as T;
}

function minIsoDate(left: string, right: string) {
  return left <= right ? left : right;
}

function assertBoundedDateRange<TEnv extends LlmGatewayAdminUsageEnv>(
  fromDate: string,
  toDate: string,
  maxDays: number,
  tooLargeCode: string,
  deps: Pick<LlmGatewayAdminUsageDeps<TEnv>, "httpError">
) {
  const from = Date.parse(`${fromDate}T00:00:00.000Z`);
  const to = Date.parse(`${toDate}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    throw deps.httpError(400, "invalid_usage_date_range");
  }
  const inclusiveDays = Math.floor((to - from) / 86_400_000) + 1;
  if (inclusiveDays > maxDays) {
    throw deps.httpError(tooLargeCode === "usage_ledger_stale" ? 503 : 400, tooLargeCode);
  }
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function liteLlmSpendQueryFromExportParams(params: URLSearchParams) {
  const from = params.get("from") || `${new Date().toISOString().slice(0, 8)}01`;
  const to = params.get("to") || new Date().toISOString().slice(0, 10);
  const fromDate = normalizeSpendDate(from);
  const toDate = normalizeSpendDate(to);
  const scopeType = normalizeUsageScopeType(params.get("scopeType"));
  const scopeId = params.get("scopeId") || "";
  const spendSearch = new URLSearchParams({
    start_date: fromDate,
    end_date: toDate
  });
  const upstreamFilter = scopeType === "model"
    ? ["model", scopeId]
    : scopeType === "token"
      ? ["api_key", scopeId]
      : scopeType === "user"
        ? ["user_id", scopeId]
        : undefined;
  if (upstreamFilter?.[1]) {
    spendSearch.set(upstreamFilter[0], upstreamFilter[1]);
  }

  return { spendSearch, scopeType, scopeId, fromDate, toDate };
}

function filterSpendLogs(logs: unknown[], scopeType: string | undefined, scopeId: string | undefined) {
  if (!scopeType || !scopeId) {
    return logs;
  }

  return logs.filter((log) => {
    const row = log as Record<string, unknown>;
    if (scopeType === "token") {
      return readString(row.api_key) === scopeId;
    }
    if (scopeType === "user") {
      return readString(row.user) === scopeId;
    }
    if (scopeType === "model") {
      return readString(row.model) === scopeId;
    }
    if (scopeType === "provider") {
      return providerForModel(readString(row.model)) === scopeId;
    }
    return true;
  });
}

function normalizeSpendDate(value: string) {
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
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

function normalizeUsageScopeType(value: unknown) {
  const scopeType = readString(value);

  if (scopeType === "model" || scopeType === "provider" || scopeType === "team" || scopeType === "user" || scopeType === "token") {
    return scopeType;
  }

  return "";
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseUsageExportTicket<TEnv extends LlmGatewayAdminUsageEnv>(
  value: string,
  deps: Pick<LlmGatewayAdminUsageDeps<TEnv>, "httpError">
) {
  const parsed = parseJsonObject(value, deps) as { params?: Record<string, string>; expiresAt?: string };

  if (!parsed.params || typeof parsed.params !== "object") {
    throw deps.httpError(400, "invalid_export_ticket");
  }

  if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= Date.now()) {
    throw deps.httpError(410, "export_ticket_expired_or_used");
  }

  return {
    params: parsed.params
  };
}

function parseJsonObject<TEnv extends LlmGatewayAdminUsageEnv>(
  value: string,
  deps: Pick<LlmGatewayAdminUsageDeps<TEnv>, "httpError">
) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw deps.httpError(400, "invalid_export_ticket");
  }
}

export function gatewayRequestsCsv(rows: unknown[]) {
  const columns = [
    "id",
    "request_id",
    "token_id",
    "subaccount_id",
    "environment",
    "external_org_id",
    "external_team_id",
    "external_user_id",
    "external_app_id",
    "endpoint",
    "provider",
    "model",
    "model_version",
    "status",
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "reasoning_output_tokens",
    "billable_units",
    "estimated_cost_usd",
    "usage_json",
    "upstream_status",
    "upstream_request_id",
    "cloudflare_ray_id",
    "latency_ms",
    "error_code",
    "error_message",
    "created_at",
    "completed_at"
  ];
  const lines = [columns.join(",")];

  for (const item of rows) {
    const row = item as Record<string, unknown>;
    lines.push(columns.map((column) => csvCell(row[column])).join(","));
  }

  return `${lines.join("\n")}\n`;
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);

  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll("\"", "\"\"")}"`;
  }

  return text;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}
