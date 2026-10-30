import type { PortalCatalog } from "../../../src/shared/types.ts";

type CurrentUser = PortalCatalog["currentUser"];
export type ModelHealthResultStatus = "operational" | "degraded" | "failed";
export type ModelHealthRunStatus = "running" | "operational" | "degraded" | "outage" | "error";

export type ModelHealthResultInput = {
  modelId: string;
  displayName: string;
  vendorId: string;
  status: ModelHealthResultStatus;
  latencyMs: number;
  httpStatus: number;
  errorCode: string;
  requestId: string;
  responseExcerpt: string;
  testedAt: string;
};

type ModelHealthEnv = { DB?: D1Database };
type ModelHealthContext<TEnv extends ModelHealthEnv> = EventContext<TEnv, string, unknown>;
export const MODEL_HEALTH_UPTIME_WINDOW_DAYS = 7;
type ModelHealthApiDeps<TEnv extends ModelHealthEnv> = {
  httpError(status: number, message: string): Error;
  json(body: unknown, init?: ResponseInit): Response;
  now?: () => Date;
  resolveCurrentUser(context: ModelHealthContext<TEnv>): Promise<CurrentUser>;
};

type ModelHealthRunRow = {
  id: string;
  scheduled_at: string;
  slot_local: string;
  timezone: string;
  status: ModelHealthRunStatus;
  model_count: number;
  operational_count: number;
  degraded_count: number;
  failed_count: number;
  started_at: string;
  completed_at: string | null;
  error_code: string;
};

type ModelHealthResultRow = {
  run_id: string;
  model_id: string;
  display_name: string;
  vendor_id: string;
  status: ModelHealthResultStatus;
  latency_ms: number;
  http_status: number;
  error_code: string;
  request_id: string;
  response_excerpt: string;
  tested_at: string;
};

