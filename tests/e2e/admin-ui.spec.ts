import { expect, test } from "@playwright/test";
import { fallbackPortal } from "../../src/shared/fallbackPortal";
import { mockPortalApis } from "./fixtures/portalApi";

const avatar = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="green"/></svg>')}`;
const source = { provider: "litellm", mode: "admin-api", fetchedAt: "2026-10-09T16:00:00Z", endpoints: [] };
const token = { id: "a".repeat(64), name: "Long production-style token name with an owner and rotation suffix", externalUserId: "admin.owner@example.test", accessStatus: "active", status: "active", monthlyBudgetUsd: 100, createdAt: "2026-10-01T00:00:00Z", lastUsedAt: "2026-10-09T16:00:00Z" };

test.use({ timezoneId: "Asia/Shanghai" });

test.beforeEach(async ({ page }, testInfo) => {
  await page.addInitScript((locale) => window.localStorage.setItem("workspace-ai:locale", locale), testInfo.title.startsWith("English") ? "en" : "zh-CN");
  await mockPortalApis(page);
  await page.route("**/api/admin/users", (route) => route.fulfill({ json: { users: [
    { ...fallbackPortal.currentUser, status: "active", avatarUrl: avatar },
    { id: "user-bob", name: "Bob Chen", email: "bob@example.test", role: "member", status: "active", avatarUrl: avatar, department: "A long production department name", team: "Operations" }
  ] } }));
  await page.route("**/api/admin/login-email-policy", (route) => route.fulfill({ json: { policy: { mode: "company_email_only", allowedDomains: ["example.test"], updatedAt: "2026-10-09T00:00:00Z" } } }));
  await page.route(/\/api\/llm-gateway\/admin\/allocations(?:\?.*)?$/, (route) => route.fulfill({ json: { source, tokens: [token], userLimits: [], usage: [], modelOptions: [] } }));
  await page.route("**/api/llm-gateway/admin/usage?*", (route) => {
    const groupType = new URL(route.request().url()).searchParams.get("groupBy") || "model";
    const groupId = groupType === "user" ? "bob@example.test" : groupType === "token" ? token.id : "model-alpha";
    return route.fulfill({ json: { source, usage: [], tokens: [token], requestTotal: 5,
      series: [1, 2].map((day) => ({ periodStart: `2026-10-0${day}T00:00:00Z`, groupType, groupId, requests: day + 1, billableUnits: day * 100, estimatedCostUsd: day / 100, failedRequests: 0, blockedRequests: 0 })),
      requests: [{ id: "sample", request_id: "request-one", model: "model-alpha", external_user_id: "bob@example.test", status: "completed", billable_units: 100, estimated_cost_usd: 0.01, created_at: "2026-10-09T16:45:00Z" }]
    } });
  });
  await page.route("**/api/admin/mcp/connections?*", (route) => {
    const search = new URL(route.request().url()).searchParams;
    const status = search.get("status") === "inactive" ? "inactive" : "active";
    return route.fulfill({ json: { summary: { activeCount: 1, inactiveCount: 1, totalCount: 2, userCount: 1 }, connections: search.get("q") ? [] : [{ id: `link-${status}`, agentType: "codex", clientId: "workspace-ai-mcp", displayName: "Production-style long terminal name", status, createdAt: "2026-10-01T00:00:00Z", lastActiveAt: "2026-10-09T00:00:00Z", scopes: [], user: { id: "user-bob", name: "Bob Chen", email: "bob@example.test" } }] } });
  });
  for (const key of ["apps", "jobs", "nodes"]) {
    await page.route(`**/api/backups/admin/${key}`, (route) => route.fulfill({ json: { [key]: [] } }));
  }
  await page.route("**/api/llm-gateway/model-catalog", (route) => route.fulfill({ json: { gatewayUrl: "https://gateway.example.test", catalog: { version: "test", source: { provider: "litellm", importedAt: source.fetchedAt }, vendors: [{ id: "vendor-alpha", displayName: "Vendor Alpha", status: "active", kind: "openai" }], models: [{ id: "model-alpha", displayName: "Model Alpha", supported: true, defaultVendor: "vendor-alpha", description: "Test model", capabilities: ["chat"], limits: { maxPromptTokens: 8192, maxCompletionTokens: 1024 } }] } } }));
});

