export const GATEWAY_USAGE_TIMEZONE = "Asia/Shanghai";
export const GATEWAY_USAGE_DAILY_WINDOW_DAYS = 365;

const UNKNOWN_TOKEN_ID = "__unknown__";
const MAX_D1_BATCH_STATEMENTS = 400;
const MAX_D1_READ_BINDINGS = 90;
const DEFAULT_USAGE_RUN_LEASE_MS = 15 * 60 * 1000;
export const USAGE_SUMMARY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export type UsageAnalyticsStatus = "ready" | "pending" | "error";
export type UsageSnapshotTriggerType = "manual" | "automatic" | "scheduled" | "reconcile";

export type UsageAnalytics = {
  timezone: typeof GATEWAY_USAGE_TIMEZONE;
  source: "snapshot" | "live";
  status: UsageAnalyticsStatus;
  updatedAt?: string;
  dataThroughDate?: string;
  dataThroughAt?: string;
  lastCheckedAt?: string;
  activityWatermarkAt?: string;
  lastReconciledAt?: string;
  keysetFingerprint?: string;
  triggerType?: UsageSnapshotTriggerType;
  summary: {
    cumulativeTokens: number;
    peakDailyTokens: number;
    currentMonthSpendUsd: number;
    monthlyBudgetUsd: number;
  };
  dailyUsage: Array<{
    date: string;
    tokens: number;
    requests: number;
    estimatedCostUsd: number;
  }>;
  tokenUsage: Array<{
    tokenId: string;
    tokens: number;
    requests: number;
    estimatedCostUsd: number;
  }>;
};

export type UsageDailySnapshotInput = {
  date: string;
  externalUserId: string;
  tokenId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  tokens: number;
  estimatedCostUsd: number;
};

export type UsageDailyModelSnapshotInput = {
  date: string;
  externalUserId: string;
  tokenId: string;
  modelGroup: string;
  upstreamModel: string;
  provider: string;
  requests: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  tokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  toolCostUsd: number;
  originalCostUsd: number;
  discountUsd: number;
  billedCostUsd: number;
};

export type UsageSnapshotRunInput = {
  id: string;
  externalUserId?: string;
  triggerType?: UsageSnapshotTriggerType;
  sourceFromDate: string;
  sourceToDate: string;
  dataThroughDate: string;
  dataThroughAt?: string;
  activityWatermarkAt?: string;
  keysetFingerprint?: string;
  startedAt: string;
  staleAfterMs?: number;
};

export type UsageSnapshotPublishInput = {
  runId: string;
  externalUserId?: string;
  fromDate: string;
  toDate: string;
  dataThroughDate: string;
  dataThroughAt?: string;
  completedAt: string;
  sourceRowCount: number;
  attributedRowCount: number;
  activityWatermarkAt?: string;
  keysetFingerprint?: string;
  triggerType?: UsageSnapshotTriggerType;
  reconciledAt?: string;
};

export type UsageRefreshState = {
  externalUserId: string;
  runId: string;
  updatedAt: string;
  dataThroughDate: string;
  dataThroughAt?: string;
  lastCheckedAt?: string;
  activityWatermarkAt?: string;
  lastReconciledAt?: string;
  keysetFingerprint?: string;
  triggerType?: UsageSnapshotTriggerType;
};

type UsageUserSnapshotRow = {
  externalUserId?: string;
  runId?: string;
  status?: string;
  updatedAt?: string;
  dataThroughDate?: string;
  dataThroughAt?: string;
  lastCheckedAt?: string;
  activityWatermarkAt?: string;
  lastReconciledAt?: string;
  keysetFingerprint?: string;
  triggerType?: string;
  cumulativeTokens?: number;
  peakDailyTokens?: number;
  monthlyBudgetUsd?: number;
};

export type CumulativeUsageSummary = {
  hasSnapshot: boolean;
  cumulativeTokens: number;
  updatedAt?: string;
  dataThroughAt?: string;
  lastRefreshRequestedAt?: string;
};

type UsageSnapshotRunRow = {
  status?: string;
  startedAt?: string;
  completedAt?: string;
  dataThroughDate?: string;
};

type UsageDailyQueryRow = {
  date?: string;
  tokens?: number;
  requests?: number;
  estimatedCostUsd?: number;
};

type UsageTokenQueryRow = {
  tokenId?: string;
  tokens?: number;
  requests?: number;
  estimatedCostUsd?: number;
};

