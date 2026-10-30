import { expect, test } from "@playwright/test";
import { fallbackPortal } from "../../src/shared/fallbackPortal";
import { mockPortalApis } from "./fixtures/portalApi";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "zh-CN"));
  await mockPortalApis(page, { catalog: { json: fallbackPortal } });
  await page.goto("/#/home");
});

test("opens and copies current browser diagnostics after three consecutive logo clicks", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:5174" });
  const logo = page.locator(".portal-left-rail .portal-brand-mark");

  await logo.click({ clickCount: 3, delay: 80 });

  const dialog = page.getByRole("dialog", { name: "浏览器诊断信息" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("系统与浏览器", { exact: true })).toBeVisible();
  await expect(dialog.getByText("屏幕与显示", { exact: true })).toBeVisible();
  await expect(dialog.getByText("运行环境", { exact: true })).toBeVisible();
  await expect(dialog.locator("dt", { hasText: "User-Agent" })).toBeVisible();
  await expect(dialog.locator("dt", { hasText: "设备像素比" })).toBeVisible();
  await expect(dialog.locator("dt", { hasText: "时区" })).toBeVisible();
  const copyButton = dialog.getByRole("button", { name: "复制诊断信息" });
  await expect(copyButton).toBeEnabled();
  await copyButton.click();
  await expect(dialog.getByRole("button", { name: "已复制" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("[系统与浏览器]");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
