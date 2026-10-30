import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import {
  debugField,
  expectPreviewHostReady,
  expectPreviewTurnSettled,
  sendPreviewMessage,
  matePreview
} from "./fixtures/matePreview";
import { installMatePreviewServer } from "./fixtures/matePreviewServer";

test("provider rejection shows one failed assistant before and after hydration without a completed label or spinner", async ({ context, page }) => {
  const server = await installMatePreviewServer(page, context);
  server.failNextProviderTurn();
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`);
  await expectPreviewHostReady(page);
  await sendPreviewMessage(page, "Synthetic provider schema rejection");
  await expectPreviewTurnSettled(page, "failed");
  const assistant = page.getByTestId("preview-message-assistant");
  const process = assistant.getByTestId("preview-turn-process");
  await expect(assistant).toHaveCount(1);
  await expect(process).toHaveAttribute("data-status", "failed");
  await expect(process.locator(":scope > summary")).not.toContainText("已完成");
  await expect(assistant.getByRole("alert")).toContainText("本次回复未完成");
  await expect(assistant.locator(".tm-preview-process-spinner")).toHaveCount(0);
  await expect(assistant).not.toContainText("结构化消息");
  await page.reload();
  await expectPreviewHostReady(page);
  await expect(assistant).toHaveCount(1);
  await expect(process).toHaveAttribute("data-status", "failed");
  await expect(assistant.getByRole("alert")).toContainText("本次回复未完成");
  await expect(process.locator(":scope > summary")).not.toContainText("已完成");
});

test("direct answers stay visible beside one timed process after streaming and hydration", async ({ context, page }) => {
  const server = await installMatePreviewServer(page, context, { directAnswer: true });
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`);
  await expectPreviewHostReady(page, { conversationId: server.conversationId, mode: "preview", releaseId: server.releaseId });
  await sendPreviewMessage(page, "Direct answer without tool calls");
  await expectPreviewTurnSettled(page, "completed");
  const assistant = page.getByTestId("preview-message-assistant");
  await expect(assistant).toContainText("Synthetic answer 1");
  await expect(assistant.getByTestId("preview-turn-process")).toHaveCount(1);
  await page.reload();
  await expectPreviewHostReady(page, { conversationId: server.conversationId, mode: "preview", releaseId: server.releaseId });
  await expect(assistant).toContainText("Synthetic answer 1");
  await expect(assistant.getByTestId("preview-turn-process")).toHaveCount(1);
});

