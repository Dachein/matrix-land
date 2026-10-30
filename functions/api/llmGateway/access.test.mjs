import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlmGatewayAccessApi, hashLiteLlmToken, llmGatewayUserScope } from "./access.ts";
import { dispatchLlmGatewayRoutes } from "./routes.ts";
import { aggregateUserSpendLogs } from "./usageRefresh.ts";
import { computeUsageKeysetFingerprint } from "./usageSnapshots.ts";
import { syncLiteLlmUserMonthlyBudget } from "./userBudgets.ts";

const currentUser = {
  id: "user-1",
  name: "Ada",
  email: "ada@example.com",
  team: "AI Adoption",
  identity: {
    provider: "microsoft_entra_id",
    objectId: "oid-1",
    tenantId: "tenant-1"
  }
};

function makeDeps(overrides = {}) {
  return {
    async audit() { return "test-audit-id"; },
    async adminJson() {
      return {};
    },
    baseUrl() {
      return "https://llm.example.com";
    },
    httpError(status, message) {
      return Object.assign(new Error(message), { status });
    },
    json(body, init = {}) {
      return new Response(JSON.stringify(body), init);
    },
    optionalText(value, maxLength) {
      return String(value ?? "").trim().slice(0, maxLength);
    },
    async readBody(request) {
      return request.headers.get("content-type")?.includes("json") ? request.json() : {};
    },
    requireText(value, errorCode, maxLength) {
      const text = String(value ?? "").trim();
      if (!text) {
        throw Object.assign(new Error(errorCode), { status: 400 });
      }
      return text.slice(0, maxLength);
    },
    async resolveCurrentUser() {
      return currentUser;
    },
    ...overrides
  };
}

