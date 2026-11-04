import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mockPortalApis } from "./fixtures/portalApi";

function folder(id: string) {
  return {
    access: "owner", id, kind: "folder", name: `Folder ${id}`, ownerUserId: "user-owner",
    parentPath: "", path: id, sizeBytes: 0, modifiedAt: "2026-10-01T00:00:00Z"
  };
}

function file(parent: string, name = `${parent}.md`) {
  return {
    access: "owner", id: `${parent}-${name}`, kind: "markdown", name, ownerUserId: "user-owner",
    parentPath: parent, path: `${parent}/${name}`, sizeBytes: 20, modifiedAt: "2026-10-01T00:00:00Z"
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
  await mockPortalApis(page);
  await page.route("**/k/api/shared-with-me**", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/k/api/knowledge-services**", (route) => route.fulfill({ json: { services: [] } }));
}

async function openFolder(page: Page, id: string) {
  await page.locator(`[data-knowledge-item-id="${id}"] .portal-knowledge-unified-hit`).click();
  await expect(page.getByRole("navigation", { name: "Folder path" }).getByRole("button", { name: `Folder ${id}`, exact: true })).toBeVisible();
}

async function openRoot(page: Page) {
  await page.getByRole("navigation", { name: "Folder path" }).getByRole("button").first().click();
  await expect(page.locator('[data-knowledge-item-id="B"]')).toBeVisible();
}

test("upload completion refreshes its folder without replacing a folder opened meanwhile", async ({ page }) => {
  await setup(page);
  const uploaded = file("A", "uploaded.md");
  const uploadStarted = deferred();
  const finishUpload = deferred();
  let uploadComplete = false;
  await page.route("**/k/api/tree**", (route) => {
    const id = new URL(route.request().url()).searchParams.get("folderObjectId");
    return route.fulfill({ json: { items: id ? [file(id), ...(id === "A" && uploadComplete ? [uploaded] : [])] : [folder("A"), folder("B")] } });
  });
  await page.route("**/k/api/files/upload", async (route) => {
    expect(route.request().postData()).toContain('name="parentObjectId"\r\n\r\nA');
    uploadStarted.resolve();
    await finishUpload.promise;
    uploadComplete = true;
    await route.fulfill({ json: { item: uploaded } });
  });

  await page.goto("/knowledge");
  await openFolder(page, "A");
  await expect(page.locator('[data-knowledge-item-id="A-A.md"]')).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles({ name: "uploaded.md", mimeType: "text/markdown", buffer: Buffer.from("# Uploaded") });
  await uploadStarted.promise;
  await openRoot(page);
  await openFolder(page, "B");
  await expect(page.locator('[data-knowledge-item-id="B-B.md"]')).toBeVisible();
  finishUpload.resolve();
  await expect(page.getByRole("status")).toContainText("files uploaded");
  await expect(page.locator('[data-knowledge-item-id="B-B.md"]')).toBeVisible();
  await expect(page.locator('[data-knowledge-item-id="A-uploaded.md"]')).toHaveCount(0);
  await openRoot(page);
  await openFolder(page, "A");
  await expect(page.locator('[data-knowledge-item-id="A-uploaded.md"]')).toBeVisible();
});

test("a directory refresh that completes after navigation keeps the new directory visible", async ({ page }) => {
  await setup(page);
  const refreshStarted = deferred();
  const finishRefresh = deferred();
  let uploadComplete = false;
  const uploaded = file("A", "uploaded.md");
  await page.route("**/k/api/tree**", async (route) => {
    const id = new URL(route.request().url()).searchParams.get("folderObjectId");
    if (id === "A" && uploadComplete) {
      refreshStarted.resolve();
      await finishRefresh.promise;
    }
    await route.fulfill({ json: { items: id ? [file(id), ...(id === "A" && uploadComplete ? [uploaded] : [])] : [folder("A"), folder("B")] } });
  });
  await page.route("**/k/api/files/upload", async (route) => {
    uploadComplete = true;
    await route.fulfill({ json: { item: uploaded } });
  });
  await page.goto("/knowledge");
  await openFolder(page, "A");
  await expect(page.locator('[data-knowledge-item-id="A-A.md"]')).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles({ name: "uploaded.md", mimeType: "text/markdown", buffer: Buffer.from("# Uploaded") });
  await refreshStarted.promise;
  await openRoot(page);
  await openFolder(page, "B");
  await expect(page.locator('[data-knowledge-item-id="B-B.md"]')).toBeVisible();
  finishRefresh.resolve();
  await expect(page.getByRole("status")).toContainText("files uploaded");
  await expect(page.locator('[data-knowledge-item-id="B-B.md"]')).toBeVisible();
  await expect(page.locator('[data-knowledge-item-id="A-uploaded.md"]')).toHaveCount(0);
});

async function setupTreeHarness(page: Page) {
  const bundle = await build({
    entryPoints: ["tests/e2e/fixtures/knowledgeTreeHarness.tsx"], bundle: true, write: false,
    format: "esm", platform: "browser", jsx: "automatic", logLevel: "silent",
    define: { "import.meta.env.VITE_KNOWLEDGE_WORKER_URL": '"/k"' }
  });
  await page.route("**/__knowledge-tree", (route) => route.fulfill({
    contentType: "text/html", body: '<div id="root"></div><script type="module" src="/__knowledge-tree.js"></script>'
  }));
  await page.route("**/__knowledge-tree.js", (route) => route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0].text }));
  await page.route("**/k/api/shared-with-me**", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/k/api/knowledge-services**", (route) => route.fulfill({ json: { services: [] } }));
}

