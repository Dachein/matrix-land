import { testInstallation } from "../../../tests/helpers/installation.mjs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runModelHealthCheck, shanghaiSlot } from "./index.ts";

class HealthDb {
  constructor() {
    this.statements = [];
    this.batches = [];
  }

  prepare(sql) {
    const statement = { sql: sql.replace(/\s+/g, " ").trim(), values: [] };
    this.statements.push(statement);
    return {
      bind: (...values) => {
        statement.values = values;
        return {
          run: async () => ({ meta: { changes: 1 } })
        };
      }
    };
  }

  async batch(statements) {
    this.batches.push(statements);
    return statements.map(() => ({ success: true }));
  }
}

describe("scheduled model health worker", () => {
  it("converts UTC cron time to a stable Shanghai slot", () => {
    assert.equal(shanghaiSlot(new Date("2026-08-03T01:00:00.000Z")), "2026-08-03T09:00");
    assert.equal(shanghaiSlot(new Date("2026-08-03T10:00:00.000Z")), "2026-08-03T18:00");
  });

  it("probes every supported chat model and completes a degraded run", async () => {
    const db = new HealthDb();
    let tick = 0;
    const times = [
      "2026-08-03T01:00:00.000Z",
      "2026-08-03T01:00:00.000Z",
      "2026-08-03T01:00:01.000Z",
      "2026-08-03T01:00:01.000Z",
      "2026-08-03T01:00:03.000Z",
      "2026-08-03T01:00:03.000Z",
      "2026-08-03T01:00:04.000Z"
    ];
    const calls = [];
    const fetcher = async (input, init = {}) => {
      calls.push({ input: String(input), init });
      if (String(input).endsWith("/v1/models")) {
        return jsonResponse({ data: [
          { id: "gpt-5" },
          { id: "claude-sonnet" },
          // LiteLLM's compact response has no visibility metadata, so Workspace's
          // configured hidden compatibility list is the final filter.
          { id: "tencent-kimi-k2.7-code" },
          // /v1/models should already omit these. Keep them here to verify
          // that metadata-aware upstream variants are filtered defensively.
          { model_name: "aws-openai-gpt-oss-120b", model_info: { display_name: "OpenAI gpt-oss-120b", provider: "aws-bedrock", mode: "chat", blocked: true } },
          { model_name: "tencent-glm-5.2", model_info: { display_name: "GLM-5.2", provider: "tencent-tokenhub-intl", mode: "chat", hidden: true } },
          { model_name: "embedding-3", model_info: { provider: "openai", mode: "embedding" } }
        ] });
      }
      const body = JSON.parse(init.body);
      return body.model === "gpt-5"
        ? jsonResponse({ choices: [{ message: { content: "OK" } }] }, 200, { "x-request-id": "req-ok" })
        : jsonResponse({ error: { type: "provider_unavailable" } }, 503);
    };

    const result = await runModelHealthCheck({ ...testInstallation,
      DB: db,
      LITELLM_PROVISIONING_KEY: "admin-key",
      MODEL_HEALTH_CONCURRENCY: "1",
      MODEL_HEALTH_EXCLUDED_MODELS: " tencent-kimi-k2.7-code "
    }, new Date("2026-08-03T01:00:00.000Z"), {
      fetch: fetcher,
      clock: () => new Date(times[Math.min(tick++, times.length - 1)])
    });

    assert.equal(result.status, "degraded");
    assert.equal(result.modelCount, 2);
    assert.equal(result.operationalCount, 1);
    assert.equal(result.failedCount, 1);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].input, "https://token.example.invalid/v1/models");
    assert.equal(calls[0].init.headers.Authorization, "Bearer admin-key");
    assert.deepEqual(calls.slice(1).map((call) => JSON.parse(call.init.body).model), ["claude-sonnet", "gpt-5"]);
    assert.equal(calls.some((call) => call.input.endsWith("/v1/model/info")), false);
    assert.equal(calls.some((call) => call.init.body?.includes("tencent-kimi-k2.7-code")), false);
    assert.equal(db.batches.length, 1);
    assert.equal(db.batches[0].length, 2);
    assert.ok(db.statements.some((statement) => statement.sql.includes("SET status = ?")));
  });

  it("treats an HTTP 200 response without visible content as connected", async () => {
    const db = new HealthDb();
    const result = await runModelHealthCheck({ ...testInstallation,
      DB: db,
      LITELLM_PROVISIONING_KEY: "admin-key",
      MODEL_HEALTH_CONCURRENCY: "1"
    }, new Date("2026-08-03T01:00:00.000Z"), {
      fetch: async (input) => String(input).endsWith("/v1/models")
        ? jsonResponse({ data: [
            { id: "reasoning-model" }
          ] })
        : jsonResponse({ choices: [{ message: { content: "" } }] }),
      clock: () => new Date("2026-08-03T01:00:01.000Z")
    });

    assert.equal(result.status, "operational");
    assert.equal(result.operationalCount, 1);
    assert.equal(result.degradedCount, 0);
    assert.equal(result.failedCount, 0);
  });

  it("uses a 512-token probe budget while preserving provider parameter compatibility", async () => {
    const db = new HealthDb();
    const chatRequests = [];
    const result = await runModelHealthCheck({ ...testInstallation,
      DB: db,
      LITELLM_PROVISIONING_KEY: "admin-key",
      MODEL_HEALTH_CONCURRENCY: "1"
    }, new Date("2026-09-26T01:00:00.000Z"), {
      fetch: async (input, init = {}) => {
        if (String(input).endsWith("/v1/models")) {
          return jsonResponse({ data: [
            { id: "cf-openai-gpt-5.6-luna" },
            { id: "cf-openai-gpt-5.6-sol" },
            { id: "tencent-deepseek-v4-flash" },
            { id: "tencent-hy4-preview" },
            { id: "tencent-mimo-v2.6-pro" },
            { id: "tencent-minimax-m3" }
          ] });
        }
        const body = JSON.parse(init.body);
        chatRequests.push(body);
        return jsonResponse({ choices: [{ message: { content: "OK" } }] });
      },
      clock: () => new Date("2026-09-26T01:00:01.000Z")
    });

    assert.equal(result.status, "operational");
    assert.equal(result.operationalCount, 6);
    assert.deepEqual(Object.fromEntries(chatRequests.map(({ model, max_tokens, max_completion_tokens }) => [model, {
      max_tokens,
      max_completion_tokens
    }])), {
      "cf-openai-gpt-5.6-luna": { max_tokens: undefined, max_completion_tokens: 512 },
      "cf-openai-gpt-5.6-sol": { max_tokens: undefined, max_completion_tokens: 512 },
      "tencent-deepseek-v4-flash": { max_tokens: 512, max_completion_tokens: undefined },
      "tencent-hy4-preview": { max_tokens: 512, max_completion_tokens: undefined },
      "tencent-mimo-v2.6-pro": { max_tokens: 512, max_completion_tokens: undefined },
      "tencent-minimax-m3": { max_tokens: 512, max_completion_tokens: undefined }
    });
    for (const request of chatRequests) {
      assert.deepEqual(request.messages, [{ role: "user", content: "Reply with OK only." }]);
      assert.equal(request.stream, false);
    }
  });

  it("keeps the provider error message on failed probes for diagnosis", async () => {
    const db = new HealthDb();
    const result = await runModelHealthCheck({ ...testInstallation,
      DB: db,
      LITELLM_PROVISIONING_KEY: "admin-key",
      MODEL_HEALTH_CONCURRENCY: "1"
    }, new Date("2026-09-26T04:00:00.000Z"), {
      fetch: async (input) => String(input).endsWith("/v1/models")
        ? jsonResponse({ data: [{ id: "cf-openai-gpt-5.6-sol" }] })
        : jsonResponse({ error: {
            type: "invalid_request_error",
            message: "Unsupported parameter: max_completion_tokens"
          } }, 400),
      clock: () => new Date("2026-09-26T04:00:01.000Z")
    });

    assert.equal(result.failedCount, 1);
    const savedResult = db.statements.find((statement) => statement.sql.includes("INSERT INTO model_health_results"));
    assert.ok(savedResult);
    assert.equal(savedResult.values[7], "invalid_request_error");
    assert.equal(savedResult.values[9], "Unsupported parameter: max_completion_tokens");
  });

  it("records a failed run when the unified model catalog is forbidden", async () => {
    const db = new HealthDb();
    const scheduledAt = new Date("2026-08-24T01:00:00.000Z");

    await assert.rejects(
      () => runModelHealthCheck({ ...testInstallation,
        DB: db,
        LITELLM_PROVISIONING_KEY: "admin-key"
      }, scheduledAt, {
        fetch: async (input) => {
          assert.equal(String(input), "https://token.example.invalid/v1/models");
          return jsonResponse({ error: "forbidden" }, 403);
        },
        clock: () => new Date("2026-08-24T01:00:01.000Z")
      }),
      /model_health_catalog_failed:403/
    );

    const failedRun = db.statements.find((statement) => statement.sql.includes("SET status = 'error'"));
    assert.ok(failedRun);
    assert.deepEqual(failedRun.values, [
      "2026-08-24T01:00:01.000Z",
      "model_health_catalog_failed:403",
      "model-health:2026-08-24T09:00"
    ]);
    assert.equal(db.batches.length, 0);
  });

  it("records a failed run when no LiteLLM health probe token is configured", async () => {
    const db = new HealthDb();
    const scheduledAt = new Date("2026-08-10T07:00:00.000Z");

    await assert.rejects(
      () => runModelHealthCheck({ ...testInstallation,  DB: db }, scheduledAt, {
        fetch: async () => {
          throw new Error("fetch should not be called without a health probe token");
        },
        clock: () => new Date("2026-08-10T07:00:01.000Z")
      }),
      /litellm_health_probe_token_not_configured/
    );

    const failedRun = db.statements.find((statement) => statement.sql.includes("SET status = 'error'"));
    assert.ok(failedRun);
    assert.deepEqual(failedRun.values, [
      "2026-08-10T07:00:01.000Z",
      "litellm_health_probe_token_not_configured",
      "model-health:2026-08-10T15:00"
    ]);
    assert.equal(db.batches.length, 0);
  });

  it("does not fall back to the retired user token", async () => {
    const db = new HealthDb();

    await assert.rejects(
      () => runModelHealthCheck({ ...testInstallation,
        DB: db,
        LITELLM_USER_TOKEN: "legacy-user-token"
      }, new Date("2026-08-10T07:00:00.000Z"), {
        fetch: async () => {
          throw new Error("fetch should not be called with only the retired user token");
        },
        clock: () => new Date("2026-08-10T07:00:01.000Z")
      }),
      /litellm_health_probe_token_not_configured/
    );
  });
});

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}
