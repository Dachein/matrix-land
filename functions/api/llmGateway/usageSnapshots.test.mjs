import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeUsageKeyActivityWatermark,
  computeUsageKeysetFingerprint,
  readCumulativeUsageSummary,
  failUsageSnapshotRun,
  publishStagedUsageSnapshot,
  readUsageAnalytics,
  stageUsageDailySnapshotRows,
  stageUsageUsers
} from "./usageSnapshots.ts";

function readDb({ snapshot, run, daily = [], token = [], error } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const statement = {
        bind(...args) {
          calls.push({ args, sql });
          return statement;
        },
        async first() {
          if (error) throw error;
          if (sql.includes("FROM gateway_usage_user_snapshots")) return snapshot ?? null;
          if (sql.includes("FROM gateway_usage_snapshot_runs")) return run ?? null;
          return null;
        },
        async all() {
          if (error) throw error;
          if (sql.includes("GROUP BY usage_date")) return { results: daily };
          if (sql.includes("GROUP BY token_id")) return { results: token };
          return { results: [] };
        }
      };
      return statement;
    }
  };
}

function snapshot(overrides = {}) {
  return {
    status: "ready",
    updatedAt: "2026-07-14T00:00:02.000Z",
    dataThroughDate: "2026-07-13",
    cumulativeTokens: 43_300_000_000,
    peakDailyTokens: 580_000_000,
    monthlyBudgetUsd: 100,
    ...overrides
  };
}