test("a newer refresh wins when two reads of the same directory complete out of order", async ({ page }) => {
  await setupTreeHarness(page);
  const firstStarted = deferred();
  const finishFirst = deferred();
  let readCount = 0;
  await page.route("**/k/api/tree**", async (route) => {
    if (++readCount === 1) {
      firstStarted.resolve();
      await finishFirst.promise;
      await route.fulfill({ json: { items: [folder("old")] } });
    } else {
      await route.fulfill({ json: { items: [folder("new")] } });
    }
  });
  await page.goto("/__knowledge-tree");
  await firstStarted.promise;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByTestId("items")).toHaveText("new");
  const oldResponse = page.waitForResponse(async (response) => response.url().includes("/k/api/tree") && (await response.json()).items?.[0]?.id === "old");
  finishFirst.resolve();
  await oldResponse;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.getByTestId("items")).toHaveText("new");
});

test("changing user isolates pending reads, directory caches and recently opened files", async ({ page }) => {
  await setupTreeHarness(page);
  await page.addInitScript(() => {
    for (const id of ["first", "second"]) {
      localStorage.setItem(`workspace:knowledge:recent:${id}`, JSON.stringify([{ id: `${id}-recent`, name: `${id}.md`, kind: "markdown" }]));
    }
  });
  const refreshStarted = deferred();
  const finishRefresh = deferred();
  let readCount = 0;
  await page.route("**/k/api/tree**", async (route) => {
    const read = ++readCount;
    if (read === 2) {
      refreshStarted.resolve();
      await finishRefresh.promise;
    }
    await route.fulfill({ json: { items: [folder(read === 1 ? "first" : read === 2 ? "first-stale" : "second")] } });
  });
  await page.goto("/__knowledge-tree");
  await expect(page.getByTestId("items")).toHaveText("first");
  await expect(page.getByTestId("recent")).toHaveText("first-recent");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await refreshStarted.promise;
  await page.getByRole("button", { name: "Switch user" }).click();
  await expect(page.getByTestId("items")).toHaveText("second");
  await expect(page.getByTestId("recent")).toHaveText("second-recent");
  finishRefresh.resolve();
  await expect(page.getByTestId("message")).toHaveText("refreshed");
  await expect(page.getByTestId("items")).toHaveText("second");
  await page.getByRole("button", { name: "Switch user" }).click();
  await expect(page.getByTestId("items")).toHaveText("first");
  await expect(page.getByTestId("recent")).toHaveText("first-recent");
});
