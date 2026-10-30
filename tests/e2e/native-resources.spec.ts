import { expect, test } from "@playwright/test";
import { mockPortalApis } from "../e2e/fixtures/portalApi";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.localStorage.getItem("workspace-ai:locale")) {
      window.localStorage.setItem("workspace-ai:locale", "en");
    }
  });
  await mockPortalApis(page);
});

test("never substitutes demo content when the production catalog fails", async ({ page }) => {
  await page.route("**/api/catalog", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { error: "catalog_unavailable" }, status: 503 });
  });

  await page.goto("/#/home");

  await expect(page.getByRole("heading", { level: 1, name: "The workspace is temporarily unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByText("Workspace Onboarding", { exact: true })).toHaveCount(0);
  await expect(page.locator(".portal-shell")).toHaveCount(0);
  await captureReviewScreenshot(page, "portal-data-error-desktop.png");
});

test("brands the MCP handbook navigation with the standard MCP mark", async ({ page }, testInfo) => {
  await page.route("**/api/mcp/handbook", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        capabilityPacks: [
          { count: 3, description: "Discover Forum discussions.", descriptionZh: "发现 Forum 讨论。", group: "forum", id: "forum-discover", title: "Discover", titleZh: "发现", toolNames: [] },
          { count: 5, description: "Participate in Forum discussions.", descriptionZh: "参与 Forum 讨论。", group: "forum", id: "forum-participate", title: "Participate", titleZh: "参与", toolNames: [] },
          { count: 1, description: "Manage Forum topics.", descriptionZh: "维护 Forum 主题。", group: "forum", id: "forum-manage", title: "Manage", titleZh: "维护", toolNames: [] },
          { count: 3, description: "Discover Hub assets.", descriptionZh: "发现 Hub 资产。", group: "hub", id: "hub-discover", title: "Discover and consume", titleZh: "发现与使用", toolNames: [] },
          { count: 1, description: "Publish Hub assets.", descriptionZh: "发布 Hub 资产。", group: "hub", id: "hub-publish", title: "Publish", titleZh: "发布", toolNames: [] },
          { count: 10, description: "Consume Knowledge services.", descriptionZh: "使用知识服务。", group: "knowledge", id: "knowledge-consumer", title: "Consumer", titleZh: "知识消费者", toolNames: [] },
          { count: 18, description: "Author Knowledge content.", descriptionZh: "创作知识内容。", group: "knowledge", id: "knowledge-author", title: "Author", titleZh: "知识作者", toolNames: [] },
          { count: 6, description: "Start a APPS workflow.", descriptionZh: "启动 APPS 工作流。", group: "apps", id: "apps-entry", title: "Entry", titleZh: "入口", toolNames: [] },
          { count: 5, description: "Define and provision an App.", descriptionZh: "定义 App 并初始化资源。", group: "apps", id: "apps-app-definition", title: "App definition and provisioning", titleZh: "App 定义与资源初始化", toolNames: [] },
          { count: 16, description: "Manage App resources.", descriptionZh: "管理 App 资源。", group: "apps", id: "apps-app-resources", title: "App resources", titleZh: "App 资源", toolNames: [] },
          { count: 6, description: "Deploy and release an App.", descriptionZh: "部署并发布 App。", group: "apps", id: "apps-deploy-release", title: "Deploy and release", titleZh: "部署与发布", toolNames: [] },
          { count: 2, description: "Maintain a Skill.", descriptionZh: "维护 Skill。", group: "apps", id: "apps-skill-maintenance", title: "Skill maintenance", titleZh: "Skill 维护", toolNames: [] }
        ],
        catalogRevision: "0.6.2+20260812",
        generatedAt: "2026-08-12T00:00:00.000Z",
        groups: [
          { count: 9, id: "forum" },
          { count: 4, id: "hub" },
          { count: 28, id: "knowledge" },
          { count: 35, id: "apps" }
        ],
        latestFeatures: [],
        releases: [],
        server: { name: "workspace-ai", protocol: "Model Context Protocol", protocolVersion: "2025-06-18", releasedAt: "2026-08-12", version: "0.6.2" },
        summary: { approvalTools: 5, readTools: 40, toolCount: 76, writeTools: 31 },
        tools: []
      }
    });
  });
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/#/home");

  const navItem = page.getByRole("button", { exact: true, name: "WORKSPACE PASS MCP" });
  const logo = navItem.locator(".portal-nav-mcp-logo");
  await expect(navItem).toBeVisible();
  await expect(logo).toBeVisible();
  await expect(logo).toHaveCSS("width", "18px");
  await expect(logo).toHaveCSS("height", "18px");
  await expect(logo).toHaveCSS("background-color", "rgb(94, 90, 82)");
  await expect(logo).toHaveCSS("mask-image", /Model%20Context%20Protocol/);
  await testInfo.attach("workspace-ai-mcp-navigation-default", {
    body: await page.locator(".portal-left-rail").screenshot(),
    contentType: "image/png"
  });
  if (process.env.Portal_CAPTURE_SCREENSHOTS === "1") {
    await page.locator(".portal-left-rail").screenshot({
      path: "output/playwright/workspace-ai-mcp-navigation-default.png"
    });
  }
  await navItem.click();
  await expect(navItem).toHaveAttribute("aria-current", "page");
  await expect(logo).toHaveCSS("background-color", "rgb(183, 244, 58)");
  await expect(page).toHaveURL(/\/workspace-pass-mcp\/handbook$/);
  await expect(page.getByRole("heading", { level: 2, name: "Domains and workflow stages" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Knowledge file upload and retrieval" })).toHaveCount(0);
  await expect(page.getByText("76 official tools", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "System" })).toHaveCount(0);

  await testInfo.attach("workspace-ai-mcp-navigation", {
    body: await page.locator(".portal-left-rail").screenshot(),
    contentType: "image/png"
  });
  await testInfo.attach("workspace-ai-mcp-handbook", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png"
  });
  if (process.env.Portal_CAPTURE_SCREENSHOTS === "1") {
    await page.locator(".portal-left-rail").screenshot({
      path: "output/playwright/workspace-ai-mcp-navigation.png"
    });
    await page.screenshot({
      fullPage: true,
      path: "output/playwright/workspace-ai-mcp-handbook.png"
    });
  }
});

test("keeps APPS creation compact and exposes both creation layers", async ({ page }, testInfo) => {
  await page.route("**/api/apps/mcp-apps", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        apps: [{
          appId: "portfolio-tracker",
          description: "Portfolio data and actions",
          manifestVersion: "workspace.app-mcp/v1",
          name: "Portfolio Tracker"
        }]
      }
    });
  });
  await page.route("**/k/api/knowledge-services?view=card", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        services: [{
          description: "Published policy and product knowledge",
          effectiveRole: "owner",
          name: "AI Adoption Handbook",
          serviceId: "adoption-handbook"
        }]
      }
    });
  });
  await page.route("**/api/apps/mates", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: { error: "mate_email_conflict", requestId: "req-duplicate-email" },
      status: 409
    });
  });
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/#/apps");

  const header = page.locator(".portal-apps-heading");
  await expect(header.locator(".portal-apps-object-count")).toHaveText(/^\d{2}APPSs$/);
  await expect(page.locator(".portal-apps-summary")).toHaveCount(0);
  await expect(page.locator(".portal-apps-metric")).toHaveCount(0);
  await expect(page.getByRole("button", { exact: true, name: "Create App" })).toHaveCount(0);

  await page.getByRole("button", { exact: true, name: "NEW APPS" }).click();
  const createMenu = page.getByRole("menu", { name: "Choose a APPS type to create" });
  await expect(createMenu).toBeVisible();
  await expect(createMenu.getByRole("menuitem")).toHaveCount(3);
  await expect(createMenu.getByRole("menuitem", { name: /Skill/ })).toBeVisible();
  await expect(createMenu.getByRole("menuitem", { name: /Mate/ })).toBeVisible();
  await expect(createMenu.locator(".portal-apps-new-menu-icon")).toHaveCount(0);
  await expect(createMenu.getByRole("menuitem", { name: /App/ })).toContainText("Create a data or service object");
  expect(await createMenu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
  })).toBe(true);

  await testInfo.attach("apps-new-menu", {
    body: await page.screenshot(),
    contentType: "image/png"
  });
  if (process.env.Portal_CAPTURE_SCREENSHOTS === "1") {
    await page.screenshot({ path: "output/playwright/apps-new-menu.png" });
  }

  await createMenu.getByRole("menuitem", { name: /Mate/ }).click();
  const mateDialog = page.getByRole("dialog", { name: "Mate Builder" });
  await expect(mateDialog).toBeVisible();
  await expect(mateDialog).toHaveClass(/appsCreateModal/);
  await expect(mateDialog.getByText("Knowledge Mate (built-in)")).toHaveCount(0);
  await expect(mateDialog.getByText("Cortana · AI Adoption operations (built-in)")).toHaveCount(0);
  await expect(mateDialog.getByRole("radio")).toHaveCount(0);
  await expect(mateDialog.getByLabel("Name")).toHaveValue("");
  await expect(mateDialog.getByLabel("Name")).toHaveAttribute("placeholder", "For example: Cortana");
  await expect(mateDialog.getByLabel("Mate Code")).toHaveAttribute("placeholder", "For example: cortana-ai");
  await expect(mateDialog.getByLabel("Role")).toHaveValue("");
  await expect(mateDialog.getByLabel("Role")).toHaveAttribute("placeholder", /AI Adoption operations mate/);
  await expect(mateDialog.getByLabel("Description")).toHaveAttribute("placeholder", /who it serves/);
  await expect(mateDialog.getByRole("button", { name: "Manage private Todos" })).toHaveCount(0);
  await expect(mateDialog.getByRole("button", { name: "Manage private reminders" })).toHaveCount(0);
  await expect(mateDialog.getByText(/Private Todos and reminders are always provided by Runtime/)).toBeVisible();
  await mateDialog.getByRole("button", { name: /Task mode/ }).click();
  await expect(mateDialog.getByRole("button", { name: /mate_call through Workspace MCP MCP/ })).toBeVisible();
  await expect(mateDialog.getByRole("button", { name: /Email task inbox/ })).toBeVisible();
  await expect(mateDialog.getByRole("button", { name: /Scheduled tasks and reminders/ })).toHaveCount(0);

  const appResources = mateDialog.getByRole("button", { name: "Select App MCP resources" });
  await appResources.click();
  await page.getByRole("option", { name: /Portfolio Tracker/ }).click();
  await expect(appResources).toContainText("Portfolio Tracker");
  await appResources.click();

  const knowledgeResources = mateDialog.getByRole("button", { name: "Select Knowledge resources" });
  await knowledgeResources.click();
  await page.getByRole("option", { name: /AI Adoption Handbook/ }).click();
  await expect(knowledgeResources).toContainText("AI Adoption Handbook");
  await knowledgeResources.click();

  await mateDialog.getByRole("button", { name: "Who may call this Mate" }).click();
  await page.getByRole("option", { name: /Specified people or departments/ }).click();
  await expect(mateDialog.locator(".appsCreateAccessPickerPane")).toBeVisible();
  await expect(mateDialog.getByPlaceholder("Search departments, names, or emails")).toBeVisible();
  await mateDialog.getByPlaceholder("Search departments, names, or emails").fill("Bob Chen");
  await mateDialog.getByLabel(/Bob Chen/).check();
  await expect(mateDialog.getByTitle("Remove Bob Chen")).toBeVisible();

  await testInfo.attach("mate-builder-custom-resources", {
    body: await mateDialog.screenshot(),
    contentType: "image/png"
  });
  await mateDialog.getByLabel("Name").fill("Duplicate Email Mate");
  await mateDialog.getByLabel("Mate Code").fill("cortana");
  await mateDialog.getByLabel("Role").fill("Test duplicate work email handling");
  await mateDialog.getByRole("button", { name: "Save and Preview" }).click();
  await expect(mateDialog.getByText("This Mate Code is already in use. Choose a different one.")).toBeVisible();
  await mateDialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { exact: true, name: "NEW APPS" }).click();
  await createMenu.getByRole("menuitem", { name: /App/ }).click();
  const createDialog = page.getByRole("dialog", { name: "Create APPS app" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog).toHaveClass(/appsCreateModal/);
  await expect(createDialog.getByRole("heading", { level: 2, name: "Create APPS app" })).toBeVisible();
});

