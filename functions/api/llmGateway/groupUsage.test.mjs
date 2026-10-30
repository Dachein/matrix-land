import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlmGatewayGroupUsageApi, readGroupUsageDailyTotals } from "./groupUsage.ts";

function makeDeps(overrides = {}) {
  return {
    httpError(status, message) {
      return Object.assign(new Error(message), { status });
    },
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        ...init,
        headers: { "content-type": "application/json", ...init.headers }
      });
    },
    async requireAuthenticated() {
      return undefined;
    },
    ...overrides
  };
}

function context(db = {}) {
  return {
    env: {
      DB: db,
      USAGE_HISTORY_START_DATE: "2026-07-13"
    },
    request: new Request("https://portal.test/api/llm-gateway/group-usage")
  };
}

describe("LLM Gateway group usage", () => {
  it("serves cumulative totals from the daily D1 ledger", async () => {
    const calls = [];
    const api = createLlmGatewayGroupUsageApi(makeDeps({
      async readDailyTotals(db, startDate) {
        calls.push({ db, startDate });
        return {
          requestCount: 115_853,
          startDate,
          totalTokens: 15_284_943_775,
          updatedAt: "2026-09-14T16:02:38.642Z"
        };
      }
    }));
    const db = {};

    const response = await api.getGroupUsage(context(db));

    assert.equal(response.headers.get("x-workspace-usage-source"), "d1-daily-ledger");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(calls, [{ db, startDate: "2026-07-13" }]);
    assert.deepEqual(await response.json(), {
      requestCount: 115_853,
      startDate: "2026-07-13",
      totalTokens: 15_284_943_775,
      updatedAt: "2026-09-14T16:02:38.642Z"
    });
  });

  it("returns a stable 503 when no daily snapshot exists", async () => {
    const api = createLlmGatewayGroupUsageApi(makeDeps({
      async readDailyTotals() {
        return undefined;
      }
    }));

    await assert.rejects(
      () => api.getGroupUsage(context()),
      (error) => error.status === 503 && error.message === "group_usage_daily_snapshot_unavailable"
    );
  });

  it("sums every available date including current-day rows", async () => {
    const calls = [];
    const db = {
      prepare(sql) {
        calls.push(sql);
        return {
          bind(startDate) {
            calls.push(startDate);
            return {
              async first() {
                return {
                  rowCount: "696",
                  requestCount: "115853",
                  totalTokens: "15284943775",
                  updatedAt: "2026-09-15T06:19:55.298Z"
                };
              }
            };
          }
        };
      }
    };

    assert.deepEqual(await readGroupUsageDailyTotals(db, "2026-07-13"), {
      requestCount: 115_853,
      startDate: "2026-07-13",
      totalTokens: 15_284_943_775,
      updatedAt: "2026-09-15T06:19:55.298Z"
    });
    assert.match(calls[0], /FROM gateway_usage_daily_snapshots/);
    assert.match(calls[0], /WHERE usage_date >= \?/);
    assert.doesNotMatch(calls[0], /data_through_date/);
    assert.equal(calls[1], "2026-07-13");
  });
});
