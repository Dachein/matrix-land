import { expect, test, type Page, type Response } from "@playwright/test";
import { mockPortalApis } from "./fixtures/portalApi";
import { fallbackPortal } from "../../src/shared/fallbackPortal";
import { renderMarkdown } from "../../src/shared/markdownRenderer";

const root = {
  id: "lifecycle-root", name: "Lifecycle Knowledge", kind: "folder", access: "owner",
  path: "lifecycle", parentPath: "", ownerUserId: fallbackPortal.currentUser.id,
  agentEnabled: true, knowledgeServiceId: "lifecycle-service", shareMode: "private"
};
const files = ["A", "B"].map((id) => ({
  id, name: `${id}.md`, kind: "markdown", access: "owner", path: `lifecycle/${id}.md`,
  parentPath: "lifecycle", ownerUserId: fallbackPortal.currentUser.id,
  currentVersionId: `version-${id}`, shareMode: "private", mimeType: "text/markdown"
}));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle(page: Page, response: Response) {
  await response.finished();
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}
function row(page: Page, id: string) { return page.locator(`[data-knowledge-item-id="${id}"]`); }
async function properties(page: Page, id: string) {
  await row(page, id).getByRole("button", { name: "File action menu", exact: true }).click();
  await page.getByRole("menuitem", { name: /^(More|Knowledge base settings)$/ }).click();
  return page.getByRole("complementary", { name: "File details" });
}
async function edit(page: Page, id: string) {
  const details = await properties(page, id);
  await details.getByRole("button", { name: "Edit", exact: true }).click();
  return page.getByRole("dialog", { name: "Edit", exact: true });
}
async function folder(page: Page) {
  await row(page, root.id).locator(".portal-knowledge-unified-hit").click();
  await expect(row(page, "A")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
  await mockPortalApis(page);
  await page.route("**/k/api/shared-with-me**", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/k/api/knowledge-services", (route) => route.fulfill({ json: { services: [] } }));
  await page.route("**/k/api/tree**", (route) => route.fulfill({ json: {
    items: new URL(route.request().url()).searchParams.get("folderObjectId") ? files : [root]
  } }));
  await page.route("**/k/api/files/*/raw", (route) => route.fulfill({ body: `Content ${route.request().url().split("/").at(-2)}`, contentType: "text/plain" }));
});

test("isolates an edit draft and its save target from an older file load", async ({ page }) => {
  const started = deferred(), release = deferred();
  const saves: Array<{ id: string; content: string }> = [];
  await page.route("**/k/api/files/A/raw", async (route) => {
    started.resolve(); await release.promise;
    await route.fulfill({ body: "OUTDATED A", contentType: "text/plain" });
  });
  await page.route("**/k/api/files/*/edit", (route) => {
    saves.push({ id: route.request().url().split("/").at(-2)!, content: route.request().postDataJSON().contentText });
    return route.fulfill({ json: { versionAfterId: "saved-version" } });
  });
  await page.goto("/#/knowledge"); await folder(page);
  let dialog = await edit(page, "A");
  try {
    await started.promise;
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    dialog = await edit(page, "B");
    await expect(dialog.getByRole("textbox")).toHaveValue("Content B");
    await dialog.getByRole("textbox").fill("B user draft");
    const late = page.waitForResponse((response) => response.url().endsWith("/files/A/raw"));
    release.resolve(); await settle(page, await late);
    await expect(dialog.getByRole("textbox")).toHaveValue("B user draft");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(saves).toEqual([{ id: "B", content: "B user draft" }]);
  } finally { release.resolve(); }
});

test("an earlier save cannot close a newly opened edit dialog", async ({ page }) => {
  const started = deferred(), release = deferred();
  await page.route("**/k/api/files/A/edit", async (route) => {
    started.resolve(); await release.promise; await route.fulfill({ json: { versionAfterId: "saved-version" } });
  });
  await page.goto("/#/knowledge"); await folder(page);
  let dialog = await edit(page, "A");
  await expect(dialog.getByRole("textbox")).toHaveValue("Content A");
  await dialog.getByRole("textbox").fill("A changed");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await started.promise;
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    dialog = await edit(page, "B");
    await expect(dialog.getByRole("textbox")).toHaveValue("Content B");
    const late = page.waitForResponse((response) => response.url().endsWith("/files/A/edit"));
    release.resolve(); await settle(page, await late);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox")).toBeEnabled();
    await expect(dialog.getByRole("textbox")).toHaveValue("Content B");
  } finally { release.resolve(); }
});

