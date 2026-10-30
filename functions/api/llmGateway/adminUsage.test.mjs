import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlmGatewayAdminUsageApi, gatewayRequestsCsv, usageRequestExportParams } from "./adminUsage.ts";

const adminUser = {
  id: "admin-1",
  name: "Ada",
  email: "ada@example.com",
  team: "AI Adoption",
  role: "admin",
  identity: {
    provider: "microsoft_entra_id",
    objectId: "oid-1",
    tenantId: "tenant-1"
  }
};

class MemoryKv {
  constructor(entries = []) {
    this.store = new Map(entries);
    this.puts = [];
    this.deletes = [];
  }

  async get(key) {
    return this.store.get(key) ?? null;
  }

  async put(key, value, options) {
    this.puts.push({ key, value, options });
    this.store.set(key, value);
  }

  async delete(key) {
    this.deletes.push(key);
    this.store.delete(key);
  }
}

function makeDeps(overrides = {}) {
  return {
    async adminJson() {
      return {};
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
    async requireAdminPortalUser() {
      return adminUser;
    },
    ...overrides
  };
}

describe("llm gateway admin usage service", () => {
  it("loads ledger usage, bounded requests, and token metadata without daily activity", async () => {
    const calls = [];
    const api = createLlmGatewayAdminUsageApi(makeDeps({
      async readUsageLedgerCoverage() {
        return { available: true, dataThroughDate: "2026-06-01" };
      },
      async readAdminUsageLedger() {
        return {
          available: true,
          usage: [
            { scopeType: "user", scopeId: "ada@example.com", estimatedCostUsd: 0.75 },
            { scopeType: "token", scopeId: "hash-1", cachedInputTokens: 160 }
          ],
          series: [{ periodStart: "2026-06-01 00:00:00", groupType: "model", groupId: "tencent-hy3-preview" }],
          requestTotal: 2
        };
      },
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);

        if (gatewayPath.startsWith("/spend/logs/v2")) {
          return {
            data: [
              {
                request_id: "req_2",
                api_key: "hash-1",
                user: "ada@example.com",
                model: "tencent-hy3-preview",
                spend: 0.5,
                total_tokens: 240,
                prompt_tokens: 160,
                completion_tokens: 80,
                startTime: "2026-06-03T00:00:00Z"
              },
              {
                request_id: "req_1",
                api_key: "hash-1",
                user: "ada@example.com",
                model: "tencent-hy3-preview",
                spend: 0.25,
                total_tokens: 120,
                prompt_tokens: 80,
                completion_tokens: 40,
                startTime: "2026-06-02T00:00:00Z"
              }
            ],
            total: 2,
            page: 1,
            page_size: 10,
            total_pages: 1
          };
        }

        if (gatewayPath.startsWith("/key/list")) {
          return { keys: [{ token: "hash-1", key_alias: "Portal", user_id: "ada@example.com" }] };
        }

        return [];
      }
    }));

    const response = await api.getAdminUsage({
      request: new Request("https://portal.test/api/llm-gateway/admin/usage?periodType=month&groupBy=model&from=2026-06-01&to=2026-06-02"),
      env: {}
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("server-timing"), /^auth;dur=\d+, data;dur=\d+, total;dur=\d+$/);
    assert.equal(body.source.provider, "litellm");
    assert.equal(body.source.mode, "admin-api");
    assert.deepEqual(body.source.range, { from: "2026-06-01", to: "2026-06-02" });
    assert.equal(body.requestTotal, 2);
    assert.equal(body.series[0].groupType, "model");
    assert.equal(body.series[0].groupId, "tencent-hy3-preview");
    assert.equal(body.usage.find((row) => row.scopeType === "user").estimatedCostUsd, 0.75);
    assert.equal(body.usage.find((row) => row.scopeType === "token").cachedInputTokens, 160);
    assert.deepEqual(calls, [
      "/spend/logs/v2?start_date=2026-06-01+00%3A00%3A00&end_date=2026-06-02+23%3A59%3A59&page=1&page_size=10&sort_by=startTime&sort_order=desc",
      "/key/list?return_full_object=true&page=1&size=100"
    ]);
  });

  it("fails closed without touching LiteLLM when the daily ledger is unavailable", async () => {
    const calls = [];
    const api = createLlmGatewayAdminUsageApi(makeDeps({
      async readUsageLedgerCoverage() {
        return { available: false };
      },
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);
        return {};
      }
    }));

    await assert.rejects(
      () => api.getAdminUsage({
        request: new Request("https://portal.test/api/llm-gateway/admin/usage?from=2026-09-01&to=2026-09-22"),
        env: {}
      }),
      (error) => error.status === 503 && error.message === "usage_ledger_unavailable"
    );
    assert.deepEqual(calls, []);
  });

  it("serves only available ledger history and still rejects oversized ranges", async () => {
    const calls = [];
    let ledgerInput;
    const api = createLlmGatewayAdminUsageApi(makeDeps({
      async readUsageLedgerCoverage() {
        return { available: true, dataThroughDate: "2026-08-15" };
      },
      async readAdminUsageLedger(_db, input) {
        ledgerInput = input;
        return { available: true, usage: [], series: [], requestTotal: 0 };
      },
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);
        if (gatewayPath.startsWith("/spend/logs/v2")) return { data: [] };
        if (gatewayPath.startsWith("/key/list")) return { keys: [] };
        throw new Error(`unexpected upstream call: ${gatewayPath}`);
      }
    }));

    const response = await api.getAdminUsage({
      request: new Request("https://portal.test/api/llm-gateway/admin/usage?from=2026-08-01&to=2026-08-20"),
      env: {}
    });
    assert.equal(response.status, 200);
    assert.equal(ledgerInput.toDate, "2026-08-15");
    assert.ok(!calls.some((path) => path.startsWith("/user/daily/activity/aggregated")));
    calls.length = 0;
    await assert.rejects(
      () => api.getAdminUsage({
        request: new Request("https://portal.test/api/llm-gateway/admin/usage?from=2026-07-13&to=2026-09-22"),
        env: {}
      }),
      (error) => error.status === 400 && error.message === "admin_usage_range_too_large"
    );
    assert.deepEqual(calls, []);
  });

  it("serves closed admin aggregates from D1 without calling LiteLLM daily activity", async () => {
    const calls = [];
    let ledgerInput;
    const api = createLlmGatewayAdminUsageApi(makeDeps({
      async readUsageLedgerCoverage() {
        return { available: true, dataThroughDate: "2026-08-19" };
      },
      async readAdminUsageLedger(_db, input) {
        ledgerInput = input;
        return {
          available: true,
          usage: [{
            id: "d1:model:m1",
            scopeType: "model",
            scopeId: "tencent-glm-5.3",
            periodType: "month",
            periodStart: "2026-08-01 00:00:00",
            periodEnd: "2026-08-19 23:59:59",
            requests: 12,
            blockedRequests: 0,
            failedRequests: 0,
            inputTokens: 10_000,
            outputTokens: 2_000,
            cachedInputTokens: 4_000,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
            billableUnits: 12_000,
            estimatedCostUsd: 0.25,
            updatedAt: "2026-08-20T00:00:00.000Z"
          }],
          series: [{
            periodStart: "2026-08-19 00:00:00",
            groupType: "model",
            groupId: "tencent-glm-5.3",
            requests: 12,
            blockedRequests: 0,
            failedRequests: 0,
            inputTokens: 10_000,
            outputTokens: 2_000,
            cachedInputTokens: 4_000,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
            billableUnits: 12_000,
            estimatedCostUsd: 0.25
          }],
          requestTotal: 12
        };
      },
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);
        if (gatewayPath.startsWith("/spend/logs/v2")) {
          return { data: [], total: 0, page: 1, page_size: 10, total_pages: 0 };
        }
        if (gatewayPath.startsWith("/key/list")) return { keys: [] };
        throw new Error(`unexpected upstream call: ${gatewayPath}`);
      }
    }));

    const body = await (await api.getAdminUsage({
      request: new Request("https://portal.test/api/llm-gateway/admin/usage?from=2026-08-01&to=2026-08-19&groupBy=model"),
      env: {}
    })).json();

    assert.deepEqual(ledgerInput, {
      fromDate: "2026-08-01",
      toDate: "2026-08-19",
      groupBy: "model",
      scopeType: "",
      scopeId: ""
    });
    assert.equal(body.requestTotal, 12);
    assert.equal(body.usage[0].cachedInputTokens, 4_000);
    assert.equal(body.series[0].groupId, "tencent-glm-5.3");
    assert.ok(body.source.endpoints.includes("d1:gateway_usage_daily_model_snapshots"));
    assert.ok(!calls.some((path) => path.startsWith("/user/daily/activity/aggregated")));
  });

  it("does not query LiteLLM daily activity for an unclosed ledger tail", async () => {
    const calls = [];
    const metricRow = {
      id: "d1:model:m1",
      scopeType: "model",
      scopeId: "tencent-glm-5.3",
      periodType: "month",
      periodStart: "2026-08-01 00:00:00",
      periodEnd: "2026-08-19 23:59:59",
      requests: 10,
      blockedRequests: 0,
      failedRequests: 0,
      inputTokens: 1_000,
      outputTokens: 100,
      cachedInputTokens: 800,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
      billableUnits: 1_100,
      estimatedCostUsd: 0.1,
      updatedAt: "2026-08-20T00:00:00.000Z"
    };
    const api = createLlmGatewayAdminUsageApi(makeDeps({
      async readUsageLedgerCoverage() {
        return { available: true, dataThroughDate: "2026-08-19" };
      },
      async readAdminUsageLedger() {
        return { available: true, usage: [metricRow], series: [], requestTotal: 10 };
      },
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);
        if (gatewayPath.startsWith("/spend/logs/v2")) return { data: [] };
        if (gatewayPath.startsWith("/key/list")) return { keys: [] };
        throw new Error(`unexpected upstream call: ${gatewayPath}`);
      }
    }));

    const body = await (await api.getAdminUsage({
      request: new Request("https://portal.test/api/llm-gateway/admin/usage?from=2026-08-01&to=2026-08-20&groupBy=model"),
      env: {}
    })).json();

    assert.ok(!calls.some((path) => path.startsWith("/user/daily/activity/aggregated")));
    assert.equal(body.requestTotal, 10);
    assert.equal(body.usage.find((row) => row.scopeType === "model").requests, 10);
    assert.equal(body.usage.find((row) => row.scopeType === "model").billableUnits, 1_100);
  });

  it("paginates the complete key catalog used for user attribution", async () => {
    const keyCalls = [];
    const api = createLlmGatewayAdminUsageApi(makeDeps({
      async readUsageLedgerCoverage() {
        return { available: true, dataThroughDate: "2026-08-19" };
      },
      async readAdminUsageLedger() {
        return { available: true, usage: [], series: [], requestTotal: 0 };
      },
      async adminJson(_context, gatewayPath) {
        if (gatewayPath.startsWith("/spend/logs/v2")) return { data: [] };
        if (gatewayPath.startsWith("/key/list")) {
          keyCalls.push(gatewayPath);
          const page = new URL(`https://x.test${gatewayPath}`).searchParams.get("page");
          return page === "1"
            ? { keys: Array.from({ length: 100 }, (_, index) => ({ token: `hash-${index}`, user_id: `user-${index}` })) }
            : { keys: [{ token: "hash-100", user_id: "user-100" }] };
        }
        return {};
      }
    }));

    const body = await (await api.getAdminUsage({
      request: new Request("https://portal.test/api/llm-gateway/admin/usage?from=2026-08-01&to=2026-08-20"),
      env: {}
    })).json();

    assert.equal(body.tokens.length, 101);
    assert.equal(keyCalls.length, 2);
    assert.match(keyCalls[1], /page=2/);
  });

  it("propagates LiteLLM spend failures instead of reporting empty usage", async () => {
    const upstreamError = Object.assign(new Error("litellm_unavailable"), { status: 502 });
    const api = createLlmGatewayAdminUsageApi(makeDeps({
      clock() {
        return new Date("2026-08-20T08:00:00.000Z");
      },
      async readUsageLedgerCoverage() {
        return { available: true, dataThroughDate: "2026-08-19" };
      },
      async readAdminUsageLedger() {
        return { available: true, usage: [], series: [], requestTotal: 0 };
      },
      async adminJson(_context, gatewayPath) {
        if (gatewayPath.startsWith("/spend/logs/v2")) {
          throw upstreamError;
        }
        return { keys: [] };
      }
    }));

    await assert.rejects(
      () => api.getAdminUsage({
        request: new Request("https://portal.test/api/llm-gateway/admin/usage"),
        env: {}
      }),
      (error) => error === upstreamError
    );
  });

  it("creates a one-time export ticket with sanitized request filters", async () => {
    const kv = new MemoryKv();
    const calls = [];
    const api = createLlmGatewayAdminUsageApi(makeDeps({
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);
        return {};
      }
    }));

    const response = await api.createUsageExportLink({
      request: new Request("https://portal.test/api/llm-gateway/admin/usage/export-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: "2026-06-01",
          to: "2026-06-30",
          scopeType: "user",
          scopeId: "user-1"
        })
      }),
      env: { PORTAL_KV: kv }
    });
    const body = await response.json();
    const ticket = new URL(body.url).searchParams.get("ticket");
    const saved = JSON.parse(kv.puts[0].value);

    assert.equal(response.status, 200);
    assert.equal(body.total, undefined);
    assert.match(body.url, /^https:\/\/portal\.test\/api\/llm-gateway\/admin\/usage\/export\?ticket=/);
    assert.equal(kv.puts[0].key, `llm_usage_export:${ticket}`);
    assert.equal(kv.puts[0].options.expirationTtl, 600);
    assert.deepEqual(saved.params, {
      from: "2026-06-01",
      to: "2026-06-30",
      scopeType: "user",
      scopeId: "user-1"
    });
    assert.equal(saved.requestedBy, "ada@example.com");
    assert.deepEqual(calls, []);
  });

  it("downloads an export ticket once and renders request CSV", async () => {
    const kv = new MemoryKv([[
      "llm_usage_export:abc",
      JSON.stringify({
        params: { from: "2026-07-01", to: "2026-07-02", scopeType: "model", scopeId: "gpt-4" },
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    ]]);
    const calls = [];
    const api = createLlmGatewayAdminUsageApi(makeDeps({
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);
        const page = new URL(`https://x.test${gatewayPath}`).searchParams.get("page");
        return page === "1"
          ? {
              data: [
                { request_id: "r1", api_key: "hash-1", user: "ada@example.com", model: "gpt-4", spend: 0.1, total_tokens: 10, startTime: "2026-07-01T00:00:00Z", error_message: "bad, \"quoted\"" },
                { request_id: "r3", api_key: "hash-3", user: "ada@example.com", model: "other", spend: 0.2, total_tokens: 20, startTime: "2026-07-02T00:00:00Z" }
              ],
              page: 1,
              total_pages: 2
            }
          : {
              data: [
                { request_id: "r2", api_key: "hash-2", user: "ada@example.com", model: "gpt-4", spend: 0.2, total_tokens: 20, startTime: "2026-07-02T00:00:00Z" }
              ],
              page: 2,
              total_pages: 2
            };
      }
    }));

    const response = await api.downloadUsageExport({
      request: new Request("https://portal.test/api/llm-gateway/admin/usage/export?ticket=abc"),
      env: { PORTAL_KV: kv }
    });
    const csv = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(kv.deletes[0], "llm_usage_export:abc");
    assert.equal(await kv.get("llm_usage_export:abc"), null);
    assert.deepEqual(calls, [
      "/spend/logs/v2?start_date=2026-07-01&end_date=2026-07-02&model=gpt-4&page=1&page_size=100&sort_by=startTime&sort_order=asc",
      "/spend/logs/v2?start_date=2026-07-01&end_date=2026-07-02&model=gpt-4&page=2&page_size=100&sort_by=startTime&sort_order=asc"
    ]);
    assert.match(csv, /^id,request_id,token_id,.*cached_input_tokens,cache_write_input_tokens,reasoning_output_tokens,.*usage_json,/);
    assert.match(csv, /^r1,r1,/m);
    assert.doesNotMatch(csv, /^r3,r3,/m);
  });

  it("rejects oversized exports after the first bounded page", async () => {
    const kv = new MemoryKv([[
      "llm_usage_export:large",
      JSON.stringify({
        params: { from: "2026-09-01", to: "2026-09-02" },
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    ]]);
    const calls = [];
    const api = createLlmGatewayAdminUsageApi(makeDeps({
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);
        return { data: [], page: 1, total_pages: 11 };
      }
    }));

    await assert.rejects(
      () => api.downloadUsageExport({
        request: new Request("https://portal.test/api/llm-gateway/admin/usage/export?ticket=large"),
        env: { PORTAL_KV: kv }
      }),
      (error) => error.status === 413 && error.message === "usage_export_too_large"
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^\/spend\/logs\/v2\?/);
  });

  it("keeps export filter helpers narrow and predictable", () => {
    const params = usageRequestExportParams({
      from: " 2026-06-01 ",
      to: "2026-06-30",
      scopeType: "unsupported",
      scopeId: "user-1"
    }, makeDeps());

    assert.equal(params.toString(), "from=2026-06-01&to=2026-06-30");
    assert.equal(gatewayRequestsCsv([{ id: "req,1", error_message: "line\nbreak" }]).includes("\"req,1\""), true);
  });
});