export function createLlmGatewayModelHealthApi<TEnv extends ModelHealthEnv>(deps: ModelHealthApiDeps<TEnv>) {
  return {
    async getAdminModelHealth(context: ModelHealthContext<TEnv>) {
      await deps.resolveCurrentUser(context);
      const db = context.env.DB;
      if (!db) {
        throw deps.httpError(503, "model_health_database_not_configured");
      }

      const url = new URL(context.request.url);
      const days = boundedInteger(url.searchParams.get("days"), 30, 7, 90);
      const runLimit = boundedInteger(url.searchParams.get("limit"), 0, 0, 90);
      const now = deps.now?.() ?? new Date();
      const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
      const runStatement = runLimit > 0
        ? db.prepare(`
          SELECT * FROM (
            SELECT id, scheduled_at, slot_local, timezone, status, model_count,
                   operational_count, degraded_count, failed_count, started_at,
                   completed_at, error_code
            FROM model_health_runs
            ORDER BY scheduled_at DESC
            LIMIT ?
          )
          ORDER BY scheduled_at ASC
        `).bind(runLimit)
        : db.prepare(`
          SELECT id, scheduled_at, slot_local, timezone, status, model_count,
                 operational_count, degraded_count, failed_count, started_at,
                 completed_at, error_code
          FROM model_health_runs
          WHERE scheduled_at >= ?
          ORDER BY scheduled_at ASC
        `).bind(cutoff);
      const resultStatement = runLimit > 0
        ? db.prepare(`
          WITH recent_runs AS (
            SELECT id, scheduled_at
            FROM model_health_runs
            ORDER BY scheduled_at DESC
            LIMIT ?
          )
          SELECT result.run_id, result.model_id, result.display_name, result.vendor_id,
                 result.status, result.latency_ms, result.http_status, result.error_code,
                 result.request_id, result.response_excerpt, result.tested_at
          FROM model_health_results result
          INNER JOIN recent_runs run ON run.id = result.run_id
          ORDER BY run.scheduled_at ASC, result.display_name ASC
        `).bind(runLimit)
        : db.prepare(`
          SELECT result.run_id, result.model_id, result.display_name, result.vendor_id,
                 result.status, result.latency_ms, result.http_status, result.error_code,
                 result.request_id, result.response_excerpt, result.tested_at
          FROM model_health_results result
          INNER JOIN model_health_runs run ON run.id = result.run_id
          WHERE run.scheduled_at >= ?
          ORDER BY run.scheduled_at ASC, result.display_name ASC
        `).bind(cutoff);
      const [runQuery, resultQuery] = await Promise.all([
        runStatement.all<ModelHealthRunRow>(),
        resultStatement.all<ModelHealthResultRow>()
      ]);
      const queriedRuns = (runQuery.results ?? []).map(toRun);
      const runs = runLimit > 0 ? queriedRuns.slice(-runLimit) : queriedRuns;
      const selectedRunIds = new Set(runs.map((run) => run.id));
      const results = (resultQuery.results ?? [])
        .map(toResult)
        .filter((result) => selectedRunIds.has(result.runId));
      const latestRun = [...runs].reverse().find((run) => run.status !== "running");
      const uptimeCutoff = now.getTime() - MODEL_HEALTH_UPTIME_WINDOW_DAYS * 86_400_000;
      // The grid represents the current public model set. Do not keep
      // retired/hidden deployments alive solely because they have old results.
      const latestRunModelIds = latestRun && latestRun.status !== "error"
        ? new Set(results
          .filter((result) => result.runId === latestRun.id)
          .map((result) => result.modelId))
        : undefined;
      const modelResults = latestRunModelIds && latestRunModelIds.size > 0
        ? results.filter((result) => latestRunModelIds.has(result.modelId))
        : results;
      const modelMap = new Map<string, {
        id: string;
        displayName: string;
        vendorId: string;
        results: ReturnType<typeof toResult>[];
      }>();

      for (const result of modelResults) {
        const model = modelMap.get(result.modelId) ?? {
          id: result.modelId,
          displayName: result.displayName,
          vendorId: result.vendorId,
          results: []
        };
        model.results.push(result);
        modelMap.set(result.modelId, model);
      }

      const models = Array.from(modelMap.values())
        .map((model) => ({
          ...model,
          uptimePercent: uptimePercent(model.results, uptimeCutoff)
        }))
        .sort((left, right) => left.displayName.localeCompare(right.displayName));
      const completedResults = modelResults.filter((result) => result.status !== "failed");

      return deps.json({
        generatedAt: now.toISOString(),
        rangeDays: runLimit > 0 ? MODEL_HEALTH_UPTIME_WINDOW_DAYS : days,
        rangeRunLimit: runLimit,
        schedule: {
          timezone: "Asia/Shanghai",
          weekdaysOnly: true,
          slots: ["09:00", "12:00", "15:00", "18:00"],
          nextScheduledAt: nextModelHealthScheduledAt(now).toISOString()
        },
        summary: {
          status: latestRun?.status ?? "unknown",
          latestRunId: latestRun?.id ?? "",
          modelCount: latestRun?.modelCount ?? models.length,
          operationalCount: latestRun?.operationalCount ?? 0,
          degradedCount: latestRun?.degradedCount ?? 0,
          failedCount: latestRun?.failedCount ?? 0,
          averageLatencyMs: completedResults.length === 0 ? 0 : Math.round(
            completedResults.reduce((total, result) => total + result.latencyMs, 0) / completedResults.length
          ),
          uptimePercent: uptimePercent(modelResults, uptimeCutoff),
          uptimeWindowDays: MODEL_HEALTH_UPTIME_WINDOW_DAYS,
          lastCheckedAt: latestRun?.completedAt ?? ""
        },
        runs,
        models
      });
    }
  };
}

export async function beginModelHealthRun(db: D1Database, input: {
  id: string;
  scheduledAt: string;
  slotLocal: string;
  startedAt: string;
}) {
  return db.prepare(`
    INSERT INTO model_health_runs (
      id, scheduled_at, slot_local, timezone, status, started_at
    ) VALUES (?, ?, ?, 'Asia/Shanghai', 'running', ?)
    ON CONFLICT(id) DO UPDATE SET
      status = 'running',
      started_at = excluded.started_at,
      completed_at = NULL,
      error_code = ''
    WHERE model_health_runs.status = 'error'
       OR (
         model_health_runs.status = 'running'
         AND unixepoch(model_health_runs.started_at) <= unixepoch(excluded.started_at) - 1800
       )
  `).bind(input.id, input.scheduledAt, input.slotLocal, input.startedAt).run();
}

