import { expect, test, type Page } from "@playwright/test";
import { fallbackPortal } from "../../src/shared/fallbackPortal";
import type { Discussion, PortalCatalog } from "../../src/shared/types";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
});

async function mockForum(page: Page) {
  const catalog = structuredClone(fallbackPortal) as PortalCatalog;
  const discussions = structuredClone(catalog.discussions) as Discussion[];

  await page.route("**/api/**", (route) => route.fulfill({
    contentType: "application/json", json: { error: "unmocked" }, status: 501
  }));
  await page.route("**/api/home-bootstrap", (route) => route.fulfill({
    contentType: "application/json", json: { error: "home_bootstrap_not_mocked" }, status: 404
  }));
  await page.route("**/api/auth/session", (route) => route.fulfill({
    contentType: "application/json",
    json: { authenticated: true, configured: false, loginUrl: "/auth/login" }
  }));
  await page.route("**/api/catalog", (route) => route.fulfill({
    contentType: "application/json", json: { ...catalog, discussions }
  }));
  await page.route("**/api/apps", (route) => route.fulfill({ contentType: "application/json", json: { apps: catalog.apps } }));
  await page.route("**/api/skills", (route) => route.fulfill({ contentType: "application/json", json: { skills: catalog.skills } }));
  await page.route("**/api/publication/listings", (route) => route.fulfill({
    contentType: "application/json", json: { publicationListings: catalog.publicationListings }
  }));
  await page.route("**/api/publication/hub-listings", (route) => route.fulfill({
    contentType: "application/json", json: { hubListings: catalog.hubListings }
  }));
  await page.route("**/api/activity/events**", (route) => route.fulfill({
    contentType: "application/json", json: { events: catalog.activityEvents }
  }));
  await page.route("**/api/journey", (route) => route.fulfill({
    contentType: "application/json", json: { journey: catalog.journey }
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
    contentType: "application/json", json: { users: [] }
  }));
  await page.route("**/api/users/batch**", (route) => route.fulfill({
    contentType: "application/json", json: { users: [{ id: catalog.currentUser.id, name: catalog.currentUser.name }] }
  }));
  await page.route(/\/api\/forum\/topics(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json", json: { discussions, pinnedDiscussions: [] }
  }));
  await page.route("**/api/forum/topics/*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const topicId = decodeURIComponent(/\/api\/forum\/topics\/([^/]+)$/.exec(new URL(route.request().url()).pathname)?.[1] ?? "");
    const discussion = discussions.find((item) => item.id === topicId);
    await route.fulfill(discussion
      ? { contentType: "application/json", json: { discussion } }
      : { contentType: "application/json", json: { error: "not_found" }, status: 404 });
  });
  await page.route("**/api/forum/topics", async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON() as { body: string; categorySlug: string; title: string };
      const created: Discussion = {
        ...structuredClone(discussions[0]),
        id: "topic-audit",
        title: payload.title,
        body: payload.body,
        excerpt: payload.body,
        mentions: [],
        replyPosts: []
      };
      discussions.unshift(created);
      await route.fulfill({
        contentType: "application/json",
        json: { id: "topic-audit", postId: created.rootPostId, discussion: created },
        status: 201
      });
      return;
    }
    await route.fallback();
  });
}

const AUDIT_MARKDOWN = [
  "# Heading one",
  "",
  "### Heading three",
  "",
  "Paragraph with **bold**, *italic*, ~~strike~~, `inline code`, and [a link](https://example.com).",
  "",
  "> a quoted line",
  "",
  "- bullet one",
  "- bullet two",
  "",
  "1. ordered one",
  "2. ordered two",
  "",
  "- [ ] unchecked task",
  "- [x] checked task",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "| Col A | Col B |",
  "| --- | --- |",
  "| a1 | b1 |",
  "",
  "---",
  "",
  "![alt text](https://example.com/pic.png)"
].join("\n");

