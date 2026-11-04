import { expect, test } from "@playwright/test";
import { fallbackPortal } from "../../src/shared/fallbackPortal";
import type { PublicationListing, PortalCatalog } from "../../src/shared/types";
import { mockPortalApis } from "./fixtures/portalApi";

const baseAppListing = fallbackPortal.publicationListings.find((listing) => listing.type === "app")!;

function appListing(index: number, status: PublicationListing["status"] = "pending_review"): PublicationListing {
  return {
    ...baseAppListing,
    config: { productionUrl: `https://pending-${index}.example.test` },
    id: `listing-pending-${index}`,
    name: `待发布应用 ${index}`,
    status,
    summary: `第 ${index} 个待发布应用入口`,
    targetId: `pending-app-${index}`,
    updatedAt: `2026-07-${String(index).padStart(2, "0")}`
  };
}

function homeCatalog(listings: PublicationListing[]): PortalCatalog {
  const catalog = structuredClone(fallbackPortal);
  catalog.apps = [];
  catalog.hubListings = listings;
  catalog.publicationListings = listings;
  catalog.portal = {
    ...catalog.portal
  };
  return catalog;
}

async function prepareHome(page: Parameters<typeof mockPortalApis>[0], catalog: PortalCatalog, pins: string[], locale: "zh-CN" | "en" = "zh-CN") {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.addInitScript(({ targetIds, locale }) => {
    window.localStorage.setItem("workspace-ai:locale", locale);
    window.localStorage.setItem(
      "workspace.homePins.v1",
      JSON.stringify(targetIds.map((id) => ({ id, kind: "app" })))
    );
  }, { targetIds: pins, locale });
  await mockPortalApis(page, {
    apps: catalog.apps,
    catalog: { json: catalog },
    hubListings: catalog.hubListings,
    publicationListings: catalog.publicationListings
  });
  await page.goto("/home");
}

test("shows all accessible Apps as fixed cards in a draggable single-row rail", async ({ page }) => {
  const listings = Array.from({ length: 8 }, (_, index) => appListing(index + 1));
  listings[0] = { ...listings[0], name: "短标题" };
  listings[1] = { ...listings[1], name: "这是一个需要占据两行空间的待发布应用标题" };
  const catalog = homeCatalog(listings);
  let launchRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/auth/direct-jump")) {
      launchRequests += 1;
    }
  });

  await prepareHome(page, catalog, []);

  await expect(page.getByRole("heading", { level: 2, name: "公共应用" })).toBeVisible();
  const rail = page.getByRole("region", { name: "公共应用" });
  const cards = rail.locator(".portal-quick-item");
  await expect(cards).toHaveCount(8);

  const geometry = await cards.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { height: rect.height, top: rect.top, width: rect.width };
  }));
  expect(geometry.every(({ height, width }) => height === 160 && width === 160)).toBe(true);
  expect(geometry.every(({ top }) => Math.abs(top - geometry[0].top) < 1)).toBe(true);
  expect(await rail.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

  await expect(cards.locator(".portal-quick-description")).toHaveCount(0);
  await expect(cards.locator("small")).toHaveCount(0);
  const firstCardLayout = await cards.first().evaluate((element) => {
    const mark = element.querySelector(".portal-object-mark")!.getBoundingClientRect();
    const title = element.querySelector(".portal-quick-copy")!.getBoundingClientRect();
    return { markHeight: mark.height, markWidth: mark.width, titleHeight: title.height };
  });
  expect(firstCardLayout).toEqual({ markHeight: 158, markWidth: 158, titleHeight: 44 });
  const title = cards.first().locator(".portal-quick-copy");
  await expect(title).toHaveCSS("opacity", "0");
  await cards.first().hover();
  await expect(title).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  await expect(title).toHaveCSS("opacity", "0");
  await cards.first().getByRole("button").focus();
  await expect(title).toHaveCSS("opacity", "1");
  await cards.first().getByRole("button").blur();

  const box = await rail.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width - 40, box!.y + 80);
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + 80, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => rail.evaluate((element) => element.scrollLeft)).toBeGreaterThan(100);
  expect(launchRequests).toBe(0);
});