test("Preview Host boots, sends, hydrates, and resumes one authoritative transcript", async ({
  context,
  page
}) => {
  const markdownRequests: string[] = [];
  const sourceRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("MarkdownMessage")) markdownRequests.push(request.url());
    if (request.url().includes("SourcePanel")) sourceRequests.push(request.url());
  });
  const server = await installMatePreviewServer(page, context);
  const route = `/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`;

  await page.goto(route, { waitUntil: "domcontentloaded" });
  await expectPreviewHostReady(page, {
    conversationId: server.conversationId,
    mode: "preview",
    releaseId: server.releaseId
  });
  await expect(page.getByTestId("preview-sdk-surface")).toBeVisible();
  await expect(page.getByTestId(matePreview.host)).toHaveAttribute("data-entry-channel", "sdk");
  await expect(page.getByRole("button", { exact: true, name: "对话" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: /Preview portfolio review/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "新对话" })).toContainText("新对话");
  await expect(page.locator(".tm-preview-rail-section-title strong")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "置顶对话" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "活跃", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "已存档", exact: true })).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("tabpanel", { name: "活跃", exact: true })).toBeVisible();
  await expect(page.locator(".tm-preview-directory-group-label")).toHaveCount(0);
  await expect(page.locator(".tm-preview-directory-item time").first()).not.toContainText("T");
  await expect(page.locator(".tm-preview-chat-toolbar")).toHaveCount(0);
  const topbarStatus = page.locator(".tm-preview-topbar-status");
  const filesControl = topbarStatus.getByRole("button", { name: /展开文件与来源/ });
  const connectionStatus = topbarStatus.locator(".tm-preview-connection");
  await expect(topbarStatus.getByTestId(/preview-text-size-/)).toHaveCount(0);
  await expect(filesControl).toBeVisible();
  await expect(connectionStatus).toBeVisible();
  const topbarControlOrder = await Promise.all([
    filesControl.evaluate((element) => element.getBoundingClientRect().left),
    connectionStatus.evaluate((element) => element.getBoundingClientRect().left)
  ]);
  expect(topbarControlOrder[0]).toBeLessThan(topbarControlOrder[1]);
  const userSettings = page.getByRole("button", { name: "打开当前用户设置" });
  await expect(userSettings).toContainText("Preview Owner");
  await userSettings.click();
  await expect(page.getByRole("dialog", { name: "显示设置" })).toBeVisible();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByRole("button", { exact: true, name: "Conversations" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New conversation" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Answer layout" })).toBeVisible();
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.getByRole("button", { exact: true, name: "对话" })).toBeVisible();
  expect(markdownRequests).toEqual([]);
  expect(sourceRequests).toEqual([]);
  const composer = page.getByTestId(matePreview.composer);
  const resourceTrigger = composer.getByRole("button", { name: /知识库与应用/ });
  await expect(resourceTrigger).toContainText("2 知识库 · 2 应用");
  await expect(composer.getByRole("button", { name: "添加附件" })).toBeDisabled();
  await resourceTrigger.click();
  const resourceDialog = page.getByRole("dialog", { name: "选择当前对话的知识库与应用" });
  await expect(resourceDialog).toBeVisible();
  await expect(resourceDialog.locator(":scope > header, :scope > footer")).toHaveCount(0);
  await expect(resourceDialog.getByRole("tab", { name: "知识库 [2]" })).toHaveAttribute("aria-selected", "true");
  await expect(resourceDialog.getByRole("tab", { name: "应用 [2]" })).toHaveAttribute("aria-selected", "false");
  await expect(resourceDialog.getByRole("button", { name: /Frontier Workspace How To/ })).toHaveAttribute("aria-pressed", "true");
  await expect(resourceDialog.getByRole("button", { name: /Portfolio MCP/ })).toHaveCount(0);
  await resourceDialog.getByRole("tab", { name: "应用 [2]" }).click();
  await expect(resourceDialog.getByRole("button", { name: /Portfolio MCP/ })).toHaveAttribute("aria-pressed", "true");
  await expect(resourceDialog.locator(".tm-preview-resource-scope-actions")).toHaveCount(0);
  await resourceDialog.getByRole("button", { name: "应用：取消全选", exact: true }).click();
  await expect(resourceTrigger).toContainText("2 知识库");
  await expect(resourceDialog.getByRole("tab", { name: "应用 [0]" })).toHaveAttribute("aria-selected", "true");
  await expect(resourceDialog.getByRole("button", { name: /Portfolio MCP/ })).toHaveAttribute("aria-pressed", "false");
  await resourceDialog.getByRole("button", { name: "应用：全选", exact: true }).click();
  await expect(resourceDialog.getByRole("tab", { name: "应用 [2]" })).toHaveAttribute("aria-selected", "true");
  await expect(resourceTrigger).toContainText("2 知识库 · 2 应用");
  await page.keyboard.press("Escape");
  const modelTrigger = composer.getByRole("button", { name: /选择模型，当前 DeepSeek V4 Flash/ });
  await modelTrigger.click();
  const modelList = page.getByRole("listbox", { name: "选择模型" });
  await expect(modelList.getByRole("option")).toHaveCount(2);
  await modelList.getByRole("option", { name: /GPT-5.4/ }).click();
  await expect(composer.getByRole("button", { name: /选择模型，当前 GPT-5.4/ })).toBeVisible();
  const transcript = page.getByTestId(matePreview.transcript);
  await expect(transcript).toHaveAttribute("data-text-size", "standard");
  await page.getByRole("button", { name: "打开当前用户设置" }).click();
  await page.getByTestId("preview-text-size-compact").click();
  await expect(transcript).toHaveAttribute("data-text-size", "compact");
  await expect(page.getByTestId("preview-text-size-large")).toHaveCount(0);
  const input = page.getByTestId(matePreview.input);
  const compactHeight = await input.evaluate((element) => element.getBoundingClientRect().height);
  await input.fill("一\n二\n三\n四\n五");
  await expect.poll(() => input.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(compactHeight);
  await input.fill("");
  await expect.poll(() => input.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(compactHeight + 1);
  await expect(page.getByLabel("Environment 语义坐标")).toHaveCount(0);
  await expect.poll(server.connectionCount).toBeGreaterThan(0);
  expect(server.previewSessionRequestCount()).toBeGreaterThanOrEqual(1);
  expect(server.previewGrantRequestCount()).toBeGreaterThanOrEqual(1);
  expect(server.hydrationRequestCount()).toBeGreaterThanOrEqual(1);
  expect(server.liveRequestCount()).toBe(0);
  const sessionsBeforeReload = server.previewSessionRequestCount();
  const hydrationsBeforeReload = server.hydrationRequestCount();
  await assertNoCredentialPersistence(page);

  await sendWithProtocolDiagnostics(page, server, "First deterministic Preview turn");
  await expect.poll(() => server.semanticCoordinates()).toContain(`mate:${server.mateId}`);
  await expect(page.getByTestId("preview-message-user")).toHaveCount(1);
  await expect(page.getByTestId("preview-message-assistant")).toHaveCount(1);
  const turnProcess = page.getByTestId("preview-turn-process").first();
  await expect(turnProcess).not.toHaveAttribute("open", "");
  await expect(turnProcess.locator(":scope > summary")).toContainText("已处理");
  await expect(turnProcess.locator(":scope > summary")).toContainText("5秒");
  await expect(turnProcess.locator(":scope > summary")).toContainText("读取 Workspace Forum");
  await expect(turnProcess.getByText("确认当前用户可见范围。", { exact: true })).not.toBeVisible();
  await expect(turnProcess.getByText("Runtime design 1", { exact: true }).first()).not.toBeVisible();
  await turnProcess.locator(":scope > summary").click();
  const processSummaries = turnProcess.getByTestId("preview-process-summary");
  const toolSteps = turnProcess.getByTestId("preview-process-tool");
  await expect(processSummaries).toHaveCount(3);
  await expect(toolSteps).toHaveCount(2);
  await expect(processSummaries.nth(0)).toContainText("确认当前用户可见范围。");
  await expect(processSummaries.nth(0)).toContainText("选择最相关的论坛检索词。");
  await expect(toolSteps.nth(0).locator(":scope > summary")).toContainText("读取 Workspace Forum");
  await expect(toolSteps.nth(0).locator(":scope > summary")).toContainText("forum_read");
  await expect(toolSteps.nth(1).locator(":scope > summary")).toContainText("forum_read");
  await expect(turnProcess.getByText("Runtime design 1", { exact: true }).first()).not.toBeVisible();
  await toolSteps.nth(0).locator(":scope > summary").click();
  await expect(turnProcess.getByText("Runtime design 1", { exact: true }).first()).toBeVisible();
  await expect(turnProcess.getByText("Agent architecture 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic answer 1 for", { exact: false })).toBeVisible();
  await expect(page.getByText("数据范围按 Release 与当前用户权限实时取交集")).toHaveCount(0);
  const assistantMessage = page.getByTestId("preview-message-assistant");
  await expect(assistantMessage.locator(".tm-preview-message-header")).toContainText("Preview E2E Mate");
  await expect.poll(() => assistantMessage.locator(".tm-preview-message-body").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderLeftWidth: style.borderLeftWidth,
      borderTopWidth: style.borderTopWidth
    };
  })).toEqual({ backgroundColor: "rgba(0, 0, 0, 0)", borderLeftWidth: "0px", borderTopWidth: "0px" });
  await expect.poll(() => assistantMessage.locator(".tm-preview-message-header").evaluate(
    (element) => getComputedStyle(element).borderBottomWidth
  )).toBe("1px");
  await expect(page.getByTestId("preview-message-user").getByRole("img", { name: "Preview Owner" })).toBeVisible();
  const assistantAvatar = page.getByTestId("preview-message-assistant").getByRole("img", { name: "Preview E2E Mate" });
  await expect(assistantAvatar).toBeVisible();
  await expect(assistantAvatar).toHaveAttribute("data-avatar-source", "configured");
  const roleBasedWidths = await page.evaluate(() => {
    const assistant = document.querySelector<HTMLElement>('[data-testid="preview-message-assistant"] .tm-preview-message-body');
    const user = document.querySelector<HTMLElement>('[data-testid="preview-message-user"] .tm-preview-message-body');
    const composer = document.querySelector<HTMLElement>('[data-testid="preview-composer"] .tm-preview-composer-card');
    if (!assistant || !user || !composer) return undefined;
    return {
      assistant: assistant.getBoundingClientRect().width,
      composer: composer.getBoundingClientRect().width,
      user: user.getBoundingClientRect().width
    };
  });
  expect(roleBasedWidths).toBeDefined();
  expect(roleBasedWidths!.assistant).toBeGreaterThanOrEqual(roleBasedWidths!.composer * 0.9);
  expect(roleBasedWidths!.assistant).toBeGreaterThan(roleBasedWidths!.user);
  await expectPreviewTurnSettled(page, "completed");
  expect(markdownRequests.length).toBeGreaterThan(0);
  expect(sourceRequests).toEqual([]);
  await page.getByRole("button", { name: /展开文件与来源/ }).click();
  await expect(page.getByTestId("preview-source-panel")).toBeVisible();
  expect(sourceRequests.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "关闭文件与来源" }).click();
  await expect(page.getByTestId("preview-source-panel")).toHaveCount(0);
  const firstIds = await messageIds(page);
  expect(firstIds).toEqual(server.transcriptIds());
  expect(new Set(firstIds).size).toBe(2);

  const connectionsBeforeReload = server.connectionCount();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectPreviewHostReady(page, {
    conversationId: server.conversationId,
    mode: "preview",
    releaseId: server.releaseId
  });
  await expect(page.getByTestId(matePreview.transcript)).toHaveAttribute("data-text-size", "compact");
  await expect.poll(server.connectionCount).toBeGreaterThan(connectionsBeforeReload);
  expect(server.previewSessionRequestCount()).toBeGreaterThan(sessionsBeforeReload);
  expect(server.hydrationRequestCount()).toBeGreaterThan(hydrationsBeforeReload);
  expect(await messageIds(page)).toEqual(firstIds);
  await expect(page.getByTestId("preview-turn-process").first().locator(":scope > summary")).toContainText("已处理");
  await expect(page.getByTestId("preview-turn-process").first().locator(":scope > summary")).toContainText("5秒");
  await expect(page.getByTestId("preview-turn-process").first()).not.toHaveAttribute("open", "");
  await assertNoCredentialPersistence(page);

  server.pauseNextTurn();
  const connectionsBeforeCut = server.connectionCount();
  const probesBeforeCut = server.resumeRequestCount();
  await sendWithProtocolDiagnostics(page, server, "Second deterministic turn must resume");
  await expect(page.getByTestId(matePreview.host)).toHaveAttribute("data-streaming", "true");
  const runningProcess = page.getByTestId("preview-turn-process").last();
  await expect(runningProcess.locator(":scope > summary")).toContainText("正在处理");
  await expect(runningProcess).not.toHaveAttribute("open", "");
  await runningProcess.locator(":scope > summary").click();
  await expect(runningProcess).toHaveAttribute("open", "");
  await context.setOffline(true);
  try {
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await server.cutLatest();
  } finally {
    await context.setOffline(false);
  }
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);

  await expect.poll(server.connectionCount).toBeGreaterThan(connectionsBeforeCut);
  await expect.poll(server.resumeRequestCount).toBeGreaterThan(probesBeforeCut);
  await expect.poll(server.resumeAcknowledgementCount).toBeGreaterThan(0);
  await expectPreviewTurnSettled(page, "completed");
  await expect(page.getByTestId("preview-turn-process").last()).toHaveAttribute("open", "");
  await expectPreviewHostReady(page, {
    conversationId: server.conversationId,
    mode: "preview",
    releaseId: server.releaseId
  });

  const finalIds = await messageIds(page);
  expect(finalIds).toEqual(server.transcriptIds());
  expect(finalIds).toHaveLength(4);
  expect(new Set(finalIds).size).toBe(finalIds.length);
  expect(server.liveRequestCount()).toBe(0);
  await assertNoCredentialPersistence(page);

  await page.getByRole("button", { name: "任务" }).click();
  await expect(page.getByTestId(matePreview.host)).toHaveAttribute("data-surface", "task_inbox");
  await expect(page.getByTestId("preview-operations-surface")).toBeVisible();
  await expect(page.getByTestId(matePreview.input)).toHaveCount(0);
  await expect.poll(server.taskListRequestCount).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: /Candidate release review/ })).toBeVisible();

  await page.getByRole("button", { exact: true, name: "对话" }).click();
  await expectPreviewHostReady(page, {
    conversationId: server.conversationId,
    mode: "preview",
    releaseId: server.releaseId
  });
  await expect(page.getByTestId("preview-sdk-surface")).toBeVisible();
  expect(await messageIds(page)).toEqual(finalIds);
});

