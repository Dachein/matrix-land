import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  beginUsageSnapshotRun,
  claimCumulativeUsageSummaryRefresh,
  failUsageSnapshotRun,
  publishStagedUsageSnapshot,
  readUsageAnalytics,
  readCumulativeUsageSummary,
  readUsageRefreshStates,
  recordUsageRefreshCheck,
  stageUsageDailyModelSnapshotRows,
  stageUsageDailySnapshotRows,
  stageUsageUsers
} from "./usageSnapshots.ts";
import {
  readAdminUsageLedger,
  readUsageLedgerCoverage,
  readUserUsageModelLedger
} from "./usageLedger.ts";

const baseMigrationSql = readFileSync(
  new URL("../../../db/migrations/20260713_gateway_usage_snapshots.sql", import.meta.url),
  "utf8"
);
const perUserMigrationSql = readFileSync(
  new URL("../../../db/migrations/20260715_gateway_usage_per_user_snapshots.sql", import.meta.url),
  "utf8"
);
const dailyModelLedgerMigrationSql = readFileSync(
  new URL("../../../db/d1-migrations/0010_gateway_daily_model_ledger.sql", import.meta.url),
  "utf8"
);
const usageLedgerQueryIndexesMigrationSql = readFileSync(
  new URL("../../../db/d1-migrations/0011_gateway_usage_ledger_query_indexes.sql", import.meta.url),
  "utf8"
);
const usageSummaryRefreshMigrationSql = readFileSync(
  new URL("../../../db/d1-migrations/0016_gateway_usage_summary_refresh_state.sql", import.meta.url),
  "utf8"
);

function migrate(sqlite) {
  sqlite.exec(baseMigrationSql);
  sqlite.exec(perUserMigrationSql);
  sqlite.exec(dailyModelLedgerMigrationSql);
  sqlite.exec(usageLedgerQueryIndexesMigrationSql);
  sqlite.exec(usageSummaryRefreshMigrationSql);
}

describe("gateway cumulative usage summary cache", () => {
  it("reads the stored total with one narrow snapshot query and atomically claims one refresh per five minutes", async () => {
    const sqlite = new DatabaseSync(":memory:");
    migrate(sqlite);
    sqlite.prepare(`
      INSERT INTO gateway_usage_user_snapshots (
        external_user_id, run_id, status, timezone, updated_at,
        data_through_date, data_through_at, cumulative_tokens, peak_daily_tokens,
        monthly_budget_usd
      ) VALUES (?, ?, 'ready', 'Asia/Shanghai', ?, ?, ?, ?, 0, 0)
    `).run(
      "ada@example.com",
      "snapshot-run",
      "2026-07-15T11:00:00.000Z",
      "2026-07-15",
      "2026-07-15T10:59:00.000Z",
      9_876_543
    );
    const db = sqliteD1(sqlite);

    assert.deepEqual(await readCumulativeUsageSummary(db, "ADA@EXAMPLE.COM"), {
      hasSnapshot: true,
      cumulativeTokens: 9_876_543,
      updatedAt: "2026-07-15T11:00:00.000Z",
      dataThroughAt: "2026-07-15T10:59:00.000Z"
    });

    assert.equal(await claimCumulativeUsageSummaryRefresh(db, {
      externalUserId: "ada@example.com",
      requestedAt: "2026-07-15T12:00:00.000Z",
      staleBefore: "2026-07-15T11:55:00.000Z"
    }), true);
    assert.equal(await claimCumulativeUsageSummaryRefresh(db, {
      externalUserId: "ada@example.com",
      requestedAt: "2026-07-15T12:01:00.000Z",
      staleBefore: "2026-07-15T11:56:00.000Z"
    }), false);
    assert.equal(await claimCumulativeUsageSummaryRefresh(db, {
      externalUserId: "ada@example.com",
      requestedAt: "2026-07-15T12:06:00.000Z",
      staleBefore: "2026-07-15T12:01:00.000Z"
    }), true);
    assert.deepEqual(await readCumulativeUsageSummary(db, "ada@example.com"), {
      hasSnapshot: true,
      cumulativeTokens: 9_876_543,
      updatedAt: "2026-07-15T11:00:00.000Z",
      dataThroughAt: "2026-07-15T10:59:00.000Z",
      lastRefreshRequestedAt: "2026-07-15T12:06:00.000Z"
    });
    sqlite.close();
  });
});