for (const locale of ["Chinese", "English"]) {
  test(`${locale} admin rail opens every management route including login policy`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/#/admin/knowledge");
    const names = locale === "Chinese"
      ? ["用户管理", "知识库管理", "MCP 连接", "发布审核", "全局数据备份", "登录与邮箱策略", "Token 管理"]
      : ["User Management", "Knowledge Management", "MCP Connections", "Skills Review", "Data Backups", "Login & Email Policy", "Gateway Administration"];
    const routes = ["users", "knowledge", "mcp-connections", "hub-review", "backups", "login-policy", "gateway"];
    const nav = page.getByRole("navigation", { name: locale === "Chinese" ? "管理" : "Administration", exact: true });
    await expect(nav.getByRole("button")).toHaveCount(7);
    await expect(nav.getByRole("button", { name: locale === "Chinese" ? "模型测试" : "Model Test", exact: true })).toHaveCount(0);
    for (let i = 0; i < names.length; i++) {
      await nav.getByRole("button", { name: names[i], exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/#/admin/${routes[i]}$`));
    }
    await nav.getByRole("button", { name: names[5], exact: true }).click();
    await expect(page.getByText("example.test", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveValue("");
  });
}

for (const locale of ["Chinese", "English"]) {
  test(`${locale} retired admin model test link opens the existing front-end Token page`, async ({ page }) => {
    const adminRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/llm-gateway/admin/")) adminRequests.push(request.url());
    });
    for (const legacyUrl of ["/#/admin/playground", "/#/admin/playground?model=model-alpha", "/#/admin/playground/"]) {
      await page.goto(legacyUrl);
      await expect(page).toHaveURL(/\/#\/tokens$/);
      await expect(page.getByRole("heading", { name: "Token", exact: true, level: 1 })).toBeVisible();
      await expect(page.getByRole("navigation", { name: locale === "Chinese" ? "管理" : "Administration", exact: true })).toHaveCount(0);
      await expect(page.locator('.portal-nav-item[aria-current="page"]')).toHaveText("Token");
    }
    expect(adminRequests).toEqual([]);
  });
}

for (const width of [1280, 390]) {
  test(`knowledge people use text without avatars and details remain reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/#/admin/knowledge");
    const table = page.locator(".portal-admin-knowledge-table");
    await expect(table.getByText("PB Partner", { exact: true })).toBeVisible();
    await expect(table.getByText("Bob Chen", { exact: true })).toBeVisible();
    await expect(table.getByText("1 位协作者", { exact: true })).toBeVisible();
    await expect(table.locator("img, .personAvatar, .avatarStack")).toHaveCount(0);
    const row = table.locator("tbody tr").first();
    expect((await row.boundingBox())?.height).toBeLessThan(180);
    await row.getByRole("button", { name: /^PB Partner/ }).scrollIntoViewIfNeeded();
    await expect(row.getByRole("button", { name: /查看知识库服务/ })).toBeInViewport();
    await row.getByRole("button", { name: /查看知识库服务/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Bob Chen", { exact: true })).toBeVisible();
    await expect(dialog.getByText("bob@example.test", { exact: true })).toBeVisible();
    await expect(dialog.locator("img, .personAvatar, .avatarStack")).toHaveCount(0);
    expect((await dialog.boundingBox())?.width).toBeLessThanOrEqual(width);
    await dialog.locator(".portal-admin-dialog-header").getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("textbox", { name: "搜索知识库服务" }).fill("no-match-ui-test");
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(table.locator("tbody")).not.toContainText("PB Partner");
  });
}

test("knowledge management hides legacy Private rows and totals and offers only Company and Targeted", async ({ page }) => {
  await page.route("**/k/api/admin/knowledge-services", (route) => route.fulfill({ json: {
    services: [
      { id: "company", name: "Company knowledge", permissionType: "company", access: { company: true, departments: [], users: [] }, fileCount: 3, requestCount: 4 },
      { id: "targeted", name: "Targeted knowledge", permissionType: "targeted", access: { company: false, departments: [], users: ["user-bob"] }, fileCount: 5, requestCount: 6 },
      { id: "private", name: "Private knowledge must be hidden", permissionType: "private", access: { company: false, departments: [], users: [] }, fileCount: 100, requestCount: 100 }
    ].map((service) => ({ collaboratorUserIds: [], ownerUserId: "user-bob", tags: [], category: "general", folderPath: service.name, ...service })),
    summary: { serviceCount: 3, companyVisibleCount: 1, fileCount: 108, requestCount: 110 }
  } }));
  await page.goto("/#/admin/knowledge");
  await expect(page.getByText("当前结果 2 / 全部 2", { exact: true })).toBeVisible();
  await expect(page.locator(".portal-admin-knowledge-table tbody tr")).toHaveCount(2);
  await expect(page.getByText("Private knowledge must be hidden", { exact: true })).toHaveCount(0);
  await expect(page.locator(".portal-admin-knowledge-metrics")).toContainText("文件总数8");
  await expect(page.locator(".portal-admin-knowledge-metrics")).toContainText("请求总数10");
  await page.getByRole("button", { name: "按权限类型筛选", exact: true }).click();
  await expect(page.getByRole("option", { name: "私有", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "指定范围", exact: true }).click();
  await expect(page.locator(".portal-admin-knowledge-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".portal-admin-knowledge-table")).toContainText("Targeted knowledge");
});

test("review network failure preserves valid cover and edits and explains that the result is unconfirmed", async ({ page }) => {
  const cover = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfuoAAAAASUVORK5CYII=";
  await page.route("**/api/publication/listings?view=review", (route) => route.fulfill({ json: { publicationListings: [{
    ...fallbackPortal.publicationListings[0], id: "review-network", targetId: "network-skill", targetPlane: "apps", type: "skill", name: "Network test Skill", status: "pending_review", coverImageUrl: cover
  }] } }));
  await page.route("**/api/listings/review-network/status", (route) => route.abort("failed"));
  await page.goto("/#/admin/hub-review");
  await page.getByRole("button", { name: "审核详情: Network test Skill", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("封面可正常预览", { exact: true })).toBeVisible();
  await expect(dialog.locator(".appCoverFieldHeader strong")).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "上架名称", exact: true }).fill("Retained Skill edits");
  await dialog.getByRole("button", { name: "发布决定", exact: true }).click();
  await page.getByRole("option", { name: "已上架", exact: true }).click();
  await dialog.getByRole("button", { name: "保存并上架", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("审核保存请求未收到响应，结果尚未确认");
  await expect(dialog.getByRole("textbox", { name: "上架名称", exact: true })).toHaveValue("Retained Skill edits");
  await expect(dialog.getByText("封面可正常预览", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "保存并上架", exact: true })).toBeEnabled();
});

test("public App recommendations are saved with review and hidden for private scopes", async ({ page }) => {
  const cover = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfuoAAAAASUVORK5CYII=";
  const listing = { ...fallbackPortal.publicationListings[0], id: "review-recommendation", targetId: "public-app", targetPlane: "apps", type: "app", name: "Public test App", visibility: "org", status: "pending_review", homeDisplay: "normal", coverImageUrl: cover };
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps: [] } }));
  await page.route("**/api/publication/listings?view=review", (route) => route.fulfill({ json: { publicationListings: [listing] } }));
  const saves: Record<string, unknown>[] = [];
  await page.route("**/api/listings/review-recommendation/status", async (route) => {
    const body = route.request().postDataJSON();
    saves.push(body);
    Object.assign(listing, body);
    await route.fulfill({ json: { listingId: listing.id, status: body.status } });
  });
  await page.goto("/#/admin/hub-review");
  await page.getByRole("button", { name: "审核详情: Public test App", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const recommendation = dialog.getByRole("button", { name: "是否在首页推荐", exact: true });
  await expect(recommendation).toHaveCount(0);
  await dialog.getByRole("button", { name: "发布决定", exact: true }).click();
  await page.getByRole("option", { name: "已上架", exact: true }).click();
  await expect(recommendation).toContainText("不推荐");
  await recommendation.click();
  await page.getByRole("option", { name: "推荐", exact: true }).click();
  await dialog.getByRole("button", { name: "平台展示范围", exact: true }).click();
  await page.getByRole("option", { name: "仅自己可见", exact: true }).click();
  await expect(recommendation).toHaveCount(0);
  await dialog.getByRole("button", { name: "平台展示范围", exact: true }).click();
  await page.getByRole("option", { name: "组织可见", exact: true }).click();
  await expect(recommendation).toContainText("不推荐");
  await recommendation.click();
  await page.getByRole("option", { name: "推荐", exact: true }).click();
  await expect(dialog.getByText("封面可正常预览", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "保存并上架", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ homeDisplay: "recommended", status: "listed", visibility: "org" });
  await page.getByRole("button", { name: "审核详情: Public test App", exact: true }).click();
  await expect(recommendation).toContainText("推荐");
  await dialog.screenshot({ path: "output/playwright/review-home-recommendation.png" });
});

test("Skill and targeted App reviews do not offer Home recommendation", async ({ page }) => {
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps: [] } }));
  const listings = [
    { ...fallbackPortal.publicationListings[0], id: "skill-no-recommend", targetId: "skill-no-recommend", type: "skill", name: "Skill review", targetPlane: "apps", visibility: "org", status: "listed" },
    { ...fallbackPortal.publicationListings[0], id: "targeted-no-recommend", targetId: "targeted-no-recommend", type: "app", name: "Targeted review", targetPlane: "apps", visibility: "org", status: "listed", config: { reviewDraft: { accessMode: "targeted" } } }
  ];
  await page.route("**/api/publication/listings?view=review", (route) => route.fulfill({ json: { publicationListings: listings } }));
  await page.goto("/#/admin/hub-review");
  for (const name of ["Skill review", "Targeted review"]) {
    await page.getByRole("button", { name: `审核详情: ${name}`, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "是否在首页推荐", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
  }
});

test("Token status and actions stay visible and grouped usage follows the selected dimension", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/#/admin/gateway");
  const row = page.locator(".portal-admin-token-table tbody tr").first();
  await expect(row.getByText("可用", { exact: true })).toBeVisible();
  const status = row.locator(".portal-admin-status");
  const statusBox = await status.boundingBox();
  expect(statusBox?.height).toBeLessThan(30);
  await expect(row.getByRole("button")).toBeInViewport();
  await row.getByRole("button").click();
  await expect(page.getByRole("spinbutton", { name: "每月预算（USD）" })).toHaveValue("100");
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "用量监控", exact: true }).click();
  const grouped = page.getByRole("table", { name: "分组汇总", exact: true });
  await expect(grouped.locator("tbody tr")).toHaveCount(1);
  await expect(grouped.locator("tbody tr")).toContainText("model-alpha");
  await expect(grouped.locator("tbody td").nth(1)).toHaveText("5");
  await expect(grouped.locator("tbody td").nth(2)).toHaveText("300");
  await page.getByRole("combobox", { name: "分组方式", exact: true }).selectOption("user");
  await expect(grouped).toContainText("bob@example.test");
  await expect(grouped).not.toContainText("model-alpha");
  const requests = page.getByRole("table", { name: "最近请求明细", exact: true });
  await expect(requests).toContainText("时间（UTC）");
  await expect(requests).not.toContainText("Oct 10");
  await expect(page.getByText("请求明细（当前显示 1 条样本）", { exact: true })).toBeVisible();
});

test("review inputs have usable dimensions and cancelling does not publish changes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const mutations: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET" && /\/api\/(listings|assets)/.test(request.url())) mutations.push(request.url()); });
  await page.goto("/#/admin/hub-review");
  await page.getByRole("button", { name: /^审核详情:/ }).first().click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByRole("textbox", { name: "上架名称", exact: true });
  await expect(input).toBeVisible();
  expect((await input.boundingBox())?.height).toBeGreaterThanOrEqual(38);
  await input.fill("UI TEST DRAFT — NOT PUBLISHED");
  const description = dialog.getByRole("textbox", { name: "详细说明", exact: true });
  await description.scrollIntoViewIfNeeded();
  expect((await description.boundingBox())?.height).toBeGreaterThanOrEqual(112);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(mutations).toEqual([]);
});

test("review waits for the complete registry beyond the old eight-second deadline", async ({ page }) => {
  const listings = Array.from({ length: 27 }, (_, index) => ({
    ...fallbackPortal.publicationListings[0],
    id: `review-${index}`, targetId: `target-${index}`, targetPlane: "apps" as const,
    type: index % 2 === 0 ? "app" as const : "skill" as const,
    name: `Registry asset ${index}`,
    status: index < 17 ? "listed" as const : index < 23 ? "pending_review" as const : "delisted" as const
  }));
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps: [] } }));
  await page.route("**/api/skills", (route) => route.fulfill({ json: { skills: [] } }));
  await page.route("**/api/publication/listings?view=review", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 8_200));
    await route.fulfill({ json: { publicationListings: listings } });
  });
  await page.goto("/#/admin/hub-review");
  await expect(page.getByText("当前结果 27 / 全部 27", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".portal-hub-review-table tbody tr")).toHaveCount(27);
  await expect(page.locator(".portal-admin-metrics")).toContainText("待审核6");
  await expect(page.locator(".portal-admin-metrics")).toContainText("已上架17");
  await expect(page.locator(".portal-data-warning")).toHaveCount(0);
});

test("failed review reads hide partial global totals and recover on retry", async ({ page }) => {
  let failed = true;
  await page.route("**/api/publication/listings?view=review", (route) => route.fulfill(failed
    ? { status: 502, json: { error: "upstream_unavailable" } }
    : { json: { publicationListings: fallbackPortal.publicationListings } }));
  await page.goto("/#/admin/hub-review");
  await expect(page.getByRole("heading", { name: "审核列表加载失败" })).toBeVisible();
  await expect(page.locator(".portal-admin-metrics")).toHaveCount(0);
  await expect(page.locator(".portal-hub-review-table")).toHaveCount(0);
  failed = false;
  await page.locator(".portal-admin-state").getByRole("button", { name: "重试" }).click();
  await expect(page.getByRole("heading", { name: "上架审核队列" })).toBeVisible();
  await expect(page.locator(".portal-hub-review-table tbody tr")).not.toHaveCount(0);
});

for (const entry of [
  { route: "users", api: /\/api\/admin\/users$/, metrics: ".portal-admin-user-metrics", count: 2 },
  { route: "knowledge", api: /\/api\/admin\/knowledge-services$/, metrics: ".portal-admin-knowledge-metrics", count: 4 },
  { route: "mcp-connections", api: /\/api\/admin\/mcp\/connections\?/, metrics: ".portal-admin-mcp-metrics", count: 4 },
  { route: "backups", api: /\/api\/backups\/admin\/jobs$/, metrics: ".backupAdminMetrics", count: 4 }
]) {
  test(`${entry.route} marks unavailable statistics instead of showing zero after a read failure`, async ({ page }) => {
    await page.route(entry.api, (route) => route.fulfill({ status: 503, json: { error: "source_unavailable" } }));
    await page.goto(`/#/admin/${entry.route}`);
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.locator(`${entry.metrics} strong`)).toHaveText(Array(entry.count).fill("-"));
  });
}