test("Preview Host does not load Owner Debug unless debug mode is enabled", async ({ context, page }) => {
  const debugRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("DebugInspector")) debugRequests.push(request.url());
  });
  const server = await installMatePreviewServer(page, context);
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}`, {
    waitUntil: "domcontentloaded"
  });
  const host = page.getByTestId(matePreview.host);
  await expect(host).toHaveAttribute("data-hydration-state", "ready");
  await expect(host).toHaveAttribute("data-connection-state", "connected");
  await expect(page.getByTestId(matePreview.debugInspector)).toHaveCount(0);
  expect(debugRequests).toEqual([]);
});

test("Mate without a configured avatar uses Workspace's animated robot", async ({ context, page }) => {
  const server = await installMatePreviewServer(page, context, { mateAvatarUrl: null });
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`, {
    waitUntil: "domcontentloaded"
  });
  await expectPreviewHostReady(page, {
    conversationId: server.conversationId,
    mode: "preview",
    releaseId: server.releaseId
  });

  await sendPreviewMessage(page, "Verify the default animated avatar");
  await expectPreviewTurnSettled(page, "completed");
  const avatar = page.getByTestId("preview-message-assistant").getByRole("img", { name: "Preview E2E Mate" });
  await expect(avatar).toHaveAttribute("data-avatar-source", "workspace-pet");
  await expect(avatar).toHaveAttribute("data-avatar-motion", "idle");
  await expect(avatar.locator("img")).toHaveAttribute("src", /mate-pet-actions\/workspace-bot\/idle\.webp/);
});

test("New Conversation stays local until the first message commits its title", async ({ context, page }) => {
  const server = await installMatePreviewServer(page, context);
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`, {
    waitUntil: "domcontentloaded"
  });
  await expectPreviewHostReady(page, { conversationId: server.conversationId });
  const grants = server.previewGrantRequestCount();
  const hydrations = server.hydrationRequestCount();
  await page.getByRole("button", { name: "新对话" }).click();

  await expect(page.getByTestId("preview-draft-surface")).toBeVisible();
  await expect(page.getByText("草稿 · 尚未创建")).toBeVisible();
  await expect(page.getByRole("button", { name: /Preview portfolio review/ })).not.toHaveAttribute("aria-current", "page");
  expect(server.conversationCommitCount()).toBe(0);
  expect(server.previewGrantRequestCount()).toBe(grants);
  expect(server.hydrationRequestCount()).toBe(hydrations);

  const title = "Review portfolio concentration and liquidity";
  await sendPreviewMessage(page, title);
  await expect.poll(server.conversationCommitCount).toBe(1);
  await expectPreviewHostReady(page, { conversationId: server.latestDraftConversationId() });
  await expect(page.getByRole("button", { name: new RegExp(title) })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("preview-message-user")).toContainText(title);
});

test("the first request stays visible optimistically while Conversation and Agent DO start", async ({ context, page }) => {
  const server = await installMatePreviewServer(page, context, { conversationCommitDelayMs: 1_200 });
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`, {
    waitUntil: "domcontentloaded"
  });
  await expectPreviewHostReady(page, { conversationId: server.conversationId });
  await page.getByRole("button", { name: "新对话" }).click();
  await expect(page.getByTestId("preview-draft-surface")).toBeVisible();

  const prompt = "Summarize the current knowledge scope";
  await page.getByTestId(matePreview.input).fill(prompt);
  await page.getByTestId(matePreview.send).click();

  await expect(page.getByTestId(matePreview.input)).toHaveValue("");
  await expect(page.getByTestId("preview-draft-surface")).toBeVisible();
  await expect(page.getByTestId("preview-message-user")).toContainText(prompt);
  await expect(page.getByTestId(matePreview.loading)).toHaveCount(0);
  await expect(page.getByTestId("preview-chat-hydrating")).toHaveCount(0);

  await expectPreviewHostReady(page, { conversationId: server.latestDraftConversationId() });
  await expect(page.getByTestId("preview-message-user")).toContainText(prompt);
});

