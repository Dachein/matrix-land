import { expect, test } from "@playwright/test";
import { mockPortalApis } from "./fixtures/portalApi";

const tokenId = "a".repeat(64);

function dailySnapshotEnding(endDate: string, count: number) {
  const endTimestamp = Date.parse(`${endDate}T00:00:00.000Z`);

  return Array.from({ length: count }, (_, index) => {
    const date = new Date(endTimestamp - ((count - index - 1) * 86_400_000)).toISOString().slice(0, 10);
    const tokens = date === "2026-06-18"
      ? 580_000_000
      : date === "2026-07-12"
        ? 12_345
        : date === "2026-05-06"
          ? 820_000
          : 0;

    return {
      date,
      estimatedCostUsd: tokens > 0 ? Number((tokens / 1_000_000).toFixed(4)) : 0,
      requests: tokens > 0 ? 1 : 0,
      tokens
    };
  });
}

const gatewayAccess = {
  analytics: {
    dailyUsage: dailySnapshotEnding("2026-07-12", 365),
    dataThroughDate: "2026-07-12",
    status: "ready",
    summary: {
      cumulativeTokens: 4_330_000_000,
      currentMonthSpendUsd: 12.34,
      monthlyBudgetUsd: 100,
      peakDailyTokens: 580_000_000
    },
    timezone: "Asia/Shanghai",
    tokenUsage: [{
      estimatedCostUsd: 12.34,
      requests: 12,
      tokenId,
      tokens: 765_432
    }],
    updatedAt: "2026-07-12T16:00:00.000Z"
  },
  gatewayUrl: "https://token.example.test",
  modelOptions: [
    {
      displayName: "Model Alpha",
      id: "model-alpha",
      pricing: {
        cacheReadPerMillionTokens: 0.05,
        currency: "USD",
        inputPerMillionTokens: 0.25,
        outputPerMillionTokens: 1
      }
    },
    {
      displayName: "Model Beta",
      id: "model-beta",
      pricing: {
        cacheReadPerMillionTokens: 0.4,
        currency: "USD",
        inputPerMillionTokens: 2,
        outputPerMillionTokens: 8
      }
    },
    {
      displayName: "Model Hidden",
      id: "model-hidden",
      pricing: {
        cacheReadPerMillionTokens: 0.1,
        currency: "USD",
        inputPerMillionTokens: 0.5,
        outputPerMillionTokens: 2
      }
    }
  ],
  source: {
    endpoints: ["/user/info", "/key/list", "/v1/model/info"],
    fetchedAt: "2026-07-13T06:00:00.000Z",
    mode: "admin-api",
    provider: "litellm"
  },
  series: [],
  tokens: [{
    accessStatus: "active",
    allowedModels: ["model-alpha", "model-beta"],
    createdAt: "2026-07-01T00:00:00.000Z",
    environment: "live",
    id: tokenId,
    lastUsedAt: "2026-07-13T05:30:00.000Z",
    monthlyBudgetPercent: 100,
    name: "E2E token",
    status: "active",
    tokenLast4: "e2e1",
    tokenPrefix: "hash-e2e",
    usagePurpose: "agent"
  }],
  usage: [],
  usageRefresh: {
    reason: "current",
    recommended: false
  },
  userLimit: {
    allowedModels: ["model-alpha", "model-beta", "model-hidden"],
    id: "litellm:user:local.admin@example.invalid",
    monthlyBudgetUsd: 999,
    spendUsd: 12.34,
    requestLimitPerMinute: 60,
    status: "active",
    tokensPerMinute: 120000,
    userId: "local.admin@example.invalid"
  }
};

test.beforeEach(async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-07-13T06:00:00.000Z"));
  await page.addInitScript((locale) => window.localStorage.setItem("workspace-ai:locale", locale), testInfo.title.includes("Chinese rotation") ? "zh-CN" : "en");
  await mockPortalApis(page);
  await page.route("**/api/llm-gateway/access", async (route) => {
    await route.fulfill({ contentType: "application/json", json: gatewayAccess });
  });
});

