import {
  addIsoDateDays,
  beginUsageSnapshotRun,
  computeUsageKeyActivityWatermark,
  computeUsageKeysetFingerprint,
  dateKeyInTimeZone,
  failUsageSnapshotRun,
  GATEWAY_USAGE_TIMEZONE,
  publishStagedUsageSnapshot,
  readUsageAnalytics,
  stageUsageDailySnapshotRows,
  stageUsageUsers,
  type UsageAnalytics,
  type UsageDailySnapshotInput
} from "./usageSnapshots.ts";

const DEFAULT_HISTORY_START_DATE = "2026-07-13";
const DEFAULT_REFRESH_LOOKBACK_DAYS = 7;
const MAX_REFRESH_LOOKBACK_DAYS = 31;
const REFRESH_RUN_STALE_AFTER_MS = 15 * 60 * 1000;
const UNKNOWN_TOKEN_ID = "__unknown__";

export type UsageRefreshTrigger = "manual" | "automatic" | "scheduled" | "reconcile";

export type UsageRefreshDecisionReason =
  | "snapshot_missing"
  | "keyset_changed"
  | "key_activity"
  | "reconcile_due"
  | "current";

export type UsageRefreshSnapshotState = Pick<
  UsageAnalytics,
  "dataThroughAt" | "lastReconciledAt" | "keysetFingerprint"
>;

export type UsageRefreshActivity = {
  maxLastUsedAt?: string;
  keysetFingerprint: string;
};

export type UsageRefreshDecision = {
  recommended: boolean;
  reason: UsageRefreshDecisionReason;
};

export type UsageRefreshKey = {
  id: string;
  lastUsedAt?: string;
  status?: string;
  accessStatus?: string;
  metadata?: unknown;
};

export type UserUsageRefreshResult = {
  status: "committed" | "busy" | "superseded";
  analytics: UsageAnalytics;
  endpoints: string[];
  sourceFromDate: string;
  sourceToDate: string;
  sourceRowCount: number;
  attributedRowCount: number;
  unattributedRowCount: number;
};

type UsageRefreshCollection = {
  logs: unknown[];
  endpoints?: string[];
};

type UsageRefreshDependencies = {
  beginRun?: typeof beginUsageSnapshotRun;
  clock?: () => Date;
  failRun?: typeof failUsageSnapshotRun;
  fingerprint?: typeof computeUsageKeysetFingerprint;
  publish?: typeof publishStagedUsageSnapshot;
  randomUUID?: () => string;
  readAnalytics?: typeof readUsageAnalytics;
  stageRows?: typeof stageUsageDailySnapshotRows;
  stageUsers?: typeof stageUsageUsers;
  watermark?: typeof computeUsageKeyActivityWatermark;
};

export async function usageRefreshActivityForKeys(
  keys: readonly UsageRefreshKey[]
): Promise<UsageRefreshActivity> {
  return {
    maxLastUsedAt: computeUsageKeyActivityWatermark(keys),
    keysetFingerprint: await computeUsageKeysetFingerprint(keys)
  };
}

export function evaluateUsageRefreshNeed(input: {
  snapshot?: UsageRefreshSnapshotState | null;
  activity: UsageRefreshActivity;
  now: Date;
  reconcileAfterHours?: number;
}): UsageRefreshDecision {
  if (!input.snapshot) {
    return { recommended: true, reason: "snapshot_missing" };
  }

  if ((input.snapshot.keysetFingerprint ?? "") !== input.activity.keysetFingerprint) {
    return { recommended: true, reason: "keyset_changed" };
  }

  const dataThroughMillis = timestampMillis(input.snapshot.dataThroughAt);
  const lastUsedMillis = timestampMillis(input.activity.maxLastUsedAt);
  if (lastUsedMillis !== undefined
    && (dataThroughMillis === undefined || lastUsedMillis > dataThroughMillis)) {
    return { recommended: true, reason: "key_activity" };
  }

  const reconcileAfterHours = boundedInteger(input.reconcileAfterHours, 1, 168, 24);
  const lastReconciledMillis = timestampMillis(input.snapshot.lastReconciledAt);
  if (lastReconciledMillis === undefined
    || input.now.getTime() - lastReconciledMillis >= reconcileAfterHours * 60 * 60 * 1000) {
    return { recommended: true, reason: "reconcile_due" };
  }

  return { recommended: false, reason: "current" };
}

