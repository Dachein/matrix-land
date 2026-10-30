import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockPortalApis } from "./fixtures/portalApi";
import { fallbackPortal } from "../../src/shared/fallbackPortal";
import { normalizeApiItem } from "../../src/portal/knowledge/utils";

// A previously opened file belongs in Recently accessed, rather than the root
// knowledge-base list. Keep its complete read model in the current user's cache.
const recentlyOpenedFile = normalizeApiItem({
  access: "owner", id: "knowledge-file-1", kind: "html", name: "Market Brief.html",
  ownerUserId: "user-owner", parentPath: "", path: "Market Brief.html",
  description: "HTML briefing page for smoke testing.", modifiedAt: "2026-07-02T12:00:00.000Z",
  shareMode: "company", sizeBytes: 24800, tags: ["brief"], version: "v3"
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ userId, item }) => {
    window.localStorage.setItem("workspace-ai:locale", "en");
    window.localStorage.setItem(`workspace:knowledge:recent:${userId}`, JSON.stringify([item]));
  }, { userId: fallbackPortal.currentUser.id, item: recentlyOpenedFile });
  await mockPortalApis(page);
});

function itemRow(page: Page, id: string) {
  return page.locator(`[data-knowledge-item-id="${id}"]`);
}

async function openProperties(page: Page, id: string) {
  await expect(page.locator(".portal-knowledge-loading-skeleton")).toHaveCount(0);
  await itemRow(page, id).getByRole("button", { name: "File action menu", exact: true }).click();
  await page.getByRole("menuitem", { name: /^(More|Knowledge base settings)$/ }).click();
  return page.getByRole("complementary", { name: "File details" });
}

test("unifies owned and shared knowledge bases and filters relationships without duplicates", async ({ page }) => {
  await page.goto("/#/knowledge");
  await expect(page.getByRole("heading", { level: 1, name: "Knowledge Base" })).toBeVisible();
  const roots = page.locator(".portal-knowledge-unified-row.root");
  await expect(roots).toHaveCount(3);
  await expect(itemRow(page, "shared-collaborator-folder")).toHaveCount(1);
  await expect(itemRow(page, "shared-collaborator-folder")).toContainText("Collaboration (1)");
  await expect(itemRow(page, "shared-viewer-folder")).toContainText("Shared knowledge");
  await expect(page.getByRole("button", { name: "New Knowledge Base", exact: true })).toBeVisible();
  await expect(page.getByText("Recently accessed", { exact: true })).toBeVisible();
  await expect(itemRow(page, "knowledge-file-1")).toBeVisible();

  const relationships = page.locator('.portal-knowledge-sections[aria-label="Filter knowledge bases by my relationship"]');
  await relationships.getByRole("button", { name: "Mine", exact: true }).click();
  await expect(roots).toHaveCount(2);
  await expect(itemRow(page, "shared-collaborator-folder")).toBeVisible();
  await expect(itemRow(page, "shared-viewer-folder")).toHaveCount(0);
  await relationships.getByRole("button", { name: "Shared with me", exact: true }).click();
  await expect(roots).toHaveCount(1);
  await expect(itemRow(page, "shared-viewer-folder")).toBeVisible();
  await relationships.getByRole("button", { name: "All", exact: true }).click();
  await expect(roots).toHaveCount(3);
  await page.getByRole("searchbox", { name: "Search My Knowledge files" }).fill("Shared Research");
  await expect(roots).toHaveCount(1);
  await expect(itemRow(page, "shared-collaborator-folder")).toBeVisible();
});

