import { expect, test, type Page } from "@playwright/test";
import { fallbackPortal } from "../../src/shared/fallbackPortal";
import type { Discussion } from "../../src/shared/types";
import { mockPortalApis } from "./fixtures/portalApi";

const topicId = "discussion-contract-review";
const screenshotDir = "artifacts/copy-for-agent-flow";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1440 });
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "zh-CN"));
});

test("copies a forum post for the Agent when Workspace MCP is active", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:5174" });
  await mockCopyForAgentForum(page);
  await page.unroute("**/api/mcp/connections/status");
  let statusChecks = 0;
  await page.route("**/api/mcp/connections/status", (route) => {
    statusChecks += 1;
    return route.fulfill({
      contentType: "application/json",
      json: {
        status: {
          activeCount: 1,
          connected: true,
          connections: [{ id: "mcp-local-active", status: "active" }],
          maxActiveConnections: 3
        }
      }
    });
  });

  await page.goto(`/#/posts/${topicId}`);
  await expect(page.getByRole("heading", { level: 1, name: baseTopicTitle() })).toBeVisible();

  const postActions = page.locator(".portal-post-actions");
  const handoff = postActions.locator(".agentHandoffButton");
  expect(statusChecks).toBe(0);
  await expect(handoff).toBeVisible();
  await expect(handoff).toHaveAccessibleName("Copy for Agent");
  await expect(handoff).toHaveCSS("background-color", "rgb(17, 17, 15)");
  await expect(handoff.locator("img")).toHaveAttribute("src", /Workspace%20Pass%20MCP%20signal/);
  await expect(handoff.locator("img")).toHaveAttribute("src", /%23B7F43A/);
  await expect(postActions.locator(":scope > *").nth(0)).toHaveClass(/agentHandoffButton/);
  await expect(postActions.locator(":scope > *").nth(1)).toHaveClass(/forumReactionBar/);
  await page.screenshot({ path: `${screenshotDir}/01-default-button.png` });

  await handoff.click();
  await expect.poll(() => statusChecks).toBe(1);
  await expect(handoff).toHaveAccessibleName("指令已复制");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("请通过 Workspace MCP 接手这个 Forum Post。");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`请先调用 forum_read，并传入 action="get_topic"、topicId="${topicId}"`);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toContain("Take over this Forum Post");
  expect(statusChecks).toBe(1);
  await page.screenshot({ path: `${screenshotDir}/02-connected-copied.png` });

  await page.getByRole("button", { exact: true, name: "切换语言" }).click();
  await page.getByRole("option", { exact: true, name: "EN" }).click();
  await handoff.click();
  await expect(handoff).toHaveAccessibleName("Instruction copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("Take over this Forum Post through Workspace MCP.");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`First call forum_read with action="get_topic" and topicId="${topicId}"`);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toContain("请通过 Workspace MCP");
  expect(statusChecks).toBe(1);

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: baseTopicTitle() })).toBeVisible();
  expect(statusChecks).toBe(1);
  const cachedHandoff = page.locator(".portal-post-actions .agentHandoffButton");
  await cachedHandoff.click();
  await expect(cachedHandoff).toHaveAccessibleName("指令已复制");
  expect(statusChecks).toBe(1);
});

test("guides an unconnected user through Agent selection and setup", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:5174" });
  await mockCopyForAgentForum(page);
  await page.unroute("**/api/mcp/connections/status");
  let connected = false;
  let statusChecks = 0;
  await page.route("**/api/mcp/connections/status", (route) => {
    statusChecks += 1;
    return route.fulfill({
      contentType: "application/json",
      json: {
        status: {
          activeCount: connected ? 1 : 0,
          connected,
          connections: connected ? [{ id: "mcp-local-reconnected", status: "active" }] : [],
          maxActiveConnections: 3
        }
      }
    });
  });

  await page.goto(`/#/posts/${topicId}`);
  await expect(page.getByRole("heading", { level: 1, name: baseTopicTitle() })).toBeVisible();

  const handoff = page.locator(".portal-post-actions").getByRole("button", { name: "Copy for Agent" });
  expect(statusChecks).toBe(0);
  await handoff.click();
  await expect.poll(() => statusChecks).toBe(1);

  const guide = page.getByRole("dialog", { name: "Workspace MCP Agent 转交引导" });
  await expect(guide).toBeVisible();
  await expect(guide.getByRole("heading", { name: "连接后，Agent 才能安全接手" })).toBeVisible();
  const agentOptions = guide.getByRole("radio");
  await expect(agentOptions).toHaveCount(4);
  await expect(agentOptions.nth(0)).toHaveAccessibleName("WorkBuddy");
  const workBuddy = guide.getByRole("radio", { name: "WorkBuddy" });
  await expect(workBuddy).toHaveAttribute("aria-checked", "true");
  await expect(guide.getByRole("heading", { name: "连接 WorkBuddy" })).toBeVisible();
  await expect(guide.getByRole("link", { name: "为什么需要 Workspace MCP？" })).toHaveAttribute(
    "href",
    "#/posts/forum-topic-workspace-ai-mcp-guide"
  );
  await page.screenshot({ path: `${screenshotDir}/03-no-connection-guide.png` });

  await page.screenshot({ path: `${screenshotDir}/04-workbuddy-default.png` });

  const copySetup = guide.getByRole("button", { name: "复制安装指令" });
  await copySetup.click();
  await expect(guide.getByRole("button", { name: "指令已复制" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("为 WorkBuddy 连接当前企业的 MCP");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("OAuth");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("ping_who_am_i");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("https://mcp.example.invalid/mcp");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toContain("llms.txt");
  await page.screenshot({ path: `${screenshotDir}/05-install-prompt-copied.png` });

  connected = true;
  await guide.getByRole("button", { name: "我已连接，重新检查" }).click();
  await expect(guide).toBeHidden();
  await expect(page.locator(".portal-post-actions .agentHandoffButton")).toHaveAccessibleName("指令已复制");
  expect(statusChecks).toBe(2);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(topicId);
  await page.screenshot({ path: `${screenshotDir}/06-retry-connected-copied.png` });
});

async function mockCopyForAgentForum(page: Page) {
  const baseDiscussion = fallbackPortal.discussions.find((discussion) => discussion.id === topicId)
    ?? fallbackPortal.discussions[0];
  const discussion: Discussion = {
    ...structuredClone(baseDiscussion),
    replies: 1,
    replyPosts: [{
      id: "reply-copy-for-agent",
      author: "Faye Wang",
      authorEmail: "faye@example.test",
      body: "请 Agent 帮我继续处理这个回复。",
      createdAt: "2026-07-31T10:20:00.000Z",
      likes: 0,
      reactions: [],
      source: "portal"
    }]
  };
  await mockPortalApis(page, {
    catalog: {
      json: {
        ...structuredClone(fallbackPortal),
        discussions: [
          discussion,
          ...fallbackPortal.discussions.filter((item) => item.id !== discussion.id)
        ]
      }
    }
  });

  await page.route(`**/api/forum/topics/${topicId}`, (route) => route.fulfill({
    contentType: "application/json",
    json: { discussion }
  }));
}

function baseTopicTitle() {
  return fallbackPortal.discussions.find((discussion) => discussion.id === topicId)?.title
    ?? fallbackPortal.discussions[0].title;
}
