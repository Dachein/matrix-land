import { expect, test, type Page } from "@playwright/test";
import { fallbackPortal } from "../../src/shared/fallbackPortal";
import type { Discussion, DiscussionAttachment, DiscussionReply, PortalCatalog } from "../../src/shared/types";

type ForumRequestState = {
  appRequestPaths: string[];
  replyReactionPayloads: unknown[];
  replyPayloads: unknown[];
  topicDetailIds: string[];
  topicPayloads: unknown[];
  topicReactionPayloads: unknown[];
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
});

test("loads a post through its canonical topic endpoint even when it is already cached", async ({ page }) => {
  const state = await mockPortalForum(page);
  await page.goto("/#/posts/discussion-contract-review");

  await expect(page.getByRole("heading", { level: 1, name: "How should high-risk legal write scopes be confirmed?" })).toBeVisible();
  await expect.poll(() => state.topicDetailIds).toEqual(["discussion-contract-review"]);
});

test("streamlines the empty reply composer into one writing surface", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await mockPortalForum(page, {
    forumDiscussionPatch: { replies: 0, replyPosts: [] }
  });
  await page.goto("/#/posts/discussion-contract-review");

  const replies = page.locator("#forum-replies");
  const composer = replies.locator("#forum-reply-composer");
  const textarea = composer.locator(".forumPlainTextArea");
  const editorLauncher = composer.getByRole("button", { name: "Markdown Editor", exact: true });

  await expect(replies.getByText("No replies yet.", { exact: true })).toBeVisible();
  await expect(page.getByText("0 replies", { exact: true })).toHaveCount(0);
  await expect(replies.getByText(/Switch to/i)).toHaveCount(0);

  const geometry = await composer.evaluate((form) => {
    const textarea = form.querySelector<HTMLTextAreaElement>(".forumPlainTextArea")!;
    const launcher = form.querySelector<HTMLElement>(".markdownExpandButton")!;
    const formBox = form.getBoundingClientRect();
    const textareaBox = textarea.getBoundingClientRect();
    const launcherBox = launcher.getBoundingClientRect();
    const formStyle = window.getComputedStyle(form);
    const launcherStyle = window.getComputedStyle(launcher);
    return {
      borderLeftWidth: formStyle.borderLeftWidth,
      launcherBorderRadius: launcherStyle.borderRadius,
      launcherInsideTextarea: launcherBox.top > textareaBox.bottom - 48
        && launcherBox.right < textareaBox.right
        && launcherBox.bottom < textareaBox.bottom,
      paddingLeft: formStyle.paddingLeft,
      textareaFlushLeft: Math.abs(textareaBox.left - formBox.left),
      textareaFlushRight: Math.abs(textareaBox.right - formBox.right)
    };
  });

  expect(geometry.borderLeftWidth).toBe("0px");
  expect(geometry.launcherBorderRadius).toBe("0px");
  expect(geometry.paddingLeft).toBe("0px");
  expect(geometry.launcherInsideTextarea).toBe(true);
  expect(geometry.textareaFlushLeft).toBeLessThanOrEqual(1);
  expect(geometry.textareaFlushRight).toBeLessThanOrEqual(1);
  await textarea.fill("Reply draft stays editable");
  await editorLauncher.click();
  await expect(page.getByRole("dialog", { name: "Markdown Editor" }).locator("[contenteditable='true']"))
    .toContainText("Reply draft stays editable");
});

test("keeps anonymous reply controls text-first and visually unboxed", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await mockPortalForum(page);
  await page.goto("/#/posts/discussion-contract-review");

  const composer = page.locator("#forum-reply-composer");
  const anonymousToggle = composer.getByRole("checkbox", { name: "Reply anonymously" });
  const toggleLabel = composer.locator(".forumAnonymousToggle");
  await expect(toggleLabel.locator(".lucide-eye-off")).toHaveCount(0);

  await anonymousToggle.check();
  const picker = composer.locator(".forumAnonymousPersonaPicker");
  await expect(picker).toBeVisible();
  await expect(picker).toHaveCSS("border-top-width", "0px");
  await expect(picker).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(composer.getByRole("button", { name: "Try another anonymous character" }))
    .toContainText("Try another");
});

test("paginates the home feed and defers fresh topics while the reader is deep in the list", async ({ page }) => {
  await page.setViewportSize({ height: 760, width: 1440 });
  await mockPortalForum(page);
  const template = structuredClone(fallbackPortal.discussions[0]) as Discussion;
  const topic = (id: string, index: number, title = id): Discussion => ({
    ...structuredClone(template),
    body: `${title} body`,
    excerpt: `${title} excerpt`,
    id,
    lastActive: `2026-07-24T${String(20 - index).padStart(2, "0")}:00:00.000Z`,
    pinned: false,
    title
  });
  const pinned = { ...topic("pinned-home", 20, "Pinned home topic"), pinned: true };
  const baseline = Array.from({ length: 12 }, (_, index) => topic(`home-${index + 1}`, index));
  const pageTwo = [topic("home-13", 13), topic("home-14", 14)];
  const freshTopic = topic("home-fresh", -1, "Fresh forum topic");
  const filteredTopic = topic("home-filtered", 4, "Agent workflow search result");
  let fresh = false;

  await page.route(/\/api\/forum\/topics(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    const url = new URL(route.request().url());
    if (url.searchParams.get("q")) {
      await route.fulfill({
        contentType: "application/json",
        json: { discussions: [filteredTopic], pinnedDiscussions: [] }
      });
      return;
    }
    if (url.searchParams.get("cursor")) {
      await route.fulfill({
        contentType: "application/json",
        json: { discussions: pageTwo, pinnedDiscussions: [] }
      });
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        discussions: fresh ? [freshTopic, ...baseline.slice(0, 11)] : baseline,
        nextCursor: "cursor-page-2",
        pinnedDiscussions: [pinned]
      }
    });
  });

  await page.goto("/#/home");
  await expect(page.locator("#discussion-home-1")).toBeVisible();
  const firstFourIds = await page.locator(".portal-feed-list > .portal-feed-row").evaluateAll(
    (rows) => rows.slice(0, 4).map((row) => row.id)
  );
  expect(firstFourIds).toEqual([
    "discussion-home-1",
    "discussion-home-2",
    "discussion-pinned-home",
    "discussion-home-3"
  ]);

  await page.locator("#discussion-home-9").scrollIntoViewIfNeeded();
  fresh = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const freshNotice = page.getByRole("button", { name: "New topics: 1 — click to view" });
  await expect(freshNotice).toBeVisible();
  await expect(page.locator("#discussion-home-fresh")).toHaveCount(0);
  await freshNotice.click();
  await expect(page.locator("#discussion-home-fresh")).toBeAttached();

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.locator("#discussion-home-14")).toBeAttached();

  await page.getByRole("searchbox", { name: "Search community topics" }).fill("agent workflow");
  await expect(page.locator("#discussion-home-filtered")).toBeVisible();
  await expect(page.locator("#discussion-home-1")).toHaveCount(0);
});