test("a failed registry request does not leave a warning on unrelated admin modules", async ({ page }) => {
  await page.route("**/api/publication/listings?view=review", (route) => route.fulfill({ status: 502, json: { error: "source_unavailable" } }));
  await page.goto("/#/admin/hub-review");
  await expect(page.getByRole("heading", { name: "审核列表加载失败" })).toBeVisible();
  await page.getByRole("navigation", { name: "管理", exact: true }).getByRole("button", { name: "用户管理", exact: true }).click();
  await expect(page.getByRole("heading", { name: "用户管理", exact: true })).toBeVisible();
  await expect(page.locator(".portal-data-warning")).toHaveCount(0);
  await expect(page.locator(".portal-admin-user-metrics strong")).not.toHaveText(["-", "-"]);
});

test("MCP actions remain visible while status and empty searches update the table", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/#/admin/mcp-connections");
  const table = page.locator(".portal-admin-mcp-table");
  await expect(table.getByRole("button", { name: "停用连接", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "按 MCP 连接状态筛选", exact: true }).click();
  await page.getByRole("option", { name: "无效授权", exact: true }).click();
  await expect(table.locator(".portal-admin-status").first()).toHaveText("无效授权");
  await expect(table.getByRole("button", { name: "停用连接", exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "搜索 MCP 连接用户", exact: true }).fill("no-match-ui-test");
  await expect(table).toContainText("没有匹配的 MCP 连接");
  await expect(page.locator(".portal-admin-mcp-metrics")).toContainText("全部连接2");
  await expect(page.getByText("当前结果 0 / 全部 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "清空筛选", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "搜索 MCP 连接用户", exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "按 MCP 连接状态筛选", exact: true })).toContainText("全部状态");
});

test("backup tabs expose selection and the new node dialog cancels without writing", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET" && request.url().includes("/api/backups/")) writes.push(request.url()); });
  await page.goto("/#/admin/backups");
  const tabs = page.getByRole("tab");
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.first()).toHaveAttribute("aria-selected", "false");
  await page.getByRole("button", { name: "新增备份节点", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("user status remains visible and permission dialogs cancel without a role change", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const changes: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET" && request.url().includes("/api/admin/users")) changes.push(request.url()); });
  await page.goto("/#/admin/users");
  const table = page.locator(".portal-users-table");
  const own = table.getByRole("button", { name: `管理 ${fallbackPortal.currentUser.name} 的权限`, exact: true });
  await expect(own).toBeDisabled();
  const row = table.locator("tbody tr").filter({ hasText: "Bob Chen" });
  await expect(row.locator("td").nth(4)).toBeInViewport();
  await row.getByRole("button", { name: "管理 Bob Chen 的权限", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索用户", exact: true }).fill("no-match-ui-test");
  await expect(table.locator("tbody")).not.toContainText("Bob Chen");
  expect(changes).toEqual([]);
});

test("login policy validates domains and previews changes before any write", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("login-email-policy")) writes.push(request.url()); });
  await page.goto("/#/admin/login-policy");
  const save = page.getByRole("button", { name: "检查并保存策略", exact: true });
  await expect(save).toBeDisabled();
  const input = page.getByRole("textbox");
  await input.fill("https://bad.example");
  await page.getByRole("button", { name: "添加域名", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("域名");
  await input.fill("EXAMPLE.TEST");
  await page.getByRole("button", { name: "添加域名", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已经在列表中");
  await input.fill("new.example.test");
  await page.getByRole("button", { name: "添加域名", exact: true }).click();
  await save.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("new.example.test");
  await expect(dialog).toContainText("Moka");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(writes).toEqual([]);
});

test("failed backup node creation preserves the form and does not enable default assignment", async ({ page }) => {
  await page.route("**/api/backups/admin/nodes", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 400, json: { error: "invalid_host_key_fingerprint" } })
    : route.fulfill({ json: { nodes: [] } }));
  await page.goto("/#/admin/backups");
  await page.getByRole("button", { name: "新增备份节点", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  const fields = dialog.locator("input:not([type=checkbox])");
  for (const [index, value] of ["Test node", "backup.example.test", "22", "tester", "test-only-password", "invalid", "/backups"].entries()) await fields.nth(index).fill(value);
  await dialog.getByRole("button", { name: "创建节点", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("invalid_host_key_fingerprint");
  await expect(fields.first()).toHaveValue("Test node");
});

test("model permissions preserve legacy IDs and can explicitly restore the default scope", async ({ page }) => {
  await page.route(/\/api\/llm-gateway\/admin\/allocations(?:\?.*)?$/, (route) => route.fulfill({ json: { source, tokens: [{ ...token, allowedModels: ["legacy-model"] }], userLimits: [], usage: [], modelOptions: [{ id: "model-alpha", displayName: "Model Alpha" }] } }));
  await page.goto("/#/admin/gateway");
  await page.locator(".portal-admin-token-table tbody tr").first().getByRole("button").click();
  const dialog = page.getByRole("dialog");
  const legacy = dialog.getByRole("checkbox", { name: /legacy-model/ });
  await expect(legacy).toBeChecked();
  await dialog.getByRole("checkbox", { name: /Model Alpha/ }).check();
  await expect(dialog.getByText("已选择 2 个模型", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "使用默认模型范围", exact: true }).click();
  await expect(legacy).toHaveCount(0);
  await expect(dialog.getByRole("checkbox", { name: /Model Alpha/ })).not.toBeChecked();
});

test("usage discrepancies remain visible instead of appearing as complete billing totals", async ({ page }) => {
  await page.route("**/api/llm-gateway/admin/usage?*", (route) => route.fulfill({ json: { source, tokens: [], usage: [], requestTotal: 3, series: [{ periodStart: "2026-10-01", groupType: "model", groupId: "alpha", requests: 3, billableUnits: 0, estimatedCostUsd: 0 }], requests: Array.from({ length: 10 }, (_, id) => ({ id: String(id), request_id: `req-${id}`, status: "completed" })) } }));
  await page.goto("/#/admin/gateway/usage");
  await expect(page.getByRole("alert")).toContainText("待核对");
});

for (const width of [1280, 390]) {
  test(`domain entry uses full-sized controls without horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/#/admin/login-policy");
    const field = page.getByRole("textbox", { name: "企业邮箱域名", exact: true });
    await expect(field).toBeVisible();
    const box = await field.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(38);
    expect(box?.width).toBeGreaterThanOrEqual(width === 390 ? 140 : 300);
    expect(await field.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe("solid");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test.describe("Source date locale", () => {
  test.use({ locale: "zh-CN" });
  for (const route of ["gateway", "gateway/usage"]) {
    test(`English source timestamps follow the interface language on ${route}`, async ({ page }) => {
      await page.goto(`/#/admin/${route}`);
      const stamp = page.locator(".portal-admin-source small");
      await expect(stamp).toContainText("Synced Oct");
      await expect(stamp).not.toContainText("年");
      if (route.startsWith("gateway")) {
        const table = route === "gateway" ? page.locator(".portal-admin-token-table") : page.getByRole("table", { name: "Recent request details", exact: true });
        await expect(table).toContainText("Oct");
        await expect(table).not.toContainText("年");
      }
    });
  }
});

for (const language of ["Chinese", "English"]) {
  test(`${language} signed-in administrators have no mobile administration entry`, async ({ page }) => {
    const entryName = language === "English" ? "Switch to administration" : "切换到管理模式";
    const menuName = language === "English" ? "Open navigation menu" : "打开导航菜单";
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#/home");
    await page.getByRole("button", { name: menuName, exact: true }).click();
    await expect(page.locator(".portal-left-rail .portal-account-profile")).toBeVisible();
    await expect(page.getByRole("button", { name: entryName, exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 760, height: 844 });
    await expect(page.getByRole("button", { name: entryName, exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByRole("button", { name: entryName, exact: true })).toBeVisible();
    await page.getByRole("button", { name: entryName, exact: true }).click();
    await expect(page).toHaveURL(/#\/admin\/gateway$/);
  });
}