export async function replaceModelHealthResults(db: D1Database, runId: string, results: ModelHealthResultInput[]) {
  await db.prepare("DELETE FROM model_health_results WHERE run_id = ?").bind(runId).run();
  if (results.length === 0) return;
  await db.batch(results.map((result) => db.prepare(`
    INSERT INTO model_health_results (
      run_id, model_id, display_name, vendor_id, status, latency_ms, http_status,
      error_code, request_id, response_excerpt, tested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    runId,
    result.modelId,
    result.displayName,
    result.vendorId,
    result.status,
    result.latencyMs,
    result.httpStatus,
    result.errorCode,
    result.requestId,
    result.responseExcerpt,
    result.testedAt
  )));
}

export async function completeModelHealthRun(db: D1Database, input: {
  id: string;
  status: Exclude<ModelHealthRunStatus, "running" | "error">;
  modelCount: number;
  operationalCount: number;
  degradedCount: number;
  failedCount: number;
  completedAt: string;
}) {
  await db.prepare(`
    UPDATE model_health_runs
    SET status = ?, model_count = ?, operational_count = ?, degraded_count = ?,
        failed_count = ?, completed_at = ?, error_code = ''
    WHERE id = ?
  `).bind(
    input.status,
    input.modelCount,
    input.operationalCount,
    input.degradedCount,
    input.failedCount,
    input.completedAt,
    input.id
  ).run();
}

export async function failModelHealthRun(db: D1Database, input: { id: string; completedAt: string; errorCode: string }) {
  await db.prepare(`
    UPDATE model_health_runs
    SET status = 'error', completed_at = ?, error_code = ?
    WHERE id = ?
  `).bind(input.completedAt, input.errorCode.slice(0, 120), input.id).run();
}

export async function deleteOldModelHealthRuns(db: D1Database, cutoff: string) {
  await db.prepare("DELETE FROM model_health_runs WHERE scheduled_at < ?").bind(cutoff).run();
}

export function nextModelHealthScheduledAt(now: Date) {
  const localNow = new Date(now.getTime() + 8 * 3_600_000);
  const slots = [9, 12, 15, 18];

  for (let offset = 0; offset <= 8; offset += 1) {
    const localDay = new Date(Date.UTC(
      localNow.getUTCFullYear(),
      localNow.getUTCMonth(),
      localNow.getUTCDate() + offset
    ));
    const weekday = localDay.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    for (const hour of slots) {
      const candidate = new Date(Date.UTC(
        localDay.getUTCFullYear(),
        localDay.getUTCMonth(),
        localDay.getUTCDate(),
        hour - 8
      ));
      if (candidate.getTime() > now.getTime()) return candidate;
    }
  }

  throw new Error("model_health_next_schedule_unavailable");
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function roundPercent(ratio: number) {
  return Math.round(ratio * 10_000) / 100;
}

function uptimePercent(results: Array<{ status: ModelHealthResultStatus; testedAt: string }>, cutoff: number) {
  const recent = results.filter((result) => {
    const testedAt = Date.parse(result.testedAt);
    return Number.isFinite(testedAt) && testedAt >= cutoff;
  });
  return recent.length === 0
    ? 0
    : roundPercent(recent.filter((result) => result.status === "operational").length / recent.length);
}

function toRun(row: ModelHealthRunRow) {
  return {
    id: row.id,
    scheduledAt: row.scheduled_at,
    slotLocal: row.slot_local,
    timezone: row.timezone,
    status: row.status,
    modelCount: row.model_count,
    operationalCount: row.operational_count,
    degradedCount: row.degraded_count,
    failedCount: row.failed_count,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? "",
    errorCode: row.error_code
  };
}

function toResult(row: ModelHealthResultRow) {
  return {
    runId: row.run_id,
    modelId: row.model_id,
    displayName: row.display_name,
    vendorId: row.vendor_id,
    status: row.status,
    latencyMs: row.latency_ms,
    httpStatus: row.http_status,
    errorCode: row.error_code,
    requestId: row.request_id,
    responseExcerpt: row.response_excerpt,
    testedAt: row.tested_at
  };
}