test("shows every accessible App without configured default IDs", async ({ page }) => {
  const workbuddy = {
    ...appListing(1, "listed"),
    config: { reviewDraft: { launchUrl: "https://workbuddy.example.test" } },
    id: "listing-workbuddy",
    name: "WorkBuddy 申请",
    targetId: "workbuddy-request"
  } satisfies PublicationListing;
  const academy = {
    ...appListing(2, "listed"),
    config: { productionUrl: "https://academy.example.test" },
    coverImageUrl: "/covers/workspace-academy.png",
    id: "listing-academy",
    name: "Workspace Academy",
    targetId: "app_83c1296c08eb"
  } satisfies PublicationListing;
  const custom = appListing(3, "listed");
  const catalog = homeCatalog([workbuddy, academy, custom]);

  await prepareHome(page, catalog, []);

  let legacyDirectJumpRequests = 0;
  await page.route("**/api/auth/direct-jump", async (route) => {
    legacyDirectJumpRequests += 1;
    await route.abort();
  });
  await page.context().route("https://workbuddy.example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><title>WorkBuddy</title>"
  }));

  await expect(page.getByRole("heading", { level: 2, name: "公共应用" })).toBeVisible();
  const workbuddyCard = page.getByRole("button", { exact: true, name: "WorkBuddy 申请" });
  await expect(workbuddyCard).toBeVisible();
  await expect(page.locator(".portal-quick-item")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "从首页隐藏" })).toHaveCount(0);

  const popupPromise = page.waitForEvent("popup");
  await workbuddyCard.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL("https://workbuddy.example.test/");
  expect(legacyDirectJumpRequests).toBe(0);
});

test("keeps a removed accessible App hidden for the current user", async ({ page }) => {
  const academy = {
    ...appListing(1, "listed"),
    config: { productionUrl: "https://academy.example.test" },
    coverImageUrl: "/covers/workspace-academy.png",
    id: "listing-academy",
    name: "Workspace Academy",
    targetId: "app_83c1296c08eb"
  } satisfies PublicationListing;
  const custom = appListing(2, "listed");
  const catalog = homeCatalog([academy, custom]);

  await prepareHome(page, catalog, []);

  await expect(page.getByText("管理公共应用", { exact: true })).toHaveCount(0);
  const card = page.locator(".portal-quick-item").filter({ hasText: "Workspace Academy" });
  await expect(card).toBeVisible();
  await expect(card.locator("img")).toHaveAttribute("src", academy.coverImageUrl);
  await expect(card.getByRole("button", { name: "从首页隐藏" })).toHaveCount(0);

  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await expect(page.locator(".portal-quick-grid")).toHaveClass(/editing/);
  await expect(page.getByRole("button", { name: "从首页隐藏" })).toHaveCount(2);
  await page.mouse.up();

  const rail = page.locator(".portal-quick-grid");
  await rail.click({ position: { x: 500, y: 68 } });
  await expect(rail).not.toHaveClass(/editing/);
  await expect(page.getByRole("button", { name: "从首页隐藏" })).toHaveCount(0);

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "从首页隐藏" })).toHaveCount(2);

  await card.getByRole("button", { name: "从首页隐藏" }).click();
  await expect(page.getByText("Workspace Academy", { exact: true })).toHaveCount(0);
  await expect(page.getByText(custom.name, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Workspace Academy", { exact: true })).toHaveCount(0);
  await expect(page.getByText(custom.name, { exact: true })).toBeVisible();

  const dismissed = await page.evaluate((userId) => (
    window.localStorage.getItem(`workspace.homePinDismissals.v1:${userId}`)
  ), catalog.currentUser.id);
  expect(JSON.parse(dismissed || "[]")).toEqual([{ id: academy.targetId, kind: "app" }]);
});

test("hides the application entries section when no accessible Apps exist", async ({ page }) => {
  const catalog = homeCatalog([]);

  await prepareHome(page, catalog, []);

  await expect(page.getByRole("heading", { level: 2, name: "公共应用" })).toHaveCount(0);
  await expect(page.locator(".portal-quick-access")).toHaveCount(0);
});

