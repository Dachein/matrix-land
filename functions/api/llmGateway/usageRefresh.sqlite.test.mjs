import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { readUsageAnalytics } from "./usageSnapshots.ts";
import { refreshUsageForUser } from "./usageRefresh.ts";

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

describe("per-user usage refresh SQLite integration", () => {
  it("persists a manual refresh and serves the same canonical snapshot after reload", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec(baseMigrationSql);
    sqlite.exec(perUserMigrationSql);
    sqlite.exec(dailyModelLedgerMigrationSql);
    const db = sqliteD1(sqlite);

    const result = await refreshUsageForUser({
      db,
      externalUserId: "ada@example.com",
      historyStartDate: "2026-07-13",
      keys: [{ id: "hash-1", lastUsedAt: "2026-07-15T09:30:00.000Z" }],
      monthlyBudgetUsd: 100,
      now: new Date("2026-07-15T10:00:00.000Z"),
      triggerType: "manual",
      async fetchSpendLogs() {
        return {
          endpoints: ["/spend/logs/v2?page=1"],
          logs: [
            {
              request_id: "r1",
              api_key: "hash-1",
              user: "ada@example.com",
              startTime: "2026-07-15T09:30:00.000Z",
              prompt_tokens: 12,
              completion_tokens: 8,
              total_tokens: 20,
              spend: 0.02
            }
          ]
        };
      }
    }, {
      clock: () => new Date("2026-07-15T10:00:05.000Z"),
      randomUUID: () => "manual-run-1"
    });

    assert.equal(result.status, "committed");
    assert.deepEqual(result.endpoints, ["/spend/logs/v2?page=1"]);
    assert.equal(result.analytics.source, "snapshot");
    assert.equal(result.analytics.status, "ready");
    assert.equal(result.analytics.updatedAt, "2026-07-15T10:00:05.000Z");
    assert.equal(result.analytics.dataThroughAt, "2026-07-15T10:00:00.000Z");
    assert.equal(result.analytics.lastCheckedAt, "2026-07-15T10:00:05.000Z");
    assert.equal(result.analytics.activityWatermarkAt, "2026-07-15T09:30:00.000Z");
    assert.equal(result.analytics.lastReconciledAt, "2026-07-15T10:00:05.000Z");
    assert.equal(result.analytics.triggerType, "manual");
    assert.equal(result.analytics.summary.cumulativeTokens, 20);
    assert.equal(result.analytics.summary.currentMonthSpendUsd, 0.02);
    assert.equal(result.analytics.summary.monthlyBudgetUsd, 100);
    assert.deepEqual(result.analytics.dailyUsage, [{
      date: "2026-07-15",
      tokens: 20,
      requests: 1,
      estimatedCostUsd: 0.02
    }]);
    assert.deepEqual(result.analytics.tokenUsage, [{
      tokenId: "hash-1",
      tokens: 20,
      requests: 1,
      estimatedCostUsd: 0.02
    }]);

    const reloaded = await readUsageAnalytics(
      db,
      "ada@example.com",
      new Date("2026-07-15T10:01:00.000Z")
    );
    assert.deepEqual(reloaded, result.analytics);
    assert.deepEqual({ ...sqlite.prepare(`
      SELECT status, external_user_id AS externalUserId, trigger_type AS triggerType
      FROM gateway_usage_snapshot_runs
      WHERE id = 'manual-run-1'
    `).get() }, {
      status: "ready",
      externalUserId: "ada@example.com",
      triggerType: "manual"
    });
    sqlite.close();
  });
});

function sqliteD1(sqlite) {
  return {
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
          return sqlite.prepare(sql).run(...args);
        }
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.runSync());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
}