test("shows token statistics, a live budget, and an accessible 365-day heatmap", async ({ page }) => {
  await page.goto("/#/tokens");

  const totalTokens = page.locator('.portal-token-metric[data-metric="totalTokens"]');
  const peakDailyTokens = page.locator('.portal-token-metric[data-metric="peakDailyTokens"]');
  const monthlyCost = page.locator('.portal-token-metric[data-metric="monthlyCost"]');
  const monthlyBudget = page.locator('.portal-token-metric[data-metric="monthlyBudget"]');
  await expect(page.locator(".portal-token-metrics")).toHaveCSS("border-radius", "0px");

  await expect(totalTokens).toBeVisible();
  await expect(totalTokens).toContainText("Cumulative Tokens");
  await expect(totalTokens).toContainText(/4\.3 Billion|4,330,000,000/);
  await expect(peakDailyTokens).toBeVisible();
  await expect(peakDailyTokens).toContainText("Peak Tokens");
  await expect(peakDailyTokens).toContainText(/580 M|580,000,000/);
  await expect(monthlyCost).toBeVisible();
  await expect(monthlyCost).toContainText("This month spend");
  await expect(monthlyCost).toContainText("$12.34");
  await expect(monthlyBudget).toBeVisible();
  await expect(monthlyBudget).toContainText("Monthly budget");
  await expect(monthlyBudget).toContainText("$999");
  await expect(monthlyBudget).toContainText("1% used");

  const tokenRow = page.getByRole("button", { name: "Manage key: E2E token" });
  await expect(tokenRow).toContainText("765,432");
  await expect(tokenRow).toContainText("$12.34");

  const heatmap = page.locator(".portal-token-heatmap");
  const cells = heatmap.locator(".portal-token-heatmap-cell");
  await expect(heatmap).toBeVisible();
  await expect(cells).toHaveCount(365);
  await expect(heatmap.locator('.portal-token-heatmap-cell[data-date="2026-06-18"]')).toHaveAttribute("data-level", "4");
  await expect(heatmap.locator('.portal-token-heatmap-cell[data-date="2025-07-13"]')).toHaveAttribute("data-level", "0");

  const snapshotTime = page.locator(".portal-token-snapshot-time");
  await expect(snapshotTime).toBeVisible();
  await expect(snapshotTime.locator(".portal-token-snapshot-copy"))
    .toHaveText("Data queried through: 14 hours ago");
  await expect(snapshotTime.locator("time"))
    .toHaveAttribute("datetime", "2026-07-12T16:00:00.000Z");

  const julyTwelfth = heatmap.locator('.portal-token-heatmap-cell[data-date="2026-07-12"]');
  await julyTwelfth.hover();
  const englishTooltip = julyTwelfth.locator(".portal-token-heatmap-tooltip");
  await expect(englishTooltip).toBeVisible();
  await expect(englishTooltip).toHaveText("July 12: 12.3 K Tokens used");

  await page.getByRole("button", { exact: true, name: "Change language" }).click();
  await page.getByRole("option", { exact: true, name: "中文" }).click();

  const chineseCell = page.locator('.portal-token-heatmap-cell[data-date="2026-07-12"]');
  await chineseCell.hover();
  const chineseTooltip = chineseCell.locator(".portal-token-heatmap-tooltip");
  await expect(chineseTooltip).toBeVisible();
  await expect(chineseTooltip).toHaveText("7月12日 消耗 1.2万 Token");
  await expect(page.locator(".portal-token-snapshot-copy"))
    .toHaveText("数据查询截至：14小时前");
});

test("keeps the latest heatmap weeks visible without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto("/#/tokens");

  const viewport = page.locator(".portal-token-heatmap-scroll");
  const cells = viewport.locator(".portal-token-heatmap-cell");
  await expect(viewport).toBeVisible();
  await expect.poll(() => cells.count()).toBeLessThan(365);
  await expect(cells.last()).toHaveAttribute("data-date", "2026-07-12");
  await expect(viewport.locator('[data-date="2025-07-13"]')).toHaveCount(0);

  const dimensions = await viewport.evaluate((element) => ({
    overflowX: getComputedStyle(element).overflowX
  }));
  expect(dimensions.overflowX).toBe("hidden");
});

test("manually refreshes the latest usage statistics while keeping the live budget", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-15T03:00:00.000Z"));
  const refreshRequests: Array<{ method: string; url: string }> = [];
  let releaseRefresh!: () => void;
  const refreshBlocked = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const refreshedAnalytics = {
    ...gatewayAccess.analytics,
    dailyUsage: [{
      date: "2026-07-15",
      estimatedCostUsd: 24.56,
      requests: 18,
      tokens: 888_888
    }],
    dataThroughAt: "2026-07-15T02:29:00.000Z",
    dataThroughDate: "2026-07-15",
    lastCheckedAt: "2026-07-15T02:30:00.000Z",
    source: "snapshot",
    summary: {
      cumulativeTokens: 4_500_000_000,
      currentMonthSpendUsd: 24.56,
      monthlyBudgetUsd: 100,
      peakDailyTokens: 888_888
    },
    tokenUsage: [{
      estimatedCostUsd: 24.56,
      requests: 18,
      tokenId,
      tokens: 888_888
    }],
    triggerType: "manual",
    updatedAt: "2026-07-15T02:30:00.000Z"
  };

  await page.route("**/api/llm-gateway/access/usage/refresh", async (route) => {
    refreshRequests.push({
      method: route.request().method(),
      url: route.request().url()
    });
    await refreshBlocked;
    await route.fulfill({
      contentType: "application/json",
      json: {
        analytics: refreshedAnalytics,
        series: [],
        source: {
          ...gatewayAccess.source,
          endpoints: ["/key/list", "/spend/logs"],
          fetchedAt: "2026-07-15T02:30:00.000Z",
          range: { from: "2026-07-01", to: "2026-07-15" }
        },
        usage: []
      }
    });
  });

  await page.goto("/#/tokens");
  const refresh = page.getByRole("button", { exact: true, name: "Update statistics" });
  await refresh.click();
  await expect.poll(() => refreshRequests.length).toBe(1);
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh).toBeDisabled();
  await expect(page.locator('.portal-token-metric[data-metric="monthlyCost"]')).toContainText("$12.34");
  await expect(page.getByRole("button", { name: "Manage key: E2E token" })).toContainText("765,432");

  releaseRefresh();

  await expect(page.getByRole("status")).toHaveText("Statistics updated and saved");
  await expect(refresh).toBeEnabled();
  await expect(refresh).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator('.portal-token-metric[data-metric="totalTokens"]')).toContainText("4.5 Billion");
  await expect(page.locator('.portal-token-metric[data-metric="monthlyCost"]')).toContainText("$24.56");
  await expect(page.locator('.portal-token-metric[data-metric="monthlyBudget"]')).toContainText("$999");
  const refreshedTokenRow = page.getByRole("button", { name: "Manage key: E2E token" });
  await expect(refreshedTokenRow).toContainText("888,888");
  await expect(refreshedTokenRow).toContainText("$24.56");
  await expect(page.locator(".portal-token-snapshot-copy"))
    .toHaveText("Data queried through: 30 minutes ago");
  expect(refreshRequests).toEqual([{
    method: "POST",
    url: "http://127.0.0.1:5174/api/llm-gateway/access/usage/refresh"
  }]);
});