test("keeps all eight page headers and Rail states aligned across English and Chinese", async ({ page }) => {
  const pages = [
    {
      hash: "/#/skills-apps",
      en: { subtitle: "“Turn organizational experience into workflows in Apps, and methods in Skills.”", title: "Skills & Apps", nav: "Skills Hub" },
      zh: { subtitle: "“把组织经验，用 App 编排成流程，用 Skill 蒸馏成方法。”", title: "Skills & Apps", nav: "Skills Hub" }
    },
    {
      hash: "/#/tokens",
      en: { subtitle: "“Tokens measure intelligence in motion; Work Units measure the work completed.”", title: "Token" },
      zh: { subtitle: "“Token 计量智能调用，Work Unit 计量工作成果。”", title: "Token" }
    },
    {
      hash: "/#/apps",
      en: { subtitle: "“Software will become a skill—like knowing how to send a text message.”", title: "APPS" },
      zh: { subtitle: "“写软件会成为一项技能，就像会发短信一样。”", title: "APPS" }
    },
    {
      hash: "/#/knowledge",
      en: { subtitle: "“Within permission boundaries, publish documents and data as searchable, auditable context for Agents.”", title: "Knowledge Base" },
      zh: { subtitle: "“在权限边界内，把文档与数据发布为可检索、可审计的 Agent 上下文。”", title: "知识库" }
    },
    {
      hash: "/#/admin/users",
      en: { subtitle: "Manage users, organizational structures, and permissions", title: "User Management" },
      zh: { subtitle: "查看组织成员、社区等级及管理权限。", title: "用户管理" }
    },
    {
      hash: "/#/admin/knowledge",
      en: { subtitle: "Review every published knowledge service, its activity, and permission scope", title: "Knowledge Management" },
      zh: { subtitle: "查看已发布知识库的负责人、协作者、访问权限及使用情况。", title: "知识库管理" }
    },
    {
      hash: "/#/admin/hub-review",
      en: { subtitle: "Review App and Skill safety and publishing readiness", title: "Skills Review" },
      zh: { subtitle: "App 与 Skill 安全、上架审核", title: "发布审核" }
    },
    {
      hash: "/#/admin/gateway",
      en: { subtitle: "Manage API keys, user quotas and usage", title: "Gateway Administration" },
      zh: { subtitle: "API Key、用户配额与调用用量管理", title: "Token 管理" }
    }
  ] as const;

  await page.goto(pages[0].hash);
  for (const locale of ["en", "zh"] as const) {
    await page.evaluate((value) => window.localStorage.setItem("workspace-ai:locale", value), locale === "zh" ? "zh-CN" : "en");
    await page.setViewportSize({ height: locale === "en" ? 900 : 844, width: locale === "en" ? 1440 : 390 });
    for (const target of pages) {
      await page.goto(target.hash);
      await page.reload();
      const labels = target[locale];
      const heading = page.getByRole("heading", { exact: true, level: 1, name: labels.title });
      const header = page.locator(".portal-page-heading").filter({ has: heading });
      await expect(heading).toBeVisible();
      await expect(header).toHaveCount(1);
      await expect(header.getByText(labels.subtitle, { exact: true })).toBeVisible();
      expect(await header.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const navItem = page.locator('.portal-nav-item[aria-current="page"]');
      await expect(navItem).toHaveCount(1);
      await expect(navItem).toHaveText("nav" in labels ? labels.nav : labels.title);
      if (target.hash === "/#/apps") {
        const quoteSource = header.getByRole("link", { name: locale === "en" ? "Watch Boris Cherny's original AI Ascent 2026 interview" : "观看 Boris Cherny 在 AI Ascent 2026 的原始访谈" });
        await expect(quoteSource).toHaveAttribute("href", "https://www.youtube.com/watch?v=SlGRN8jh2RI");
        await expect(quoteSource).toHaveAttribute("target", "_blank");
      }
    }
  }
});

test("opens profile settings from the Portal shell and Agent settings from Live", async ({ page }) => {
  const avatarUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' fill='%23d9e2ee'/%3E%3C/svg%3E";
  const profileUpdates: unknown[] = [];

  await page.route("**/api/users/*/profile", async (route) => {
    if (route.request().method() === "PATCH") {
      const updates = await route.request().postDataJSON();
      profileUpdates.push(updates);
      await route.fulfill({
        contentType: "application/json",
        json: {
          user: {
            avatarUrl: updates.avatarUrl,
            bio: updates.bio,
            email: "local.admin@example.invalid",
            id: "local-dev-admin",
            jobTitle: updates.jobTitle,
            location: updates.location,
            name: updates.name,
            role: "admin",
            team: "AI Adoption"
          }
        }
      });
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        user: {
          avatarUrl,
          bio: "Local fallback account for development when the API catalog is unavailable.",
          id: "local-dev-admin",
          jobTitle: "",
          location: "Local",
          name: "Local Admin"
        }
      }
    });
  });

  await page.goto("/#/home");

  await page.getByRole("button", { name: "Open profile settings and badges" }).click();
  const profileDialog = page.getByRole("dialog", { name: "Local Admin profile" });
  await expect(profileDialog).toBeVisible();
  await profileDialog.getByLabel("Title").fill("Portal Shell Owner");
  await profileDialog.getByRole("button", { name: "Save" }).click();
  await expect(profileDialog.getByText("Saved.")).toBeVisible();
  expect(profileUpdates).toEqual([{
    avatarUrl,
    bio: "Local fallback account for development when the API catalog is unavailable.",
    jobTitle: "Portal Shell Owner",
    location: "Local",
    name: "Local Admin"
  }]);
  await profileDialog.getByRole("button", { name: "Close" }).click();
  await expect(profileDialog).toBeHidden();

  await page.getByRole("button", { name: "Workspace MCP MCP settings" }).click();
  const mcpDialog = page.getByRole("dialog", { name: "Workspace MCP MCP status" });
  await expect(mcpDialog).toBeVisible();
  await expect(mcpDialog.locator(".appsApiMode")).toHaveCount(0);
  await expect(mcpDialog.getByText("Choose my Agent")).toBeVisible();
  const [summaryWidth, pickerWidth] = await Promise.all([
    mcpDialog.locator(".mcpConnectionSummary").evaluate((element) => element.getBoundingClientRect().width),
    mcpDialog.locator(".agentQuickConnect").first().evaluate((element) => element.getBoundingClientRect().width)
  ]);
  expect(Math.abs(summaryWidth - pickerWidth)).toBeLessThan(1);
  const agentOptions = mcpDialog.getByRole("radio");
  await expect(agentOptions).toHaveCount(4);
  await expect(mcpDialog.locator(".agentTargetGrid")).toHaveCSS("display", "grid");
  await expect(agentOptions.first()).toHaveCSS("display", "grid");
  await expect(agentOptions.first()).toHaveCSS("min-height", "40px");
  await expect(agentOptions.first()).toHaveAccessibleName("WorkBuddy");
  await expect(mcpDialog.getByRole("radio", { name: "Claude Code" })).toBeVisible();
  await expect(mcpDialog.getByRole("radio", { name: "Codex" })).toBeVisible();
  await expect(agentOptions.first()).toHaveAttribute("aria-checked", "true");
  await mcpDialog.getByRole("radio", { name: "Cursor" }).click();
  await expect(mcpDialog.getByRole("heading", { name: "Connect Cursor" })).toBeVisible();
  await mcpDialog.getByRole("button", { name: "Close" }).click();
  await expect(mcpDialog).toBeHidden();
});

test("opens Agent settings from the Live empty-connection action", async ({ page }) => {
  await page.goto("/#/home");

  const emptyConnectionAction = page.getByRole("button", { exact: true, name: "Connect Workspace MCP MCP" });
  await expect(emptyConnectionAction).toBeVisible();
  await expect(emptyConnectionAction.locator("img")).toHaveCount(1);
  await captureReviewScreenshot(page, "portal-live-empty-action.png");
  await emptyConnectionAction.click();

  const mcpDialog = page.getByRole("dialog", { name: "Workspace MCP MCP status" });
  await expect(mcpDialog).toBeVisible();
  await expect(mcpDialog.getByText("Choose my Agent")).toBeVisible();
  await captureReviewScreenshot(page, "portal-mcp-settings-unified.png");
});

test("confirms and visibly revokes an MCP connection from Agent settings", async ({ page }) => {
  let connections = [{
    agentType: "claude-code",
    displayName: "Claude (Ivy) refresh",
    id: "mcp-conn-ivy-refresh",
    lastSeenAt: "2026-07-14T13:03:04.000Z",
    status: "active"
  }];
  const revokeRequests: Array<{ method: string; url: string }> = [];

  await page.route("**/api/mcp/connections/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        status: {
          activeCount: connections.length,
          connected: connections.length > 0,
          connections,
          maxActiveConnections: 3
        }
      }
    });
  });
  await page.route("**/api/mcp/connections/mcp-conn-ivy-refresh", async (route) => {
    revokeRequests.push({ method: route.request().method(), url: route.request().url() });
    connections = [];
    await route.fulfill({ contentType: "application/json", json: { revoked: true } });
  });

  await page.goto("/#/home");
  await expect(page.locator(".portal-agent-connection").filter({ hasText: "Claude (Ivy) refresh" })).toBeVisible();
  await page.getByRole("button", { name: "Workspace MCP MCP settings" }).click();
  const mcpDialog = page.getByRole("dialog", { name: "Workspace MCP MCP status" });
  const revokeButton = mcpDialog.getByRole("button", { name: "Revoke the Claude Code MCP connection" });
  await expect(revokeButton).toBeVisible();

  const confirmationHandled = new Promise<void>((resolve) => {
    page.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain("Claude (Ivy) refresh");
      await dialog.accept();
      resolve();
    });
  });
  await revokeButton.click();
  await confirmationHandled;

  await expect(mcpDialog.getByRole("status")).toHaveText('MCP connection "Claude (Ivy) refresh" was revoked.');
  await expect(revokeButton).toHaveCount(0);
  expect(revokeRequests).toHaveLength(1);
  expect(revokeRequests[0].method).toBe("DELETE");
});