describe("gateway usage snapshot reads", () => {
  it("still serves the persisted total if the new refresh state table has not been migrated yet", async () => {
    const db = {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          async first() {
            if (sql.includes("gateway_usage_summary_refresh_state")) {
              throw new Error("no such table: gateway_usage_summary_refresh_state");
            }
            return {
              cumulativeTokens: 1234,
              updatedAt: "2026-07-15T11:00:00.000Z",
              dataThroughAt: "2026-07-15T10:59:00.000Z"
            };
          }
        };
        return statement;
      }
    };

    assert.deepEqual(await readCumulativeUsageSummary(db, "ada@example.com"), {
      hasSnapshot: true,
      cumulativeTokens: 1234,
      updatedAt: "2026-07-15T11:00:00.000Z",
      dataThroughAt: "2026-07-15T10:59:00.000Z"
    });
  });

  it("returns a safe pending zero contract without D1 or before migration", async () => {
    const missingDb = await readUsageAnalytics(undefined, "ada@example.com");
    assert.equal(missingDb.status, "pending");
    assert.deepEqual(missingDb.summary, {
      cumulativeTokens: 0,
      peakDailyTokens: 0,
      currentMonthSpendUsd: 0,
      monthlyBudgetUsd: 0
    });

    const missingTable = await readUsageAnalytics(readDb({
      error: new Error("D1_ERROR: no such table: gateway_usage_user_snapshots")
    }), "ada@example.com");
    assert.equal(missingTable.status, "pending");
  });

  it("uses the read-time Shanghai month, so August 1 excludes a July 31 snapshot", async () => {
    const db = readDb({
      snapshot: snapshot({
        updatedAt: "2026-07-31T16:00:02.000Z",
        dataThroughDate: "2026-07-31"
      }),
      run: { status: "ready", startedAt: "2026-07-31T16:00:00.000Z" },
      daily: [{ date: "2026-07-31", tokens: 80, requests: 2, estimatedCostUsd: 0.4 }],
      token: [{ tokenId: "old-month", tokens: 80, requests: 2, estimatedCostUsd: 0.4 }]
    });

    const analytics = await readUsageAnalytics(
      db,
      "ADA@EXAMPLE.COM",
      new Date("2026-07-31T16:00:01.000Z")
    );

    assert.equal(analytics.status, "ready");
    assert.equal(analytics.dataThroughDate, "2026-07-31");
    assert.equal(analytics.summary.currentMonthSpendUsd, 0);
    assert.deepEqual(analytics.tokenUsage, []);
    assert.equal(analytics.dailyUsage[0].date, "2026-07-31");
    assert.equal(db.calls.some((call) => call.sql.includes("GROUP BY token_id")), false);
  });

  it("returns current-month per-token distribution from the last completed snapshot", async () => {
    const db = readDb({
      snapshot: snapshot(),
      run: { status: "ready", startedAt: "2026-07-13T16:00:00.000Z" },
      daily: [{ date: "2026-07-13", tokens: 300, requests: 3, estimatedCostUsd: 1.25 }],
      token: [
        { tokenId: "hash-a", tokens: 200, requests: 2, estimatedCostUsd: 1 },
        { tokenId: "hash-b", tokens: 100, requests: 1, estimatedCostUsd: 0.25 }
      ]
    });

    const analytics = await readUsageAnalytics(db, "ada@example.com", new Date("2026-07-14T04:00:00.000Z"));

    assert.equal(analytics.summary.currentMonthSpendUsd, 1.25);
    assert.deepEqual(analytics.tokenUsage.map((row) => row.tokenId), ["hash-a", "hash-b"]);
    assert.equal(analytics.summary.cumulativeTokens, 43_300_000_000);
    assert.equal(analytics.summary.peakDailyTokens, 580_000_000);
  });

  it("returns persisted per-user refresh metadata and scopes the latest run lookup", async () => {
    const db = readDb({
      snapshot: snapshot({
        dataThroughAt: "2026-07-13T15:59:00.000Z",
        lastCheckedAt: "2026-07-13T16:00:02.000Z",
        activityWatermarkAt: "2026-07-13T15:58:00.000Z",
        lastReconciledAt: "2026-07-13T16:00:02.000Z",
        triggerType: "reconcile"
      }),
      run: { status: "ready", startedAt: "2026-07-13T16:00:00.000Z" }
    });

    const analytics = await readUsageAnalytics(
      db,
      "ADA@EXAMPLE.COM",
      new Date("2026-07-14T04:00:00.000Z")
    );

    assert.equal(analytics.source, "snapshot");
    assert.equal(analytics.dataThroughAt, "2026-07-13T15:59:00.000Z");
    assert.equal(analytics.lastCheckedAt, "2026-07-13T16:00:02.000Z");
    assert.equal(analytics.activityWatermarkAt, "2026-07-13T15:58:00.000Z");
    assert.equal(analytics.lastReconciledAt, "2026-07-13T16:00:02.000Z");
    assert.equal(analytics.triggerType, "reconcile");
    const runLookup = db.calls.find((call) => call.sql.includes("FROM gateway_usage_snapshot_runs"));
    assert.deepEqual(runLookup.args, ["ada@example.com", "ada@example.com"]);
    assert.match(runLookup.sql, /external_user_id = \?/);
  });

  it("keeps the last ready values when a newer nightly run fails", async () => {
    const db = readDb({
      snapshot: snapshot(),
      run: {
        status: "error",
        startedAt: "2026-07-14T16:00:00.000Z",
        completedAt: "2026-07-14T16:00:10.000Z",
        dataThroughDate: "2026-07-14"
      },
      daily: [{ date: "2026-07-13", tokens: 300, requests: 3, estimatedCostUsd: 1.25 }],
      token: [{ tokenId: "hash-a", tokens: 300, requests: 3, estimatedCostUsd: 1.25 }]
    });

    const analytics = await readUsageAnalytics(db, "ada@example.com", new Date("2026-07-15T04:00:00.000Z"));

    assert.equal(analytics.status, "error");
    assert.equal(analytics.updatedAt, "2026-07-14T00:00:02.000Z");
    assert.equal(analytics.dataThroughDate, "2026-07-13");
    assert.equal(analytics.summary.cumulativeTokens, 43_300_000_000);
    assert.equal(analytics.dailyUsage.length, 1);
    assert.equal(analytics.tokenUsage.length, 1);
  });

  it("does not claim a data-through date when the first nightly run fails", async () => {
    const analytics = await readUsageAnalytics(readDb({
      run: {
        status: "error",
        startedAt: "2026-07-14T16:00:00.000Z",
        completedAt: "2026-07-14T16:00:10.000Z",
        dataThroughDate: "2026-07-14"
      }
    }), "ada@example.com", new Date("2026-07-15T04:00:00.000Z"));

    assert.equal(analytics.status, "error");
    assert.equal(analytics.dataThroughDate, undefined);
    assert.equal(analytics.updatedAt, "2026-07-14T16:00:10.000Z");
  });
});