test("shows the saved snapshot before automatically refreshing recommended usage once", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-16T03:00:00.000Z"));
  let automaticRefreshCount = 0;
  let releaseRefresh!: () => void;
  const refreshBlocked = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const refreshedAnalytics = {
    ...gatewayAccess.analytics,
    dataThroughAt: "2026-07-16T01:59:00.000Z",
    dataThroughDate: "2026-07-16",
    lastCheckedAt: "2026-07-16T02:00:00.000Z",
    source: "snapshot",
    summary: {
      ...gatewayAccess.analytics.summary,
      currentMonthSpendUsd: 18.75
    },
    triggerType: "automatic",
    updatedAt: "2026-07-16T02:00:00.000Z"
  };

  await page.unroute("**/api/llm-gateway/access");
  await page.route("**/api/llm-gateway/access", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        ...gatewayAccess,
        usageRefresh: { reason: "key_activity", recommended: true }
      }
    });
  });
  await page.route(/\/api\/llm-gateway\/access\/usage\/refresh\?trigger=automatic$/, async (route) => {
    automaticRefreshCount += 1;
    await refreshBlocked;
    await route.fulfill({
      contentType: "application/json",
      json: {
        analytics: refreshedAnalytics,
        series: [],
        source: gatewayAccess.source,
        usage: []
      }
    });
  });

  await page.goto("/#/tokens");
  await expect(page.locator('.portal-token-metric[data-metric="monthlyCost"]')).toContainText("$12.34");
  await expect.poll(() => automaticRefreshCount).toBe(1);

  releaseRefresh();

  await expect(page.locator('.portal-token-metric[data-metric="monthlyCost"]')).toContainText("$18.75");
  await expect(page.locator(".portal-token-snapshot-copy"))
    .toHaveText("Data queried through: 1 hour ago");
  await page.waitForTimeout(100);
  expect(automaticRefreshCount).toBe(1);
});

test("keeps the saved snapshot and reloads access when automatic refresh is already running", async ({ page }) => {
  let refreshBusy = false;
  let automaticRefreshCount = 0;
  let accessReloadedAfterBusy = false;

  await page.unroute("**/api/llm-gateway/access");
  await page.route("**/api/llm-gateway/access", async (route) => {
    if (refreshBusy) {
      accessReloadedAfterBusy = true;
    }
    await route.fulfill({
      contentType: "application/json",
      json: refreshBusy
        ? {
            ...gatewayAccess,
            analytics: {
              ...gatewayAccess.analytics,
              dataThroughAt: "2026-07-16T02:59:00.000Z",
              lastCheckedAt: "2026-07-16T03:00:00.000Z",
              summary: {
                ...gatewayAccess.analytics.summary,
                currentMonthSpendUsd: 19.5
              },
              triggerType: "automatic",
              updatedAt: "2026-07-16T03:00:00.000Z"
            },
            usageRefresh: { reason: "current", recommended: false }
          }
        : {
            ...gatewayAccess,
            usageRefresh: { reason: "key_activity", recommended: true }
          }
    });
  });
  await page.route(/\/api\/llm-gateway\/access\/usage\/refresh\?trigger=automatic$/, async (route) => {
    automaticRefreshCount += 1;
    refreshBusy = true;
    await route.fulfill({
      contentType: "application/json",
      json: { error: "usage_refresh_in_progress" },
      status: 409
    });
  });

  await page.goto("/#/tokens");
  await expect(page.locator('.portal-token-metric[data-metric="monthlyCost"]')).toContainText("$12.34");
  await expect.poll(() => accessReloadedAfterBusy).toBe(true);
  await expect(page.locator('.portal-token-metric[data-metric="monthlyCost"]')).toContainText("$19.5");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(automaticRefreshCount).toBe(1);
});

test("shows a persisted scheduled snapshot and a later no-activity check", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-15T04:01:00.000Z"));
  await page.unroute("**/api/llm-gateway/access");
  await page.route("**/api/llm-gateway/access", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        ...gatewayAccess,
        analytics: {
          ...gatewayAccess.analytics,
          dataThroughAt: "2026-07-15T03:00:00.000Z",
          dataThroughDate: "2026-07-15",
          lastCheckedAt: "2026-07-15T04:00:00.000Z",
          source: "snapshot",
          triggerType: "scheduled",
          updatedAt: "2026-07-15T03:01:00.000Z"
        }
      }
    });
  });

  await page.goto("/#/tokens");
  await expect(page.locator(".portal-token-snapshot-copy"))
    .toHaveText("Data queried through: 1 hour ago");
});

test("keeps the last good statistics when a manual refresh fails", async ({ page }) => {
  let refreshRequestCount = 0;
  await page.route("**/api/llm-gateway/access/usage/refresh", async (route) => {
    refreshRequestCount += 1;
    await route.fulfill({
      contentType: "application/json",
      json: { error: "litellm_unavailable" },
      status: 502
    });
  });

  await page.goto("/#/tokens");
  await page.getByRole("button", { exact: true, name: "Update statistics" }).click();

  await expect(page.getByRole("alert")).toHaveText("Could not update statistics. Try again later.");
  await expect(page.locator('.portal-token-metric[data-metric="totalTokens"]')).toContainText("4.3 Billion");
  await expect(page.locator('.portal-token-metric[data-metric="monthlyCost"]')).toContainText("$12.34");
  await expect(page.locator('.portal-token-metric[data-metric="monthlyBudget"]')).toContainText("$999");
  const retainedTokenRow = page.getByRole("button", { name: "Manage key: E2E token" });
  await expect(retainedTokenRow).toContainText("765,432");
  await expect(retainedTokenRow).toContainText("$12.34");
  expect(refreshRequestCount).toBe(1);
});