test("accepts pasted Markdown with fenced code blocks", async ({ page }) => {
  const state = await mockPortalForum(page);
  await page.goto("/#/home");

  await page.getByRole("button", { name: "New post" }).first().click();
  const composer = page.getByRole("dialog", { name: "New Topic" });
  await composer.locator(".titleField input").fill("Markdown paste contract");
  await composer.getByRole("button", { name: "Markdown Editor", exact: true }).click();
  const expandedEditor = page.getByRole("dialog", { name: "Markdown Editor" });
  const topicEditor = expandedEditor.locator("[contenteditable='true']");
  const markdown = [
    "A cached-cost example:",
    "",
    "```text",
    "input: $0.006",
    "output: $0.024",
    "```"
  ].join("\n");

  await topicEditor.focus();
  await topicEditor.evaluate((element, pastedMarkdown) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pastedMarkdown);
    clipboardData.setData(
      "text/html",
      "<p>A cached-cost example:</p><pre><code>input: $0.006\noutput: $0.024</code></pre>"
    );
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData
    }));
  }, markdown);

  const codeBlock = expandedEditor.locator("[data-content-type='codeBlock']");
  await expect(codeBlock).toBeVisible();
  await expect(codeBlock).toContainText("input: $0.006");
  await expect(codeBlock).toContainText("output: $0.024");
  await expandedEditor.getByRole("button", { name: "Done" }).click();
  await composer.getByRole("button", { name: "Publish" }).click();

  await expect(page).toHaveURL(/#\/posts\/topic-created$/);
  expect(state.topicPayloads[0]).toMatchObject({
    body: "A cached-cost example:\n\n```text\ninput: $0.006\noutput: $0.024\n```",
    title: "Markdown paste contract"
  });
});