test("Conversation context menu renames, pins, archives, and permanently deletes one item", async ({ context, page }) => {
  const server = await installMatePreviewServer(page, context);
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`, { waitUntil: "domcontentloaded" });
  await expectPreviewHostReady(page, { conversationId: server.conversationId });
  const item = page.getByRole("button", { name: /Second Preview conversation/ }).first();

  page.once("dialog", (dialog) => dialog.accept("Pinned research thread"));
  await item.click({ button: "right" });
  await page.getByRole("menuitem", { name: "修改标题" }).click();
  const renamed = page.getByRole("button", { name: /Pinned research thread/ }).first();
  await expect(renamed).toBeVisible();

  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
  await expect(page.getByLabel("已置顶")).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "活跃", exact: true })).toContainText("Pinned research thread");

  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "存档", exact: true }).click();
  await expect(renamed).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "活跃", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: /Preview portfolio review/ })).toBeVisible();
  await page.getByRole("tab", { name: "已存档", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "已存档", exact: true })).toContainText("Pinned research thread");

  await renamed.click({ button: "right" });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await expect(page.getByRole("button", { name: /Pinned research thread/ })).toHaveCount(0);
  await expect.poll(server.deletedConversationCount).toBe(1);
});

test("Task tab is absent when the Release keeps Task mode disabled", async ({ context, page }) => {
  const server = await installMatePreviewServer(page, context, { taskModeEnabled: false });
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`, { waitUntil: "domcontentloaded" });
  await expectPreviewHostReady(page, { conversationId: server.conversationId });
  await expect(page.getByRole("button", { name: "任务" })).toHaveCount(0);
  await expect(page.getByRole("button", { exact: true, name: "对话" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".tm-preview-rail-tabs")).toHaveClass(/is-single/);
});

test("Conversation scope hides an unassociated App category", async ({ context, page }) => {
  const server = await installMatePreviewServer(page, context, { appMcpEnabled: false });
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`, { waitUntil: "domcontentloaded" });
  await expectPreviewHostReady(page, { conversationId: server.conversationId });

  const resourceTrigger = page.getByTestId(matePreview.composer).getByRole("button", { name: /知识库与应用/ });
  await expect(resourceTrigger).toContainText("2 知识库");
  await resourceTrigger.click();
  const resourceDialog = page.getByRole("dialog", { name: "选择当前对话的知识库与应用" });
  await expect(resourceDialog.getByRole("tab", { name: "知识库 [2]" })).toBeVisible();
  await expect(resourceDialog.getByRole("tab", { name: /应用/ })).toHaveCount(0);
});

test("Preview Host switches conversations without replacing the shell with the full-page boot gate", async ({
  context,
  page
}) => {
  const server = await installMatePreviewServer(page, context);
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`, {
    waitUntil: "domcontentloaded"
  });
  await expectPreviewHostReady(page, { conversationId: server.conversationId });
  server.delayNextSession(1_200);
  await page.getByRole("button", { name: /Second Preview conversation/ }).click();

  await expect(page.getByTestId(matePreview.host)).toBeVisible();
  await expect(page.getByTestId(matePreview.loading)).toHaveCount(0);
  await expect(page.getByText("正在打开 Mate Preview")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Second Preview conversation/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: /Second Preview conversation/ })).not.toHaveAttribute("aria-busy");
  await expect(page.getByRole("button", { name: /Second Preview conversation/ }).locator(".is-spinning")).toHaveCount(0);
  await expect(page.getByTestId("preview-conversation-switching")).toBeVisible();
  await expect(page.getByTestId("preview-conversation-switching")).toContainText("正在加载对话");
  await expectPreviewHostReady(page, { conversationId: server.secondConversationId });
  await expect(page.getByRole("button", { name: /Second Preview conversation/ })).toHaveAttribute("aria-current", "page");
});

test("Mate routes keep one pixel-agent launch gate through Portal and Session loading", async ({
  context,
  page
}) => {
  const server = await installMatePreviewServer(page, context, { sessionDelayMs: 1_200 });
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}`, {
    waitUntil: "domcontentloaded"
  });

  const gate = page.getByTestId(matePreview.loading);
  await expect(gate).toBeVisible();
  await expect(gate).toContainText("正在打开 Mate Preview");
  await expect(gate.locator("img")).toHaveAttribute("src", /running\.gif/);
  await expect(page.locator(".portal-boot-skeleton, .portal-route-loading-state")).toHaveCount(0);
  await expectPreviewHostReady(page);
});

test("returning to a Conversation paints its memory cache before background hydration", async ({
  context,
  page
}) => {
  const server = await installMatePreviewServer(page, context);
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`, {
    waitUntil: "domcontentloaded"
  });
  await expectPreviewHostReady(page, { conversationId: server.conversationId });
  const cachedText = "Cache this deterministic conversation";
  await sendWithProtocolDiagnostics(page, server, cachedText);
  await expectPreviewTurnSettled(page, "completed");
  await page.getByRole("button", { name: /Second Preview conversation/ }).click();
  await expectPreviewHostReady(page, { conversationId: server.secondConversationId });

  server.delayNextSession(1_200);
  server.delayNextHydration(1_200);
  await page.getByRole("button", { name: /Preview portfolio review/ }).click();
  await expect(page.getByTestId("preview-message-user").getByText(cachedText)).toBeVisible({ timeout: 700 });
  await expect(page.getByTestId("preview-conversation-cache")).toBeVisible();
  await expect(page.getByText("正在同步最新消息…")).toBeVisible();
  await expect(page.getByRole("button", { name: /Preview portfolio review/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: /Preview portfolio review/ })).not.toHaveAttribute("aria-busy");
  await expect(page.getByTestId(matePreview.loading)).toHaveCount(0);
  await expect(page.getByText("正在加载 Agent DO 对话记录…")).toHaveCount(0);
  await expectPreviewHostReady(page, { conversationId: server.conversationId });
});

