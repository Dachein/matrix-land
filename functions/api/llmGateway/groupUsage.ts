type GroupUsageEnv = {
  DB?: D1Database;
  USAGE_HISTORY_START_DATE?: string;
};

type GroupUsageContext<TEnv extends GroupUsageEnv> = EventContext<TEnv, string, unknown>;

type GroupUsageDeps<TEnv extends GroupUsageEnv> = {
  httpError(status: number, message: string): Error;
  json(body: unknown, init?: ResponseInit): Response;
  readDailyTotals?: typeof readGroupUsageDailyTotals;
  requireAuthenticated(context: GroupUsageContext<TEnv>): Promise<void>;
};

type GroupUsageSnapshot = {
  requestCount: number;
  startDate: string;
  totalTokens: number;
  updatedAt: string;
};

type GroupUsageDailyTotalRow = {
  requestCount?: number | string;
  rowCount?: number | string;
  totalTokens?: number | string;
  updatedAt?: string;
};

const DEFAULT_GROUP_USAGE_START_DATE = "2026-07-13";

export function createLlmGatewayGroupUsageApi<TEnv extends GroupUsageEnv>(deps: GroupUsageDeps<TEnv>) {
  const loadDailyTotals = deps.readDailyTotals ?? readGroupUsageDailyTotals;

  return {
    async getGroupUsage(context: GroupUsageContext<TEnv>) {
      await deps.requireAuthenticated(context);

      const startDate = configuredGroupUsageStartDate(context.env.USAGE_HISTORY_START_DATE);
      const snapshot = await loadDailyTotals(context.env.DB, startDate);
      if (!snapshot) {
        throw deps.httpError(503, "group_usage_daily_snapshot_unavailable");
      }

      return groupUsageResponse(deps, snapshot);
    }
  };
}

/** Read the cumulative group total from every available daily row, including today. */
export async function readGroupUsageDailyTotals(
  db: D1Database | undefined,
  startDate: string
): Promise<GroupUsageSnapshot | undefined> {
  if (!db) {
    return undefined;
  }

  const row = await db.prepare(`
    SELECT
      COUNT(*) AS rowCount,
      COALESCE(SUM(requests), 0) AS requestCount,
      COALESCE(SUM(tokens), 0) AS totalTokens,
      MAX(updated_at) AS updatedAt
    FROM gateway_usage_daily_snapshots
    WHERE usage_date >= ?
  `).bind(startDate).first<GroupUsageDailyTotalRow>();

  const updatedAt = validIsoTimestamp(row?.updatedAt);
  if (nonNegativeInteger(row?.rowCount) === 0 || !updatedAt) {
    return undefined;
  }

  return {
    requestCount: nonNegativeInteger(row?.requestCount),
    startDate,
    totalTokens: nonNegativeInteger(row?.totalTokens),
    updatedAt
  };
}

function groupUsageResponse<TEnv extends GroupUsageEnv>(
  deps: Pick<GroupUsageDeps<TEnv>, "json">,
  snapshot: GroupUsageSnapshot
) {
  return deps.json(snapshot, {
    headers: {
      "cache-control": "private, no-store",
      "x-workspace-usage-source": "d1-daily-ledger"
    }
  });
}

function configuredGroupUsageStartDate(value: string | undefined) {
  return validIsoDate(value) || DEFAULT_GROUP_USAGE_START_DATE;
}

function nonNegativeInteger(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function validIsoDate(value: unknown) {
  const normalized = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) && !Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))
    ? normalized
    : undefined;
}

function validIsoTimestamp(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized && !Number.isNaN(Date.parse(normalized)) ? normalized : undefined;
}