describe("llm gateway access service", () => {
  it("serves the persisted total-token summary and schedules stale refresh work after the response path", async () => {
    const backgroundTasks = [];
    let refreshCalls = 0;
    let releaseUpstream;
    const upstreamGate = new Promise((resolve) => { releaseUpstream = resolve; });
    const api = createLlmGatewayAccessApi(makeDeps({
      clock: () => new Date("2026-07-15T12:10:00.000Z"),
      async readCumulativeUsageSummary(_db, userId) {
        assert.equal(userId, "ada@example.com");
        return {
          hasSnapshot: true,
          cumulativeTokens: 9_876_543,
          updatedAt: "2026-07-15T11:00:00.000Z",
          dataThroughAt: "2026-07-15T10:59:00.000Z",
          lastRefreshRequestedAt: "2026-07-15T11:00:00.000Z"
        };
      },
      async claimCumulativeUsageSummaryRefresh(_db, input) {
        assert.equal(input.externalUserId, "ada@example.com");
        assert.equal(input.requestedAt, "2026-07-15T12:10:00.000Z");
        return true;
      },
      async adminJson(_context, path) {
        await upstreamGate;
        if (path.startsWith("/user/info")) {
          return { user_id: "ada@example.com", max_budget: 100 };
        }
        if (path.startsWith("/key/list")) return { keys: [] };
        return {};
      },
      async refreshUsageForUser() {
        refreshCalls += 1;
        return { status: "committed" };
      }
    }));
    const context = {
      request: new Request("https://portal.test/api/llm-gateway/access/usage/summary"),
      env: { DB: { prepare() { return { bind() { return this; }, async first() { return null; } }; } } },
      waitUntil(task) { backgroundTasks.push(task); }
    };

    const response = await api.getUsageSummary(context);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(body, {
      source: "snapshot",
      hasSnapshot: true,
      cumulativeTokens: 9_876_543,
      updatedAt: "2026-07-15T11:00:00.000Z",
      dataThroughAt: "2026-07-15T10:59:00.000Z",
      lastRefreshRequestedAt: "2026-07-15T11:00:00.000Z",
      refreshScheduled: true
    });
    assert.equal(backgroundTasks.length, 1);
    assert.equal(refreshCalls, 0);

    releaseUpstream();
    await Promise.all(backgroundTasks);
    assert.equal(refreshCalls, 1);
  });

  it("does not schedule a refresh while the summary cache is younger than five minutes", async () => {
    let claimCalls = 0;
    const api = createLlmGatewayAccessApi(makeDeps({
      clock: () => new Date("2026-07-15T12:04:59.000Z"),
      async readCumulativeUsageSummary() {
        return {
          hasSnapshot: true,
          cumulativeTokens: 99,
          updatedAt: "2026-07-15T12:00:00.000Z",
          lastRefreshRequestedAt: "2026-07-15T12:00:00.000Z"
        };
      },
      async claimCumulativeUsageSummaryRefresh() {
        claimCalls += 1;
        return true;
      }
    }));

    const body = await (await api.getUsageSummary({
      request: new Request("https://portal.test/api/llm-gateway/access/usage/summary"),
      env: { DB: {} },
      waitUntil() { throw new Error("fresh summary must not schedule background work"); }
    })).json();

    assert.equal(body.cumulativeTokens, 99);
    assert.equal(body.refreshScheduled, false);
    assert.equal(claimCalls, 0);
  });

  it("records a lightweight current check and returns the entry refresh decision", async () => {
    const keysetFingerprint = await computeUsageKeysetFingerprint([{ id: "hash-1" }]);
    let recorded;
    const api = createLlmGatewayAccessApi(makeDeps({
      clock: () => new Date("2026-07-15T12:00:00.000Z"),
      async adminJson(_context, gatewayPath) {
        if (gatewayPath.startsWith("/user/info")) return { user_id: "ada@example.com", max_budget: 100 };
        if (gatewayPath.startsWith("/key/list")) {
          return { keys: [{ token: "hash-1", user_id: "ada@example.com", last_used_at: "2026-07-15T09:00:00.000Z" }] };
        }
        return { data: [] };
      },
      async readUsageAnalytics() {
        return {
          timezone: "Asia/Shanghai",
          source: "snapshot",
          status: "ready",
          dataThroughDate: "2026-07-15",
          dataThroughAt: "2026-07-15T10:00:00.000Z",
          lastReconciledAt: "2026-07-15T11:00:00.000Z",
          keysetFingerprint,
          summary: { cumulativeTokens: 10, peakDailyTokens: 10, currentMonthSpendUsd: 0.01, monthlyBudgetUsd: 100 },
          dailyUsage: [],
          tokenUsage: []
        };
      },
      async recordUsageRefreshCheck(_db, input) {
        recorded = input;
        return true;
      }
    }));

    const body = await (await api.getAccess({
      request: new Request("https://portal.test/api/llm-gateway/access"),
      env: {
        DB: {
          prepare() {
            return {
              bind() { return this; },
              async first() { return null; }
            };
          }
        }
      }
    })).json();

    assert.deepEqual(body.usageRefresh, { recommended: false, reason: "current" });
    assert.equal(body.analytics.lastCheckedAt, "2026-07-15T12:00:00.000Z");
    assert.equal(body.analytics.keysetFingerprint, undefined);
    assert.equal(recorded.externalUserId, "ada@example.com");
    assert.equal(recorded.activityWatermarkAt, "2026-07-15T09:00:00.000Z");
    assert.equal(recorded.keysetFingerprint, keysetFingerprint);
  });

  it("reads personal keys, models, and budget live while serving usage from the nightly snapshot", async () => {
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);
        if (gatewayPath.startsWith("/user/info")) return { user_id: "ada@example.com", max_budget: 999, spend: 0.154381 };
        if (gatewayPath.startsWith("/key/list")) return { keys: [{ token: "hash-1", key_alias: "Portal", user_id: "ada@example.com", metadata: { workspace: { usagePurpose: "app" } } }] };
        return { data: [{ model_name: "gpt-5.5", model_info: { mode: "chat" } }] };
      },
      async readUsageAnalytics(_db, userId) {
        assert.equal(userId, "ada@example.com");
        return {
          timezone: "Asia/Shanghai",
          status: "ready",
          updatedAt: "2026-07-12T16:00:00.000Z",
          dataThroughDate: "2026-07-12",
          summary: {
            cumulativeTokens: 200,
            peakDailyTokens: 80,
            currentMonthSpendUsd: 0.1,
            monthlyBudgetUsd: 100
          },
          dailyUsage: [{ date: "2026-07-12", tokens: 20, requests: 1, estimatedCostUsd: 0.1 }],
          tokenUsage: [{ tokenId: "hash-1", tokens: 20, requests: 1, estimatedCostUsd: 0.1 }]
        };
      }
    }));

    const response = await api.getAccess({
      request: new Request("https://portal.test/api/llm-gateway/access"),
      env: {}
    });
    const body = await response.json();

    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("server-timing"), /^auth;dur=\d+, data;dur=\d+, total;dur=\d+$/);
    assert.equal(body.source.provider, "litellm");
    assert.equal(body.tokens[0].id, "hash-1");
    assert.equal(body.tokens[0].usagePurpose, "app");
    assert.equal(body.series[0].billableUnits, 20);
    assert.equal(body.analytics.summary.cumulativeTokens, 200);
    assert.equal(body.analytics.summary.monthlyBudgetUsd, 999);
    assert.equal(body.analytics.summary.currentMonthSpendUsd, 0.1);
    assert.equal(body.userLimit.spendUsd, 0.154381);
    assert.equal(body.modelOptions[0].id, "gpt-5.5");
    assert.equal(calls.length, 3);
    assert.equal(calls.some((path) => path.startsWith("/spend/logs")), false);
  });

  it("loads every page of the current user's keys before evaluating usage", async () => {
    const keyPaths = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath) {
        if (gatewayPath.startsWith("/user/info")) {
          return { user_id: "ada@example.com", max_budget: 100 };
        }
        if (gatewayPath.startsWith("/key/list")) {
          keyPaths.push(gatewayPath);
          const page = Number(new URL(`https://gateway.test${gatewayPath}`).searchParams.get("page"));
          return page === 1
            ? { keys: [{ token: "hash-1", user_id: "ada@example.com", last_used_at: "2026-07-15T09:00:00.000Z" }], page: 1, total_pages: 2 }
            : { keys: [{ token: "hash-2", user_id: "ada@example.com" }], page: 2, total_pages: 2 };
        }
        return { data: [] };
      },
      async readUsageAnalytics() {
        return {
          timezone: "Asia/Shanghai",
          source: "snapshot",
          status: "pending",
          summary: { cumulativeTokens: 0, peakDailyTokens: 0, currentMonthSpendUsd: 0, monthlyBudgetUsd: 0 },
          dailyUsage: [],
          tokenUsage: []
        };
      }
    }));

    const body = await (await api.getAccess({
      request: new Request("https://portal.test/api/llm-gateway/access"),
      env: {}
    })).json();

    assert.deepEqual(body.tokens.map((token) => token.id), ["hash-1", "hash-2"]);
    assert.equal(body.tokens[0].lastUsedAt, "2026-07-15T09:00:00.000Z");
    assert.equal(keyPaths.length, 2);
    assert.match(keyPaths[0], /page=1/);
    assert.match(keyPaths[1], /page=2/);
  });

  it("calculates current usage directly from user-scoped LiteLLM logs and merges rotated key lineage", async () => {
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);
        if (gatewayPath.startsWith("/key/list")) {
          return {
            keys: [{
              token: "hash-old",
              key_alias: "old-key",
              user_id: "ada@example.com",
              blocked: true,
              metadata: { workspace: { credentialId: "credential-1", generation: 1 } }
            }, {
              token: "hash-new",
              key_alias: "current-key",
              user_id: "ada@example.com",
              metadata: {
                workspace: {
                  credentialId: "credential-1",
                  generation: 2,
                  previousTokenIds: ["hash-old"],
                  rotatedFromTokenId: "hash-old"
                }
              }
            }]
          };
        }
        if (gatewayPath.startsWith("/spend/logs/v2")) {
          return {
            data: [
              { request_id: "r1", api_key: "hash-old", user: "ada@example.com", startTime: "2026-06-30T16:30:00.000Z", total_tokens: 110, spend: 0.11 },
              { request_id: "r2", api_key: "hash-old", user: "ada@example.com", startTime: "2026-07-14T13:00:00.000Z", prompt_tokens: 100, completion_tokens: 120, spend: 0.22 },
              { request_id: "r3", api_key: "hash-new", user: "ada@example.com", startTime: "2026-07-15T01:00:00.000Z", total_tokens: 50, spend: 0.05 },
              { request_id: "r3", api_key: "hash-new", user: "ada@example.com", startTime: "2026-07-15T01:00:00.000Z", total_tokens: 50, spend: 0.05 },
              { request_id: "other", api_key: "hash-other", user: "other@example.com", startTime: "2026-07-15T01:00:00.000Z", total_tokens: 999, spend: 9.99 }
            ],
            page: 1,
            page_size: 100,
            total: 5,
            total_pages: 1
          };
        }
        return {};
      },
      async readUsageAnalytics(_db, userId, now) {
        assert.equal(userId, "ada@example.com");
        assert.equal(now.toISOString(), "2026-07-15T10:00:00.000Z");
        return {
          timezone: "Asia/Shanghai",
          status: "ready",
          updatedAt: "2026-07-14T16:00:00.000Z",
          dataThroughDate: "2026-07-14",
          summary: {
            cumulativeTokens: 1000,
            peakDailyTokens: 500,
            currentMonthSpendUsd: 0.3,
            monthlyBudgetUsd: 100
          },
          dailyUsage: [
            { date: "2026-06-20", tokens: 500, requests: 1, estimatedCostUsd: 0.5 },
            { date: "2026-07-01", tokens: 100, requests: 1, estimatedCostUsd: 0.1 },
            { date: "2026-07-14", tokens: 200, requests: 1, estimatedCostUsd: 0.2 }
          ],
          tokenUsage: [{ tokenId: "hash-old", tokens: 300, requests: 2, estimatedCostUsd: 0.3 }]
        };
      },
      async refreshUsageForUser(input) {
        assert.equal(input.triggerType, "manual");
        const sourceFromDate = "2026-07-13";
        const sourceToDate = "2026-07-15";
        const collected = await input.fetchSpendLogs({
          dataThroughAt: input.now.toISOString(),
          fromDate: sourceFromDate,
          toDate: sourceToDate,
          userId: input.externalUserId
        });
        return {
          status: "committed",
          endpoints: collected.endpoints,
          sourceFromDate,
          sourceToDate,
          sourceRowCount: collected.logs.length,
          attributedRowCount: 2,
          unattributedRowCount: 1,
          analytics: {
            timezone: "Asia/Shanghai",
            source: "snapshot",
            status: "ready",
            updatedAt: "2026-07-15T10:00:00.000Z",
            dataThroughDate: sourceToDate,
            dataThroughAt: "2026-07-15T10:00:00.000Z",
            triggerType: "manual",
            summary: {
              cumulativeTokens: 1070,
              peakDailyTokens: 500,
              currentMonthSpendUsd: 0.37,
              monthlyBudgetUsd: 100
            },
            dailyUsage: [],
            tokenUsage: [
              { tokenId: "hash-old", tokens: 320, requests: 2, estimatedCostUsd: 0.32 },
              { tokenId: "hash-new", tokens: 50, requests: 1, estimatedCostUsd: 0.05 }
            ]
          }
        };
      }
    }));

    const response = await api.refreshAccessUsage({
      request: new Request("https://portal.test/api/llm-gateway/access/usage/refresh", { method: "POST" }),
      env: { USAGE_HISTORY_START_DATE: "2026-07-13" }
    });
    const body = await response.json();

    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.source.provider, "litellm");
    assert.deepEqual(body.source.range, { from: "2026-07-13", to: "2026-07-15" });
    assert.equal(
      calls.find((path) => path.startsWith("/spend/logs/v2")),
      "/spend/logs/v2?start_date=2026-07-12&end_date=2026-07-16&user_id=ada%40example.com&page=1&page_size=100&sort_by=startTime&sort_order=asc"
    );
    assert.equal(body.analytics.source, "snapshot");
    assert.equal(body.analytics.timezone, "Asia/Shanghai");
    assert.equal(body.analytics.status, "ready");
    assert.equal(body.analytics.dataThroughDate, "2026-07-15");
    assert.equal(body.analytics.updatedAt, "2026-07-15T10:00:00.000Z");
    assert.equal(body.analytics.summary.cumulativeTokens, 1070);
    assert.equal(body.analytics.summary.peakDailyTokens, 500);
    assert.ok(Math.abs(body.analytics.summary.currentMonthSpendUsd - 0.37) < 1e-12);
    assert.deepEqual(body.analytics.tokenUsage, [{
      tokenId: "hash-new",
      tokens: 370,
      requests: 3,
      estimatedCostUsd: 0.37
    }]);
    assert.equal(body.usage[0].scopeId, "hash-new");
    assert.equal(body.usage[0].billableUnits, 370);
    assert.equal(body.series[0].groupId, "hash-new");
  });

  it("returns a model-level cost breakdown for a selected scope and key", async () => {
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);
        if (gatewayPath.startsWith("/key/list")) {
          return {
            keys: [
              { token: "hash-a", key_alias: "alpha", user_id: "ada@example.com" },
              { token: "hash-b", key_alias: "beta", user_id: "ada@example.com" }
            ]
          };
        }
        if (gatewayPath.startsWith("/v1/model/info")) {
          return {
            data: [{
              model_name: "tencent-hunyuan-t1-latest",
              model_info: { mode: "chat", display_name: "Hunyuan T1" }
            }, {
              model_name: "gpt-5.5",
              model_info: { mode: "chat" }
            }]
          };
        }
        if (gatewayPath.startsWith("/spend/logs/v2")) {
          return {
            data: [
              {
                request_id: "r1",
                api_key: "hash-a",
                user: "ada@example.com",
                model: "tencent-hunyuan-t1-latest",
                startTime: "2026-07-02T04:00:00.000Z",
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120,
                cache_read_input_tokens: 60,
                spend: 0.02
              },
              {
                request_id: "r2",
                api_key: "hash-b",
                user: "ada@example.com",
                model: "tencent-hunyuan-t1-latest",
                startTime: "2026-07-14T04:00:00.000Z",
                prompt_tokens: 200,
                completion_tokens: 50,
                total_tokens: 250,
                cached_input_tokens: 40,
                spend: 0.03
              },
              {
                request_id: "r3",
                api_key: "hash-a",
                user: "ada@example.com",
                model: "gpt-5.5",
                startTime: "2026-07-15T01:00:00.000Z",
                prompt_tokens: 300,
                completion_tokens: 100,
                total_tokens: 400,
                spend: 0.05
              }
            ],
            page: 1,
            page_size: 100,
            total: 3,
            total_pages: 1
          };
        }
        return {};
      }
    }));

    const response = await api.getUsageBreakdown({
      request: new Request("https://portal.test/api/llm-gateway/access/usage/breakdown?scope=month&key=hash-a"),
      env: { USAGE_HISTORY_START_DATE: "2026-07-13" }
    });
    const body = await response.json();

    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(body.scope, { type: "month", from: "2026-07-01", to: "2026-07-15" });
    assert.deepEqual(body.selectedKey, { id: "hash-a", name: "alpha" });
    assert.equal(body.models.length, 2);
    const hunyuan = body.models.find((row) => row.model === "tencent-hunyuan-t1-latest");
    const gpt = body.models.find((row) => row.model === "gpt-5.5");
    assert.equal(hunyuan.displayName, "Hunyuan T1");
    assert.equal(hunyuan.requests, 1);
    assert.equal(hunyuan.cacheReadTokens, 60);
    assert.equal(hunyuan.cacheRate, 60 / 100);
    assert.equal(gpt.requests, 1);
    assert.equal(gpt.inputTokens, 300);
    assert.equal(body.total.requests, 2);
    assert.equal(body.total.totalTokens, 520);
    assert.ok(Math.abs(body.total.estimatedCostUsd - 0.07) < 1e-12);
    assert.ok(calls.some((path) => path.startsWith("/spend/logs/v2")));
    assert.ok(calls.some((path) => path.startsWith("/v1/model/info")));
  });

  it("serves a closed user and token history range from the daily ledger without spend-log scans", async () => {
    const calls = [];
    let ledgerInput;
    const api = createLlmGatewayAccessApi(makeDeps({
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);
        if (gatewayPath.startsWith("/key/list")) {
          return { keys: [{ token: "hash-a", key_alias: "alpha", user_id: "ada@example.com" }] };
        }
        if (gatewayPath.startsWith("/v1/model/info")) {
          return { data: [{ model_name: "tencent-deepseek-v4-flash", model_info: { mode: "chat", display_name: "DeepSeek-V4-Flash 正式版" } }] };
        }
        throw new Error(`unexpected upstream call: ${gatewayPath}`);
      },
      async readUsageLedgerCoverage() {
        return { available: true, dataThroughDate: "2026-07-14" };
      },
      async readUserUsageModelLedger(_db, input) {
        ledgerInput = input;
        return {
          available: true,
          models: [{
            model: "tencent-deepseek-v4-flash",
            displayName: "tencent-deepseek-v4-flash",
            requests: 5,
            inputTokens: 1_000,
            outputTokens: 100,
            cacheReadTokens: 800,
            cacheWriteTokens: 0,
            totalTokens: 1_100,
            cacheRate: 0.8,
            estimatedCostUsd: 0.2
          }]
        };
      }
    }));

    const body = await (await api.getUsageBreakdown({
      request: new Request("https://portal.test/api/llm-gateway/access/usage/breakdown?scope=date&date=2026-07-14&key=hash-a"),
      env: {}
    })).json();

    assert.deepEqual(ledgerInput, {
      externalUserId: "ada@example.com",
      tokenId: "hash-a",
      fromDate: "2026-07-14",
      toDate: "2026-07-14"
    });
    assert.equal(body.models[0].displayName, "DeepSeek-V4-Flash 正式版");
    assert.equal(body.total.cacheRate, 0.8);
    assert.ok(body.source.endpoints.includes("d1:gateway_usage_daily_model_snapshots"));
    assert.ok(!calls.some((path) => path.startsWith("/spend/logs/v2")));
  });

  it("combines closed daily ledgers with only the unclosed live tail", async () => {
    const spendPaths = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      async adminJson(_context, gatewayPath) {
        if (gatewayPath.startsWith("/key/list")) return { keys: [] };
        if (gatewayPath.startsWith("/v1/model/info")) return { data: [] };
        if (gatewayPath.startsWith("/spend/logs/v2")) {
          spendPaths.push(gatewayPath);
          return {
            data: [{
              request_id: "today",
              model_group: "tencent-deepseek-v4-flash",
              model: "openai/deepseek-v4-flash-202605",
              startTime: "2026-07-15T02:00:00.000Z",
              prompt_tokens: 200,
              completion_tokens: 40,
              total_tokens: 240,
              spend: 0.02
            }],
            page: 1,
            total_pages: 1
          };
        }
        throw new Error(`unexpected upstream call: ${gatewayPath}`);
      },
      async readUsageLedgerCoverage() {
        return { available: true, dataThroughDate: "2026-07-14" };
      },
      async readUserUsageModelLedger() {
        return {
          available: true,
          models: [{
            model: "tencent-deepseek-v4-flash",
            displayName: "tencent-deepseek-v4-flash",
            requests: 10,
            inputTokens: 1_000,
            outputTokens: 100,
            cacheReadTokens: 800,
            cacheWriteTokens: 0,
            totalTokens: 1_100,
            cacheRate: 0.8,
            estimatedCostUsd: 0.1
          }]
        };
      }
    }));

    const body = await (await api.getUsageBreakdown({
      request: new Request("https://portal.test/api/llm-gateway/access/usage/breakdown?scope=month"),
      env: {}
    })).json();

    assert.equal(spendPaths.length, 1);
    assert.match(spendPaths[0], /start_date=2026-07-14/);
    assert.match(spendPaths[0], /end_date=2026-07-16/);
    assert.equal(body.models.length, 1);
    assert.equal(body.models[0].requests, 11);
    assert.equal(body.models[0].cacheRate, 800 / 1_200);
    assert.equal(body.total.totalTokens, 1_340);
  });

  it("rejects an invalid usage breakdown scope", async () => {
    const api = createLlmGatewayAccessApi(makeDeps());

    await assert.rejects(
      () => api.getUsageBreakdown({
        request: new Request("https://portal.test/api/llm-gateway/access/usage/breakdown?scope=year"),
        env: {}
      }),
      /invalid_usage_breakdown_scope/
    );
  });

  it("persists page-entry refreshes with an automatic trigger", async () => {
    let triggerType;
    const api = createLlmGatewayAccessApi(makeDeps({
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      async adminJson(_context, gatewayPath) {
        if (gatewayPath.startsWith("/user/info")) return { user_id: "ada@example.com", max_budget: 100 };
        if (gatewayPath.startsWith("/key/list")) return { keys: [] };
        return {};
      },
      async refreshUsageForUser(input) {
        triggerType = input.triggerType;
        return {
          status: "committed",
          endpoints: [],
          sourceFromDate: "2026-07-13",
          sourceToDate: "2026-07-15",
          sourceRowCount: 0,
          attributedRowCount: 0,
          unattributedRowCount: 0,
          analytics: {
            timezone: "Asia/Shanghai",
            source: "snapshot",
            status: "ready",
            updatedAt: "2026-07-15T10:00:00.000Z",
            dataThroughDate: "2026-07-15",
            dataThroughAt: "2026-07-15T10:00:00.000Z",
            triggerType: "automatic",
            summary: { cumulativeTokens: 0, peakDailyTokens: 0, currentMonthSpendUsd: 0, monthlyBudgetUsd: 100 },
            dailyUsage: [],
            tokenUsage: []
          }
        };
      }
    }));

    const response = await api.refreshAccessUsage({
      request: new Request("https://portal.test/api/llm-gateway/access/usage/refresh?trigger=automatic", { method: "POST" }),
      env: {}
    });

    assert.equal(response.status, 200);
    assert.equal(triggerType, "automatic");
    assert.equal((await response.json()).analytics.triggerType, "automatic");
  });

  it("paginates LiteLLM v2 spend logs and deduplicates requests across pages", async () => {
    const spendPaths = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      async adminJson(_context, gatewayPath) {
        if (gatewayPath.startsWith("/key/list")) {
          return { keys: [{ token: "hash-1", user_id: "ada@example.com" }] };
        }
        if (gatewayPath.startsWith("/spend/logs/v2")) {
          spendPaths.push(gatewayPath);
          const page = Number(new URL(`https://gateway.test${gatewayPath}`).searchParams.get("page"));
          return page === 1
            ? {
              data: [{ request_id: "r1", api_key: "hash-1", startTime: "2026-07-14T01:00:00.000Z", total_tokens: 10, spend: 0.01 }],
              page: 1,
              page_size: 100,
              total: 3,
              total_pages: 2
            }
            : {
              data: [
                { request_id: "r1", api_key: "hash-1", startTime: "2026-07-14T01:00:00.000Z", total_tokens: 10, spend: 0.01 },
                { request_id: "r2", api_key: "hash-1", startTime: "2026-07-15T01:00:00.000Z", prompt_tokens: 8, completion_tokens: 12, spend: 0.02 }
              ],
              page: 2,
              page_size: 100,
              total: 3,
              total_pages: 2
            };
        }
        return {};
      },
      async readUsageAnalytics() {
        return {
          timezone: "Asia/Shanghai",
          status: "pending",
          summary: { cumulativeTokens: 0, peakDailyTokens: 0, currentMonthSpendUsd: 0, monthlyBudgetUsd: 0 },
          dailyUsage: [],
          tokenUsage: []
        };
      },
      async refreshUsageForUser(input) {
        const sourceFromDate = "2026-07-13";
        const sourceToDate = "2026-07-15";
        const collected = await input.fetchSpendLogs({
          dataThroughAt: input.now.toISOString(),
          fromDate: sourceFromDate,
          toDate: sourceToDate,
          userId: input.externalUserId
        });
        const aggregated = aggregateUserSpendLogs({
          dataThroughAt: input.now.toISOString(),
          externalUserId: input.externalUserId,
          fromDate: sourceFromDate,
          keys: input.keys,
          logs: collected.logs,
          toDate: sourceToDate
        });
        const tokenUsage = new Map();
        for (const row of aggregated.rows) {
          const current = tokenUsage.get(row.tokenId) ?? {
            tokenId: row.tokenId,
            tokens: 0,
            requests: 0,
            estimatedCostUsd: 0
          };
          current.tokens += row.tokens;
          current.requests += row.requests;
          current.estimatedCostUsd += row.estimatedCostUsd;
          tokenUsage.set(row.tokenId, current);
        }
        const totalTokens = aggregated.rows.reduce((sum, row) => sum + row.tokens, 0);
        const totalCost = aggregated.rows.reduce((sum, row) => sum + row.estimatedCostUsd, 0);
        return {
          status: "committed",
          endpoints: collected.endpoints,
          sourceFromDate,
          sourceToDate,
          ...aggregated,
          analytics: {
            timezone: "Asia/Shanghai",
            source: "snapshot",
            status: "ready",
            updatedAt: input.now.toISOString(),
            dataThroughDate: sourceToDate,
            dataThroughAt: input.now.toISOString(),
            triggerType: "manual",
            summary: {
              cumulativeTokens: totalTokens,
              peakDailyTokens: Math.max(0, ...aggregated.rows.map((row) => row.tokens)),
              currentMonthSpendUsd: totalCost,
              monthlyBudgetUsd: 0
            },
            dailyUsage: [],
            tokenUsage: Array.from(tokenUsage.values())
          }
        };
      }
    }));

    const body = await (await api.refreshAccessUsage({
      request: new Request("https://portal.test/api/llm-gateway/access/usage/refresh", { method: "POST" }),
      env: { USAGE_HISTORY_START_DATE: "2026-07-13" }
    })).json();

    assert.equal(spendPaths.length, 2);
    assert.match(spendPaths[0], /user_id=ada%40example\.com/);
    assert.match(spendPaths[0], /page=1/);
    assert.match(spendPaths[1], /page=2/);
    assert.doesNotMatch(spendPaths[0], /summarize=/);
    assert.equal(body.analytics.summary.cumulativeTokens, 30);
    assert.equal(body.analytics.summary.currentMonthSpendUsd, 0.03);
    assert.deepEqual(body.analytics.tokenUsage, [{
      tokenId: "hash-1",
      tokens: 30,
      requests: 2,
      estimatedCostUsd: 0.03
    }]);
  });

  it("fails closed when LiteLLM v2 spend pagination exceeds the bounded scan", async () => {
    const api = createLlmGatewayAccessApi(makeDeps({
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      async adminJson(_context, gatewayPath) {
        if (gatewayPath.startsWith("/key/list")) {
          return { keys: [] };
        }
        return {
          data: [],
          page: 1,
          page_size: 100,
          total: 10_001,
          total_pages: 101
        };
      },
      async readUsageAnalytics() {
        return {
          timezone: "Asia/Shanghai",
          status: "pending",
          summary: { cumulativeTokens: 0, peakDailyTokens: 0, currentMonthSpendUsd: 0, monthlyBudgetUsd: 0 },
          dailyUsage: [],
          tokenUsage: []
        };
      },
      async refreshUsageForUser(input) {
        await input.fetchSpendLogs({
          dataThroughAt: input.now.toISOString(),
          fromDate: "2026-07-13",
          toDate: "2026-07-15",
          userId: input.externalUserId
        });
        throw new Error("unreachable");
      }
    }));

    await assert.rejects(
      () => api.refreshAccessUsage({
        request: new Request("https://portal.test/api/llm-gateway/access/usage/refresh", { method: "POST" }),
        env: { USAGE_HISTORY_START_DATE: "2026-07-13" }
      }),
      (error) => error.status === 502 && error.message === "litellm_spend_logs_truncated"
    );
  });

  it("hides completed rotated generations and merges their analytics into the current key", async () => {
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath) {
        if (gatewayPath.startsWith("/user/info")) return { user_id: "ada@example.com", max_budget: 100 };
        if (gatewayPath.startsWith("/key/list")) {
          return {
            keys: [{
              token: "hash-generation-1",
              key_alias: "agent-key-rotated-1",
              user_id: "ada@example.com",
              blocked: true,
              metadata: {
                workspace: {
                  credentialId: "credential-1",
                  generation: 1,
                  lifecycle: "rotated",
                  rotatedToTokenId: "hash-generation-2"
                }
              }
            }, {
              token: "hash-generation-2",
              key_alias: "agent-key-rotated-2",
              user_id: "ada@example.com",
              blocked: true,
              metadata: {
                workspace: {
                  credentialId: "credential-1",
                  generation: 2,
                  lifecycle: "rotated",
                  rotatedFromTokenId: "hash-generation-1",
                  rotatedToTokenId: "hash-generation-3"
                }
              }
            }, {
              token: "hash-generation-3",
              key_alias: "agent-key",
              user_id: "ada@example.com",
              metadata: {
                workspace: {
                  credentialId: "credential-1",
                  generation: 3,
                  previousTokenIds: ["hash-generation-1", "hash-generation-2"],
                  rotatedFromTokenId: "hash-generation-2"
                }
              }
            }, {
              token: "hash-manually-suspended",
              key_alias: "paused-key",
              user_id: "ada@example.com",
              blocked: true,
              metadata: { workspace: { credentialId: "credential-2", generation: 1 } }
            }]
          };
        }
        return { data: [] };
      },
      async readUsageAnalytics() {
        return {
          timezone: "Asia/Shanghai",
          status: "ready",
          updatedAt: "2026-07-12T16:00:00.000Z",
          dataThroughDate: "2026-07-12",
          summary: {
            cumulativeTokens: 100,
            peakDailyTokens: 100,
            currentMonthSpendUsd: 1,
            monthlyBudgetUsd: 100
          },
          dailyUsage: [{ date: "2026-07-12", tokens: 100, requests: 10, estimatedCostUsd: 1 }],
          tokenUsage: [{ tokenId: "hash-generation-1", tokens: 10, requests: 1, estimatedCostUsd: 0.1 },
            { tokenId: "hash-generation-2", tokens: 20, requests: 2, estimatedCostUsd: 0.2 },
            { tokenId: "hash-generation-3", tokens: 30, requests: 3, estimatedCostUsd: 0.3 },
            { tokenId: "hash-manually-suspended", tokens: 40, requests: 4, estimatedCostUsd: 0.4 }]
        };
      }
    }));

    const response = await api.getAccess({ request: new Request("https://portal.test/api/llm-gateway/access"), env: {} });
    const body = await response.json();

    assert.deepEqual(body.tokens.map((token) => token.id), ["hash-generation-3", "hash-manually-suspended"]);
    const tokenUsage = new Map(body.analytics.tokenUsage.map((row) => [row.tokenId, row]));
    assert.deepEqual(tokenUsage.get("hash-generation-3"), {
      tokenId: "hash-generation-3",
      tokens: 60,
      requests: 6,
      estimatedCostUsd: 0.6000000000000001
    });
    assert.deepEqual(tokenUsage.get("hash-manually-suspended"), {
      tokenId: "hash-manually-suspended",
      tokens: 40,
      requests: 4,
      estimatedCostUsd: 0.4
    });
    assert.equal(tokenUsage.has("hash-generation-1"), false);
    assert.equal(tokenUsage.has("hash-generation-2"), false);
    assert.deepEqual(body.usage.map((row) => row.scopeId), ["hash-generation-3", "hash-manually-suspended"]);
    assert.deepEqual(body.series.map((row) => row.groupId), ["hash-generation-3", "hash-manually-suspended"]);
    assert.equal(body.analytics.summary.cumulativeTokens, 100);
    assert.deepEqual(body.analytics.dailyUsage, [{ date: "2026-07-12", tokens: 100, requests: 10, estimatedCostUsd: 1 }]);
  });

  it("does not hide or merge an old generation until it is actually blocked", async () => {
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath) {
        if (gatewayPath.startsWith("/user/info")) return { user_id: "ada@example.com" };
        if (gatewayPath.startsWith("/key/list")) {
          return { keys: [{
            token: "hash-old-active",
            key_alias: "old-active",
            user_id: "ada@example.com",
            blocked: false,
            metadata: { workspace: { credentialId: "credential-1", generation: 1, lifecycle: "rotated", rotatedToTokenId: "hash-new" } }
          }, {
            token: "hash-new",
            key_alias: "new",
            user_id: "ada@example.com",
            metadata: { workspace: { credentialId: "credential-1", generation: 2, previousTokenIds: ["hash-old-active"], rotatedFromTokenId: "hash-old-active" } }
          }] };
        }
        return { data: [] };
      },
      async readUsageAnalytics() {
        return {
          timezone: "Asia/Shanghai",
          status: "ready",
          summary: { cumulativeTokens: 30, peakDailyTokens: 30, currentMonthSpendUsd: 0.3, monthlyBudgetUsd: 0 },
          dailyUsage: [],
          tokenUsage: [{ tokenId: "hash-old-active", tokens: 10, requests: 1, estimatedCostUsd: 0.1 },
            { tokenId: "hash-new", tokens: 20, requests: 2, estimatedCostUsd: 0.2 }]
        };
      }
    }));

    const body = await (await api.getAccess({ request: new Request("https://portal.test/api/llm-gateway/access"), env: {} })).json();

    assert.deepEqual(body.tokens.map((token) => token.id), ["hash-old-active", "hash-new"]);
    assert.deepEqual(body.analytics.tokenUsage.map((row) => row.tokenId), ["hash-old-active", "hash-new"]);
  });

  it("keeps key management available while the first nightly usage snapshot is pending", async () => {
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath) {
        if (gatewayPath.startsWith("/user/info")) return { user_id: "ada@example.com" };
        if (gatewayPath.startsWith("/key/list")) return { keys: [] };
        return { data: [] };
      },
      async readUsageAnalytics() {
        return {
          timezone: "Asia/Shanghai",
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
      }
    }));

    const response = await api.getAccess({ request: new Request("https://portal.test/api/llm-gateway/access"), env: {} });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.analytics.status, "pending");
    assert.deepEqual(body.series, []);
  });

  it("builds user-scoped token creation payloads", async () => {
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/user/info")) {
          return {
            user_id: "ada@example.com",
            user_email: "ada@example.com",
            max_budget: 100,
            models: ["tencent-hy3-preview"],
            budget_duration: "30d"
          };
        }
        if (gatewayPath === "/key/generate") {
          return {
            key: "sk-created",
            token: await hashLiteLlmToken("sk-created"),
            token_id: await hashLiteLlmToken("sk-created"),
            key_alias: init.body.key_alias,
            user_id: init.body.user_id,
            models: init.body.models,
            max_budget: init.body.max_budget,
            metadata: init.body.metadata
          };
        }
        return {};
      }
    }));

    const response = await api.createAccessToken({
      request: new Request("https://portal.test/api/llm-gateway/access/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "team-token", monthlyBudgetPercent: 55, usagePurpose: "app" })
      }),
      env: {}
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.token, "sk-created");
    assert.equal(body.tokenRecord.id, await hashLiteLlmToken("sk-created"));
    assert.equal(calls[0].gatewayPath, "/user/info?user_id=ada%40example.com");
    assert.equal(calls[1].gatewayPath, "/key/generate");
    assert.equal(calls[1].init.method, "POST");
    assert.equal(calls[1].init.body.key_alias, "team-token");
    assert.equal(calls[1].init.body.key_type, "llm_api");
    assert.equal(calls[1].init.body.user_id, "ada@example.com");
    assert.deepEqual(calls[1].init.body.models, ["tencent-hy3-preview"]);
    assert.equal(calls[1].init.body.max_budget, 55);
    assert.equal(calls[1].init.body.rpm_limit, 60);
    assert.equal(calls[1].init.body.tpm_limit, 2_000_000);
    assert.equal(calls[1].init.body.metadata.workspace.monthlyBudgetPercent, 55);
    assert.equal(calls[1].init.body.metadata.workspace.usagePurpose, "app");
    assert.match(calls[1].init.body.metadata.workspace.credentialId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(calls[1].init.body.metadata.workspace.generation, 1);
    assert.equal(calls[1].init.body.metadata.workspace.rateLimitRepairVersion, 2);
  });

  it("repairs Portal-managed zero user rate limits before returning personal access", async () => {
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init = {}) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/user/info")) {
          return {
            user_info: {
              user_id: "ada@example.com",
              max_budget: 100,
              rpm_limit: 0,
              tpm_limit: "0",
              metadata: {
                trace: "keep-user-metadata",
                workspace: {
                  allocationUpdatedVia: "workspace-portal",
                  budgetManagedBy: "admin"
                }
              }
            }
          };
        }
        if (gatewayPath === "/user/update") {
          return init.body;
        }
        if (gatewayPath.startsWith("/key/list")) {
          return { keys: [] };
        }
        return { data: [] };
      },
      async readUsageAnalytics() {
        return {
          timezone: "Asia/Shanghai",
          status: "pending",
          updatedAt: "",
          dataThroughDate: "",
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
    }));

    const response = await api.getAccess({
      request: new Request("https://portal.test/api/llm-gateway/access"),
      env: {}
    });
    const body = await response.json();
    const repair = calls.find((call) => call.gatewayPath === "/user/update");

    assert.equal(response.status, 200);
    assert.equal(repair.init.body.user_id, "ada@example.com");
    assert.equal(repair.init.body.rpm_limit, 60);
    assert.equal(repair.init.body.tpm_limit, 2_000_000);
    assert.equal(repair.init.body.metadata.trace, "keep-user-metadata");
    assert.equal(repair.init.body.metadata.workspace.rateLimitRepairVersion, 2);
    assert.equal(body.userLimit.requestLimitPerMinute, 60);
    assert.equal(body.userLimit.tokensPerMinute, 2_000_000);
  });

  it("upgrades the legacy 120k TPM default while preserving a versioned explicit 120k limit", async () => {
    for (const [repairVersion, expectedUpdates] of [[undefined, 1], [2, 0]]) {
      const calls = [];
      const api = createLlmGatewayAccessApi(makeDeps({
        async adminJson(_context, gatewayPath, init = {}) {
          calls.push({ gatewayPath, init });
          if (gatewayPath.startsWith("/user/info")) {
            return {
              user_id: "ada@example.com",
              max_budget: 100,
              rpm_limit: 60,
              tpm_limit: 120_000,
              metadata: {
                workspace: {
                  allocationUpdatedVia: "workspace-portal",
                  budgetManagedBy: "admin",
                  ...(repairVersion === undefined ? {} : { rateLimitRepairVersion: repairVersion })
                }
              }
            };
          }
          if (gatewayPath.startsWith("/key/list")) return { keys: [] };
          return { data: [] };
        }
      }));

      await api.getAccess({
        request: new Request("https://portal.test/api/llm-gateway/access"),
        env: {}
      });

      const updates = calls.filter((call) => call.gatewayPath === "/user/update");
      assert.equal(updates.length, expectedUpdates);
      if (updates.length > 0) {
        assert.equal(updates[0].init.body.tpm_limit, 2_000_000);
        assert.equal(updates[0].init.body.metadata.workspace.rateLimitRepairVersion, 2);
      }
    }
  });

  it("does not repair an explicit zero limit owned outside the Portal allocation flow", async () => {
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init = {}) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/user/info")) {
          return {
            user_id: "ada@example.com",
            max_budget: 100,
            rpm_limit: 0,
            tpm_limit: 0,
            metadata: { workspace: { allocationUpdatedVia: "external-admin", budgetManagedBy: "admin" } }
          };
        }
        if (gatewayPath.startsWith("/key/list")) {
          return { keys: [] };
        }
        return { data: [] };
      },
      async readUsageAnalytics() {
        return {
          timezone: "Asia/Shanghai",
          status: "pending",
          updatedAt: "",
          dataThroughDate: "",
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
    }));

    await api.getAccess({ request: new Request("https://portal.test/api/llm-gateway/access"), env: {} });

    assert.equal(calls.some((call) => call.gatewayPath === "/user/update"), false);
  });

  it("requires LiteLLM to return the one-time plaintext key", async () => {
    const tokenHash = await hashLiteLlmToken("sk-created");
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath) {
        if (gatewayPath.startsWith("/user/info")) {
          return { user_id: "ada@example.com", max_budget: 100 };
        }
        if (gatewayPath === "/key/generate") {
          return { token: tokenHash, token_id: tokenHash };
        }
        return {};
      }
    }));

    await assert.rejects(
      () => api.createAccessToken({
        request: new Request("https://portal.test/api/llm-gateway/access/tokens", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "missing-secret-key" })
        }),
        env: {}
      }),
      (error) => error.status === 502 && error.message === "gateway_token_create_missing_secret"
    );
  });

  it("rejects any LiteLLM token hash that disagrees with the plaintext key", async () => {
    const mismatchedHash = "f".repeat(64);

    for (const field of ["token_id", "token_hash", "key_hash", "token"]) {
      const api = createLlmGatewayAccessApi(makeDeps({
        async adminJson(_context, gatewayPath) {
          if (gatewayPath.startsWith("/user/info")) {
            return { user_id: "ada@example.com", max_budget: 100 };
          }
          if (gatewayPath === "/key/generate") {
            return { key: "sk-created", [field]: mismatchedHash };
          }
          return {};
        }
      }));

      await assert.rejects(
        () => api.createAccessToken({
          request: new Request("https://portal.test/api/llm-gateway/access/tokens", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: `mismatch-${field.replace("_", "-")}` })
          }),
          env: {}
        }),
        (error) => error.status === 502 && error.message === "gateway_token_create_identity_mismatch"
      );
    }
  });

  it("rejects invalid or silently truncated token names before calling LiteLLM", async () => {
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);
        return {};
      }
    }));

    for (const name of ["a", "team token", "-team", "team-", "名-key", "a".repeat(121)]) {
      await assert.rejects(
        () => api.createAccessToken({
          request: new Request("https://portal.test/api/llm-gateway/access/tokens", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name })
          }),
          env: {}
        }),
        (error) => error.status === 400 && error.message === "invalid_gateway_token_name"
      );
    }

    assert.deepEqual(calls, []);
  });

  it("creates a missing LiteLLM user with the default L1 budget and global rate limits", async () => {
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init = {}) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/user/info")) {
          throw Object.assign(new Error("not_found"), { status: 404 });
        }
        if (gatewayPath === "/user/new") {
          return {
            user_info: {
              user_id: init.body.user_id,
              max_budget: init.body.max_budget,
              budget_duration: init.body.budget_duration,
              models: []
            }
          };
        }
        if (gatewayPath === "/key/generate") {
          return {
            key: "sk-new-user-key",
            key_alias: init.body.key_alias,
            user_id: init.body.user_id,
            max_budget: init.body.max_budget,
            metadata: init.body.metadata
          };
        }
        return {};
      }
    }));

    const response = await api.createAccessToken({
      request: new Request("https://portal.test/api/llm-gateway/access/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "first-key" })
      }),
      env: {}
    });
    const createUserCall = calls.find((call) => call.gatewayPath === "/user/new");
    const generateKeyCall = calls.find((call) => call.gatewayPath === "/key/generate");

    assert.equal(response.status, 201);
    assert.equal(createUserCall.init.method, "POST");
    assert.equal(createUserCall.init.body.user_id, "ada@example.com");
    assert.equal(createUserCall.init.body.max_budget, 10);
    assert.equal(createUserCall.init.body.rpm_limit, 60);
    assert.equal(createUserCall.init.body.tpm_limit, 2_000_000);
    assert.equal(createUserCall.init.body.budget_duration, "30d");
    assert.equal(createUserCall.init.body.metadata.workspace.journeyLevelKey, "newcomer");
    assert.equal(createUserCall.init.body.metadata.workspace.baseMonthlyBudgetUsd, 10);
    assert.equal(createUserCall.init.body.metadata.workspace.budgetManagedBy, "journey-level");
    assert.equal(createUserCall.init.body.metadata.workspace.rateLimitRepairVersion, 2);
    assert.equal(generateKeyCall.init.body.max_budget, 10);
    assert.equal(generateKeyCall.init.body.budget_duration, "30d");
  });

  it("repairs an unlimited existing user from the materialized journey level before issuing a token", async () => {
    const calls = [];
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return { currentLevelKey: "explorer" };
              }
            };
          }
        };
      }
    };
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init = {}) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/user/info")) {
          return { user_id: "ada@example.com", max_budget: 0, metadata: {} };
        }
        if (gatewayPath === "/user/update") {
          return init.body;
        }
        if (gatewayPath.startsWith("/key/list")) {
          return { keys: [] };
        }
        if (gatewayPath === "/key/generate") {
          return { key: "sk-repaired", ...init.body };
        }
        return {};
      }
    }));

    const response = await api.createAccessToken({
      request: new Request("https://portal.test/api/llm-gateway/access/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "repaired-key" })
      }),
      env: { DB: db }
    });
    const userUpdate = calls.find((call) => call.gatewayPath === "/user/update");
    const keyCreate = calls.find((call) => call.gatewayPath === "/key/generate");

    assert.equal(response.status, 201);
    assert.equal(userUpdate.init.body.max_budget, 30);
    assert.equal(userUpdate.init.body.metadata.workspace.journeyLevelKey, "explorer");
    assert.equal(keyCreate.init.body.max_budget, 30);
  });

  it("repairs an unlimited existing user when personal access is opened", async () => {
    const calls = [];
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return { currentLevelKey: "explorer" };
              }
            };
          }
        };
      }
    };
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init = {}) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/user/info")) {
          return { user_id: "ada@example.com", max_budget: 0, metadata: {} };
        }
        if (gatewayPath === "/user/update") {
          return init.body;
        }
        if (gatewayPath.startsWith("/key/list")) {
          return { keys: [] };
        }
        if (gatewayPath.startsWith("/spend/logs")) {
          return [];
        }
        return { data: [] };
      }
    }));

    const response = await api.getAccess({
      request: new Request("https://portal.test/api/llm-gateway/access"),
      env: { DB: db }
    });
    const body = await response.json();
    const userUpdate = calls.find((call) => call.gatewayPath === "/user/update");

    assert.equal(response.status, 200);
    assert.equal(userUpdate.init.body.max_budget, 30);
    assert.equal(userUpdate.init.body.metadata.workspace.journeyLevelKey, "explorer");
    assert.equal(body.userLimit.monthlyBudgetUsd, 30);
  });

  it("retries the parallel key read once after provisioning a missing user", async () => {
    let userReady = false;
    let keyReads = 0;
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init = {}) {
        if (gatewayPath.startsWith("/user/info")) {
          throw Object.assign(new Error("not_found"), { status: 404 });
        }
        if (gatewayPath === "/user/new") {
          userReady = true;
          return { user_info: { user_id: init.body.user_id, max_budget: init.body.max_budget, models: [] } };
        }
        if (gatewayPath.startsWith("/key/list")) {
          keyReads += 1;
          if (!userReady) {
            throw Object.assign(new Error("user_not_found"), { status: 404 });
          }
          return { keys: [] };
        }
        return { data: [] };
      }
    }));

    const response = await api.getAccess({
      request: new Request("https://portal.test/api/llm-gateway/access"),
      env: {}
    });

    assert.equal(response.status, 200);
    assert.equal(keyReads, 2);
    assert.equal((await response.json()).userLimit.monthlyBudgetUsd, 10);
  });

  it("syncs a level budget to the LiteLLM user and all existing token percentages", async () => {
    const calls = [];
    const context = {
      request: new Request("https://portal.test/api/journey"),
      env: {}
    };
    const deps = {
      async adminJson(_context, gatewayPath, init = {}) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/user/info")) {
          return {
            user_info: {
              user_id: "ada@example.com",
              user_email: "ada@example.com",
              user_alias: "Ada",
              max_budget: 30,
              budget_duration: "30d",
              metadata: {
                trace: "keep-user-metadata",
                workspace: {
                  journeyLevelKey: "explorer",
                  baseMonthlyBudgetUsd: 30
                }
              }
            }
          };
        }
        if (gatewayPath.startsWith("/key/list")) {
          return {
            keys: [
              {
                token: "hash-full",
                user_id: "ada@example.com",
                max_budget: 30,
                tpm_limit: 120_000,
                metadata: {
                  trace: "keep-token-metadata",
                  workspace: { monthlyBudgetPercent: 100 }
                }
              },
              {
                token: "hash-half",
                user_id: "ada@example.com",
                max_budget: 15,
                tpm_limit: 80_000,
                metadata: { workspace: { monthlyBudgetPercent: 50 } }
              },
              {
                token: "hash-default",
                user_id: "ada@example.com",
                max_budget: 30,
                metadata: { legacy: true }
              }
            ]
          };
        }
        return init.body ?? {};
      }
    };

    await syncLiteLlmUserMonthlyBudget(context, currentUser, "builder", deps);

    const userUpdate = calls.find((call) => call.gatewayPath === "/user/update");
    const tokenUpdates = calls
      .filter((call) => call.gatewayPath === "/key/update")
      .map((call) => call.init.body)
      .sort((left, right) => left.key.localeCompare(right.key));

    assert.equal(userUpdate.init.body.max_budget, 100);
    assert.equal(userUpdate.init.body.budget_duration, "30d");
    assert.equal(userUpdate.init.body.metadata.trace, "keep-user-metadata");
    assert.equal(userUpdate.init.body.metadata.workspace.journeyLevelKey, "builder");
    assert.equal(userUpdate.init.body.metadata.workspace.baseMonthlyBudgetUsd, 100);
    assert.equal(userUpdate.init.body.metadata.workspace.budgetManagedBy, "journey-level");
    assert.equal(calls.find((call) => call.gatewayPath.startsWith("/key/list")).gatewayPath, "/key/list?user_id=ada%40example.com&return_full_object=true&size=100");
    assert.deepEqual(tokenUpdates.map((update) => ({
      key: update.key,
      maxBudget: update.max_budget,
      percent: update.metadata.workspace.monthlyBudgetPercent,
      tpmLimit: update.tpm_limit
    })), [
      { key: "hash-default", maxBudget: 100, percent: 100, tpmLimit: 2_000_000 },
      { key: "hash-full", maxBudget: 100, percent: 100, tpmLimit: 2_000_000 },
      { key: "hash-half", maxBudget: 50, percent: 50, tpmLimit: undefined }
    ]);
    assert.equal(tokenUpdates.find((update) => update.key === "hash-full").metadata.trace, "keep-token-metadata");
    assert.equal(tokenUpdates.find((update) => update.key === "hash-default").metadata.legacy, true);
  });

  it("defaults token usage purpose to agent and persists purpose-only updates", async () => {
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/user/info")) {
          return { user_id: "ada@example.com", max_budget: 100 };
        }
        if (gatewayPath.startsWith("/key/list")) {
          return {
            keys: [{
              token: "hash-1",
              key_alias: "Portal",
              user_id: "ada@example.com",
              metadata: { workspace: { issuedVia: "workspace-portal" } }
            }]
          };
        }
        if (gatewayPath === "/key/generate") {
          return {
            key: "sk-created",
            key_alias: init.body.key_alias,
            user_id: init.body.user_id,
            metadata: init.body.metadata
          };
        }
        if (gatewayPath === "/key/update") {
          return init.body;
        }
        return {};
      }
    }));

    const createResponse = await api.createAccessToken({
      request: new Request("https://portal.test/api/llm-gateway/access/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "agent-key" })
      }),
      env: {}
    });
    const createBody = await createResponse.json();
    await api.updateAccessToken({
      request: new Request("https://portal.test/api/llm-gateway/access/tokens/hash-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ usagePurpose: "app" })
      }),
      env: {}
    }, "hash-1");

    const generateCall = calls.find((call) => call.gatewayPath === "/key/generate");
    const updateCall = calls.find((call) => call.gatewayPath === "/key/update");
    assert.equal(createBody.tokenRecord.id, await hashLiteLlmToken("sk-created"));
    assert.equal(generateCall.init.body.metadata.workspace.usagePurpose, "agent");
    assert.equal(updateCall.init.body.metadata.workspace.usagePurpose, "app");
    assert.equal(updateCall.init.body.metadata.workspace.issuedVia, "workspace-portal");
  });

  it("grandfathers unchanged legacy aliases but validates actual renames", async () => {
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/key/list")) {
          return {
            keys: [{
              token: "hash-legacy",
              key_alias: "Legacy Key",
              user_id: "ada@example.com",
              metadata: { workspace: { usagePurpose: "agent" } }
            }]
          };
        }
        return init?.body ?? {};
      }
    }));
    const contextFor = (name) => ({
      request: new Request("https://portal.test/api/llm-gateway/access/tokens/hash-legacy", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, usagePurpose: "app" })
      }),
      env: {}
    });

    await api.updateAccessToken(contextFor("Legacy Key"), "hash-legacy");
    const unchangedUpdate = calls.find((call) => call.gatewayPath === "/key/update");
    assert.equal(Object.hasOwn(unchangedUpdate.init.body, "key_alias"), false);

    await assert.rejects(
      () => api.updateAccessToken(contextFor("New Key"), "hash-legacy"),
      (error) => error.status === 400 && error.message === "invalid_gateway_token_name"
    );
    assert.equal(calls.filter((call) => call.gatewayPath === "/key/update").length, 1);

    await api.updateAccessToken(contextFor("new-key"), "hash-legacy");
    const renameUpdates = calls.filter((call) => call.gatewayPath === "/key/update");
    assert.equal(renameUpdates[1].init.body.key_alias, "new-key");
  });

  it("tests the selected owned key with its raw bearer token and redacts the secret from JSON", async () => {
    const rawApiKey = "sk-test-this-key";
    const tokenHash = await hashLiteLlmToken(rawApiKey);
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath) {
        calls.push({ gatewayPath });
        return {
          keys: [{
            token: tokenHash,
            key_alias: "Portal",
            user_id: "ada@example.com",
            status: "active",
            models: ["gpt-5.5"]
          }]
        };
      },
      async fetch(url, init) {
        calls.push({ body: JSON.parse(init.body), init, url });
        return new Response(JSON.stringify({
          id: "chatcmpl_1",
          choices: [{ message: { content: `ok ${rawApiKey}` } }]
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "request-1"
          }
        });
      }
    }));

    const response = await api.testAccessToken({
      request: new Request(`https://portal.test/api/llm-gateway/access/tokens/${tokenHash}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: rawApiKey,
          model: "gpt-5.5",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 64
        })
      }),
      env: {}
    }, tokenHash);
    const body = await response.json();
    const proxyCall = calls.find((call) => call.url);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-request-id"), "request-1");
    assert.equal(body.choices[0].message.content, "ok [REDACTED]");
    assert.equal(proxyCall.url, "https://llm.example.com/v1/chat/completions");
    assert.equal(proxyCall.init.headers.Authorization, `Bearer ${rawApiKey}`);
    assert.equal(proxyCall.body.model, "gpt-5.5");
    assert.equal(proxyCall.body.stream, false);
    assert.equal("max_tokens" in proxyCall.body, false);
    assert.equal("temperature" in proxyCall.body, false);
    assert.equal("top_p" in proxyCall.body, false);
    assert.equal("apiKey" in proxyCall.body, false);
    assert.equal(proxyCall.init.signal instanceof AbortSignal, true);
    assert.equal(proxyCall.init.signal.aborted, false);
  });

  it("maps upstream token-test failures to safe stable codes without forwarding LiteLLM details", async () => {
    const rawApiKey = "sk-sensitive-test-key";
    const tokenHash = await hashLiteLlmToken(rawApiKey);
    const cases = [
      { expected: "gateway_token_auth_rejected", status: 401, type: "token_not_found_in_db" },
      { expected: "gateway_token_access_denied", status: 403, type: "permission_error" },
      { expected: "gateway_model_unavailable", status: 404, type: "model_not_found" },
      { expected: "gateway_token_budget_exceeded", status: 429, type: "budget_exceeded" },
      { expected: "gateway_token_budget_exceeded", status: 429, type: "auth_error", message: "Max budget limit reached" },
      { expected: "gateway_token_rate_limited", status: 429, type: "rate_limit_error" },
      { expected: "llm_gateway_test_unavailable", status: 500, type: "internal_server_error" },
      { expected: "gateway_test_request_rejected", status: 400, type: "bad_request" }
    ];

    for (const testCase of cases) {
      const testErrors = [];
      const api = createLlmGatewayAccessApi(makeDeps({
        async adminJson() {
          return { keys: [{ token: tokenHash, user_id: "ada@example.com", status: "active", models: ["gpt-5.5"] }] };
        },
        async fetch() {
          return new Response(JSON.stringify({
            error: {
              type: testCase.type,
              code: String(testCase.status),
              message: `${testCase.message ?? "private"} ${rawApiKey} ${tokenHash}`
            }
          }), {
            status: testCase.status,
            headers: { "x-request-id": "safe-request-id" }
          });
        },
        onTestError(event) {
          testErrors.push(event);
        }
      }));

      const response = await api.testAccessToken({
        request: new Request(`https://portal.test/api/llm-gateway/access/tokens/${tokenHash}/test`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            apiKey: rawApiKey,
            model: "gpt-5.5",
            messages: [{ role: "user", content: "Hello" }]
          })
        }),
        env: {}
      }, tokenHash);
      const body = await response.json();

      assert.equal(response.status, testCase.status);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(body, { error: testCase.expected, requestId: "safe-request-id" });
      assert.deepEqual(testErrors, [{
        code: testCase.expected,
        model: "gpt-5.5",
        requestId: "safe-request-id",
        upstreamStatus: testCase.status
      }]);
      assert.doesNotMatch(JSON.stringify(body), new RegExp(rawApiKey));
      assert.doesNotMatch(JSON.stringify(body), new RegExp(tokenHash));
    }
  });

  it("rejects an invalid successful LiteLLM response with a stable safe code", async () => {
    const rawApiKey = "sk-invalid-json-key";
    const tokenHash = await hashLiteLlmToken(rawApiKey);
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson() {
        return { keys: [{ token: tokenHash, user_id: "ada@example.com", status: "active", models: ["gpt-5.5"] }] };
      },
      async fetch() {
        return new Response("not-json", { status: 200 });
      }
    }));

    await assert.rejects(
      () => api.testAccessToken({
        request: new Request(`https://portal.test/api/llm-gateway/access/tokens/${tokenHash}/test`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            apiKey: rawApiKey,
            model: "gpt-5.5",
            messages: [{ role: "user", content: "Hello" }]
          })
        }),
        env: {}
      }, tokenHash),
      (error) => error.status === 502 && error.message === "llm_gateway_test_invalid_response"
    );
  });

  it("aborts a slow upstream token test and returns a stable timeout", async () => {
    const rawApiKey = "sk-timeout-key";
    const tokenHash = await hashLiteLlmToken(rawApiKey);
    let abortEvents = 0;
    let upstreamSignal;
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson() {
        return {
          keys: [{
            token: tokenHash,
            user_id: "ada@example.com",
            status: "active",
            models: ["gpt-5.5"]
          }]
        };
      },
      async fetch(_url, init) {
        upstreamSignal = init.signal;
        return await new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            abortEvents += 1;
            reject(new DOMException("The operation was aborted", "AbortError"));
          }, { once: true });
        });
      },
      testTimeoutMs: 5
    }));

    await assert.rejects(
      () => api.testAccessToken({
        request: new Request(`https://portal.test/api/llm-gateway/access/tokens/${tokenHash}/test`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            apiKey: rawApiKey,
            model: "gpt-5.5",
            messages: [{ role: "user", content: "Hello" }]
          })
        }),
        env: {}
      }, tokenHash),
      (error) => error.status === 504 && error.message === "llm_gateway_test_timeout"
    );

    assert.equal(upstreamSignal instanceof AbortSignal, true);
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(abortEvents, 1);
  });

  it("cancels the upstream token test when the portal client disconnects", async () => {
    const rawApiKey = "sk-client-cancel-key";
    const tokenHash = await hashLiteLlmToken(rawApiKey);
    const clientAbortController = new AbortController();
    let markFetchStarted;
    const fetchStarted = new Promise((resolve) => {
      markFetchStarted = resolve;
    });
    let upstreamSignal;
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson() {
        return {
          keys: [{
            token: tokenHash,
            user_id: "ada@example.com",
            status: "active",
            models: ["gpt-5.5"]
          }]
        };
      },
      async fetch(_url, init) {
        upstreamSignal = init.signal;
        markFetchStarted();
        return await new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          }, { once: true });
        });
      },
      testTimeoutMs: 10_000
    }));
    const pending = api.testAccessToken({
      request: new Request(`https://portal.test/api/llm-gateway/access/tokens/${tokenHash}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: rawApiKey,
          model: "gpt-5.5",
          messages: [{ role: "user", content: "Hello" }]
        }),
        signal: clientAbortController.signal
      }),
      env: {}
    }, tokenHash);
    const rejection = assert.rejects(
      pending,
      (error) => error.status === 502 && error.message === "llm_gateway_test_unavailable"
    );

    await fetchStarted;
    clientAbortController.abort();
    await rejection;

    assert.equal(upstreamSignal instanceof AbortSignal, true);
    assert.equal(upstreamSignal.aborted, true);
  });

  it("rejects unowned, inactive, disallowed-model, and mismatched token tests before proxying", async () => {
    const rawApiKey = "sk-test-this-key";
    const tokenHash = await hashLiteLlmToken(rawApiKey);
    const cases = [
      {
        expectedMessage: "gateway_token_not_found",
        expectedStatus: 404,
        token: { token: tokenHash, user_id: "other@example.com", status: "active", models: ["gpt-5.5"] }
      },
      {
        expectedMessage: "gateway_token_inactive",
        expectedStatus: 409,
        token: { token: tokenHash, user_id: "ada@example.com", status: "revoked", models: ["gpt-5.5"] }
      },
      {
        expectedMessage: "gateway_token_suspended",
        expectedStatus: 409,
        token: { token: tokenHash, user_id: "ada@example.com", status: "active", blocked: true, models: ["gpt-5.5"] }
      },
      {
        expectedMessage: "gateway_token_model_not_allowed",
        expectedStatus: 403,
        token: { token: tokenHash, user_id: "ada@example.com", status: "active", models: ["other-model"] }
      }
    ];

    for (const testCase of cases) {
      let fetchCalls = 0;
      const api = createLlmGatewayAccessApi(makeDeps({
        async adminJson() {
          return { keys: [testCase.token] };
        },
        async fetch() {
          fetchCalls += 1;
          return new Response("{}");
        }
      }));

      await assert.rejects(
        () => api.testAccessToken({
          request: new Request(`https://portal.test/api/llm-gateway/access/tokens/${tokenHash}/test`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              apiKey: rawApiKey,
              model: "gpt-5.5",
              messages: [{ role: "user", content: "Hello" }]
            })
          }),
          env: {}
        }, tokenHash),
        (error) => error.status === testCase.expectedStatus && error.message === testCase.expectedMessage
      );
      assert.equal(fetchCalls, 0);
    }

    let fetchCalls = 0;
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson() {
        return { keys: [{ token: tokenHash, user_id: "ada@example.com", status: "active", models: ["gpt-5.5"] }] };
      },
      async fetch() {
        fetchCalls += 1;
        return new Response("{}");
      }
    }));
    await assert.rejects(
      () => api.testAccessToken({
        request: new Request(`https://portal.test/api/llm-gateway/access/tokens/${tokenHash}/test`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            apiKey: "sk-wrong-key",
            model: "gpt-5.5",
            messages: [{ role: "user", content: "Hello" }]
          })
        }),
        env: {}
      }, tokenHash),
      (error) => error.status === 400 && error.message === "gateway_token_secret_mismatch"
    );
    assert.equal(fetchCalls, 0);
  });

  it("dispatches the personal token test route before generic token handling", async () => {
    const calls = [];
    const response = await dispatchLlmGatewayRoutes({
      request: new Request("https://portal.test/api/llm-gateway/access/tokens/hash%2F1/test", { method: "POST" }),
      env: {}
    }, {
      llmGatewayAccessApi: {
        async testAccessToken(_context, tokenId) {
          calls.push(tokenId);
          return new Response(JSON.stringify({ tested: tokenId }), {
            headers: { "content-type": "application/json" }
          });
        }
      }
    }, "llm-gateway/access/tokens/hash%2F1/test");

    assert.deepEqual(await response.json(), { tested: "hash/1" });
    assert.deepEqual(calls, ["hash/1"]);
  });

  it("rotates an owned token and returns the replacement secret without exposing it as the token id", async () => {
    const calls = [];
    const rawRotatedToken = "sk-rotated-secret";
    const expectedTokenHash = await hashLiteLlmToken(rawRotatedToken);
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/key/list")) {
          return {
            keys: [{
              token: "hash-old",
              key_alias: "agent-key",
              user_id: "ada@example.com",
              models: ["gpt-5.5"],
              max_budget: 42,
              spend: 3.5,
              rpm_limit: 20,
              tpm_limit: 40_000,
              budget_duration: "30d",
              metadata: { trace: "preserve", workspace: { usagePurpose: "agent" } }
            }]
          };
        }
        if (gatewayPath === "/key/generate") {
          return { key: rawRotatedToken, token_id: expectedTokenHash };
        }
        return init?.body ?? {};
      }
    }));

    const response = await api.rotateAccessToken({
      request: new Request("https://portal.test/api/llm-gateway/access/tokens/hash-old/rotate", { method: "POST" }),
      env: {}
    }, "hash-old");
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.token, rawRotatedToken);
    assert.equal(body.tokenRecord.id, expectedTokenHash);
    assert.notEqual(body.tokenRecord.id, rawRotatedToken);
    assert.equal(body.tokenRecord.name, "agent-key");
    assert.equal(body.tokenRecord.externalUserId, "ada@example.com");
    assert.deepEqual(body.tokenRecord.allowedModels, ["gpt-5.5"]);
    assert.deepEqual(calls.map((call) => call.gatewayPath), [
      "/key/list?user_id=ada%40example.com&return_full_object=true&size=100",
      "/key/generate",
      "/key/block",
      "/key/update",
      "/key/update"
    ]);
    const generateBody = calls[1].init.body;
    const oldArchiveBody = calls[3].init.body;
    assert.match(generateBody.key_alias, /^agent-key-rotate-hash-old-/);
    assert.equal(generateBody.key_type, "llm_api");
    assert.equal(generateBody.user_id, "ada@example.com");
    assert.deepEqual(generateBody.models, ["gpt-5.5"]);
    assert.equal(generateBody.max_budget, 42);
    assert.equal(generateBody.spend, 3.5);
    assert.equal(generateBody.rpm_limit, 20);
    assert.equal(generateBody.tpm_limit, 40_000);
    assert.equal(generateBody.budget_duration, "30d");
    assert.equal("budget_id" in generateBody, false);
    assert.equal(generateBody.metadata.trace, "preserve");
    assert.match(generateBody.metadata.workspace.credentialId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(generateBody.metadata.workspace.generation, 2);
    assert.equal(generateBody.metadata.workspace.rotatedFromTokenId, "hash-old");
    assert.deepEqual(generateBody.metadata.workspace.previousTokenIds, ["hash-old"]);
    assert.equal(generateBody.metadata.workspace.rotatedVia, "workspace-portal-replacement");
    assert.deepEqual(calls[2].init.body, { key: "hash-old" });
    assert.equal(oldArchiveBody.key, "hash-old");
    assert.notEqual(oldArchiveBody.key_alias, "agent-key");
    assert.equal(oldArchiveBody.metadata.trace, "preserve");
    assert.equal(oldArchiveBody.metadata.workspace.credentialId, generateBody.metadata.workspace.credentialId);
    assert.equal(oldArchiveBody.metadata.workspace.generation, 1);
    assert.equal(oldArchiveBody.metadata.workspace.lifecycle, "rotated");
    assert.equal(oldArchiveBody.metadata.workspace.rotatedToTokenId, expectedTokenHash);
    assert.match(oldArchiveBody.metadata.workspace.rotatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(calls[4].init.body, { key: expectedTokenHash, key_alias: "agent-key" });
    assert.equal(calls.some((call) => call.gatewayPath === "/key/delete"), false);
    assert.equal(body.warning, undefined);
  });

  it("preserves an existing credential lineage when rotating a later generation", async () => {
    const rawRotatedToken = "sk-later-generation";
    const replacementHash = await hashLiteLlmToken(rawRotatedToken);
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/key/list")) {
          return { keys: [{
            token: "hash-generation-4",
            key_alias: "agent-key",
            user_id: "ada@example.com",
            budget_id: "budget-shared-1",
            budget_duration: "30d",
            budget_reset_at: "2026-08-01T00:00:00.000Z",
            metadata: {
              workspace: {
                credentialId: "credential-existing",
                generation: 4,
                previousTokenIds: ["hash-generation-1", "hash-generation-2", "hash-generation-3"],
                rotatedFromTokenId: "hash-generation-3",
                usagePurpose: "agent"
              }
            }
          }] };
        }
        if (gatewayPath === "/key/generate") return { key: rawRotatedToken, token_id: replacementHash };
        return init?.body ?? {};
      }
    }));

    const body = await (await api.rotateAccessToken({
      request: new Request("https://portal.test/api/llm-gateway/access/tokens/hash-generation-4/rotate", { method: "POST" }),
      env: {}
    }, "hash-generation-4")).json();

    const generateBody = calls.find((call) => call.gatewayPath === "/key/generate").init.body;
    const oldArchiveBody = calls.find((call) => call.gatewayPath === "/key/update" && call.init.body.key === "hash-generation-4").init.body;
    assert.equal(generateBody.metadata.workspace.credentialId, "credential-existing");
    assert.equal(generateBody.metadata.workspace.generation, 5);
    assert.equal(generateBody.rpm_limit, 60);
    assert.equal(generateBody.tpm_limit, 2_000_000);
    assert.equal(generateBody.budget_id, "budget-shared-1");
    assert.equal("budget_duration" in generateBody, false);
    assert.deepEqual(generateBody.metadata.workspace.previousTokenIds, [
      "hash-generation-1",
      "hash-generation-2",
      "hash-generation-3",
      "hash-generation-4"
    ]);
    assert.equal(oldArchiveBody.metadata.workspace.credentialId, "credential-existing");
    assert.equal(oldArchiveBody.metadata.workspace.generation, 4);
    assert.equal(body.tokenRecord.metadata.workspace.credentialId, "credential-existing");
    assert.equal(body.tokenRecord.metadata.workspace.generation, 5);
  });

  it("removes only the unused replacement when blocking the old key clearly fails", async () => {
    const rawRotatedToken = "sk-rotation-compensation";
    const replacementHash = await hashLiteLlmToken(rawRotatedToken);
    const calls = [];
    const deleteBodies = [];
    let listCalls = 0;
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/key/list")) {
          listCalls += 1;
          return { keys: [{ token: "hash-old", key_alias: "agent-key", user_id: "ada@example.com", blocked: false }] };
        }
        if (gatewayPath === "/key/generate") {
          return { key: rawRotatedToken, token_id: replacementHash };
        }
        if (gatewayPath === "/key/block") throw new Error("old block failed");
        if (gatewayPath === "/key/delete") {
          deleteBodies.push(init.body);
          return {};
        }
        return {};
      }
    }));

    await assert.rejects(
      () => api.rotateAccessToken({
        request: new Request("https://portal.test/api/llm-gateway/access/tokens/hash-old/rotate", { method: "POST" }),
        env: {}
      }, "hash-old"),
      (error) => error.status === 502 && error.message === "gateway_token_rotation_old_key_block_failed"
    );
    assert.equal(listCalls, 2);
    assert.deepEqual(calls.find((call) => call.gatewayPath === "/key/block").init.body, { key: "hash-old" });
    assert.deepEqual(deleteBodies, [{ keys: [replacementHash], reason: "rotation_compensation" }]);
    assert.equal(deleteBodies.some((body) => body.keys.includes("hash-old")), false);
  });

  it("keeps the copyable replacement when a failed block response reads back as blocked", async () => {
    const rawRotatedToken = "sk-rotation-blocked-readback";
    const replacementHash = await hashLiteLlmToken(rawRotatedToken);
    const calls = [];
    let listCalls = 0;
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/key/list")) {
          listCalls += 1;
          return { keys: [{
            token: "hash-old",
            key_alias: "agent-key",
            user_id: "ada@example.com",
            blocked: listCalls > 1
          }] };
        }
        if (gatewayPath === "/key/generate") return { key: rawRotatedToken, token_id: replacementHash };
        if (gatewayPath === "/key/block") throw new Error("ambiguous block response");
        return init?.body ?? {};
      }
    }));

    const response = await api.rotateAccessToken({
      request: new Request("https://portal.test/api/llm-gateway/access/tokens/hash-old/rotate", { method: "POST" }),
      env: {}
    }, "hash-old");
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.token, rawRotatedToken);
    assert.equal(body.tokenRecord.id, replacementHash);
    assert.equal(listCalls, 2);
    assert.equal(calls.some((call) => call.gatewayPath === "/key/delete"), false);
    assert.equal(calls.some((call) => call.gatewayPath === "/key/update" && call.init.body.key === "hash-old"), true);
  });

  it("returns the copyable replacement secret when only the final alias restore fails", async () => {
    const rawRotatedToken = "sk-rotation-alias-pending";
    const replacementHash = await hashLiteLlmToken(rawRotatedToken);
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init) {
        if (gatewayPath.startsWith("/key/list")) {
          return { keys: [{ token: "hash-old", key_alias: "Legacy Key", user_id: "ada@example.com" }] };
        }
        if (gatewayPath === "/key/generate") {
          return { key: rawRotatedToken, token_id: replacementHash };
        }
        if (gatewayPath === "/key/update" && init.body.key === replacementHash) throw new Error("alias update failed");
        return {};
      }
    }));

    const response = await api.rotateAccessToken({
      request: new Request("https://portal.test/api/llm-gateway/access/tokens/hash-old/rotate", { method: "POST" }),
      env: {}
    }, "hash-old");
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.token, rawRotatedToken);
    assert.equal(body.tokenRecord.id, replacementHash);
    assert.match(body.tokenRecord.name, /^Legacy-Key-rotate-hash-old-/);
    assert.equal(body.warning, "gateway_token_rotation_alias_pending");
  });

  it("returns the replacement secret with a warning when archiving old-key metadata fails", async () => {
    const rawRotatedToken = "sk-rotation-archive-pending";
    const replacementHash = await hashLiteLlmToken(rawRotatedToken);
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init) {
        if (gatewayPath.startsWith("/key/list")) {
          return { keys: [{ token: "hash-old", key_alias: "agent-key", user_id: "ada@example.com" }] };
        }
        if (gatewayPath === "/key/generate") {
          return { key: rawRotatedToken, token_id: replacementHash };
        }
        if (gatewayPath === "/key/update" && init.body.key === "hash-old") throw new Error("archive update failed");
        return {};
      }
    }));

    const response = await api.rotateAccessToken({
      request: new Request("https://portal.test/api/llm-gateway/access/tokens/hash-old/rotate", { method: "POST" }),
      env: {}
    }, "hash-old");
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.token, rawRotatedToken);
    assert.equal(body.tokenRecord.id, replacementHash);
    assert.equal(body.tokenRecord.name, "agent-key");
    assert.ok(body.warning);
  });

  it("does not rotate a token owned by another user", async () => {
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);
        return { keys: [{ token: "hash-old", user_id: "other@example.com" }] };
      }
    }));

    await assert.rejects(
      () => api.rotateAccessToken({
        request: new Request("https://portal.test/api/llm-gateway/access/tokens/hash-old/rotate", { method: "POST" }),
        env: {}
      }, "hash-old"),
      (error) => error.status === 404 && error.message === "gateway_token_not_found"
    );
    assert.deepEqual(calls, ["/key/list?user_id=ada%40example.com&return_full_object=true&size=100"]);
  });

  it("rejects updates for tokens owned by another user", async () => {
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      async adminJson(_context, gatewayPath, init) {
        calls.push({ gatewayPath, init });
        return {
          keys: [{
            token: "tok_1",
            key_alias: "Other",
            user_id: "other@example.com"
          }]
        };
      }
    }));

    await assert.rejects(
      () => api.updateAccessToken({
        request: new Request("https://portal.test/api/llm-gateway/access/tokens/tok_1", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Renamed" })
        }),
        env: {}
      }, "tok_1"),
      (error) => error.status === 404 && error.message === "gateway_token_not_found"
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].gatewayPath, "/key/list?user_id=ada%40example.com&return_full_object=true&size=100");
  });

  it("maps the current user to gateway external scope", () => {
    assert.deepEqual(llmGatewayUserScope(currentUser), {
      externalOrgId: "tenant-1",
      externalTeamId: "AI Adoption",
      externalUserId: "ada@example.com",
      externalAppId: ""
    });
  });
});