for (const legacySection of ["my", "services", "collaboration"]) {
  test(`opens the unified Knowledge workspace from the legacy ${legacySection} address`, async ({ page }) => {
    await page.goto(`/#/knowledge/${legacySection}`);
    await expect(page.locator(".portal-knowledge-unified-row.root")).toHaveCount(3);
    await expect(page.locator('.portal-knowledge-sections[aria-label="Filter knowledge bases by my relationship"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Agent Knowledge", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "My Folder", exact: true })).toHaveCount(0);
  });
}

test("opens collaborative folders with editing controls and keeps Viewer folders read-only", async ({ page }) => {
  await page.goto("/#/knowledge");
  const sharedRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname.endsWith("/k/api/tree") && url.searchParams.get("folderObjectId") === "shared-collaborator-folder";
  });
  await itemRow(page, "shared-collaborator-folder").locator(".portal-knowledge-unified-hit").click();
  await sharedRequest;
  const path = page.getByRole("navigation", { name: "Folder path" });
  await expect(path).toContainText("Shared Research");
  await expect(page.getByRole("columnheader")).toHaveText(["Name", "Type", "Modified", "Size"]);
  await expect(page.getByRole("button", { name: "New folder", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload", exact: true })).toBeVisible();
  await expect(itemRow(page, "shared-collaborator-folder-file")).toBeVisible();
  await path.getByRole("button", { name: "Back", exact: true }).click();

  const details = await openProperties(page, "shared-viewer-folder");
  await expect(details).toContainText("Shared with me");
  await expect(details.getByRole("button", { name: "Set collaborators" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Transfer Owner" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Unpublish" })).toHaveCount(0);
  await details.getByRole("button", { name: "Hide properties" }).click();
  await itemRow(page, "shared-viewer-folder").locator(".portal-knowledge-unified-hit").click();
  await expect(path).toContainText("Company Handbook");
  await expect(page.getByRole("button", { name: "New folder", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upload", exact: true })).toHaveCount(0);
  const file = itemRow(page, "shared-viewer-folder-file");
  await expect(file).toBeVisible();
  await file.getByRole("button", { name: "File action menu", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await file.locator(".portal-knowledge-unified-hit").click();
  await expect(page.getByRole("dialog", { name: "handbook.md Viewer" })).toBeVisible();
});

test("shows properties and the Worker viewer on desktop and mobile without workspace overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/k/view/knowledge-file-1**", (route) => route.fulfill({ body: "<h1>Market brief</h1>", contentType: "text/html" }));
  await page.goto("/#/knowledge");
  const live = page.getByRole("complementary", { name: "Live platform rail" });
  await expect(live).toBeHidden();
  await page.getByRole("button", { name: "Open Live" }).click();
  await expect(live).toBeVisible();
  const details = await openProperties(page, "knowledge-file-1");
  await expect(details.locator("header strong")).toHaveText("Market Brief.html");
  await expect(live).toBeHidden();
  const owner = details.getByRole("button", { name: "Open Knowledge Owner profile" });
  await expect(owner).toHaveText("Knowledge Owner");
  await owner.hover();
  await expect(page.getByRole("tooltip")).toContainText("knowledge.owner@example.test");
  await details.getByRole("button", { name: "Hide properties" }).click();
  await expect(live).toBeVisible();

  await itemRow(page, "knowledge-file-1").locator(".portal-knowledge-unified-hit").click();
  const viewer = page.getByRole("dialog", { name: "Market Brief.html Viewer" });
  await expect(viewer.locator("iframe")).toHaveAttribute("src", /\/k\/view\/knowledge-file-1\?embed=modal$/);
  await viewer.getByRole("button", { name: "More", exact: true }).click();
  await expect(viewer.getByRole("menu", { name: "More file actions" }).getByRole("menuitem", { name: "Download", exact: true })).toBeVisible();
  await viewer.getByRole("menuitem", { name: "Fullscreen", exact: true }).click();
  await expect(viewer).toHaveClass(/fullscreen/);
  await page.keyboard.press("Escape");
  await expect(viewer).not.toHaveClass(/fullscreen/);
  await viewer.getByRole("button", { name: "Close", exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".portal-knowledge-surface")).toBeVisible();
  const mobileDetails = await openProperties(page, "knowledge-folder-1");
  await expect(mobileDetails).toBeVisible();
  await expect(page.locator(".portal-mobile-scrim")).toBeVisible();
  await mobileDetails.getByRole("button", { name: "Hide properties" }).click();
  await expect(mobileDetails).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("keeps a menu open after scrolling its trigger into view and closes on later movement", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto("/#/knowledge");
  await expect(page.locator(".portal-knowledge-unified-row.root")).toHaveCount(3);
  const trigger = itemRow(page, "knowledge-file-1").getByRole("button", { name: "File action menu", exact: true });
  // The trigger starts below the viewport. Opening it must survive the queued
  // scroll notification from the browser bringing the button into view.
  await trigger.click();
  const menu = page.getByRole("menu", { name: "File action menu" });
  await expect(menu.getByRole("menuitem", { name: "More", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.evaluate(() => window.scrollBy(0, -80));
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.getByRole("heading", { level: 1, name: "Knowledge Base" }).click();
  await expect(menu).toHaveCount(0);
});

test("copies a folder-specific Agent instruction directly when Workspace MCP is connected", async ({ context, page, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  await page.route("**/api/mcp/connections/status", (route) => route.fulfill({ contentType: "application/json", json: {
    status: { activeCount: 1, connected: true, connections: [{ id: "connection-1", status: "active", agentType: "codex", scopes: ["workspace:knowledge:read"] }], maxActiveConnections: 3 }
  } }));
  await page.goto("/#/knowledge");
  await itemRow(page, "shared-collaborator-folder").locator(".portal-knowledge-unified-hit").click();
  const copy = page.getByRole("navigation", { name: "Folder path" }).getByRole("button", { name: "Copy prompt", exact: true });
  await copy.click();
  await expect(page.getByRole("navigation", { name: "Folder path" }).locator(".agentHandoffButton")).toHaveAttribute("data-state", "copied");
  await expect(page.getByRole("dialog", { name: "Workspace MCP MCP Agent handoff guide" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('folderObjectId="shared-collaborator-folder"');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("Shared Research");
});

test("creates a folder and continues directly into Agent Knowledge setup", async ({ page }) => {
  const folderCreates: Array<Record<string, unknown>> = [];
  const handbookUploads: string[] = [];
  const serviceCreates: Array<Record<string, unknown>> = [];
  let handbookReady = false;

  await page.route("**/k/api/folders", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    folderCreates.push(body);
    await route.fulfill({
      contentType: "application/json",
      json: {
        item: {
          access: "owner",
          agentEnabled: false,
          description: "",
          id: "new-agent-knowledge-folder",
          kind: "folder",
          modifiedAt: "2026-08-11T08:00:00.000Z",
          name: body.name,
          ownerUserId: "user-owner",
          parentPath: "",
          path: "board-playbook",
          shareMode: "private",
          sizeBytes: 0,
          tags: [],
          version: "v1"
        }
      },
      status: 201
    });
  });
  await page.route("**/k/api/knowledge-services/preflight**", async (route) => {
    const folderObjectId = new URL(route.request().url()).searchParams.get("folderObjectId");
    if (folderObjectId !== "new-agent-knowledge-folder") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: handbookReady
        ? { handbookObjectId: "new-agent-knowledge-folder-handbook", ready: true, status: "ready" }
        : { ready: false, status: "missing" }
    });
  });
  await page.route("**/k/api/files/upload", async (route) => {
    handbookUploads.push(route.request().postData() ?? "");
    handbookReady = true;
    await route.fulfill({
      contentType: "application/json",
      json: { item: { id: "new-agent-knowledge-folder-handbook", name: "handbook.md" } },
      status: 201
    });
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/knowledge-services")) {
      serviceCreates.push(request.postDataJSON() as Record<string, unknown>);
    }
  });

  await page.goto("/#/knowledge/services");
  const newKnowledgeBase = page.getByRole("button", { name: "New Knowledge Base", exact: true });
  await expect(newKnowledgeBase).toBeVisible();
  await newKnowledgeBase.click();

  const createDialog = page.getByRole("dialog", { name: "New Knowledge Base" });
  await createDialog.getByRole("textbox", { name: "Knowledge base name" }).fill("Board Playbook");
  await createDialog.getByRole("checkbox").check();
  await createDialog.getByRole("button", { name: "Continue to publishing", exact: true }).click();
  await expect.poll(() => folderCreates).toEqual([{ name: "Board Playbook", parentPath: "" }]);

  const serviceDialog = page.getByRole("dialog", { name: "Publish as Knowledge Base" });
  await expect(serviceDialog).toBeVisible();
  await expect(serviceDialog.getByRole("textbox", { name: "Service name" })).toHaveValue("Board Playbook");
  await expect(serviceDialog.getByRole("textbox", { name: "Category" })).toHaveCount(0);
  await expect(serviceDialog.getByRole("textbox", { name: "Tags" })).toHaveCount(0);
  await expect(serviceDialog.getByRole("textbox", { name: "Content languages" })).toHaveCount(0);
  await expect(serviceDialog.getByRole("checkbox", { name: "Allow Agents to submit questions and suggestions through Workspace MCP MCP" })).toHaveCount(0);
  const viewerAccess = serviceDialog.getByRole("group", { name: "Access scope" });
  await expect(viewerAccess).toContainText("These recipients receive read-only access to the knowledge base and can interact through the Agent's Workspace MCP MCP.");
  await expect(viewerAccess.locator("p strong")).toHaveText("Agent's Workspace MCP MCP");
  await expect(serviceDialog.getByText("Agent access", { exact: true })).toHaveCount(0);
  await expect(serviceDialog.getByText("Index status", { exact: true })).toHaveCount(0);
  await expect(serviceDialog.getByRole("checkbox", { name: "Create a starter handbook.md" })).toBeChecked();
  const enableButton = serviceDialog.getByRole("button", { name: "Publish as Knowledge Base", exact: true });
  await expect(enableButton).toBeEnabled();
  await enableButton.click();

  await expect.poll(() => handbookUploads).toHaveLength(1);
  expect(handbookUploads[0]).toContain("new-agent-knowledge-folder");
  expect(handbookUploads[0]).toContain('filename="handbook.md"');
  expect(handbookUploads[0]).toContain("# Board Playbook");
  expect(handbookUploads[0]).toContain("## Content scope");
  expect(handbookUploads[0]).toContain("## Recommended retrieval path");
  await expect.poll(() => serviceCreates).toHaveLength(1);
  expect(serviceCreates[0]).toMatchObject({
    access: { company: false, departments: [], users: [] },
    feedbackEnabled: true,
    folderObjectId: "new-agent-knowledge-folder",
    name: "Board Playbook"
  });
  const enabledDialog = page.getByRole("dialog", { name: "Publishing settings" });
  await expect(enabledDialog).toBeVisible();
  await expect(enabledDialog.getByText("Agent access", { exact: true })).toHaveCount(0);
  await expect(enabledDialog.getByText("Index status", { exact: true })).toBeVisible();
  await enabledDialog.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("[data-knowledge-item-id]").filter({ hasText: "Board Playbook" })).toBeVisible();
});

test("creates a starter handbook when an existing folder is enabled", async ({ page }) => {
  const creates: Array<Record<string, unknown>> = [];
  const handbookUploads: string[] = [];
  let handbookReady = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/knowledge-services")) {
      creates.push(request.postDataJSON() as Record<string, unknown>);
    }
  });
  await page.route("**/k/api/knowledge-services/preflight**", async (route) => {
    const folderObjectId = new URL(route.request().url()).searchParams.get("folderObjectId");
    await route.fulfill({
      contentType: "application/json",
      json: folderObjectId === "knowledge-folder-1" && !handbookReady
        ? { ready: false, status: "missing" }
        : { handbookObjectId: `${folderObjectId}-handbook`, ready: true, status: "ready" }
    });
  });
  await page.route("**/k/api/files/upload", async (route) => {
    handbookUploads.push(route.request().postData() ?? "");
    handbookReady = true;
    await route.fulfill({
      contentType: "application/json",
      json: { item: { id: "knowledge-folder-1-handbook", name: "handbook.md" } },
      status: 201
    });
  });

  await page.goto("/#/knowledge/my");
  const rootFolder = page.locator("[data-knowledge-item-id]").filter({ hasText: "Client Onboarding Kit" });
  await rootFolder.locator(".portal-knowledge-more").click();
  await page.getByRole("menuitem", { name: /^(More|Knowledge base settings)$/ }).click();
  await page.getByRole("complementary", { name: "File details" }).getByRole("button", { name: "Publish as Knowledge Base" }).click();

  const dialog = page.getByRole("dialog", { name: "Publish as Knowledge Base" });
  await expect(dialog.getByText("Prepare handbook.md before enabling")).toHaveCount(0);
  await expect(dialog.getByLabel("How to prepare the Handbook")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Copy preparation prompt" })).toHaveCount(0);
  const createTemplate = dialog.getByRole("checkbox", { name: "Create a starter handbook.md" });
  await expect(createTemplate).toBeChecked();
  const enableButton = dialog.getByRole("button", { name: "Publish as Knowledge Base" });
  await expect(enableButton).toBeEnabled();
  await createTemplate.uncheck();
  await expect(enableButton).toBeDisabled();
  await createTemplate.check();
  await enableButton.click();
  await expect.poll(() => handbookUploads).toHaveLength(1);
  expect(handbookUploads[0]).toContain("knowledge-folder-1");
  expect(handbookUploads[0]).toContain('filename="handbook.md"');
  await expect.poll(() => creates).toHaveLength(1);
});

test("keeps existing Agent Knowledge access fail-closed when settings cannot load", async ({ page }) => {
  await page.route("**/k/api/tree**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        items: [{
          access: "owner",
          agentEnabled: true,
          capabilities: {
            canCreatePublicShare: false,
            canEdit: true,
            canManageAccess: true,
            canManageKnowledgeService: true,
            canManageProtectedStructure: true,
            canUseKnowledgeService: true
          },
          description: "Existing owner-managed Agent knowledge.",
          id: "existing-agent-folder",
          indexStatus: "ready",
          kind: "folder",
          knowledgeServiceId: "service-existing",
          modifiedAt: "2026-07-14T08:00:00.000Z",
          name: "Existing Agent Knowledge",
          ownerUserId: "user-owner",
          parentPath: "",
          path: "existing-agent-knowledge",
          shareMode: "private",
          sizeBytes: 0,
          version: "v1"
        }]
      }
    });
  });
  await page.route("**/k/api/knowledge-services/service-existing", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: { service: { agentEnabled: true, id: "service-existing", indexStatus: "ready" } }
    });
  });

  await page.goto("/#/knowledge/my");
  const folder = page.locator("[data-knowledge-item-id]").filter({ hasText: "Existing Agent Knowledge" });
  await folder.locator(".portal-knowledge-more").click();
  await expect(page.getByRole("menuitem", { name: "Submit feedback" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: /^(More|Knowledge base settings)$/ }).click();
  const details = page.getByRole("complementary", { name: "File details" });
  await details.getByRole("button", { name: "Unpublish" }).click();
  const disableDialog = page.getByRole("dialog", { name: /Unpublish knowledge base.*Existing Agent Knowledge/ });
  await expect(disableDialog.getByText(/revokes recipients.*read-only browsing and Agent retrieval/)).toBeVisible();
  await expect(disableDialog.getByRole("button", { name: "Unpublish" })).toBeDisabled();
  await disableDialog.getByRole("button", { name: "Close" }).click();

  await details.getByRole("button", { name: "Publishing settings" }).click();

  const dialog = page.getByRole("dialog", { name: "Publishing settings" });
  await expect(dialog.getByText(/current settings did not load completely/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save settings" })).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: /Collaborators only/ })).toBeChecked();
});

test("keeps collaborator replacement fail-closed when the current list cannot load", async ({ page }) => {
  await page.route("**/k/api/access**", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { error: "access_unavailable" }, status: 503 });
  });

  await page.goto("/#/knowledge/my");
  const folder = page.locator("[data-knowledge-item-id]").filter({ hasText: "Client Onboarding Kit" });
  await folder.locator(".portal-knowledge-more").click();
  await page.getByRole("menuitem", { name: /^(More|Knowledge base settings)$/ }).click();
  await page.getByRole("complementary", { name: "File details" }).getByRole("button", { name: "Set collaborators" }).click();

  const dialog = page.getByRole("dialog", { name: "Set collaborators" });
  await expect(dialog.getByText(/current collaborator list did not load completely/)).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Search and select collaborators" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Save collaborators" })).toBeDisabled();
});

