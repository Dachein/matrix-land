import { expect, test } from "@playwright/test";
import { mockPortalApis } from "./fixtures/portalApi";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
  await mockPortalApis(page);
});

test("shows a random anonymous persona card and refreshes without a dropdown", async ({ page }) => {
  await page.setViewportSize({ height: 1080, width: 1720 });
  await page.goto("/#/home");
  await page.getByRole("button", { name: "New post" }).first().click();

  const composer = page.getByRole("dialog", { name: "New Topic" });
  const anonymousToggle = composer.getByRole("checkbox", { name: "Publish anonymously" });
  await anonymousToggle.check();
  await expect(anonymousToggle).toBeChecked();

  const picker = composer.locator(".forumAnonymousPersonaPicker");
  const personaName = picker.locator(".forumAnonymousPersonaLabel span");
  await expect(picker).toBeVisible();
  await expect(picker).toHaveCSS("border-top-width", "0px");
  await expect(picker).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(composer.getByRole("listbox")).toHaveCount(0);
  const refreshButton = composer.getByRole("button", { name: "Try another anonymous character" });
  await expect(refreshButton).toBeVisible();
  await expect(refreshButton).toContainText("Try another");

  const firstPersona = await personaName.innerText();
  await refreshButton.click();
  await expect(personaName).not.toHaveText(firstPersona);
});
