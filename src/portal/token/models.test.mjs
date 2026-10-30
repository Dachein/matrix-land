import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyGatewayTokenRotation,
  budgetUsagePercent,
  buildAnnualDailyUsage,
  buildDefaultGatewayTokenName,
  buildTokenRowsFromAnalytics,
  formatCompactTokens,
  gatewayModelOptions,
  GATEWAY_TOKEN_NAME_INPUT_PATTERN,
  GATEWAY_TOKEN_NAME_MAX_LENGTH,
  isGatewayTokenNameValid,
  latestCompleteShanghaiDate,
  peakDailyTokens,
  usageIntensityLevel
} from "./models.ts";

describe("gateway token names", () => {
  it("builds the default name from the first email segment in Shanghai time", () => {
    const now = new Date("2026-07-13T10:35:00.000Z");

    assert.equal(
      buildDefaultGatewayTokenName("alyssa.lin@example.invalid", now),
      "alyssa-app-20260713-1835"
    );
    assert.equal(
      buildDefaultGatewayTokenName("Ályssa.lin+finance@example.com", now),
      "alyssa-app-20260713-1835"
    );
  });

  it("uses the next Shanghai calendar day across UTC midnight boundaries", () => {
    assert.equal(
      buildDefaultGatewayTokenName("ada@example.com", new Date("2026-07-13T16:05:00.000Z")),
      "ada-app-20260714-0005"
    );
  });

  it("falls back safely and keeps generated names within the API limit", () => {
    const now = new Date("2026-07-13T10:35:00.000Z");
    const fallback = buildDefaultGatewayTokenName("中文@example.com", now);
    const longName = buildDefaultGatewayTokenName(`${"a".repeat(200)}@example.com`, now);

    assert.equal(fallback, "user-app-20260713-1835");
    assert.equal(longName.length, GATEWAY_TOKEN_NAME_MAX_LENGTH);
    assert.equal(isGatewayTokenNameValid(longName), true);
  });

  it("accepts only the LiteLLM-compatible 2–120 character format", () => {
    assert.doesNotThrow(() => new RegExp(GATEWAY_TOKEN_NAME_INPUT_PATTERN, "v"));
    assert.equal(isGatewayTokenNameValid("a-b_c/d.e@f"), true);
    assert.equal(isGatewayTokenNameValid("a"), false);
    assert.equal(isGatewayTokenNameValid("team token"), false);
    assert.equal(isGatewayTokenNameValid(" valid-key "), false);
    assert.equal(isGatewayTokenNameValid("-team"), false);
    assert.equal(isGatewayTokenNameValid("team-"), false);
    assert.equal(isGatewayTokenNameValid("名-key"), false);
    assert.equal(isGatewayTokenNameValid("a".repeat(121)), false);
  });
});