test("searches downward for collaborators and a single new Owner", async ({ page }) => {
  await page.goto("/#/knowledge/my");
  const folder = page.locator("[data-knowledge-item-id]").filter({ hasText: "Client Onboarding Kit" });
  await folder.locator(".portal-knowledge-more").click();
  await page.getByRole("menuitem", { name: /^(More|Knowledge base settings)$/ }).click();
  const details = page.getByRole("complementary", { name: "File details" });

  await details.getByRole("button", { name: "Set collaborators" }).click();
  const collaboratorDialog = page.getByRole("dialog", { name: "Set collaborators" });
  const collaboratorInput = collaboratorDialog.getByRole("combobox", { name: "Search and select collaborators" });
  const collaboratorSuggestions = collaboratorDialog.getByRole("listbox", { name: "Available collaborators" });
  await collaboratorInput.focus();
  await expect(collaboratorSuggestions).toHaveCount(0);
  await collaboratorInput.fill("Ali");
  await expect(collaboratorSuggestions.getByRole("option", { name: /Alice Wong/ })).toBeVisible();
  await expectSuggestionsBelowInput(collaboratorDialog, collaboratorSuggestions);
  if (process.env.Portal_CAPTURE_SCREENSHOTS === "1") {
    await page.screenshot({ path: "output/playwright/portal-knowledge-collaborator-search-downward.png" });
  }
  await collaboratorDialog.getByRole("button", { name: "Close" }).click();

  await details.getByRole("button", { name: "Transfer Owner" }).click();
  const ownerDialog = page.getByRole("dialog", { name: "Transfer knowledge base ownership" });
  const ownerInput = ownerDialog.getByRole("combobox", { name: "New Owner" });
  const ownerSuggestions = ownerDialog.getByRole("listbox", { name: "Matching people" });
  await ownerInput.focus();
  await expect(ownerSuggestions).toHaveCount(0);
  await ownerInput.fill("Ali");
  await expect(ownerSuggestions.getByRole("option", { name: /Alice Wong/ })).toBeVisible();
  await expectSuggestionsBelowInput(ownerDialog, ownerSuggestions);
  if (process.env.Portal_CAPTURE_SCREENSHOTS === "1") {
    await page.screenshot({ path: "output/playwright/portal-knowledge-owner-transfer-search.png" });
  }
  await ownerSuggestions.getByRole("option", { name: /Alice Wong/ }).click();
  await expect(ownerDialog.getByRole("button", { name: "Remove selected Owner Alice Wong" })).toBeVisible();
  await ownerInput.fill("Bob");
  await ownerDialog.getByRole("option", { name: /Bob Chen/ }).click();
  await expect(ownerDialog.getByRole("button", { name: "Remove selected Owner Alice Wong" })).toHaveCount(0);
  await expect(ownerDialog.getByRole("button", { name: "Remove selected Owner Bob Chen" })).toBeVisible();
  await expect(ownerDialog.locator(".peopleMentionTag")).toHaveCount(1);
});