export async function refreshUsageForUser(
  input: {
    db: D1Database | undefined;
    externalUserId: string;
    fetchSpendLogs(range: {
      dataThroughAt: string;
      fromDate: string;
      toDate: string;
      userId: string;
    }): Promise<UsageRefreshCollection>;
    historyStartDate?: string;
    keys: UsageRefreshKey[];
    lookbackDays?: number;
    monthlyBudgetUsd?: number;
    now?: Date;
    triggerType: UsageRefreshTrigger;
  },
  dependencies: UsageRefreshDependencies = {}
): Promise<UserUsageRefreshResult> {
  if (!input.db) {
    throw new Error("usage_snapshot_database_unavailable");
  }

  const externalUserId = normalizeUserId(input.externalUserId);
  if (!externalUserId) {
    throw new Error("invalid_usage_snapshot_user");
  }

  const clock = dependencies.clock ?? (() => new Date());
  const now = validDate(input.now) ?? clock();
  const dataThroughAt = now.toISOString();
  const dataThroughDate = dateKeyInTimeZone(now, GATEWAY_USAGE_TIMEZONE);
  const readAnalytics = dependencies.readAnalytics ?? readUsageAnalytics;
  const snapshot = await readAnalytics(input.db, externalUserId, now);
  const sourceFromDate = usageRefreshSourceFromDate({
    currentDate: dataThroughDate,
    historyStartDate: input.historyStartDate,
    lookbackDays: input.lookbackDays,
    snapshotDate: snapshot.dataThroughDate
  });
  const eligibleKeys = input.keys.filter((key) => timestampAtOrBefore(key.lastUsedAt, dataThroughAt));
  const watermark = dependencies.watermark ?? computeUsageKeyActivityWatermark;
  const fingerprint = dependencies.fingerprint ?? computeUsageKeysetFingerprint;
  const activityWatermarkAt = watermark(eligibleKeys);
  const keysetFingerprint = await fingerprint(input.keys);
  const runId = (dependencies.randomUUID ?? (() => crypto.randomUUID()))();
  const beginRun = dependencies.beginRun ?? beginUsageSnapshotRun;
  const started = await beginRun(input.db, {
    id: runId,
    externalUserId,
    triggerType: input.triggerType,
    sourceFromDate,
    sourceToDate: dataThroughDate,
    dataThroughDate,
    dataThroughAt,
    activityWatermarkAt,
    keysetFingerprint,
    startedAt: dataThroughAt,
    staleAfterMs: REFRESH_RUN_STALE_AFTER_MS
  });

  if (!started) {
    return emptyRefreshResult("busy", snapshot, sourceFromDate, dataThroughDate);
  }

  let sourceRowCount = 0;
  let attributedRowCount = 0;
  let unattributedRowCount = 0;

  try {
    const collected = await input.fetchSpendLogs({
      dataThroughAt,
      fromDate: sourceFromDate,
      toDate: dataThroughDate,
      userId: externalUserId
    });
    const aggregated = aggregateUserSpendLogs({
      dataThroughAt,
      externalUserId,
      fromDate: sourceFromDate,
      keys: input.keys,
      logs: collected.logs,
      toDate: dataThroughDate
    });
    sourceRowCount = aggregated.sourceRowCount;
    attributedRowCount = aggregated.attributedRowCount;
    unattributedRowCount = aggregated.unattributedRowCount;

    const stageRows = dependencies.stageRows ?? stageUsageDailySnapshotRows;
    const stageUsers = dependencies.stageUsers ?? stageUsageUsers;
    await stageRows(input.db, {
      runId,
      updatedAt: dataThroughAt,
      rows: aggregated.rows
    });
    await stageUsers(input.db, {
      runId,
      userIds: [externalUserId],
      monthlyBudgetUsdByUser: finiteNonNegative(input.monthlyBudgetUsd) === undefined
        ? new Map()
        : new Map([[externalUserId, finiteNonNegative(input.monthlyBudgetUsd)!]])
    });

    const completedAt = clock().toISOString();
    const publish = dependencies.publish ?? publishStagedUsageSnapshot;
    const committed = await publish(input.db, {
      runId,
      externalUserId,
      fromDate: sourceFromDate,
      toDate: dataThroughDate,
      dataThroughDate,
      dataThroughAt,
      completedAt,
      sourceRowCount,
      attributedRowCount,
      activityWatermarkAt,
      keysetFingerprint,
      triggerType: input.triggerType,
      reconciledAt: completedAt
    });
    const analytics = await readAnalytics(input.db, externalUserId, new Date(completedAt));

    return {
      status: committed ? "committed" : "superseded",
      analytics,
      endpoints: collected.endpoints ?? [],
      sourceFromDate,
      sourceToDate: dataThroughDate,
      sourceRowCount,
      attributedRowCount,
      unattributedRowCount
    };
  } catch (error) {
    const failRun = dependencies.failRun ?? failUsageSnapshotRun;
    try {
      await failRun(input.db, {
        id: runId,
        completedAt: clock().toISOString(),
        errorCode: usageRefreshErrorCode(error),
        sourceRowCount,
        attributedRowCount
      });
    } catch (cleanupError) {
      console.error("token_usage_refresh_error_record_failed", {
        error: usageRefreshErrorCode(cleanupError),
        runId,
        userId: externalUserId
      });
    }
    throw error;
  }
}

