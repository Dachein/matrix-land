import { expect, test } from "@playwright/test";
import {
  collectRuntimeErrors,
  mockPortalApis
} from "./fixtures/portalApi";

test("localizes the canonical community level in both rails", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    if (!window.localStorage.getItem("workspace-ai:locale")) {
      window.localStorage.setItem("workspace-ai:locale", "en");
    }
  });
  await mockPortalApis(page);
  await page.goto("/#/home");
  await expect(page.locator("main.portal-workspace")).toBeVisible();

  const accountProfile = page.locator(".portal-account-profile");
  await expect(accountProfile.getByText("Level 3 · Contributor", { exact: true })).toBeVisible();
  await expect(accountProfile.getByText("AI Adoption", { exact: true })).toHaveCount(0);

  const onlineList = page.locator(".portal-online-list");
  await expect(onlineList.getByText("Local Admin", { exact: true })).toBeVisible();
  await expect(onlineList.getByText("Level 3 · Contributor", { exact: true })).toBeVisible();
  await expect(onlineList.getByText("AI Adoption", { exact: true })).toHaveCount(0);
  await expect(onlineList.getByText(/viewing|正在浏览/i)).toHaveCount(0);

  await page.evaluate(() => window.localStorage.setItem("workspace-ai:locale", "zh-CN"));
  await page.reload();
  await expect(page.locator("main.portal-workspace")).toBeVisible();
  await expect(page.locator(".portal-account-profile").getByText("Level 3 · 贡献者", { exact: true })).toBeVisible();
  await expect(page.locator(".portal-online-list").getByText("Level 3 · 贡献者", { exact: true })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("does not fall back to organization data when the current journey is unavailable", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page, {
    ignoredApiUrls: [/\/api\/journey/]
  });
  await mockPortalApis(page, { journey: { status: 503 } });
  await page.goto("/#/home");
  await expect(page.locator("main.portal-workspace")).toBeVisible();

  const accountProfile = page.locator(".portal-account-profile");
  await expect(accountProfile.locator("small")).toHaveCount(0);
  await expect(accountProfile.getByText("AI Adoption", { exact: true })).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});