test("places the shared department and people picker beside the Agent Knowledge form", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/#/knowledge/my");

  const folder = page.locator("[data-knowledge-item-id]").filter({ hasText: "Client Onboarding Kit" });
  await folder.locator(".portal-knowledge-more").click();
  await page.getByRole("menuitem", { name: /^(More|Knowledge base settings)$/ }).click();
  await page.getByRole("complementary", { name: "File details" }).getByRole("button", { name: "Publish as Knowledge Base" }).click();

  const dialog = page.getByRole("dialog", { name: "Publish as Knowledge Base" });
  const formColumn = dialog.locator(".portal-knowledge-service-form-column");
  await expect(dialog.locator(".portal-knowledge-service-access-pane")).toHaveCount(0);
  await expect(dialog.locator(".portal-knowledge-service-access .accessTargetPicker")).toHaveCount(0);

  await dialog.getByRole("radio", { name: /Specific members/ }).check();
  const pickerPane = dialog.locator(".portal-knowledge-service-access-pane");
  const picker = pickerPane.locator(".accessTargetPicker");
  await expect(dialog).toHaveClass(/with-access-picker/);
  await expect(picker).toBeVisible();
  await expect(dialog.locator(".portal-knowledge-service-access .accessTargetPicker")).toHaveCount(0);
  await expect(formColumn).toHaveCSS("overflow-y", "auto");
  await expect(picker.locator(".accessTargetPickerTree")).toHaveCSS("overflow-y", "auto");

  const desktopDialogBox = await dialog.boundingBox();
  const desktopFormBox = await formColumn.boundingBox();
  const desktopPickerBox = await pickerPane.boundingBox();
  expect(desktopDialogBox?.width).toBeGreaterThan(1000);
  expect(desktopDialogBox?.height).toBeLessThanOrEqual(820);
  expect(desktopPickerBox?.width).toBeCloseTo(380, 0);
  expect(desktopPickerBox?.x).toBeGreaterThan((desktopFormBox?.x ?? 0) + (desktopFormBox?.width ?? 0) - 2);

  const search = pickerPane.getByPlaceholder("Search departments, names, or emails");
  await search.fill("Alice");
  await picker.locator(".accessTargetPickerLine").filter({ hasText: "Alice Wong" }).getByRole("checkbox").check();
  await search.fill("Macro");
  await picker.locator(".accessTargetPickerLine").filter({ hasText: "Macro" }).first().getByRole("checkbox").check();

  const selectedTargets = formColumn.locator(".portal-knowledge-service-access-summary .accessTargetSelectedTags");
  await expect(selectedTargets.locator(".accessTargetSelectedTag")).toHaveCount(2);
  await expect(selectedTargets.locator(".accessTargetSelectedTag.user")).toContainText("Alice Wong");
  await expect(selectedTargets.locator(".accessTargetSelectedTag.department")).toContainText("Macro");
  await selectedTargets.scrollIntoViewIfNeeded();
  await captureReviewScreenshot(page, "portal-knowledge-agent-access-desktop.png");

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(dialog).toBeVisible();
  const mobileFormBox = await formColumn.boundingBox();
  const mobilePickerBox = await pickerPane.boundingBox();
  expect(mobilePickerBox?.x).toBeCloseTo(mobileFormBox?.x ?? 0, 0);
  expect(mobilePickerBox?.y).toBeGreaterThan((mobileFormBox?.y ?? 0) + (mobileFormBox?.height ?? 0) - 2);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await pickerPane.scrollIntoViewIfNeeded();
  await captureReviewScreenshot(page, "portal-knowledge-agent-access-mobile.png");
});