describe("gateway rotation audit retention", () => {
  const rawKey = "sk-audit-replacement-secret";
  function fixture({ rejectIntent = false, rejectOutcome = false, rejectGenerate = false } = {}) {
    const rows = [];
    const calls = [];
    const db = {
      prepare(sql) {
        assert.match(sql, /INSERT INTO audit_logs/);
        let values;
        return {
          bind(...args) { values = args; return this; },
          async run() {
            if ((rejectIntent && rows.length === 0) || (rejectOutcome && rows.length > 0)) throw new Error("audit unavailable");
            rows.push(values);
          }
        };
      }
    };
    const api = createLlmGatewayAccessApi(makeDeps({
      audit: undefined,
      clock: () => new Date("2026-10-07T08:00:00.000Z"),
      async adminJson(_context, path, init) {
        calls.push(path);
        if (path.startsWith("/key/list")) return { keys: [{
          token: "hash-old", key_alias: "agent-key", user_id: currentUser.email, metadata: {}
        }] };
        if (path === "/key/generate") {
          assert.equal(rows.length, 1, "intent must be durable before key creation");
          if (rejectGenerate) throw new Error("upstream failure with secret that must not be logged");
          return { key: rawKey };
        }
        return init?.body ?? {};
      }
    }));
    const context = { env: { DB: db }, request: new Request("https://portal.test/api/llm-gateway/access/tokens/hash-old/rotate", { method: "POST" }) };
    return { rows, calls, rotate: () => api.rotateAccessToken(context, "hash-old") };
  }

  it("persists actor, timestamp, result and key hashes without secret material", async () => {
    const { rows, rotate } = fixture();
    const response = await rotate();
    assert.equal(response.status, 201);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.slice(1, 6)), [
      ["user", currentUser.id, "requested gateway token rotation", "gateway_token", "hash-old"],
      ["user", currentUser.id, "completed gateway token rotation", "gateway_token", "hash-old"]
    ]);
    const [intent, outcome] = rows.map((row) => JSON.parse(row[6]));
    assert.equal(intent.actorEmail, currentUser.email);
    assert.equal(intent.startedAt, "2026-10-07T08:00:00.000Z");
    assert.equal(intent.operationId, outcome.operationId);
    assert.equal(outcome.outcome, "completed");
    assert.equal(outcome.oldKeyBlocked, true);
    assert.equal(outcome.newTokenId, await hashLiteLlmToken(rawKey));
    assert.equal(outcome.finishedAt, intent.startedAt);
    assert.equal(JSON.stringify(rows).includes(rawKey), false);
  });

  it("refuses rotation when durable audit storage is missing", async () => {
    const calls = [];
    const api = createLlmGatewayAccessApi(makeDeps({
      audit: undefined,
      async adminJson(_context, path) {
        calls.push(path);
        return { keys: [{ token: "hash-old", user_id: currentUser.email, metadata: {} }] };
      }
    }));
    await assert.rejects(() => api.rotateAccessToken({ env: {}, request: new Request("https://portal.test/rotate", { method: "POST" }) }, "hash-old"),
      (error) => error.status === 503 && error.message === "gateway_token_rotation_audit_unavailable");
    assert.equal(calls.some((path) => !path.startsWith("/key/list")), false);
  });

  it("leaves both keys unchanged if the initial audit cannot be saved", async () => {
    const { calls, rotate } = fixture({ rejectIntent: true });
    await assert.rejects(rotate, /audit unavailable/);
    assert.equal(calls.some((path) => ["/key/generate", "/key/block", "/key/update"].includes(path)), false);
  });

  it("retains a failed attempt without saving raw upstream error text", async () => {
    const { rows, rotate } = fixture({ rejectGenerate: true });
    await assert.rejects(rotate, /upstream failure/);
    const outcome = JSON.parse(rows[1][6]);
    assert.equal(outcome.outcome, "failed");
    assert.equal(outcome.oldKeyBlocked, false);
    assert.equal(outcome.newTokenId, null);
    assert.equal(JSON.stringify(rows).includes("secret that must not be logged"), false);
  });

  it("still delivers the replacement secret if the outcome audit fails after rotation", async () => {
    const { rows, rotate } = fixture({ rejectOutcome: true });
    const response = await rotate();
    assert.equal((await response.json()).token, rawKey);
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0][6]).outcome, "started");
  });
});
