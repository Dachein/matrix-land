import {
  addIsoDateDays,
  beginUsageSnapshotRun,
  failUsageSnapshotRun,
  listKnownUsageUserIds,
  publishStagedUsageSnapshot,
  readLatestReadyUsageDate,
  stageUsageDailySnapshotRows,
  stageUsageDailyModelSnapshotRows,
  stageUsageUsers
} from "../../../../functions/api/llmGateway/usageSnapshots.ts";
import { createLiteLlmSnapshotClient } from "./usageClient.ts";
import {
  createLiteLlmSpendAccumulator,
  chunkIsoDateRange,
  configuredHistoryStartDate,
  configuredPositiveInteger,
  errorCode,
  usageRollupWindow
} from "./usageAggregation.ts";
import type { Env } from "../types.ts";

type RollupDependencies = {
  fetch?: typeof fetch;
  clock?: () => Date;
  randomUUID?: () => string;
};

export async function runTokenUsageRollup(
  env: Env,
  scheduledAt: Date,
  dependencies: RollupDependencies = {}
) {
  const clock = dependencies.clock ?? (() => new Date());
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  const { dataThroughDate } = usageRollupWindow(scheduledAt);
  const latestReadyDate = await readLatestReadyUsageDate(env.DB);
  const lookbackDays = configuredPositiveInteger(env.USAGE_REFRESH_LOOKBACK_DAYS, 7, 31);
  const historyStartDate = configuredHistoryStartDate(env.USAGE_HISTORY_START_DATE);
  const sourceFromDate = latestReadyDate
    ? maxIsoDate(historyStartDate, addIsoDateDays(latestReadyDate, -(lookbackDays - 1)))
    : historyStartDate;

  if (sourceFromDate > dataThroughDate) {
    throw new Error("usage_history_start_after_data_through");
  }

  const runId = randomUUID();
  const startedAt = clock().toISOString();
  let sourceRowCount = 0;
  let attributedRowCount = 0;
  let runStarted = false;

  try {
    await beginUsageSnapshotRun(env.DB, {
      id: runId,
      sourceFromDate,
      sourceToDate: dataThroughDate,
      dataThroughDate,
      startedAt
    });
    runStarted = true;

    const client = createLiteLlmSnapshotClient(env, dependencies.fetch);
    const [monthlyBudgetUsdByUser, tokenUserIds, existingUserIds] = await Promise.all([
      client.listUserBudgets(),
      client.listTokenUsers(),
      listKnownUsageUserIds(env.DB)
    ]);
    const userIds = new Set<string>([
      ...existingUserIds,
      ...monthlyBudgetUsdByUser.keys(),
      ...tokenUserIds.values()
    ]);
    // A completed Shanghai day is the unit of collection and publication.
    // Pages are folded into one small accumulator, so raw LiteLLM rows never
    // build up across multiple days in Worker memory.
    for (const chunk of chunkIsoDateRange(sourceFromDate, dataThroughDate, 1)) {
      const accumulator = createLiteLlmSpendAccumulator(
        tokenUserIds,
        chunk.fromDate,
        chunk.toDate
      );
      for await (const page of client.spendLogPages(chunk.fromDate, chunk.toDate)) {
        accumulator.add(page);
      }
      const aggregated = accumulator.result();
      const updatedAt = clock().toISOString();

      await stageUsageDailySnapshotRows(env.DB, {
        runId,
        updatedAt,
        rows: aggregated.rows
      });
      await stageUsageDailyModelSnapshotRows(env.DB, {
        runId,
        updatedAt,
        rows: aggregated.modelRows
      });
      aggregated.userIds.forEach((userId) => userIds.add(userId));
      sourceRowCount += aggregated.sourceRowCount;
      attributedRowCount += aggregated.attributedRowCount;

      if (aggregated.unattributedRowCount > 0) {
        console.warn("token_usage_rollup_unattributed_rows", {
          fromDate: chunk.fromDate,
          toDate: chunk.toDate,
          count: aggregated.unattributedRowCount
        });
      }
    }

    const completedAt = clock().toISOString();
    await stageUsageUsers(env.DB, {
      runId,
      userIds,
      monthlyBudgetUsdByUser
    });
    await publishStagedUsageSnapshot(env.DB, {
      runId,
      fromDate: sourceFromDate,
      toDate: dataThroughDate,
      dataThroughDate,
      completedAt,
      sourceRowCount,
      attributedRowCount
    });

    return {
      runId,
      sourceFromDate,
      dataThroughDate,
      sourceRowCount,
      attributedRowCount,
      userCount: userIds.size
    };
  } catch (error) {
    if (runStarted) {
      await failUsageRollupAndRethrow(
        env.DB,
        {
          id: runId,
          completedAt: clock().toISOString(),
          errorCode: errorCode(error),
          sourceRowCount,
          attributedRowCount
        },
        error
      );
    }
    throw error;
  }
}

export async function failUsageRollupAndRethrow(
  db: D1Database,
  input: Parameters<typeof failUsageSnapshotRun>[1],
  originalError: unknown
): Promise<never> {
  try {
    await failUsageSnapshotRun(db, input);
  } catch (cleanupError) {
    console.error("token_usage_rollup_error_record_failed", {
      error: errorCode(cleanupError),
      runId: input.id
    });
  }
  throw originalError;
}



function maxIsoDate(left: string, right: string) {
  return left >= right ? left : right;
}