test("preserves Markdown through editing and published display", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ height: 1000, width: 1440 });
  await mockForum(page);
  await page.goto("/#/home");

  await page.getByRole("button", { name: "New post" }).first().click();
  const composer = page.getByRole("dialog", { name: "New Topic" });
  await composer.locator(".titleField input").fill("Parity audit");
  const textarea = composer.locator(".forumPlainTextArea");
  await textarea.fill(AUDIT_MARKDOWN);

  await composer.getByRole("button", { name: "Markdown Editor", exact: true }).click();
  const expanded = page.getByRole("dialog", { name: "Markdown Editor" });
  const surface = expanded.locator("[contenteditable='true']").first();
  await expect(surface).toContainText("Heading one");

  const editorReport = await surface.evaluate((root) => ({
    h1: root.querySelectorAll("h1").length,
    h3: root.querySelectorAll("h3").length,
    strong: root.querySelectorAll("strong, b").length,
    em: root.querySelectorAll("em, i").length,
    s: root.querySelectorAll("s, del, [data-strike], .bn-strike").length,
    inlineCode: root.querySelectorAll("code").length,
    pre: root.querySelectorAll("pre").length,
    blockquote: root.querySelectorAll("blockquote, [data-content-type='quote']").length,
    ul: root.querySelectorAll("ul").length,
    ol: root.querySelectorAll("ol").length,
    checkbox: root.querySelectorAll("input[type='checkbox']").length,
    table: root.querySelectorAll("table").length,
    hr: root.querySelectorAll("hr").length,
    img: root.querySelectorAll("img").length,
    link: root.querySelectorAll("a").length
  }));
  expect(editorReport).toMatchObject({
    checkbox: 2,
    em: 1,
    h1: 1,
    h3: 1,
    hr: 1,
    img: 1,
    inlineCode: 2,
    link: 1,
    pre: 1,
    s: 1,
    strong: 1,
    table: 1
  });
  expect(editorReport.blockquote).toBeGreaterThanOrEqual(1);

  // Toolbar only offers markdown-representable styles (no underline / color).
  await surface.locator("text=Paragraph with").first().dblclick();
  await surface.selectText();
  const toolbar = page.locator(".bn-formatting-toolbar");
  await expect(toolbar).toBeVisible();
  const toolbarLabels = await toolbar.locator("button").evaluateAll(
    (buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? "")
  );
  expect(toolbarLabels.some((label) => /underline|color/i.test(label))).toBe(false);
  await surface.press("Escape");
  await expect(expanded).toBeVisible();

  await expanded.getByRole("button", { name: "Done" }).click();

  const roundtrip = await textarea.inputValue();
  expect(roundtrip).toBe(AUDIT_MARKDOWN);

  await composer.getByRole("button", { name: "Publish" }).click();
  await expect(page).toHaveURL(/#\/posts\//);
  const body = page.locator(".forumMarkdownBody").first();
  await expect(body).toContainText("Heading one");

  const displayReport = await body.evaluate((root) => ({
    h1: root.querySelectorAll("h1").length,
    h3: root.querySelectorAll("h3").length,
    strong: root.querySelectorAll("strong").length,
    em: root.querySelectorAll("em").length,
    s: root.querySelectorAll("s").length,
    inlineCode: root.querySelectorAll("p code, li code").length,
    pre: root.querySelectorAll("pre").length,
    blockquote: root.querySelectorAll("blockquote").length,
    ul: root.querySelectorAll("ul").length,
    ol: root.querySelectorAll("ol").length,
    checkbox: root.querySelectorAll("input[type='checkbox']").length,
    table: root.querySelectorAll("table").length,
    hr: root.querySelectorAll("hr").length,
    img: root.querySelectorAll("img").length,
    link: root.querySelectorAll("a").length,
    taskLiteral: root.textContent?.includes("[ ]") ?? false
  }));
  expect(displayReport).toEqual({
    blockquote: 1,
    checkbox: 2,
    em: 1,
    h1: 1,
    h3: 1,
    hr: 1,
    img: 1,
    inlineCode: 1,
    link: 1,
    ol: 1,
    pre: 1,
    s: 1,
    strong: 1,
    table: 1,
    taskLiteral: false,
    ul: 2
  });

  // Code block copy button copies the fenced content.
  const copyButton = body.locator(".forumCodeCopyButton").first();
  await body.locator(".forumCodeBlock").first().hover();
  await expect(copyButton).toBeVisible();
  await copyButton.click();
  await expect(copyButton).toHaveClass(/copied/);
  await expect(copyButton).toHaveAttribute("aria-label", "Code copied");
  const copiedText = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiedText).toContain("const answer = 42;");
});

