import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateUserSpendLogs,
  evaluateUsageRefreshNeed,
  refreshUsageForUser,
  usageRefreshActivityForKeys,
  usageRefreshSourceFromDate
} from "./usageRefresh.ts";

const pendingAnalytics = {
  timezone: "Asia/Shanghai",
  source: "snapshot",
  status: "pending",
  summary: {
    cumulativeTokens: 0,
    peakDailyTokens: 0,
    currentMonthSpendUsd: 0,
    monthlyBudgetUsd: 0
  },
  dailyUsage: [],
  tokenUsage: []
};

describe("per-user usage refresh orchestration", () => {
  it("collects, stages, publishes, and returns the committed user snapshot", async () => {
    const events = [];
    const committedAnalytics = {
      ...pendingAnalytics,
      status: "ready",
      updatedAt: "2026-07-15T10:00:05.000Z",
      dataThroughDate: "2026-07-15",
      dataThroughAt: "2026-07-15T10:00:00.000Z",
      triggerType: "manual",
      summary: {
        cumulativeTokens: 30,
        peakDailyTokens: 20,
        currentMonthSpendUsd: 0.03,
        monthlyBudgetUsd: 100
      },
      dailyUsage: [],
      tokenUsage: []
    };
    let reads = 0;

    const result = await refreshUsageForUser({
      db: {},
      externalUserId: "ADA@EXAMPLE.COM",
      historyStartDate: "2026-07-13",
      keys: [{ id: "hash-1", lastUsedAt: "2026-07-15T09:00:00.000Z" }],
      monthlyBudgetUsd: 100,
      now: new Date("2026-07-15T10:00:00.000Z"),
      triggerType: "manual",
      async fetchSpendLogs(range) {
        events.push(["fetch", range]);
        return {
          endpoints: ["/spend/logs/v2?page=1"],
          logs: [
            { request_id: "r1", api_key: "hash-1", user: "ada@example.com", startTime: "2026-07-14T01:00:00.000Z", total_tokens: 10, spend: 0.01 },
            { request_id: "r1", api_key: "hash-1", user: "ada@example.com", startTime: "2026-07-14T01:00:00.000Z", total_tokens: 10, spend: 0.01 },
            { request_id: "r2", api_key: "hash-1", user: "ada@example.com", startTime: "2026-07-15T09:00:00.000Z", prompt_tokens: 8, completion_tokens: 12, spend: 0.02 },
            { request_id: "future", api_key: "hash-1", user: "ada@example.com", startTime: "2026-07-15T10:01:00.000Z", total_tokens: 999, spend: 9.99 },
            { request_id: "other", api_key: "other-hash", user: "other@example.com", startTime: "2026-07-15T09:00:00.000Z", total_tokens: 999, spend: 9.99 }
          ]
        };
      }
    }, {
      async beginRun(_db, input) {
        events.push(["begin", input]);
        return true;
      },
      clock: () => new Date("2026-07-15T10:00:05.000Z"),
      fingerprint: async () => "fingerprint-1",
      randomUUID: () => "run-1",
      async readAnalytics() {
        reads += 1;
        return reads === 1 ? pendingAnalytics : committedAnalytics;
      },
      async stageRows(_db, input) {
        events.push(["rows", input]);
      },
      async stageUsers(_db, input) {
        events.push(["users", input]);
      },
      async publish(_db, input) {
        events.push(["publish", input]);
        return true;
      },
      watermark: () => "2026-07-15T09:00:00.000Z"
    });

    assert.equal(result.status, "committed");
    assert.equal(result.analytics, committedAnalytics);
    assert.deepEqual(result.endpoints, ["/spend/logs/v2?page=1"]);
    assert.equal(result.sourceFromDate, "2026-07-13");
    assert.equal(result.sourceToDate, "2026-07-15");
    assert.equal(result.sourceRowCount, 5);
    assert.equal(result.attributedRowCount, 2);
    assert.equal(result.unattributedRowCount, 1);

    const begin = events.find(([name]) => name === "begin")[1];
    assert.equal(begin.externalUserId, "ada@example.com");
    assert.equal(begin.dataThroughAt, "2026-07-15T10:00:00.000Z");
    assert.equal(begin.activityWatermarkAt, "2026-07-15T09:00:00.000Z");
    assert.equal(begin.keysetFingerprint, "fingerprint-1");
    const stagedRows = events.find(([name]) => name === "rows")[1].rows;
    assert.deepEqual(stagedRows.map((row) => [row.date, row.tokens, row.requests]), [
      ["2026-07-14", 10, 1],
      ["2026-07-15", 20, 1]
    ]);
    const published = events.find(([name]) => name === "publish")[1];
    assert.equal(published.externalUserId, "ada@example.com");
    assert.equal(published.reconciledAt, "2026-07-15T10:00:05.000Z");
  });

  it("does not fetch spend logs when another refresh owns the user lease", async () => {
    let fetched = false;
    const result = await refreshUsageForUser({
      db: {},
      externalUserId: "ada@example.com",
      keys: [],
      now: new Date("2026-07-15T10:00:00.000Z"),
      triggerType: "scheduled",
      async fetchSpendLogs() {
        fetched = true;
        return { logs: [] };
      }
    }, {
      async beginRun() {
        return false;
      },
      fingerprint: async () => "empty",
      async readAnalytics() {
        return pendingAnalytics;
      },
      watermark: () => undefined
    });

    assert.equal(result.status, "busy");
    assert.equal(fetched, false);
  });

  it("marks the user run failed while preserving the source error", async () => {
    const original = new Error("litellm_down");
    let failure;

    await assert.rejects(() => refreshUsageForUser({
      db: {},
      externalUserId: "ada@example.com",
      keys: [],
      now: new Date("2026-07-15T10:00:00.000Z"),
      triggerType: "scheduled",
      async fetchSpendLogs() {
        throw original;
      }
    }, {
      async beginRun() {
        return true;
      },
      clock: () => new Date("2026-07-15T10:00:05.000Z"),
      async failRun(_db, input) {
        failure = input;
      },
      fingerprint: async () => "empty",
      randomUUID: () => "failed-run",
      async readAnalytics() {
        return pendingAnalytics;
      },
      watermark: () => undefined
    }), (error) => error === original);

    assert.equal(failure.id, "failed-run");
    assert.equal(failure.errorCode, "litellm_down");
  });
});