export function aggregateUserSpendLogs(input: {
  dataThroughAt: string;
  externalUserId: string;
  fromDate: string;
  keys: UsageRefreshKey[];
  logs: unknown[];
  toDate: string;
}) {
  const externalUserId = normalizeUserId(input.externalUserId);
  const cutoff = Date.parse(input.dataThroughAt);
  const ownedTokenIds = new Set(input.keys.map((key) => readText(key.id).trim()).filter(Boolean));
  const seenRequestIds = new Set<string>();
  const rows = new Map<string, UsageDailySnapshotInput>();
  let attributedRowCount = 0;
  let unattributedRowCount = 0;

  for (const value of input.logs) {
    const row = readRecord(value);
    const timestamp = readText(
      row.startTime ?? row.start_time ?? row.created_at ?? row.createdAt ?? row.timestamp
    ).trim();
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || !Number.isFinite(cutoff) || timestampMs > cutoff) {
      continue;
    }

    const usageDate = dateKeyInTimeZone(new Date(timestampMs), GATEWAY_USAGE_TIMEZONE);
    if (usageDate < input.fromDate || usageDate > input.toDate) {
      continue;
    }

    const requestId = readText(row.request_id ?? row.requestId).trim();
    if (requestId && seenRequestIds.has(requestId)) {
      continue;
    }
    if (requestId) {
      seenRequestIds.add(requestId);
    }

    const tokenId = readText(
      row.api_key ?? row.apiKey ?? row.token_id ?? row.tokenId
    ).trim() || UNKNOWN_TOKEN_ID;
    const rowUserId = normalizeUserId(row.user ?? row.user_id ?? row.userId);
    if (!ownedTokenIds.has(tokenId) && rowUserId !== externalUserId) {
      unattributedRowCount += 1;
      continue;
    }

    const inputTokens = nonNegativeInteger(row.prompt_tokens ?? row.input_tokens ?? row.inputTokens);
    const outputTokens = nonNegativeInteger(row.completion_tokens ?? row.output_tokens ?? row.outputTokens);
    const explicitTokens = nonNegativeInteger(row.total_tokens ?? row.totalTokens);
    const tokens = explicitTokens || inputTokens + outputTokens;
    const reasoningOutputTokens = Math.max(0, tokens - inputTokens - outputTokens);
    const mapKey = `${usageDate}\u0000${tokenId}`;
    const current = rows.get(mapKey) ?? {
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
    current.inputTokens += inputTokens;
    current.outputTokens += outputTokens;
    current.reasoningOutputTokens += reasoningOutputTokens;
    current.tokens += tokens;
    current.estimatedCostUsd += nonNegativeNumber(
      row.spend ?? row.estimated_cost_usd ?? row.estimatedCostUsd
    );
    rows.set(mapKey, current);
    attributedRowCount += 1;
  }

  return {
    rows: Array.from(rows.values()).sort((left, right) => (
      left.date.localeCompare(right.date) || left.tokenId.localeCompare(right.tokenId)
    )),
    sourceRowCount: input.logs.length,
    attributedRowCount,
    unattributedRowCount
  };
}

export function usageRefreshSourceFromDate(input: {
  currentDate: string;
  historyStartDate?: string;
  lookbackDays?: number;
  snapshotDate?: string;
}) {
  const currentDate = validIsoDate(input.currentDate) || dateKeyInTimeZone(new Date(), GATEWAY_USAGE_TIMEZONE);
  const historyStartDate = validIsoDate(input.historyStartDate) || DEFAULT_HISTORY_START_DATE;
  const lookbackDays = boundedInteger(
    input.lookbackDays,
    1,
    MAX_REFRESH_LOOKBACK_DAYS,
    DEFAULT_REFRESH_LOOKBACK_DAYS
  );
  const snapshotDate = validIsoDate(input.snapshotDate);
  const candidate = snapshotDate
    ? addIsoDateDays(snapshotDate > currentDate ? currentDate : snapshotDate, -(lookbackDays - 1))
    : historyStartDate;
  return maxIsoDate(historyStartDate > currentDate ? currentDate : historyStartDate, candidate);
}

export function usageRefreshErrorCode(error: unknown) {
  const text = error instanceof Error ? error.message : readText(error);
  return (text || "usage_snapshot_failed").replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 240);
}

function emptyRefreshResult(
  status: "busy" | "superseded",
  analytics: UsageAnalytics,
  sourceFromDate: string,
  sourceToDate: string
): UserUsageRefreshResult {
  return {
    status,
    analytics,
    endpoints: [],
    sourceFromDate,
    sourceToDate,
    sourceRowCount: 0,
    attributedRowCount: 0,
    unattributedRowCount: 0
  };
}

function timestampAtOrBefore(value: unknown, cutoff: string) {
  const timestamp = Date.parse(readText(value));
  const cutoffTimestamp = Date.parse(cutoff);
  return !Number.isFinite(timestamp) || !Number.isFinite(cutoffTimestamp) || timestamp <= cutoffTimestamp;
}

function timestampMillis(value: unknown) {
  const timestamp = Date.parse(readText(value));
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function validDate(value: unknown) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : undefined;
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

function maxIsoDate(left: string, right: string) {
  return left >= right ? left : right;
}

function normalizeUserId(value: unknown) {
  return readText(value).trim().toLowerCase();
}

function finiteNonNegative(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : undefined;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function nonNegativeNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(min, Math.min(max, Math.round(number)))
    : fallback;
}

function readText(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