test("reloading a Conversation paints its browser cache before server hydration", async ({ context, page }) => {
  const server = await installMatePreviewServer(page, context);
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`, {
    waitUntil: "domcontentloaded"
  });
  await expectPreviewHostReady(page, { conversationId: server.conversationId });
  const cachedText = "Keep this conversation after a browser reload";
  await sendWithProtocolDiagnostics(page, server, cachedText);
  await expectPreviewTurnSettled(page, "completed");
  await expect.poll(() => page.evaluate((text) => Object.keys(localStorage)
    .some((key) => key.startsWith("workspace.mate.transcript.v1:")
      && localStorage.getItem(key)?.includes(text)), cachedText)).toBe(true);

  server.delayNextHydration(5_000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("preview-message-user").getByText(cachedText)).toBeVisible({ timeout: 900 });
  await expectPreviewHostReady(page, { conversationId: server.conversationId });
});

test("Owner can clear Preview records and returns to a non-persisted draft", async ({
  context,
  page
}) => {
  const server = await installMatePreviewServer(page, context);
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`, {
    waitUntil: "domcontentloaded"
  });
  await expectPreviewHostReady(page, { conversationId: server.conversationId });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "清空 Preview 记录" }).click();

  await expect(page.getByTestId(matePreview.host)).toBeVisible();
  await expect(page.getByTestId(matePreview.loading)).toHaveCount(0);
  await expect.poll(server.clearRequestCount).toBe(1);
  await expect(page.getByTestId("preview-draft-surface")).toBeVisible();
  await expect(page.getByText("草稿 · 尚未创建")).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "活跃", exact: true })).toContainText("暂无活跃对话。");
  expect(server.conversationCommitCount()).toBe(0);
});

test("Preview Host keeps the hydrated conversation mounted across the former query refresh window", async ({
  context,
  page
}) => {
  test.setTimeout(50_000);
  const server = await installMatePreviewServer(page, context);
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}`, {
    waitUntil: "domcontentloaded"
  });
  await expectPreviewHostReady(page);
  const grants = server.previewGrantRequestCount();
  const hydrations = server.hydrationRequestCount();
  await page.waitForTimeout(31_000);
  await expect(page.getByTestId("preview-sdk-surface")).toBeVisible();
  await expect(page.getByText("正在加载 Agent DO 对话记录…")).toHaveCount(0);
  expect(server.previewGrantRequestCount()).toBe(grants);
  expect(server.hydrationRequestCount()).toBe(hydrations);
});

test("Preview Host clears one failed turn and accepts the next message without replacing the conversation", async ({
  context,
  page
}) => {
  const server = await installMatePreviewServer(page, context);
  server.failNextTurn("mate_chat_executor_unsupported");
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`, {
    waitUntil: "domcontentloaded"
  });
  await expectPreviewHostReady(page, {
    conversationId: server.conversationId,
    mode: "preview",
    releaseId: server.releaseId
  });

  await sendPreviewMessage(page, "First Preview turn fails deterministically");
  await expect(page.getByRole("alert")).toContainText("本次回复失败");
  await expect(page.getByRole("alert").locator("span")).toHaveAttribute("title", "mate_chat_executor_unsupported");
  await expect(page.locator("[data-connection-state]").first()).toHaveAttribute("data-connection-state", "connected");
  await expectPreviewTurnSettled(page, "failed");
  await expect(page.getByTestId("preview-message-user")).toHaveCount(1);

  await page.getByRole("button", { name: "继续对话" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectPreviewHostReady(page, {
    conversationId: server.conversationId,
    mode: "preview",
    releaseId: server.releaseId
  });

  await sendPreviewMessage(page, "Second Preview turn completes");
  await expectPreviewTurnSettled(page, "completed");
  await expect(page.getByTestId("preview-message-user")).toHaveCount(2);
  await expect(page.getByTestId("preview-message-assistant")).toHaveCount(1);
  expect(server.chatRequestCount()).toBe(2);
});