test("does not invent a data-through date when the first nightly snapshot fails", async ({ page }) => {
  await page.unroute("**/api/llm-gateway/access");
  await page.route("**/api/llm-gateway/access", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        ...gatewayAccess,
        analytics: {
          ...gatewayAccess.analytics,
          dailyUsage: [],
          dataThroughDate: undefined,
          status: "error",
          summary: {
            cumulativeTokens: 0,
            currentMonthSpendUsd: 0,
            monthlyBudgetUsd: 0,
            peakDailyTokens: 0
          },
          tokenUsage: []
        }
      }
    });
  });

  await page.goto("/#/tokens");
  await expect(page.locator(".portal-token-snapshot-time")).toHaveCount(0);
  await expect(page.locator('.portal-token-metric[data-metric="totalTokens"] strong')).toHaveText("—");
  await expect(page.locator('.portal-token-metric[data-metric="monthlyBudget"]')).toContainText("$999");
  await expect(page.locator('.portal-token-metric[data-metric="monthlyBudget"]')).toContainText("Live LiteLLM budget limit");
  const unavailableTokenRow = page.getByRole("button", { name: "Manage key: E2E token" });
  await expect(unavailableTokenRow.locator(':scope > span[data-label="Monthly tokens"] strong')).toHaveText("—");
  await expect(unavailableTokenRow.locator(':scope > span[data-label="Estimated cost"] strong')).toHaveText("—");
});

test("shows the manual refresh hint while waiting for the first snapshot", async ({ page }) => {
  await page.unroute("**/api/llm-gateway/access");
  await page.route("**/api/llm-gateway/access", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        ...gatewayAccess,
        analytics: {
          ...gatewayAccess.analytics,
          dailyUsage: [],
          dataThroughDate: undefined,
          status: "pending",
          summary: {
            cumulativeTokens: 0,
            currentMonthSpendUsd: 0,
            monthlyBudgetUsd: 0,
            peakDailyTokens: 0
          },
          tokenUsage: [],
          updatedAt: undefined
        }
      }
    });
  });

  await page.goto("/#/tokens");
  await expect(page.locator(".portal-token-snapshot-time")).toHaveCount(0);
  await expect(page.locator('.portal-token-metric[data-metric="totalTokens"] strong')).toHaveText("—");
  await expect(page.locator('.portal-token-metric[data-metric="monthlyBudget"]')).toContainText("$999");
});

test("labels retained data as stale when a later nightly snapshot fails", async ({ page }) => {
  await page.unroute("**/api/llm-gateway/access");
  await page.route("**/api/llm-gateway/access", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        ...gatewayAccess,
        analytics: {
          ...gatewayAccess.analytics,
          status: "error"
        }
      }
    });
  });

  await page.goto("/#/tokens");
  await expect(page.locator(".portal-token-snapshot-copy"))
    .toHaveText("Data queried through: 14 hours ago");
  await expect(page.locator('.portal-token-metric[data-metric="totalTokens"]')).toContainText("4.3 Billion");
  await expect(page.locator('.portal-token-metric[data-metric="monthlyBudget"]')).toContainText("$999");
});