test("creates public file links explicitly and upgrades folders without Skill publishing", async ({ page }, testInfo) => {
  const collaboratorPuts: Array<Record<string, unknown>> = [];
  const publicSharePosts: Array<Record<string, unknown>> = [];
  const servicePosts: Array<Record<string, unknown>> = [];
  const servicePatches: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/collaborators")) {
      collaboratorPuts.push(request.postDataJSON() as Record<string, unknown>);
    }
    if (request.method() === "POST" && request.url().includes("/public-share")) {
      publicSharePosts.push(request.postDataJSON() as Record<string, unknown>);
    }
    if (request.method() === "POST" && request.url().endsWith("/api/knowledge-services")) {
      servicePosts.push(request.postDataJSON() as Record<string, unknown>);
    }
    if (request.method() === "PATCH" && request.url().endsWith("/api/knowledge-services/service-1")) {
      servicePatches.push(request.postDataJSON() as Record<string, unknown>);
    }
  });

  await page.goto("/#/knowledge/my");
  const fileRow = page.locator("[data-knowledge-item-id]").filter({ hasText: "Market Brief.html" });
  await fileRow.locator(".portal-knowledge-more").click();
  await page.getByRole("menuitem", { name: /^(More|Knowledge base settings)$/ }).click();
  const details = page.getByRole("complementary", { name: "File details" });
  await details.getByRole("button", { name: "Public share" }).click();
  const shareDialog = page.getByRole("dialog", { name: "Public share" });
  await expect(shareDialog).toBeVisible();
  await expect.poll(() => publicSharePosts.length).toBe(0);
  const shareExpiry = shareDialog.getByRole("button", { name: "Expiry" });
  await expect(shareExpiry).toContainText("24 hours (default)");
  await shareExpiry.click();
  const shareExpiryOptions = page.getByRole("listbox", { name: "Expiry" });
  await expect(shareExpiryOptions.getByRole("option", { name: "24 hours (default)" })).toHaveAttribute("aria-selected", "true");
  await testInfo.attach("knowledge-public-share-expiry-listbox", {
    body: await page.screenshot(),
    contentType: "image/png"
  });
  if (process.env.Portal_CAPTURE_SCREENSHOTS === "1") {
    await page.screenshot({ path: "output/playwright/portal-knowledge-share-expiry-listbox.png" });
  }
  await shareExpiryOptions.getByRole("option", { name: "Permanent" }).click();
  await expect(shareExpiry).toContainText("Permanent");
  await expect(shareDialog.getByRole("button", { name: "Create public link" })).toBeDisabled();
  await shareDialog.getByRole("checkbox").check();
  await shareDialog.getByRole("button", { name: "Create public link" }).click();
  await expect.poll(() => publicSharePosts).toEqual([{ expiry: "permanent" }]);
  await expect(shareDialog.locator('input[value="https://knowledge.example.test/public-share"]')).toBeVisible();
  await shareDialog.getByRole("button", { name: "Revoke link" }).click();
  await expect(shareDialog.getByRole("button", { name: "Create public link" })).toBeVisible();
  await shareDialog.getByRole("button", { name: "Close" }).click();

  const folderRow = page.locator("[data-knowledge-item-id]").filter({ hasText: "Client Onboarding Kit" });
  await folderRow.locator(".portal-knowledge-more").click();
  await expect(page.getByRole("menuitem", { name: "Public share" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: /^(More|Knowledge base settings)$/ }).click();
  await details.getByRole("button", { name: "Set collaborators" }).click();
  const accessDialog = page.getByRole("dialog", { name: "Set collaborators" });
  await expect(accessDialog).toContainText("Invite people to maintain this knowledge base together");
  await expect(accessDialog).toContainText("Only the Owner can manage members and publishing settings.");
  await expect(accessDialog.getByRole("combobox", { name: "Search and select collaborators" })).toBeVisible();
  await expect(accessDialog).toContainText("Bob Chen");
  await expect(accessDialog.getByText("Entire company")).toHaveCount(0);
  await expect(accessDialog.getByText("Viewer", { exact: true })).toHaveCount(0);
  await accessDialog.getByRole("button", { name: "Remove collaborator Bob Chen" }).click();
  await accessDialog.getByRole("combobox", { name: "Search and select collaborators" }).fill("Alice");
  await accessDialog.getByRole("option", { name: /Alice Wong/ }).click();
  await accessDialog.getByRole("button", { name: "Save collaborators" }).click();
  await expect(accessDialog).toHaveCount(0);
  await expect.poll(() => collaboratorPuts).toEqual([{ userIds: ["user-alice"] }]);
  await details.getByRole("button", { name: "Publish as Knowledge Base" }).click();
  const serviceDialog = page.getByRole("dialog", { name: "Publish as Knowledge Base" });
  await expect(serviceDialog).toContainText("handbook.md");
  await expect(serviceDialog).toContainText("Access scope");
  await expect(serviceDialog).toContainText("read-only access");
  await expect(serviceDialog.getByRole("radio", { name: /Collaborators only/ })).toBeChecked();
  await expect(serviceDialog).not.toContainText("skill.md");
  await serviceDialog.getByRole("radio", { name: /Specific members/ }).check();
  await serviceDialog.getByLabel("Maintenance team (optional)").fill("Compliance Team");
  await serviceDialog.getByPlaceholder("Search departments, names, or emails").fill("Macro");
  await serviceDialog.locator(".accessTargetPickerLine").filter({ hasText: "Macro" }).getByRole("checkbox").check();
  await serviceDialog.getByRole("button", { name: "Publish as Knowledge Base" }).click();
  await expect.poll(() => servicePosts.length).toBe(1);
  expect(servicePosts[0]).not.toHaveProperty("visibility");
  expect(servicePosts[0]).not.toHaveProperty("accessTargets");
  expect(servicePosts[0]).toMatchObject({
    access: { company: false, departments: ["dept-macro"], users: [] },
    maintenanceTeam: "Compliance Team"
  });
  const enabledServiceDialog = page.getByRole("dialog", { name: "Publishing settings" });
  await expect(enabledServiceDialog.getByRole("button", { name: "Unpublish" })).toHaveCount(0);
  await expect(enabledServiceDialog.getByText(/Disabling downgrades this knowledge base/)).toHaveCount(0);
  await enabledServiceDialog.getByRole("button", { name: "Close" }).click();

  await details.getByRole("button", { name: "Unpublish" }).click();
  const disableDialog = page.getByRole("dialog", { name: /Unpublish knowledge base.*Client Onboarding Kit/ });
  await disableDialog.getByRole("checkbox", { name: /I confirm that I want to unpublish/ }).check();
  await disableDialog.getByRole("button", { name: "Unpublish" }).click();
  await expect.poll(() => servicePatches).toEqual([{ agentEnabled: false }]);
  await expect(disableDialog).toHaveCount(0);
});

