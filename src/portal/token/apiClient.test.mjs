import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const originalFetch = globalThis.fetch;
let apiPromise;

function loadApi() {
  apiPromise ??= (async () => {
    const outdir = await mkdtemp(join(tmpdir(), "workspace-token-api-client-"));
    const outfile = join(outdir, "apiClient.mjs");
    await build({
      bundle: true,
      entryPoints: [fileURLToPath(new URL("./apiClient.ts", import.meta.url))],
      format: "esm",
      logLevel: "silent",
      outfile,
      platform: "neutral"
    });
    const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
    await rm(outdir, { force: true, recursive: true });
    return mod;
  })();
  return apiPromise;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("gateway token API client", () => {
  it("fetches gateway access without using a cached response", async () => {
    const { fetchGatewayAccess } = await loadApi();
    const requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
        source: { provider: "litellm" },
        tokens: [],
        usage: [],
        series: []
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const payload = await fetchGatewayAccess();

    assert.equal(payload.source.provider, "litellm");
    assert.deepEqual(requests, [{
      input: "/api/llm-gateway/access",
      init: { cache: "no-store" }
    }]);
  });

  it("posts a no-store request for a manual usage refresh", async () => {
    const { refreshGatewayUsage } = await loadApi();
    const requests = [];
    const refreshPayload = {
      source: {
        provider: "litellm",
        mode: "admin-api",
        fetchedAt: "2026-07-15T02:30:00.000Z",
        endpoints: ["/spend/logs"]
      },
      analytics: {
        source: "snapshot",
        status: "ready",
        timezone: "Asia/Shanghai",
        updatedAt: "2026-07-15T02:30:00.000Z",
        dataThroughAt: "2026-07-15T02:29:00.000Z",
        dataThroughDate: "2026-07-15",
        lastCheckedAt: "2026-07-15T02:30:00.000Z",
        triggerType: "manual",
        summary: {
          cumulativeTokens: 42,
          currentMonthSpendUsd: 0.12,
          monthlyBudgetUsd: 100,
          peakDailyTokens: 42
        },
        dailyUsage: [],
        tokenUsage: []
      },
      usage: [],
      series: []
    };
    globalThis.fetch = async (input, init) => {
      requests.push({ input, init });
      return new Response(JSON.stringify(refreshPayload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const payload = await refreshGatewayUsage();

    assert.equal(payload.analytics.source, "snapshot");
    assert.equal(payload.analytics.dataThroughAt, "2026-07-15T02:29:00.000Z");
    assert.equal(payload.analytics.lastCheckedAt, "2026-07-15T02:30:00.000Z");
    assert.equal(payload.analytics.triggerType, "manual");
    assert.deepEqual(requests, [{
      input: "/api/llm-gateway/access/usage/refresh",
      init: { method: "POST", cache: "no-store" }
    }]);
  });

  it("marks a page-entry usage refresh as automatic", async () => {
    const { refreshGatewayUsage } = await loadApi();
    const requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
        source: { provider: "litellm" },
        analytics: { status: "ready" },
        usage: [],
        series: []
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    await refreshGatewayUsage({ trigger: "automatic" });

    assert.deepEqual(requests, [{
      input: "/api/llm-gateway/access/usage/refresh?trigger=automatic",
      init: { method: "POST", cache: "no-store" }
    }]);
  });

  it("preserves an in-progress usage refresh conflict", async () => {
    const { GatewayTokenApiError, refreshGatewayUsage } = await loadApi();
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "usage_refresh_in_progress" }), {
      status: 409,
      headers: { "content-type": "application/json" }
    });

    await assert.rejects(
      () => refreshGatewayUsage({ trigger: "automatic" }),
      (error) => error instanceof GatewayTokenApiError
        && error.status === 409
        && error.code === "usage_refresh_in_progress"
    );
  });

  it("rejects failed and malformed manual usage refresh responses", async () => {
    const { refreshGatewayUsage } = await loadApi();

    globalThis.fetch = async () => new Response(JSON.stringify({ error: "upstream unavailable" }), {
      status: 502,
      headers: { "content-type": "application/json" }
    });
    await assert.rejects(() => refreshGatewayUsage(), /usage_refresh_failed/);

    globalThis.fetch = async () => new Response(JSON.stringify({
      source: { provider: "litellm" }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    await assert.rejects(() => refreshGatewayUsage(), /usage_refresh_invalid_response/);
  });

  it("fetches a usage breakdown with the selected scope, date, and key", async () => {
    const { fetchUsageBreakdown } = await loadApi();
    const requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
        source: {
          provider: "litellm",
          mode: "admin-api",
          fetchedAt: "2026-07-15T02:30:00.000Z",
          endpoints: ["/spend/logs/v2"]
        },
        scope: { type: "date", from: "2026-07-08", to: "2026-07-08" },
        selectedKey: { id: "hash-a", name: "alpha" },
        models: [{
          model: "tencent-hunyuan-t1-latest",
          displayName: "Hunyuan T1",
          requests: 1,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 60,
          cacheWriteTokens: 0,
          totalTokens: 120,
          cacheRate: 0.6,
          estimatedCostUsd: 0.02
        }],
        total: {
          requests: 1,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 60,
          cacheWriteTokens: 0,
          totalTokens: 120,
          cacheRate: 0.6,
          estimatedCostUsd: 0.02
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const payload = await fetchUsageBreakdown({
      scope: "date",
      date: "2026-07-08",
      key: "hash-a"
    });

    assert.equal(payload.scope.type, "date");
    assert.equal(payload.models[0].cacheRate, 0.6);
    assert.deepEqual(requests, [{
      input: "/api/llm-gateway/access/usage/breakdown?scope=date&date=2026-07-08&key=hash-a",
      init: { cache: "no-store" }
    }]);
  });

  it("rejects failed and malformed usage breakdown responses", async () => {
    const { fetchUsageBreakdown } = await loadApi();

    globalThis.fetch = async () => new Response(JSON.stringify({ error: "upstream unavailable" }), {
      status: 502,
      headers: { "content-type": "application/json" }
    });
    await assert.rejects(() => fetchUsageBreakdown({ scope: "month" }), /usage_breakdown_failed/);

    globalThis.fetch = async () => new Response(JSON.stringify({
      source: { provider: "litellm" }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    await assert.rejects(() => fetchUsageBreakdown({ scope: "month" }), /usage_breakdown_invalid_response/);
  });

  it("preserves the stable name-conflict code and HTTP status", async () => {
    const { createGatewayToken, GatewayTokenApiError } = await loadApi();
    let requestBody;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ error: "gateway_token_name_conflict" }), {
        status: 409,
        headers: { "content-type": "application/json" }
      });
    };

    await assert.rejects(
      () => createGatewayToken({
        name: " existing-key ",
        monthlyBudgetPercent: "49",
        usagePurpose: "app"
      }),
      (error) => error instanceof GatewayTokenApiError
        && error.status === 409
        && error.code === "gateway_token_name_conflict"
    );
    assert.deepEqual(requestBody, {
      monthlyBudgetPercent: 49,
      name: "existing-key",
      usagePurpose: "app"
    });
  });

  it("does not expose unknown or non-JSON server errors", async () => {
    const { createGatewayToken, GatewayTokenApiError } = await loadApi();
    globalThis.fetch = async () => new Response("private upstream error", { status: 502 });

    await assert.rejects(
      () => createGatewayToken({
        name: "valid-key",
        monthlyBudgetPercent: "100",
        usagePurpose: "agent"
      }),
      (error) => error instanceof GatewayTokenApiError
        && error.status === 502
        && error.code === "token_create_failed"
        && !error.message.includes("private upstream error")
    );
  });

  it("preserves the stable name-conflict code for token renames", async () => {
    const { GatewayTokenApiError, updateGatewayToken } = await loadApi();
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "gateway_token_name_conflict" }), {
      status: 409,
      headers: { "content-type": "application/json" }
    });

    await assert.rejects(
      () => updateGatewayToken("hash-1", {
        name: "existing-key",
        monthlyBudgetPercent: "100",
        usagePurpose: "agent"
      }),
      (error) => error instanceof GatewayTokenApiError
        && error.status === 409
        && error.code === "gateway_token_name_conflict"
    );
  });

  it("rotates an encoded token id and returns the one-time replacement secret", async () => {
    const { rotateGatewayToken } = await loadApi();
    const requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
        token: "sk-rotated",
        tokenRecord: { id: "hash-rotated" }
      }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    };

    const payload = await rotateGatewayToken("hash/old");

    assert.equal(requests[0].input, "/api/llm-gateway/access/tokens/hash%2Fold/rotate");
    assert.deepEqual(requests[0].init, { method: "POST" });
    assert.equal(payload.token, "sk-rotated");
    assert.equal(payload.tokenRecord.id, "hash-rotated");
  });

  it("maps rotation failures to a stable client error", async () => {
    const { GatewayTokenApiError, rotateGatewayToken } = await loadApi();
    globalThis.fetch = async () => new Response("private upstream error", { status: 502 });

    await assert.rejects(
      () => rotateGatewayToken("hash-1"),
      (error) => error instanceof GatewayTokenApiError
        && error.status === 502
        && error.code === "token_rotate_failed"
        && !error.message.includes("private upstream error")
    );
  });

  it("tests an encoded token id and normalizes a valid chat response", async () => {
    const { testGatewayToken } = await loadApi();
    let request;
    globalThis.fetch = async (input, init) => {
      request = { body: JSON.parse(String(init?.body)), input };
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "OK" } }],
        id: "chat-1",
        model: "model-alpha",
        usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 }
      }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "request-1" }
      });
    };

    const result = await testGatewayToken({
      apiKey: "sk-test",
      input: "Hello",
      model: "model-alpha",
      tokenId: "hash/test"
    });

    assert.equal(request.input, "/api/llm-gateway/access/tokens/hash%2Ftest/test");
    assert.deepEqual(request.body, {
      apiKey: "sk-test",
      messages: [{ content: "Hello", role: "user" }],
      model: "model-alpha"
    });
    assert.equal(result.content, "OK");
    assert.equal(result.requestId, "request-1");
    assert.deepEqual(result.usage, { completionTokens: 1, promptTokens: 2, totalTokens: 3 });
  });

  it("preserves allowlisted test codes from nested error objects", async () => {
    const { GatewayTokenApiError, testGatewayToken } = await loadApi();
    const stableCodes = [
      "gateway_token_not_found",
      "gateway_token_auth_rejected",
      "gateway_token_access_denied",
      "gateway_token_budget_exceeded",
      "gateway_token_rate_limited",
      "gateway_model_unavailable",
      "gateway_test_request_rejected",
      "llm_gateway_test_unavailable",
      "llm_gateway_test_invalid_response"
    ];

    for (const stableCode of stableCodes) {
      globalThis.fetch = async () => new Response(JSON.stringify({
        error: {
          code: "upstream_status_code",
          message: "private upstream detail",
          type: stableCode
        }
      }), {
        status: 400,
        headers: { "content-type": "application/json", "x-request-id": "request-error-1" }
      });

      await assert.rejects(
        () => testGatewayToken({
          apiKey: "sk-test",
          input: "Hello",
          model: "model-alpha",
          tokenId: "hash/test"
        }),
        (error) => error instanceof GatewayTokenApiError
          && error.status === 400
          && error.code === stableCode
          && error.requestId === "request-error-1"
          && !error.message.includes("private upstream detail")
      );
    }
  });

  it("classifies legacy LiteLLM nested failures without exposing their messages", async () => {
    const { GatewayTokenApiError, testGatewayToken } = await loadApi();
    const cases = [
      { expected: "gateway_token_auth_rejected", status: 401, type: "token_not_found_in_db" },
      { expected: "gateway_token_access_denied", status: 403, type: "permission_error" },
      { expected: "gateway_model_unavailable", status: 404, type: "not_found_error" },
      { expected: "gateway_token_budget_exceeded", status: 429, type: "budget_exceeded" },
      { expected: "gateway_token_rate_limited", status: 429, type: "rate_limit_error" },
      { expected: "llm_gateway_test_unavailable", status: 502, type: "service_error" }
    ];

    for (const testCase of cases) {
      globalThis.fetch = async () => new Response(JSON.stringify({
        error: {
          code: String(testCase.status),
          message: "private key suffix and token hash",
          type: testCase.type
        }
      }), {
        status: testCase.status,
        headers: { "content-type": "application/json" }
      });

      await assert.rejects(
        () => testGatewayToken({
          apiKey: "sk-test",
          input: "Hello",
          model: "model-alpha",
          tokenId: "hash-1"
        }),
        (error) => error instanceof GatewayTokenApiError
          && error.status === testCase.status
          && error.code === testCase.expected
          && !error.message.includes("private key suffix")
      );
    }
  });

  it("maps malformed success bodies and network failures to safe test errors", async () => {
    const { GatewayTokenApiError, testGatewayToken } = await loadApi();
    const run = () => testGatewayToken({
      apiKey: "sk-test",
      input: "Hello",
      model: "model-alpha",
      tokenId: "hash-1"
    });

    globalThis.fetch = async () => new Response("not-json", { status: 200 });
    await assert.rejects(
      run,
      (error) => error instanceof GatewayTokenApiError
        && error.status === 200
        && error.code === "llm_gateway_test_invalid_response"
        && !error.message.includes("not-json")
    );

    globalThis.fetch = async () => {
      throw new TypeError("private network detail");
    };
    await assert.rejects(
      run,
      (error) => error instanceof GatewayTokenApiError
        && error.status === 0
        && error.code === "llm_gateway_test_unavailable"
        && !error.message.includes("private network detail")
    );
  });
});