describe("gateway usage analytics", () => {
  it("calculates budget usage from the live spend counter rather than historical monthly spend", () => {
    assert.equal(budgetUsagePercent(0.154381, 200), 0);
    assert.equal(budgetUsagePercent(16.5, 200), 8);
  });

  it("formats token counts with locale-specific compact units and at most one decimal", () => {
    assert.equal(formatCompactTokens(450_000_000, "zh-CN"), "4.5亿");
    assert.equal(formatCompactTokens(3_422_000, "zh-CN"), "342.2万");
    assert.equal(formatCompactTokens(33_000, "zh-CN"), "3.3万");
    assert.equal(formatCompactTokens(4_500_000_000, "en-US"), "4.5 Billion");
    assert.equal(formatCompactTokens(314_000_000, "en-US"), "314 M");
    assert.equal(formatCompactTokens(33_000, "en-US"), "33 K");
    assert.equal(formatCompactTokens(99_999_999, "zh-CN"), "1亿");
    assert.equal(formatCompactTokens(999_950_000, "en-US"), "1 Billion");
    assert.equal(formatCompactTokens(Number.NaN, "zh-CN"), "0");
    assert.equal(formatCompactTokens(-1, "en-US"), "0");
    assert.equal(formatCompactTokens(0, "en-US"), "0");
  });

  it("fills an inclusive 365-day window and aggregates duplicate snapshot dates", () => {
    const points = buildAnnualDailyUsage([{
      date: "2026-07-12",
      estimatedCostUsd: 0.2,
      requests: 1,
      tokens: 20
    }, {
      date: "2026-07-12",
      estimatedCostUsd: 0.1,
      requests: 2,
      tokens: 10
    }, {
      date: "2025-01-01",
      estimatedCostUsd: 5,
      requests: 5,
      tokens: 500
    }], "2026-07-12");

    assert.equal(points.length, 365);
    assert.equal(points[0].date, "2025-07-13");
    assert.equal(points.at(-1).date, "2026-07-12");
    assert.deepEqual(points.at(-1).summary, {
      billableUnits: 30,
      estimatedCostUsd: 0.30000000000000004,
      requests: 3
    });
    assert.deepEqual(points[0].summary, {
      billableUnits: 0,
      estimatedCostUsd: 0,
      requests: 0
    });
  });

  it("maps zero and relative daily peaks to five stable heat levels", () => {
    const points = buildAnnualDailyUsage([{
      date: "2026-07-11",
      estimatedCostUsd: 0,
      requests: 1,
      tokens: 25
    }, {
      date: "2026-07-12",
      estimatedCostUsd: 0,
      requests: 1,
      tokens: 100
    }], "2026-07-12");
    const peak = peakDailyTokens(points);

    assert.equal(peak, 100);
    assert.equal(usageIntensityLevel(0, peak), 0);
    assert.equal(usageIntensityLevel(1, peak), 1);
    assert.equal(usageIntensityLevel(5, peak), 2);
    assert.equal(usageIntensityLevel(25, peak), 3);
    assert.equal(usageIntensityLevel(100, peak), 4);
  });

  it("uses yesterday in Asia/Shanghai as the last complete fallback day", () => {
    assert.equal(latestCompleteShanghaiDate(new Date("2026-07-13T15:59:59.000Z")), "2026-07-12");
    assert.equal(latestCompleteShanghaiDate(new Date("2026-07-13T16:00:00.000Z")), "2026-07-13");
  });

  it("builds each key's current-month distribution from the analytics snapshot", () => {
    const tokens = [{ id: "token-a", name: "A" }, { id: "token-b", name: "B" }];
    const rows = buildTokenRowsFromAnalytics(tokens, [{
      estimatedCostUsd: 1.25,
      requests: 4,
      tokenId: "token-b",
      tokens: 900
    }]);

    assert.equal(rows[0].token.id, "token-b");
    assert.deepEqual(rows[0].usage, {
      billableUnits: 900,
      estimatedCostUsd: 1.25,
      requests: 4
    });
    assert.deepEqual(rows[1].usage, {
      billableUnits: 0,
      estimatedCostUsd: 0,
      requests: 0
    });
  });

  it("moves the current view's usage to a confirmed replacement but keeps an uncertain old generation visible", () => {
    const access = {
      tokens: [{ id: "hash-old", name: "Old" }],
      usage: [{ scopeType: "token", scopeId: "hash-old" }],
      series: [{ groupType: "token", groupId: "hash-old" }],
      analytics: {
        tokenUsage: [{ tokenId: "hash-old", tokens: 10, requests: 1, estimatedCostUsd: 0.1 },
          { tokenId: "hash-new", tokens: 20, requests: 2, estimatedCostUsd: 0.2 }]
      }
    };
    const replacement = { id: "hash-new", name: "New" };

    const confirmed = applyGatewayTokenRotation(access, "hash-old", replacement);
    assert.deepEqual(confirmed.tokens.map((token) => token.id), ["hash-new"]);
    assert.equal(confirmed.usage[0].scopeId, "hash-new");
    assert.equal(confirmed.series[0].groupId, "hash-new");
    assert.deepEqual(confirmed.analytics.tokenUsage, [{
      tokenId: "hash-new",
      tokens: 30,
      requests: 3,
      estimatedCostUsd: 0.30000000000000004
    }]);

    const uncertain = applyGatewayTokenRotation(access, "hash-old", replacement, true);
    assert.deepEqual(uncertain.tokens.map((token) => token.id), ["hash-old", "hash-new"]);
    assert.deepEqual(uncertain.analytics.tokenUsage, access.analytics.tokenUsage);
  });
});

describe("gateway model options", () => {
  it("preserves normalized model pricing for the token UI", () => {
    assert.deepEqual(gatewayModelOptions({
      modelOptions: [{
        id: " tencent-kimi-k3 ",
        displayName: " Kimi K3 ",
        pricing: {
          currency: "usd",
          inputPerMillionTokens: 3,
          outputPerMillionTokens: 15,
          cacheReadPerMillionTokens: 0.3
        }
      }],
      tokens: [],
      usage: [],
      series: []
    }), [{
      id: "tencent-kimi-k3",
      displayName: "Kimi K3",
      pricing: {
        currency: "USD",
        inputPerMillionTokens: 3,
        outputPerMillionTokens: 15,
        cacheReadPerMillionTokens: 0.3
      }
    }]);
  });
});