test("immersive Markdown editor uses a full-screen desk and focused paper", async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1440 });
  await mockForum(page);
  await page.goto("/#/home");

  await page.getByRole("button", { name: "New post" }).first().click();
  const composer = page.getByRole("dialog", { name: "New Topic" });
  const titleInput = composer.locator(".titleField input");
  await titleInput.fill("Original topic title");
  const textarea = composer.locator(".forumPlainTextArea");
  await textarea.fill("# Short post");
  const editorLauncher = composer.getByRole("button", { name: "Markdown Editor", exact: true });
  const launcherGeometry = await editorLauncher.evaluate((button) => {
    const textarea = button.closest(".markdownComposer")?.querySelector<HTMLTextAreaElement>(".forumPlainTextArea");
    const buttonBox = button.getBoundingClientRect();
    const textareaBox = textarea?.getBoundingClientRect();
    return {
      buttonBottom: buttonBox.bottom,
      buttonRight: buttonBox.right,
      buttonTop: buttonBox.top,
      textareaBottom: textareaBox?.bottom ?? 0,
      textareaRight: textareaBox?.right ?? 0
    };
  });
  expect(launcherGeometry.buttonTop).toBeGreaterThan(launcherGeometry.textareaBottom - 48);
  expect(launcherGeometry.buttonBottom).toBeLessThan(launcherGeometry.textareaBottom);
  expect(launcherGeometry.buttonRight).toBeLessThan(launcherGeometry.textareaRight);
  await expect(composer.getByText(/Switch to/i)).toHaveCount(0);
  await editorLauncher.click();

  const expanded = page.getByRole("dialog", { name: "Markdown Editor" });
  const editorFrame = expanded.locator(".forumBlockNoteEditor.bn-container");
  const editable = editorFrame.locator("[contenteditable='true']");
  const expandedTitle = expanded.getByRole("textbox", { name: "Title" });
  await expect(expandedTitle).toHaveValue("Original topic title");
  await expandedTitle.fill("Title edited in Markdown");
  await expect(editable).toContainText("Short post");

  const geometry = await expanded.evaluate((dialog) => {
    const count = dialog.querySelector<HTMLElement>(".markdownEditorCharacterCount")!;
    const paper = dialog.querySelector<HTMLElement>(".markdownEditorPaper")!;
    const frame = dialog.querySelector<HTMLElement>(".forumBlockNoteEditor.bn-container")!;
    const surface = frame.querySelector<HTMLElement>("[contenteditable='true']")!;
    const dialogBox = dialog.getBoundingClientRect();
    const countBox = count.getBoundingClientRect();
    const paperBox = paper.getBoundingClientRect();
    const frameBox = frame.getBoundingClientRect();
    const surfaceBox = surface.getBoundingClientRect();
    const frameStyle = window.getComputedStyle(frame);
    const paperStyle = window.getComputedStyle(paper);
    const surfaceStyle = window.getComputedStyle(surface);
    return {
      dialogHeight: dialogBox.height,
      dialogWidth: dialogBox.width,
      countBottomGap: dialogBox.bottom - countBox.bottom,
      countRightGap: paperBox.right - countBox.right,
      frameHeight: frameBox.height,
      frameWidth: frameBox.width,
      frameBorderWidth: frameStyle.borderTopWidth,
      paperBorderRadius: paperStyle.borderRadius,
      paperBoxShadow: paperStyle.boxShadow,
      paperWidth: paperBox.width,
      surfaceHeight: surfaceBox.height,
      writingWidth: surfaceBox.width
        - Number.parseFloat(surfaceStyle.paddingLeft)
        - Number.parseFloat(surfaceStyle.paddingRight)
    };
  });

  expect(
    Math.abs(geometry.surfaceHeight - geometry.frameHeight),
    `editor geometry: ${JSON.stringify(geometry)}`
  ).toBeLessThanOrEqual(2);
  expect(Math.abs(geometry.dialogHeight - 1000)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.dialogWidth - 1440)).toBeLessThanOrEqual(1);
  expect(geometry.countBottomGap).toBeGreaterThanOrEqual(16);
  expect(geometry.countBottomGap).toBeLessThanOrEqual(20);
  expect(geometry.countRightGap).toBeGreaterThanOrEqual(22);
  expect(geometry.countRightGap).toBeLessThanOrEqual(26);
  expect(geometry.paperWidth).toBeGreaterThanOrEqual(890);
  expect(geometry.paperWidth).toBeLessThanOrEqual(900);
  expect(geometry.writingWidth).toBeGreaterThanOrEqual(760);
  expect(geometry.writingWidth).toBeLessThanOrEqual(780);
  expect(geometry.frameBorderWidth).toBe("0px");
  expect(geometry.paperBorderRadius).not.toBe("0px");
  expect(geometry.paperBoxShadow).not.toBe("none");
  await expect(editorFrame).toHaveAttribute("aria-label", "Post body");
  await expect(expanded.getByText("Post body", { exact: true })).toHaveCount(0);
  await expect(expanded.getByText("12 / 8000 characters", { exact: true })).toBeVisible();

  await expanded.getByRole("button", { name: "Done" }).focus();
  await editorFrame.click({ position: { x: geometry.frameWidth / 2, y: geometry.frameHeight - 24 } });
  await page.keyboard.type("bottom click works");
  await expect(editable).toContainText("bottom click works");
  await expanded.getByRole("button", { name: "Done" }).click();
  await expect(textarea).toHaveValue(/bottom click works/);
  await expect(titleInput).toHaveValue("Title edited in Markdown");

  await composer.getByRole("button", { name: "Cancel" }).click();
  const postTitle = "How should high-risk legal write scopes be confirmed?";
  await page.getByRole("button", { name: `Open discussion: ${postTitle}` }).click();
  const replyComposer = page.locator("#forum-reply-composer");
  await replyComposer.getByRole("button", { name: "Markdown Editor", exact: true }).click();
  const replyEditor = page.getByRole("dialog", { name: "Markdown Editor" });
  await expect(replyEditor.locator(".markdownEditorHeaderTitle")).toHaveText(`Reply to 【${postTitle}】`);
});