export async function readUsageAnalytics(
  db: D1Database | undefined,
  userId: string,
  now: Date = new Date()
): Promise<UsageAnalytics> {
  const normalizedUserId = normalizeUserId(userId);
  if (!db || !normalizedUserId) {
    return emptyUsageAnalytics("pending");
  }

  try {
    const [snapshot, latestRun] = await Promise.all([
      db.prepare(
        `
        SELECT
          external_user_id AS externalUserId,
          run_id AS runId,
          status,
          updated_at AS updatedAt,
          data_through_date AS dataThroughDate,
          data_through_at AS dataThroughAt,
          last_checked_at AS lastCheckedAt,
          activity_watermark_at AS activityWatermarkAt,
          last_reconciled_at AS lastReconciledAt,
          keyset_fingerprint AS keysetFingerprint,
          trigger_type AS triggerType,
          cumulative_tokens AS cumulativeTokens,
          peak_daily_tokens AS peakDailyTokens,
          monthly_budget_usd AS monthlyBudgetUsd
        FROM gateway_usage_user_snapshots
        WHERE external_user_id = ?
        LIMIT 1
        `
      ).bind(normalizedUserId).first<UsageUserSnapshotRow>(),
      db.prepare(
        `
        SELECT
          status,
          started_at AS startedAt,
          completed_at AS completedAt,
          data_through_date AS dataThroughDate
        FROM gateway_usage_snapshot_runs
        WHERE external_user_id = ? OR external_user_id IS NULL
        ORDER BY
          CASE WHEN external_user_id = ? THEN 0 ELSE 1 END,
          started_at DESC
        LIMIT 1
        `
      ).bind(normalizedUserId, normalizedUserId).first<UsageSnapshotRunRow>()
    ]);

    const latestRunFailed = latestRun?.status === "error" && runIsNewerThanSnapshot(latestRun, snapshot);
    if (latestRunFailed && !snapshot) {
      return emptyUsageAnalytics("error", {
        updatedAt: readText(latestRun.completedAt) || readText(latestRun.startedAt) || undefined
      });
    }

    const dataThroughDate = validIsoDate(snapshot?.dataThroughDate);
    if (!snapshot || snapshot.status !== "ready" || !dataThroughDate) {
      return emptyUsageAnalytics(snapshot?.status === "error" ? "error" : "pending");
    }

    const dailyFromDate = addIsoDateDays(dataThroughDate, -(GATEWAY_USAGE_DAILY_WINDOW_DAYS - 1));
    const currentShanghaiDate = dateKeyInTimeZone(now, GATEWAY_USAGE_TIMEZONE);
    const currentMonthStart = `${currentShanghaiDate.slice(0, 7)}-01`;
    const dailyPromise = db.prepare(
      `
      SELECT
        usage_date AS date,
        SUM(tokens) AS tokens,
        SUM(requests) AS requests,
        SUM(estimated_cost_usd) AS estimatedCostUsd
      FROM gateway_usage_daily_snapshots
      WHERE external_user_id = ?
        AND usage_date BETWEEN ? AND ?
      GROUP BY usage_date
      ORDER BY usage_date ASC
      `
    ).bind(normalizedUserId, dailyFromDate, dataThroughDate).all<UsageDailyQueryRow>();
    const tokenPromise = currentMonthStart <= dataThroughDate
      ? db.prepare(
        `
        SELECT
          token_id AS tokenId,
          SUM(tokens) AS tokens,
          SUM(requests) AS requests,
          SUM(estimated_cost_usd) AS estimatedCostUsd
        FROM gateway_usage_daily_snapshots
        WHERE external_user_id = ?
          AND usage_date BETWEEN ? AND ?
        GROUP BY token_id
        ORDER BY tokens DESC, token_id ASC
        `
      ).bind(normalizedUserId, currentMonthStart, dataThroughDate).all<UsageTokenQueryRow>()
      : Promise.resolve({ results: [] as UsageTokenQueryRow[] });
    const [dailyResult, tokenResult] = await Promise.all([dailyPromise, tokenPromise]);
    const dailyUsage = (dailyResult.results ?? []).map((row) => ({
      date: validIsoDate(row.date),
      tokens: nonNegativeInteger(row.tokens),
      requests: nonNegativeInteger(row.requests),
      estimatedCostUsd: nonNegativeNumber(row.estimatedCostUsd)
    })).filter((row) => row.date);
    const tokenUsage = (tokenResult.results ?? []).map((row) => ({
      tokenId: readText(row.tokenId) || UNKNOWN_TOKEN_ID,
      tokens: nonNegativeInteger(row.tokens),
      requests: nonNegativeInteger(row.requests),
      estimatedCostUsd: nonNegativeNumber(row.estimatedCostUsd)
    }));

    return {
      timezone: GATEWAY_USAGE_TIMEZONE,
      source: "snapshot",
      status: latestRunFailed ? "error" : "ready",
      updatedAt: readText(snapshot.updatedAt) || undefined,
      dataThroughDate,
      ...(validIsoTimestamp(snapshot.dataThroughAt) ? {
        dataThroughAt: validIsoTimestamp(snapshot.dataThroughAt)
      } : {}),
      ...(validIsoTimestamp(snapshot.lastCheckedAt) ? {
        lastCheckedAt: validIsoTimestamp(snapshot.lastCheckedAt)
      } : {}),
      ...(validIsoTimestamp(snapshot.activityWatermarkAt) ? {
        activityWatermarkAt: validIsoTimestamp(snapshot.activityWatermarkAt)
      } : {}),
      ...(validIsoTimestamp(snapshot.lastReconciledAt) ? {
        lastReconciledAt: validIsoTimestamp(snapshot.lastReconciledAt)
      } : {}),
      ...(normalizeKeysetFingerprint(snapshot.keysetFingerprint) ? {
        keysetFingerprint: normalizeKeysetFingerprint(snapshot.keysetFingerprint)
      } : {}),
      ...(validUsageSnapshotTrigger(snapshot.triggerType) ? {
        triggerType: validUsageSnapshotTrigger(snapshot.triggerType)
      } : {}),
      summary: {
        cumulativeTokens: nonNegativeInteger(snapshot.cumulativeTokens),
        peakDailyTokens: nonNegativeInteger(snapshot.peakDailyTokens),
        currentMonthSpendUsd: tokenUsage.reduce((sum, row) => sum + row.estimatedCostUsd, 0),
        monthlyBudgetUsd: nonNegativeNumber(snapshot.monthlyBudgetUsd)
      },
      dailyUsage,
      tokenUsage
    };
  } catch (error) {
    return emptyUsageAnalytics(isMissingUsageSnapshotTable(error) ? "pending" : "error");
  }
}

/**
 * Read only the persisted cumulative total used by the fast Token-page header.
 * This deliberately avoids the daily and per-token aggregates in
 * readUsageAnalytics so the cached total can be returned independently.
 */
