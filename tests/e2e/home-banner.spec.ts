import { expect, test, type Locator } from "@playwright/test";
import { fallbackPortal } from "../../src/shared/fallbackPortal";
import { mockPortalApis } from "./fixtures/portalApi";

const avatarUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' fill='%23b7f43a'/%3E%3C/svg%3E";

async function readHeroLayout(hero: Locator) {
  return hero.evaluate((element) => {
    const copy = element.querySelector<HTMLElement>(".portal-hero-copy")!;
    const panel = element.querySelector<HTMLElement>(".portal-hero-panel")!;
    const title = copy.querySelector<HTMLElement>("h1")!;
    const copyRect = copy.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    return {
      copyWidth: copyRect.width,
      heroOverflows: element.scrollWidth > element.clientWidth + 1,
      layout: panelRect.top >= copyRect.bottom - 1 ? "stacked" : "side-by-side",
      metricOverflows: copy.querySelector<HTMLElement>(".portal-group-usage-metric")!.scrollWidth > copy.clientWidth + 1,
      titleOverflows: title.scrollWidth > title.clientWidth + 1
    };
  });
}

test("shows connected users the universal pass panel and opens localized journey token levels", async ({ page }) => {
  const explorer = fallbackPortal.journey.levels.find((level) => level.key === "explorer");
  const mcpConnected = fallbackPortal.journey.badgeDefinitions.find((badge) => badge.key === "mcp_connected");
  expect(explorer).toBeDefined();
  expect(mcpConnected).toBeDefined();

  const catalog = structuredClone(fallbackPortal);
  catalog.currentUser = {
    ...catalog.currentUser,
    avatarUrl,
    id: "banner-user",
    name: "Mina Zhang"
  };
  catalog.journey = {
    ...catalog.journey,
    level: explorer!,
    badges: [
      ...catalog.journey.badges,
      {
        awardedAt: "2026-08-18T08:00:00.000Z",
        badgeKey: mcpConnected!.key,
        category: mcpConnected!.category,
        descriptionEn: mcpConnected!.descriptionEn,
        descriptionZh: mcpConnected!.descriptionZh,
        nameEn: mcpConnected!.nameEn,
        nameZh: mcpConnected!.nameZh,
        points: mcpConnected!.points,
        source: "e2e"
      }
    ]
  };

  await page.addInitScript(() => {
    if (!window.localStorage.getItem("workspace-ai:locale")) {
      window.localStorage.setItem("workspace-ai:locale", "en");
    }
  });
  await mockPortalApis(page, {
    catalog: { json: catalog },
    journey: { json: { journey: catalog.journey } }
  });
  await page.goto("/#/home");

  const hero = page.locator(".portal-hero-mast");
  const user = hero.locator(".portal-hero-current-user");
  const benefit = hero.locator(".portal-level-token-benefit");
  const passPanel = hero.getByLabel("Connect your AI assistant");

  await expect(hero.getByRole("heading", { level: 1, name: "48,200,122 TOKEN" })).toBeVisible();
  await expect(hero.locator(".portal-group-usage-number")).toHaveText("48,200,122");
  await expect(hero.locator(".portal-group-usage-meta")).toHaveText("Since Jul 13 · 12,204 Requests");
  await expect(user.locator("img")).toHaveAttribute("src", avatarUrl);
  await expect(user.locator(".portal-hero-user-level")).toHaveText("Mina Zhang/ Level 2 · Explorer");
  await expect(user.locator(".portal-hero-level-caption")).toHaveText("Current level｜$30 USD / MONTH");
  await expect(user.locator(".portal-hero-next-level")).toHaveText("Next levelLevel 3 · Contributor");
  await expect(benefit.locator(":scope > strong")).toHaveText("$50");
  await expect(benefit.locator(":scope > span")).toHaveText("USD / Next Level");
  await expect(passPanel.getByRole("heading", { name: "Get your AI assistant a Workspace MCP" })).toBeVisible();
  await expect(hero.locator(".portal-playground-step")).toHaveCount(0);
  await expect(hero.getByRole("heading", { name: "Four ways to join the Playground" })).toHaveCount(0);

  await benefit.getByRole("button", { name: "How to" }).click();
  const profile = page.getByRole("dialog", { name: "Mina Zhang profile" });
  await expect(profile).toBeVisible();
  await expect(profile.getByRole("tab", { name: "Tasks & Badges" })).toHaveClass(/active/);
  expect(await profile.locator(".journeyLevelTokenBudget").allTextContents()).toEqual([
    "$10 USD Token / month",
    "$30 USD Token / month",
    "$50 USD Token / month",
    "$100 USD Token / month",
    "$200 USD Token / month"
  ]);
  await profile.getByRole("button", { exact: true, name: "Close" }).click();

  await page.evaluate(() => window.localStorage.setItem("workspace-ai:locale", "zh-CN"));
  await page.reload();

  await expect(hero.getByRole("heading", { level: 1, name: "48,200,122 TOKEN" })).toBeVisible();
  await expect(hero.locator(".portal-group-usage-number")).toHaveText("48,200,122");
  await expect(hero.locator(".portal-group-usage-meta")).toHaveText("自 7月13日起 · 12,204 次 Request");
  await expect(user.locator(".portal-hero-user-level")).toHaveText("Mina Zhang/ Level 2 · 探索者");
  await expect(user.locator(".portal-hero-level-caption")).toHaveText("当前等级｜$30 USD / 月");
  await expect(user.locator(".portal-hero-next-level")).toHaveText("下一等级Level 3 · 贡献者");
  await expect(benefit.locator(":scope > strong")).toHaveText("$50");
  await expect(benefit.locator(":scope > span")).toHaveText("USD / 下一等级");
  const zhPassPanel = hero.getByLabel("连接你的 AI 助手");
  await expect(zhPassPanel.getByRole("heading", { name: "为你的 AI 助手领取 Workspace MCP" })).toBeVisible();
  await expect(hero.getByRole("heading", { level: 2, name: "加入 Playground 四件事" })).toHaveCount(0);

  await benefit.getByRole("button", { name: "如何升级" }).click();
  const zhProfile = page.getByRole("dialog", { name: "Mina Zhang 个人资料" });
  await expect(zhProfile.getByRole("tab", { name: "任务与徽章" })).toHaveClass(/active/);
  expect(await zhProfile.locator(".journeyLevelTokenBudget").allTextContents()).toEqual([
    "$10 USD Token / 月",
    "$30 USD Token / 月",
    "$50 USD Token / 月",
    "$100 USD Token / 月",
    "$200 USD Token / 月"
  ]);
  await zhProfile.getByRole("button", { exact: true, name: "关闭" }).click();

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(hero).toBeVisible();
  expect(await hero.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

  const mobileHeader = page.locator(".portal-mobile-header");
  await expect(mobileHeader).toBeVisible();
  await expect(mobileHeader.getByRole("button", { name: "发布" })).toHaveCount(0);

  await mobileHeader.getByRole("button", { name: "打开导航菜单" }).click();
  const navigationNewPost = page.locator(".portal-left-rail").getByRole("button", { name: "发布新帖" });
  await expect(navigationNewPost).toBeVisible();
  await navigationNewPost.click();
  await expect(page.getByRole("dialog", { name: "新帖子" })).toBeVisible();
});

test("hydrates Me from local cache and swaps one aggregated refresh without a blank level", async ({ page }) => {
  const catalog = structuredClone(fallbackPortal);
  const newcomer = catalog.journey.levels.find((level) => level.key === "newcomer")!;
  const builder = catalog.journey.levels.find((level) => level.key === "builder")!;
  const master = catalog.journey.levels.find((level) => level.key === "master")!;
  catalog.currentUser = {
    ...catalog.currentUser,
    id: "cached-me-user",
    name: "Mina Zhang",
    status: {
      journeyLevelKey: "newcomer",
      mcpConnected: false,
      tokenApplied: false,
      updatedAt: "2026-08-20T08:00:00.000Z"
    }
  };
  catalog.journey = { ...catalog.journey, level: newcomer };
  const refreshedJourney = { ...catalog.journey, level: master, updatedAt: "2026-08-20T10:00:00.000Z" };

  await page.addInitScript(({ builderLevel }) => {
    window.localStorage.setItem("workspace-ai:locale", "en");
    window.localStorage.setItem("workspace-ai:current-user-summary:v1:cached-me-user", JSON.stringify({
      cachedAt: Date.parse("2026-08-20T09:30:01.000Z"),
      summary: {
        journeyLevelKey: builderLevel,
        mcpConnected: true,
        tokenApplied: true,
        updatedAt: "2026-08-20T09:30:00.000Z"
      },
      userId: "cached-me-user"
    }));
  }, { builderLevel: builder.key });
  await mockPortalApis(page, { catalog: { json: catalog } });

  let meRequests = 0;
  let mcpRequests = 0;
  let releaseMe = () => {};
  page.on("request", (request) => {
    if (request.url().includes("/api/mcp/connections/status")) {
      mcpRequests += 1;
    }
  });
  await page.route("**/api/me", async (route) => {
    meRequests += 1;
    await new Promise<void>((resolve) => {
      releaseMe = resolve;
    });
    await route.fulfill({
      contentType: "application/json",
      json: {
        journey: refreshedJourney,
        me: {
          ...catalog.currentUser,
          status: {
            journeyLevelKey: "master",
            mcpConnected: true,
            tokenApplied: true,
            updatedAt: refreshedJourney.updatedAt
          }
        }
      }
    });
  });

  await page.goto("/#/home");
  const hero = page.locator(".portal-hero-mast");
  const userLevel = hero.locator(".portal-hero-user-level");
  await expect(userLevel).toHaveText("Mina Zhang/ Level 4 · Builder");
  await expect(hero.locator(".portal-hero-level-caption")).toHaveText("Current level｜$100 USD / MONTH");
  await expect.poll(() => meRequests).toBe(1);
  await expect(userLevel).toHaveText("Mina Zhang/ Level 4 · Builder");
  expect(mcpRequests).toBe(0);

  releaseMe();
  await expect(userLevel).toHaveText("Mina Zhang/ Level 5 · Master");
  await expect(hero.locator(".portal-hero-level-caption")).toHaveText("Current level｜$200 USD / MONTH");
  await expect(hero.locator(".portal-hero-achievement")).toBeVisible();
});

test("lazy-loads the sharp-corner Workspace MCP flow with interactive scenes", async ({ page }) => {
  const catalog = structuredClone(fallbackPortal);
  const master = catalog.journey.levels.find((level) => level.key === "master");
  expect(master).toBeDefined();
  catalog.journey = { ...catalog.journey, level: master! };

  await page.setViewportSize({ height: 900, width: 1440 });
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
  await mockPortalApis(page, {
    catalog: { json: catalog },
    journey: { json: { journey: catalog.journey } }
  });
  await page.goto("/#/home");

  const hero = page.locator(".portal-hero-mast");
  const passPanel = hero.getByLabel("Connect your AI assistant");
  await expect(passPanel.getByRole("heading", { name: "Get your AI assistant a Workspace MCP" })).toBeVisible();
  await expect(passPanel).toHaveCSS("border-radius", "0px");
  await expect(hero.locator(".portal-hero-level-caption")).toHaveText("Current level｜$200 USD / MONTH");
  await expect(hero.locator(".portal-level-token-benefit")).toHaveText("$200USD / Max LevelHow to →");
  await expect(passPanel.getByText("Connect in about 30 seconds", { exact: false })).toHaveCount(0);
  await expect(page.getByLabel("Three interactive work examples")).toHaveCount(0);
  expect(await page.evaluate(() => performance.getEntriesByType("resource").some(
    (entry) => entry.name.includes("PassLearningModal-")
  ))).toBe(false);

  await passPanel.getByRole("button", { name: "See what a pass unlocks" }).click();
  const onboarding = page.getByRole("dialog", { name: "WORKSPACE PASS / COMMON SCENARIOS" });
  await expect(onboarding).toBeVisible();
  await expect(onboarding).toHaveJSProperty("open", true);
  expect(await onboarding.evaluate((element) => element.matches(":modal"))).toBe(true);
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await expect(onboarding.getByRole("button", { name: "Start learning" })).toBeVisible();
  await onboarding.getByRole("button", { name: "Start learning" }).click();
  await expect(onboarding.getByRole("checkbox", { name: "Backend service (Worker)", exact: true })).toBeChecked();
  await expect(onboarding.getByRole("checkbox", { name: "File storage (R2)", exact: true })).toBeChecked();
  await expect(onboarding.getByRole("checkbox", { name: "Frontend service (Pages)", exact: true })).toBeDisabled();
  await onboarding.getByRole("checkbox", { name: "Backend service (Worker)", exact: true }).uncheck();
  await expect(onboarding.getByRole("checkbox", { name: "Frontend service (Pages)", exact: true })).toBeEnabled();
  await onboarding.getByRole("checkbox", { name: "Frontend service (Pages)", exact: true }).check();
  await expect(onboarding.getByRole("checkbox", { name: "Backend service (Worker)", exact: true })).toBeDisabled();
  await onboarding.getByRole("radio", { name: "Agent app", exact: true }).check();
  await expect(onboarding.getByRole("radio", { name: "Agent app", exact: true })).toBeChecked();
  await onboarding.getByRole("checkbox", { name: "Investment operations", exact: true }).check();
  await expect(onboarding.getByText("3 selected", { exact: true })).toBeVisible();
  await onboarding.getByRole("button", { name: "Open Create App", exact: true }).click();
  await expect(onboarding.getByText("portfolio-analysis-app.handoff", { exact: true })).toBeVisible();

  const tabs = onboarding.getByRole("navigation", { name: "Learning scenarios" });
  await tabs.getByRole("button", { name: "Knowledge", exact: true }).click();
  await onboarding.getByRole("button", { name: "Start learning" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(onboarding.getByRole("heading", { name: "Create a folder" })).toBeVisible();
  await onboarding.getByRole("button", { name: "Next", exact: true }).click();
  await expect(onboarding.getByRole("heading", { name: "Publish a knowledge service" })).toBeVisible();
  await expect(onboarding.getByRole("navigation", { name: "Learning steps" }).getByRole("button")).toHaveCount(4);
  await tabs.getByRole("button", { name: "Build an App", exact: true }).click();
  await expect(onboarding.getByText("portfolio-analysis-app.handoff", { exact: true })).toBeVisible();
  await onboarding.getByRole("button", { name: "Preview inside Agent" }).click();
  await expect(onboarding.getByText("$24.8M", { exact: true })).toBeVisible();
  await onboarding.getByRole("button", { name: /Please publish this App/ }).click();
  await expect(onboarding.getByRole("button", { name: "App published" })).toBeVisible();
  await onboarding.getByRole("button", { name: "Finish learning", exact: true }).click();
  await expect(onboarding.getByRole("heading", { name: "Scenario completed" })).toBeVisible();

  await tabs.getByRole("button", { name: "Skill", exact: true }).click();
  await onboarding.getByRole("button", { name: "Start learning" }).click();
  await expect(onboarding.getByRole("link", { name: "Download Skill" })).toHaveAttribute("download", "portfolio-holdings-reconciliation.skill.md");
  await onboarding.getByRole("button", { name: "Continue to find in Agent" }).click();
  await onboarding.getByRole("button", { name: "Install in Agent", exact: true }).click();
  await onboarding.getByRole("button", { name: "Use this Skill" }).click();
  await expect(onboarding.getByRole("button", { name: "Skill ran" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await onboarding.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(onboarding.getByRole("button", { name: "Finish learning" })).toBeInViewport();
  await tabs.getByRole("button", { name: /Mate/ }).click();
  await expect(onboarding.getByRole("heading", { name: "An enterprise Agent that works 24/7" })).toBeVisible();
  await onboarding.getByRole("button", { name: "Accept task" }).click();
  await expect(onboarding.getByRole("heading", { name: "Create a Mate" })).toBeVisible();
  await expect(onboarding.getByText("ur.botname@example.invalid", { exact: true })).toBeVisible();
  await expect(onboarding.getByRole("navigation", { name: "Learning steps" }).getByRole("button")).toHaveCount(4);
  await onboarding.getByRole("button", { name: "STEP 4 Assign work from any channel" }).click();
  await expect(onboarding.getByText("Agent Call", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await onboarding.getByRole("button", { name: "Close learning guide" }).click();
  await expect(onboarding).toHaveCount(0);
  await expect(passPanel.getByRole("button", { name: "See what a pass unlocks" })).toBeFocused();
  expect(await page.locator("body").evaluate((element) => element.style.overflow)).toBe("");
  await passPanel.getByRole("button", { name: "See what a pass unlocks" }).click();
  await onboarding.getByRole("button", { name: "Connect my AI assistant" }).click();
  const connection = page.getByRole("dialog", { name: "Workspace MCP onboarding" });
  await expect(connection.getByRole("heading", { name: "Do you already use an AI tool?" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(connection).toHaveCount(0);
});

test("switches the hero from its own available width without clipping the copy", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
  await mockPortalApis(page);
  await page.goto("/#/home");

  const hero = page.locator(".portal-hero-mast");
  const shell = page.locator(".portal-shell");

  await page.getByRole("button", { name: "Open Live" }).click();
  await expect(shell).not.toHaveClass(/live-collapsed/);
  await expect.poll(async () => (await readHeroLayout(hero)).layout).toBe("stacked");
  expect((await readHeroLayout(hero)).heroOverflows).toBe(false);
  expect((await readHeroLayout(hero)).metricOverflows).toBe(false);
  expect((await readHeroLayout(hero)).titleOverflows).toBe(false);

  await page.setViewportSize({ height: 900, width: 1200 });
  await expect(shell).toHaveClass(/live-collapsed/);
  await expect.poll(async () => (await readHeroLayout(hero)).layout).toBe("side-by-side");
  const expandedLayout = await readHeroLayout(hero);
  expect(expandedLayout.copyWidth).toBeGreaterThanOrEqual(420);
  expect(expandedLayout.heroOverflows).toBe(false);
  expect(expandedLayout.metricOverflows).toBe(false);
  expect(expandedLayout.titleOverflows).toBe(false);

  await page.setViewportSize({ height: 900, width: 1080 });
  await expect.poll(async () => (await readHeroLayout(hero)).layout).toBe("side-by-side");
  const minimumTwoColumnLayout = await readHeroLayout(hero);
  expect(minimumTwoColumnLayout.copyWidth).toBeGreaterThanOrEqual(419.5);
  expect(minimumTwoColumnLayout.heroOverflows).toBe(false);
  expect(minimumTwoColumnLayout.metricOverflows).toBe(false);
  expect(minimumTwoColumnLayout.titleOverflows).toBe(false);

  await page.setViewportSize({ height: 900, width: 1040 });
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
  await expect.poll(async () => (await readHeroLayout(hero)).layout).toBe("stacked");
  expect((await readHeroLayout(hero)).heroOverflows).toBe(false);

  await page.setViewportSize({ height: 900, width: 1280 });
  await expect(shell).not.toHaveClass(/live-collapsed/);
  await expect.poll(async () => (await readHeroLayout(hero)).layout).toBe("stacked");
  expect((await readHeroLayout(hero)).heroOverflows).toBe(false);
  expect((await readHeroLayout(hero)).titleOverflows).toBe(false);
});

test("starts with the right Live rail collapsed after load and reload", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
  await mockPortalApis(page);
  await page.goto("/#/home");

  const shell = page.locator(".portal-shell");
  await expect(shell).toHaveClass(/live-collapsed/);
  await expect(page.getByRole("button", { name: "Open Live" })).toBeVisible();

  await page.getByRole("button", { name: "Open Live" }).click();
  await expect(shell).not.toHaveClass(/live-collapsed/);

  await page.reload();
  await expect(shell).toHaveClass(/live-collapsed/);
  await expect(page.getByRole("button", { name: "Open Live" })).toBeVisible();
});

test("keeps the saved group usage visible while refreshing it after reload", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
  await mockPortalApis(page);

  let requestCount = 0;
  let releaseRefresh = () => {};
  await page.route("**/api/llm-gateway/group-usage", async (route) => {
    requestCount += 1;
    if (requestCount > 1) {
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
    }
    await route.fulfill({
      contentType: "application/json",
      json: requestCount === 1
        ? {
            requestCount: 12_204,
            startDate: "2026-07-13",
            totalTokens: 48_200_122,
            updatedAt: "2026-08-17T04:00:00.000Z"
          }
        : {
            requestCount: 12_205,
            startDate: "2026-07-13",
            totalTokens: 48_201_000,
            updatedAt: "2026-08-17T04:05:00.000Z"
          }
    });
  });

  await page.goto("/#/home");
  const hero = page.locator(".portal-hero-mast");
  await expect(hero.locator(".portal-group-usage-number")).toHaveText("48,200,122");

  await page.evaluate(() => {
    const key = "workspace-ai:group-usage:v1";
    const snapshot = JSON.parse(window.sessionStorage.getItem(key)!);
    snapshot.cachedAt = Date.now() - 5 * 60 * 1000;
    window.sessionStorage.setItem(key, JSON.stringify(snapshot));
  });
  await page.reload();
  await expect.poll(() => requestCount).toBe(2);
  await expect(hero.locator(".portal-group-usage-number")).toHaveText("48,200,122");
  await expect(hero.locator(".portal-group-usage-meta")).toHaveText("Since Jul 13 · 12,204 Requests");
  await expect(hero.getByText("Syncing Group usage…", { exact: true })).toHaveCount(0);

  releaseRefresh();
  await expect(hero.locator(".portal-group-usage-number")).toHaveText("48,201,000");
  await expect(hero.locator(".portal-group-usage-meta")).toHaveText("Since Jul 13 · 12,205 Requests");
});