for (const finishesWhileAway of [false, true]) {
  test(`leaving an active conversation does not cancel or resubmit it (${finishesWhileAway ? "completed in background" : "attach to active stream"})`, async ({ page, context }) => {
    const server = await installMatePreviewServer(page, context);
    const route = `/mates/${server.mateId}/preview?release=${server.releaseId}`;
    server.pauseNextTurn();
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await expectPreviewHostReady(page);
    await sendPreviewMessage(page, "Keep working while I leave the page");
    await expect(page.getByTestId(matePreview.host)).toHaveAttribute("data-streaming", "true");
    await page.goto("about:blank");
    expect(server.cancellationRequestCount()).toBe(0);
    if (finishesWhileAway) server.completeActiveInBackground();
    const resumeCount = server.resumeRequestCount();
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Synthetic answer 1 for", { exact: false })).toBeVisible();
    if (!finishesWhileAway) {
      expect(server.resumeRequestCount()).toBeGreaterThan(resumeCount);
      expect(server.resumeAcknowledgementCount()).toBeGreaterThan(0);
    }
    expect(server.chatRequestCount()).toBe(1);
    expect(server.cancellationRequestCount()).toBe(0);
    await expect(page.getByTestId("preview-message-user")).toHaveCount(1);
    await expect(page.getByTestId("preview-message-assistant")).toHaveCount(1);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

test("a tool-only budget pause survives reload and Continue starts a linked execution", async ({ page, context }) => {
  const server = await installMatePreviewServer(page, context);
  server.yieldNextTurn();
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}`, { waitUntil: "domcontentloaded" });
  await expectPreviewHostReady(page);
  await sendPreviewMessage(page, "A long task pauses at a tool boundary");
  await expect(page.getByText("任务已暂停，进度已保存，可以继续执行。", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("preview-turn-process").first()).toHaveAttribute("data-status", "paused");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("preview-resume")).toBeVisible();
  await page.getByTestId("preview-resume").click();
  await expect(page.getByText("Synthetic answer 2 for", { exact: false })).toBeVisible();
  expect(server.continuationMessageIds()).toEqual(["assistant-preview-1"]);
  expect(server.chatRequestCount()).toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

async function messageIds(page: Parameters<typeof expectPreviewHostReady>[0]) {
  return page.locator("[data-message-id]").evaluateAll((messages) => (
    messages.map((message) => message.getAttribute("data-message-id") ?? "")
  ));
}

async function assertNoCredentialPersistence(page: Parameters<typeof expectPreviewHostReady>[0]) {
  const clean = await page.evaluate(() => {
    const url = new URL(window.location.href);
    const jwt = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
    if ([...url.searchParams].some(([key, value]) => (
      /token|grant|authorization|bearer/i.test(key) || jwt.test(value)
    ))) return false;
    if (jwt.test(document.body.textContent ?? "") || (document.body.textContent ?? "").includes("mock.preview.grant")) {
      return false;
    }
    return [window.localStorage, window.sessionStorage].every((storage) => (
      Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? "")
        .every((key) => {
          const value = storage.getItem(key) ?? "";
          return !/token|grant|authorization|bearer/i.test(key)
            && !jwt.test(value)
            && !value.includes("mock.preview.grant");
        })
    ));
  });
  expect(clean).toBe(true);
  await expect(debugField(page, "mode")).toHaveText("preview");
}

async function sendWithProtocolDiagnostics(
  page: Parameters<typeof expectPreviewHostReady>[0],
  server: Awaited<ReturnType<typeof installMatePreviewServer>>,
  text: string
) {
  try {
    await sendPreviewMessage(page, text);
  } catch (error) {
    const code = error instanceof Error ? error.message : "preview_send_failed";
    throw new Error(
      `${code}:chat_requests_${server.chatRequestCount()}`
      + `:invalid_requests_${server.invalidChatRequestCount()}`
    );
  }
}

for (const outcome of ["denied", "completed", "failed"] as const) {
  test(`HITL shared message follows Runtime ${outcome} and survives remount`, async ({ page }) => {
    await page.route("**/hitl-component-test", (route) => route.fulfill({ contentType: "text/html", body: '<div id="hitl-test"></div>' }));
    await page.goto("/hitl-component-test");
    await page.evaluate(async (outcome) => {
      const refreshPath = "/@react-refresh";
      const refresh = (await import(refreshPath)).default;
      refresh.injectIntoGlobalHook(window);
      Object.assign(window, { $RefreshReg$: () => {}, $RefreshSig$: () => (type: unknown) => type, __vite_plugin_react_preamble_installed__: true });
      const reactPath = "/node_modules/.vite/deps/react.js";
      const clientPath = "/node_modules/.vite/deps/react-dom_client.js";
      const approvalsPath = "/src/components/FolderEditApprovals.tsx";
      const messagePath = "/src/components/MessageRenderer.tsx";
      const localePath = "/src/locale.tsx";
      const [reactModule, clientModule, approvalsModule, messageModule, localeModule] = await Promise.all([
        import(reactPath), import(clientPath), import(approvalsPath), import(messagePath), import(localePath)
      ]);
      const React = reactModule.default ?? reactModule;
      const client = clientModule.default ?? clientModule;
      let approval = {
        id: "hitl-approval", taskId: "hitl-task", status: "pending", conversationId: "hitl-conversation", releaseId: "hitl-release",
        expiresAt: "2099-01-01T00:00:00.000Z", riskLevel: "high", operation: { type: "workspace_pass_mcp_tool_call", toolName: "forum_write" }
      };
      const task = { id: "hitl-task", status: "waiting_for_approval", conclusion: { summary: "" } };
      const message = { id: "hitl-message", role: "assistant", parts: [
        { type: "dynamic-tool", toolName: "forum_write", state: "output-available", output: { approval: { ...approval } } },
        { type: "text", text: "历史提案：pending / waiting_for_approval" },
        { type: "data-mate-process", data: { schemaVersion: "workspace.mate-process/v1", startedAt: "2026-10-08T00:00:00.000Z", status: "completed" } }
      ] };
      const accessToken = async () => "synthetic-runtime-token";
      const fetcher = async (input: string, init: RequestInit) => {
        if ((init.headers as Record<string, string>).Authorization !== "Bearer synthetic-runtime-token") throw new Error("unauthenticated_read");
        if (input.endsWith("/decision")) {
          const decision = JSON.parse(init.body as string).decision;
          if (decision !== (outcome === "denied" ? "deny" : "approve")) throw new Error("incorrect_decision");
          approval = { ...approval, status: outcome === "denied" ? "denied" : "consumed" };
          task.status = outcome === "denied" ? "cancelled" : outcome;
          task.conclusion.summary = `Runtime result: ${outcome}`;
          return Response.json({ approval, task });
        }
        if (input.includes("/tasks?")) return Response.json({ tasks: [task] });
        return Response.json({ approvals: [approval, { ...approval, id: "another-conversation", conversationId: "other", status: "pending" }] });
      };
      function Harness() {
        const [states, setStates] = React.useState([]);
        const [version, setVersion] = React.useState(0);
        return React.createElement(localeModule.MateLocaleProvider, null,
          React.createElement(messageModule.MateMessage, { message, approvals: states, mate: { displayName: "Test Mate" } }),
          React.createElement(approvalsModule.FolderEditApprovals, {
            key: version, session: { mode: "live", runtimeOrigin: "https://synthetic.test", mate: { id: "test-mate" }, release: { id: "hitl-release" } },
            accessToken, fetcher, refreshKey: "1", conversationId: "hitl-conversation", onStateChange: setStates
          }),
          React.createElement("button", { onClick: () => setVersion(version + 1) }, "Remount from Runtime")
        );
      }
      client.createRoot(document.getElementById("hitl-test")).render(React.createElement(Harness));
    }, outcome);
    const process = page.getByTestId("preview-turn-process");
    await expect(process).toHaveAttribute("data-status", "waiting");
    await expect(process).toContainText("提案已生成，等待审核");
    await expect(page.getByRole("button", { name: "拒绝此项", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: outcome === "denied" ? "拒绝此项" : "确认这项修改", exact: true }).click();
    const status = outcome === "denied" ? "cancelled" : outcome;
    const label = outcome === "denied" ? "未获批准，已取消" : outcome === "completed" ? "审核通过，执行成功" : "审核通过，执行失败";
    await expect(process).toHaveAttribute("data-status", status);
    await expect(process).toContainText(label);
    await expect(page.getByRole("button", { name: "拒绝此项", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("preview-message-assistant")).toContainText("历史提案：pending / waiting_for_approval");
    await expect(page.getByTestId("preview-message-assistant")).toContainText("最新审核与执行状态请见处理过程");
    await page.getByRole("button", { name: "Remount from Runtime" }).click();
    await expect(process).toHaveAttribute("data-status", status);
    await expect(process).toContainText(label);
  });
}

test("a long return guides recovery of the same conversation and preserves unsent input without replay", async ({ context, page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  const server = await installMatePreviewServer(page, context, { sessionExpiresAt: new Date(now + 5 * 60_000).toISOString(), rotateSessionToken: true });
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`);
  await expectPreviewHostReady(page);
  await sendPreviewMessage(page, "Completed before leaving");
  await expectPreviewTurnSettled(page, "completed");
  const ids = await messageIds(page);
  const composer = page.getByTestId(matePreview.composer).getByRole("textbox");
  await composer.fill("Unsent draft must survive reconnect");
  const requests = server.chatRequestCount();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.clock.setSystemTime(now + 31 * 60_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const dialog = page.getByRole("dialog", { name: "重新连接当前对话" });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId(matePreview.host)).toHaveAttribute("data-connection-state", "error");
  await expect(composer).toHaveValue("Unsent draft must survive reconnect");
  await expect(dialog.getByRole("button")).toHaveCount(2);
  await expect(dialog).toContainText("您长时间没有操作，为了保护你的对话安全，进入到休眠状态，请重新点击连接");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  server.setSessionExpiresAt("2099-08-27T10:05:00.000Z");
  const sessions = server.previewSessionRequestCount();
  await dialog.getByRole("button", { name: "重新连接", exact: true }).click();
  await expectPreviewHostReady(page, { conversationId: server.conversationId });
  await expect(dialog).toHaveCount(0);
  await expect(composer).toHaveValue("Unsent draft must survive reconnect");
  expect(await messageIds(page)).toEqual(ids);
  expect(server.chatRequestCount()).toBe(requests);
  expect(server.previewSessionRequestCount()).toBe(sessions + 1);
  await expect.poll(() => server.profileAuthorizationHeaders().at(-1)).toBe(`Bearer eyJtb2NrIjp0cnVlfQ.eyJtb2NrIjp0cnVlfQ.mock-signature-${sessions + 1}`);
});

test("active use is not interrupted at 30 minutes and authentication failure ends preparing with one recovery prompt", async ({ context, page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  const server = await installMatePreviewServer(page, context);
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`);
  await expectPreviewHostReady(page);
  for (let minute = 1; minute <= 31; minute += 1) {
    await page.clock.setSystemTime(now + minute * 60_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  }
  await expect(page.getByRole("dialog", { name: "重新连接当前对话" })).toHaveCount(0);
  server.failNextTurn("runtime_token_invalid");
  await sendPreviewMessage(page, "Authentication failure must not look connected");
  const dialog = page.getByRole("dialog", { name: "重新连接当前对话" });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId(matePreview.host)).toHaveAttribute("data-connection-state", "error");
  await expect(page.getByTestId("preview-pending-turn")).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭当前对话" }).click();
  await expect(page.getByTestId("preview-draft-surface")).toBeVisible();
  await page.clock.setSystemTime(now + 32 * 60_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog).toHaveCount(0);
});

test("recovery refuses a switched conversation and retains the visible history and draft", async ({ context, page }) => {
  const server = await installMatePreviewServer(page, context);
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`);
  await expectPreviewHostReady(page);
  await sendPreviewMessage(page, "Keep this history");
  await expectPreviewTurnSettled(page, "completed");
  const ids = await messageIds(page);
  const composer = page.getByTestId(matePreview.composer).getByRole("textbox");
  await composer.fill("Keep this draft");
  server.changeNextSessionConversation(server.secondConversationId);
  await page.getByRole("button", { name: "打开调试", exact: true }).click();
  await page.getByTestId("preview-reconnect").click();
  const dialog = page.getByRole("dialog", { name: "重新连接当前对话" });
  await expect(dialog).toBeVisible();
  expect(await messageIds(page)).toEqual(ids);
  await expect(composer).toHaveValue("Keep this draft");
  await expect(debugField(page, "conversation")).toHaveText(server.conversationId);
  expect(server.chatRequestCount()).toBe(1);
});

test("closing a sleeping conversation leaves the old chat without replaying messages", async ({ context, page }) => {
  const server = await installMatePreviewServer(page, context);
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`);
  await expectPreviewHostReady(page);
  server.failNextTurn("runtime_token_invalid");
  await sendPreviewMessage(page, "Never replay this failed request");
  const dialog = page.getByRole("dialog", { name: "重新连接当前对话" });
  await expect(dialog).toBeVisible();
  const requests = server.chatRequestCount();
  await dialog.getByRole("button", { name: "关闭当前对话" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("preview-draft-surface")).toBeVisible();
  expect(server.chatRequestCount()).toBe(requests);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog).toHaveCount(0);
});

test("a hanging reconnect times out and can be retried without replaying messages", async ({ context, page }) => {
  await page.clock.install();
  const server = await installMatePreviewServer(page, context);
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`);
  await expectPreviewHostReady(page);
  server.failNextTurn("runtime_token_invalid");
  await sendPreviewMessage(page, "Do not replay after timeout");
  const dialog = page.getByRole("dialog", { name: "重新连接当前对话" });
  await expect(dialog).toBeVisible();
  let stall = true;
  await page.route("**/api/mate-runtime/preview-sessions", (route) => {
    if (stall) { stall = false; return; }
    return route.fallback();
  });
  const messages = server.chatRequestCount();
  await dialog.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "正在重新连接…" })).toBeDisabled();
  await page.clock.runFor(15_001);
  await expect(dialog.getByRole("alert")).toContainText("暂时无法恢复连接");
  await expect(dialog.getByRole("button", { name: "重新连接", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "重新连接", exact: true }).click();
  await expectPreviewHostReady(page, { conversationId: server.conversationId });
  await expect(dialog).toHaveCount(0);
  expect(server.chatRequestCount()).toBe(messages);
});

