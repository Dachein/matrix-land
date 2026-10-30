import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateLiteLlmSpendLogs,
  chunkIsoDateRange,
  createLiteLlmSpendAccumulator,
  shanghaiSpendQueryRange,
  usageRollupWindow
} from "./rollup.ts";

describe("token usage nightly rollup boundaries", () => {
  it("maps 16:00 UTC to Shanghai midnight and snapshots the completed prior day", () => {
    assert.deepEqual(
      usageRollupWindow(new Date("2026-07-13T16:00:00.000Z")),
      { snapshotDate: "2026-07-14", dataThroughDate: "2026-07-13" }
    );
  });

  it("assigns 15:59Z and 16:00Z to different Asia/Shanghai dates", () => {
    const result = aggregateLiteLlmSpendLogs([
      {
        request_id: "before-midnight",
        api_key: "hash-a",
        user: "ada@example.com",
        startTime: "2026-07-13T15:59:59.999Z",
        prompt_tokens: 8,
        completion_tokens: 2,
        total_tokens: 10,
        spend: 0.01
      },
      {
        request_id: "at-midnight",
        api_key: "hash-a",
        user: "ada@example.com",
        startTime: "2026-07-13T16:00:00.000Z",
        prompt_tokens: 16,
        completion_tokens: 4,
        total_tokens: 20,
        spend: 0.02
      }
    ], new Map(), "2026-07-13", "2026-07-14");

    assert.deepEqual(result.rows.map((row) => [row.date, row.tokens]), [
      ["2026-07-13", 10],
      ["2026-07-14", 20]
    ]);
    assert.equal(result.attributedRowCount, 2);
  });

  it("queries exact UTC boundaries for completed Shanghai dates", () => {
    assert.deepEqual(shanghaiSpendQueryRange("2026-07-01", "2026-07-31"), {
      startDate: "2026-06-30 16:00:00",
      endDate: "2026-07-31 16:00:00"
    });
  });

  it("filters source rows back to the requested local-date interval", () => {
    const result = aggregateLiteLlmSpendLogs([
      { request_id: "early", api_key: "hash-a", user: "ada@example.com", startTime: "2026-06-29T15:00:00Z", total_tokens: 99 },
      { request_id: "inside", api_key: "hash-a", user: "ada@example.com", startTime: "2026-06-30T16:00:00Z", total_tokens: 10 },
      { request_id: "late", api_key: "hash-a", user: "ada@example.com", startTime: "2026-08-01T16:00:00Z", total_tokens: 99 }
    ], new Map(), "2026-07-01", "2026-07-31");

    assert.deepEqual(result.rows.map((row) => row.tokens), [10]);
  });

  it("uses the key owner when a spend row omits its user", () => {
    const result = aggregateLiteLlmSpendLogs([
      { request_id: "mapped", api_key: "hash-a", startTime: "2026-07-01T08:00:00Z", total_tokens: 10 },
      { request_id: "unknown", api_key: "hash-b", startTime: "2026-07-01T09:00:00Z", total_tokens: 20 }
    ], new Map([["hash-a", "ADA@EXAMPLE.COM"]]), "2026-07-01", "2026-07-01");

    assert.equal(result.rows[0].externalUserId, "ada@example.com");
    assert.equal(result.attributedRowCount, 1);
    assert.equal(result.unattributedRowCount, 1);
  });

  it("persists model, cache, and request-time cost components in the daily ledger", () => {
    const result = aggregateLiteLlmSpendLogs([{
      request_id: "priced-request",
      api_key: "hash-a",
      user: "ada@example.com",
      startTime: "2026-08-19T08:00:00Z",
      model: "openai/deepseek-v4-flash-202605",
      model_group: "tencent-deepseek-v4-flash",
      custom_llm_provider: "openai",
      prompt_tokens: 1_000,
      completion_tokens: 200,
      total_tokens: 1_200,
      spend: 0.14,
      metadata: {
        usage_object: {
          prompt_tokens_details: { cached_tokens: 800 },
          completion_tokens_details: { reasoning_tokens: 150 }
        },
        cost_breakdown: {
          input_cost: 0.04,
          output_cost: 0.1,
          original_cost: 0.16,
          discount_amount: 0.02,
          total_cost: 0.14
        }
      }
    }], new Map(), "2026-08-19", "2026-08-19");

    assert.deepEqual(result.modelRows, [{
      date: "2026-08-19",
      externalUserId: "ada@example.com",
      tokenId: "hash-a",
      modelGroup: "tencent-deepseek-v4-flash",
      upstreamModel: "openai/deepseek-v4-flash-202605",
      provider: "openai",
      requests: 1,
      inputTokens: 1_000,
      cacheReadInputTokens: 800,
      cacheWriteInputTokens: 0,
      outputTokens: 200,
      reasoningOutputTokens: 150,
      tokens: 1_200,
      inputCostUsd: 0.04,
      outputCostUsd: 0.1,
      cacheReadCostUsd: 0,
      cacheWriteCostUsd: 0,
      toolCostUsd: 0,
      originalCostUsd: 0.16,
      discountUsd: 0.02,
      billedCostUsd: 0.14
    }]);
    assert.equal(result.rows[0].estimatedCostUsd, 0.14);
  });

  it("folds many pages into daily totals without retaining raw rows", () => {
    const accumulator = createLiteLlmSpendAccumulator(new Map(), "2026-08-19", "2026-08-19");
    accumulator.add([spendRow("page-1", 10, 0.01)]);
    accumulator.add([spendRow("page-2", 20, 0.02), spendRow("page-1", 10, 0.01)]);

    const result = accumulator.result();
    assert.equal(result.sourceRowCount, 3);
    assert.equal(result.attributedRowCount, 2);
    assert.equal(result.rows[0].tokens, 30);
    assert.equal(result.modelRows[0].billedCostUsd, 0.03);
  });

  it("splits long history backfills into non-overlapping inclusive chunks", () => {
    assert.deepEqual(chunkIsoDateRange("2026-01-30", "2026-02-03", 2), [
      { fromDate: "2026-01-30", toDate: "2026-01-31" },
      { fromDate: "2026-02-01", toDate: "2026-02-02" },
      { fromDate: "2026-02-03", toDate: "2026-02-03" }
    ]);
  });
});

function spendRow(requestId, tokens, spend) {
  return {
    request_id: requestId,
    api_key: "hash-a",
    user: "ada@example.com",
    startTime: "2026-08-19T08:00:00Z",
    model: "openai/glm-5.3",
    model_group: "tencent-glm-5.3",
    prompt_tokens: tokens,
    completion_tokens: 0,
    total_tokens: tokens,
    spend
  };
}