export async function readCumulativeUsageSummary(
  db: D1Database | undefined,
  userId: string
): Promise<CumulativeUsageSummary | null> {
  const normalizedUserId = normalizeUserId(userId);
  if (!db || !normalizedUserId) {
    return null;
  }

  try {
    const row = await db.prepare(
      `
      WITH requested_user(external_user_id) AS (VALUES (?))
      SELECT
        snapshot.cumulative_tokens AS cumulativeTokens,
        snapshot.updated_at AS updatedAt,
        snapshot.data_through_at AS dataThroughAt,
        refresh_state.checked_at AS lastRefreshRequestedAt
      FROM requested_user
      LEFT JOIN gateway_usage_user_snapshots AS snapshot
        ON snapshot.external_user_id = requested_user.external_user_id
      LEFT JOIN gateway_usage_summary_refresh_state AS refresh_state
        ON refresh_state.external_user_id = requested_user.external_user_id
      `
    ).bind(normalizedUserId).first<{
      cumulativeTokens?: number;
      updatedAt?: string;
      dataThroughAt?: string;
      lastRefreshRequestedAt?: string;
    }>();

    if (!row) {
      return null;
    }

    return {
      hasSnapshot: row.cumulativeTokens !== null && row.cumulativeTokens !== undefined,
      cumulativeTokens: nonNegativeInteger(row.cumulativeTokens),
      ...(validIsoTimestamp(row.updatedAt) ? { updatedAt: validIsoTimestamp(row.updatedAt) } : {}),
      ...(validIsoTimestamp(row.dataThroughAt) ? { dataThroughAt: validIsoTimestamp(row.dataThroughAt) } : {}),
      ...(validIsoTimestamp(row.lastRefreshRequestedAt)
        ? { lastRefreshRequestedAt: validIsoTimestamp(row.lastRefreshRequestedAt) }
        : {})
    };
  } catch (error) {
    if (isMissingUsageSummaryRefreshTable(error)) {
      try {
        const row = await db.prepare(
          `
          SELECT
            cumulative_tokens AS cumulativeTokens,
            updated_at AS updatedAt,
            data_through_at AS dataThroughAt
          FROM gateway_usage_user_snapshots
          WHERE external_user_id = ?
          LIMIT 1
          `
        ).bind(normalizedUserId).first<{
          cumulativeTokens?: number;
          updatedAt?: string;
          dataThroughAt?: string;
        }>();
        return row ? {
          hasSnapshot: true,
          cumulativeTokens: nonNegativeInteger(row.cumulativeTokens),
          ...(validIsoTimestamp(row.updatedAt) ? { updatedAt: validIsoTimestamp(row.updatedAt) } : {}),
          ...(validIsoTimestamp(row.dataThroughAt) ? { dataThroughAt: validIsoTimestamp(row.dataThroughAt) } : {})
        } : null;
      } catch (fallbackError) {
        if (isMissingUsageSnapshotTable(fallbackError)) {
          return null;
        }
        throw fallbackError;
      }
    }
    if (isMissingUsageSnapshotTable(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Atomically claim the per-user 5-minute background refresh window.
 * D1's conditional UPSERT makes this a cross-isolate single-flight gate.
 */
export async function claimCumulativeUsageSummaryRefresh(
  db: D1Database,
  input: { externalUserId: string; requestedAt: string; staleBefore: string }
): Promise<boolean> {
  const externalUserId = requireUserId(input.externalUserId);
  const requestedAt = requireIsoTimestamp(input.requestedAt);
  const staleBefore = requireIsoTimestamp(input.staleBefore);
  const result = await db.prepare(
    `
    INSERT INTO gateway_usage_summary_refresh_state (external_user_id, checked_at)
    VALUES (?, ?)
    ON CONFLICT(external_user_id) DO UPDATE SET
      checked_at = excluded.checked_at
    WHERE gateway_usage_summary_refresh_state.checked_at <= ?
    `
  ).bind(externalUserId, requestedAt, staleBefore).run();
  return d1ResultChanged(result);
}

export async function beginUsageSnapshotRun(
  db: D1Database,
  input: UsageSnapshotRunInput
): Promise<boolean> {
  const sourceFromDate = requireIsoDate(input.sourceFromDate);
  const sourceToDate = requireIsoDate(input.sourceToDate);
  const dataThroughDate = requireIsoDate(input.dataThroughDate);
  const startedAt = requireIsoTimestamp(input.startedAt);
  if (sourceFromDate > sourceToDate || sourceToDate > dataThroughDate) {
    throw new Error("invalid_usage_snapshot_range");
  }

  const externalUserId = normalizeUserId(input.externalUserId);
  const triggerType = normalizeUsageSnapshotTrigger(input.triggerType);
  const dataThroughAt = input.dataThroughAt
    ? requireIsoTimestamp(input.dataThroughAt)
    : startedAt;
  const activityWatermarkAt = input.activityWatermarkAt
    ? requireIsoTimestamp(input.activityWatermarkAt)
    : null;
  const keysetFingerprint = normalizeKeysetFingerprint(input.keysetFingerprint) || null;

  if (!externalUserId) {
    await db.prepare(
      `
      INSERT INTO gateway_usage_snapshot_runs (
        id,
        status,
        trigger_type,
        timezone,
        source_from_date,
        source_to_date,
        data_through_date,
        data_through_at,
        activity_watermark_at,
        keyset_fingerprint,
        started_at
      ) VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).bind(
      input.id,
      triggerType,
      GATEWAY_USAGE_TIMEZONE,
      sourceFromDate,
      sourceToDate,
      dataThroughDate,
      dataThroughAt,
      activityWatermarkAt,
      keysetFingerprint,
      startedAt
    ).run();
    return true;
  }

  const leaseMs = boundedPositiveInteger(
    input.staleAfterMs,
    DEFAULT_USAGE_RUN_LEASE_MS,
    24 * 60 * 60 * 1000
  );
  const staleBefore = new Date(Date.parse(startedAt) - leaseMs).toISOString();
  const expireStale = db.prepare(
    `
    UPDATE gateway_usage_snapshot_runs
    SET status = 'error',
        completed_at = ?,
        error_code = 'usage_snapshot_lease_expired'
    WHERE external_user_id = ?
      AND status = 'running'
      AND started_at <= ?
    `
  ).bind(startedAt, externalUserId, staleBefore);
  const deleteExpiredDailyStaging = db.prepare(
    `
    DELETE FROM gateway_usage_daily_snapshot_staging
    WHERE run_id IN (
      SELECT id
      FROM gateway_usage_snapshot_runs
      WHERE external_user_id = ?
        AND status = 'error'
        AND error_code = 'usage_snapshot_lease_expired'
        AND completed_at = ?
    )
    `
  ).bind(externalUserId, startedAt);
  const deleteExpiredModelStaging = db.prepare(
    `
    DELETE FROM gateway_usage_daily_model_snapshot_staging
    WHERE run_id IN (
      SELECT id
      FROM gateway_usage_snapshot_runs
      WHERE external_user_id = ?
        AND status = 'error'
        AND error_code = 'usage_snapshot_lease_expired'
        AND completed_at = ?
    )
    `
  ).bind(externalUserId, startedAt);
  const deleteExpiredUserStaging = db.prepare(
    `
    DELETE FROM gateway_usage_user_snapshot_staging
    WHERE run_id IN (
      SELECT id
      FROM gateway_usage_snapshot_runs
      WHERE external_user_id = ?
        AND status = 'error'
        AND error_code = 'usage_snapshot_lease_expired'
        AND completed_at = ?
    )
    `
  ).bind(externalUserId, startedAt);
  const insertRun = db.prepare(
    `
    INSERT INTO gateway_usage_snapshot_runs (
      id,
      status,
      external_user_id,
      trigger_type,
      timezone,
      source_from_date,
      source_to_date,
      data_through_date,
      data_through_at,
      activity_watermark_at,
      keyset_fingerprint,
      started_at
    )
    SELECT ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1
      FROM gateway_usage_snapshot_runs
      WHERE external_user_id = ? AND status = 'running'
    )
    `
  ).bind(
    input.id,
    externalUserId,
    triggerType,
    GATEWAY_USAGE_TIMEZONE,
    sourceFromDate,
    sourceToDate,
    dataThroughDate,
    dataThroughAt,
    activityWatermarkAt,
    keysetFingerprint,
    startedAt,
    externalUserId
  );

  await db.batch([
    expireStale,
    deleteExpiredDailyStaging,
    deleteExpiredModelStaging,
    deleteExpiredUserStaging,
    insertRun
  ]);
  const acquired = await db.prepare(
    `
    SELECT id
    FROM gateway_usage_snapshot_runs
    WHERE id = ? AND external_user_id = ? AND status = 'running'
    LIMIT 1
    `
  ).bind(input.id, externalUserId).first<{ id?: string }>();
  return readText(acquired?.id) === input.id;
}

export async function failUsageSnapshotRun(
  db: D1Database,
  input: { id: string; completedAt: string; errorCode: string; sourceRowCount?: number; attributedRowCount?: number }
) {
  const deleteDailyStaging = db.prepare(
    `DELETE FROM gateway_usage_daily_snapshot_staging WHERE run_id = ?`
  ).bind(input.id);
  const deleteModelStaging = db.prepare(
    `DELETE FROM gateway_usage_daily_model_snapshot_staging WHERE run_id = ?`
  ).bind(input.id);
  const deleteUserStaging = db.prepare(
    `DELETE FROM gateway_usage_user_snapshot_staging WHERE run_id = ?`
  ).bind(input.id);
  const markFailed = db.prepare(
    `
    UPDATE gateway_usage_snapshot_runs
    SET status = 'error',
        completed_at = ?,
        source_row_count = ?,
        attributed_row_count = ?,
        error_code = ?
    WHERE id = ? AND status = 'running'
    `
  ).bind(
    input.completedAt,
    nonNegativeInteger(input.sourceRowCount),
    nonNegativeInteger(input.attributedRowCount),
    readText(input.errorCode).slice(0, 240) || "usage_snapshot_failed",
    input.id
  );

  // D1 executes a batch transactionally. If cleanup itself fails, the worker
  // logs that secondary failure and still rethrows the original rollup error.
  await db.batch([deleteDailyStaging, deleteModelStaging, deleteUserStaging, markFailed]);
}

export async function readLatestReadyUsageDate(db: D1Database, externalUserId?: string) {
  const userId = normalizeUserId(externalUserId);
  const statement = userId
    ? db.prepare(
      `
      SELECT data_through_date AS dataThroughDate
      FROM gateway_usage_snapshot_runs
      WHERE status = 'ready'
        AND (external_user_id = ? OR external_user_id IS NULL)
      ORDER BY
        CASE WHEN external_user_id = ? THEN 0 ELSE 1 END,
        started_at DESC
      LIMIT 1
      `
    ).bind(userId, userId)
    : db.prepare(
      `
      SELECT data_through_date AS dataThroughDate
      FROM gateway_usage_snapshot_runs
      WHERE status = 'ready' AND external_user_id IS NULL
      ORDER BY started_at DESC
      LIMIT 1
      `
    );
  const row = await statement.first<{ dataThroughDate?: string }>();
  return validIsoDate(row?.dataThroughDate) || undefined;
}

export async function readUsageRefreshStates(
  db: D1Database,
  userIds?: Iterable<string>
): Promise<Map<string, UsageRefreshState>> {
  const normalizedUserIds = userIds === undefined
    ? undefined
    : Array.from(new Set(Array.from(userIds, normalizeUserId).filter(Boolean))).sort();
  if (normalizedUserIds?.length === 0) {
    return new Map();
  }

  const rows: UsageUserSnapshotRow[] = [];
  if (normalizedUserIds === undefined) {
    const result = await usageRefreshStateStatement(db).all<UsageUserSnapshotRow>();
    rows.push(...(result.results ?? []));
  } else {
    for (let index = 0; index < normalizedUserIds.length; index += MAX_D1_READ_BINDINGS) {
      const chunk = normalizedUserIds.slice(index, index + MAX_D1_READ_BINDINGS);
      const result = await usageRefreshStateStatement(db, chunk).all<UsageUserSnapshotRow>();
      rows.push(...(result.results ?? []));
    }
  }

  const states = new Map<string, UsageRefreshState>();
  for (const row of rows) {
    const externalUserId = normalizeUserId(row.externalUserId);
    const runId = readText(row.runId);
    const updatedAt = validIsoTimestamp(row.updatedAt);
    const dataThroughDate = validIsoDate(row.dataThroughDate);
    if (!externalUserId || !runId || !updatedAt || !dataThroughDate) {
      continue;
    }
    const dataThroughAt = validIsoTimestamp(row.dataThroughAt);
    const lastCheckedAt = validIsoTimestamp(row.lastCheckedAt);
    const activityWatermarkAt = validIsoTimestamp(row.activityWatermarkAt);
    const lastReconciledAt = validIsoTimestamp(row.lastReconciledAt);
    const triggerType = validUsageSnapshotTrigger(row.triggerType);
    states.set(externalUserId, {
      externalUserId,
      runId,
      updatedAt,
      dataThroughDate,
      ...(dataThroughAt ? { dataThroughAt } : {}),
      ...(lastCheckedAt ? { lastCheckedAt } : {}),
      ...(activityWatermarkAt ? { activityWatermarkAt } : {}),
      ...(lastReconciledAt ? { lastReconciledAt } : {}),
      ...(normalizeKeysetFingerprint(row.keysetFingerprint) ? {
        keysetFingerprint: normalizeKeysetFingerprint(row.keysetFingerprint)
      } : {}),
      ...(triggerType ? { triggerType } : {})
    });
  }
  return states;
}

export async function recordUsageRefreshCheck(
  db: D1Database,
  input: {
    externalUserId: string;
    checkedAt: string;
    activityWatermarkAt?: string;
    keysetFingerprint?: string;
    expectedRunId?: string;
  }
): Promise<boolean> {
  const externalUserId = requireUserId(input.externalUserId);
  const checkedAt = requireIsoTimestamp(input.checkedAt);
  const activityWatermarkAt = input.activityWatermarkAt
    ? requireIsoTimestamp(input.activityWatermarkAt)
    : null;
  const keysetFingerprint = normalizeKeysetFingerprint(input.keysetFingerprint) || null;
  const expectedRunId = readText(input.expectedRunId).trim() || null;
  const result = await db.prepare(
    `
    UPDATE gateway_usage_user_snapshots
    SET last_checked_at = CASE
          WHEN last_checked_at IS NULL OR last_checked_at < ? THEN ?
          ELSE last_checked_at
        END,
        activity_watermark_at = CASE
          WHEN ? IS NULL THEN activity_watermark_at
          WHEN activity_watermark_at IS NULL OR activity_watermark_at < ? THEN ?
          ELSE activity_watermark_at
        END,
        keyset_fingerprint = COALESCE(?, keyset_fingerprint)
    WHERE external_user_id = ?
      AND (? IS NULL OR run_id = ?)
    `
  ).bind(
    checkedAt,
    checkedAt,
    activityWatermarkAt,
    activityWatermarkAt,
    activityWatermarkAt,
    keysetFingerprint,
    externalUserId,
    expectedRunId,
    expectedRunId
  ).run();
  return d1ResultChanged(result);
}

export async function listKnownUsageUserIds(db: D1Database) {
  const result = await db.prepare(
    `
    SELECT external_user_id AS externalUserId FROM gateway_usage_user_snapshots
    UNION
    SELECT external_user_id AS externalUserId FROM gateway_usage_daily_snapshots
    `
  ).all<{ externalUserId?: string }>();
  return (result.results ?? []).map((row) => normalizeUserId(row.externalUserId)).filter(Boolean);
}

export async function stageUsageDailySnapshotRows(
  db: D1Database,
  input: {
    runId: string;
    updatedAt: string;
    rows: UsageDailySnapshotInput[];
  }
) {
  const upserts = input.rows.map((row) => usageDailyStagingInsertStatement(db, input, row));
  for (let index = 0; index < upserts.length; index += MAX_D1_BATCH_STATEMENTS) {
    await db.batch(upserts.slice(index, index + MAX_D1_BATCH_STATEMENTS));
  }
}

export async function stageUsageDailyModelSnapshotRows(
  db: D1Database,
  input: {
    runId: string;
    updatedAt: string;
    rows: UsageDailyModelSnapshotInput[];
  }
) {
  const upserts = input.rows.map((row) => usageDailyModelStagingInsertStatement(db, input, row));
  for (let index = 0; index < upserts.length; index += MAX_D1_BATCH_STATEMENTS) {
    await db.batch(upserts.slice(index, index + MAX_D1_BATCH_STATEMENTS));
  }
}

export async function stageUsageUsers(
  db: D1Database,
  input: {
    runId: string;
    userIds: Iterable<string>;
    monthlyBudgetUsdByUser: ReadonlyMap<string, number>;
  }
) {
  const userIds = Array.from(new Set(Array.from(input.userIds, normalizeUserId).filter(Boolean))).sort();
  const statements = userIds.map((userId) => db.prepare(
    `
    INSERT INTO gateway_usage_user_snapshot_staging (
      run_id,
      external_user_id,
      monthly_budget_usd
    ) VALUES (?, ?, ?)
    ON CONFLICT(run_id, external_user_id) DO UPDATE SET
      monthly_budget_usd = excluded.monthly_budget_usd
    `
  ).bind(
    input.runId,
    userId,
    input.monthlyBudgetUsdByUser.has(userId)
      ? nonNegativeNumber(input.monthlyBudgetUsdByUser.get(userId))
      : null
  ));

  for (let index = 0; index < statements.length; index += MAX_D1_BATCH_STATEMENTS) {
    await db.batch(statements.slice(index, index + MAX_D1_BATCH_STATEMENTS));
  }
}

export async function publishStagedUsageSnapshot(
  db: D1Database,
  input: UsageSnapshotPublishInput
): Promise<boolean> {
  const fromDate = requireIsoDate(input.fromDate);
  const toDate = requireIsoDate(input.toDate);
  const dataThroughDate = requireIsoDate(input.dataThroughDate);
  if (fromDate > toDate || toDate > dataThroughDate) {
    throw new Error("invalid_usage_snapshot_range");
  }
  const externalUserId = normalizeUserId(input.externalUserId);
  if (externalUserId) {
    return publishStagedUsageSnapshotForUser(db, {
      ...input,
      externalUserId,
      fromDate,
      toDate,
      dataThroughDate
    });
  }
  const peakFromDate = addIsoDateDays(dataThroughDate, -(GATEWAY_USAGE_DAILY_WINDOW_DAYS - 1));
  const publishingRunGuard = `
    EXISTS (
      SELECT 1
      FROM gateway_usage_snapshot_runs AS publishing_run
      WHERE publishing_run.id = ?
        AND publishing_run.status = 'running'
        AND publishing_run.source_from_date = ?
        AND publishing_run.source_to_date = ?
        AND publishing_run.data_through_date = ?
    )
  `;

  const deleteLiveRange = db.prepare(
    `
    DELETE FROM gateway_usage_daily_snapshots
    WHERE usage_date BETWEEN ? AND ?
      AND ${publishingRunGuard}
    `
  ).bind(fromDate, toDate, input.runId, fromDate, toDate, dataThroughDate);
  const insertStagedRange = db.prepare(
    `
    INSERT INTO gateway_usage_daily_snapshots (
      usage_date,
      external_user_id,
      token_id,
      requests,
      input_tokens,
      output_tokens,
      reasoning_output_tokens,
      tokens,
      estimated_cost_usd,
      run_id,
      updated_at
    )
    SELECT
      usage_date,
      external_user_id,
      token_id,
      requests,
      input_tokens,
      output_tokens,
      reasoning_output_tokens,
      tokens,
      estimated_cost_usd,
      run_id,
      updated_at
    FROM gateway_usage_daily_snapshot_staging
    WHERE run_id = ? AND usage_date BETWEEN ? AND ?
      AND ${publishingRunGuard}
    `
  ).bind(
    input.runId,
    fromDate,
    toDate,
    input.runId,
    fromDate,
    toDate,
    dataThroughDate
  );
  const deleteLiveModelRange = db.prepare(
    `
    DELETE FROM gateway_usage_daily_model_snapshots
    WHERE usage_date BETWEEN ? AND ?
      AND ${publishingRunGuard}
    `
  ).bind(fromDate, toDate, input.runId, fromDate, toDate, dataThroughDate);
  const insertStagedModelRange = db.prepare(
    `
    INSERT INTO gateway_usage_daily_model_snapshots (
      usage_date,
      external_user_id,
      token_id,
      model_group,
      upstream_model,
      provider,
      requests,
      input_tokens,
      cache_read_input_tokens,
      cache_write_input_tokens,
      output_tokens,
      reasoning_output_tokens,
      tokens,
      input_cost_usd,
      output_cost_usd,
      cache_read_cost_usd,
      cache_write_cost_usd,
      tool_cost_usd,
      original_cost_usd,
      discount_usd,
      billed_cost_usd,
      run_id,
      updated_at
    )
    SELECT
      usage_date,
      external_user_id,
      token_id,
      model_group,
      upstream_model,
      provider,
      requests,
      input_tokens,
      cache_read_input_tokens,
      cache_write_input_tokens,
      output_tokens,
      reasoning_output_tokens,
      tokens,
      input_cost_usd,
      output_cost_usd,
      cache_read_cost_usd,
      cache_write_cost_usd,
      tool_cost_usd,
      original_cost_usd,
      discount_usd,
      billed_cost_usd,
      run_id,
      updated_at
    FROM gateway_usage_daily_model_snapshot_staging
    WHERE run_id = ? AND usage_date BETWEEN ? AND ?
      AND ${publishingRunGuard}
    `
  ).bind(
    input.runId,
    fromDate,
    toDate,
    input.runId,
    fromDate,
    toDate,
    dataThroughDate
  );
  const publishUsers = db.prepare(
    `
    INSERT INTO gateway_usage_user_snapshots (
      external_user_id,
      run_id,
      status,
      timezone,
      updated_at,
      data_through_date,
      cumulative_tokens,
      peak_daily_tokens,
      monthly_budget_usd
    )
    SELECT
      staged.external_user_id,
      ?,
      'ready',
      ?,
      ?,
      ?,
      COALESCE((
        SELECT SUM(daily.tokens)
        FROM gateway_usage_daily_snapshots AS daily
        WHERE daily.external_user_id = staged.external_user_id
          AND daily.usage_date <= ?
      ), 0),
      COALESCE((
        SELECT MAX(peaks.day_tokens)
        FROM (
          SELECT external_user_id, usage_date, SUM(tokens) AS day_tokens
          FROM gateway_usage_daily_snapshots
          WHERE usage_date BETWEEN ? AND ?
          GROUP BY external_user_id, usage_date
        ) AS peaks
        WHERE peaks.external_user_id = staged.external_user_id
      ), 0),
      COALESCE(
        staged.monthly_budget_usd,
        (
          SELECT current.monthly_budget_usd
          FROM gateway_usage_user_snapshots AS current
          WHERE current.external_user_id = staged.external_user_id
        ),
        0
      )
    FROM gateway_usage_user_snapshot_staging AS staged
    WHERE staged.run_id = ?
      AND ${publishingRunGuard}
    ON CONFLICT(external_user_id) DO UPDATE SET
      run_id = excluded.run_id,
      status = excluded.status,
      timezone = excluded.timezone,
      updated_at = excluded.updated_at,
      data_through_date = excluded.data_through_date,
      cumulative_tokens = excluded.cumulative_tokens,
      peak_daily_tokens = excluded.peak_daily_tokens,
      monthly_budget_usd = excluded.monthly_budget_usd
    `
  ).bind(
    input.runId,
    GATEWAY_USAGE_TIMEZONE,
    input.completedAt,
    dataThroughDate,
    dataThroughDate,
    peakFromDate,
    dataThroughDate,
    input.runId,
    input.runId,
    fromDate,
    toDate,
    dataThroughDate
  );
  const markReady = db.prepare(
    `
    UPDATE gateway_usage_snapshot_runs
    SET status = 'ready',
        completed_at = ?,
        source_row_count = ?,
        attributed_row_count = ?,
        error_code = NULL
    WHERE id = ?
      AND status = 'running'
      AND source_from_date = ?
      AND source_to_date = ?
      AND data_through_date = ?
    `
  ).bind(
    input.completedAt,
    nonNegativeInteger(input.sourceRowCount),
    nonNegativeInteger(input.attributedRowCount),
    input.runId,
    fromDate,
    toDate,
    dataThroughDate
  );
  const deleteDailyStaging = db.prepare(
    `DELETE FROM gateway_usage_daily_snapshot_staging WHERE run_id = ?`
  ).bind(input.runId);
  const deleteModelStaging = db.prepare(
    `DELETE FROM gateway_usage_daily_model_snapshot_staging WHERE run_id = ?`
  ).bind(input.runId);
  const deleteUserStaging = db.prepare(
    `DELETE FROM gateway_usage_user_snapshot_staging WHERE run_id = ?`
  ).bind(input.runId);

  // D1 batch is a single transaction: readers see either the previous live
  // snapshot or this fully published run, never an intermediate range.
  await db.batch([
    deleteLiveRange,
    insertStagedRange,
    deleteLiveModelRange,
    insertStagedModelRange,
    publishUsers,
    markReady,
    deleteDailyStaging,
    deleteModelStaging,
    deleteUserStaging
  ]);
  return true;
}

async function publishStagedUsageSnapshotForUser(
  db: D1Database,
  input: UsageSnapshotPublishInput & {
    externalUserId: string;
    fromDate: string;
    toDate: string;
    dataThroughDate: string;
  }
): Promise<boolean> {
  const completedAt = requireIsoTimestamp(input.completedAt);
  const dataThroughAt = input.dataThroughAt
    ? requireIsoTimestamp(input.dataThroughAt)
    : null;
  const activityWatermarkAt = input.activityWatermarkAt
    ? requireIsoTimestamp(input.activityWatermarkAt)
    : null;
  const reconciledAt = input.reconciledAt
    ? requireIsoTimestamp(input.reconciledAt)
    : null;
  const keysetFingerprint = normalizeKeysetFingerprint(input.keysetFingerprint) || null;
  const triggerType = input.triggerType
    ? normalizeUsageSnapshotTrigger(input.triggerType)
    : null;
  const peakFromDate = addIsoDateDays(
    input.dataThroughDate,
    -(GATEWAY_USAGE_DAILY_WINDOW_DAYS - 1)
  );
  const publishingRunGuard = `
    EXISTS (
      SELECT 1
      FROM gateway_usage_snapshot_runs AS publishing_run
      WHERE publishing_run.id = ?
        AND publishing_run.external_user_id = ?
        AND publishing_run.status = 'running'
        AND publishing_run.source_from_date = ?
        AND publishing_run.source_to_date = ?
        AND publishing_run.data_through_date = ?
        AND (? IS NULL OR publishing_run.data_through_at = ?)
        AND EXISTS (
          SELECT 1
          FROM gateway_usage_user_snapshot_staging AS staged_user
          WHERE staged_user.run_id = publishing_run.id
            AND staged_user.external_user_id = ?
        )
        AND NOT EXISTS (
          SELECT 1
          FROM gateway_usage_user_snapshots AS current
          LEFT JOIN gateway_usage_snapshot_runs AS current_run
            ON current_run.id = current.run_id
          WHERE current.external_user_id = ?
            AND (
              COALESCE(
                current.data_through_at,
                current.data_through_date || 'T15:59:59.999Z'
              ) > COALESCE(
                publishing_run.data_through_at,
                publishing_run.data_through_date || 'T15:59:59.999Z'
              )
              OR (
                COALESCE(
                  current.data_through_at,
                  current.data_through_date || 'T15:59:59.999Z'
                ) = COALESCE(
                  publishing_run.data_through_at,
                  publishing_run.data_through_date || 'T15:59:59.999Z'
                )
                AND COALESCE(current_run.started_at, current.updated_at)
                  > publishing_run.started_at
              )
            )
        )
    )
  `;
  const guardBindings = [
    input.runId,
    input.externalUserId,
    input.fromDate,
    input.toDate,
    input.dataThroughDate,
    dataThroughAt,
    dataThroughAt,
    input.externalUserId,
    input.externalUserId
  ];

  const deleteLiveRange = db.prepare(
    `
    DELETE FROM gateway_usage_daily_snapshots
    WHERE external_user_id = ?
      AND usage_date BETWEEN ? AND ?
      AND ${publishingRunGuard}
    `
  ).bind(input.externalUserId, input.fromDate, input.toDate, ...guardBindings);
  const insertStagedRange = db.prepare(
    `
    INSERT INTO gateway_usage_daily_snapshots (
      usage_date,
      external_user_id,
      token_id,
      requests,
      input_tokens,
      output_tokens,
      reasoning_output_tokens,
      tokens,
      estimated_cost_usd,
      run_id,
      updated_at
    )
    SELECT
      usage_date,
      external_user_id,
      token_id,
      requests,
      input_tokens,
      output_tokens,
      reasoning_output_tokens,
      tokens,
      estimated_cost_usd,
      run_id,
      updated_at
    FROM gateway_usage_daily_snapshot_staging
    WHERE run_id = ?
      AND external_user_id = ?
      AND usage_date BETWEEN ? AND ?
      AND ${publishingRunGuard}
    `
  ).bind(
    input.runId,
    input.externalUserId,
    input.fromDate,
    input.toDate,
    ...guardBindings
  );
  const publishUser = db.prepare(
    `
    INSERT INTO gateway_usage_user_snapshots (
      external_user_id,
      run_id,
      status,
      timezone,
      updated_at,
      data_through_date,
      data_through_at,
      last_checked_at,
      activity_watermark_at,
      last_reconciled_at,
      keyset_fingerprint,
      trigger_type,
      cumulative_tokens,
      peak_daily_tokens,
      monthly_budget_usd
    )
    SELECT
      staged.external_user_id,
      staged.run_id,
      'ready',
      ?,
      ?,
      ?,
      COALESCE(?, publishing_run.data_through_at),
      ?,
      COALESCE(?, publishing_run.activity_watermark_at, current.activity_watermark_at),
      COALESCE(?, current.last_reconciled_at),
      COALESCE(?, publishing_run.keyset_fingerprint, current.keyset_fingerprint),
      COALESCE(?, publishing_run.trigger_type, 'scheduled'),
      COALESCE((
        SELECT SUM(daily.tokens)
        FROM gateway_usage_daily_snapshots AS daily
        WHERE daily.external_user_id = staged.external_user_id
          AND daily.usage_date <= ?
      ), 0),
      COALESCE((
        SELECT MAX(peaks.day_tokens)
        FROM (
          SELECT external_user_id, usage_date, SUM(tokens) AS day_tokens
          FROM gateway_usage_daily_snapshots
          WHERE usage_date BETWEEN ? AND ?
          GROUP BY external_user_id, usage_date
        ) AS peaks
        WHERE peaks.external_user_id = staged.external_user_id
      ), 0),
      COALESCE(staged.monthly_budget_usd, current.monthly_budget_usd, 0)
    FROM gateway_usage_user_snapshot_staging AS staged
    JOIN gateway_usage_snapshot_runs AS publishing_run
      ON publishing_run.id = staged.run_id
    LEFT JOIN gateway_usage_user_snapshots AS current
      ON current.external_user_id = staged.external_user_id
    WHERE staged.run_id = ?
      AND staged.external_user_id = ?
      AND ${publishingRunGuard}
    ON CONFLICT(external_user_id) DO UPDATE SET
      run_id = excluded.run_id,
      status = excluded.status,
      timezone = excluded.timezone,
      updated_at = excluded.updated_at,
      data_through_date = excluded.data_through_date,
      data_through_at = excluded.data_through_at,
      last_checked_at = excluded.last_checked_at,
      activity_watermark_at = excluded.activity_watermark_at,
      last_reconciled_at = excluded.last_reconciled_at,
      keyset_fingerprint = excluded.keyset_fingerprint,
      trigger_type = excluded.trigger_type,
      cumulative_tokens = excluded.cumulative_tokens,
      peak_daily_tokens = excluded.peak_daily_tokens,
      monthly_budget_usd = excluded.monthly_budget_usd
    `
  ).bind(
    GATEWAY_USAGE_TIMEZONE,
    completedAt,
    input.dataThroughDate,
    dataThroughAt,
    completedAt,
    activityWatermarkAt,
    reconciledAt,
    keysetFingerprint,
    triggerType,
    input.dataThroughDate,
    peakFromDate,
    input.dataThroughDate,
    input.runId,
    input.externalUserId,
    ...guardBindings
  );
  const markReady = db.prepare(
    `
    UPDATE gateway_usage_snapshot_runs
    SET status = 'ready',
        completed_at = ?,
        data_through_at = COALESCE(?, data_through_at),
        activity_watermark_at = COALESCE(?, activity_watermark_at),
        keyset_fingerprint = COALESCE(?, keyset_fingerprint),
        trigger_type = COALESCE(?, trigger_type),
        source_row_count = ?,
        attributed_row_count = ?,
        error_code = NULL
    WHERE id = ?
      AND external_user_id = ?
      AND status = 'running'
      AND ${publishingRunGuard}
    `
  ).bind(
    completedAt,
    dataThroughAt,
    activityWatermarkAt,
    keysetFingerprint,
    triggerType,
    nonNegativeInteger(input.sourceRowCount),
    nonNegativeInteger(input.attributedRowCount),
    input.runId,
    input.externalUserId,
    ...guardBindings
  );
  const markSuperseded = db.prepare(
    `
    UPDATE gateway_usage_snapshot_runs
    SET status = 'error',
        completed_at = ?,
        source_row_count = ?,
        attributed_row_count = ?,
        error_code = 'usage_snapshot_superseded'
    WHERE id = ? AND external_user_id = ? AND status = 'running'
    `
  ).bind(
    completedAt,
    nonNegativeInteger(input.sourceRowCount),
    nonNegativeInteger(input.attributedRowCount),
    input.runId,
    input.externalUserId
  );
  const deleteDailyStaging = db.prepare(
    `DELETE FROM gateway_usage_daily_snapshot_staging WHERE run_id = ?`
  ).bind(input.runId);
  const deleteModelStaging = db.prepare(
    `DELETE FROM gateway_usage_daily_model_snapshot_staging WHERE run_id = ?`
  ).bind(input.runId);
  const deleteUserStaging = db.prepare(
    `DELETE FROM gateway_usage_user_snapshot_staging WHERE run_id = ?`
  ).bind(input.runId);

  await db.batch([
    deleteLiveRange,
    insertStagedRange,
    publishUser,
    markReady,
    markSuperseded,
    deleteDailyStaging,
    deleteModelStaging,
    deleteUserStaging
  ]);
  const publishedRun = await db.prepare(
    `
    SELECT status
    FROM gateway_usage_snapshot_runs
    WHERE id = ? AND external_user_id = ?
    LIMIT 1
    `
  ).bind(input.runId, input.externalUserId).first<{ status?: string }>();
  return publishedRun?.status === "ready";
}

export function emptyUsageAnalytics(
  status: UsageAnalyticsStatus,
  metadata: { updatedAt?: string; dataThroughDate?: string } = {}
): UsageAnalytics {
  return {
    timezone: GATEWAY_USAGE_TIMEZONE,
    source: "snapshot",
    status,
    ...(metadata.updatedAt ? { updatedAt: metadata.updatedAt } : {}),
    ...(metadata.dataThroughDate ? { dataThroughDate: metadata.dataThroughDate } : {}),
    summary: {
      cumulativeTokens: 0,
      peakDailyTokens: 0,
      currentMonthSpendUsd: 0,
      monthlyBudgetUsd: 0
    },
    dailyUsage: [],
    tokenUsage: []
  };
}

export function dateKeyInTimeZone(value: Date, timeZone: string) {
  const date = Number.isFinite(value.getTime()) ? value : new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addIsoDateDays(value: string, days: number) {
  const date = requireIsoDate(value);
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(timestamp + Math.trunc(days) * 86_400_000).toISOString().slice(0, 10);
}

export function computeUsageKeyActivityWatermark(keys: Iterable<unknown>) {
  let watermark = "";
  for (const value of keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const key = value as Record<string, unknown>;
    const timestamp = validIsoTimestamp(
      key.lastUsedAt
        ?? key.last_used_at
        ?? key.lastActive
        ?? key.last_active
    );
    if (timestamp > watermark) {
      watermark = timestamp;
    }
  }
  return watermark || undefined;
}

export async function computeUsageKeysetFingerprint(keys: Iterable<unknown>) {
  const identities = Array.from(new Set(Array.from(keys, usageKeyIdentity).filter(Boolean))).sort();
  const bytes = new TextEncoder().encode(JSON.stringify(identities));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function usageDailyStagingInsertStatement(
  db: D1Database,
  input: { runId: string; updatedAt: string },
  row: UsageDailySnapshotInput
) {
  return db.prepare(
    `
    INSERT INTO gateway_usage_daily_snapshot_staging (
      run_id,
      usage_date,
      external_user_id,
      token_id,
      requests,
      input_tokens,
      output_tokens,
      reasoning_output_tokens,
      tokens,
      estimated_cost_usd,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, usage_date, external_user_id, token_id) DO UPDATE SET
      requests = excluded.requests,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      tokens = excluded.tokens,
      estimated_cost_usd = excluded.estimated_cost_usd,
      run_id = excluded.run_id,
      updated_at = excluded.updated_at
    `
  ).bind(
    input.runId,
    requireIsoDate(row.date),
    normalizeUserId(row.externalUserId),
    readText(row.tokenId) || UNKNOWN_TOKEN_ID,
    nonNegativeInteger(row.requests),
    nonNegativeInteger(row.inputTokens),
    nonNegativeInteger(row.outputTokens),
    nonNegativeInteger(row.reasoningOutputTokens),
    nonNegativeInteger(row.tokens),
    nonNegativeNumber(row.estimatedCostUsd),
    input.updatedAt
  );
}

function usageDailyModelStagingInsertStatement(
  db: D1Database,
  input: { runId: string; updatedAt: string },
  row: UsageDailyModelSnapshotInput
) {
  return db.prepare(
    `
    INSERT INTO gateway_usage_daily_model_snapshot_staging (
      run_id,
      usage_date,
      external_user_id,
      token_id,
      model_group,
      upstream_model,
      provider,
      requests,
      input_tokens,
      cache_read_input_tokens,
      cache_write_input_tokens,
      output_tokens,
      reasoning_output_tokens,
      tokens,
      input_cost_usd,
      output_cost_usd,
      cache_read_cost_usd,
      cache_write_cost_usd,
      tool_cost_usd,
      original_cost_usd,
      discount_usd,
      billed_cost_usd,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, usage_date, external_user_id, token_id, model_group, upstream_model) DO UPDATE SET
      provider = excluded.provider,
      requests = excluded.requests,
      input_tokens = excluded.input_tokens,
      cache_read_input_tokens = excluded.cache_read_input_tokens,
      cache_write_input_tokens = excluded.cache_write_input_tokens,
      output_tokens = excluded.output_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      tokens = excluded.tokens,
      input_cost_usd = excluded.input_cost_usd,
      output_cost_usd = excluded.output_cost_usd,
      cache_read_cost_usd = excluded.cache_read_cost_usd,
      cache_write_cost_usd = excluded.cache_write_cost_usd,
      tool_cost_usd = excluded.tool_cost_usd,
      original_cost_usd = excluded.original_cost_usd,
      discount_usd = excluded.discount_usd,
      billed_cost_usd = excluded.billed_cost_usd,
      updated_at = excluded.updated_at
    `
  ).bind(
    input.runId,
    requireIsoDate(row.date),
    normalizeUserId(row.externalUserId),
    readText(row.tokenId) || UNKNOWN_TOKEN_ID,
    readText(row.modelGroup).trim() || "unknown",
    readText(row.upstreamModel).trim() || "unknown",
    readText(row.provider).trim() || "unknown",
    nonNegativeInteger(row.requests),
    nonNegativeInteger(row.inputTokens),
    nonNegativeInteger(row.cacheReadInputTokens),
    nonNegativeInteger(row.cacheWriteInputTokens),
    nonNegativeInteger(row.outputTokens),
    nonNegativeInteger(row.reasoningOutputTokens),
    nonNegativeInteger(row.tokens),
    nonNegativeNumber(row.inputCostUsd),
    nonNegativeNumber(row.outputCostUsd),
    nonNegativeNumber(row.cacheReadCostUsd),
    nonNegativeNumber(row.cacheWriteCostUsd),
    nonNegativeNumber(row.toolCostUsd),
    nonNegativeNumber(row.originalCostUsd),
    nonNegativeNumber(row.discountUsd),
    nonNegativeNumber(row.billedCostUsd),
    input.updatedAt
  );
}

function usageRefreshStateStatement(db: D1Database, userIds?: string[]) {
  const where = userIds
    ? `WHERE external_user_id IN (${userIds.map(() => "?").join(", ")})`
    : "";
  const statement = db.prepare(
    `
    SELECT
      external_user_id AS externalUserId,
      run_id AS runId,
      updated_at AS updatedAt,
      data_through_date AS dataThroughDate,
      data_through_at AS dataThroughAt,
      last_checked_at AS lastCheckedAt,
      activity_watermark_at AS activityWatermarkAt,
      last_reconciled_at AS lastReconciledAt,
      keyset_fingerprint AS keysetFingerprint,
      trigger_type AS triggerType
    FROM gateway_usage_user_snapshots
    ${where}
    ORDER BY external_user_id ASC
    `
  );
  return userIds ? statement.bind(...userIds) : statement;
}

function runIsNewerThanSnapshot(run: UsageSnapshotRunRow, snapshot: UsageUserSnapshotRow | null) {
  if (!snapshot) {
    return true;
  }
  return readText(run.startedAt) > readText(snapshot.updatedAt);
}

function isMissingUsageSnapshotTable(error: unknown) {
  const message = error instanceof Error ? error.message : readText(error);
  return /no such table[^\n]*(gateway_usage_snapshot_runs|gateway_usage_user_snapshots|gateway_usage_daily_snapshots)/i.test(message);
}

function isMissingUsageSummaryRefreshTable(error: unknown) {
  const message = error instanceof Error ? error.message : readText(error);
  return /no such table[^\n]*gateway_usage_summary_refresh_state/i.test(message);
}

function validIsoTimestamp(value: unknown) {
  const text = readText(value).trim();
  if (!text) {
    return "";
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function requireIsoTimestamp(value: unknown) {
  const timestamp = validIsoTimestamp(value);
  if (!timestamp) {
    throw new Error("invalid_usage_snapshot_timestamp");
  }
  return timestamp;
}

function validUsageSnapshotTrigger(value: unknown): UsageSnapshotTriggerType | undefined {
  const trigger = readText(value).trim();
  return trigger === "manual"
    || trigger === "automatic"
    || trigger === "scheduled"
    || trigger === "reconcile"
    ? trigger
    : undefined;
}

function normalizeUsageSnapshotTrigger(value: unknown): UsageSnapshotTriggerType {
  return validUsageSnapshotTrigger(value) ?? "scheduled";
}

function normalizeKeysetFingerprint(value: unknown) {
  const fingerprint = readText(value).trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : "";
}

function usageKeyIdentity(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const key = value as Record<string, unknown>;
  return readText(
    key.id
      ?? key.tokenId
      ?? key.token_id
      ?? key.tokenHash
      ?? key.token_hash
      ?? key.keyHash
      ?? key.key_hash
      ?? key.apiKey
      ?? key.api_key
      ?? key.key
      ?? key.token
  ).trim();
}

function requireUserId(value: unknown) {
  const userId = normalizeUserId(value);
  if (!userId) {
    throw new Error("missing_usage_snapshot_user_id");
  }
  return userId;
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.min(maximum, Math.max(1, Math.trunc(number)));
}

function d1ResultChanged(result: unknown) {
  if (!result || typeof result !== "object") {
    return false;
  }
  const row = result as { changes?: unknown; meta?: { changes?: unknown } };
  return nonNegativeInteger(row.meta?.changes ?? row.changes) > 0;
}

function validIsoDate(value: unknown) {
  const text = readText(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return "";
  }
  try {
    return new Date(`${text}T00:00:00.000Z`).toISOString().slice(0, 10) === text ? text : "";
  } catch {
    return "";
  }
}

function requireIsoDate(value: unknown) {
  const date = validIsoDate(value);
  if (!date) {
    throw new Error("invalid_usage_snapshot_date");
  }
  return date;
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
