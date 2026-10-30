import { expect, test } from "@playwright/test";
import { collectRuntimeErrors, mockPortalApis } from "./fixtures/portalApi";

test("creates the default Mate from a character and nickname, preserving its identity after reload", async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1440 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
  const runtimeErrors = collectRuntimeErrors(page);
  await mockPortalApis(page);
  let created = false;
  let creationCount = 0;
  const mate = {
    id: "daniel-bot", activeReleaseId: "daniel-bot-r1", isDefault: true,
    displayName: "Daniel Bot", ownerUserId: "local-dev-admin", status: "published",
    visibility: "private", workEmail: "local.admin@example.invalid"
  };
  await page.route("**/api/apps/mates/default", async route => {
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON();
      expect(Object.keys(input).sort()).toEqual(["avatarUrl", "displayName"]);
      expect(input.displayName).toBe("Daniel Bot");
      expect(input.avatarUrl).toMatch(/^https:\/\//);
      created = true;
      creationCount++;
    }
    await route.fulfill({ json: { mate: created ? mate : null } });
  });
  await page.route("**/api/mate-runtime/live-sessions", route => route.fulfill({ json: { session: {
    accessToken: "synthetic-live-token", conversationId: "draft-default-mate", conversationState: "draft",
    expiresAt: "2099-01-01T00:00:00Z", mode: "live", principalKey: "synthetic-default-owner",
    release: { id: "daniel-bot-r1" }, runtimeOrigin: "https://runtime.default.test", mate,
    surface: { kind: "conversation", channels: ["sdk"], entries: [{channel: "sdk", kind: "conversation"}] }
  } } }));
  await page.route("https://runtime.default.test/**", route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith("/runtime") ? { capabilities: {
      models: {defaultModel: "cf-openai-gpt-6-luna", allowed: [{id: "cf-openai-gpt-6-luna", name: "GPT-6 Luna"}]},
      knowledge: [], appMcp: [], tools: []
    } } : { conversations: [], approvals: [], reminders: [], tasks: [] } });
  });
  await page.goto("/#/mate");
  await page.getByRole("group", {name: "Choose a Mate character"}).getByRole("button").first().click();
  await page.getByRole("button", {name: "Next", exact: true}).click();
  const dialog = page.getByRole("dialog", {name: "Start your Mate"});
  await dialog.getByLabel("Name", {exact: true}).fill("Daniel Bot");
  await expect(dialog.locator('input[type="email"]')).toHaveCount(0);
  await dialog.getByRole("button", {name: "Start", exact: true}).click();
  const success = page.getByRole("dialog", {name: "Mate created"});
  await expect(success.getByRole("heading", {name: "Daniel Bot is ready"})).toBeVisible();
  await expect(success.getByText("local.admin@example.invalid", {exact: true})).toBeVisible();
  await expect(success.getByText("Capabilities included", {exact: true})).toBeVisible();
  await expect(success.getByText("Public web search and web reading", {exact: true})).toBeVisible();
  await success.getByRole("button", {name: "Start using Mate"}).click();
  await expect(page.getByRole("heading", {name: "What would you like to discuss with Daniel Bot?", exact: true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", {name: "What would you like to discuss with Daniel Bot?", exact: true})).toBeVisible();
  expect(creationCount).toBe(1);
  expect(runtimeErrors).toEqual([]);
});