test("routes the retired MCP device page to the OAuth handbook", async ({ page }) => {
  await page.route("**/api/mcp/handbook", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        capabilityPacks: [],
        catalogRevision: "0.6.2+20260812",
        generatedAt: "2026-08-12T00:00:00.000Z",
        groups: [
          { count: 0, id: "forum" },
          { count: 0, id: "hub" },
          { count: 0, id: "knowledge" },
          { count: 0, id: "apps" }
        ],
        latestFeatures: [],
        releases: [],
        server: { name: "workspace-ai", protocol: "Model Context Protocol", protocolVersion: "2025-06-18", releasedAt: "2026-08-12", version: "0.6.2" },
        summary: { approvalTools: 0, readTools: 0, toolCount: 0, writeTools: 0 },
        tools: []
      }
    });
  });
  await page.goto("/#/mcp/device/verify?user_code=ABCD-1234");

  await expect(page.getByRole("heading", { level: 1, name: "Workspace MCP MCP Handbook" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Authorize Workspace MCP MCP" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
});

test("collapses the Portal navigation when workspace space is constrained", async ({ page }) => {
  await page.goto("/#/knowledge");

  await expect(page.getByRole("heading", { level: 1, name: "Knowledge Base" })).toBeVisible();
  const shell = page.locator(".portal-shell");
  const leftRail = page.locator(".portal-left-rail");
  const railToggle = page.getByRole("button", { name: "Collapse navigation" });
  const sharedResearch = page.locator(".portal-knowledge-row").filter({ hasText: "Shared Research" });
  const profileAvatar = page.locator(".portal-account-profile .personAvatar");

  await expect(leftRail.locator(".portal-brand strong")).toHaveText("Frontier Workspace");
  await expect(railToggle).toHaveCSS("border-top-style", "solid");
  await expect(railToggle).toHaveCSS("border-top-width", "1px");
  await expect(shell).not.toHaveClass(/rail-collapsed/);
  await expect(leftRail).toHaveCSS("width", "256px");
  if (process.env.Portal_CAPTURE_SCREENSHOTS === "1") {
    await page.screenshot({ path: "output/playwright/portal-expanded-navigation-brand.png" });
  }
  await railToggle.click();
  await expect(shell).toHaveClass(/rail-collapsed/);
  await expect(leftRail).toHaveCSS("width", "68px");
  await expect(page.getByRole("button", { name: "Switch to administration" })).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
  await expect(profileAvatar).toBeVisible();
  expect(await profileAvatar.evaluate((avatar) => {
    const avatarBox = avatar.getBoundingClientRect();
    const railBox = avatar.closest(".portal-left-rail")?.getBoundingClientRect();
    return Boolean(railBox && avatarBox.left >= railBox.left && avatarBox.right <= railBox.right);
  })).toBe(true);
  await page.getByRole("button", { name: "Expand navigation" }).click();
  await expect(shell).not.toHaveClass(/rail-collapsed/);

  await sharedResearch.getByRole("button", { name: "Ask", exact: true }).click();
  const mateDrawer = page.getByRole("dialog", { name: "Access “Shared Research” with Mate" });
  await expect(mateDrawer).toBeVisible();
  await expect(shell).toHaveClass(/rail-collapsed/);
  await expect(leftRail).toHaveCSS("width", "68px");
  if (process.env.Portal_CAPTURE_SCREENSHOTS === "1") {
    await page.screenshot({ path: "output/playwright/portal-collapsed-navigation-with-mate.png" });
  }
  await page.getByRole("button", { name: "Expand navigation" }).click();
  await expect(shell).not.toHaveClass(/rail-collapsed/);
  await page.keyboard.press("Escape");
  await expect(mateDrawer).toHaveCount(0);
  await expect(leftRail).toHaveCSS("width", "256px");

  await page.setViewportSize({ height: 800, width: 1000 });
  await expect(shell).toHaveClass(/rail-collapsed/);
  await expect(leftRail).toHaveCSS("width", "68px");
  await page.getByRole("button", { name: "Expand navigation" }).click();
  await expect(shell).not.toHaveClass(/rail-collapsed/);
  await expect(leftRail).toHaveCSS("width", "256px");
});

test("runs APPS from its native Portal controller and opens the shared create flow", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ height: 900, width: 1440 });
  const appsListRequests = { apps: 0, inventory: 0, skills: 0 };
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/apps/inventory") appsListRequests.inventory += 1;
    if (path === "/api/apps/apps") appsListRequests.apps += 1;
    if (path === "/api/apps/skills") appsListRequests.skills += 1;
  });
  let appFixture: Record<string, unknown> = {
    accessTargets: [],
    agentMcpEnabled: false,
    appCode: "risk-review",
    collaboratorUserIds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    dataServiceId: "data-risk-review",
    deployments: [{
      appId: "apps-app-risk-review",
      createdAt: "2026-07-09T08:30:00.000Z",
      createdBy: "local-dev-admin",
      environment: "production",
      id: "deployment-risk-review-20260709",
      status: "active",
      url: "https://risk-review.example.test",
      version: "2026.07.09",
      versionName: "Contract Risk Review owner permission management"
    }],
    description: "Review high-risk client contracts with a controlled workflow.",
    domains: [{
      environment: "production",
      hostname: "risk-review.example.test",
      id: "domain-risk-review",
      routeStatus: "active",
      status: "registered",
      type: "production"
    }],
    id: "apps-app-risk-review",
    lastDeployedAt: "2026-07-10T00:00:00.000Z",
    llmEnabled: true,
    loginRequired: true,
    manifest: {
      email: { sending: { senderMailbox: "risk-review@mail.example.invalid" } },
      llm: { gatewayUrl: "https://token.example.invalid", secretName: "WORKSPACE_LLM_APP_KEY" }
    },
    name: "Contract Risk Review",
    orgId: "workspace",
    ownerTeamId: "legal-ai",
    ownerUserId: "local-dev-admin",
    productionUrl: "https://risk-review.example.test",
    resources: [{
      environment: "production",
      id: "resource-risk-review-d1",
      provider: "cloudflare",
      resourceName: "apps-risk-review-db",
      status: "ready",
      type: "d1_database"
    }, {
      environment: "production",
      id: "resource-risk-review-worker",
      provider: "cloudflare",
      resourceName: "apps-risk-review-worker",
      status: "ready",
      type: "worker"
    }, {
      environment: "production",
      id: "resource-risk-review-email",
      provider: "cloudflare",
      resourceName: "apps-risk-review-email",
      status: "ready",
      type: "email_sending"
    }],
    secrets: [{
      appId: "apps-app-risk-review",
      configuredAt: "2026-07-10T00:00:00.000Z",
      configuredBy: "local-dev-admin",
      createdAt: "2026-07-01T00:00:00.000Z",
      declaredBy: "local-dev-admin",
      description: "LLM Gateway App Key",
      environment: "production",
      id: "secret-risk-review-llm",
      name: "WORKSPACE_LLM_APP_KEY",
      required: true,
      status: "configured",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }],
    slug: "risk-review",
    status: "published",
    type: "web",
    updatedAt: "2026-07-10T00:00:00.000Z",
    visibility: "org"
  };
  let skillFixture: Record<string, unknown> = {
    accessTargets: [],
    capabilities: ["review", "risk"],
    collaboratorUserIds: [],
    createdAt: "2026-07-02T00:00:00.000Z",
    currentVersion: "1.0.0",
    currentVersionId: "skill-version-risk-review-1",
    description: "Reusable risk review instructions.",
    id: "apps-skill-risk-review",
    kind: "vanilla",
    loginRequired: true,
    name: "Risk Review Skill",
    orgId: "workspace",
    orgSlug: "workspace",
    ownerUserId: "local-dev-admin",
    slug: "risk-review-skill",
    status: "private",
    updatedAt: "2026-07-09T00:00:00.000Z",
    versions: [{
      artifactKey: "skills/risk-review/1.0.0/package.zip",
      artifactSha256: "e2e-risk-review-sha256",
      changelog: "Initial reusable risk review workflow.",
      createdAt: "2026-07-08T09:15:00.000Z",
      createdBy: "local-dev-admin",
      fileCount: 10,
      frontmatter: {},
      id: "skill-version-risk-review-1",
      manifest: {
        package: {
          files: [{ path: "AGENT.md", sizeBytes: 2048 }, {
            path: "COMMERCIAL_LICENSING.md",
            sizeBytes: 9216
          }, { path: "WORKSPACE_PACKAGE_NOTES.md", sizeBytes: 608 }, {
            path: "HANDOFF.md",
            sizeBytes: 37888
          }, { path: "LICENSE", sizeBytes: 34816 }, {
            path: "package-lock.json",
            sizeBytes: 1638
          }, { path: "package.json", sizeBytes: 980 }, {
            path: "SKILL.md",
            sizeBytes: 12288
          }, { path: "references/background-systems.md", sizeBytes: 3482 }, {
            path: "references/components.md",
            sizeBytes: 19456
          }]
        }
      },
      manifestKey: "skills/risk-review/1.0.0/manifest.json",
      sizeBytes: 122416,
      skillId: "apps-skill-risk-review",
      skillMdKey: "skills/risk-review/1.0.0/SKILL.md",
      state: "listed",
      version: "1.0.0"
    }],
    visibility: "org"
  };
  const orgReadableSkillFixture: Record<string, unknown> = {
    ...skillFixture,
    collaboratorUserIds: ["remote-storage-collaborator"],
    id: "apps-skill-storage-analyzer",
    name: "storage-analyzer",
    ownerUserId: "remote-storage-owner",
    slug: "storage-analyzer",
    visibility: "org"
  };
  let savedAppAccess: Record<string, unknown> | undefined;
  let savedAppCollaborators: Record<string, unknown> | undefined;
  let savedSkillAccess: Record<string, unknown> | undefined;
  let savedSkillCollaborators: Record<string, unknown> | undefined;
  let coauthorAppInfo: Record<string, unknown> | undefined;
  let coauthorAppCollaborators: Record<string, unknown> | undefined;
  let coauthorAppSubmission: Record<string, unknown> | undefined;
  let coauthorSkillInfo: Record<string, unknown> | undefined;
  let coauthorSkillCollaborators: Record<string, unknown> | undefined;
  let coauthorSkillSubmission: Record<string, unknown> | undefined;
  const coauthorDeleteRequests: Array<{
    body?: Record<string, unknown>;
    method: string;
    target: "listing" | "skill";
  }> = [];
  let handoffRequestStarted = false;
  let handoffRequestCount = 0;
  let releaseHandoffRequest = () => {};
  const handoffRequestGate = new Promise<void>((resolve) => {
    releaseHandoffRequest = resolve;
  });

  await page.route("**/api/users/departments", route => route.fulfill({ json: { departments: [
    { id: "dept-gh", name: "GH" },
    { id: "dept-research", name: "Investment Research", parentId: "dept-gh" },
    { id: "dept-gentleman", name: "Gentleman" },
    { id: "dept-trading", name: "Trading", parentId: "dept-gentleman" },
    { id: "dept-workspace-space", name: "Workspace Space" },
    { id: "dept-ai-adoption", name: "AI Adoption", parentId: "dept-workspace-space" },
    { id: "dept-empty", name: "Empty team", parentId: "dept-gh" }
  ] } }));

  await page.route("**/api/users/directory**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        users: [{
          avatarUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' rx='12' fill='%23d97706'/%3E%3C/svg%3E",
          department: "Investment Research",
          departmentId: "dept-research",
          departmentPath: ["dept-gh", "dept-research"],
          email: "ada@example.com",
          id: "user-ada",
          name: "Ada",
          team: "GH / Investment Research"
        }, {
          avatarUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' rx='12' fill='%23047857'/%3E%3C/svg%3E",
          department: "Trading",
          departmentId: "dept-trading",
          departmentPath: ["dept-gentleman", "dept-trading"],
          email: "bob@example.com",
          id: "user-bob",
          name: "Bob",
          team: "Gentleman / Trading"
        }, {
          department: "AI Adoption",
          departmentId: "dept-ai-adoption",
          departmentPath: ["dept-workspace-space", "dept-ai-adoption"],
          email: "local.admin@example.invalid",
          id: "local-dev-admin",
          name: "Local Admin",
          team: "Workspace Space / AI Adoption"
        }]
      }
    });
  });

  await page.route("**/api/apps/apps/apps-app-risk-review/visibility", async (route) => {
    savedAppAccess = route.request().postDataJSON() as Record<string, unknown>;
    appFixture = { ...appFixture, ...savedAppAccess };
    await route.fulfill({ contentType: "application/json", json: { app: appFixture } });
  });

  await page.route("**/api/apps/apps/apps-app-risk-review/collaborators", async (route) => {
    savedAppCollaborators = route.request().postDataJSON() as Record<string, unknown>;
    if (appFixture.ownerUserId === "remote-app-owner") {
      coauthorAppCollaborators = savedAppCollaborators;
    }
    appFixture = { ...appFixture, ...savedAppCollaborators };
    await route.fulfill({ contentType: "application/json", json: { app: appFixture } });
  });

  await page.route("**/api/apps/apps/apps-app-risk-review/handoff-link", async (route) => {
    handoffRequestStarted = true;
    handoffRequestCount += 1;
    await handoffRequestGate;
    await route.fulfill({
      contentType: "application/json",
      json: { expiresAt: Math.floor(Date.now() / 1000) + 900, url: "https://handoff.example.test/signed-risk-review" }
    });
  });

  await page.route("**/api/apps/skills/apps-skill-risk-review/visibility", async (route) => {
    savedSkillAccess = route.request().postDataJSON() as Record<string, unknown>;
    skillFixture = { ...skillFixture, ...savedSkillAccess };
    await route.fulfill({ contentType: "application/json", json: { skill: skillFixture } });
  });

  await page.route("**/api/apps/skills/apps-skill-risk-review/collaborators", async (route) => {
    savedSkillCollaborators = route.request().postDataJSON() as Record<string, unknown>;
    if (skillFixture.ownerUserId === "remote-skill-owner") {
      coauthorSkillCollaborators = savedSkillCollaborators;
    }
    skillFixture = { ...skillFixture, ...savedSkillCollaborators };
    await route.fulfill({ contentType: "application/json", json: { skill: skillFixture } });
  });

  await page.route("**/api/apps/apps/apps-app-risk-review", async (route) => {
    expect(route.request().method()).toBe("PATCH");
    coauthorAppInfo = route.request().postDataJSON() as Record<string, unknown>;
    appFixture = {
      ...appFixture,
      description: coauthorAppInfo.description,
      name: coauthorAppInfo.name,
      updatedAt: "2026-07-14T00:00:00.000Z"
    };
    await route.fulfill({ contentType: "application/json", json: { app: appFixture } });
  });

  await page.route("**/api/apps/skills/apps-skill-risk-review", async (route) => {
    if (route.request().method() === "DELETE") {
      coauthorDeleteRequests.push({
        body: route.request().postDataJSON() as Record<string, unknown>,
        method: route.request().method(),
        target: "skill"
      });
      await route.fulfill({ contentType: "application/json", json: { ok: true } });
      return;
    }

    expect(route.request().method()).toBe("PATCH");
    coauthorSkillInfo = route.request().postDataJSON() as Record<string, unknown>;
    skillFixture = {
      ...skillFixture,
      ...coauthorSkillInfo,
      updatedAt: "2026-07-14T00:00:00.000Z"
    };
    await route.fulfill({ contentType: "application/json", json: { skill: skillFixture } });
  });

  await page.route("**/api/listings/listing-apps-skill-risk-review", async (route) => {
    coauthorDeleteRequests.push({ method: route.request().method(), target: "listing" });
    await route.fulfill({ contentType: "application/json", json: { ok: true } });
  });

  await page.route("**/api/market/submissions", async (route) => {
    expect(route.request().method()).toBe("POST");
    const submission = route.request().postDataJSON() as Record<string, unknown>;
    if (submission.targetType === "app") {
      coauthorAppSubmission = submission;
    } else if (submission.targetType === "skill") {
      coauthorSkillSubmission = submission;
    }
    await route.fulfill({
      contentType: "application/json",
      json: {
        listingId: submission.targetType === "app" ? "listing-apps-app-risk-review" : "listing-apps-skill-risk-review",
        status: "pending_review",
        targetId: submission.targetId,
        targetPlane: "apps",
        targetType: submission.targetType
      }
    });
  });

  await page.route("**/api/apps/inventory", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        apps: [appFixture],
        skills: [skillFixture]
      }
    });
  });
  await page.route("**/api/publication/listings", async (route) => {
    const sharedListing = {
      category: "Workflow",
      coverImageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      owner: "AI Adoption",
      publisherProfile: {
        email: "local.admin@example.invalid",
        id: "local-dev-admin",
        name: "Local Admin"
      },
      riskLevel: "low",
      status: "listed",
      summary: "Ready for the company catalog.",
      targetPlane: "apps",
      updatedAt: "2026-07-10T00:00:00.000Z",
      visibility: "company"
    };

    await route.fulfill({
      contentType: "application/json",
      json: {
        publicationListings: [{
          ...sharedListing,
          config: { productionUrl: "https://risk-review.example.test" },
          description: "Review high-risk client contracts with a controlled workflow.",
          id: "listing-apps-app-risk-review",
          name: "Contract Risk Review",
          targetId: "apps-app-risk-review",
          type: "app"
        }, {
          ...sharedListing,
          description: "Reusable risk review instructions.",
          id: "listing-apps-skill-risk-review",
          name: "Risk Review Skill",
          targetId: "apps-skill-risk-review",
          type: "skill"
        }, {
          ...sharedListing,
          description: "Stale Publication listing without a My APPS inventory asset.",
          id: "listing-apps-skill-storage-analyzer",
          name: "storage-analyzer",
          ownerProfiles: [{
            email: "local.admin@example.invalid",
            id: "local-dev-admin",
            name: "Local Admin"
          }],
          submittedByProfile: {
            email: "local.admin@example.invalid",
            id: "local-dev-admin",
            name: "Local Admin"
          },
          targetId: orgReadableSkillFixture.id,
          type: "skill"
        }]
      }
    });
  });
  await page.route("**/api/publication/hub-listings", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { hubListings: [] } });
  });

  await page.goto("/#/apps");

  await expect(page.getByRole("heading", { level: 1, name: "APPS" })).toBeVisible();
  await expect(page.locator(".portal-apps-surface")).toBeVisible();
  await expect(page.locator(".portal-apps-domain-bridge, .appsPage")).toHaveCount(0);
  await expect(page.locator(".appsProductRow")).toHaveCount(2);
  await expect(page.getByText("storage-analyzer", { exact: true })).toHaveCount(0);
  await expect.poll(() => appsListRequests).toEqual({ apps: 0, inventory: 1, skills: 0 });
  await expect(page.locator(".portal-apps-object-count")).toHaveText("02APPSs");
  await expect(page.locator(".portal-apps-summary, .portal-apps-metric")).toHaveCount(0);
  await expect(page.locator(".appsProductRow").filter({ hasText: "Risk Review Skill" }).locator(".statusBadge"))
    .toHaveText("Organization visible");

  await page.getByRole("button", { exact: true, name: "Skills" }).click();
  await expect(page.locator(".appsProductRow")).toHaveCount(1);
  await expect(page.getByText("Risk Review Skill", { exact: true })).toBeVisible();
  await page.getByRole("button", { exact: true, name: "All" }).click();

  const contractRiskReviewRow = page.locator(".appsProductRow").filter({ hasText: "Contract Risk Review" });
  await expect(page.locator(".appsProductRow")).toHaveCount(2);
  await expect(contractRiskReviewRow).toBeVisible();
  await contractRiskReviewRow.click();
  const detailDialog = page.getByRole("dialog", { name: "Contract Risk Review details" });
  await expect(detailDialog).toBeVisible();
  const appDefaultModalBox = await detailDialog.boundingBox();
  expect(appDefaultModalBox?.width).toBeCloseTo(820, 0);
  expect(appDefaultModalBox?.height).toBeCloseTo(820, 0);
  await expect(detailDialog.locator(".assetReviewFormPanel")).toHaveCount(0);
  await expect(detailDialog.getByRole("tab", { name: "Publish to Community" })).toBeVisible();
  await expect(detailDialog.locator(".appsProgressRailItem")).toHaveCount(4);
  await expect(detailDialog.locator(".appsProgressRailItem.ready")).toHaveCount(4);
  await expect(detailDialog.locator(".appsProgressStepNumber")).toHaveText(["1", "2", "3", "4"]);
  await expect(detailDialog.locator(".appsProgressStepCheck, .appsProgressSummary, .appsProgressSegments")).toHaveCount(0);
  await expect(detailDialog.locator(".appsProgressRailItem.ready .appsProgressStepNumber").first()).toHaveCSS("background-color", "rgb(39, 112, 78)");
  const appProgressStepBoxes = await detailDialog.locator(".appsProgressRailItem").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));
  expect(new Set(appProgressStepBoxes.map((box) => Math.round(box.y))).size).toBe(1);
  const appProgressBox = await detailDialog.locator(".appsBasicProgressSection").boundingBox();
  const appBasicInfoBox = await detailDialog.locator(".appsBasicInfoSection").boundingBox();
  expect(appProgressBox?.y).toBeLessThan(appBasicInfoBox?.y ?? 0);
  const appBasicScroller = detailDialog.locator(".appsDetailTabScroll");
  const appBasicFooter = detailDialog.locator(".appsDetailTabFooter");
  await expect(appBasicScroller).toHaveCSS("overflow-y", "auto");
  const appBasicPreviewScrollMetrics = await appBasicScroller.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(appBasicPreviewScrollMetrics.scrollHeight).toBeGreaterThan(appBasicPreviewScrollMetrics.clientHeight);
  const appBasicPreviewFooterY = (await appBasicFooter.boundingBox())?.y ?? 0;
  await appBasicScroller.hover();
  await page.mouse.wheel(0, 420);
  await expect.poll(() => appBasicScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect((await appBasicFooter.boundingBox())?.y ?? 0).toBeCloseTo(appBasicPreviewFooterY, 0);
  await appBasicScroller.evaluate((element) => { element.scrollTop = 0; });
  await expect(detailDialog.getByRole("button", { exact: true, name: "Edit" })).toBeVisible();
  await expect(detailDialog.getByRole("button", { name: "Delete App" })).toHaveCount(0);
  await expect(detailDialog.locator(".appsBasicInfoGrid .assetDetailItem")).toHaveCount(4);
  const resourceItems = detailDialog.locator(".appsResourceInventoryItem");
  await expect(resourceItems).toHaveCount(4);
  await expect(resourceItems.locator(".appsResourceStatus")).toHaveText(["Ready", "Ready", "Registered", "Ready"]);
  await expect(resourceItems.locator(".appsResourceMeta small")).toHaveText(["production", "production", "production", "production"]);
  const firstResourceBox = await resourceItems.nth(0).boundingBox();
  const secondResourceBox = await resourceItems.nth(1).boundingBox();
  expect(firstResourceBox?.y).toBe(secondResourceBox?.y);
  expect(firstResourceBox?.height).toBeLessThan(100);
  const workerCopy = resourceItems.nth(1).getByRole("button", { name: "apps-risk-review-worker" });
  await workerCopy.click();
  await expect(workerCopy).toContainText("apps-risk-review-worker");
  await expect(workerCopy).toHaveAttribute("title", "Copied");
  const handoffButton = detailDialog.getByRole("button", { name: "Copy Handoff to Agent" });
  await expect(handoffButton).toHaveCSS("background-color", "rgb(17, 17, 15)");
  await handoffButton.click();
  await detailDialog.getByRole("menuitem", { name: /Copy environment info/ }).click();
  await expect.poll(() => handoffRequestStarted).toBe(true);
  const generatingHandoffButton = detailDialog.getByRole("button", { name: "Generating handoff" });
  await expect(generatingHandoffButton).toHaveAttribute("aria-busy", "true");
  await expect(generatingHandoffButton.locator(".spinIcon")).toBeVisible();
  await expect(generatingHandoffButton).toBeDisabled();
  await captureReviewScreenshot(page, "portal-apps-handoff-loading-desktop.png");
  releaseHandoffRequest();
  const copiedHandoffDialog = page.getByRole("dialog", { name: "Copied" });
  await expect(copiedHandoffDialog).toBeVisible();
  await copiedHandoffDialog.getByRole("button", { name: "Got it" }).click();
  await captureReviewScreenshot(page, "portal-apps-app-detail-desktop.png");

  await detailDialog.getByRole("tab", { name: "Publish to Community" }).click();
  await expect(detailDialog.getByText("Publishing preview", { exact: true })).toHaveCount(0);
  await expect(detailDialog.locator(".appsDetailTabScroll input, .appsDetailTabScroll textarea")).toHaveCount(0);
  await expect(detailDialog.getByRole("button", { exact: true, name: "Edit" })).toBeVisible();
  await expect(detailDialog.getByRole("button", { name: "Delete App" })).toHaveCount(0);
  expect((await detailDialog.boundingBox())?.height).toBeCloseTo(appDefaultModalBox?.height ?? 0, 0);
  await captureReviewScreenshot(page, "portal-apps-app-community-view-desktop.png");
  await detailDialog.getByRole("button", { exact: true, name: "Edit" }).click();
  await expect(detailDialog.locator(".appsDetailTabScroll input").first()).toBeVisible();
  await expect(detailDialog.getByRole("button", { exact: true, name: "Save" })).toBeVisible();
  await expect(detailDialog.getByRole("button", { name: "Delete App" })).toHaveCount(0);
  await captureReviewScreenshot(page, "portal-apps-app-community-edit-desktop.png");
  await detailDialog.getByRole("button", { exact: true, name: "Cancel" }).click();
  await expect(detailDialog.locator(".appsDetailTabScroll input, .appsDetailTabScroll textarea")).toHaveCount(0);

  await detailDialog.getByRole("tab", { name: "Settings" }).click();
  const appStatusPanel = detailDialog.locator(".assetReviewFormPanel");
  const appAccessMain = detailDialog.locator(".appsAccessSettingsMain");
  const appSettingsFormColumn = detailDialog.locator(".appsAccessSettingsFormColumn");
  await expect(appStatusPanel).toHaveCount(0);
  await expect(detailDialog.locator(".appsAccessPickerPane")).toHaveCount(0);
  await expect(detailDialog.locator(".appsAccessPolicySummary")).toHaveCount(0);
  const appCollaboratorCard = appSettingsFormColumn.locator(".appsCollaboratorCard");
  await expect(appCollaboratorCard).toContainText("Collaborators");
  await expect(appCollaboratorCard.locator(".capabilityStatusText")).toHaveText("None added");
  const appModalHeightBeforeCollaboratorEdit = await detailDialog.evaluate((element) => element.getBoundingClientRect().height);
  const appFormBoxBeforeCollaboratorEdit = await appSettingsFormColumn.boundingBox();
  await appCollaboratorCard.getByRole("button", { exact: true, name: "Manage" }).click();
  const appCollaboratorPicker = appCollaboratorCard.locator(".peopleMentionPicker");
  const appCollaboratorInput = appCollaboratorPicker.getByRole("combobox", { name: "Choose collaborators" });
  await expect(appCollaboratorInput).toHaveAttribute("placeholder", "@ Search by name or email");
  await appCollaboratorInput.fill("@Ada");
  const appAdaOption = appCollaboratorPicker.getByRole("option", { name: "Ada" });
  await expect(appAdaOption).toBeVisible();
  await expect(appAdaOption.locator(".peopleMentionAvatar img")).toBeVisible();
  await expect(appAdaOption).not.toContainText("Investment Research");
  const appCollaboratorResultsBox = await appCollaboratorPicker.getByRole("listbox").boundingBox();
  const appCollaboratorViewportBox = await appSettingsFormColumn.boundingBox();
  expect((appCollaboratorResultsBox?.y ?? 0) + (appCollaboratorResultsBox?.height ?? 0))
    .toBeLessThanOrEqual((appCollaboratorViewportBox?.y ?? 0) + (appCollaboratorViewportBox?.height ?? 0) + 1);
  expect(await detailDialog.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(appModalHeightBeforeCollaboratorEdit, 0);
  const appFormBoxWithCollaboratorResults = await appSettingsFormColumn.boundingBox();
  expect(Math.abs((appFormBoxWithCollaboratorResults?.width ?? 0) - (appFormBoxBeforeCollaboratorEdit?.width ?? 0))).toBeLessThanOrEqual(1);
  await captureReviewScreenshot(page, "portal-apps-app-settings-collaborators-search-desktop.png");
  await appCollaboratorInput.press("ArrowDown");
  await appCollaboratorInput.press("Enter");
  await expect(appCollaboratorInput).toBeFocused();
  await expect(appCollaboratorInput).toHaveValue("");
  const appAdaTag = appCollaboratorCard.getByRole("button", { name: "Remove collaborator Ada" });
  await expect(appAdaTag).toBeVisible();
  await expect(appAdaTag.locator(".peopleMentionAvatar img")).toBeVisible();
  await appCollaboratorCard.scrollIntoViewIfNeeded();
  await captureReviewScreenshot(page, "portal-apps-app-settings-collaborators-edit-desktop.png");
  await appCollaboratorCard.getByRole("button", { name: "Save collaborators" }).click();
  await expect.poll(() => savedAppCollaborators).toEqual({ collaboratorUserIds: ["user-ada"] });
  await expect(appCollaboratorCard.locator(".peopleMentionTag.readOnly")).toContainText("Ada");
  await expect(appCollaboratorCard.locator(".peopleMentionTag.readOnly .peopleMentionAvatar img")).toBeVisible();
  await expect(appCollaboratorCard.locator(".capabilityStatusText")).toHaveText("1 collaborator");
  await appCollaboratorCard.scrollIntoViewIfNeeded();
  await captureReviewScreenshot(page, "portal-apps-app-settings-collaborators-desktop.png");
  await appCollaboratorCard.getByRole("button", { exact: true, name: "Manage" }).click();
  await page.setViewportSize({ height: 844, width: 390 });
  const appMobileModalHeightBeforeSearch = await detailDialog.evaluate((element) => element.getBoundingClientRect().height);
  const appMobileCollaboratorInput = appCollaboratorCard.getByRole("combobox", { name: "Choose collaborators" });
  await appMobileCollaboratorInput.fill("@Bob");
  const appMobileCollaboratorListbox = appCollaboratorCard.getByRole("listbox");
  await expect(appMobileCollaboratorListbox).toBeVisible();
  await expect(appCollaboratorPicker).toHaveClass(/opensUpward/);
  const appMobileCollaboratorListboxBox = await appMobileCollaboratorListbox.boundingBox();
  const appMobileDialogBox = await detailDialog.boundingBox();
  expect(appMobileCollaboratorListboxBox?.width).toBeLessThanOrEqual((appMobileDialogBox?.width ?? 0) - 24);
  expect(appMobileCollaboratorListboxBox?.y).toBeGreaterThanOrEqual((appMobileDialogBox?.y ?? 0) + 1);
  expect((appMobileCollaboratorListboxBox?.y ?? 0) + (appMobileCollaboratorListboxBox?.height ?? 0))
    .toBeLessThanOrEqual((appMobileDialogBox?.y ?? 0) + (appMobileDialogBox?.height ?? 0) - 1);
  expect(await detailDialog.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(appMobileModalHeightBeforeSearch, 0);
  expect(await detailDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await captureReviewScreenshot(page, "portal-apps-app-settings-collaborators-search-mobile.png");
  await appMobileCollaboratorInput.press("Escape");
  await appCollaboratorCard.getByRole("button", { name: "Cancel" }).click();
  await page.setViewportSize({ height: 900, width: 1440 });
  const appModalHeightBeforeTargeted = await detailDialog.evaluate((element) => element.getBoundingClientRect().height);
  expect(appModalHeightBeforeTargeted).toBeCloseTo(appDefaultModalBox?.height ?? 0, 0);
  const appFormBoxBeforeTargeted = await appSettingsFormColumn.boundingBox();
  await expect(detailDialog.locator(".appsAccessModeOption")).toHaveCount(3);
  const preTargetedSendingCapabilityCard = appSettingsFormColumn.locator(".appsCapabilityCard").filter({ hasText: "Email Sending capability" });
  await preTargetedSendingCapabilityCard.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await captureReviewScreenshot(page, "portal-apps-app-settings-capabilities-desktop.png");
  await appSettingsFormColumn.locator(".appsAccessConfigSection").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await detailDialog.getByRole("radio", { name: /Specific members/ }).click();
  await expect(appStatusPanel).toHaveCount(0);
  await expect(detailDialog.locator(".assetReviewBody")).toHaveClass(/isTargetedAccessMode/);
  const appAccessPicker = detailDialog.locator(".appsAccessPickerPane");
  await expect(appAccessPicker.locator(".accessTargetPicker")).toBeVisible();
  const appAccessSearch = appAccessPicker.getByPlaceholder("Search departments, names, or emails");
  await expect(appAccessSearch).toBeVisible();
  await expect(appSettingsFormColumn.locator(".appsLlmStatusSection")).toHaveCount(1);
  await expect(appSettingsFormColumn.locator(".appsAppMcpStatusSection")).toHaveCount(1);
  await expect(appSettingsFormColumn.locator(".appsEmailStatusSection")).toHaveCount(2);
  await expect(appSettingsFormColumn.locator(".appsSecretsSection")).toHaveCount(1);
  const appCapabilityCards = appSettingsFormColumn.locator(".appsCapabilityCard");
  await expect(appCapabilityCards).toHaveCount(6);
  const collaboratorsCapabilityCard = appCapabilityCards.filter({ hasText: "Collaborators" });
  const llmCapabilityCard = appCapabilityCards.filter({ hasText: "LLM capability" });
  const sendingCapabilityCard = appCapabilityCards.filter({ hasText: "Email Sending capability" });
  const routingCapabilityCard = appCapabilityCards.filter({ hasText: "Email Routing capability" });
  const secretsCapabilityCard = appCapabilityCards.filter({ hasText: "Secret config" });
  await expect(llmCapabilityCard.locator(".appsCapabilityTitleRow .capabilityStatusText")).toHaveText("Enabled");
  await expect(sendingCapabilityCard.locator(".appsCapabilityTitleRow .capabilityStatusText")).toHaveText("Enabled");
  await expect(routingCapabilityCard.locator(".appsCapabilityTitleRow .capabilityStatusText")).toHaveText("Disabled");
  await expect(secretsCapabilityCard.locator(".appsCapabilityTitleRow .capabilityStatusText")).toHaveText("1 / 1 configured");
  await expect(appCapabilityCards.locator(".appsCapabilityMark")).toHaveCount(6);
  await expect(collaboratorsCapabilityCard.locator(".appsCapabilityTitleRow .capabilityStatusText")).toHaveText("1 collaborator");
  // Infrastructure is managed in the App resource view, outside access settings.
  await expect(appCapabilityCards.filter({ hasText: "App resources" })).toHaveCount(0);
  await expect(appCapabilityCards.locator(".appsCapabilityControls .capabilityStatusText")).toHaveCount(0);
  await expect(sendingCapabilityCard.locator(".appsCapabilityDetails")).toContainText("risk-review@mail.example.invalid");
  await expect(secretsCapabilityCard.locator(".appsSecretRow .capabilityStatusText")).toHaveText("Configured");
  const routingEnableButton = routingCapabilityCard.getByRole("button", { name: "Enable" });
  await expect(routingEnableButton).toHaveCSS("background-color", "rgb(17, 17, 15)");
  await routingEnableButton.click();
  await expect(routingCapabilityCard.locator(".appsCapabilitySetupForm")).toBeVisible();
  await routingCapabilityCard.getByRole("button", { name: "Cancel" }).click();
  await expect(routingCapabilityCard.locator(".appsCapabilitySetupForm")).toHaveCount(0);
  await expect(appAccessPicker.locator(".assetDetailSection")).toHaveCount(0);
  await expect(appSettingsFormColumn).toHaveCSS("overflow-y", "auto");
  await expect(appAccessPicker.locator(".accessTargetPickerTree")).toHaveCSS("overflow-y", "auto");
  const appFormScrollMetrics = await appSettingsFormColumn.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(appFormScrollMetrics.scrollHeight).toBeGreaterThan(appFormScrollMetrics.clientHeight);
  const appFormBox = await appSettingsFormColumn.boundingBox();
  const appPickerBox = await appAccessPicker.boundingBox();
  const appExpandedModalBox = await detailDialog.boundingBox();
  expect(Math.abs((appFormBox?.width ?? 0) - (appFormBoxBeforeTargeted?.width ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((appFormBox?.height ?? 0) - (appFormBoxBeforeTargeted?.height ?? 0))).toBeLessThanOrEqual(1);
  expect(appPickerBox?.width).toBeCloseTo(380, 0);
  expect((appExpandedModalBox?.width ?? 0) - (appDefaultModalBox?.width ?? 0)).toBeCloseTo(396, 0);
  expect(appExpandedModalBox?.height).toBeCloseTo(appModalHeightBeforeTargeted, 0);
  expect(appPickerBox?.x).toBeGreaterThan((appFormBox?.x ?? 0) + (appFormBox?.width ?? 0) - 2);
  const ghTargetLine = appAccessPicker.locator(".accessTargetPickerLine").filter({ hasText: "GH" });
  await ghTargetLine.locator(".accessTargetPickerExpandButton").click();
  const appFormBoxAfterTreeExpansion = await appSettingsFormColumn.boundingBox();
  expect(Math.abs((appFormBoxAfterTreeExpansion?.width ?? 0) - (appFormBox?.width ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((appFormBoxAfterTreeExpansion?.height ?? 0) - (appFormBox?.height ?? 0))).toBeLessThanOrEqual(1);
  const appTargetedBounds = await detailDialog.evaluate((dialog) => {
    const picker = dialog.querySelector<HTMLElement>(".appsAccessPickerPane");
    const workspace = dialog.querySelector<HTMLElement>(".appsAccessSettingsWorkspace.withAccessPicker");
    const dialogBox = dialog.getBoundingClientRect();
    const pickerBox = picker?.getBoundingClientRect();
    const workspaceBox = workspace?.getBoundingClientRect();
    return {
      dialogBottom: dialogBox.bottom,
      dialogHeight: dialogBox.height,
      pickerBottom: pickerBox?.bottom ?? Number.POSITIVE_INFINITY,
      pickerHeight: pickerBox?.height ?? Number.POSITIVE_INFINITY,
      workspaceBottom: workspaceBox?.bottom ?? Number.POSITIVE_INFINITY
    };
  });
  expect(appTargetedBounds.dialogHeight).toBeLessThanOrEqual(appModalHeightBeforeTargeted + 1);
  expect(appTargetedBounds.dialogHeight).toBeLessThanOrEqual((page.viewportSize()?.height ?? 720) - 47);
  expect(appTargetedBounds.workspaceBottom).toBeLessThanOrEqual(appTargetedBounds.dialogBottom + 1);
  expect(appTargetedBounds.pickerBottom).toBeLessThanOrEqual(appTargetedBounds.dialogBottom + 1);
  expect(appTargetedBounds.pickerHeight).toBeLessThanOrEqual(appTargetedBounds.dialogHeight + 1);
  await appAccessSearch.fill("Ada");
  await appAccessPicker.locator(".accessTargetPickerLine").filter({ hasText: "Ada" }).getByRole("checkbox").click();
  await appAccessSearch.fill("");
  await ghTargetLine.getByRole("checkbox").click();
  const appSelectedTargets = appAccessMain.locator(".accessTargetSelectedTags");
  const appSelectedUser = appSelectedTargets.locator(".accessTargetSelectedTag.user");
  const appSelectedDepartment = appSelectedTargets.locator(".accessTargetSelectedTag.department");
  await expect(appSelectedTargets.locator(".accessTargetSelectedTag")).toHaveCount(2);
  await expect(appSelectedUser).toContainText("Ada");
  await expect(appSelectedDepartment).toContainText("GH");
  await expect(appSelectedUser).toHaveCSS("border-left-color", "rgb(160, 106, 32)");
  await expect(appSelectedUser).toHaveCSS("background-color", "rgb(255, 250, 240)");
  await expect(appSelectedUser.locator("svg").first()).toHaveCSS("color", "rgb(160, 106, 32)");
  await expect(appSelectedDepartment).toHaveCSS("border-left-color", "rgb(39, 112, 78)");
  await expect(appSelectedDepartment.locator("svg").first()).toHaveCSS("color", "rgb(39, 112, 78)");
  const appSelectedTargetsBox = await appSelectedTargets.boundingBox();
  const appSelectedUserBox = await appSelectedUser.boundingBox();
  const appSelectedDepartmentBox = await appSelectedDepartment.boundingBox();
  expect(Math.abs((appSelectedUserBox?.y ?? 0) - (appSelectedDepartmentBox?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((appSelectedUserBox?.width ?? 0) - (appSelectedDepartmentBox?.width ?? 0))).toBeLessThanOrEqual(1);
  expect(appSelectedUserBox?.width).toBeLessThan((appSelectedTargetsBox?.width ?? 0) * 0.55);
  await appSelectedTargets.scrollIntoViewIfNeeded();
  await captureReviewScreenshot(page, "portal-apps-app-settings-targets-desktop.png");
  await appSelectedUser.click();
  await expect(appSelectedTargets.locator(".accessTargetSelectedTag")).toHaveCount(1);
  await appAccessMain.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => savedAppAccess).toEqual({
    accessTargets: ["department:dept-gh"],
    loginRequired: true,
    visibility: "team"
  });
  await expect(appAccessMain.getByRole("button", { name: "Save settings" })).toBeEnabled();
  await expect(detailDialog.locator(".appsAccessPickerPane")).toHaveCount(0);
  expect((await detailDialog.boundingBox())?.width).toBeCloseTo(appDefaultModalBox?.width ?? 0, 0);
  await captureReviewScreenshot(page, "portal-apps-app-settings-targeted-desktop.png");

  await detailDialog.getByRole("radio", { name: /Company-wide/ }).click();
  await expect(detailDialog.locator(".appsAccessPickerPane")).toHaveCount(0);
  await expect(appStatusPanel).toHaveCount(0);
  await expect(detailDialog.locator(".assetReviewBody")).not.toHaveClass(/isTargetedAccessMode/);

  await detailDialog.getByRole("tab", { name: "Basic info" }).click();
  expect((await detailDialog.boundingBox())?.height).toBeCloseTo(appDefaultModalBox?.height ?? 0, 0);
  await expect(detailDialog.getByRole("button", { name: "Delete App" })).toHaveCount(0);
  await detailDialog.getByRole("button", { exact: true, name: "Edit" }).click();
  await expect(detailDialog.locator(".appsBasicInfoSection")).toHaveCount(0);
  await expect(detailDialog.getByRole("heading", { level: 3, name: "Edit info" })).toBeVisible();
  await expect(detailDialog.getByRole("button", { exact: true, name: "Save" })).toBeVisible();
  await expect(detailDialog.getByRole("button", { name: "Delete App" })).toBeVisible();
  const appBasicEditScrollMetrics = await appBasicScroller.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(appBasicEditScrollMetrics.scrollHeight).toBeGreaterThan(appBasicEditScrollMetrics.clientHeight);
  const appBasicEditFooterY = (await appBasicFooter.boundingBox())?.y ?? 0;
  await appBasicScroller.hover();
  await page.mouse.wheel(0, 420);
  await expect.poll(() => appBasicScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect((await appBasicFooter.boundingBox())?.y ?? 0).toBeCloseTo(appBasicEditFooterY, 0);
  await appBasicScroller.evaluate((element) => { element.scrollTop = 0; });
  await captureReviewScreenshot(page, "portal-apps-app-basic-edit-desktop.png");
  await detailDialog.getByRole("button", { exact: true, name: "Cancel" }).click();
  await expect(detailDialog.getByRole("button", { name: "Delete App" })).toHaveCount(0);
  await detailDialog.getByRole("tab", { name: "Deployment history" }).click();
  expect((await detailDialog.boundingBox())?.height).toBeCloseTo(appDefaultModalBox?.height ?? 0, 0);
  const appHistoryItems = detailDialog.locator(".appsHistoryItem");
  await expect(detailDialog.getByRole("heading", { level: 3, name: "Release and deployment history" })).toBeVisible();
  await expect(appHistoryItems).toHaveCount(2);
  await expect(appHistoryItems.locator(".appsHistoryEventLabel")).toHaveText(["Published to Community", "Contract Risk Review owner permission management"]);
  await expect(appHistoryItems.locator(".appsHistoryEventMeta code")).toHaveText(["listing-apps-app-risk-review", "2026.07.09"]);
  await expect(appHistoryItems.getByText("Version name", { exact: true })).toHaveCount(0);
  await expect(appHistoryItems.locator(".appsHistoryEventLabel").first()).toHaveCSS("font-size", "14px");
  await expect(appHistoryItems.locator(".appsHistoryEventMeta code").first()).toHaveCSS("font-size", "12px");
  await expect(appHistoryItems.locator(".appsHistoryEventTime strong").first()).toHaveCSS("font-size", "12px");
  expect(await detailDialog.locator(".appsHistorySection").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await appHistoryItems.evaluateAll((items) => items.every((item) => {
    const itemBox = item.getBoundingClientRect();
    const contentBottom = Math.max(...Array.from(item.children).map((child) => child.getBoundingClientRect().bottom));
    return contentBottom <= itemBox.bottom + 1;
  }))).toBe(true);
  await captureReviewScreenshot(page, "portal-apps-app-deployment-history-desktop.png");
  await detailDialog.getByRole("button", { name: "Close" }).click();

  const riskReviewSkillRow = page.locator(".appsProductRow").filter({ hasText: "Risk Review Skill" });
  await riskReviewSkillRow.click();
  const skillDetailDialog = page.getByRole("dialog", { name: "Risk Review Skill details" });
  await expect(skillDetailDialog).toBeVisible();
  const skillDefaultModalBox = await skillDetailDialog.boundingBox();
  expect(skillDefaultModalBox?.width).toBeCloseTo(appDefaultModalBox?.width ?? 0, 0);
  expect(skillDefaultModalBox?.height).toBeCloseTo(appDefaultModalBox?.height ?? 0, 0);
  await expect(skillDetailDialog.locator(".assetReviewFormPanel")).toHaveCount(0);
  await expect(skillDetailDialog.getByRole("tab", { name: "Publish to Community" })).toBeVisible();
  await expect(skillDetailDialog.locator(".appsProgressRailItem")).toHaveCount(3);
  await expect(skillDetailDialog.locator(".appsProgressRailItem.ready")).toHaveCount(3);
  await expect(skillDetailDialog.locator(".appsProgressStepNumber")).toHaveText(["1", "2", "3"]);
  await expect(skillDetailDialog.locator(".appsProgressStepCheck, .appsProgressSummary, .appsProgressSegments")).toHaveCount(0);
  await expect(skillDetailDialog.locator(".appsBasicInfoTags b")).toHaveText(["review", "risk"]);
  const skillBasicScroller = skillDetailDialog.locator(".appsDetailTabScroll");
  const skillBasicInfo = skillDetailDialog.locator(".appsBasicInfoSection");
  const skillFileStructure = skillDetailDialog.locator(".appsSkillStructureSection");
  await expect.poll(() => skillBasicScroller.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(skillBasicInfo).toBeVisible();
  await expect(skillBasicInfo).toContainText("Risk Review Skill");
  await expect(skillBasicInfo).toContainText("risk-review-skill");
  await expect(skillBasicInfo).toContainText("1.0.0");
  await expect(skillDetailDialog.getByRole("heading", { level: 3, name: "File structure" })).toBeVisible();
  await expect(skillDetailDialog.getByText("Project structure", { exact: true })).toHaveCount(0);
  await expect(skillFileStructure.locator(".appsSkillStructureSummary strong")).toHaveText(["1.0.0", "10", "120 KB"]);
  await expect(skillFileStructure.locator(".appsSkillStructureGroup")).toHaveCount(2);
  await expect(skillFileStructure.locator(".appsSkillFileRow")).toHaveCount(8);
  await expect(skillFileStructure.locator(".appsSkillFileMore")).toHaveText("2 more files");
  await expect(skillFileStructure.getByRole("heading", { level: 3, name: "File structure" })).toHaveCSS("font-size", "14px");
  await expect(skillFileStructure.locator(".appsSkillFileRow").first()).toHaveCSS("font-size", "11px");
  expect(await skillDetailDialog.evaluate((dialog) => {
    const basic = dialog.querySelector(".appsBasicInfoSection");
    const structure = dialog.querySelector(".appsSkillStructureSection");
    return Boolean(basic && structure && (basic.compareDocumentPosition(structure) & Node.DOCUMENT_POSITION_FOLLOWING));
  })).toBe(true);
  await captureReviewScreenshot(page, "portal-apps-skill-detail-desktop.png");

  await skillFileStructure.scrollIntoViewIfNeeded();
  await captureReviewScreenshot(page, "portal-apps-skill-file-structure-desktop.png");
  await skillBasicScroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => skillBasicScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await skillDetailDialog.getByRole("button", { exact: true, name: "Edit" }).click();
  await expect.poll(() => skillBasicScroller.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(skillDetailDialog.getByRole("heading", { level: 3, name: "Edit Skill meta" })).toBeVisible();
  await skillDetailDialog.getByRole("button", { exact: true, name: "Cancel" }).click();
  await expect.poll(() => skillBasicScroller.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(skillBasicInfo).toBeVisible();

  await skillBasicScroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await skillDetailDialog.getByRole("tab", { name: "Deployment history" }).click();
  await expect.poll(() => skillBasicScroller.evaluate((element) => element.scrollTop)).toBe(0);
  const skillHistoryItems = skillDetailDialog.locator(".appsHistoryItem");
  await expect(skillHistoryItems).toHaveCount(2);
  await expect(skillHistoryItems.locator(".appsHistoryEventLabel")).toHaveText(["Published to Community", "Skill version"]);
  await expect(skillHistoryItems.locator(".appsHistoryEventMeta code")).toHaveText(["listing-apps-skill-risk-review", "1.0.0"]);
  await expect(skillHistoryItems.locator(".appsHistoryEventLabel").first()).toHaveCSS("font-size", "14px");
  await captureReviewScreenshot(page, "portal-apps-skill-deployment-history-desktop.png");
  await skillDetailDialog.getByRole("tab", { name: "Basic info" }).click();
  await expect.poll(() => skillBasicScroller.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(skillBasicInfo).toBeVisible();

  await skillDetailDialog.getByRole("tab", { name: "Settings" }).click();
  const skillSettingsFormColumn = skillDetailDialog.locator(".appsAccessSettingsFormColumn");
  const skillFormBoxBeforeTargeted = await skillSettingsFormColumn.boundingBox();
  await expect(skillDetailDialog.locator(".assetReviewFormPanel")).toHaveCount(0);
  await expect(skillDetailDialog.locator(".appsAccessPickerPane")).toHaveCount(0);
  await expect(skillDetailDialog.locator(".appsAccessPolicySummary")).toHaveCount(0);
  await expect(skillDetailDialog.locator(".appsAccessModeOption")).toHaveCount(3);
  await expect(skillDetailDialog.getByRole("radio", { name: /Public/ })).toHaveCount(0);
  const skillCollaboratorCard = skillSettingsFormColumn.locator(".appsCollaboratorCard");
  await skillCollaboratorCard.getByRole("button", { exact: true, name: "Manage" }).click();
  const skillCollaboratorPicker = skillCollaboratorCard.locator(".peopleMentionPicker");
  const skillCollaboratorInput = skillCollaboratorPicker.getByRole("combobox", { name: "Choose collaborators" });
  await skillCollaboratorInput.fill("@Bob");
  await skillCollaboratorInput.press("Escape");
  await expect(skillCollaboratorPicker.getByRole("listbox")).toHaveCount(0);
  await skillCollaboratorInput.press("ArrowDown");
  const skillBobOption = skillCollaboratorPicker.getByRole("option", { name: "Bob" });
  await expect(skillBobOption.locator(".peopleMentionAvatar img")).toBeVisible();
  await skillBobOption.click();
  await expect(skillCollaboratorCard.getByRole("button", { name: "Remove collaborator Bob" })).toBeVisible();
  await skillCollaboratorInput.press("Backspace");
  await expect(skillCollaboratorCard.getByRole("button", { name: "Remove collaborator Bob" })).toHaveCount(0);
  await skillCollaboratorInput.fill("@Bob");
  await skillCollaboratorPicker.getByRole("option", { name: "Bob" }).click();
  await skillCollaboratorCard.getByRole("button", { name: "Save collaborators" }).click();
  await expect.poll(() => savedSkillCollaborators).toEqual({ collaboratorUserIds: ["user-bob"] });
  await expect(skillCollaboratorCard.locator(".peopleMentionTag.readOnly")).toContainText("Bob");
  await skillDetailDialog.getByRole("radio", { name: /Specific members/ }).click();
  await expect(skillDetailDialog.locator(".assetReviewFormPanel")).toHaveCount(0);
  await expect(skillDetailDialog.locator(".assetReviewBody")).toHaveClass(/isTargetedAccessMode/);
  const skillAccessPicker = skillDetailDialog.locator(".appsAccessPickerPane");
  await expect(skillAccessPicker.locator(".accessTargetPicker")).toBeVisible();
  const skillFormBox = await skillSettingsFormColumn.boundingBox();
  const skillPickerBox = await skillAccessPicker.boundingBox();
  expect(Math.abs((skillFormBox?.width ?? 0) - (skillFormBoxBeforeTargeted?.width ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((skillFormBox?.height ?? 0) - (skillFormBoxBeforeTargeted?.height ?? 0))).toBeLessThanOrEqual(1);
  expect(skillPickerBox?.width).toBeCloseTo(380, 0);
  await skillAccessPicker.locator(".accessTargetPickerLine").filter({ hasText: "Gentleman" }).getByRole("checkbox").click();
  await skillDetailDialog.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => savedSkillAccess).toEqual({
    accessTargets: ["department:dept-gentleman"],
    loginRequired: true,
    visibility: "team"
  });
  await expect(skillDetailDialog.locator(".appsAccessPickerPane")).toHaveCount(0);
  await captureReviewScreenshot(page, "portal-apps-skill-settings-targeted-desktop.png");

  await skillDetailDialog.getByRole("button", { name: "Edit visible targets" }).click();
  await expect(skillDetailDialog.locator(".appsAccessPickerPane")).toBeVisible();

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(skillDetailDialog).toBeVisible();
  await expect(skillDetailDialog.locator(".appsAccessSettingsWorkspace.withAccessPicker")).toHaveCSS("grid-template-columns", /.+/);
  const mobileSkillMainBox = await skillDetailDialog.locator(".appsAccessSettingsFormColumn").boundingBox();
  const mobileSkillPickerBox = await skillDetailDialog.locator(".appsAccessPickerPane").boundingBox();
  expect(mobileSkillPickerBox?.x).toBeCloseTo(mobileSkillMainBox?.x ?? 0, 0);
  expect(mobileSkillPickerBox?.y).toBeCloseTo(mobileSkillMainBox?.y ?? 0, 0);
  expect(mobileSkillPickerBox?.height).toBeCloseTo(mobileSkillMainBox?.height ?? 0, 0);
  expect(await skillDetailDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await captureReviewScreenshot(page, "portal-apps-skill-settings-targeted-mobile.png");
  await skillDetailDialog.getByRole("tab", { name: "Deployment history" }).click();
  await expect(skillDetailDialog.locator(".appsAccessPickerPane")).toHaveCount(0);
  await expect(skillDetailDialog.locator(".appsHistoryItem")).toHaveCount(2);
  const mobileHistoryCopyBox = await skillDetailDialog.locator(".appsHistoryEventCopy").first().boundingBox();
  const mobileHistoryTimeBox = await skillDetailDialog.locator(".appsHistoryEventTime").first().boundingBox();
  expect(mobileHistoryTimeBox?.y).toBeGreaterThan((mobileHistoryCopyBox?.y ?? 0) + (mobileHistoryCopyBox?.height ?? 0) - 2);
  expect(await skillDetailDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await captureReviewScreenshot(page, "portal-apps-skill-deployment-history-mobile.png");
  await skillDetailDialog.getByRole("button", { name: "Close" }).click();
  await page.setViewportSize({ height: 900, width: 1440 });

  await page.getByRole("button", { exact: true, name: "NEW APPS" }).click();
  await page.getByRole("menuitem", { name: /App/ }).click();
  const createDialog = page.getByRole("dialog", { name: "Create APPS app" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByRole("radio")).toHaveCount(5);
  await expect(createDialog.getByRole("heading", { level: 3, name: "Creation template" })).toBeVisible();
  await expect(createDialog.getByText("A template only presets the runtime entry and resources at creation. Afterward, add resources in Settings; added resources cannot be removed.", { exact: true })).toBeVisible();
  expect((await createDialog.boundingBox())?.width).toBeCloseTo(appDefaultModalBox?.width ?? 0, 0);
  await createDialog.getByRole("button", { name: "Page visibility" }).click();
  await page.getByRole("option", { name: /Specific members/ }).click();
  const createAccessPicker = createDialog.locator(".appsCreateAccessPickerPane");
  const createAccessSearch = createAccessPicker.getByPlaceholder("Search departments, names, or emails");
  await expect(createAccessPicker).toBeVisible();
  await createAccessSearch.fill("Ada");
  await createAccessPicker.locator(".accessTargetPickerLine").filter({ hasText: "Ada" }).getByRole("checkbox").click();
  await createAccessSearch.fill("");
  await createAccessPicker.locator(".accessTargetPickerLine").filter({ hasText: "GH" }).getByRole("checkbox").click();
  const createSelectedTargets = createDialog.locator(".appsAccessTargetSummaryPanel .accessTargetSelectedTags");
  const createSelectedUser = createSelectedTargets.locator(".accessTargetSelectedTag.user");
  const createSelectedDepartment = createSelectedTargets.locator(".accessTargetSelectedTag.department");
  await expect(createSelectedTargets.locator(".accessTargetSelectedTag")).toHaveCount(2);
  await expect(createSelectedUser).toHaveCSS("border-left-color", "rgb(160, 106, 32)");
  await expect(createSelectedDepartment).toHaveCSS("border-left-color", "rgb(39, 112, 78)");
  const createSelectedTargetsBox = await createSelectedTargets.boundingBox();
  const createSelectedUserBox = await createSelectedUser.boundingBox();
  const createSelectedDepartmentBox = await createSelectedDepartment.boundingBox();
  expect(Math.abs((createSelectedUserBox?.y ?? 0) - (createSelectedDepartmentBox?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((createSelectedUserBox?.width ?? 0) - (createSelectedDepartmentBox?.width ?? 0))).toBeLessThanOrEqual(1);
  expect(createSelectedUserBox?.width).toBeLessThan((createSelectedTargetsBox?.width ?? 0) * 0.55);
  await createSelectedTargets.scrollIntoViewIfNeeded();
  await captureReviewScreenshot(page, "portal-apps-create-desktop.png");
  await page.setViewportSize({ height: 844, width: 390 });
  await createSelectedTargets.scrollIntoViewIfNeeded();
  const createMobileUserBox = await createSelectedUser.boundingBox();
  const createMobileDepartmentBox = await createSelectedDepartment.boundingBox();
  expect(createMobileDepartmentBox?.y).toBeGreaterThan((createMobileUserBox?.y ?? 0) + (createMobileUserBox?.height ?? 0) - 2);
  expect(await createDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await captureReviewScreenshot(page, "portal-apps-create-targeted-mobile.png");
  await page.setViewportSize({ height: 900, width: 1440 });
  await createDialog.getByRole("button", { name: "Close" }).click();

  await testInfo.attach("apps-desktop", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png"
  });
  await captureReviewScreenshot(page, "portal-apps-desktop.png");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.waitForTimeout(250);
  await expect(page.locator(".portal-apps-surface")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await testInfo.attach("apps-mobile", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png"
  });
  await captureReviewScreenshot(page, "portal-apps-mobile.png");

  appFixture = {
    ...appFixture,
    collaboratorUserIds: ["local-dev-admin"],
    ownerTeamId: "Legal AI",
    ownerUserId: "remote-app-owner"
  };
  skillFixture = {
    ...skillFixture,
    collaboratorUserIds: ["local-dev-admin"],
    ownerUserId: "remote-skill-owner"
  };
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.reload();
  await expect(page.locator(".appsProductRow")).toHaveCount(2);

  const coauthoredAppRow = page.locator(".appsProductRow").filter({ hasText: "Contract Risk Review" });
  const coauthoredSkillRow = page.locator(".appsProductRow").filter({ hasText: "Risk Review Skill" });
  await expect(coauthoredAppRow.locator(".appsAuthorAvatar")).toHaveCount(2);
  await expect(coauthoredAppRow.locator(".appsAuthorGroup")).toHaveAttribute("aria-label", "Authors: Remote App Owner, Local Admin");
  await expect(coauthoredSkillRow.locator(".appsAuthorAvatar")).toHaveCount(2);
  await expect(coauthoredSkillRow.locator(".appsAuthorGroup")).toHaveAttribute("aria-label", "Authors: Remote Skill Owner, Local Admin");
  await captureReviewScreenshot(page, "portal-apps-coauthor-list-desktop.png");

  await contractRiskReviewRow.click();
  await expect(detailDialog).toBeVisible();
  await expect(detailDialog.locator(".assetReviewHero .appsAuthorAvatar")).toHaveCount(2);
  await expect(detailDialog.locator(".assetReviewHero .appsAuthorGroup")).toHaveAttribute("aria-label", "Authors: Remote App Owner, Local Admin");
  await expect(detailDialog.getByRole("tab", { name: "Settings" })).toBeVisible();
  await expect(detailDialog.getByRole("tab", { name: "Publish to Community" })).toBeVisible();
  await expect(detailDialog.getByRole("button", { exact: true, name: "Edit" })).toBeVisible();
  await expect(detailDialog.getByRole("button", { name: "Delete App" })).toHaveCount(0);
  const coauthorHandoffButton = detailDialog.getByRole("button", { name: "Copy Handoff to Agent" });
  await expect(coauthorHandoffButton).toBeVisible();
  await expect(detailDialog.getByRole("link", { name: "Open production" })).toBeVisible();

  await coauthorHandoffButton.click();
  await detailDialog.getByRole("menuitem", { name: /Copy environment info/ }).click();
  await expect.poll(() => handoffRequestCount).toBe(2);
  const coauthorCopiedHandoffDialog = page.getByRole("dialog", { name: "Copied" });
  await expect(coauthorCopiedHandoffDialog).toBeVisible();
  await coauthorCopiedHandoffDialog.getByRole("button", { name: "Got it" }).click();

  await detailDialog.getByRole("button", { exact: true, name: "Edit" }).click();
  await expect(detailDialog.getByRole("button", { name: "Delete App" })).toBeVisible();
  await expect(detailDialog.getByRole("button", { exact: true, name: "Save" })).toBeVisible();
  await detailDialog.getByLabel("Notes").fill("Updated by a APPS co-author.");
  await detailDialog.getByRole("button", { exact: true, name: "Save" }).click();
  await expect.poll(() => coauthorAppInfo).toEqual({
    description: "Updated by a APPS co-author.",
    name: "Contract Risk Review"
  });
  await expect(detailDialog.getByRole("button", { exact: true, name: "Edit" })).toBeVisible();
  await expect(detailDialog.getByRole("button", { name: "Delete App" })).toHaveCount(0);

  await detailDialog.getByRole("tab", { name: "Settings" }).click();
  const coauthorAppCollaboratorCard = detailDialog.locator(".appsCollaboratorCard");
  await coauthorAppCollaboratorCard.getByRole("button", { exact: true, name: "Manage" }).click();
  const coauthorAppCollaboratorInput = coauthorAppCollaboratorCard.getByRole("combobox", { name: "Choose collaborators" });
  await coauthorAppCollaboratorInput.fill("@Ada");
  await coauthorAppCollaboratorCard.getByRole("option", { name: "Ada" }).click();
  await coauthorAppCollaboratorCard.getByRole("button", { name: "Save collaborators" }).click();
  await expect.poll(() => coauthorAppCollaborators).toEqual({ collaboratorUserIds: ["local-dev-admin", "user-ada"] });
  await expect(coauthorAppCollaboratorCard.locator(".peopleMentionTag.readOnly")).toHaveCount(2);

  await detailDialog.getByRole("tab", { name: "Publish to Community" }).click();
  await expect(detailDialog.locator(".appsPublishReadOnlyGrid")).toHaveCount(3);
  await expect(detailDialog.getByText("Listed", { exact: true }).first()).toBeVisible();
  await detailDialog.getByRole("button", { exact: true, name: "Edit" }).click();
  await detailDialog.getByLabel("One-line summary").fill("Updated community summary by a co-author.");
  await detailDialog.getByRole("button", { exact: true, name: "Save" }).click();
  await expect.poll(() => coauthorAppSubmission?.summary).toBe("Updated community summary by a co-author.");
  expect(coauthorAppSubmission).toMatchObject({
    targetId: "apps-app-risk-review",
    targetPlane: "apps",
    targetType: "app"
  });
  await expect(detailDialog.getByRole("button", { exact: true, name: "Edit" })).toBeVisible();
  await captureReviewScreenshot(page, "portal-apps-app-collaborator-coauthor-desktop.png");
  await detailDialog.getByRole("button", { name: "Close" }).click();

  await riskReviewSkillRow.click();
  await expect(skillDetailDialog).toBeVisible();
  await expect(skillDetailDialog.locator(".assetReviewHero .appsAuthorAvatar")).toHaveCount(2);
  await expect(skillDetailDialog.getByRole("tab", { name: "Settings" })).toBeVisible();
  await expect(skillDetailDialog.getByRole("tab", { name: "Publish to Community" })).toBeVisible();
  await expect(skillDetailDialog.getByRole("button", { exact: true, name: "Edit" })).toBeVisible();
  await expect(skillDetailDialog.getByRole("button", { name: "Delete Skill" })).toHaveCount(0);
  await skillDetailDialog.getByRole("button", { exact: true, name: "Edit" }).click();
  await expect(skillDetailDialog.getByRole("button", { name: "Delete Skill" })).toBeVisible();
  await skillDetailDialog.getByLabel("Description").fill("Updated by a Skill co-author.");
  await skillDetailDialog.getByRole("button", { exact: true, name: "Save" }).click();
  await expect.poll(() => coauthorSkillInfo).toEqual({
    capabilities: ["review", "risk"],
    description: "Updated by a Skill co-author.",
    kind: "vanilla",
    name: "Risk Review Skill",
    slug: "risk-review-skill"
  });
  await expect(skillDetailDialog.getByRole("button", { name: "Delete Skill" })).toHaveCount(0);

  await skillDetailDialog.getByRole("tab", { name: "Settings" }).click();
  const coauthorSkillCollaboratorCard = skillDetailDialog.locator(".appsCollaboratorCard");
  await coauthorSkillCollaboratorCard.getByRole("button", { exact: true, name: "Manage" }).click();
  const coauthorSkillCollaboratorInput = coauthorSkillCollaboratorCard.getByRole("combobox", { name: "Choose collaborators" });
  await coauthorSkillCollaboratorInput.fill("@Bob");
  await coauthorSkillCollaboratorCard.getByRole("option", { name: "Bob" }).click();
  await coauthorSkillCollaboratorCard.getByRole("button", { name: "Save collaborators" }).click();
  await expect.poll(() => coauthorSkillCollaborators).toEqual({ collaboratorUserIds: ["local-dev-admin", "user-bob"] });
  await expect(coauthorSkillCollaboratorCard.locator(".peopleMentionTag.readOnly")).toHaveCount(2);

  await skillDetailDialog.getByRole("tab", { name: "Publish to Community" }).click();
  await skillDetailDialog.getByRole("button", { exact: true, name: "Edit" }).click();
  await skillDetailDialog.getByLabel("Description").fill("Community update by a Skill co-author.");
  await skillDetailDialog.getByRole("button", { exact: true, name: "Save" }).click();
  await expect.poll(() => coauthorSkillSubmission?.description).toBe("Community update by a Skill co-author.");
  expect(coauthorSkillSubmission).toMatchObject({
    targetId: "apps-skill-risk-review",
    targetPlane: "apps",
    targetType: "skill"
  });

  await skillDetailDialog.getByRole("tab", { name: "Basic info" }).click();
  await skillDetailDialog.getByRole("button", { exact: true, name: "Edit" }).click();
  await skillDetailDialog.getByRole("button", { name: "Delete Skill" }).click();
  await skillDetailDialog.getByLabel("Enter Skill Slug").fill("risk-review-skill");
  await skillDetailDialog.getByRole("button", { name: "Delete Skill permanently" }).click();
  await expect.poll(() => coauthorDeleteRequests).toEqual([{
    method: "DELETE",
    target: "listing"
  }, {
    body: { slug: "risk-review-skill" },
    method: "DELETE",
    target: "skill"
  }]);
  await expect(skillDetailDialog).toBeHidden();
});

test("runs Gateway Administration as a native Portal LiteLLM control surface", async ({ page }, testInfo) => {
  const source = {
    endpoints: ["/key/list", "/user/list", "/spend/logs", "/v1/model/info"],
    fetchedAt: "2026-07-12T05:00:00.000Z",
    mode: "admin-api",
    provider: "litellm",
    range: { from: "2026-07-01", to: "2026-07-12" }
  };
  let tokenUpdateCount = 0;

  await page.route("**/api/llm-gateway/admin/allocations", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        gatewayUrl: "https://token.example.invalid",
        modelOptions: [{ id: "gpt-5.5", displayName: "GPT-5.5" }],
        source,
        tokens: [{
          accessStatus: "active",
          allowedModels: ["gpt-5.5"],
          createdAt: "2026-07-01T00:00:00.000Z",
          externalUserId: "ada@example.com",
          id: "hash-1",
          lastUsedAt: "2026-07-12T04:00:00.000Z",
          monthlyBudgetUsd: 25,
          name: "Production key",
          requestLimitPerMinute: 60,
          status: "active",
          tokenLast4: "0001",
          tokenPrefix: "hash-prod",
          tokensPerMinute: 120000
        }],
        usage: [{
          billableUnits: 480,
          blockedRequests: 0,
          estimatedCostUsd: 0.42,
          failedRequests: 0,
          id: "token-usage",
          inputTokens: 320,
          outputTokens: 160,
          reasoningOutputTokens: 0,
          requests: 2,
          scopeId: "hash-1",
          scopeType: "token"
        }, {
          billableUnits: 480,
          blockedRequests: 0,
          estimatedCostUsd: 0.42,
          failedRequests: 0,
          id: "user-usage",
          inputTokens: 320,
          outputTokens: 160,
          reasoningOutputTokens: 0,
          requests: 2,
          scopeId: "ada@example.com",
          scopeType: "user"
        }],
        userLimits: [{
          allowedModels: ["gpt-5.5"],
          id: "litellm:user:ada@example.com",
          monthlyBudgetUsd: 100,
          requestLimitPerMinute: 120,
          status: "active",
          tokensPerMinute: 240000,
          userId: "ada@example.com"
        }]
      }
    });
  });
  await page.route("**/api/llm-gateway/admin/usage?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        requestTotal: 2,
        requests: [{
          billable_units: 240,
          created_at: "2026-07-12T04:00:00.000Z",
          estimated_cost_usd: 0.21,
          external_user_id: "ada@example.com",
          id: "req-1",
          model: "gpt-5.5",
          provider: "openai",
          request_id: "req-1",
          status: "completed",
          token_id: "hash-1"
        }],
        series: [{
          billableUnits: 480,
          blockedRequests: 0,
          estimatedCostUsd: 0.42,
          failedRequests: 0,
          groupId: "gpt-5.5",
          groupType: "model",
          inputTokens: 320,
          outputTokens: 160,
          periodStart: "2026-07-12 00:00:00",
          reasoningOutputTokens: 0,
          requests: 2
        }],
        source,
        tokens: [],
        usage: []
      }
    });
  });
  await page.route("**/api/llm-gateway/admin/tokens/**", async (route) => {
    if (route.request().method() === "PATCH") {
      tokenUpdateCount += 1;
    }
    await route.fulfill({ contentType: "application/json", json: { ok: true } });
  });

  await page.goto("/#/home");

  const adminEntry = page.getByRole("button", { name: "Switch to administration" });
  await expect(adminEntry).toBeVisible();
  await expect(adminEntry).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(adminEntry).toHaveCSS("border-color", "rgb(17, 17, 15)");
  const adminEntryBox = await adminEntry.boundingBox();
  expect(adminEntryBox).not.toBeNull();
  await expect(page.getByRole("button", { name: "Gateway Administration" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New post" })).toBeVisible();
  await captureReviewScreenshot(page, "portal-admin-entry-desktop.png");
  await adminEntry.click();

  await expect(page.getByRole("heading", { level: 1, name: "Gateway Administration" })).toBeVisible();
  await expect(page.getByText("LiteLLM", { exact: true })).toBeVisible();
  await expect(page.locator(".portal-shell")).toHaveClass(/admin-mode/);
  await expect(page.locator(".portal-live-rail")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New post" })).toHaveCount(0);
  await expect(page.locator(".portal-left-rail .portal-brand strong")).toHaveText("Frontier Workspace");
  await expect(page.locator(".portal-left-rail .portal-brand small")).toHaveText("Administration");
  const adminExit = page.getByRole("button", { name: "Back to Playground" });
  await expect(adminExit).toBeVisible();
  const adminExitBox = await adminExit.boundingBox();
  expect(adminExitBox).not.toBeNull();
  expect(adminExitBox?.width).toBe(adminEntryBox?.width);
  expect(adminExitBox?.height).toBe(adminEntryBox?.height);
  await expect(page.locator(".portal-left-rail")).toHaveCSS("background-color", "rgb(17, 17, 15)");
  await expect(page.locator(".gatewayAdminPanel, .adminPage")).toHaveCount(0);
  await expect(page.locator(".portal-admin-table tbody tr")).toHaveCount(1);
  await captureReviewScreenshot(page, "portal-admin-token-desktop.png");

  await adminExit.click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator(".portal-shell")).not.toHaveClass(/admin-mode/);
  await page.getByRole("button", { name: "Switch to administration" }).click();
  await expect(page.locator(".portal-admin-table tbody tr")).toHaveCount(1);

  const manageTokenButton = page.getByRole("button", { name: "Manage token: Production key" });
  await expect(manageTokenButton).toHaveText("");
  await expect(manageTokenButton).toHaveCSS("width", "30px");
  await manageTokenButton.click();
  const tokenDialog = page.getByRole("dialog", { name: "Manage token: Production key" });
  await expect(tokenDialog).toBeVisible();
  await captureReviewScreenshot(page, "portal-admin-token-dialog.png");
  await tokenDialog.getByLabel("Key name").fill("Production key updated");
  await tokenDialog.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => tokenUpdateCount).toBe(1);
  await expect(tokenDialog).toHaveCount(0);

  await page.getByRole("button", { exact: true, name: "User allocations" }).click();
  await expect(page).toHaveURL(/#\/admin\/gateway\/allocations$/);
  await expect(page.getByText("ada@example.com", { exact: true })).toBeVisible();
  const manageAllocationButton = page.getByRole("button", { name: "Manage user allocation: ada@example.com" });
  await expect(manageAllocationButton).toHaveText("");
  await expect(manageAllocationButton).toHaveCSS("width", "30px");

  await page.getByRole("button", { exact: true, name: "Usage" }).click();
  await expect(page).toHaveURL(/#\/admin\/gateway\/usage$/);
  await expect(page.getByText("req-1", { exact: true })).toBeVisible();

  await testInfo.attach("admin-gateway-desktop", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png"
  });
  await captureReviewScreenshot(page, "portal-admin-gateway-desktop.png");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await captureReviewScreenshot(page, "portal-admin-gateway-mobile.png");
});

test("runs Model Playground against the unified LiteLLM catalog", async ({ page }, testInfo) => {
  const chatRequests: unknown[] = [];

  await page.route("**/api/llm-gateway/model-catalog", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        gatewayUrl: "https://token.example.invalid",
        catalog: {
          version: "litellm-2026-07",
          source: {
            importedAt: "2026-07-12T06:00:00.000Z",
            importedFrom: "/v1/model/info",
            modelCount: 2,
            provider: "litellm"
          },
          vendors: [
            { displayName: "OpenAI", id: "openai", kind: "cloud", status: "active" },
            { displayName: "Tencent Cloud", id: "tencent", kind: "cloud", status: "active" }
          ],
          models: [
            {
              capabilities: ["chat", "tools"],
              defaultVendor: "openai",
              description: "General reasoning model",
              displayName: "GPT-5.5",
              id: "gpt-5.5",
              limits: { maxCompletionTokens: 32768, maxPromptTokens: 128000 },
              supported: true
            },
            {
              capabilities: ["chat"],
              defaultVendor: "tencent",
              description: "Tencent reasoning model",
              displayName: "Hunyuan T1",
              id: "hunyuan-t1",
              limits: { maxCompletionTokens: 8192, maxPromptTokens: 32768 },
              supported: true
            }
          ]
        }
      }
    });
  });

  await page.route("**/api/llm-gateway/chat", async (route) => {
    chatRequests.push(await route.request().postDataJSON());
    await route.fulfill({
      contentType: "application/json",
      headers: { "x-request-id": "req-playground-e2e" },
      json: {
        choices: [{ finish_reason: "stop", message: { content: "The model test completed successfully." } }],
        id: "chat-e2e-1",
        model: "hunyuan-t1",
        usage: { completion_tokens: 6, prompt_tokens: 14, total_tokens: 20 }
      }
    });
  });

  await page.goto("/#/home");
  await page.getByRole("button", { name: "Switch to administration" }).click();
  await page.getByRole("button", { name: "Model Playground" }).click();

  await expect(page).toHaveURL(/#\/admin\/playground$/);
  await expect(page.getByRole("heading", { level: 1, name: "Model Playground" })).toBeVisible();
  await expect(page.locator(".portal-shell")).toHaveClass(/admin-mode/);
  await expect(page.getByText("/v1/chat/completions", { exact: true })).toBeVisible();
  await expect(page.locator(".portal-playground-model-list > button")).toHaveCount(2);
  await expect(page.locator(".llmGatewayAdmin, .gatewayWorkbench")).toHaveCount(0);

  await page.getByRole("button", { name: /Hunyuan T1/ }).click();
  await page.getByLabel("User message").fill("Run the production readiness check.");
  await page.getByRole("button", { name: "Run test" }).click();

  await expect(page.getByText("The model test completed successfully.", { exact: true })).toBeVisible();
  await expect(page.getByText("req-playground-e2e", { exact: true })).toBeVisible();
  expect(chatRequests).toHaveLength(1);
  expect(chatRequests[0]).toMatchObject({ model: "hunyuan-t1", max_tokens: 512, temperature: 0.7, top_p: 1 });

  await testInfo.attach("model-playground-desktop", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png"
  });
  await captureReviewScreenshot(page, "portal-model-playground-desktop.png");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.waitForTimeout(250);
  await expect(page.locator(".portal-playground-layout")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await captureReviewScreenshot(page, "portal-model-playground-mobile.png");
});

test("opens scheduled model results from Token and shows hover details", async ({ page }) => {
  const runs = Array.from({ length: 12 }, (_, index) => {
    const hour = [1, 4, 7, 10][index % 4];
    const day = 28 + Math.floor(index / 4);
    const scheduledAt = `2026-07-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
    const slotHour = [9, 12, 15, 18][index % 4];
    return {
      id: `run-${index}`,
      scheduledAt,
      slotLocal: `2026-07-${String(day).padStart(2, "0")}T${String(slotHour).padStart(2, "0")}:00`,
      timezone: "Asia/Shanghai",
      status: index === 10 ? "degraded" : "operational",
      modelCount: 5,
      operationalCount: index === 10 ? 4 : 5,
      degradedCount: 0,
      failedCount: index === 10 ? 1 : 0,
      startedAt: scheduledAt,
      completedAt: scheduledAt,
      errorCode: ""
    };
  });
  const modelDefinitions = [
    ["gpt-5", "GPT-5", "openai"],
    ["claude-sonnet", "Claude Sonnet", "anthropic"],
    ["deepseek-v3", "DeepSeek V3", "deepseek"],
    ["qwen-max", "Qwen Max", "qwen"],
    ["kimi-k2", "Kimi K2", "moonshot"]
  ];
  const models = modelDefinitions.map(([id, displayName, vendorId], modelIndex) => ({
    id,
    displayName,
    vendorId,
    uptimePercent: modelIndex === 0 ? 91.67 : 100,
    results: runs.map((run, runIndex) => ({
      runId: run.id,
      modelId: id,
      displayName,
      vendorId,
      status: modelIndex === 0 && runIndex === 10 ? "failed" : "operational",
      latencyMs: 840 + modelIndex * 220 + runIndex * 9,
      httpStatus: modelIndex === 0 && runIndex === 10 ? 503 : 200,
      errorCode: modelIndex === 0 && runIndex === 10 ? "provider_unavailable" : "",
      requestId: `req-${id}-${runIndex}`,
      responseExcerpt: modelIndex === 0 && runIndex === 10 ? "" : "OK",
      testedAt: run.scheduledAt
    }))
  }));

  await page.route("**/api/llm-gateway/model-health**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        generatedAt: "2026-08-01T00:00:00.000Z",
        rangeDays: 30,
        schedule: {
          timezone: "Asia/Shanghai",
          weekdaysOnly: true,
          slots: ["09:00", "12:00", "15:00", "18:00"],
          nextScheduledAt: "2026-08-03T01:00:00.000Z"
        },
        summary: {
          status: "operational",
          latestRunId: "run-11",
          modelCount: 5,
          operationalCount: 5,
          degradedCount: 0,
          failedCount: 0,
          averageLatencyMs: 1324,
          uptimePercent: 98.33,
          lastCheckedAt: runs.at(-1)?.completedAt
        },
        runs,
        models
      }
    });
  });

  await page.setViewportSize({ height: 980, width: 1440 });
  await page.goto("/#/tokens");
  const statusEntry = page.getByRole("button", { name: "Open model service status" });
  await expect(statusEntry).toBeVisible();
  await expect(statusEntry).toContainText("All models are operational");
  await captureReviewScreenshot(page, "portal-token-model-health-entry-desktop.png");
  await statusEntry.click();
  await expect(page).toHaveURL(/#\/tokens$/);
  const statusDialog = page.getByRole("dialog", { name: "Model Service Status" });
  await expect(statusDialog).toBeVisible();
  await expect(statusDialog.getByRole("heading", { level: 2, name: "Model Service Status" })).toBeVisible();
  await expect(page.getByRole("button", { exact: true, name: "Token" })).toHaveAttribute("aria-current", "page");
  await expect(statusDialog.locator(".portal-model-health-grid tbody tr")).toHaveCount(5);
  await expect(statusDialog.locator(".portal-model-health-grid tbody tr").first().locator("td > button")).toHaveCount(12);

  const failedCell = statusDialog.locator('.portal-model-health-grid tbody tr').first().locator('td > button.is-failed');
  await failedCell.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("provider_unavailable");
  await expect(tooltip).toContainText("503");
  await expect(tooltip).toContainText("req-gpt-5-10");
  await captureReviewScreenshot(page, "portal-model-health-desktop.png");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await expect(statusDialog.locator(".portal-model-health-grid-scroll")).toBeVisible();
  await captureReviewScreenshot(page, "portal-model-health-mobile.png");

  await statusDialog.getByRole("button", { name: "Close" }).click();
  await expect(statusDialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Open model service status" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await captureReviewScreenshot(page, "portal-token-model-health-entry-mobile.png");
});

test("runs User Management and Skills Review as native Portal administration modules", async ({ page }, testInfo) => {
  const roleWrites: unknown[] = [];
  const reviewWrites: unknown[] = [];
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  await page.route("**/api/admin/users", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { users: [
      { createdAt: "2026-07-01T00:00:00.000Z", department: "AI Adoption", email: "local.admin@example.test", id: "local-dev-admin", journeyLevelKey: "builder", lastSeenAt: hoursAgo(24), name: "Local Admin", role: "admin", status: "active", team: "AI Adoption" },
      { createdAt: "2026-07-05T00:00:00.000Z", department: "Legal", email: "maya@example.test", id: "user-maya", journeyLevelKey: "explorer", lastSeenAt: hoursAgo(48), name: "Maya Chen", role: "member", status: "active", team: "Legal AI" },
      { createdAt: "2026-07-10T00:00:00.000Z", department: "Finance", email: "nina@example.test", id: "user-nina", journeyLevelKey: "newcomer", lastSeenAt: hoursAgo(1), name: "Nina Lee", role: "member", status: "invited", team: "Finance" },
      { createdAt: "2026-06-01T00:00:00.000Z", department: "Legal", email: "old@example.test", id: "user-old", journeyLevelKey: "master", lastSeenAt: hoursAgo(8 * 24), name: "Old Active", role: "member", status: "active", team: "Legal AI" }
    ] } });
  });
  await page.route("**/api/admin/users/*/roles", async (route) => {
    const body = await route.request().postDataJSON();
    roleWrites.push(body);
    await route.fulfill({ contentType: "application/json", json: { user: { email: "maya@example.test", id: "user-maya", name: "Maya Chen", role: body.roles.includes("admin") ? "admin" : "member", roles: body.roles, status: "active", team: "Legal AI" } } });
  });
  await page.route("**/api/listings/*/status", async (route) => {
    reviewWrites.push(await route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", json: { ok: true } });
  });
  await page.route("**/api/assets/*/*/status", async (route) => {
    reviewWrites.push(await route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", json: { ok: true } });
  });

  await page.goto("/#/home");
  await page.getByRole("button", { name: "Switch to administration" }).click();
  await expect(page.getByRole("button", { name: "User Management" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skills Review" })).toBeVisible();

  await page.getByRole("button", { name: "User Management" }).click();
  await expect(page).toHaveURL(/#\/admin\/users$/);
  await expect(page.getByRole("heading", { level: 1, name: "User Management" })).toBeVisible();
  const userSummary = page.locator('[aria-label="User management summary"]');
  const usersTable = page.locator(".portal-users-table");
  await expect(userSummary.locator("div").filter({ hasText: "Activated users" })).toContainText("3");
  await expect(userSummary.locator("div").filter({ hasText: "Logged in within 7 days" })).toContainText("3");

  await page.getByRole("button", { name: "Filter by department" }).click();
  await page.getByRole("option", { exact: true, name: "Legal" }).click();
  await expect(usersTable.getByText("Maya Chen", { exact: true })).toBeVisible();
  await expect(usersTable.getByText("Local Admin", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Filter by department" }).click();
  await page.getByRole("option", { exact: true, name: "All departments" }).click();

  await page.getByRole("button", { name: "Filter by status" }).click();
  await page.getByRole("option", { exact: true, name: "Invited" }).click();
  await expect(usersTable.getByText("Nina Lee", { exact: true })).toBeVisible();
  await expect(usersTable.getByText("Maya Chen", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Filter by status" }).click();
  await page.getByRole("option", { exact: true, name: "All statuses" }).click();

  await page.getByRole("button", { name: "Filter by community level" }).click();
  await page.getByRole("option", { exact: true, name: "Level 2 · Explorer" }).click();
  await expect(usersTable.getByText("Maya Chen", { exact: true })).toBeVisible();
  await expect(usersTable.getByText("Nina Lee", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Filter by community level" }).click();
  await page.getByRole("option", { exact: true, name: "All community levels" }).click();

  const manageRoleButton = page.locator("tr").filter({ hasText: "Maya Chen" }).getByRole("button", { name: "Manage Maya Chen's role" });
  await expect(manageRoleButton).toHaveText("Manage role");
  await manageRoleButton.click();
  const roleDialog = page.getByRole("dialog", { name: "Maya Chen profile" });
  await roleDialog.locator(".portal-admin-role-option").filter({ hasText: "IT Admin" }).getByRole("checkbox").check();
  await roleDialog.getByRole("button", { name: "Save permission" }).click();
  await expect.poll(() => roleWrites.length).toBe(1);
  expect(roleWrites[0]).toEqual({ roles: ["admin"] });
  await captureReviewScreenshot(page, "portal-admin-users-desktop.png");
  await page.setViewportSize({ height: 844, width: 390 });
  await page.waitForTimeout(250);
  const mobileManageCell = page.locator("tr").filter({ hasText: "Maya Chen" }).locator("td:last-child");
  await expect(mobileManageCell).toHaveCSS("justify-content", "flex-end");
  await expect(mobileManageCell).toHaveCSS("position", "static");
  const mobileRoleButtonBox = await mobileManageCell.getByRole("button", { name: "Manage Maya Chen's role" }).boundingBox();
  expect(mobileRoleButtonBox?.width).toBeGreaterThanOrEqual(44);
  expect(mobileRoleButtonBox?.width).toBeLessThanOrEqual((await mobileManageCell.boundingBox())!.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await captureReviewScreenshot(page, "portal-admin-users-mobile.png");
  await page.setViewportSize({ height: 900, width: 1440 });

  await page.getByRole("button", { name: "Skills Review" }).click();
  await expect(page).toHaveURL(/#\/admin\/hub-review$/);
  await expect(page.getByRole("heading", { level: 1, name: "Skills Review" })).toBeVisible();
  await expect(page.getByText("Workspace Onboarding", { exact: true })).toBeVisible();
  await expect(page.getByText("MCP", { exact: true })).toHaveCount(0);
  const onboardingActionButton = page.locator("tr").filter({ hasText: "Workspace Onboarding" }).getByRole("button", { name: "Review details: Workspace Onboarding" });
  await expect(onboardingActionButton).toBeVisible();
  await onboardingActionButton.click();
  const reviewDialog = page.getByRole("dialog", { name: "Workspace Onboarding review detail" });
  await reviewDialog.locator("summary").filter({ hasText: "Submission and security details" }).click();
  await expect(reviewDialog.getByRole("link", { name: "https://workspace-onboarding.vercel.app/login" })).toHaveAttribute("href", "https://workspace-onboarding.vercel.app/login");
  await reviewDialog.getByRole("button", { exact: true, name: "Publication decision" }).click();
  await page.getByRole("option", { exact: true, name: "Listed" }).click();
  await reviewDialog.getByRole("button", { exact: true, name: "Category" }).click();
  await page.getByRole("option", { exact: true, name: "Finance" }).click();
  await reviewDialog.getByLabel("Review notes").fill("Approved for Community Hub.");
  await reviewDialog.getByRole("button", { name: "Save and publish" }).click();
  await expect.poll(() => reviewWrites.length).toBe(1);
  expect(reviewWrites[0]).toMatchObject({ category: "Finance", status: "listed" });

  await page.locator("tr").filter({ hasText: "Contract Risk Review" }).getByRole("button", { name: "Review details: Contract Risk Review" }).click();
  const skillReviewDialog = page.getByRole("dialog", { name: "Contract Risk Review review detail" });
  await skillReviewDialog.locator("summary").filter({ hasText: "Submission and security details" }).click();
  await expect(skillReviewDialog.getByRole("link", { name: "Download Skill package" })).toHaveAttribute(
    "href",
    "/api/listings/listing-skill-contract-review/download?source=admin_review"
  );
  await skillReviewDialog.getByRole("button", { name: "Close" }).click();

  await testInfo.attach("admin-operations-desktop", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await captureReviewScreenshot(page, "portal-admin-operations-desktop.png");
  await page.setViewportSize({ height: 844, width: 390 });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await captureReviewScreenshot(page, "portal-admin-operations-mobile.png");
});

test("runs Knowledge Management as an independent Admin module", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/#/admin/knowledge");

  await expect(page.getByRole("heading", { level: 1, name: "Knowledge Management" })).toBeVisible();
  await expect(page.getByRole("button", { exact: true, name: "Knowledge Management" })).toHaveAttribute("aria-current", "page");
  const summary = page.getByRole("region", { name: "Knowledge service management summary" });
  await expect(summary).toContainText("Published services");
  await expect(summary).toContainText("18");
  await expect(summary).toContainText("42");

  const row = page.locator(".portal-admin-knowledge-table tbody tr").filter({ hasText: "PB Partner" });
  await expect(row).toContainText("Private");
  await expect(row).toContainText("18");
  await expect(row).toContainText("42");
  const detailsButton = row.getByRole("button", { name: "Open details for knowledge service “PB Partner”" });
  await expect(detailsButton).toHaveText("");
  await expect(detailsButton).toHaveCSS("width", "30px");
  await detailsButton.click();

  const dialog = page.locator(".portal-admin-knowledge-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("No additional Viewers are configured; access is limited to the Owner and collaborators.");
  await expect(dialog).toContainText("MCP Feedback");
  await expect(dialog).toContainText("Enabled");
  await expect(dialog.getByText("Submit feedback", { exact: true })).toHaveCount(0);
  await testInfo.attach("admin-knowledge-desktop", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png"
  });

  await page.setViewportSize({ height: 844, width: 390 });
  await page.waitForTimeout(250);
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await testInfo.attach("admin-knowledge-mobile", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png"
  });
});

test("offers a consistent retry action without exposing Knowledge error codes", async ({ page }) => {
  let requests = 0;
  await page.unroute("**/k/api/admin/knowledge-services");
  await page.route("**/k/api/admin/knowledge-services", async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({
        contentType: "application/json",
        json: { error: "knowledge_admin_access_denied" },
        status: 403
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: {
        services: [],
        summary: { companyVisibleCount: 0, fileCount: 0, requestCount: 0, serviceCount: 0 }
      }
    });
  });

  await page.goto("/#/admin/knowledge");
  const error = page.getByRole("alert");
  await expect(error).toContainText("Knowledge service data failed to load");
  await expect(error).not.toContainText("knowledge_admin_access_denied");
  await captureReviewScreenshot(page, "portal-admin-knowledge-error-desktop.png");
  await error.getByRole("button", { name: "Retry" }).click();
  await expect(error).toHaveCount(0);
  await expect(page.getByText("No matching knowledge services")).toBeVisible();
  expect(requests).toBe(2);
  await captureReviewScreenshot(page, "portal-admin-knowledge-retry-desktop.png");
});

async function captureReviewScreenshot(page: import("@playwright/test").Page, name: string) {
  if (process.env.Portal_CAPTURE_SCREENSHOTS === "1") {
    await page.screenshot({ fullPage: true, path: `tmp/${name}` });
  }
}