describe("gateway usage daily ledger reads", () => {
  it("reads user/token history and admin aggregates from closed D1 rows", async () => {
    const sqlite = new DatabaseSync(":memory:");
    migrate(sqlite);
    sqlite.prepare(`
      INSERT INTO gateway_usage_snapshot_runs (
        id, status, timezone, source_from_date, source_to_date,
        data_through_date, started_at, completed_at
      ) VALUES ('global-ready', 'ready', 'Asia/Shanghai', '2026-07-13',
        '2026-07-14', '2026-07-14', '2026-07-14T16:00:00.000Z',
        '2026-07-14T16:01:00.000Z')
    `).run();
    const insert = sqlite.prepare(`
      INSERT INTO gateway_usage_daily_model_snapshots (
        usage_date, external_user_id, token_id, model_group,
        upstream_model, provider, requests, input_tokens,
        cache_read_input_tokens, cache_write_input_tokens, output_tokens,
        reasoning_output_tokens, tokens, billed_cost_usd, run_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'global-ready', ?)
    `);
    insert.run("2026-07-13", "ivy.lin@example.com", "hash-a", "tencent-glm-5.3", "openai/glm-5.3", "openai", 2, 100, 40, 5, 20, 0, 120, 0.2, "2026-07-14T16:01:00.000Z");
    insert.run("2026-07-14", "ivy.lin@example.com", "hash-b", "tencent-glm-5.3", "openai/glm-5.3", "openai", 3, 200, 160, 0, 50, 10, 250, 0.3, "2026-07-14T16:01:00.000Z");
    insert.run("2026-07-14", "ada@example.com", "hash-c", "gpt-5.5", "openai/gpt-5.5", "openai", 1, 50, 0, 0, 10, 0, 60, 0.1, "2026-07-14T16:01:00.000Z");
    const db = sqliteD1(sqlite);

    assert.deepEqual(await readUsageLedgerCoverage(db), {
      available: true,
      dataThroughDate: "2026-07-14"
    });

    const ivy = await readUserUsageModelLedger(db, {
      externalUserId: "ivy.lin@example.com",
      tokenId: "hash-b",
      fromDate: "2026-07-13",
      toDate: "2026-07-14"
    });
    assert.equal(ivy.available, true);
    assert.equal(ivy.models.length, 1);
    assert.equal(ivy.models[0].requests, 3);
    assert.equal(ivy.models[0].cacheReadTokens, 160);
    assert.equal(ivy.models[0].cacheRate, 0.8);
    assert.equal(ivy.models[0].estimatedCostUsd, 0.3);

    const admin = await readAdminUsageLedger(db, {
      fromDate: "2026-07-13",
      toDate: "2026-07-14",
      groupBy: "model"
    });
    assert.equal(admin.available, true);
    assert.equal(admin.requestTotal, 6);
    assert.equal(admin.usage.find((row) => row.scopeType === "user" && row.scopeId === "ivy.lin@example.com").requests, 5);
    assert.equal(admin.usage.find((row) => row.scopeType === "provider" && row.scopeId === "tencent-tokenhub-intl").requests, 5);
    assert.equal(admin.series.find((row) => row.groupId === "tencent-glm-5.3" && row.periodStart.startsWith("2026-07-14")).cachedInputTokens, 160);

    const plan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT model_group, SUM(tokens)
      FROM gateway_usage_daily_model_snapshots
      WHERE external_user_id = ? AND token_id = ?
        AND usage_date >= ? AND usage_date <= ?
      GROUP BY model_group
    `).all("ivy.lin@example.com", "hash-b", "2026-07-13", "2026-07-14");
    assert.match(plan.map((row) => row.detail).join("\n"), /idx_gateway_usage_daily_model_user_token_date/);
    sqlite.close();
  });
});

describe("gateway usage per-user migration", () => {
  it("converts a completed Shanghai date to the correct UTC end-of-day watermark", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(baseMigrationSql);
    sqlite.prepare(`
      INSERT INTO gateway_usage_snapshot_runs (
        id, status, timezone, source_from_date, source_to_date,
        data_through_date, started_at, completed_at
      ) VALUES ('legacy-run', 'ready', 'Asia/Shanghai', '2026-07-14',
        '2026-07-14', '2026-07-14', '2026-07-14T16:00:00.000Z',
        '2026-07-14T16:01:00.000Z')
    `).run();
    sqlite.prepare(`
      INSERT INTO gateway_usage_user_snapshots (
        external_user_id, run_id, status, timezone, updated_at,
        data_through_date, cumulative_tokens, peak_daily_tokens, monthly_budget_usd
      ) VALUES ('ada@example.com', 'legacy-run', 'ready', 'Asia/Shanghai',
        '2026-07-14T16:01:00.000Z', '2026-07-14', 1, 1, 100)
    `).run();

    sqlite.exec(perUserMigrationSql);

    assert.equal(sqlite.prepare(`
      SELECT data_through_at AS dataThroughAt
      FROM gateway_usage_snapshot_runs WHERE id = 'legacy-run'
    `).get().dataThroughAt, "2026-07-14T15:59:59.999Z");
    assert.equal(sqlite.prepare(`
      SELECT data_through_at AS dataThroughAt
      FROM gateway_usage_user_snapshots WHERE external_user_id = 'ada@example.com'
    `).get().dataThroughAt, "2026-07-14T15:59:59.999Z");
    sqlite.close();
  });
});

describe("gateway usage snapshot SQLite publication", () => {
  it("rolls back live range and summaries together when publication fails mid-batch", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    migrate(sqlite);
    seedReadySnapshot(sqlite);
    const db = sqliteD1(sqlite);

    await beginUsageSnapshotRun(db, {
      id: "new-run",
      sourceFromDate: "2026-07-13",
      sourceToDate: "2026-07-13",
      dataThroughDate: "2026-07-13",
      startedAt: "2026-07-13T16:00:00.000Z"
    });
    await stageUsageDailySnapshotRows(db, {
      runId: "new-run",
      updatedAt: "2026-07-13T16:00:05.000Z",
      rows: [{
        date: "2026-07-13",
        externalUserId: "ada@example.com",
        tokenId: "hash-a",
        requests: 2,
        inputTokens: 20,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        tokens: 25,
        estimatedCostUsd: 0.25
      }]
    });
    await stageUsageDailyModelSnapshotRows(db, {
      runId: "new-run",
      updatedAt: "2026-07-13T16:00:05.000Z",
      rows: [modelUsageRow("ada@example.com", "hash-a", "tencent-glm-5.3", 0.25)]
    });
    await stageUsageUsers(db, {
      runId: "new-run",
      userIds: ["ada@example.com"],
      monthlyBudgetUsdByUser: new Map([["ada@example.com", 250]])
    });

    db.failBatchAfterStatement = 2;
    await assert.rejects(publish(db), /simulated_mid_batch_failure/);

    assert.deepEqual(liveDaily(sqlite), { tokens: 10, runId: "old-run" });
    assert.deepEqual(userSnapshot(sqlite), {
      runId: "old-run",
      cumulativeTokens: 10,
      peakDailyTokens: 10,
      monthlyBudgetUsd: 100
    });
    assert.equal(runStatus(sqlite, "new-run"), "running");
    assert.equal(stagingCount(sqlite), 3);

    db.failBatchAfterStatement = undefined;
    await publish(db);

    assert.deepEqual(liveDaily(sqlite), { tokens: 25, runId: "new-run" });
    assert.deepEqual(liveDailyModel(sqlite), {
      modelGroup: "tencent-glm-5.3",
      billedCostUsd: 0.25,
      runId: "new-run"
    });
    assert.deepEqual(userSnapshot(sqlite), {
      runId: "new-run",
      cumulativeTokens: 25,
      peakDailyTokens: 25,
      monthlyBudgetUsd: 250
    });
    assert.equal(runStatus(sqlite, "new-run"), "ready");
    assert.equal(stagingCount(sqlite), 0);

    // A delivery retry after the run is already ready must be a live-data
    // no-op even though the same source range is supplied again.
    await publish(db);
    assert.deepEqual(liveDaily(sqlite), { tokens: 25, runId: "new-run" });
    assert.deepEqual(userSnapshot(sqlite), {
      runId: "new-run",
      cumulativeTokens: 25,
      peakDailyTokens: 25,
      monthlyBudgetUsd: 250
    });
    assert.equal(runStatus(sqlite, "new-run"), "ready");
    sqlite.close();

    function publish(database) {
      return publishStagedUsageSnapshot(database, {
        runId: "new-run",
        fromDate: "2026-07-13",
        toDate: "2026-07-13",
        dataThroughDate: "2026-07-13",
        completedAt: "2026-07-13T16:00:10.000Z",
        sourceRowCount: 2,
        attributedRowCount: 2
      });
    }
  });

  it("acquires one user refresh at a time and expires an abandoned lease", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    migrate(sqlite);
    const db = sqliteD1(sqlite);

    assert.equal(await beginUserRun(db, "run-1", "2026-07-15T10:00:00.000Z"), true);
    assert.equal(await beginUserRun(db, "run-2", "2026-07-15T10:05:00.000Z"), false);
    assert.equal(runStatus(sqlite, "run-1"), "running");
    assert.equal(runExists(sqlite, "run-2"), false);

    assert.equal(await beginUserRun(db, "run-3", "2026-07-15T10:11:00.000Z"), true);
    assert.equal(runStatus(sqlite, "run-1"), "error");
    assert.equal(runError(sqlite, "run-1"), "usage_snapshot_lease_expired");
    assert.equal(runStatus(sqlite, "run-3"), "running");
    sqlite.close();
  });

  it("publishes and reads one canonical user snapshot without touching another user", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    migrate(sqlite);
    seedPerUserSnapshot(sqlite, {
      userId: "ada@example.com",
      runId: "ada-old",
      tokens: 10,
      dataThroughAt: "2026-07-15T09:00:00.000Z"
    });
    seedPerUserSnapshot(sqlite, {
      userId: "grace@example.com",
      runId: "grace-old",
      tokens: 50,
      dataThroughAt: "2026-07-15T09:00:00.000Z"
    });
    const db = sqliteD1(sqlite);
    const fingerprint = "a".repeat(64);

    assert.equal(await beginUsageSnapshotRun(db, {
      id: "ada-new",
      externalUserId: "ada@example.com",
      triggerType: "manual",
      sourceFromDate: "2026-07-15",
      sourceToDate: "2026-07-15",
      dataThroughDate: "2026-07-15",
      dataThroughAt: "2026-07-15T10:00:00.000Z",
      activityWatermarkAt: "2026-07-15T09:59:00.000Z",
      keysetFingerprint: fingerprint,
      startedAt: "2026-07-15T10:00:01.000Z"
    }), true);
    await stageUsageDailySnapshotRows(db, {
      runId: "ada-new",
      updatedAt: "2026-07-15T10:00:05.000Z",
      rows: [
        userUsageRow("ada@example.com", "hash-a", 25),
        userUsageRow("grace@example.com", "hash-g", 999)
      ]
    });
    await stageUsageUsers(db, {
      runId: "ada-new",
      userIds: ["ada@example.com", "grace@example.com"],
      monthlyBudgetUsdByUser: new Map([
        ["ada@example.com", 250],
        ["grace@example.com", 999]
      ])
    });

    const publishAda = () => publishStagedUsageSnapshot(db, {
      runId: "ada-new",
      externalUserId: "ada@example.com",
      triggerType: "manual",
      fromDate: "2026-07-15",
      toDate: "2026-07-15",
      dataThroughDate: "2026-07-15",
      dataThroughAt: "2026-07-15T10:00:00.000Z",
      completedAt: "2026-07-15T10:00:10.000Z",
      sourceRowCount: 2,
      attributedRowCount: 1,
      activityWatermarkAt: "2026-07-15T09:59:00.000Z",
      keysetFingerprint: fingerprint
    });

    db.failBatchAfterStatement = 2;
    await assert.rejects(publishAda(), /simulated_mid_batch_failure/);
    assert.deepEqual(liveDailyFor(sqlite, "ada@example.com"), {
      tokens: 10,
      runId: "ada-old"
    });
    assert.deepEqual(liveDailyFor(sqlite, "grace@example.com"), {
      tokens: 50,
      runId: "grace-old"
    });
    assert.equal(userSnapshotDetails(sqlite, "ada@example.com").runId, "ada-old");
    assert.equal(runStatus(sqlite, "ada-new"), "running");

    db.failBatchAfterStatement = undefined;
    assert.equal(await publishAda(), true);

    assert.deepEqual(liveDailyFor(sqlite, "ada@example.com"), {
      tokens: 25,
      runId: "ada-new"
    });
    assert.deepEqual(liveDailyFor(sqlite, "grace@example.com"), {
      tokens: 50,
      runId: "grace-old"
    });
    assert.deepEqual(userSnapshotDetails(sqlite, "ada@example.com"), {
      runId: "ada-new",
      dataThroughAt: "2026-07-15T10:00:00.000Z",
      lastCheckedAt: "2026-07-15T10:00:10.000Z",
      activityWatermarkAt: "2026-07-15T09:59:00.000Z",
      lastReconciledAt: "2026-07-15T09:00:00.000Z",
      keysetFingerprint: fingerprint,
      triggerType: "manual",
      cumulativeTokens: 25,
      monthlyBudgetUsd: 250
    });

    const analytics = await readUsageAnalytics(
      db,
      "ADA@EXAMPLE.COM",
      new Date("2026-07-15T10:01:00.000Z")
    );
    assert.equal(analytics.source, "snapshot");
    assert.equal(analytics.status, "ready");
    assert.equal(analytics.dataThroughAt, "2026-07-15T10:00:00.000Z");
    assert.equal(analytics.lastCheckedAt, "2026-07-15T10:00:10.000Z");
    assert.equal(analytics.activityWatermarkAt, "2026-07-15T09:59:00.000Z");
    assert.equal(analytics.triggerType, "manual");
    assert.equal(analytics.summary.cumulativeTokens, 25);

    const states = await readUsageRefreshStates(db, ["ada@example.com", "missing@example.com"]);
    assert.equal(states.size, 1);
    assert.equal(states.get("ada@example.com")?.keysetFingerprint, fingerprint);
    assert.equal(await recordUsageRefreshCheck(db, {
      externalUserId: "ada@example.com",
      checkedAt: "2026-07-15T11:00:00.000Z",
      activityWatermarkAt: "2026-07-15T09:59:00.000Z",
      keysetFingerprint: fingerprint,
      expectedRunId: "ada-new"
    }), true);
    assert.equal(await recordUsageRefreshCheck(db, {
      externalUserId: "ada@example.com",
      checkedAt: "2026-07-15T12:00:00.000Z",
      expectedRunId: "wrong-run"
    }), false);
    assert.equal(
      userSnapshotDetails(sqlite, "ada@example.com").lastCheckedAt,
      "2026-07-15T11:00:00.000Z"
    );

    await beginUsageSnapshotRun(db, {
      id: "ada-failed",
      externalUserId: "ada@example.com",
      triggerType: "scheduled",
      sourceFromDate: "2026-07-15",
      sourceToDate: "2026-07-15",
      dataThroughDate: "2026-07-15",
      dataThroughAt: "2026-07-15T12:00:00.000Z",
      startedAt: "2026-07-15T12:00:01.000Z"
    });
    await failUsageSnapshotRun(db, {
      id: "ada-failed",
      completedAt: "2026-07-15T12:00:02.000Z",
      errorCode: "upstream_failed"
    });
    const afterFailure = await readUsageAnalytics(
      db,
      "ada@example.com",
      new Date("2026-07-15T12:01:00.000Z")
    );
    assert.equal(afterFailure.status, "error");
    assert.equal(afterFailure.summary.cumulativeTokens, 25);
    assert.equal(afterFailure.dataThroughAt, "2026-07-15T10:00:00.000Z");
    sqlite.close();
  });

  it("rejects a user publication whose data watermark is older than the committed snapshot", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    migrate(sqlite);
    seedPerUserSnapshot(sqlite, {
      userId: "ada@example.com",
      runId: "current-run",
      tokens: 40,
      dataThroughAt: "2026-07-15T12:00:00.000Z"
    });
    const db = sqliteD1(sqlite);

    assert.equal(await beginUsageSnapshotRun(db, {
      id: "stale-run",
      externalUserId: "ada@example.com",
      triggerType: "scheduled",
      sourceFromDate: "2026-07-15",
      sourceToDate: "2026-07-15",
      dataThroughDate: "2026-07-15",
      dataThroughAt: "2026-07-15T11:00:00.000Z",
      startedAt: "2026-07-15T12:30:00.000Z"
    }), true);
    await stageUsageDailySnapshotRows(db, {
      runId: "stale-run",
      updatedAt: "2026-07-15T12:30:01.000Z",
      rows: [userUsageRow("ada@example.com", "hash-a", 5)]
    });
    await stageUsageUsers(db, {
      runId: "stale-run",
      userIds: ["ada@example.com"],
      monthlyBudgetUsdByUser: new Map()
    });

    assert.equal(await publishStagedUsageSnapshot(db, {
      runId: "stale-run",
      externalUserId: "ada@example.com",
      fromDate: "2026-07-15",
      toDate: "2026-07-15",
      dataThroughDate: "2026-07-15",
      dataThroughAt: "2026-07-15T11:00:00.000Z",
      completedAt: "2026-07-15T12:30:05.000Z",
      sourceRowCount: 1,
      attributedRowCount: 1
    }), false);
    assert.deepEqual(liveDailyFor(sqlite, "ada@example.com"), {
      tokens: 40,
      runId: "current-run"
    });
    assert.equal(userSnapshotDetails(sqlite, "ada@example.com").runId, "current-run");
    assert.equal(runStatus(sqlite, "stale-run"), "error");
    assert.equal(runError(sqlite, "stale-run"), "usage_snapshot_superseded");
    assert.equal(stagingCount(sqlite), 0);
    sqlite.close();
  });

  it("does not mutate live data when the user summary staging row is missing", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    migrate(sqlite);
    seedPerUserSnapshot(sqlite, {
      userId: "ada@example.com",
      runId: "old-run",
      tokens: 40,
      dataThroughAt: "2026-07-15T10:00:00.000Z"
    });
    const db = sqliteD1(sqlite);
    await beginUsageSnapshotRun(db, {
      id: "incomplete-run",
      externalUserId: "ada@example.com",
      sourceFromDate: "2026-07-15",
      sourceToDate: "2026-07-15",
      dataThroughDate: "2026-07-15",
      dataThroughAt: "2026-07-15T11:00:00.000Z",
      startedAt: "2026-07-15T11:00:00.000Z"
    });
    await stageUsageDailySnapshotRows(db, {
      runId: "incomplete-run",
      updatedAt: "2026-07-15T11:00:01.000Z",
      rows: [userUsageRow("ada@example.com", "hash-a", 5)]
    });

    assert.equal(await publishStagedUsageSnapshot(db, {
      runId: "incomplete-run",
      externalUserId: "ada@example.com",
      fromDate: "2026-07-15",
      toDate: "2026-07-15",
      dataThroughDate: "2026-07-15",
      dataThroughAt: "2026-07-15T11:00:00.000Z",
      completedAt: "2026-07-15T11:00:02.000Z",
      sourceRowCount: 1,
      attributedRowCount: 1
    }), false);
    assert.deepEqual(liveDailyFor(sqlite, "ada@example.com"), {
      tokens: 40,
      runId: "old-run"
    });
    assert.equal(userSnapshotDetails(sqlite, "ada@example.com").runId, "old-run");
    assert.equal(runError(sqlite, "incomplete-run"), "usage_snapshot_superseded");
    assert.equal(stagingCount(sqlite), 0);
    sqlite.close();
  });
});

function seedReadySnapshot(sqlite) {
  sqlite.prepare(`
    INSERT INTO gateway_usage_snapshot_runs (
      id, status, timezone, source_from_date, source_to_date,
      data_through_date, started_at, completed_at
    ) VALUES (?, 'ready', 'Asia/Shanghai', ?, ?, ?, ?, ?)
  `).run(
    "old-run",
    "2026-07-13",
    "2026-07-13",
    "2026-07-13",
    "2026-07-12T16:00:00.000Z",
    "2026-07-12T16:00:10.000Z"
  );
  sqlite.prepare(`
    INSERT INTO gateway_usage_daily_snapshots (
      usage_date, external_user_id, token_id, requests, input_tokens,
      output_tokens, reasoning_output_tokens, tokens, estimated_cost_usd,
      run_id, updated_at
    ) VALUES (?, ?, ?, 1, 8, 2, 0, 10, 0.1, ?, ?)
  `).run(
    "2026-07-13",
    "ada@example.com",
    "hash-a",
    "old-run",
    "2026-07-12T16:00:10.000Z"
  );
  sqlite.prepare(`
    INSERT INTO gateway_usage_user_snapshots (
      external_user_id, run_id, status, timezone, updated_at,
      data_through_date, cumulative_tokens, peak_daily_tokens, monthly_budget_usd
    ) VALUES (?, ?, 'ready', 'Asia/Shanghai', ?, ?, 10, 10, 100)
  `).run(
    "ada@example.com",
    "old-run",
    "2026-07-12T16:00:10.000Z",
    "2026-07-13"
  );
}

function seedPerUserSnapshot(sqlite, { userId, runId, tokens, dataThroughAt }) {
  const fingerprint = "0".repeat(64);
  sqlite.prepare(`
    INSERT INTO gateway_usage_snapshot_runs (
      id, status, external_user_id, trigger_type, timezone,
      source_from_date, source_to_date, data_through_date, data_through_at,
      activity_watermark_at, keyset_fingerprint, started_at, completed_at
    ) VALUES (?, 'ready', ?, 'scheduled', 'Asia/Shanghai', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    userId,
    "2026-07-15",
    "2026-07-15",
    "2026-07-15",
    dataThroughAt,
    dataThroughAt,
    fingerprint,
    dataThroughAt,
    dataThroughAt
  );
  sqlite.prepare(`
    INSERT INTO gateway_usage_daily_snapshots (
      usage_date, external_user_id, token_id, requests, input_tokens,
      output_tokens, reasoning_output_tokens, tokens, estimated_cost_usd,
      run_id, updated_at
    ) VALUES (?, ?, ?, 1, ?, 0, 0, ?, 0.1, ?, ?)
  `).run(
    "2026-07-15",
    userId,
    `hash-${userId}`,
    tokens,
    tokens,
    runId,
    dataThroughAt
  );
  sqlite.prepare(`
    INSERT INTO gateway_usage_user_snapshots (
      external_user_id, run_id, status, timezone, updated_at,
      data_through_date, data_through_at, last_checked_at,
      activity_watermark_at, last_reconciled_at, keyset_fingerprint,
      trigger_type, cumulative_tokens, peak_daily_tokens, monthly_budget_usd
    ) VALUES (?, ?, 'ready', 'Asia/Shanghai', ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, 100)
  `).run(
    userId,
    runId,
    dataThroughAt,
    "2026-07-15",
    dataThroughAt,
    dataThroughAt,
    dataThroughAt,
    dataThroughAt,
    fingerprint,
    tokens,
    tokens
  );
}

function beginUserRun(db, id, startedAt) {
  return beginUsageSnapshotRun(db, {
    id,
    externalUserId: "ada@example.com",
    triggerType: "scheduled",
    sourceFromDate: "2026-07-15",
    sourceToDate: "2026-07-15",
    dataThroughDate: "2026-07-15",
    dataThroughAt: startedAt,
    startedAt,
    staleAfterMs: 10 * 60 * 1000
  });
}

function userUsageRow(externalUserId, tokenId, tokens) {
  return {
    date: "2026-07-15",
    externalUserId,
    tokenId,
    requests: 1,
    inputTokens: tokens,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    tokens,
    estimatedCostUsd: tokens / 100
  };
}

function modelUsageRow(externalUserId, tokenId, modelGroup, billedCostUsd) {
  return {
    date: "2026-07-13",
    externalUserId,
    tokenId,
    modelGroup,
    upstreamModel: "openai/glm-5.3",
    provider: "openai",
    requests: 2,
    inputTokens: 20,
    cacheReadInputTokens: 10,
    cacheWriteInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 3,
    tokens: 25,
    inputCostUsd: 0.1,
    outputCostUsd: 0.15,
    cacheReadCostUsd: 0.01,
    cacheWriteCostUsd: 0,
    toolCostUsd: 0,
    originalCostUsd: billedCostUsd,
    discountUsd: 0,
    billedCostUsd
  };
}

function sqliteD1(sqlite) {
  return {
    failBatchAfterStatement: undefined,
    prepare(sql) {
      let args = [];
      const statement = {
        sql,
        bind(...values) {
          args = values;
          return statement;
        },
        async run() {
          return statement.runSync();
        },
        async first() {
          return sqlite.prepare(sql).get(...args) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...args) };
        },
        runSync() {
          if (/^\s*SELECT\b/i.test(sql)) {
            return { results: sqlite.prepare(sql).all(...args) };
          }
          return sqlite.prepare(sql).run(...args);
        }
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (let index = 0; index < statements.length; index += 1) {
          results.push(statements[index].runSync());
          if (this.failBatchAfterStatement === index) {
            throw new Error("simulated_mid_batch_failure");
          }
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function liveDaily(sqlite) {
  const row = sqlite.prepare(`
    SELECT tokens, run_id AS runId
    FROM gateway_usage_daily_snapshots
    WHERE usage_date = '2026-07-13' AND external_user_id = 'ada@example.com'
  `).get();
  return { tokens: row.tokens, runId: row.runId };
}

function liveDailyFor(sqlite, userId) {
  const row = sqlite.prepare(`
    SELECT tokens, run_id AS runId
    FROM gateway_usage_daily_snapshots
    WHERE usage_date = '2026-07-15' AND external_user_id = ?
  `).get(userId);
  return row ? { tokens: row.tokens, runId: row.runId } : undefined;
}

function liveDailyModel(sqlite) {
  const row = sqlite.prepare(`
    SELECT model_group AS modelGroup, billed_cost_usd AS billedCostUsd,
      run_id AS runId
    FROM gateway_usage_daily_model_snapshots
    WHERE usage_date = '2026-07-13' AND external_user_id = 'ada@example.com'
  `).get();
  return row ? { ...row } : undefined;
}

function userSnapshot(sqlite) {
  const row = sqlite.prepare(`
    SELECT
      run_id AS runId,
      cumulative_tokens AS cumulativeTokens,
      peak_daily_tokens AS peakDailyTokens,
      monthly_budget_usd AS monthlyBudgetUsd
    FROM gateway_usage_user_snapshots
    WHERE external_user_id = 'ada@example.com'
  `).get();
  return {
    runId: row.runId,
    cumulativeTokens: row.cumulativeTokens,
    peakDailyTokens: row.peakDailyTokens,
    monthlyBudgetUsd: row.monthlyBudgetUsd
  };
}

function userSnapshotDetails(sqlite, userId) {
  const row = sqlite.prepare(`
    SELECT
      run_id AS runId,
      data_through_at AS dataThroughAt,
      last_checked_at AS lastCheckedAt,
      activity_watermark_at AS activityWatermarkAt,
      last_reconciled_at AS lastReconciledAt,
      keyset_fingerprint AS keysetFingerprint,
      trigger_type AS triggerType,
      cumulative_tokens AS cumulativeTokens,
      monthly_budget_usd AS monthlyBudgetUsd
    FROM gateway_usage_user_snapshots
    WHERE external_user_id = ?
  `).get(userId);
  return row ? { ...row } : undefined;
}

function runStatus(sqlite, runId) {
  return sqlite.prepare(
    "SELECT status FROM gateway_usage_snapshot_runs WHERE id = ?"
  ).get(runId).status;
}

function runExists(sqlite, runId) {
  return Boolean(sqlite.prepare(
    "SELECT id FROM gateway_usage_snapshot_runs WHERE id = ?"
  ).get(runId));
}

function runError(sqlite, runId) {
  return sqlite.prepare(
    "SELECT error_code AS errorCode FROM gateway_usage_snapshot_runs WHERE id = ?"
  ).get(runId).errorCode;
}

function stagingCount(sqlite) {
  const daily = sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gateway_usage_daily_snapshot_staging"
  ).get().count;
  const users = sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gateway_usage_user_snapshot_staging"
  ).get().count;
  const models = sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gateway_usage_daily_model_snapshot_staging"
  ).get().count;
  return daily + models + users;
}
