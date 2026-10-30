import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlmGatewayModelHealthApi, nextModelHealthScheduledAt } from "./modelHealth.ts";

const adminUser = { id: "admin-1", name: "Ada", email: "ada@example.com", team: "AI", role: "admin" };

class HealthDb {
  constructor(runs, results) {
    this.runs = runs;
    this.results = results;
    this.binds = [];
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...values) {
        db.binds.push(values);
        return this;
      },
      async all() {
        return { results: sql.includes("FROM model_health_results") ? db.results : db.runs };
      }
    };
  }
}

function deps(now) {
  return {
    httpError(status, message) {
      return Object.assign(new Error(message), { status });
    },
    json(body, init = {}) {
      return new Response(JSON.stringify(body), init);
    },
    now: () => now,
    async resolveCurrentUser() {
      return adminUser;
    }
  };
}

describe("model health status API", () => {
  it("returns model rows aligned to scheduled runs and computes availability", async () => {
    const db = new HealthDb([
      {
        id: "run-1", scheduled_at: "2026-08-03T01:00:00.000Z", slot_local: "2026-08-03T09:00",
        timezone: "Asia/Shanghai", status: "operational", model_count: 2, operational_count: 2,
        degraded_count: 0, failed_count: 0, started_at: "2026-08-03T01:00:00.000Z",
        completed_at: "2026-08-03T01:00:02.000Z", error_code: ""
      },
      {
        id: "run-2", scheduled_at: "2026-08-03T04:00:00.000Z", slot_local: "2026-08-03T12:00",
        timezone: "Asia/Shanghai", status: "degraded", model_count: 2, operational_count: 1,
        degraded_count: 0, failed_count: 1, started_at: "2026-08-03T04:00:00.000Z",
        completed_at: "2026-08-03T04:00:03.000Z", error_code: ""
      }
    ], [
      result("run-1", "gpt-5", "operational", 1000),
      result("run-2", "gpt-5", "failed", 3000),
      { ...result("run-1", "claude-sonnet", "operational", 2000), display_name: "Claude Sonnet", vendor_id: "anthropic" },
      { ...result("run-2", "claude-sonnet", "operational", 2500), display_name: "Claude Sonnet", vendor_id: "anthropic" }
    ]);
    const api = createLlmGatewayModelHealthApi(deps(new Date("2026-08-03T04:30:00.000Z")));
    const response = await api.getAdminModelHealth({
      env: { DB: db },
      request: new Request("https://portal.test/api/llm-gateway/model-health?days=30")
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.summary.status, "degraded");
    assert.equal(body.summary.uptimePercent, 75);
    assert.equal(body.summary.averageLatencyMs, 1833);
    assert.equal(body.models.length, 2);
    assert.equal(body.models.find((model) => model.id === "gpt-5").uptimePercent, 50);
    assert.equal(body.schedule.nextScheduledAt, "2026-08-03T07:00:00.000Z");
    assert.equal(db.binds.length, 2);
  });

  it("returns only the latest 28 scheduled checks when a run limit is requested", async () => {
    const runs = Array.from({ length: 30 }, (_, index) => {
      const day = String(index + 1).padStart(2, "0");
      return {
        id: `run-${index + 1}`, scheduled_at: `2026-08-${day}T01:00:00.000Z`,
        slot_local: `2026-08-${day}T09:00`, timezone: "Asia/Shanghai", status: "operational",
        model_count: 1, operational_count: 1, degraded_count: 0, failed_count: 0,
        started_at: `2026-08-${day}T01:00:00.000Z`, completed_at: `2026-08-${day}T01:00:02.000Z`,
        error_code: ""
      };
    });
    const db = new HealthDb(runs, runs.map((run) => result(run.id, "visible-model", "operational", 1000)));
    const api = createLlmGatewayModelHealthApi(deps(new Date("2026-08-31T01:00:00.000Z")));
    const response = await api.getAdminModelHealth({
      env: { DB: db },
      request: new Request("https://portal.test/api/llm-gateway/model-health?limit=28")
    });
    const body = await response.json();

    assert.equal(body.rangeRunLimit, 28);
    assert.equal(body.runs.length, 28);
    assert.equal(body.runs[0].id, "run-3");
    assert.equal(body.runs.at(-1).id, "run-30");
    assert.equal(body.models[0].results.length, 28);
    assert.deepEqual(db.binds, [[28], [28]]);
  });

  it("reports the latest failed run while retaining availability from prior results", async () => {
    const db = new HealthDb([
      {
        id: "run-1", scheduled_at: "2026-08-10T04:00:00.000Z", slot_local: "2026-08-10T12:00",
        timezone: "Asia/Shanghai", status: "operational", model_count: 1, operational_count: 1,
        degraded_count: 0, failed_count: 0, started_at: "2026-08-10T04:00:00.000Z",
        completed_at: "2026-08-10T04:00:02.000Z", error_code: ""
      },
      {
        id: "run-2", scheduled_at: "2026-08-10T07:00:00.000Z", slot_local: "2026-08-10T15:00",
        timezone: "Asia/Shanghai", status: "error", model_count: 0, operational_count: 0,
        degraded_count: 0, failed_count: 0, started_at: "2026-08-10T07:00:00.000Z",
        completed_at: "2026-08-10T07:00:01.000Z", error_code: "litellm_provisioning_key_not_configured"
      }
    ], [{
      ...result("run-1", "gpt-5", "operational", 1200),
      tested_at: "2026-08-10T04:00:01.000Z"
    }]);
    const api = createLlmGatewayModelHealthApi(deps(new Date("2026-08-10T07:30:00.000Z")));
    const response = await api.getAdminModelHealth({
      env: { DB: db },
      request: new Request("https://portal.test/api/llm-gateway/model-health?days=30")
    });
    const body = await response.json();

    assert.equal(body.summary.status, "error");
    assert.equal(body.summary.latestRunId, "run-2");
    assert.equal(body.summary.modelCount, 0);
    assert.equal(body.summary.operationalCount, 0);
    assert.equal(body.summary.uptimePercent, 100);
    assert.equal(body.models[0].uptimePercent, 100);
    assert.equal(body.summary.averageLatencyMs, 1200);
    assert.equal(body.summary.lastCheckedAt, "2026-08-10T07:00:01.000Z");
    assert.equal(body.runs.at(-1).errorCode, "litellm_provisioning_key_not_configured");
  });

  it("drops models that are absent from the latest public health run", async () => {
    const db = new HealthDb([
      {
        id: "run-1", scheduled_at: "2026-08-10T01:00:00.000Z", slot_local: "2026-08-10T09:00",
        timezone: "Asia/Shanghai", status: "operational", model_count: 2, operational_count: 2,
        degraded_count: 0, failed_count: 0, started_at: "2026-08-10T01:00:00.000Z",
        completed_at: "2026-08-10T01:00:02.000Z", error_code: ""
      },
      {
        id: "run-2", scheduled_at: "2026-08-10T04:00:00.000Z", slot_local: "2026-08-10T12:00",
        timezone: "Asia/Shanghai", status: "operational", model_count: 1, operational_count: 1,
        degraded_count: 0, failed_count: 0, started_at: "2026-08-10T04:00:00.000Z",
        completed_at: "2026-08-10T04:00:02.000Z", error_code: ""
      }
    ], [
      result("run-1", "visible-model", "operational", 1000),
      result("run-1", "retired-oss", "operational", 1000),
      result("run-2", "visible-model", "operational", 1000)
    ]);
    const api = createLlmGatewayModelHealthApi(deps(new Date("2026-08-10T04:30:00.000Z")));
    const response = await api.getAdminModelHealth({
      env: { DB: db },
      request: new Request("https://portal.test/api/llm-gateway/model-health?days=30")
    });
    const body = await response.json();

    assert.deepEqual(body.models.map((model) => model.id), ["visible-model"]);
  });

  it("calculates uptime from the most recent seven days", async () => {
    const db = new HealthDb([
      {
        id: "run-1", scheduled_at: "2026-08-10T01:00:00.000Z", slot_local: "2026-08-10T09:00",
        timezone: "Asia/Shanghai", status: "operational", model_count: 1, operational_count: 1,
        degraded_count: 0, failed_count: 0, started_at: "2026-08-10T01:00:00.000Z",
        completed_at: "2026-08-10T01:00:02.000Z", error_code: ""
      },
      {
        id: "run-2", scheduled_at: "2026-08-19T01:00:00.000Z", slot_local: "2026-08-19T09:00",
        timezone: "Asia/Shanghai", status: "operational", model_count: 1, operational_count: 1,
        degraded_count: 0, failed_count: 0, started_at: "2026-08-19T01:00:00.000Z",
        completed_at: "2026-08-19T01:00:02.000Z", error_code: ""
      }
    ], [
      { ...result("run-1", "visible-model", "failed", 1000), tested_at: "2026-08-10T01:00:01.000Z" },
      { ...result("run-2", "visible-model", "operational", 1000), tested_at: "2026-08-19T01:00:01.000Z" }
    ]);
    const api = createLlmGatewayModelHealthApi(deps(new Date("2026-08-20T01:00:00.000Z")));
    const response = await api.getAdminModelHealth({
      env: { DB: db },
      request: new Request("https://portal.test/api/llm-gateway/model-health?days=30")
    });
    const body = await response.json();

    assert.equal(body.summary.uptimePercent, 100);
    assert.equal(body.summary.uptimeWindowDays, 7);
    assert.equal(body.models[0].uptimePercent, 100);
  });

  it("fails closed when the D1 binding is missing", async () => {
    const api = createLlmGatewayModelHealthApi(deps(new Date("2026-08-03T00:00:00.000Z")));
    await assert.rejects(
      () => api.getAdminModelHealth({ env: {}, request: new Request("https://portal.test/api/llm-gateway/model-health") }),
      /model_health_database_not_configured/
    );
  });

  it("skips weekends when calculating the next Shanghai check", () => {
    assert.equal(
      nextModelHealthScheduledAt(new Date("2026-08-07T10:01:00.000Z")).toISOString(),
      "2026-08-10T01:00:00.000Z"
    );
  });
});

function result(runId, modelId, status, latency) {
  return {
    run_id: runId,
    model_id: modelId,
    display_name: modelId,
    vendor_id: "openai",
    status,
    latency_ms: latency,
    http_status: status === "failed" ? 500 : 200,
    error_code: status === "failed" ? "upstream_error" : "",
    request_id: `req-${runId}-${modelId}`,
    response_excerpt: status === "failed" ? "" : "OK",
    tested_at: "2026-08-03T04:00:01.000Z"
  };
}