test("publishes a mentioned topic, reacts, replies with a mention, and reacts to the reply", async ({ page }) => {
  const state = await mockPortalForum(page);
  await page.goto("/#/home");

  await page.getByRole("button", { name: "New post" }).first().click();
  const composer = page.getByRole("dialog", { name: "New Topic" });
  await expect(composer).toBeVisible();
  await expect(composer.getByRole("button", { name: "Type" })).toHaveCount(0);
  await expect(composer.getByText("No label", { exact: true })).toHaveCount(0);
  await composer.locator(".titleField input").fill("Portal forum contract check");
  const topicEditor = composer.locator(".forumPlainTextArea");
  await topicEditor.pressSequentially("Please review @gra");
  await page.locator(".forumPlainTextMentions .peopleMentionOption").filter({ hasText: "Grace Hopper" }).click();
  await expect(topicEditor).toHaveValue("Please review @grace ");
  await composer.getByRole("button", { name: "Publish" }).click();

  await expect(page).toHaveURL(/#\/posts\/topic-created$/);
  await expect(page.getByRole("heading", { level: 1, name: "Portal forum contract check" })).toBeVisible();
  expect(state.topicPayloads).toHaveLength(1);
  expect(state.topicPayloads[0]).toMatchObject({
    body: "Please review @grace ",
    categorySlug: "ai-exploration",
    title: "Portal forum contract check"
  });
  const publishedMention = page.locator(".portal-post-body .inlineMentionTag");
  await expect(publishedMention).toContainText("Grace Hopper");
  await expect(publishedMention.locator(".peopleMentionAvatar")).toHaveText("GH");
  await publishedMention.click();
  const mentionedProfile = page.getByRole("dialog", { name: "Grace Hopper profile" });
  await expect(mentionedProfile).toBeVisible();
  await mentionedProfile.getByRole("button", { name: "Close profile" }).click();

  const topicReaction = page.locator(".portal-post-author-line .forumReactionBar");
  await topicReaction.getByRole("button", { name: "Add reaction" }).click();
  await topicReaction.getByRole("menuitemradio", { name: "Support" }).click();
  await expect(topicReaction.locator(".forumReactionChip[title='Support']")).toContainText("1");
  expect(state.topicReactionPayloads).toEqual([{ reaction: "heart" }]);

  const replyComposer = page.locator("#forum-reply-composer");
  const replyEditor = replyComposer.locator(".forumPlainTextArea");
  await replyEditor.pressSequentially("Acknowledged @gra");
  await page.locator(".forumPlainTextMentions .peopleMentionOption").filter({ hasText: "Grace Hopper" }).click();
  await expect(replyEditor).toHaveValue("Acknowledged @grace ");
  await replyComposer.getByRole("button", { name: "Send" }).click();

  const reply = page.locator(".forumReply").filter({ has: page.locator(".inlineMentionTag") });
  await expect(reply).toContainText("Acknowledged");
  expect(state.replyPayloads).toEqual([{ body: "Acknowledged @grace ", attachments: [], anonymous: false }]);
  await expect(reply.locator(".inlineMentionTag")).toContainText("Grace Hopper");

  await reply.locator(".forumReactionAction").click();
  await reply.getByRole("menuitemradio", { name: "Celebrate" }).click();
  await expect(reply.locator(".forumReactionChip[title='Celebrate']")).toContainText("1");
  expect(state.replyReactionPayloads).toEqual([{ reaction: "tada" }]);
});

test("keeps the person chip when switching between compact and expanded writing", async ({ page }) => {
  const state = await mockPortalForum(page);
  await page.goto("/#/home");

  await page.getByRole("button", { name: "New post" }).first().click();
  const composer = page.getByRole("dialog", { name: "New Topic" });
  await composer.locator(".titleField input").fill("Expanded mention contract");
  await composer.getByRole("button", { name: "Markdown Editor", exact: true }).click();

  const expandedEditor = page.getByRole("dialog", { name: "Markdown Editor" });
  const expandedSurface = expandedEditor.locator("[contenteditable='true']");
  await expandedSurface.pressSequentially("Coordinate with @gra");
  await page.locator(".bn-suggestion-menu-item").filter({ hasText: "Grace Hopper" }).click();
  await expect(expandedSurface.locator(".forumEditorMentionChip")).toContainText("Grace Hopper");
  await expandedSurface.press("Backspace");
  await expandedSurface.press("Backspace");
  await expect(expandedSurface.locator(".forumEditorMentionChip")).toHaveCount(0);
  await expect.poll(() => expandedSurface.evaluate((element) => element.textContent)).toBe("Coordinate with ");
  await expandedSurface.fill("");
  await expandedSurface.pressSequentially("Coordinate with @gra");
  await page.locator(".bn-suggestion-menu-item").filter({ hasText: "Grace Hopper" }).click();
  await expandedEditor.getByRole("button", { name: "Done" }).click();

  const compactSurface = composer.locator(".forumPlainTextArea");
  await expect(compactSurface).toHaveValue("Coordinate with @grace");
  await composer.getByRole("button", { name: "Publish" }).click();
  expect(state.topicPayloads[0]).toMatchObject({ body: "Coordinate with @grace" });
});

test("dismisses the slash menu with Escape before closing the expanded editor", async ({ page }) => {
  await mockPortalForum(page);
  await page.goto("/#/home");

  await page.getByRole("button", { name: "New post" }).first().click();
  const composer = page.getByRole("dialog", { name: "New Topic" });
  await composer.getByRole("button", { name: "Markdown Editor", exact: true }).click();

  const expandedEditor = page.getByRole("dialog", { name: "Markdown Editor" });
  const surface = expandedEditor.locator("[contenteditable='true']");
  await surface.pressSequentially("/head");
  const menuItems = page.locator(".bn-suggestion-menu-item");
  await expect(menuItems.first()).toBeVisible();
  await expect(menuItems).toHaveCount(3);
  await expect(menuItems.filter({ hasText: "Toggle" })).toHaveCount(0);

  await surface.press("Escape");
  await expect(page.locator(".bn-suggestion-menu-item")).toHaveCount(0);
  await expect(expandedEditor).toBeVisible();

  await surface.press("Escape");
  await expect(expandedEditor).toHaveCount(0);
  await expect(composer).toBeVisible();
});

test("shows the agent tag immediately after MCP reply authors only", async ({ page }) => {
  const createdAt = "2026-07-13T10:33:02.000Z";
  await mockPortalForum(page, {
    forumDiscussionPatch: {
      replies: 2,
      replyPosts: [
        {
          id: "reply-agent",
          author: "大澄",
          authorEmail: "agent@example.test",
          body: "Replied through Workspace MCP",
          createdAt,
          source: "mcp"
        },
        {
          id: "reply-portal",
          author: "Ivy",
          authorEmail: "ivy@example.test",
          body: "Replied through the Portal",
          createdAt,
          source: "portal"
        }
      ]
    }
  });
  await page.goto("/#/posts/discussion-contract-review");

  const agentReply = page.locator(".forumReply").filter({ hasText: "Replied through Workspace MCP" });
  const nameLine = agentReply.locator(".forumAuthorNameLine");
  await expect(nameLine.locator(":scope > :nth-child(1)")).toHaveClass(/profileInlineName/);
  await expect(nameLine.locator(":scope > :nth-child(2)")).toHaveClass(/forumAgentTag/);
  await expect(nameLine.locator(".forumAgentTag")).toHaveText("(agent)");

  const portalReply = page.locator(".forumReply").filter({ hasText: "Replied through the Portal" });
  await expect(portalReply.locator(".forumAgentTag")).toHaveCount(0);
});

test("shows profile bios first and community levels instead of department names", async ({ page }) => {
  await mockPortalForum(page, {
    forumDiscussionPatch: {
      bio: "Builds tools for the community",
      journeyLevelKey: "master",
      team: "AI Adoption",
      department: "AI Adoption",
      bu: "AI Adoption",
      replies: 1,
      replyPosts: [{
        id: "reply-level-fallback",
        author: "Ivy Lin",
        authorEmail: "ivy@example.test",
        bio: "   ",
        body: "Community level fallback",
        createdAt: "2026-07-13T10:33:02.000Z",
        journeyLevelKey: "contributor",
        team: "AI Adoption",
        department: "AI Adoption"
      }]
    }
  });
  await page.goto("/#/posts/discussion-contract-review");

  const topicMeta = page.locator(".portal-post-author small");
  await expect(topicMeta).toHaveText("Builds tools for the community");
  await expect(topicMeta).not.toContainText("AI Adoption");

  const reply = page.locator(".forumReply").filter({ hasText: "Community level fallback" });
  const replyMeta = reply.locator(".forumAuthorMeta");
  await expect(replyMeta).toContainText("Level 3 · Contributor");
  await expect(replyMeta).not.toContainText("AI Adoption");
});

test("keeps topic creation, reply creation, and thread activity times distinct", async ({ page }) => {
  const topicCreatedAt = "2026-07-14T01:00:00.000Z";
  const replyCreatedAt = "2026-07-14T02:00:00.000Z";
  const lastActiveAt = "2026-07-14T03:00:00.000Z";
  await mockPortalForum(page, {
    forumDiscussionPatch: {
      createdAt: topicCreatedAt,
      lastActive: lastActiveAt,
      replies: 1,
      replyPosts: [{
        id: "reply-distinct-time",
        author: "Ivy Lin",
        authorEmail: "ivy@example.test",
        body: "A later reply",
        createdAt: replyCreatedAt
      }]
    }
  });
  await page.goto("/#/posts/discussion-contract-review");

  await expect(page.locator(".portal-post-published-at")).toHaveAttribute("datetime", topicCreatedAt);
  const reply = page.locator(".forumReply").filter({ hasText: "A later reply" });
  await expect(reply.locator(".forumAuthorMeta time")).toHaveAttribute("datetime", replyCreatedAt);
  const threadStatus = page.locator(".portal-post-context section").filter({ hasText: "Thread status" });
  await expect(threadStatus.locator("time")).toHaveAttribute("datetime", lastActiveAt);
});

test("expands the newest reply on post hover and collapses it after hover leaves", async ({ page }) => {
  await mockPortalForum(page, {
    forumDiscussionPatch: {
      replies: 2,
      replyPosts: [
        {
          id: "reply-hover-newest",
          author: "Ivy Lin",
          body: "The newest reply should be revealed without opening the post.",
          createdAt: "2026-07-14T03:00:00.000Z"
        },
        {
          id: "reply-hover-older",
          author: "Grace Hopper",
          body: "This older reply should stay out of the preview.",
          createdAt: "2026-07-14T02:00:00.000Z"
        }
      ]
    }
  });
  await page.goto("/#/home");

  const row = page.locator("#discussion-discussion-contract-review");
  const preview = row.locator(".portal-latest-reply-shell");
  const collapsedHeight = (await row.boundingBox())?.height ?? 0;

  await expect(preview).toBeHidden();
  await row.hover();
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Latest reply");
  await expect(preview).toContainText("Ivy Lin");
  await expect(preview).toContainText("The newest reply should be revealed");
  await expect(preview).not.toContainText("This older reply");
  await expect.poll(async () => (await row.boundingBox())?.height ?? 0).toBeGreaterThan(collapsedHeight + 30);

  await page.locator(".portal-section-header").last().hover();
  await expect(preview).toBeHidden();
  await expect.poll(async () => (await row.boundingBox())?.height ?? 0).toBeLessThan(collapsedHeight + 2);
});

test("rolls a topic reaction back when the API rejects it", async ({ page }) => {
  await mockPortalForum(page, { failTopicReaction: true });
  await page.goto("/#/posts/discussion-contract-review");

  const topicReaction = page.locator(".portal-post-author-line .forumReactionBar");
  const action = topicReaction.getByRole("button", { name: "Add reaction" });
  await action.click();
  const responsePromise = page.waitForResponse((response) => (
    response.url().endsWith("/api/forum/topics/discussion-contract-review/like")
    && response.request().method() === "POST"
  ));
  await topicReaction.getByRole("menuitemradio", { name: "Support" }).click();
  expect((await responsePromise).ok()).toBe(false);

  await expect(topicReaction.locator(".forumReactionChip")).toHaveCount(0);
  await expect(action).toHaveAttribute("aria-label", "Add reaction");
});

test("keeps topic and reply drafts when their writes fail", async ({ page }) => {
  await mockPortalForum(page, { failReplyCreate: true, failTopicCreate: true });
  await page.goto("/#/home");

  await page.getByRole("button", { name: "New post" }).first().click();
  const composer = page.getByRole("dialog", { name: "New Topic" });
  await composer.locator(".titleField input").fill("Draft that must survive");
  const topicEditor = composer.locator(".forumPlainTextArea");
  await topicEditor.fill("Keep this topic body");
  await composer.getByRole("button", { name: "Publish" }).click();
  await expect(composer.locator(".statusText.error")).toHaveText("Could not post");
  await expect(composer.locator(".titleField input")).toHaveValue("Draft that must survive");
  await expect(topicEditor).toHaveValue("Keep this topic body");

  await composer.getByRole("button", { name: "Cancel" }).click();
  await page.goto("/#/posts/discussion-contract-review");
  const replyComposer = page.locator("#forum-reply-composer");
  const replyEditor = replyComposer.locator(".forumPlainTextArea");
  await replyEditor.fill("Keep this reply body");
  await replyComposer.getByRole("button", { name: "Send" }).click();
  await expect(replyComposer.locator(".statusText.error")).toHaveText("Could not reply");
  await expect(replyEditor).toHaveValue("Keep this reply body");
});

test("renders discussion rows with author avatars, plain-text excerpts, two-line clamps, and no stray zero", async ({ page }) => {
  const avatar = forumImageFixture(90, 80, 80).url;
  const attachment = forumImageFixture(91, 400, 300);
  await mockPortalForum(page, {
    forumDiscussionPatch: {
      attachments: [attachment],
      author: "Ada Lovelace",
      authorAvatarUrl: avatar,
      body: "# Weekly update\n\n**Bold summary** with [reference](https://example.test).\n\n- First item",
      tags: [],
      title: "A deliberately long discussion title that should wrap across no more than two lines in the list card"
    }
  });
  await page.goto("/#/home");

  const row = page.locator("#discussion-discussion-contract-review");
  expect(await row.evaluate((element) => getComputedStyle(element).minHeight)).toBe("132px");
  await expect(row.locator(".portal-feed-kind")).toHaveCount(0);
  await expect(row.locator(".portal-feed-avatar img")).toHaveAttribute("src", avatar);
  await expect(row.locator(".portal-feed-excerpt")).toHaveText("Weekly update Bold summary with reference. First item");
  await expect(row.getByText("mcp-auth", { exact: true })).toHaveCount(0);
  const directTextNodes = await row.locator(".portal-feed-content").evaluate((element) => (
    Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent?.trim())
      .filter(Boolean)
  ));
  expect(directTextNodes).toEqual([]);
  expect(await row.locator(".portal-feed-title").evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe("2");
  expect(await row.locator(".portal-feed-excerpt").evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe("2");

  const thumbnail = row.locator(".portal-feed-thumbnail");
  await expect(thumbnail).toHaveClass(/image/);
  await expect(thumbnail.locator("img")).toHaveAttribute("src", attachment.url);
  const thumbnailBox = await thumbnail.boundingBox();
  expect((thumbnailBox?.width ?? 0) / (thumbnailBox?.height ?? 1)).toBeCloseTo(4 / 3, 2);
});

test("hides legacy Type and Tag metadata on post details", async ({ page }) => {
  await mockPortalForum(page);
  await page.goto("/#/posts/discussion-contract-review");

  await expect(page.locator(".portal-post-meta").getByText("question", { exact: true })).toHaveCount(0);
  await expect(page.locator(".portal-post-tags")).toHaveCount(0);
  await expect(page.getByText("mcp-auth", { exact: true })).toHaveCount(0);
  await expect(page.locator(".portal-post-meta").getByText("公告与建议", { exact: true })).toBeVisible();
});

for (const { kind, patch } of [
  {
    kind: "link",
    patch: {
      attachments: [],
      contentPlugins: [],
      linkEmbeds: [{
        description: "OG description",
        embedType: "link" as const,
        id: "og-preview",
        previewImageUrl: forumImageFixture(92, 400, 300).url,
        provider: "Example",
        title: "Example page",
        url: "https://example.test"
      }]
    }
  },
  {
    kind: "app",
    patch: {
      attachments: [],
      contentPlugins: [{
        description: "App attachment",
        iconUrl: forumImageFixture(93, 200, 200).url,
        id: "app-preview",
        pluginType: "app_card" as const,
        targetId: "app-preview",
        targetType: "app" as const,
        title: "Preview App"
      }],
      linkEmbeds: []
    }
  }
]) {
  test(`renders a 4:3 ${kind} attachment thumbnail on the right of the discussion row`, async ({ page }) => {
    await mockPortalForum(page, { forumDiscussionPatch: patch });
    await page.goto("/#/home");

    const thumbnail = page.locator("#discussion-discussion-contract-review .portal-feed-thumbnail");
    await expect(thumbnail).toHaveClass(new RegExp(kind));
    await expect(thumbnail.locator("img")).toBeVisible();
    const box = await thumbnail.boundingBox();
    expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(4 / 3, 2);
  });
}

test("uses the shared compact discussion card on an App related-discussions section", async ({ page }) => {
  await mockPortalForum(page);
  await page.goto("/#/apps/app-growth-lab");

  const card = page.locator(".portal-object-discussion-list .portal-feed-row.compact").filter({ hasText: "SDK" });
  await expect(card).toBeVisible();
  expect(await card.evaluate((element) => getComputedStyle(element).minHeight)).toBe("74px");
  await expect(card.locator(".portal-feed-avatar .personAvatar")).toBeVisible();
  await expect(card.locator(".portal-feed-excerpt")).toHaveCount(0);
  expect(await card.locator(".portal-feed-title").evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe("2");
  const thumbnail = card.locator(".portal-feed-thumbnail");
  await expect(thumbnail).toBeVisible();
  const box = await thumbnail.boundingBox();
  expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(4 / 3, 2);
});

for (const detail of [
  {
    contextSelector: ".portal-object-metadata",
    layoutSelector: ".portal-object-layout",
    mainSelector: ".portal-object-publication",
    name: "App",
    route: "/#/apps/app-growth-lab"
  },
  {
    contextSelector: ".portal-post-context",
    layoutSelector: ".portal-post-layout",
    mainSelector: ".portal-post-paper",
    name: "Post",
    route: "/#/posts/discussion-contract-review"
  }
]) {
  test(`uses freed Right Rail space for the ${detail.name} Detail context`, async ({ page }) => {
    await page.setViewportSize({ height: 1000, width: 1600 });
    await mockPortalForum(page);
    await page.goto(detail.route);
    await page.getByRole("button", { name: "Open Live" }).click();

    await expect.poll(() => detailContextPlacement(page, detail)).toBe("bottom");
    await expect(page.locator(detail.contextSelector)).toHaveCSS("position", "static");

    await page.getByRole("button", { name: "Collapse Live" }).click();
    await expect.poll(() => detailContextPlacement(page, detail)).toBe("side");
    await expect(page.locator(detail.contextSelector)).toHaveCSS("position", "sticky");

    await page.locator(".portal-shell").evaluate((shell) => shell.classList.add("utility-panel-open"));
    await expect.poll(() => detailContextPlacement(page, detail)).toBe("bottom");
    await page.locator(".portal-shell").evaluate((shell) => shell.classList.remove("utility-panel-open"));
    await expect.poll(() => detailContextPlacement(page, detail)).toBe("side");

    await page.setViewportSize({ height: 900, width: 1360 });
    await expect.poll(() => detailContextPlacement(page, detail)).toBe("bottom");
    await page.setViewportSize({ height: 1000, width: 1600 });
    await expect.poll(() => detailContextPlacement(page, detail)).toBe("side");

    await page.getByRole("button", { name: "Open Live" }).click();
    await expect.poll(() => detailContextPlacement(page, detail)).toBe("bottom");

    await page.setViewportSize({ height: 900, width: 1200 });
    await expect.poll(() => detailContextPlacement(page, detail)).toBe("bottom");
    await page.getByRole("button", { name: "Open Live" }).click();
    await expect.poll(() => detailContextPlacement(page, detail)).toBe("bottom");
  });
}

test("keeps the Post body fixed while the collapsed Live rail reveals its context", async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1600 });
  await mockPortalForum(page);
  await page.goto("/#/posts/discussion-contract-review");

  const paper = page.locator(".portal-post-paper");
  const context = page.locator(".portal-post-context");
  await page.getByRole("button", { name: "Open Live" }).click();
  await expect.poll(() => detailContextPlacement(page, {
    contextSelector: ".portal-post-context",
    layoutSelector: ".portal-post-layout",
    mainSelector: ".portal-post-paper"
  })).toBe("bottom");
  await expect.poll(async () => (await paper.boundingBox())?.width).toBeCloseTo(896, 0);
  await expect.poll(async () => (await paper.boundingBox())?.x).toBeCloseTo(320, 0);
  const openPaper = await paper.boundingBox();

  await page.getByRole("button", { name: "Collapse Live" }).click();
  await expect.poll(() => detailContextPlacement(page, {
    contextSelector: ".portal-post-context",
    layoutSelector: ".portal-post-layout",
    mainSelector: ".portal-post-paper"
  })).toBe("side");
  await expect.poll(async () => (await paper.boundingBox())?.width).toBeCloseTo(openPaper?.width ?? 0, 0);
  await expect.poll(async () => (await paper.boundingBox())?.x).toBeCloseTo(openPaper?.x ?? 0, 0);

  const collapsedPaper = await paper.boundingBox();
  const collapsedContext = await context.boundingBox();
  expect(openPaper).not.toBeNull();
  expect(collapsedPaper).not.toBeNull();
  expect(collapsedContext?.width).toBeCloseTo(240, 0);
  expect(collapsedPaper?.width).toBeCloseTo(openPaper?.width ?? 0, 0);
  expect(collapsedPaper?.x).toBeCloseTo(openPaper?.x ?? 0, 0);
});