test("opens token detail as a modal and verifies the selected token in its Test playground", async ({ page }) => {
  const rawKey = "sk-e2e-token-secret";
  const prompt = "Verify this token now.";
  const testRequests: Array<{ body: unknown; url: string }> = [];

  await page.route("**/api/llm-gateway/access/tokens/*/test", async (route) => {
    testRequests.push({
      body: await route.request().postDataJSON(),
      url: route.request().url()
    });
    await route.fulfill({
      contentType: "application/json",
      headers: { "x-request-id": "req-token-e2e" },
      json: {
        choices: [{ finish_reason: "stop", message: { content: "Token verification succeeded." } }],
        id: "chat-token-e2e",
        model: "model-beta",
        usage: { completion_tokens: 3, prompt_tokens: 6, total_tokens: 9 }
      }
    });
  });

  await page.goto("/#/tokens");
  const tokenRow = page.getByRole("button", { name: "Manage key: E2E token" });
  await expect(tokenRow.locator(".portal-token-row-identity strong")).toHaveCSS("font-size", "14px");
  await expect(tokenRow.locator(".portal-token-row-identity code")).toHaveCSS("font-size", "11px");
  const ledgerAlignment = await page.locator(".portal-token-ledger").evaluate((ledger) => {
    const manageLabel = ledger.querySelector<HTMLElement>(".portal-token-ledger-header > span:last-child");
    const rowArrow = ledger.querySelector<HTMLElement>(".portal-token-row-open");
    if (!manageLabel || !rowArrow) throw new Error("token_ledger_alignment_targets_missing");
    const range = document.createRange();
    range.selectNodeContents(manageLabel);
    const labelRect = range.getBoundingClientRect();
    const arrowRect = rowArrow.getBoundingClientRect();
    const ledgerRect = ledger.getBoundingClientRect();
    return {
      centerDelta: Math.abs((labelRect.left + labelRect.right) / 2 - (arrowRect.left + arrowRect.right) / 2),
      rightGap: ledgerRect.right - labelRect.right
    };
  });
  expect(ledgerAlignment.centerDelta).toBeLessThanOrEqual(3);
  expect(ledgerAlignment.rightGap).toBeGreaterThan(27);
  await tokenRow.click();

  const detail = page.getByRole("dialog", { name: "Manage key: E2E token" });
  await expect(detail).toBeVisible();
  await expect(page.locator(".portal-token-inspector")).toHaveCount(0);
  await expect(detail.getByRole("heading", { name: "How to Use" })).toBeVisible();
  await expect(detail.getByText("https://token.example.test/v1", { exact: true })).toBeVisible();
  await expect(detail.getByText("Choose a typical usage scenario and copy its example. LiteLLM normalizes differences between model providers.", { exact: true })).toHaveCount(0);
  await expect(detail.getByText("Choose a usage scenario", { exact: true })).toBeVisible();
  await expect(detail.getByText("LiteLLM · OpenAI Compatible", { exact: true })).toBeVisible();
  const selectedPricing = detail.locator(".portal-token-model-pricing");
  await expect(selectedPricing).toContainText("Input$0.25");
  await expect(selectedPricing).toContainText("Output$1");
  await expect(selectedPricing).toContainText("Cache read$0.05");
  await detail.getByRole("button", { exact: true, name: "Model capability and price comparison" }).click();
  const pricingPanel = detail.locator(".portal-token-pricing-panel");
  await expect(pricingPanel).toBeVisible();
  await expect(pricingPanel.locator("tbody tr")).toHaveCount(2);
  await expect(pricingPanel.locator("tbody")).not.toContainText("Model Hidden");
  await detail.getByRole("complementary", { name: "Model capability and price comparison", exact: true }).getByRole("button", { exact: true, name: "Close token test" }).click();
  await expect(pricingPanel).toHaveCount(0);
  await expect(detail.getByRole("button", { exact: true, name: "Node.js" })).toHaveAttribute("aria-pressed", "true");
  await detail.getByRole("button", { exact: true, name: "Python" }).click();
  await expect(detail.locator(".portal-token-agent-copy pre")).toContainText("from openai import OpenAI");
  await expect(detail.locator(".portal-token-agent-copy pre")).toContainText('base_url="https://token.example.test/v1"');
  await expect(detail.getByRole("slider", { name: "Budget %" })).toHaveCSS("accent-color", "rgb(17, 17, 15)");

  const detailPurpose = detail.getByRole("button", { exact: true, name: "Use case" });
  await expect(detailPurpose).toHaveAttribute("aria-haspopup", "listbox");
  await expect(detailPurpose).toHaveClass(/workspaceListboxTrigger/);
  await detailPurpose.click();
  const detailPurposeListbox = page.getByRole("listbox", { exact: true, name: "Use case" });
  await expect(detailPurposeListbox.getByRole("option")).toHaveText(["Agent use", "App development"]);
  await detailPurposeListbox.getByRole("option", { exact: true, name: "App development" }).click();
  await expect(detailPurpose).toContainText("App development");

  const howToModel = detail.getByRole("button", { exact: true, name: "Supported Models" });
  await expect(howToModel).toHaveAttribute("aria-haspopup", "listbox");
  await expect(howToModel).toHaveClass(/workspaceListboxTrigger/);
  await howToModel.click();
  const howToModelListbox = page.getByRole("listbox", { exact: true, name: "Supported Models" });
  await expect(howToModelListbox.getByRole("option")).toHaveText(["Model Alpha", "Model Beta"]);
  await expect(howToModelListbox.getByRole("option", { name: "Model Hidden" })).toHaveCount(0);
  await howToModelListbox.getByRole("option", { exact: true, name: "Model Beta" }).click();
  await expect(howToModel).toContainText("Model Beta");
  await expect(selectedPricing).toContainText("Input$2");
  await expect(selectedPricing).toContainText("Output$8");
  await expect(selectedPricing).toContainText("Cache read$0.4");

  await detail.getByRole("button", { exact: true, name: "Test" }).click();
  const playground = detail.getByRole("complementary", { name: "Token test playground" });
  await expect(playground).toBeVisible();

  const model = playground.getByRole("button", { exact: true, name: "Supported Models" });
  await expect(model).toBeFocused();
  await expect(model).toContainText("Model Beta");
  await expect(model).toHaveAttribute("aria-haspopup", "listbox");
  await expect(model).toHaveClass(/workspaceListboxTrigger/);
  await model.click();
  const testModelListbox = page.getByRole("listbox", { exact: true, name: "Supported Models" });
  await expect(testModelListbox.getByRole("option")).toHaveText(["Model Alpha", "Model Beta"]);
  await expect(testModelListbox.getByRole("option", { name: "Model Hidden" })).toHaveCount(0);
  await testModelListbox.getByRole("option", { exact: true, name: "Model Alpha" }).click();
  await playground.getByRole("textbox", { name: /^API Key/ }).fill(rawKey);
  await playground.getByRole("textbox", { exact: true, name: "Input" }).fill(prompt);
  await playground.getByRole("button", { exact: true, name: "Run" }).click();

  await expect(playground.getByText("Token verification succeeded.", { exact: true })).toBeVisible();
  await expect(playground.getByText("Token is usable", { exact: true })).toBeVisible();
  await expect(playground.getByText("9 tokens", { exact: true })).toBeVisible();
  await expect(playground.getByText("req-token-e2e", { exact: true })).toBeVisible();
  await expect.poll(() => testRequests.length).toBe(1);
  expect(testRequests[0]).toEqual({
    body: {
      apiKey: rawKey,
      messages: [{ content: prompt, role: "user" }],
      model: "model-alpha"
    },
    url: `http://127.0.0.1:5174/api/llm-gateway/access/tokens/${tokenId}/test`
  });

  await playground.getByRole("button", { name: "Close token test" }).click();
  await expect(detail.getByRole("button", { exact: true, name: "Test" })).toBeFocused();
});