test("separates public and exclusive apps and expands hidden apps without global Home controls", async ({ page }) => {
  const listings: PublicationListing[] = [
    { ...appListing(1, "listed"), homeDisplay: "recommended", name: "Team Calendar" },
    { ...appListing(2, "listed"), homeDisplay: "recommended", name: "Frontier Workspace Cookbook" },
    { ...appListing(3, "listed"), homeDisplay: "recommended", name: "Workspace Academy" },
    { ...appListing(4, "listed"), name: "普通应用" },
    { ...appListing(5, "listed"), name: "隐藏应用", homeDisplay: "hidden" },
    { ...appListing(6, "listed"), name: "私人应用", visibility: "private" },
    { ...appListing(7, "listed"), name: "定向应用", homeScope: "exclusive" }
  ];
  const catalog = homeCatalog(listings);
  await prepareHome(page, catalog, []);
  const publicRail = page.getByRole("region", { name: "公共应用", exact: true });
  const exclusiveRail = page.getByRole("region", { name: "我的专属应用", exact: true });
  await expect(publicRail.locator(".portal-quick-copy strong")).toHaveText(["Workspace Academy", "Frontier Workspace Cookbook", "Team Calendar", "普通应用"]);
  await expect(exclusiveRail.locator(".portal-quick-copy strong")).toHaveText(["定向应用", "私人应用"]);
  await expect(page.getByRole("button", { name: "隐藏应用", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "显示隐藏应用（1）" }).click();
  await expect(page.getByRole("region", { name: "隐藏的公共应用" }).getByRole("button", { name: "隐藏应用", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "收起隐藏应用" }).click();

  await expect(page.getByRole("button", { name: "管理公共应用", exact: true })).toHaveCount(0);
  await page.locator(".portal-home-applications").screenshot({ path: "output/playwright/home-application-groups.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileGroups = await page.locator(".portal-home-applications").boundingBox();
  expect(mobileGroups!.width).toBeLessThanOrEqual(390);
  expect(mobileGroups!.x + mobileGroups!.width).toBeLessThanOrEqual(390);
  const mobileMark = await publicRail.locator(".portal-object-mark").first().boundingBox();
  expect(mobileMark!.height).toBe(mobileMark!.width);
  await page.locator(".portal-home-applications").screenshot({ animations: "disabled", path: "output/playwright/home-application-groups-mobile.png" });
  await page.reload();
  await expect(page.getByRole("button", { name: "显示隐藏应用（1）" })).toBeVisible();
  await expect(page.getByRole("region", { name: "公共应用", exact: true }).getByRole("button", { name: "Team Calendar", exact: true })).toBeVisible();
});

test("allows members to restore personally hidden public apps while keeping admin controls unavailable", async ({ page }) => {
  const catalog = homeCatalog([{ ...appListing(1, "listed"), homeDisplay: "recommended", name: "Team Calendar" }]);
  catalog.currentUser.role = "member";
  await page.addInitScript((userId) => {
    if (window.localStorage.getItem(`workspace.homePinDismissals.v1:${userId}`) === null) {
      window.localStorage.setItem(`workspace.homePinDismissals.v1:${userId}`, JSON.stringify([{ id: "pending-app-1", kind: "app" }]));
    }
  }, catalog.currentUser.id);
  await prepareHome(page, catalog, []);
  await expect(page.getByRole("button", { name: "管理公共应用" })).toHaveCount(0);
  await page.getByRole("button", { name: "显示隐藏应用（1）" }).click();
  await page.getByRole("button", { name: "恢复 Team Calendar" }).click();
  await expect(page.getByRole("region", { name: "公共应用", exact: true }).getByRole("button", { name: "Team Calendar", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "公共应用", exact: true }).getByRole("button", { name: "Team Calendar", exact: true })).toBeVisible();
});

for (const labels of [
  { locale: "zh-CN", publicTitle: "公共应用", exclusiveTitle: "我的专属应用", hint: "私有和定向应用" },
  { locale: "en", publicTitle: "Public Apps", exclusiveTitle: "My Exclusive Apps", hint: "Private & Targeted Apps" }
] as const) {
  test(`uses consistent application section names in ${labels.locale}`, async ({ page }) => {
    const catalog = homeCatalog([
      { ...appListing(1, "listed"), homeDisplay: "recommended", name: "Team Calendar" },
      { ...appListing(2, "listed"), visibility: "private" }
    ]);
    await prepareHome(page, catalog, [], labels.locale);
    await expect(page.getByRole("heading", { name: labels.publicTitle, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: labels.exclusiveTitle, exact: true })).toBeVisible();
    await expect(page.getByText(labels.hint, { exact: true })).toBeVisible();
  });
}