test("renders a linked App as a half-width horizontal card in the topic composer", async ({ page }) => {
  await mockPortalForum(page);
  await page.goto("/#/apps/app-growth-lab");
  await page.getByRole("button", { name: "Post New Comment" }).click();

  const dialog = page.getByRole("dialog", { name: "New Topic" });
  const panel = dialog.locator(".composerLinkedItemPanel");
  const icon = panel.locator(".composerLinkedItemIcon");
  await expect(panel).toBeVisible();
  await expect(icon).toBeVisible();
  await expect(panel.getByText("Workspace Onboarding", { exact: true })).toBeVisible();
  const panelMetrics = await panel.evaluate((element) => ({
    parentWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
    width: element.getBoundingClientRect().width
  }));
  const iconBox = await icon.boundingBox();
  expect(panelMetrics.width).toBeLessThanOrEqual(panelMetrics.parentWidth / 2 + 1);
  expect(iconBox?.width).toBeCloseTo(64, 0);
  expect(iconBox?.height).toBeCloseTo(64, 0);
});

test("renders the current linked App without requiring a Hub Listing", async ({ page }) => {
  const state = await mockPortalForum(page, {
    forumDiscussionPatch: {
      contentPlugins: [{
        actionLabel: "Open App",
        description: "Historical App description that should not win.",
        id: "current-app-card",
        pluginType: "app_card",
        targetId: "app-growth-lab",
        targetType: "app",
        title: "Historical App name"
      }]
    },
    useHomeBootstrap: true
  });
  await page.goto("/#/posts/discussion-contract-review");

  const card = page.locator(".forumEmbeddedProductCard");
  const logo = card.locator(".forumPluginLogo");
  const appLink = card.getByRole("link", { name: "Open App" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Linked product / App", { exact: true })).toBeVisible();
  await expect(card.getByText("Workspace Onboarding", { exact: true })).toBeVisible();
  await expect(card).toContainText("Workspace employee onboarding portal");
  await expect(card).not.toContainText(/delisted/i);
  await expect(card.locator(".forumProductUnavailableBadge, .forumProductUnavailableAction")).toHaveCount(0);
  await expect(appLink).toBeVisible();
  await expect(appLink).toHaveAttribute("href", "#/apps/app-growth-lab");
  await expect.poll(() => state.appRequestPaths).toEqual(["/api/apps/app-growth-lab"]);
  const desktopMetrics = await card.evaluate((element) => ({
    bodyWidth: element.querySelector(".forumProductCardBody")?.getBoundingClientRect().width ?? 0,
    parentWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
    width: element.getBoundingClientRect().width
  }));
  const desktopLogoBox = await logo.boundingBox();
  const expectedDesktopWidth = Math.min(desktopMetrics.parentWidth, Math.max(desktopMetrics.parentWidth / 2, 440), 680);
  expect(desktopMetrics.width).toBeCloseTo(expectedDesktopWidth, 0);
  expect(desktopMetrics.bodyWidth).toBeGreaterThan(140);
  expect(desktopLogoBox?.width).toBeCloseTo(64, 0);
  expect(desktopLogoBox?.height).toBeCloseTo(64, 0);
  await expect(logo.locator("img")).toHaveCSS("object-fit", "cover");

  await page.setViewportSize({ height: 844, width: 390 });
  const mobileMetrics = await card.evaluate((element) => ({
    documentScrollWidth: document.documentElement.scrollWidth,
    parentWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
    right: element.getBoundingClientRect().right,
    viewportWidth: document.documentElement.clientWidth,
    width: element.getBoundingClientRect().width
  }));
  const mobileLogoBox = await logo.boundingBox();
  expect(mobileMetrics.width).toBeCloseTo(mobileMetrics.parentWidth, 0);
  expect(mobileMetrics.right).toBeLessThanOrEqual(mobileMetrics.viewportWidth);
  expect(mobileMetrics.documentScrollWidth).toBeLessThanOrEqual(mobileMetrics.viewportWidth);
  expect(mobileLogoBox?.width).toBeCloseTo(56, 0);
  expect(mobileLogoBox?.height).toBeCloseTo(56, 0);

  await appLink.click();
  await expect(page).toHaveURL(/#\/apps\/app-growth-lab$/);
  await expect(page.getByRole("heading", { level: 1, name: "Workspace Onboarding" })).toBeVisible();
});

test("renders a current Skill without a cover in the compact attachment card", async ({ page }) => {
  await mockPortalForum(page, {
    forumDiscussionPatch: {
      attachments: [],
      contentPlugins: [{
        actionLabel: "View details",
        description: "Reviews vendor contracts before approval.",
        id: "skill-contract-review-card",
        pluginType: "app_card",
        targetId: "skill-contract-review",
        targetType: "skill",
        title: "Contract Risk Review"
      }],
      linkEmbeds: []
    }
  });
  await page.goto("/#/posts/discussion-contract-review");

  const card = page.locator(".forumEmbeddedProductCard");
  const logo = card.locator(".forumPluginLogo");
  await expect(card.getByText("Linked product / Skill", { exact: true })).toBeVisible();
  await expect(logo).toHaveText("CR");
  await expect(card.getByRole("link", { name: "View details" })).toHaveAttribute("href", "#/skills/skill-contract-review");
  const logoBox = await logo.boundingBox();
  expect(logoBox?.width).toBeCloseTo(64, 0);
  expect(logoBox?.height).toBeCloseTo(64, 0);
});

test("renders the nine-image grid without upscaling and opens the multi-image viewer", async ({ page }) => {
  const images = forumImageFixtures(10);

  await mockPortalForum(page, { forumImages: images });
  await page.goto("/#/posts/discussion-contract-review");

  const grid = page.getByRole("group", { name: "Post images" });
  await expect(grid).toHaveClass(/columns-3/);
  await expect(grid.locator(".portal-forum-image-thumbnail")).toHaveCount(9);
  await expect(grid.locator(".portal-forum-image-more")).toHaveText("+1");

  const firstThumbnail = grid.getByRole("button", { name: "Show image 1" });
  const firstImage = firstThumbnail.locator("img");
  await expect(firstImage).toHaveClass("portrait");
  const thumbnailBox = await firstThumbnail.boundingBox();
  const imageBox = await firstImage.boundingBox();
  expect(Math.abs((thumbnailBox?.width ?? 0) - (thumbnailBox?.height ?? 0))).toBeLessThan(1);
  expect(imageBox?.width).toBeLessThanOrEqual(60);
  expect(imageBox?.y).toBeCloseTo((thumbnailBox?.y ?? 0) + 1, 0);

  await firstThumbnail.click();
  const viewer = page.getByRole("dialog", { name: "Image preview" });
  await expect(viewer).toBeVisible();
  const viewerImageBox = await viewer.locator("img").boundingBox();
  expect(viewerImageBox?.width).toBeLessThanOrEqual(60);
  expect(viewerImageBox?.height).toBeLessThanOrEqual(120);
  await viewer.getByRole("button", { name: "Next image" }).click();
  await expect(viewer.locator(".portal-image-viewer-counter")).toHaveText("2 / 10");
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
});

test("keeps a tall forum image fully inside the preview viewport", async ({ page }) => {
  await page.setViewportSize({ height: 828, width: 1470 });
  await mockPortalForum(page, {
    forumImages: [forumImageFixture(0, 1394, 2400)]
  });
  await page.goto("/#/posts/discussion-contract-review");

  await page.getByRole("button", { name: "Show image 1" }).click();
  const viewer = page.getByRole("dialog", { name: "Image preview" });
  await expect(viewer).toBeVisible();

  const metrics = await viewer.evaluate((dialog) => {
    const image = dialog.querySelector("img");
    const imageBox = image?.getBoundingClientRect();
    return {
      bottom: imageBox?.bottom ?? Number.POSITIVE_INFINITY,
      dialogClientHeight: dialog.clientHeight,
      dialogScrollHeight: dialog.scrollHeight,
      height: imageBox?.height ?? 0,
      top: imageBox?.top ?? Number.NEGATIVE_INFINITY,
      viewportHeight: window.innerHeight
    };
  });

  expect(metrics.top).toBeGreaterThanOrEqual(60);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight - 60);
  expect(metrics.height).toBeGreaterThan(0);
  expect(metrics.dialogScrollHeight).toBe(metrics.dialogClientHeight);
});

test("zooms and vertically pans a forum image before restoring fit-to-viewport", async ({ page }) => {
  await page.setViewportSize({ height: 828, width: 1470 });
  await mockPortalForum(page, {
    forumImages: [forumImageFixture(0, 1394, 2400)]
  });
  await page.goto("/#/posts/discussion-contract-review");

  await page.getByRole("button", { name: "Show image 1" }).click();
  const viewer = page.getByRole("dialog", { name: "Image preview" });
  const image = viewer.locator("img");
  const initialBox = await image.boundingBox();

  await viewer.getByRole("button", { name: "Zoom in" }).click();
  const zoomedBox = await image.boundingBox();
  expect(zoomedBox?.height).toBeGreaterThan(initialBox?.height ?? 0);

  const canvasBox = await viewer.locator(".portal-image-viewer-canvas").boundingBox();
  await page.mouse.move(
    (canvasBox?.x ?? 0) + (canvasBox?.width ?? 0) / 2,
    (canvasBox?.y ?? 0) + (canvasBox?.height ?? 0) / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    (canvasBox?.x ?? 0) + (canvasBox?.width ?? 0) / 2,
    (canvasBox?.y ?? 0) + (canvasBox?.height ?? 0) / 2 - 140,
    { steps: 4 }
  );
  await page.mouse.up();

  const pannedBox = await image.boundingBox();
  expect(pannedBox?.y).toBeLessThan((zoomedBox?.y ?? 0) - 100);

  await viewer.getByRole("button", { name: "Fit to viewport" }).click();
  const restoredBox = await image.boundingBox();
  expect(restoredBox?.height).toBeCloseTo(initialBox?.height ?? 0, 0);
  expect(restoredBox?.y).toBeCloseTo(initialBox?.y ?? 0, 0);
});

for (const { columns, count } of [
  { columns: 2, count: 2 },
  { columns: 2, count: 4 },
  { columns: 3, count: 5 }
]) {
  test(`uses a full-width ${columns}-column square grid for ${count} image(s)`, async ({ page }) => {
    await mockPortalForum(page, { forumImages: forumImageFixtures(count) });
    await page.goto("/#/posts/discussion-contract-review");

    const grid = page.getByRole("group", { name: "Post images" });
    await expect(grid).toHaveClass(new RegExp(`columns-${columns}`));
    await expect(grid.locator(".portal-forum-image-thumbnail")).toHaveCount(count);
    const dimensions = await grid.evaluate((element) => ({
      gridWidth: element.getBoundingClientRect().width,
      parentWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
      tileHeight: element.firstElementChild?.getBoundingClientRect().height ?? 0,
      tileWidth: element.firstElementChild?.getBoundingClientRect().width ?? 0
    }));
    expect(Math.abs(dimensions.gridWidth - dimensions.parentWidth)).toBeLessThan(1);
    expect(Math.abs(dimensions.tileWidth - dimensions.tileHeight)).toBeLessThan(1);
  });
}

for (const { height, label, width } of [
  { height: 1800, label: "1:2 boundary", width: 900 },
  { height: 750, label: "PPT export", width: 1394 },
  { height: 900, label: "2:1 boundary", width: 1800 }
]) {
  test(`shows the complete ${label} image at natural ratio in a single-image post`, async ({ page }) => {
    await mockPortalForum(page, { forumImages: [forumImageFixture(0, width, height)] });
    await page.goto("/#/posts/discussion-contract-review");

    const thumbnail = page.getByRole("button", { name: "Show image 1" });
    await expect(thumbnail).toHaveClass(/natural/);
    await expect(thumbnail.locator("img")).toHaveClass("complete");
    const gridBox = await page.getByRole("group", { name: "Post images" }).boundingBox();
    const thumbnailBox = await thumbnail.boundingBox();
    expect(Math.max(thumbnailBox?.width ?? 0, thumbnailBox?.height ?? 0)).toBeLessThanOrEqual(gridBox?.width ?? 0);
    expect((thumbnailBox?.width ?? 0) / (thumbnailBox?.height ?? 1)).toBeCloseTo(width / height, 2);
  });
}

test("keeps a single image fluid while the Live rail changes the Post layout", async ({ page }) => {
  const width = 1394;
  const height = 750;
  await page.setViewportSize({ height: 1000, width: 1600 });
  await mockPortalForum(page, { forumImages: [forumImageFixture(0, width, height)] });
  await page.goto("/#/posts/discussion-contract-review");
  await page.getByRole("button", { name: "Open Live" }).click();

  const thumbnail = page.getByRole("button", { name: "Show image 1" });
  await expect.poll(() => thumbnail.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(width);
  await expectSingleImageToFit(thumbnail, width / height);

  await page.getByRole("button", { name: "Collapse Live" }).click();
  await expect.poll(() => detailContextPlacement(page, {
    contextSelector: ".portal-post-context",
    layoutSelector: ".portal-post-layout",
    mainSelector: ".portal-post-paper"
  })).toBe("side");
  await expectSingleImageToFit(thumbnail, width / height);

  await page.getByRole("button", { name: "Open Live" }).click();
  await expect.poll(() => detailContextPlacement(page, {
    contextSelector: ".portal-post-context",
    layoutSelector: ".portal-post-layout",
    mainSelector: ".portal-post-paper"
  })).toBe("bottom");
  await expectSingleImageToFit(thumbnail, width / height);
});

test("keeps a small single image at its natural dimensions without a square canvas", async ({ page }) => {
  await mockPortalForum(page, { forumImages: [forumImageFixture(0, 180, 120)] });
  await page.goto("/#/posts/discussion-contract-review");

  const thumbnailBox = await page.getByRole("button", { name: "Show image 1" }).boundingBox();
  expect(thumbnailBox?.width).toBeCloseTo(180, 0);
  expect(thumbnailBox?.height).toBeCloseTo(120, 0);
});

for (const { expectedClass, height, label, width } of [
  { expectedClass: "landscape", height: 600, label: "extreme landscape", width: 2400 },
  { expectedClass: "portrait", height: 2400, label: "extreme portrait", width: 600 }
]) {
  test(`crops the ${label} image in a square matching one 2x2 tile`, async ({ page }) => {
    await mockPortalForum(page, { forumImages: [forumImageFixture(0, width, height)] });
    await page.goto("/#/posts/discussion-contract-review");

    const grid = page.getByRole("group", { name: "Post images" });
    const thumbnail = grid.getByRole("button", { name: "Show image 1" });
    await expect(thumbnail).toHaveClass(/extreme/);
    await expect(thumbnail.locator("img")).toHaveClass(expectedClass);
    const gridBox = await grid.boundingBox();
    const thumbnailBox = await thumbnail.boundingBox();
    const expectedTileSize = ((gridBox?.width ?? 0) - 6) / 2;
    expect(thumbnailBox?.width).toBeCloseTo(expectedTileSize, 1);
    expect(thumbnailBox?.height).toBeCloseTo(expectedTileSize, 1);
  });
}

test("keeps short-edge cropping for moderate-ratio images in a multi-image post", async ({ page }) => {
  await mockPortalForum(page, {
    forumImages: [forumImageFixture(0, 1200, 1600), forumImageFixture(1, 1600, 1200)]
  });
  await page.goto("/#/posts/discussion-contract-review");

  const grid = page.getByRole("group", { name: "Post images" });
  const images = grid.locator("img");
  await expect(images).toHaveCount(2);
  await expect(images.first()).toHaveClass("portrait");
  await expect(images.last()).toHaveClass("landscape");
  const tileBox = await grid.getByRole("button", { name: "Show image 1" }).boundingBox();
  const portraitBox = await images.first().boundingBox();
  expect(portraitBox?.height).toBeGreaterThan(tileBox?.height ?? 0);
});

function forumImageFixtures(count: number): DiscussionAttachment[] {
  return Array.from({ length: count }, (_, index): DiscussionAttachment => {
    const portrait = index % 2 === 0;
    const width = portrait ? 60 : 240;
    const height = portrait ? 120 : 80;
    return forumImageFixture(index, width, height);
  });
}

function forumImageFixture(index: number, width: number, height: number): DiscussionAttachment {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${width < height ? "#a83232" : "#325c82"}"/></svg>`;
  return {
    alt: `Image ${index + 1}`,
    fileName: `image-${index + 1}.svg`,
    fileSize: svg.length,
    id: `image-${index + 1}`,
    mimeType: "image/svg+xml",
    type: "image",
    url: `data:image/svg+xml,${encodeURIComponent(svg)}`
  };
}

async function expectSingleImageToFit(thumbnail: ReturnType<Page["getByRole"]>, expectedRatio: number) {
  await expect.poll(() => thumbnail.evaluate((element) => {
    const grid = element.parentElement;
    const paper = element.closest<HTMLElement>(".portal-post-paper");
    if (!grid || !paper) return Number.POSITIVE_INFINITY;
    return Math.max(
      element.getBoundingClientRect().right - grid.getBoundingClientRect().right,
      grid.getBoundingClientRect().right - paper.getBoundingClientRect().right,
      paper.scrollWidth - paper.clientWidth
    );
  })).toBeLessThanOrEqual(1);

  const metrics = await thumbnail.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const gridBox = element.parentElement?.getBoundingClientRect();
    const imageBox = element.querySelector("img")?.getBoundingClientRect();
    return {
      gridWidth: gridBox?.width ?? 0,
      imageHeight: imageBox?.height ?? 0,
      imageWidth: imageBox?.width ?? 0,
      thumbnailHeight: box.height,
      thumbnailWidth: box.width
    };
  });

  expect(metrics.thumbnailWidth).toBeLessThanOrEqual(metrics.gridWidth + 1);
  expect(metrics.imageWidth).toBeCloseTo(metrics.thumbnailWidth, 0);
  expect(metrics.imageHeight).toBeCloseTo(metrics.thumbnailHeight, 0);
  expect(metrics.thumbnailWidth / metrics.thumbnailHeight).toBeCloseTo(expectedRatio, 2);
}

async function detailContextPlacement(page: Page, detail: {
  contextSelector: string;
  layoutSelector: string;
  mainSelector: string;
}) {
  return page.locator(detail.layoutSelector).evaluate((layout, selectors) => {
    const context = layout.querySelector<HTMLElement>(selectors.contextSelector);
    const main = layout.querySelector<HTMLElement>(selectors.mainSelector);
    if (!context || !main) {
      return "missing";
    }

    const contextBox = context.getBoundingClientRect();
    const mainBox = main.getBoundingClientRect();
    if (contextBox.left >= mainBox.right + 8 && Math.abs(contextBox.top - mainBox.top) <= 2) {
      return "side";
    }
    if (contextBox.top >= mainBox.bottom + 8 && Math.abs(contextBox.left - mainBox.left) <= 2) {
      return "bottom";
    }
    return "unexpected";
  }, detail);
}

async function mockPortalForum(page: Page, options: {
  failReplyCreate?: boolean;
  failTopicCreate?: boolean;
  failTopicReaction?: boolean;
  forumDiscussionPatch?: Partial<Discussion>;
  forumImages?: DiscussionAttachment[];
  useHomeBootstrap?: boolean;
} = {}) {
  const catalog = structuredClone(fallbackPortal) as PortalCatalog;
  let discussions = structuredClone(catalog.discussions) as Discussion[];
  const patchedDiscussion = discussions.find((item) => item.id === "discussion-contract-review");
  if (patchedDiscussion && options.forumDiscussionPatch) {
    Object.assign(patchedDiscussion, options.forumDiscussionPatch);
  }
  if (patchedDiscussion && options.forumImages) {
    patchedDiscussion.attachments = options.forumImages;
  }
  const state: ForumRequestState = {
    appRequestPaths: [],
    replyReactionPayloads: [],
    replyPayloads: [],
    topicDetailIds: [],
    topicPayloads: [],
    topicReactionPayloads: []
  };

  await page.route("**/api/**", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { error: "unmocked_api_request" }, status: 501 });
  });
  await page.route("**/api/home-bootstrap", async (route) => {
    if (!options.useHomeBootstrap) {
      await route.fulfill({ contentType: "application/json", json: { error: "home_bootstrap_not_mocked" }, status: 404 });
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        auth: { authenticated: true, configured: false },
        catalog: {
          ...catalog,
          apps: [],
          discussions: [],
          hubListings: [],
          publicationListings: [],
          skills: []
        },
        me: catalog.currentUser
      }
    });
  });
  await page.route("**/api/auth/session", (route) => route.fulfill({
    contentType: "application/json",
    json: { authenticated: true, configured: false, loginUrl: "/auth/login" }
  }));
  await page.route("**/api/catalog", (route) => route.fulfill({
    contentType: "application/json",
    json: { ...catalog, discussions }
  }));
  await page.route("**/api/apps**", (route) => {
    const url = new URL(route.request().url());
    state.appRequestPaths.push(url.pathname + url.search);
    const appId = /^\/api\/apps\/([^/]+)$/.exec(url.pathname)?.[1];
    if (appId) {
      const app = catalog.apps.find((item) => item.id === decodeURIComponent(appId));
      return route.fulfill(app ? {
        contentType: "application/json",
        json: { app }
      } : {
        contentType: "application/json",
        json: { error: "app_not_found" },
        status: 404
      });
    }
    return route.fulfill({ contentType: "application/json", json: { apps: catalog.apps } });
  });
  await page.route("**/api/skills", (route) => route.fulfill({ contentType: "application/json", json: { skills: catalog.skills } }));
  await page.route("**/api/publication/listings", (route) => route.fulfill({
    contentType: "application/json",
    json: { publicationListings: catalog.publicationListings }
  }));
  await page.route("**/api/publication/hub-listings", (route) => route.fulfill({
    contentType: "application/json",
    json: { hubListings: catalog.hubListings }
  }));
  await page.route("**/api/activity/events**", (route) => route.fulfill({
    contentType: "application/json",
    json: { events: catalog.activityEvents }
  }));
  await page.route("**/api/journey", (route) => route.fulfill({
    contentType: "application/json",
    json: { journey: catalog.journey }
  }));
  await page.route("**/api/me", (route) => route.fulfill({
    contentType: "application/json",
    json: {
      journey: fallbackPortal.journey,
      me: {
        ...fallbackPortal.currentUser,
        status: {
          journeyLevelKey: fallbackPortal.journey.level.key,
          mcpConnected: false,
          tokenApplied: false,
          updatedAt: fallbackPortal.journey.updatedAt
        }
      }
    }
  }));
  await page.route("**/api/users/directory**", (route) => route.fulfill({
    contentType: "application/json",
    json: {
      users: [{
        department: "People Ops",
        email: "grace@example.test",
        emailPrefix: "grace",
        id: "user-grace",
        name: "Grace Hopper",
        team: "Platform"
      }]
    }
  }));
  await page.route("**/api/users/batch**", (route) => route.fulfill({
    contentType: "application/json",
    json: {
      users: [{
        avatarUrl: catalog.currentUser.avatarUrl,
        id: catalog.currentUser.id,
        journeyLevelKey: catalog.journey.level.key,
        name: catalog.currentUser.name
      }]
    }
  }));
  await page.route("**/api/forum/topics/*/view", (route) => route.fulfill({
    contentType: "application/json",
    json: { viewed: true }
  }));
  await page.route("**/api/forum/topics/*/replies/*/like", async (route) => {
    const payload = route.request().postDataJSON();
    state.replyReactionPayloads.push(payload);
    const [, topicId, replyId] = /\/api\/forum\/topics\/([^/]+)\/replies\/([^/]+)\/like$/.exec(new URL(route.request().url()).pathname) ?? [];
    const reaction = typeof payload?.reaction === "string" ? payload.reaction : "tada";
    const liked = route.request().method() !== "DELETE";
    const reactions = liked ? [{ count: 1, reaction }] : [];
    discussions = discussions.map((discussion) => (
      discussion.id === decodeURIComponent(topicId ?? "")
        ? {
          ...discussion,
          replyPosts: (discussion.replyPosts ?? []).map((reply) => (
            reply.id === decodeURIComponent(replyId ?? "")
              ? {
                ...reply,
                currentUserReaction: liked ? reaction : undefined,
                likedByCurrentUser: liked,
                likes: liked ? 1 : 0,
                reactions
              }
              : reply
          ))
        }
        : discussion
    ));
    await route.fulfill({
      contentType: "application/json",
      json: { liked, likes: liked ? 1 : 0, reaction, reactions }
    });
  });
  await page.route("**/api/forum/topics/*/replies", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const payload = route.request().postDataJSON() as { attachments?: DiscussionAttachment[]; body: string };
    state.replyPayloads.push(payload);
    if (options.failReplyCreate) {
      await route.fulfill({
        contentType: "application/json",
        json: { error: "reply_failed" },
        status: 500
      });
      return;
    }

    const topicId = decodeURIComponent(/\/api\/forum\/topics\/([^/]+)\/replies$/.exec(new URL(route.request().url()).pathname)?.[1] ?? "");
    const now = new Date().toISOString();
    const reply: DiscussionReply = {
      id: "reply-created",
      authorId: catalog.currentUser.id,
      author: catalog.currentUser.name,
      authorEmail: catalog.currentUser.email,
      authorAvatarUrl: catalog.currentUser.avatarUrl,
      body: payload.body,
      createdAt: now,
      updatedAt: now,
      attachments: payload.attachments ?? [],
      likes: 0,
      likedByCurrentUser: false,
      reactions: [],
      currentUserReaction: undefined,
      department: catalog.currentUser.department,
      team: catalog.currentUser.team,
      jobTitle: catalog.currentUser.jobTitle,
      bio: catalog.currentUser.bio,
      location: catalog.currentUser.location,
      journeyLevelKey: catalog.journey.level.key
    };
    discussions = discussions.map((discussion) => (
      discussion.id === topicId
        ? {
          ...discussion,
          lastActive: now,
          mentions: [
            ...(discussion.mentions ?? []),
            {
              email: "grace@example.test",
              emailPrefix: "grace",
              id: "mention-reply-grace",
              name: "Grace Hopper",
              postId: "reply-created",
              text: "@grace",
              userId: "user-grace"
            }
          ],
          replies: Math.max(discussion.replies ?? 0, (discussion.replyPosts?.length ?? 0) + 1),
          replyPosts: [...(discussion.replyPosts ?? []), reply]
        }
        : discussion
    ));
    await route.fulfill({
      contentType: "application/json",
      json: { id: "reply-created" }
    });
  });
  await page.route("**/api/forum/topics/*/like", async (route) => {
    const payload = route.request().postDataJSON();
    state.topicReactionPayloads.push(payload);
    await route.fulfill(options.failTopicReaction ? {
      contentType: "application/json",
      json: { error: "reaction_failed" },
      status: 500
    } : {
      contentType: "application/json",
      json: { liked: true, likes: 1, reaction: "heart", reactions: [{ count: 1, reaction: "heart" }] }
    });
  });
  await page.route("**/api/forum/topics/*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    const topicId = decodeURIComponent(/\/api\/forum\/topics\/([^/]+)$/.exec(new URL(route.request().url()).pathname)?.[1] ?? "");
    state.topicDetailIds.push(topicId);
    const discussion = discussions.find((item) => item.id === topicId);
    await route.fulfill(discussion ? {
      contentType: "application/json",
      json: { discussion }
    } : {
      contentType: "application/json",
      json: { error: "forum_topic_not_found" },
      status: 404
    });
  });
  await page.route(/\/api\/forum\/topics(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON() as { body: string; categorySlug: string; title: string };
      state.topicPayloads.push(payload);
      if (options.failTopicCreate) {
        await route.fulfill({ contentType: "application/json", json: { error: "topic_failed" }, status: 500 });
        return;
      }
      discussions = [{
        id: "topic-created",
        title: payload.title,
        authorId: catalog.currentUser.id,
        author: catalog.currentUser.name,
        authorEmail: catalog.currentUser.email,
        authorAvatarUrl: catalog.currentUser.avatarUrl,
        body: payload.body,
        excerpt: payload.body,
        category: "AI Exploration",
        categorySlug: payload.categorySlug,
        tag: "AI Exploration",
        tags: [],
        bu: catalog.currentUser.team,
        replies: 0,
        views: 0,
        likes: 0,
        reactions: [],
        rootPostId: "root-created",
        lastActive: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        replyPosts: [],
        mentions: [{
          email: "grace@example.test",
          emailPrefix: "grace",
          id: "mention-grace",
          name: "Grace Hopper",
          postId: "root-created",
          text: "@grace",
          userId: "user-grace"
        }]
      }, ...discussions];
      await route.fulfill({
        contentType: "application/json",
        json: {
          id: "topic-created",
          postId: "root-created",
          discussion: discussions[0]
        },
        status: 201
      });
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        discussions: discussions.filter((discussion) => !discussion.pinned),
        pinnedDiscussions: discussions.filter((discussion) => discussion.pinned)
      }
    });
  });

  return state;
}