test("offers Agent and App usage purposes and opens the new key in its inspector", async ({ context, page }) => {
  const createRequests: unknown[] = [];
  const rawCreatedKey = "sk-created-e2e";
  const createdTokenRecord = {
    ...gatewayAccess.tokens[0],
    id: "b".repeat(64),
    name: "app-integration-key",
    tokenLast4: "-e2e",
    tokenPrefix: "hash-created",
    usagePurpose: "app"
  };
  let currentGatewayAccess = gatewayAccess;

  await page.unroute("**/api/llm-gateway/access");
  await page.route("**/api/llm-gateway/access", async (route) => {
    await route.fulfill({ contentType: "application/json", json: currentGatewayAccess });
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:5174" });

  await page.route("**/api/llm-gateway/access/tokens", async (route) => {
    createRequests.push(await route.request().postDataJSON());
    currentGatewayAccess = {
      ...gatewayAccess,
      tokens: [createdTokenRecord, ...gatewayAccess.tokens]
    };
    await route.fulfill({
      contentType: "application/json",
      json: {
        token: rawCreatedKey,
        tokenRecord: createdTokenRecord
      },
      status: 201
    });
  });

  await page.goto("/#/tokens");
  await page.getByRole("button", { exact: true, name: "Create new key" }).click();

  const createDialog = page.getByRole("dialog", { name: "Create Frontier Workspace key" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByLabel("Key name")).toHaveValue(/^local-app-\d{8}-\d{4}$/);
  const purpose = createDialog.getByRole("button", { exact: true, name: "Use case" });
  await expect(purpose).toHaveAttribute("aria-haspopup", "listbox");
  await expect(purpose).toHaveClass(/workspaceListboxTrigger/);
  await expect(purpose).toContainText("Agent use");
  await expect(createDialog.getByRole("slider", { name: "Budget %" })).toHaveCSS("accent-color", "rgb(17, 17, 15)");

  await createDialog.getByLabel("Key name").fill("app-integration-key");
  await purpose.click();
  const purposeListbox = page.getByRole("listbox", { exact: true, name: "Use case" });
  await expect(purposeListbox.getByRole("option")).toHaveText(["Agent use", "App development"]);
  await purposeListbox.getByRole("option", { exact: true, name: "App development" }).click();
  await expect(purpose).toContainText("App development");
  await createDialog.getByRole("button", { exact: true, name: "Create key" }).click();

  await expect.poll(() => createRequests.length).toBe(1);
  expect(createRequests[0]).toEqual({
    monthlyBudgetPercent: 100,
    name: "app-integration-key",
    usagePurpose: "app"
  });
  await expect(createDialog).toHaveCount(0);
  const detail = page.getByRole("dialog", { name: "Manage key: app-integration-key" });
  await expect(detail.getByText("Key created", { exact: true })).toBeVisible();
  await expect(detail.getByText(rawCreatedKey, { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Hide API key" }).click();
  await expect(detail.getByText("sk-••••••••••••-e2e", { exact: true })).toBeVisible();
  await expect(detail.getByText(rawCreatedKey, { exact: true })).toHaveCount(0);

  await detail.getByRole("button", { name: "Copy Base URL" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("https://token.example.test/v1");
  await detail.getByRole("button", { name: "Copy Model" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("model-alpha");
  await detail.getByRole("button", { name: "Copy API key" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(rawCreatedKey);

  await detail.getByRole("button", { name: "Show API key" }).click();
  await expect(detail.getByText(rawCreatedKey, { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Hide API key" }).click();
  await expect(detail.getByText(rawCreatedKey, { exact: true })).toHaveCount(0);

  await detail.getByRole("button", { exact: true, name: "cURL" }).click();
  await detail.getByRole("button", { name: "Copy selected scenario example" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("WORKSPACE_LLM_APP_KEY");

  await detail.getByRole("button", { exact: true, name: "Agent / CLI" }).click();
  await detail.getByRole("button", { name: "Copy selected scenario example" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("OPENAI_BASE_URL='https://token.example.test/v1'");
});

test("rotates an existing key and keeps the one-time replacement copyable in the open detail", async ({ context, page }) => {
  const rawRotatedKey = "sk-rotated-e2e-secret";
  const rotatedTokenRecord = {
    ...gatewayAccess.tokens[0],
    id: "c".repeat(64),
    tokenLast4: "cdef",
    tokenPrefix: "cccccccccc"
  };
  const rotateRequests = [];
  let currentGatewayAccess = gatewayAccess;

  await page.unroute("**/api/llm-gateway/access");
  await page.route("**/api/llm-gateway/access", async (route) => {
    await route.fulfill({ contentType: "application/json", json: currentGatewayAccess });
  });
  await page.route("**/api/llm-gateway/access/tokens/*/rotate", async (route) => {
    rotateRequests.push({
      method: route.request().method(),
      url: route.request().url()
    });
    currentGatewayAccess = {
      ...gatewayAccess,
      tokens: [rotatedTokenRecord]
    };
    await route.fulfill({
      contentType: "application/json",
      json: {
        token: rawRotatedKey,
        tokenRecord: rotatedTokenRecord
      },
      status: 201
    });
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:5174" });

  await page.goto("/#/tokens");
  await page.getByRole("button", { name: "Manage key: E2E token" }).click();

  const detail = page.getByRole("dialog", { name: "Manage key: E2E token" });
  const copyKey = detail.getByRole("button", { name: "Copy API key" });
  await expect(detail.getByText("The full key is shown only at creation.", { exact: false })).toBeVisible();
  await expect(copyKey).toBeDisabled();
  await detail.getByRole("button", { exact: true, name: "Rotate key" }).click();
  const confirmation = page.getByRole("dialog", { name: "Rotate key?" });
  await expect(confirmation).toContainText("immediately disables the old key");
  expect(rotateRequests).toHaveLength(0);
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(rotateRequests).toHaveLength(0);
  await expect(copyKey).toBeDisabled();
  await detail.getByRole("button", { exact: true, name: "Rotate key" }).click();
  await confirmation.getByRole("button", { name: "Confirm rotation", exact: true }).click();
  await expect(confirmation).toHaveCount(0);

  await expect.poll(() => rotateRequests.length).toBe(1);
  expect(rotateRequests[0]).toEqual({
    method: "POST",
    url: `http://127.0.0.1:5174/api/llm-gateway/access/tokens/${tokenId}/rotate`
  });
  await expect(detail).toBeVisible();
  await expect(detail.getByText("Using the key from this creation session; it is not persisted.", { exact: true })).toBeVisible();
  await expect(detail.getByText("The full key is shown only at creation.", { exact: false })).toHaveCount(0);
  await expect(detail.getByText("sk-••••••••••••cret", { exact: true })).toBeVisible();
  await expect(copyKey).toBeEnabled();

  await copyKey.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(rawRotatedKey);
  await detail.getByRole("button", { name: "Show API key" }).click();
  await expect(detail.getByText(rawRotatedKey, { exact: true })).toBeVisible();

  await detail.getByRole("button", { exact: true, name: "Test" }).click();
  const playground = detail.getByRole("complementary", { name: "Token test playground" });
  await expect(playground.getByRole("textbox", { name: /^API Key/ })).toHaveValue(rawRotatedKey);
});

test("shows a specific inline error when the key name already exists", async ({ page }) => {
  let createRequestCount = 0;
  await page.route("**/api/llm-gateway/access/tokens", async (route) => {
    createRequestCount += 1;
    await route.fulfill({
      contentType: "application/json",
      json: { error: "gateway_token_name_conflict" },
      status: 409
    });
  });

  await page.goto("/#/tokens");
  await page.getByRole("button", { exact: true, name: "Create new key" }).click();

  const createDialog = page.getByRole("dialog", { name: "Create Frontier Workspace key" });
  const nameInput = createDialog.getByLabel("Key name");
  await nameInput.fill("existing-key");
  await createDialog.getByRole("button", { exact: true, name: "Create key" }).click();

  await expect(createDialog.getByRole("alert")).toHaveText(
    "This key name is already in use. Choose a different name and try again."
  );
  await expect(createDialog).toBeVisible();
  await expect(nameInput).toHaveValue("existing-key");
  expect(createRequestCount).toBe(1);
});

test("shows the same inline conflict when renaming an existing key", async ({ page }) => {
  let updateRequestCount = 0;
  await page.route(/\/api\/llm-gateway\/access\/tokens\/[^/]+$/, async (route) => {
    updateRequestCount += 1;
    await route.fulfill({
      contentType: "application/json",
      json: { error: "gateway_token_name_conflict" },
      status: 409
    });
  });

  await page.goto("/#/tokens");
  await page.getByRole("button", { name: "Manage key: E2E token" }).click();

  const detail = page.getByRole("dialog", { name: "Manage key: E2E token" });
  const nameInput = detail.getByLabel("Key name");
  await nameInput.fill("existing-key");
  await detail.getByRole("button", { exact: true, name: "Save changes" }).click();

  await expect(detail.getByRole("alert")).toHaveText(
    "This key name is already in use. Choose a different name and try again."
  );
  await expect(detail).toBeVisible();
  await expect(nameInput).toHaveValue("existing-key");
  expect(updateRequestCount).toBe(1);
});

function breakdownPayload(scope, overrides = {}) {
  return {
    models: [
      {
        model: "model-alpha",
        displayName: "Model Alpha",
        requests: 12,
        inputTokens: 400_000,
        outputTokens: 100_000,
        cacheReadTokens: 60_000,
        cacheWriteTokens: 0,
        totalTokens: 500_000,
        cacheRate: 0.15,
        estimatedCostUsd: 6.25
      },
      {
        model: "model-beta",
        displayName: "Model Beta",
        requests: 8,
        inputTokens: 200_000,
        outputTokens: 50_000,
        cacheReadTokens: 20_000,
        cacheWriteTokens: 5_000,
        totalTokens: 250_000,
        cacheRate: 0.1,
        estimatedCostUsd: 8.5
      }
    ],
    scope,
    source: gatewayAccess.source,
    total: {
      requests: 20,
      inputTokens: 600_000,
      outputTokens: 150_000,
      cacheReadTokens: 80_000,
      cacheWriteTokens: 5_000,
      totalTokens: 750_000,
      cacheRate: 80_000 / 600_000,
      estimatedCostUsd: 14.75
    },
    ...overrides
  };
}

test("opens the cost breakdown from the this-month spend detail link", async ({ page }) => {
  const breakdownRequests = [];
  await page.route("**/api/llm-gateway/access/usage/breakdown*", async (route) => {
    const url = new URL(route.request().url());
    const scope = url.searchParams.get("scope") ?? "month";
    breakdownRequests.push(scope);
    await route.fulfill({
      contentType: "application/json",
      json: breakdownPayload({
        from: scope === "month" ? "2026-07-01" : "2026-07-13",
        to: "2026-07-15",
        type: scope
      })
    });
  });

  await page.goto("/#/tokens");
  await page.locator('.portal-token-metric[data-metric="monthlyCost"]')
    .getByRole("button", { name: "View Detail" })
    .click();

  const dialog = page.getByRole("dialog", { name: "Cost breakdown" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "This month" })).toHaveAttribute("aria-pressed", "true");

  const table = dialog.locator(".portal-token-breakdown-table");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.getByRole("row", { name: /Model Alpha/ })).toContainText("500,000");
  await expect(table.getByRole("row", { name: /Model Alpha/ })).toContainText("$6.25");
  await expect(table.getByRole("row", { name: /Model Beta/ })).toContainText("250,000");
  const totalRow = table.locator("tbody").getByRole("row", { name: /^Total/ });
  await expect(totalRow).toContainText("750,000");
  await expect(totalRow).toContainText("$14.75");
  await expect.poll(() => breakdownRequests).toEqual(["month"]);
});

test("opens the cost breakdown from the cumulative tokens detail link with all history", async ({ page }) => {
  const breakdownRequests = [];
  await page.route("**/api/llm-gateway/access/usage/breakdown*", async (route) => {
    const url = new URL(route.request().url());
    const scope = url.searchParams.get("scope") ?? "all";
    breakdownRequests.push({ scope, date: url.searchParams.get("date"), key: url.searchParams.get("key") });
    await route.fulfill({
      contentType: "application/json",
      json: breakdownPayload({
        from: "2026-07-13",
        to: "2026-07-15",
        type: scope
      })
    });
  });

  await page.goto("/#/tokens");
  await page.locator('.portal-token-metric[data-metric="totalTokens"]')
    .getByRole("button", { name: "View Detail" })
    .click();

  const dialog = page.getByRole("dialog", { name: "Cost breakdown" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "All history" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => breakdownRequests).toEqual([{ scope: "all", date: null, key: null }]);
});

test("opens the cost breakdown for a specific date when clicking a heatmap cell", async ({ page }) => {
  const breakdownRequests = [];
  await page.route("**/api/llm-gateway/access/usage/breakdown*", async (route) => {
    const url = new URL(route.request().url());
    const scope = url.searchParams.get("scope") ?? "date";
    breakdownRequests.push({ scope, date: url.searchParams.get("date"), key: url.searchParams.get("key") });
    await route.fulfill({
      contentType: "application/json",
      json: breakdownPayload({
        from: url.searchParams.get("date") ?? "2026-07-12",
        to: url.searchParams.get("date") ?? "2026-07-12",
        type: scope
      })
    });
  });

  await page.goto("/#/tokens");
  await page.locator('.portal-token-heatmap-cell[data-date="2026-07-12"]').click();

  const dialog = page.getByRole("dialog", { name: "Cost breakdown" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Pick a date" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.locator('input[type="date"]')).toHaveValue("2026-07-12");
  await expect.poll(() => breakdownRequests).toEqual([{ scope: "date", date: "2026-07-12", key: null }]);
});

test("filters the cost breakdown by a single key", async ({ page }) => {
  const breakdownRequests = [];
  await page.route("**/api/llm-gateway/access/usage/breakdown*", async (route) => {
    const url = new URL(route.request().url());
    const scope = url.searchParams.get("scope") ?? "month";
    breakdownRequests.push({ scope, key: url.searchParams.get("key") });
    await route.fulfill({
      contentType: "application/json",
      json: breakdownPayload({ from: "2026-07-01", to: "2026-07-15", type: scope })
    });
  });

  await page.goto("/#/tokens");
  await page.locator('.portal-token-metric[data-metric="monthlyCost"]')
    .getByRole("button", { name: "View Detail" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Cost breakdown" });
  await expect(dialog.locator(".workspaceListboxValue")).toContainText("ALL");

  await dialog.getByRole("button", { name: "Key filter" }).click();
  await page.getByRole("option", { name: /E2E token/ }).click();

  await expect(dialog.locator(".workspaceListboxValue")).toContainText(/E2E token/);
  await expect.poll(() => breakdownRequests.at(-1)).toEqual({ scope: "month", key: tokenId });
});

test("hides the cumulative total row when the breakdown has a single model", async ({ page }) => {
  await page.route("**/api/llm-gateway/access/usage/breakdown*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: breakdownPayload(
        { from: "2026-07-01", to: "2026-07-15", type: "month" },
        { models: breakdownPayload({ type: "month", from: "2026-07-01", to: "2026-07-15" }).models.slice(0, 1) }
      )
    });
  });

  await page.goto("/#/tokens");
  await page.locator('.portal-token-metric[data-metric="monthlyCost"]')
    .getByRole("button", { name: "View Detail" })
    .click();

  const dialog = page.getByRole("dialog", { name: "Cost breakdown" });
  const table = dialog.locator(".portal-token-breakdown-table");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.getByRole("row", { name: /Model Alpha/ })).toContainText("500,000");
  await expect(table.locator("tr.total")).toHaveCount(0);
});


test("shows the Chinese rotation warning and cancels without changing a key", async ({ page }) => {
  let rotations = 0;
  await page.route("**/api/llm-gateway/access/tokens/*/rotate", async (route) => {
    rotations += 1;
    await route.fulfill({ status: 500, json: { error: "unexpected_rotation" } });
  });
  await page.goto("/#/tokens");
  await page.locator(".portal-token-row").first().click();
  await page.getByRole("button", { name: "轮换 Key", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认轮换 Key？" });
  await expect(confirmation).toContainText("立即停用旧 Key");
  await expect(confirmation.getByRole("button", { name: "确认轮换" })).toBeVisible();
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(rotations).toBe(0);
  await expect(page.locator(".portal-token-row").first()).toContainText("E2E token");
});