test("keeps nested-folder access inherited in details and the right-click menu", async ({ page }) => {
  const creates: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/knowledge-services")) {
      creates.push(request.postDataJSON() as Record<string, unknown>);
    }
  });

  await page.goto("/#/knowledge/my");
  const parentFolder = page.locator("[data-knowledge-item-id]").filter({ hasText: "Client Onboarding Kit" });
  await parentFolder.locator(".portal-knowledge-unified-hit").click();

  const nestedFolder = page.locator("[data-knowledge-item-id]").filter({ hasText: "Nested Reference" });
  await expect(nestedFolder).toBeVisible();
  await nestedFolder.locator(".portal-knowledge-more").click();
  await page.getByRole("menuitem", { name: "More", exact: true }).click();
  const details = page.getByRole("complementary", { name: "File details" });
  await expect(details).toContainText("I own · Inherited from Root Folder");
  await expect(details).toContainText("Included in the parent Agent Knowledge");
  await expect(details.getByRole("button", { name: "Set collaborators" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Publish as Knowledge Base" })).toHaveCount(0);

  await nestedFolder.locator(".portal-knowledge-more").click();
  const menu = page.getByRole("menu", { name: "File action menu" });
  await expect(menu.getByRole("menuitem", { name: /^(More|Knowledge base settings)$/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Set collaborators" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Publish as Knowledge Base" })).toHaveCount(0);
  expect(creates).toEqual([]);

  await details.getByRole("button", { name: "Hide properties" }).click();
  const folderPath = page.getByRole("navigation", { name: "Folder path" });
  await expect(folderPath.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  await expect(folderPath.getByRole("button", { name: /Actions for current folder/ })).toHaveCount(0);
  await folderPath.getByRole("button", { name: "Back", exact: true }).click();
  await expect(parentFolder).toBeVisible();
});

async function expectSuggestionsBelowInput(dialog: Locator, suggestions: Locator) {
  const inputSurfaceBox = await dialog.locator(".peopleMentionInputSurface").boundingBox();
  const suggestionsBox = await suggestions.boundingBox();
  expect(inputSurfaceBox).not.toBeNull();
  expect(suggestionsBox).not.toBeNull();
  expect(suggestionsBox?.y).toBeGreaterThanOrEqual(
    (inputSurfaceBox?.y ?? 0) + (inputSurfaceBox?.height ?? 0)
  );
}

async function captureReviewScreenshot(page: import("@playwright/test").Page, name: string) {
  if (process.env.Portal_CAPTURE_SCREENSHOTS === "1") {
    await page.screenshot({ fullPage: true, path: `output/playwright/${name}` });
  }
}

function deferredHistoryResponse() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settleHistoryResponse(page: Page, response: import("@playwright/test").Response) {
  await response.finished();
  // Let the fetch continuation and its React render settle before checking for
  // a late overwrite. An immediate positive assertion could pass too early.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

test("keeps the newly selected audit change when an earlier diff arrives late", async ({ page }) => {
  const firstDiff = deferredHistoryResponse();
  const firstDiffStarted = deferredHistoryResponse();
  await page.route("**/k/api/audit/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/k/api/audit/changes") {
      await route.fulfill({ json: { changes: [
        { id: "change-a", operation: "edit", summary: "Earlier change" },
        { id: "change-b", operation: "edit", summary: "Selected change" }
      ] } });
    } else if (path.endsWith("/diff")) {
      if (path.includes("diff-a")) {
        firstDiffStarted.resolve();
        await firstDiff.promise;
      }
      await route.fulfill({ json: { diff: path.includes("diff-a") ? "OUTDATED DIFF" : "CURRENT DIFF" } });
    } else {
      const id = path.endsWith("change-a") ? "a" : "b";
      await route.fulfill({ json: {
        change: { id: `change-${id}`, operation: "edit", requestId: `request-${id}` },
        items: [{ id: `diff-${id}`, objectId: "knowledge-file-1", diff: { status: "ready" } }]
      } });
    }
  });
  await page.goto("/#/knowledge");
  const properties = await openProperties(page, "knowledge-file-1");
  await properties.getByRole("button", { name: "History & audit", exact: true }).click();
  const history = page.getByRole("dialog", { name: "History & audit for “Market Brief.html”" });
  try {
    await firstDiffStarted.promise;
    await history.getByRole("button", { name: /Selected change/ }).click();
    await expect(history.locator(".portal-knowledge-history-detail")).toContainText("request-b");
    await expect(history.locator("pre")).toHaveText("CURRENT DIFF");
    const lateResponse = page.waitForResponse((response) => response.url().includes("/diff-a/diff"));
    firstDiff.resolve();
    await settleHistoryResponse(page, await lateResponse);
    await expect(history.locator(".portal-knowledge-history-detail")).toContainText("request-b");
    await expect(history.locator("pre")).toHaveText("CURRENT DIFF");
    await expect(history.getByRole("combobox")).toBeEnabled();
  } finally {
    firstDiff.resolve();
  }
});

test("invalidates an earlier audit list when closing and reopening the same file", async ({ page }) => {
  const oldList = deferredHistoryResponse();
  const oldListStarted = deferredHistoryResponse();
  let listReads = 0;
  let staleDetailReads = 0;
  await page.route("**/k/api/audit/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/k/api/audit/changes") {
      const old = ++listReads === 1;
      if (old) {
        oldListStarted.resolve();
        await oldList.promise;
      }
      await route.fulfill({ json: { changes: [{
        id: old ? "stale" : "fresh", operation: "edit", summary: old ? "Stale history" : "Fresh history"
      }] } });
    } else {
      if (path.endsWith("/stale")) staleDetailReads++;
      await route.fulfill({ json: { change: { id: path.split("/").at(-1) }, items: [] } });
    }
  });
  await page.goto("/#/knowledge");
  const properties = await openProperties(page, "knowledge-file-1");
  await properties.getByRole("button", { name: "History & audit", exact: true }).click();
  const history = page.getByRole("dialog", { name: "History & audit for “Market Brief.html”" });
  try {
    await oldListStarted.promise;
    await history.getByRole("button", { name: "Close", exact: true }).click();
    await properties.getByRole("button", { name: "History & audit", exact: true }).click();
    await expect(history.getByRole("button", { name: /Fresh history/ })).toBeVisible();
    const lateResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/k/api/audit/changes");
    oldList.resolve();
    await settleHistoryResponse(page, await lateResponse);
    await expect(history.getByRole("button", { name: /Fresh history/ })).toBeVisible();
    await expect(history.getByRole("button", { name: /Stale history/ })).toHaveCount(0);
    expect(staleDetailReads).toBe(0);
    await expect(history.getByRole("combobox")).toBeEnabled();
  } finally {
    oldList.resolve();
  }
});