test("full-screen editor offers upload and embeds images and files in Markdown", async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1440 });
  await mockForum(page);
  const uploaded = [
    {
      storageProvider: "r2",
      storageKey: "forum/2026/08/diagram.png",
      publicUrl: "/api/forum/media/forum/2026/08/diagram.png",
      mimeType: "image/png",
      fileName: "diagram.png",
      fileSize: 68
    },
    {
      storageProvider: "r2",
      storageKey: "forum/2026/08/guide.pdf",
      publicUrl: "/api/forum/media/forum/2026/08/guide.pdf",
      mimeType: "application/pdf",
      fileName: "guide.pdf",
      fileSize: 24
    }
  ];
  let uploadIndex = 0;
  await page.route("**/api/forum/media", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      contentType: "application/json",
      json: { attachments: [uploaded[uploadIndex++]] },
      status: 201
    });
  });

  await page.goto("/#/home");
  await page.getByRole("button", { name: "New post" }).first().click();
  const composer = page.getByRole("dialog", { name: "New Topic" });
  await composer.locator(".titleField input").fill("Inline upload contract");
  await composer.getByRole("button", { name: "Markdown Editor", exact: true }).click();
  const expanded = page.getByRole("dialog", { name: "Markdown Editor" });
  const surface = expanded.locator("[contenteditable='true']").first();

  await surface.click();
  await page.keyboard.type("/image");
  await page.getByText("Image", { exact: true }).last().click();
  await expanded.locator(".bn-add-file-button").click();
  const imagePanel = page.locator(".bn-panel");
  await expect(imagePanel.getByText("Upload", { exact: true })).toBeVisible();
  await expect(imagePanel.getByText("Embed", { exact: true })).toBeVisible();
  await imagePanel.locator("input[type='file']").setInputFiles({
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    mimeType: "image/png",
    name: "diagram.png"
  });
  await expect(page.locator(".forumInlineUploadNotice.uploading")).toContainText("Uploading image");
  await expect(surface.locator("img[src='/api/forum/media/forum/2026/08/diagram.png']")).toBeVisible();

  await surface.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/file");
  await page.getByText("File", { exact: true }).last().click();
  await expanded.locator(".bn-add-file-button").last().click();
  const filePanel = page.locator(".bn-panel");
  await expect(filePanel.getByText("Upload", { exact: true })).toBeVisible();
  await filePanel.locator("input[type='file']").setInputFiles({
    buffer: Buffer.from("%PDF-1.4\n% test file\n"),
    mimeType: "application/pdf",
    name: "guide.pdf"
  });
  await expect(page.locator(".forumInlineUploadNotice.uploading")).toContainText("Uploading file");
  await expect(surface).toContainText("guide.pdf");

  await expanded.getByRole("button", { name: "Done" }).click();
  const markdown = await composer.locator(".forumPlainTextArea").inputValue();
  expect(markdown).toContain("/api/forum/media/forum/2026/08/diagram.png");
  expect(markdown).toContain("/api/forum/media/forum/2026/08/guide.pdf");
});

