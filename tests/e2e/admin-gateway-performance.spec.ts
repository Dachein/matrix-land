import { expect, test } from "@playwright/test";
import { mockPortalApis } from "./fixtures/portalApi";

test("renders Gateway inventory before usage and reuses section data", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
  await mockPortalApis(page);

  let allocationCalls = 0;
  let usageCalls = 0;
  let releaseUsage: (() => void) | undefined;
  const usageGate = new Promise<void>((resolve) => {
    releaseUsage = resolve;
  });

  await page.route("**/api/llm-gateway/admin/allocations?includeUsage=false", async (route) => {
    allocationCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      json: {
        gatewayUrl: "https://token.example.test",
        modelOptions: [],
        source: {
          endpoints: ["/key/list", "/user/list", "/v1/model/info"],
          fetchedAt: "2026-08-15T02:00:00.000Z",
          mode: "admin-api",
          provider: "litellm"
        },
        tokens: [{
          accessStatus: "active",
          createdAt: "2026-08-01T00:00:00.000Z",
          id: "hash-fast",
          monthlyBudgetUsd: 100,
          name: "Fast key",
          status: "active"
        }],
        usage: [],
        userLimits: [{
          allowedModels: [],
          id: "user-fast",
          monthlyBudgetUsd: 100,
          requestLimitPerMinute: 60,
          status: "active",
          tokensPerMinute: 120000,
          userId: "fast@example.test"
        }]
      }
    });
  });
  await page.route("**/api/llm-gateway/admin/usage?*", async (route) => {
    usageCalls += 1;
    await usageGate;
    await route.fulfill({
      contentType: "application/json",
      json: {
        requestTotal: 7,
        requests: [],
        series: [{
          billableUnits: 70,
          blockedRequests: 0,
          estimatedCostUsd: 0.07,
          failedRequests: 0,
          groupId: "model-fast",
          groupType: "model",
          periodStart: "2026-08-15T00:00:00.000Z",
          reasoningOutputTokens: 0,
          requests: 7
        }],
        source: {
          endpoints: ["/spend/logs", "/key/list"],
          fetchedAt: "2026-08-15T02:00:01.000Z",
          mode: "admin-api",
          provider: "litellm"
        },
        tokens: [],
        usage: []
      }
    });
  });

  await page.goto("/#/admin/gateway");

  await expect(page.getByRole("heading", { exact: true, name: "Token ledger" })).toBeVisible();
  await expect(page.getByText("Fast key", { exact: true })).toBeVisible();
  await expect(page.locator(".portal-admin-metrics > div").first().locator("strong")).toHaveText("—");
  expect(allocationCalls).toBe(1);
  expect(usageCalls).toBe(1);

  releaseUsage?.();
  await expect(page.locator(".portal-admin-metrics > div").first().locator("strong")).toHaveText("7");

  await page.getByRole("button", { exact: true, name: "User allocations" }).click();
  await expect(page.getByRole("heading", { exact: true, name: "User allocations" })).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Usage" }).click();
  await expect(page.getByRole("heading", { exact: true, name: "Usage" })).toBeVisible();

  expect(allocationCalls).toBe(1);
  expect(usageCalls).toBe(1);
});
