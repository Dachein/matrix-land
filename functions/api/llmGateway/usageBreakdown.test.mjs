import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildUsageBreakdown,
  mergeUsageBreakdowns,
  normalizeUsageBreakdownScope,
  resolveUsageBreakdownRange
} from "./usageBreakdown.ts";

const TIMEZONE = "Asia/Shanghai";

describe("usage breakdown scope normalization", () => {
  it("accepts the five supported scopes", () => {
    for (const scope of ["today", "week", "month", "all", "date"]) {
      assert.equal(normalizeUsageBreakdownScope(scope), scope);
    }
  });

  it("rejects unknown scopes", () => {
    assert.equal(normalizeUsageBreakdownScope("year"), undefined);
    assert.equal(normalizeUsageBreakdownScope(""), undefined);
  });
});

describe("usage breakdown range resolution", () => {
  const now = new Date("2026-07-15T04:00:00.000Z");

  it("resolves today in the configured timezone", () => {
    assert.deepEqual(resolveUsageBreakdownRange("today", now, TIMEZONE), {
      type: "today",
      from: "2026-07-15",
      to: "2026-07-15"
    });
  });

  it("resolves this week from Monday through today", () => {
    assert.deepEqual(resolveUsageBreakdownRange("week", now, TIMEZONE), {
      type: "week",
      from: "2026-07-13",
      to: "2026-07-15"
    });
  });

  it("resolves this month from the first day through today", () => {
    assert.deepEqual(resolveUsageBreakdownRange("month", now, TIMEZONE), {
      type: "month",
      from: "2026-07-01",
      to: "2026-07-15"
    });
  });

  it("resolves all history from the configured start date", () => {
    assert.deepEqual(
      resolveUsageBreakdownRange("all", now, TIMEZONE, { historyStartDate: "2026-07-13" }),
      { type: "all", from: "2026-07-13", to: "2026-07-15" }
    );
  });

  it("resolves a specified date", () => {
    assert.deepEqual(
      resolveUsageBreakdownRange("date", now, TIMEZONE, { date: "2026-07-08" }),
      { type: "date", from: "2026-07-08", to: "2026-07-08" }
    );
  });

  it("falls back to today for an invalid specified date", () => {
    assert.deepEqual(
      resolveUsageBreakdownRange("date", now, TIMEZONE, { date: "not-a-date" }),
      { type: "date", from: "2026-07-15", to: "2026-07-15" }
    );
  });
});