describe("usage refresh calculations", () => {
  it("recommends refreshes only for missing, changed, active, or stale snapshots", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const currentSnapshot = {
      dataThroughAt: "2026-07-15T10:00:00.000Z",
      keysetFingerprint: "fingerprint-1",
      lastReconciledAt: "2026-07-15T11:00:00.000Z"
    };

    assert.deepEqual(evaluateUsageRefreshNeed({
      snapshot: null,
      activity: { keysetFingerprint: "fingerprint-1" },
      now
    }), { recommended: true, reason: "snapshot_missing" });
    assert.deepEqual(evaluateUsageRefreshNeed({
      snapshot: currentSnapshot,
      activity: { keysetFingerprint: "fingerprint-2" },
      now
    }), { recommended: true, reason: "keyset_changed" });
    assert.deepEqual(evaluateUsageRefreshNeed({
      snapshot: currentSnapshot,
      activity: {
        keysetFingerprint: "fingerprint-1",
        maxLastUsedAt: "2026-07-15T10:00:00.001Z"
      },
      now
    }), { recommended: true, reason: "key_activity" });
    assert.deepEqual(evaluateUsageRefreshNeed({
      snapshot: { ...currentSnapshot, lastReconciledAt: "2026-07-14T12:00:00.000Z" },
      activity: { keysetFingerprint: "fingerprint-1" },
      now
    }), { recommended: true, reason: "reconcile_due" });
    assert.deepEqual(evaluateUsageRefreshNeed({
      snapshot: currentSnapshot,
      activity: {
        keysetFingerprint: "fingerprint-1",
        maxLastUsedAt: "2026-07-15T10:00:00.000Z"
      },
      now
    }), { recommended: false, reason: "current" });
  });

  it("derives a stable keyset fingerprint and the latest key activity", async () => {
    const left = await usageRefreshActivityForKeys([
      { id: "hash-2", lastUsedAt: "2026-07-15T09:00:00.000Z" },
      { id: "hash-1", lastUsedAt: "2026-07-15T10:00:00.000Z" }
    ]);
    const right = await usageRefreshActivityForKeys([
      { id: "hash-1" },
      { id: "hash-2" }
    ]);

    assert.equal(left.keysetFingerprint, right.keysetFingerprint);
    assert.equal(left.maxLastUsedAt, "2026-07-15T10:00:00.000Z");
  });

  it("uses a bounded overlap without crossing the configured history boundary", () => {
    assert.equal(usageRefreshSourceFromDate({
      currentDate: "2026-07-15",
      historyStartDate: "2026-01-01",
      lookbackDays: 7,
      snapshotDate: "2026-07-14"
    }), "2026-07-08");
    assert.equal(usageRefreshSourceFromDate({
      currentDate: "2026-07-15",
      historyStartDate: "2026-07-13",
      lookbackDays: 7,
      snapshotDate: "2026-07-14"
    }), "2026-07-13");
  });

  it("deduplicates and excludes activity after the exact query cutoff", () => {
    const result = aggregateUserSpendLogs({
      dataThroughAt: "2026-07-15T10:00:00.000Z",
      externalUserId: "ada@example.com",
      fromDate: "2026-07-15",
      toDate: "2026-07-15",
      keys: [{ id: "hash-1" }],
      logs: [
        { request_id: "r1", api_key: "hash-1", startTime: "2026-07-15T09:00:00.000Z", total_tokens: 10 },
        { request_id: "r1", api_key: "hash-1", startTime: "2026-07-15T09:00:00.000Z", total_tokens: 10 },
        { request_id: "r2", api_key: "hash-1", startTime: "2026-07-15T10:00:00.001Z", total_tokens: 20 }
      ]
    });

    assert.equal(result.attributedRowCount, 1);
    assert.equal(result.rows[0].tokens, 10);
    assert.equal(result.rows[0].requests, 1);
  });
});