test("immersive Markdown editor becomes edge-to-edge paper on mobile", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await mockForum(page);
  await page.goto("/#/home");

  await page.getByRole("button", { name: "What do you want to share?" }).click({ force: true });
  const composer = page.getByRole("dialog", { name: "New Topic" });
  await composer.locator(".forumPlainTextArea").fill("Mobile draft");
  await composer.getByRole("button", { name: "Markdown Editor", exact: true }).click();

  const expanded = page.getByRole("dialog", { name: "Markdown Editor" });
  await expect(expanded.locator("[contenteditable='true']")).toContainText("Mobile draft");
  const geometry = await expanded.evaluate((dialog) => {
    const paper = dialog.querySelector<HTMLElement>(".markdownEditorPaper")!;
    const surface = dialog.querySelector<HTMLElement>("[contenteditable='true']")!;
    const dialogBox = dialog.getBoundingClientRect();
    const paperBox = paper.getBoundingClientRect();
    const paperStyle = window.getComputedStyle(paper);
    const surfaceStyle = window.getComputedStyle(surface);
    return {
      dialogHeight: dialogBox.height,
      dialogWidth: dialogBox.width,
      paperBorderRadius: paperStyle.borderRadius,
      paperBoxShadow: paperStyle.boxShadow,
      paperWidth: paperBox.width,
      surfacePaddingLeft: surfaceStyle.paddingLeft
    };
  });

  expect(Math.abs(geometry.dialogHeight - 844)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.dialogWidth - 390)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.paperWidth - 390)).toBeLessThanOrEqual(1);
  expect(geometry.paperBorderRadius).toBe("0px");
  expect(geometry.paperBoxShadow).toBe("none");
  expect(geometry.surfacePaddingLeft).toBe("20px");
  await expanded.getByRole("button", { name: "Back" }).click();
  await expect(expanded).not.toBeVisible();
});