describe("gateway usage key activity", () => {
  it("uses a canonical maximum activity timestamp and a stable SHA-256 keyset", async () => {
    const keys = [
      { id: "hash-b", lastUsedAt: "2026-07-15T09:00:00+08:00" },
      { token_id: "hash-a", last_active: "2026-07-15T02:00:00.000Z" },
      { tokenHash: "hash-a", lastActive: "not-a-date" }
    ];

    assert.equal(
      computeUsageKeyActivityWatermark(keys),
      "2026-07-15T02:00:00.000Z"
    );
    const fingerprint = await computeUsageKeysetFingerprint(keys);
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(
      fingerprint,
      await computeUsageKeysetFingerprint([keys[2], keys[0], keys[1]])
    );
    assert.notEqual(
      fingerprint,
      await computeUsageKeysetFingerprint([{ id: "hash-a" }])
    );
  });
});

describe("gateway usage snapshot writes", () => {
  it("writes source chunks only to run-scoped staging and never touches live tables", async () => {
    const db = writeDb();

    await stageUsageDailySnapshotRows(db, {
      runId: "run-1",
      updatedAt: "2026-07-14T00:00:00.000Z",
      rows: [usageRow("hash-a")]
    });

    assert.deepEqual(db.events.map((event) => event.type), ["batch"]);
    assert.equal(db.events[0].statements.length, 1);
    assert.match(db.events[0].statements[0].sql, /INSERT INTO gateway_usage_daily_snapshot_staging/);
    assert.equal(db.events[0].statements.some((statement) => (
      /gateway_usage_daily_snapshots\b/.test(statement.sql)
      || /gateway_usage_user_snapshots\b/.test(statement.sql)
    )), false);
  });

  it("can chunk a large staging write without introducing any live mutation", async () => {
    const db = writeDb();
    const rows = Array.from({ length: 401 }, (_, index) => usageRow(`hash-${index}`));

    await stageUsageDailySnapshotRows(db, {
      runId: "run-large",
      updatedAt: "2026-07-14T00:00:00.000Z",
      rows
    });

    assert.deepEqual(db.events.map((event) => event.type), ["batch", "batch"]);
    assert.equal(db.events.flatMap((event) => event.statements).every((statement) => (
      /INSERT INTO gateway_usage_daily_snapshot_staging/.test(statement.sql)
    )), true);
  });

  it("publishes range, summaries, ready state, and staging cleanup in one ordered batch", async () => {
    const db = writeDb();
    await stageUsageUsers(db, {
      runId: "run-publish",
      userIds: ["ADA@EXAMPLE.COM", "grace@example.com"],
      monthlyBudgetUsdByUser: new Map([["ada@example.com", 100]])
    });
    db.events.length = 0;

    await publishStagedUsageSnapshot(db, {
      runId: "run-publish",
      fromDate: "2026-07-01",
      toDate: "2026-07-13",
      dataThroughDate: "2026-07-13",
      completedAt: "2026-07-14T00:00:00.000Z",
      sourceRowCount: 10,
      attributedRowCount: 9
    });

    assert.deepEqual(db.events.map((event) => event.type), ["batch"]);
    const statements = db.events[0].statements;
    assert.equal(statements.length, 9);
    assert.match(statements[0].sql, /DELETE FROM gateway_usage_daily_snapshots/);
    assert.match(statements[1].sql, /INSERT INTO gateway_usage_daily_snapshots/);
    assert.match(statements[1].sql, /FROM gateway_usage_daily_snapshot_staging/);
    assert.match(statements[2].sql, /DELETE FROM gateway_usage_daily_model_snapshots/);
    assert.match(statements[3].sql, /INSERT INTO gateway_usage_daily_model_snapshots/);
    assert.match(statements[3].sql, /FROM gateway_usage_daily_model_snapshot_staging/);
    assert.match(statements[4].sql, /INSERT INTO gateway_usage_user_snapshots/);
    assert.match(statements[4].sql, /FROM gateway_usage_user_snapshot_staging/);
    assert.match(statements[4].sql, /SUM\(daily\.tokens\)/);
    assert.match(statements[4].sql, /MAX\(peaks\.day_tokens\)/);
    for (const statement of statements.slice(0, 5)) {
      assert.match(statement.sql, /FROM gateway_usage_snapshot_runs AS publishing_run/);
      assert.match(statement.sql, /publishing_run\.status = 'running'/);
      assert.match(statement.sql, /publishing_run\.source_from_date = \?/);
      assert.match(statement.sql, /publishing_run\.source_to_date = \?/);
      assert.match(statement.sql, /publishing_run\.data_through_date = \?/);
    }
    assert.match(statements[5].sql, /SET status = 'ready'/);
    assert.match(statements[5].sql, /AND source_from_date = \?/);
    assert.match(statements[5].sql, /AND source_to_date = \?/);
    assert.match(statements[5].sql, /AND data_through_date = \?/);
    assert.match(statements[6].sql, /DELETE FROM gateway_usage_daily_snapshot_staging/);
    assert.match(statements[7].sql, /DELETE FROM gateway_usage_daily_model_snapshot_staging/);
    assert.match(statements[8].sql, /DELETE FROM gateway_usage_user_snapshot_staging/);
  });

  it("cannot expose a partial publish when the atomic D1 batch fails", async () => {
    const db = writeDb({ failBatch: true });

    await assert.rejects(publishStagedUsageSnapshot(db, {
      runId: "run-failed-publish",
      fromDate: "2026-07-01",
      toDate: "2026-07-13",
      dataThroughDate: "2026-07-13",
      completedAt: "2026-07-14T00:00:00.000Z",
      sourceRowCount: 10,
      attributedRowCount: 9
    }), /simulated_atomic_batch_failure/);

    assert.equal(db.events.length, 1);
    assert.equal(db.events[0].type, "batch");
    assert.equal(db.events[0].statements.length, 9);
    assert.equal(db.committedBatches.length, 0);
  });

  it("cleans failed-run staging and marks the run error without mutating live snapshots", async () => {
    const db = writeDb();

    await failUsageSnapshotRun(db, {
      id: "run-error",
      completedAt: "2026-07-14T00:00:00.000Z",
      errorCode: "source_fetch_failed",
      sourceRowCount: 3,
      attributedRowCount: 2
    });

    assert.deepEqual(db.events.map((event) => event.type), ["batch"]);
    const statements = db.events[0].statements;
    assert.equal(statements.length, 4);
    assert.match(statements[0].sql, /DELETE FROM gateway_usage_daily_snapshot_staging/);
    assert.match(statements[1].sql, /DELETE FROM gateway_usage_daily_model_snapshot_staging/);
    assert.match(statements[2].sql, /DELETE FROM gateway_usage_user_snapshot_staging/);
    assert.match(statements[3].sql, /SET status = 'error'/);
    assert.equal(statements.some((statement) => (
      /(?:DELETE FROM|INSERT INTO|UPDATE) gateway_usage_(?:daily|user)_snapshots\b/.test(statement.sql)
    )), false);
  });
});

function usageRow(tokenId) {
  return {
    date: "2026-07-13",
    externalUserId: "ada@example.com",
    tokenId,
    requests: 1,
    inputTokens: 8,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    tokens: 10,
    estimatedCostUsd: 0.01
  };
}

function writeDb({ failBatch = false } = {}) {
  const events = [];
  const committedBatches = [];
  return {
    events,
    committedBatches,
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          statement.args = args;
          return statement;
        },
        async run() {
          events.push({ type: "run", statement });
          return {};
        }
      };
      return statement;
    },
    async batch(statements) {
      events.push({ type: "batch", statements });
      if (failBatch) {
        throw new Error("simulated_atomic_batch_failure");
      }
      committedBatches.push(statements);
      return statements.map(() => ({}));
    }
  };
}