test("Conversation tabs paginate independently and restore a failed optimistic archive", async ({ context, page }) => {
  const server = await installMatePreviewServer(page, context);
  const collections = {
    active: Array.from({ length: 125 }, (_, index) => ({
      id: index === 0 ? server.conversationId : `active-page-${index}`,
      title: `分页活跃 ${index + 1}`, channel: "sdk", status: "active", updatedAt: "2026-10-08T00:00:00Z"
    })),
    archived: Array.from({ length: 125 }, (_, index) => ({
      id: `archived-page-${index}`, title: `分页存档 ${index + 1}`, channel: "sdk", status: "archived", updatedAt: "2026-10-08T00:00:00Z"
    }))
  };
  await page.route("**/conversations?status=*", async (route) => {
    const url = new URL(route.request().url());
    const status = url.searchParams.get("status") as keyof typeof collections;
    const offset = Number(url.searchParams.get("cursor") || 0);
    await route.fulfill({ json: {
      conversations: collections[status].slice(offset, offset + 50),
      nextCursor: offset + 50 < collections[status].length ? String(offset + 50) : null
    } });
  });
  let rejectArchive: (() => void) | undefined;
  await page.route("**/conversations/active-page-1", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await new Promise<void>((resolve) => { rejectArchive = resolve; });
    await route.fulfill({ status: 503, json: { error: "archive_failed" } });
  });
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`, { waitUntil: "domcontentloaded" });
  await expectPreviewHostReady(page, { conversationId: server.conversationId });
  const rows = page.locator(".tm-preview-directory-item");
  const more = page.getByRole("button", { name: "加载更多", exact: true });
  await expect(rows).toHaveCount(50);
  await more.click();
  await expect(rows).toHaveCount(100);
  await page.getByRole("tab", { name: "已存档", exact: true }).click();
  await expect(rows).toHaveCount(50);
  await more.click();
  await expect(rows).toHaveCount(100);
  await more.click();
  await expect(rows).toHaveCount(125);
  await expect(more).toHaveCount(0);
  await page.getByRole("tab", { name: "活跃", exact: true }).click();
  await expect(rows).toHaveCount(100);
  const item = page.getByRole("button", { name: /^分页活跃 2 / });
  await item.click({ button: "right" });
  await page.getByRole("menuitem", { name: "存档", exact: true }).click();
  await expect(item).toHaveCount(0);
  await expect(rows).toHaveCount(99);
  await expect(page.getByRole("tab", { name: "活跃", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => Boolean(rejectArchive)).toBe(true);
  rejectArchive!();
  await expect(item).toBeVisible();
  await expect(rows).toHaveCount(100);
  await expect(page.getByRole("alert")).toBeVisible();
});

test("English sleep recovery uses shared action buttons and translated failure guidance", async ({ context, page }) => {
  await page.addInitScript(() => window.localStorage.setItem("workspace-mate-locale-v1", "en"));
  const server = await installMatePreviewServer(page, context);
  await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`);
  await expectPreviewHostReady(page);
  server.failNextTurn("runtime_token_invalid");
  await sendPreviewMessage(page, "Trigger English recovery");
  const dialog = page.getByRole("dialog", { name: "Reconnect this conversation" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Your conversation has entered sleep mode after a long period of inactivity to keep it secure. Please reconnect to continue.");
  await expect(dialog.getByRole("button")).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: "Close conversation" })).toHaveClass(/secondaryButton/);
  const reconnect = dialog.getByRole("button", { name: "Reconnect", exact: true });
  await expect(reconnect).toHaveClass(/primaryButton/);
  await expect(reconnect).toBeFocused();
  await page.route("**/api/mate-runtime/preview-sessions", (route) => route.fulfill({ status: 401, contentType: "application/json", json: { error: "runtime_token_invalid" } }));
  await reconnect.click();
  await expect(dialog.getByRole("alert")).toHaveText("Could not restore the connection. Please try again shortly.");
  await expect(reconnect).toBeEnabled();
});
for (const failPin of [false, true]) {
  test(`pinning moves an older conversation immediately and ${failPin ? "rolls back on failure" : "keeps its position after confirmation"}`, async ({ context, page }) => {
    const server = await installMatePreviewServer(page, context);
    let releasePin: (() => void) | undefined;
    await page.route("**/conversations/*", async (route) => {
      if (route.request().method() !== "PATCH" || route.request().postDataJSON()?.pinned !== true) return route.fallback();
      await new Promise<void>((resolve) => { releasePin = resolve; });
      if (failPin) await route.fulfill({ status: 503, json: { error: "pin_failed" } });
      else await route.fallback();
    });
    await page.goto(`/mates/${server.mateId}/preview?release=${server.releaseId}&debug=1`, { waitUntil: "domcontentloaded" });
    await expectPreviewHostReady(page, { conversationId: server.conversationId });
    const rows = page.locator(".tm-preview-directory-item");
    const first = rows.first();
    await expect(first).toContainText("Preview portfolio review");
    await page.getByRole("button", { name: /Second Preview conversation/ }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
    await expect(first).toContainText("Second Preview conversation");
    await expect(first.locator("button:first-child > svg.lucide-pin")).toHaveCount(1);
    await expect(first.locator(".lucide-message-square-text")).toHaveCount(0);
    await expect(first.locator("strong svg")).toHaveCount(0);
    await expect(rows.last()).toContainText("Preview portfolio review");
    await expect.poll(() => Boolean(releasePin)).toBe(true);
    releasePin!();
    if (failPin) {
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(first).toContainText("Preview portfolio review");
      await expect(page.getByLabel("已置顶", { exact: true })).toHaveCount(0);
      await expect(rows.last().locator(".lucide-message-square-text")).toHaveCount(1);
    } else {
      await expect(first.getByRole("button", { name: /Second Preview conversation/ })).toBeEnabled();
      await expect(first).toContainText("Second Preview conversation");
      await expect(first.locator("button:first-child > svg.lucide-pin")).toHaveCount(1);
    }
  });
}


test("Portal locale overrides a stale Mate preference and updates all mounted surfaces", async ({ context, page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("workspace-ai:locale", "en");
    window.localStorage.setItem("workspace-mate-locale-v1", "zh-CN");
  });
  const server = await installMatePreviewServer(page, context, { mode: "live" });
  const hostPath = fileURLToPath(new URL("../../apps/mate-preview/fixtures/localeHost.tsx", import.meta.url));
  await page.route("**/src/main.tsx", (route) => route.fulfill({ contentType: "application/javascript", body: `import ${JSON.stringify(`/@fs/${hostPath}`)};` }));
  await page.route("**/auth/miniapp/login-tickets", (route) => route.fulfill({ json: {
    ticket: "synthetic_miniapp_ticket_123456", expiresAt: "2099-10-09T00:00:00Z",
    qrImageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
  } }));
  await page.route("**/auth/miniapp/login-tickets/*/status", (route) => route.fulfill({ json: { status: "pending" } }));
  await page.goto("/");
  await expect(page.getByTestId("preview-sdk-surface")).toBeVisible();
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.getByTestId("preview-draft-surface")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What would you like to discuss with Preview E2E Mate?" })).toBeVisible();
  await expect(page.locator(".tm-preview-welcome")).toContainText("Your work assistant for everyday tasks.");
  await expect(page.getByRole("button", { name: "New conversation", exact: true })).toBeVisible();
  await expect(page.locator(".tm-preview-connection")).toContainText("Connection:");
  await expect(page.getByTestId("preview-composer").getByRole("textbox")).toHaveAttribute("placeholder", "Ask a question or send Preview E2E Mate a message…");
  await expect(page.locator(".tm-preview-directory-item time").first()).toContainText(/m$/);
  const sessions = server.previewSessionRequestCount();
  await page.getByTestId("preview-composer").getByRole("button", { name: /Knowledge & apps/ }).click();
  const resources = page.locator(".tm-preview-resource-popover");
  await expect(resources).toBeVisible();
  await expect(resources.getByRole("tab", { name: /Knowledge/ })).toBeVisible();
  await expect(resources.getByRole("button", { name: /Clear all/ })).toBeVisible();
  await page.getByRole("button", { name: "Portal 中文" }).click();
  await page.getByTestId("preview-composer").getByRole("button", { name: /知识库与应用/ }).click();
  await expect(resources).toHaveAttribute("aria-label", "选择当前对话的知识库与应用");
  await expect(page.locator(".tm-preview-welcome")).toContainText("你的工作秘书，处理日常事务。");
  await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "通过微信访问", exact: true }).click();
  const wechat = page.locator(".tm-weixin-dialog");
  await expect(wechat).toContainText("使用微信扫一扫登录小程序");
  await page.getByRole("button", { name: "Portal English" }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(wechat).toHaveAccessibleName("Access through WeChat");
  await expect(wechat).toContainText("Scan with WeChat to sign in to the miniapp");
  await expect(wechat).toContainText("Waiting for WeChat scan");
  await expect(wechat.getByRole("tab", { name: "WeChat Q-Claw connection" })).toBeVisible();
  await expect(wechat.getByRole("button", { name: "Close WeChat access" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(server.previewSessionRequestCount()).toBe(sessions);
  expect(await page.evaluate(() => window.localStorage.getItem("workspace-mate-locale-v1"))).toBe("zh-CN");
  await wechat.getByRole("button", { name: "Close WeChat access" }).click();
  await page.getByRole("button", { name: "Open current user settings" }).click();
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await page.route("**/auth/miniapp/login-tickets", (route) => route.fulfill({ status: 401, json: { error: "login_required" } }));
  await page.getByRole("button", { name: "通过微信访问", exact: true }).click();
  await expect(wechat.getByRole("alert")).toHaveText("请先登录 Workspace Web，再生成小程序登录码。");
  await page.getByRole("button", { name: "Portal English" }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(wechat.getByRole("alert")).toHaveText("Sign in to Workspace Web before generating a miniapp code.");
});