describe("usage breakdown aggregation", () => {
  const logs = [
    {
      api_key: "hash-a",
      model: "tencent-hunyuan-t1-latest",
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cache_read_input_tokens: 60,
      spend: 0.02,
      startTime: "2026-07-02T04:00:00.000Z"
    },
    {
      api_key: "hash-b",
      model: "tencent-hunyuan-t1-latest",
      prompt_tokens: 200,
      completion_tokens: 50,
      total_tokens: 250,
      cached_input_tokens: 40,
      spend: 0.03,
      startTime: "2026-07-14T04:00:00.000Z"
    },
    {
      api_key: "hash-a",
      model: "gpt-5.5",
      prompt_tokens: 300,
      completion_tokens: 100,
      total_tokens: 400,
      spend: 0.05,
      startTime: "2026-07-15T01:00:00.000Z"
    }
  ];
  const scope = { type: "month", from: "2026-07-01", to: "2026-07-15" };

  it("groups spend logs by model with cache tokens and cache rate", () => {
    const { models, total } = buildUsageBreakdown({
      logs,
      scope,
      displayNames: new Map([["tencent-hunyuan-t1-latest", "Hunyuan T1"]])
    });

    assert.equal(models.length, 2);
    const hunyuan = models.find((row) => row.model === "tencent-hunyuan-t1-latest");
    const gpt = models.find((row) => row.model === "gpt-5.5");
    assert.equal(hunyuan.displayName, "Hunyuan T1");
    assert.equal(hunyuan.requests, 2);
    assert.equal(hunyuan.inputTokens, 300);
    assert.equal(hunyuan.outputTokens, 70);
    assert.equal(hunyuan.cacheReadTokens, 100);
    assert.equal(hunyuan.cacheWriteTokens, 0);
    assert.equal(hunyuan.totalTokens, 370);
    assert.equal(hunyuan.estimatedCostUsd, 0.05);
    assert.equal(hunyuan.cacheRate, 100 / 300);
    assert.equal(gpt.estimatedCostUsd, 0.05);
    assert.equal(gpt.cacheRate, 0);

    // models are sorted by cost desc
    assert.deepEqual(models.map((row) => row.model), ["gpt-5.5", "tencent-hunyuan-t1-latest"]);

    assert.equal(total.requests, 3);
    assert.equal(total.inputTokens, 600);
    assert.equal(total.outputTokens, 170);
    assert.equal(total.cacheReadTokens, 100);
    assert.equal(total.totalTokens, 770);
    assert.equal(total.estimatedCostUsd, 0.1);
    assert.equal(total.cacheRate, 100 / 600);
  });

  it("reads cached tokens from LiteLLM nested usage metadata without double counting mirrored values", () => {
    const { models, total } = buildUsageBreakdown({
      logs: [
        {
          request_id: "nested-cache-request",
          model: "openai/deepseek-v4-flash-202605",
          prompt_tokens: 1000,
          completion_tokens: 25,
          total_tokens: 1025,
          spend: 0.01,
          startTime: "2026-07-15T01:00:00.000Z",
          metadata: {
            usage_object: {
              prompt_tokens_details: { cached_tokens: 800 }
            },
            additional_usage_values: {
              prompt_tokens_details: { cached_tokens: 800 }
            }
          }
        }
      ],
      scope
    });

    assert.equal(models[0].cacheReadTokens, 800);
    assert.equal(models[0].cacheRate, 0.8);
    assert.equal(total.cacheReadTokens, 800);
    assert.equal(total.cacheRate, 0.8);
  });

  it("filters to a single key when selected", () => {
    const { models, total } = buildUsageBreakdown({
      logs,
      scope,
      selectedKeyId: "hash-a"
    });

    assert.equal(models.length, 2);
    assert.equal(total.requests, 2);
    assert.equal(total.inputTokens, 400);
    assert.equal(total.estimatedCostUsd, 0.07);
  });

  it("excludes logs outside the requested date range and deduplicates request ids", () => {
    const { models, total } = buildUsageBreakdown({
      logs: [
        ...logs,
        {
          api_key: "hash-a",
          model: "gpt-5.5",
          prompt_tokens: 999,
          completion_tokens: 999,
          total_tokens: 1998,
          spend: 9.99,
          startTime: "2026-06-30T04:00:00.000Z"
        },
        {
          api_key: "hash-a",
          model: "gpt-5.5",
          request_id: "dup-request",
          prompt_tokens: 999,
          completion_tokens: 999,
          total_tokens: 1998,
          spend: 9.99,
          startTime: "2026-07-15T02:00:00.000Z"
        },
        {
          api_key: "hash-a",
          model: "gpt-5.5",
          request_id: "dup-request",
          prompt_tokens: 999,
          completion_tokens: 999,
          total_tokens: 1998,
          spend: 9.99,
          startTime: "2026-07-15T02:30:00.000Z"
        }
      ],
      scope
    });

    const gpt = models.find((row) => row.model === "gpt-5.5");
    assert.equal(gpt.requests, 2);
    assert.equal(gpt.totalTokens, 2398);
    assert.ok(Math.abs(gpt.estimatedCostUsd - 10.04) < 1e-12);
    assert.equal(total.requests, 4);
    assert.ok(Math.abs(total.estimatedCostUsd - 10.09) < 1e-12);
  });

  it("returns an empty total when no logs match", () => {
    const { models, total } = buildUsageBreakdown({
      logs: [],
      scope
    });

    assert.deepEqual(models, []);
    assert.deepEqual(total, {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      cacheRate: null,
      estimatedCostUsd: 0
    });
  });

  it("merges closed ledger totals with a live tail and recalculates cache rate", () => {
    const { models, total } = mergeUsageBreakdowns([
      {
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
      },
      {
        model: "tencent-deepseek-v4-flash",
        displayName: "tencent-deepseek-v4-flash",
        requests: 2,
        inputTokens: 200,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheWriteTokens: 10,
        totalTokens: 240,
        cacheRate: 0,
        estimatedCostUsd: 0.02
      }
    ], new Map([["tencent-deepseek-v4-flash", "DeepSeek-V4-Flash 正式版"]]));

    assert.equal(models.length, 1);
    assert.equal(models[0].displayName, "DeepSeek-V4-Flash 正式版");
    assert.equal(models[0].requests, 12);
    assert.equal(models[0].cacheRate, 800 / 1_200);
    assert.equal(total.cacheRate, 800 / 1_200);
    assert.ok(Math.abs(total.estimatedCostUsd - 0.12) < 1e-12);
  });

  it("uses a public model group instead of the upstream deployment name", () => {
    const { models } = buildUsageBreakdown({
      logs: [{
        request_id: "public-model-request",
        model_group: "tencent-deepseek-v4-flash",
        model: "openai/deepseek-v4-flash-202605",
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        startTime: "2026-07-15T01:00:00.000Z"
      }],
      scope
    });

    assert.equal(models[0].model, "tencent-deepseek-v4-flash");
  });
});
