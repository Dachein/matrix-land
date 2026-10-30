import { expect, test, type Page } from "@playwright/test";
import { mockPortalApis } from "./fixtures/portalApi";
import { build } from "esbuild";

const departments = [
  { id: "org", name: "Company" },
  { id: "group", name: "Group", parentId: "org" },
  { id: "am", name: "Account Manager", parentId: "group" },
  { id: "empty", name: "Empty team", parentId: "group" }
];
async function setup(page: Page, unavailable = false) {
  await page.addInitScript(() => localStorage.setItem("workspace-ai:locale", "en"));
  await mockPortalApis(page);
  await page.route("**/api/users/departments", route => route.fulfill({ status: unavailable ? 503 : 200, json: { departments } }));
  await page.route("**/api/users/directory**", route => route.fulfill({ json: { users: [{
    id: "ada", email: "ada@example.test", name: "Ada", department: "Account Manager",
    departmentId: "am", departmentPath: ["org", "group", "am"]
  }] } }));
}

for (const entityType of ["app", "skill"]) {
  for (const unavailable of [false, true]) {
    test(`${entityType} settings ${unavailable ? "blocks partial directories" : "saves the leaf ID and retains empty departments"}`, async ({ page }) => {
      await setup(page, unavailable);
      const bundle = await build({ entryPoints: ["tests/e2e/fixtures/accessScopeHarness.tsx"], bundle: true, write: false,
        format: "esm", platform: "browser", jsx: "automatic", logLevel: "silent" });
      await page.route("**/__access-scope?**", route => route.fulfill({ contentType: "text/html",
        body: '<div id="root"></div><script type="module" src="/__access-scope.js"></script>' }));
      await page.route("**/__access-scope.js", route => route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0].text }));
      await page.goto(`/__access-scope?type=${entityType}`);
      await page.getByRole("radio", { name: /Targeted|Specific members/ }).click();
      const save = page.getByRole("button", { name: "Save settings", exact: true });
      if (unavailable) {
        await expect(page.getByText("Organization directory unavailable", { exact: true })).toBeVisible();
        await expect(save).toBeDisabled();
        await expect(page.getByTestId("saved")).toBeEmpty();
      } else {
        const search = page.getByPlaceholder("Search departments, names, or emails");
        await search.fill("Empty team");
        await expect(page.getByRole("checkbox", { name: /^Empty team\s*Department$/, exact: true })).toBeVisible();
        await search.fill("Account Manager");
        await page.getByRole("checkbox", { name: /^Account Manager\s*Department$/, exact: true }).check();
        await save.click();
        await expect(page.getByTestId("saved")).toContainText('"accessTargets":["department:am"]');
      }
    });
  }
}
async function appPicker(page: Page) {
  await page.goto("/#/apps");
  await page.getByRole("button", { name: "NEW APPS", exact: true }).click();
  await page.getByRole("menuitem", { name: /^App / }).click();
  const dialog = page.getByRole("dialog", { name: "Create APPS app" });
  await dialog.getByRole("button", { name: "Page visibility", exact: true }).click();
  await page.getByRole("option", { name: /Targeted|Specific members/ }).click();
  return dialog;
}
async function knowledgePicker(page: Page) {
  await page.goto("/#/knowledge/my");
  const row = page.locator("[data-knowledge-item-id]").filter({ hasText: "Client Onboarding Kit" });
  await row.locator(".portal-knowledge-more").click();
  await page.getByRole("menuitem", { name: /^(More|Knowledge base settings)$/ }).click();
  await page.getByRole("complementary", { name: "File details" }).getByRole("button", { name: "Publish as Knowledge Base" }).click();
  const dialog = page.getByRole("dialog", { name: "Publish as Knowledge Base" });
  await dialog.getByRole("radio", { name: /Specific members/ }).check();
  return dialog;
}

for (const [flow, open, saveLabel] of [
  ["App creation", appPicker, "Create and provision resources"],
  ["Knowledge publishing", knowledgePicker, "Publish as Knowledge Base"]
] as const) {
  test(`${flow} includes empty departments and keeps leaf selections distinct from the company`, async ({ page }) => {
    await setup(page);
    const dialog = await open(page);
    const search = dialog.getByPlaceholder("Search departments, names, or emails");
    await search.fill("Empty team");
    await expect(dialog.getByRole("checkbox", { name: /^Empty team\s*Department$/, exact: true })).toBeVisible();
    await search.fill("Ada");
    await expect(dialog.getByRole("checkbox", { name: "Ada ada@example.test", exact: true })).toBeVisible();
    await search.fill("Account Manager");
    await dialog.getByRole("checkbox", { name: /^Account Manager\s*Department$/, exact: true }).check();
    await expect(dialog.locator(".accessTargetSelectedTag.department")).toContainText("Company / Group / Account Manager");
    await expect(dialog.getByRole("checkbox", { name: "Company Department", exact: true })).not.toBeChecked();
    await page.screenshot({ path: `output/knowledge-directory-audit-2026-10-13/fixed-${flow.startsWith("App") ? "app" : "knowledge"}.png` });
  });
  test(`${flow} blocks targeted submission when the department directory fails`, async ({ page }) => {
    await setup(page, true);
    const dialog = await open(page);
    await expect(dialog.getByRole("alert")).toContainText("organization directory is unavailable");
    await expect(dialog.getByRole("button", { name: saveLabel, exact: true })).toBeDisabled();
    await expect(dialog.locator(".accessTargetPickerTree").getByRole("checkbox")).toHaveCount(0);
  });
}