test("reopening collaborator settings ignores the first opening's late grants", async ({ page }) => {
  const started = deferred(), release = deferred(); let reads = 0;
  await page.route("**/k/api/access**", async (route) => {
    const old = ++reads === 1;
    if (old) { started.resolve(); await release.promise; }
    await route.fulfill({ json: { access: { grants: old ? [{
      id: "old-grant", objectId: root.id, role: "collaborator", subjectType: "user", subjectId: "user-bob"
    }] : [] } } });
  });
  await page.goto("/#/knowledge"); const details = await properties(page, root.id);
  await details.getByRole("button", { name: "Set collaborators" }).click();
  const dialog = page.getByRole("dialog", { name: "Set collaborators" });
  try {
    await started.promise; await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await details.getByRole("button", { name: "Set collaborators" }).click();
    await expect(dialog.getByRole("combobox")).toBeEnabled();
    const late = page.waitForResponse((response) => new URL(response.url()).pathname === "/k/api/access");
    release.resolve(); await settle(page, await late);
    await expect(dialog.getByRole("button", { name: /Remove collaborator/ })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Save collaborators" })).toBeDisabled();
  } finally { release.resolve(); }
});

test("reopening publication settings preserves the new draft after an old response", async ({ page }) => {
  const started = deferred(), release = deferred(); let reads = 0;
  await page.route("**/k/api/knowledge-services/lifecycle-service", async (route) => {
    const old = ++reads === 1;
    if (old) { started.resolve(); await release.promise; }
    await route.fulfill({ json: { service: {
      id: "lifecycle-service", name: old ? "OUTDATED SERVICE" : "Fresh service",
      access: { company: false, departments: [], users: [] }
    } } });
  });
  await page.goto("/#/knowledge"); const details = await properties(page, root.id);
  await details.getByRole("button", { name: "Publishing settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Publishing settings" });
  try {
    await started.promise; await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await details.getByRole("button", { name: "Publishing settings" }).click();
    const name = dialog.getByRole("textbox", { name: "Service name" });
    await expect(name).toHaveValue("Fresh service"); await name.fill("User service draft");
    const late = page.waitForResponse((response) => response.url().endsWith("/knowledge-services/lifecycle-service"));
    release.resolve(); await settle(page, await late);
    await expect(name).toHaveValue("User service draft");
  } finally { release.resolve(); }
});

test("reopening a share dialog ignores an old inactive-link response", async ({ page }) => {
  const started = deferred(), release = deferred(); let reads = 0;
  await page.route("**/k/api/objects/A/public-share", async (route) => {
    const old = ++reads === 1;
    if (old) { started.resolve(); await release.promise; }
    await route.fulfill({ json: old ? { active: false } : { active: true, url: "https://example.test/fresh-link" } });
  });
  await page.goto("/#/knowledge"); await folder(page); const details = await properties(page, "A");
  await details.getByRole("button", { name: "Public share" }).click();
  const dialog = page.getByRole("dialog", { name: "Public share" });
  try {
    await started.promise; await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await details.getByRole("button", { name: "Public share" }).click();
    await expect(dialog.getByRole("textbox")).toHaveValue("https://example.test/fresh-link");
    const late = page.waitForResponse((response) => response.url().endsWith("/objects/A/public-share"));
    release.resolve(); await settle(page, await late);
    await expect(dialog.getByRole("textbox")).toHaveValue("https://example.test/fresh-link");
  } finally { release.resolve(); }
});

for (const mode of ["public", "private"] as const) {
  test(`reconciles ${mode} share state across navigation and persisted recent items`, async ({ page }) => {
    const updated = { ...files[0], shareMode: mode };
    const active = mode === "private";
    await page.route("**/k/api/tree**", (route) => route.fulfill({ json: {
      items: new URL(route.request().url()).searchParams.get("folderObjectId")
        ? [{ ...files[0], shareMode: active ? "public" : "private" }, files[1]] : [root]
    } }));
    await page.route("**/k/api/objects/A/public-share", (route) => route.fulfill({ json: route.request().method() === "GET"
      ? { active, ...(active ? { url: "https://example.test/old-link" } : {}) }
      : { active: !active, item: updated, ...(!active ? { url: "https://example.test/new-link" } : {}) }
    }));
    await page.goto("/#/knowledge"); await folder(page);
    await row(page, "A").locator(".portal-knowledge-unified-hit").click();
    await page.getByRole("dialog", { name: "A.md Viewer" }).getByRole("button", { name: "Close", exact: true }).click();
    let details = await properties(page, "A");
    await details.getByRole("button", { name: "Public share" }).click();
    const dialog = page.getByRole("dialog", { name: "Public share" });
    await dialog.getByRole("button", { name: active ? "Revoke link" : "Create public link", exact: true }).click();
    await expect(dialog.getByRole("button", { name: active ? "Create public link" : "Copy Link", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => page.evaluate((userId) => {
      const recent = JSON.parse(window.localStorage.getItem(`workspace:knowledge:recent:${userId}`) ?? "[]");
      return recent.find((item: { id: string }) => item.id === "A")?.shareMode;
    }, fallbackPortal.currentUser.id)).toBe(mode);
    await details.getByRole("button", { name: "Hide properties" }).click();
    await page.getByRole("navigation", { name: "Folder path" }).getByRole("button", { name: "Back", exact: true }).click();
    await folder(page); details = await properties(page, "A");
    const state = details.locator("dl > div").filter({ has: page.locator("dt", { hasText: /^Share$/ }) });
    await expect(state.locator("dd")).toHaveText(mode === "public" ? "Public" : "Private");
  });
}


test("an earlier ownership transfer cannot close a reopened settings window", async ({ page }) => {
  const started = deferred(), release = deferred();
  await page.route("**/k/api/objects/lifecycle-root/owner-transfer", async (route) => {
    started.resolve(); await release.promise; await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/#/knowledge"); const details = await properties(page, root.id);
  await details.getByRole("button", { name: "Transfer Owner" }).click();
  const dialog = page.getByRole("dialog", { name: "Transfer knowledge base ownership" });
  const input = dialog.getByRole("combobox", { name: "New Owner" });
  await input.fill("Ali"); await dialog.getByRole("option", { name: /Alice Wong/ }).click();
  await dialog.getByRole("button", { name: "Transfer Owner", exact: true }).click();
  try {
    await started.promise; await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await details.getByRole("button", { name: "Transfer Owner" }).click();
    await expect(input).toBeEnabled();
    const late = page.waitForResponse((response) => response.url().endsWith("/lifecycle-root/owner-transfer"));
    release.resolve(); await settle(page, await late);
    await expect(dialog).toBeVisible(); await expect(input).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "Transfer Owner", exact: true })).toBeDisabled();
  } finally { release.resolve(); }
});

for (const refreshFails of [false, true]) {
  test(`saving from the viewer refreshes content and supports a second edit${refreshFails ? " even when the list refresh fails" : ""}`, async ({ page }) => {
    let content = "# 当前架构\n\n依据：已核对代码快照。";
    let version = "version-A";
    let saves = 0;
    let viewerLoads = 0;
    await page.route("**/k/api/tree**", (route) => {
      if (refreshFails && saves) return route.fulfill({ status: 503, json: { error: "list_unavailable" } });
      return route.fulfill({ json: { items: new URL(route.request().url()).searchParams.get("folderObjectId")
        ? files.map((file) => file.id === "A" ? { ...file, currentVersionId: version } : file) : [root] } });
    });
    await page.route("**/k/api/files/A/raw", (route) => route.fulfill({ body: content, contentType: "text/plain" }));
    await page.route("**/k/view/A?embed=modal", (route) => {
      viewerLoads++;
      return route.fulfill({ body: `<html><head><meta charset="utf-8"></head><body><article>${renderMarkdown(content)}</article></body></html>`, contentType: "text/html", headers: { "Cache-Control": "private, no-store" } });
    });
    await page.route("**/k/api/files/A/edit", (route) => {
      const body = route.request().postDataJSON();
      expect(body.expectedCurrentVersionId).toBe(version);
      content = body.contentText;
      version = `saved-${++saves}`;
      return route.fulfill({ json: { objectId: "A", versionAfterId: version } });
    });
    await page.goto("/#/knowledge"); await folder(page);
    await row(page, "A").locator(".portal-knowledge-unified-hit").click();
    const viewer = page.getByRole("dialog", { name: "A.md Viewer", exact: true });
    const preview = viewer.locator("iframe").contentFrame();
    await expect(preview.getByRole("heading", { name: "当前架构" })).toBeVisible();
    await expect(preview.locator("article")).toContainText("依据：");
    for (const paragraph of ["已核对代码快照。", "已核对最新代码快照。"]) {
      const next = `# 当前架构\n\n${paragraph}`;
      await viewer.getByRole("button", { name: "More", exact: true }).click();
      await viewer.getByRole("menuitem", { name: "Edit", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Edit", exact: true });
      await expect(dialog.getByRole("textbox")).toHaveValue(content);
      await dialog.getByRole("textbox").fill(next);
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(preview.getByRole("heading", { name: "当前架构" })).toBeVisible();
      await expect(preview.locator("article p")).toHaveText(paragraph);
      await expect(preview.locator("article")).not.toContainText("依据：");
    }
    expect(saves).toBe(2);
    expect(viewerLoads).toBe(3);
    await expect(page.locator(".portal-knowledge-notice")).toContainText("File content saved as a new version.");
  });
}

test("a rejected save keeps the draft and shows the error inside the editor", async ({ page }) => {
  await page.route("**/k/api/files/A/edit", (route) => route.fulfill({ status: 409, json: { error: "knowledge_version_conflict" } }));
  await page.goto("/#/knowledge"); await folder(page);
  const dialog = await edit(page, "A");
  await expect(dialog.getByRole("textbox")).toHaveValue("Content A");
  await dialog.getByRole("textbox").fill("Unsaved bank update");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("knowledge_version_conflict");
  await expect(dialog.getByRole("textbox")).toHaveValue("Unsaved bank update");
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});
