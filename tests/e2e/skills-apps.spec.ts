import { expect, test } from "@playwright/test";
import { fallbackPortal } from "../../src/shared/fallbackPortal";
import { mockPortalApis } from "./fixtures/portalApi";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
  await mockPortalApis(page);
  await page.goto("/#/skills-apps");
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "Skills & Apps" })).toBeVisible();
});

test("defaults to Cards and keeps the create-and-share card first", async ({ page }) => {
  const cardsButton = page.getByRole("button", { exact: true, name: "Cards" });
  const grid = page.locator(".portal-market-grid");
  const createCard = page.getByRole("button", { name: "Create and Share Your App or Skills" });

  await expect(cardsButton).toHaveAttribute("aria-pressed", "true");
  await expect(grid).toBeVisible();
  await expect(grid.locator(":scope > *").first()).toHaveClass(/portal-market-create-card/);
  await expect(createCard).toBeVisible();
  await expect(page.locator(".portal-market-ledger")).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search Skills and Apps" }).fill("no matching object");
  await expect(page.getByText("0 results", { exact: true })).toBeVisible();
  await expect(grid.locator(":scope > *").first()).toHaveClass(/portal-market-create-card/);
  await expect(createCard).toBeVisible();

  await createCard.click();

  await expect(page).toHaveURL(/#\/apps$/);
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "APPS" })).toBeVisible();
});

test("shows only the title panel until a market card is hovered or focused", async ({ page }) => {
  const cardAction = page.getByRole("button", { exact: true, name: "Open Skill: Contract Risk Review" });
  const card = cardAction.locator("xpath=..");
  const mark = card.locator(".portal-market-mark.card");
  const details = card.locator(".portal-market-card-details");
  const footer = card.locator(".portal-market-card-footer");

  await expect(mark).toHaveCSS("position", "absolute");
  const [cardHeight, markHeight] = await Promise.all([
    card.evaluate((element) => element.getBoundingClientRect().height),
    mark.evaluate((element) => element.getBoundingClientRect().height)
  ]);
  expect(markHeight).toBe(cardHeight - 2);
  await expect(card.locator(".portal-market-card-panel")).toHaveCSS("background-color", "rgba(255, 255, 255, 0.84)");
  await expect(details).toHaveCSS("max-height", "0px");
  await expect(details).toHaveCSS("opacity", "0");
  await expect(footer).toHaveCSS("max-height", "0px");

  await card.hover();
  await expect(details).toHaveCSS("max-height", "220px");
  await expect(details).toHaveCSS("opacity", "1");
  await expect(footer).toHaveCSS("max-height", "48px");

  await page.mouse.move(0, 0);
  await cardAction.focus();
  await expect(details).toHaveCSS("max-height", "220px");
  await expect(footer).toHaveCSS("max-height", "48px");
});

test("shows type filters without counts and lists every category with availability", async ({ page }) => {
  await expect(page.getByRole("button", { exact: true, name: "All" })).toBeVisible();
  await expect(page.getByRole("button", { exact: true, name: "App" })).toBeVisible();
  await expect(page.getByRole("button", { exact: true, name: "Skill" })).toBeVisible();

  await page.getByRole("button", { name: "Capability category" }).click();

  const categoryOptions = page.getByRole("option");
  await expect(categoryOptions).toHaveCount(8);
  await expect(page.getByRole("option", { exact: true, name: "All categories 2" })).toBeEnabled();
  await expect(page.getByRole("option", { exact: true, name: "Coding 0" })).toBeDisabled();
  await expect(page.getByRole("option", { exact: true, name: "Design 0" })).toBeDisabled();
  await expect(page.getByRole("option", { exact: true, name: "Media 0" })).toBeDisabled();
  await expect(page.getByRole("option", { exact: true, name: "Workflow 1" })).toBeEnabled();
  await expect(page.getByRole("option", { exact: true, name: "Office 1" })).toBeEnabled();

  await page.getByRole("button", { name: "Capability category" }).click();
  await page.getByRole("button", { exact: true, name: "App" }).click();
  await page.getByRole("button", { name: "Capability category" }).click();

  await expect(page.getByRole("option", { exact: true, name: "All categories 1" })).toBeEnabled();
  await expect(page.getByRole("option", { exact: true, name: "Coding 0" })).toBeDisabled();
  await expect(page.getByRole("option", { exact: true, name: "Workflow 1" })).toBeEnabled();
  await expect(page.getByRole("option", { exact: true, name: "Office 0" })).toBeDisabled();
});

test("switches to List and shows the existing ledger", async ({ page }) => {
  const listButton = page.getByRole("button", { exact: true, name: "List" });

  await listButton.click();

  await expect(listButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".portal-market-grid")).toHaveCount(0);
  await expect(page.locator(".portal-market-ledger")).toBeVisible();
  await expect(page.getByRole("button", { exact: true, name: "Open Skill: Contract Risk Review" })).toBeVisible();
});

test("opens a capability detail from a card", async ({ page }) => {
  await page.getByRole("button", { exact: true, name: "Open Skill: Contract Risk Review" }).click();

  await expect(page).toHaveURL(/#\/skills\/skill-contract-review$/);
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "Contract Risk Review" })).toBeVisible();
});

test("merges every product author without role labels", async ({ page }) => {
  const baseAppListing = fallbackPortal.hubListings.find((listing) => listing.type === "app");
  if (!baseAppListing) throw new Error("missing App listing fixture");

  await mockPortalApis(page, {
    hubListings: [{
      ...baseAppListing,
      config: {
        builderSnapshot: {
          appsVerified: {
            app: {
              appCode: "pb-supply-chain-agent",
              productionUrl: "https://pb-supply-chain.example.invalid",
              type: "web"
            }
          }
        }
      },
      id: "listing-app-pb-supply-chain",
      name: "PB Supply Chain Agent",
      ownerAliasName: "Legacy Listing Alias",
      ownerProfiles: [{
        avatarUrl: "",
        department: "Owner Department Must Stay Hidden",
        email: "shi@example.test",
        id: "owner-shi",
        name: "Shi Hongbin"
      }, {
        avatarUrl: "",
        department: "Collaborator Department Must Stay Hidden",
        email: "fiona@example.test",
        id: "collaborator-fiona",
        name: "Fiona Ashley Teo"
      }],
      tags: ["apps", "app", "workflow"],
      targetId: "app-pb-supply-chain"
    }]
  });
  await page.reload();

  const cardAction = page.getByRole("button", { exact: true, name: "Open App: PB Supply Chain Agent" });
  const card = cardAction.locator("xpath=..");
  const cardAuthors = card.locator(".portal-market-card-owner .publication-authors");
  await expect(cardAuthors).toContainText("Legacy Listing Alias");
  await expect(cardAuthors.locator(".publication-author-profile")).toHaveCount(2);
  await expect(cardAuthors.locator(".publication-author-name")).toHaveCount(0);
  await expect(cardAuthors.locator('[aria-label="Shi Hongbin"]')).toHaveCount(1);
  await expect(cardAuthors.locator('[aria-label="Fiona Ashley Teo"]')).toHaveCount(1);

  await page.getByRole("button", { exact: true, name: "List" }).click();
  const row = page.getByRole("button", { exact: true, name: "Open App: PB Supply Chain Agent" }).locator("xpath=..");
  const rowAuthors = row.locator(".portal-market-row-owner .publication-authors");
  await expect(rowAuthors).toContainText("Legacy Listing Alias");
  await expect(rowAuthors.locator(".publication-author-profile")).toHaveCount(2);
  await expect(rowAuthors.locator(".publication-author-name")).toHaveCount(0);

  await page.goto("/#/apps/app-pb-supply-chain");

  await expect(page.getByRole("button", { exact: true, name: "Visit App" })).toBeVisible();

  const byline = page.locator(".portal-object-byline");
  const contributors = byline.locator(".publication-author-profile");
  await expect(contributors).toHaveCount(2);
  await expect(contributors.nth(0).locator(".personAvatar")).toBeVisible();
  await expect(contributors.nth(1).locator(".personAvatar")).toBeVisible();
  await expect(byline.locator(".publication-author-alias")).toHaveText("Legacy Listing Alias");
  await expect(byline.locator(".publication-author-name")).toHaveCount(0);
  await expect(contributors.nth(0)).toHaveAttribute("title", "Shi Hongbin");
  await expect(contributors.nth(1)).toHaveAttribute("title", "Fiona Ashley Teo");
  await expect(byline).not.toContainText("Department Must Stay Hidden");
  await expect(page.locator(".portal-object-metadata dt", { hasText: "Authors" })).toBeVisible();
  const metadataAuthors = page.locator(".portal-object-metadata dt", { hasText: "Authors" })
    .locator("xpath=following-sibling::dd[1]")
    .locator(".publication-authors");
  await expect(metadataAuthors).toContainText("Legacy Listing Alias");
  await expect(metadataAuthors.locator(".publication-author-profile")).toHaveCount(2);
  await expect(metadataAuthors.locator(".publication-author-name")).toHaveCount(0);
});

test("shows Owner and Collaborator hover cards and opens their user profiles from cards, lists, and details", async ({ page }) => {
  const baseListing = fallbackPortal.hubListings.find((listing) => listing.type === "skill");
  if (!baseListing) throw new Error("missing Skill listing fixture");

  const owner = {
    avatarUrl: "",
    department: "Product & Technology",
    email: "ivy@example.test",
    id: "owner-ivy-profile",
    jobTitle: "Product Lead",
    name: "Ivy Lin",
    team: "AI Platform"
  };
  const collaborator = {
    avatarUrl: "",
    department: "Investment Solutions",
    email: "ada@example.test",
    id: "collaborator-ada-profile",
    jobTitle: "Portfolio Specialist",
    name: "Ada Zhang",
    team: "Advisory"
  };
  const listing = {
    ...baseListing,
    id: "listing-profile-interactions",
    name: "Profile Interaction Skill",
    ownerAliasName: "",
    ownerProfiles: [owner, collaborator],
    targetId: "skill-profile-interactions"
  };

  await mockPortalApis(page, { hubListings: [listing] });
  await page.route("**/api/users/*/profile", async (route) => {
    const user = route.request().url().includes(owner.id) ? owner : collaborator;
    await route.fulfill({
      contentType: "application/json",
      json: {
        user: {
          ...user,
          bio: user.id === owner.id ? "Owns the product direction." : "Builds the advisory workflow.",
          role: "member"
        }
      }
    });
  });
  await page.reload();

  const cardAction = page.getByRole("button", { exact: true, name: "Open Skill: Profile Interaction Skill" });
  const card = cardAction.locator("xpath=..");
  await card.hover();
  const cardOwner = card.locator('.publication-author-profile[aria-label="Ivy Lin"]');
  await cardOwner.hover();
  await expect(page.getByRole("tooltip")).toContainText("Ivy Lin");
  await expect(page.getByRole("tooltip")).toContainText("Owner");
  await expect(page.getByRole("tooltip")).toContainText("Product & Technology / AI Platform");

  await cardOwner.click();
  await expect(page).toHaveURL(/#\/skills-apps$/);
  await expect(page.getByRole("dialog", { name: "Ivy Lin profile" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Ivy Lin profile" })).toContainText("Owns the product direction.");
  await page.getByRole("dialog", { name: "Ivy Lin profile" }).getByRole("button", { name: "Close profile" }).click();

  await page.getByRole("button", { exact: true, name: "List" }).click();
  const row = page.getByRole("button", { exact: true, name: "Open Skill: Profile Interaction Skill" }).locator("xpath=..");
  const rowCollaborator = row.locator('.publication-author-profile[aria-label="Ada Zhang"]');
  await rowCollaborator.hover();
  await expect(page.getByRole("tooltip")).toContainText("Collaborator");
  await expect(page.getByRole("tooltip")).toContainText("Investment Solutions / Advisory");
  await rowCollaborator.click();
  await expect(page).toHaveURL(/#\/skills-apps$/);
  await expect(page.getByRole("dialog", { name: "Ada Zhang profile" })).toBeVisible();
  await page.getByRole("dialog", { name: "Ada Zhang profile" }).getByRole("button", { name: "Close profile" }).click();

  await page.goto("/#/skills/skill-profile-interactions");
  const detailOwner = page.locator('.portal-object-byline .publication-author-profile[aria-label="Ivy Lin"]');
  await detailOwner.hover();
  await expect(page.getByRole("tooltip")).toContainText("Owner");
  await detailOwner.click();
  await expect(page).toHaveURL(/#\/skills\/skill-profile-interactions$/);
  await expect(page.getByRole("dialog", { name: "Ivy Lin profile" })).toBeVisible();
});

test("labels merged listing profiles as authors in the review queue and detail", async ({ page }) => {
  const baseListing = fallbackPortal.publicationListings.find((listing) => listing.type === "app");
  if (!baseListing) throw new Error("missing App listing fixture");

  const sharedListing = {
    ...baseListing,
    ownerAliasName: "Legacy Listing Alias",
    ownerProfiles: [{
      email: "ivy@example.test",
      id: "owner-ivy",
      name: "Ivy Lin"
    }, {
      email: "ada@example.test",
      id: "collaborator-ada",
      name: "Ada Zhang"
    }]
  };

  await mockPortalApis(page, { publicationListings: [sharedListing] });
  await page.reload();
  await page.goto("/#/admin/hub-review");

  const table = page.locator(".portal-hub-review-table");
  await expect(table.getByRole("columnheader", { name: "Authors" })).toBeVisible();
  const row = table.locator("tbody tr", { hasText: sharedListing.name });
  const queueAuthors = row.locator(".publication-authors");
  await expect(queueAuthors).toContainText("Legacy Listing Alias");
  await expect(queueAuthors.locator(".publication-author-profile")).toHaveCount(2);
  await expect(queueAuthors.locator(".publication-author-name")).toHaveCount(0);
  await expect(queueAuthors.locator('[aria-label="Ivy Lin"]')).toHaveCount(1);
  await expect(queueAuthors.locator('[aria-label="Ada Zhang"]')).toHaveCount(1);

  await row.getByRole("button", { name: "Details / actions" }).click();
  const dialog = page.getByRole("dialog", { name: `${sharedListing.name} review detail` });
  const dialogAuthors = dialog.locator("dt", { hasText: "Authors" })
    .locator("xpath=following-sibling::dd[1]")
    .locator(".publication-authors");
  await expect(dialogAuthors).toContainText("Legacy Listing Alias");
  await expect(dialogAuthors.locator(".publication-author-profile")).toHaveCount(2);
  await expect(dialogAuthors.locator(".publication-author-name")).toHaveCount(0);
  await expect(dialog.getByLabel("Owner alias name (optional)")).toHaveValue("Legacy Listing Alias");
  await expect(dialog).not.toContainText("App Owner");
  await expect(dialog).not.toContainText("Collaborator");
  await expect(dialog).not.toContainText("Submitted by (audit)");
});

test("enlarges the product cover only while the desktop Right Rail is hidden", async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1600 });
  await page.goto("/#/apps/app-growth-lab");

  const cover = page.locator(".portal-object-identity > .portal-market-mark.large");
  await expect.poll(async () => Math.round((await cover.boundingBox())?.width ?? 0)).toBe(68);

  await page.getByRole("button", { name: "Collapse Live" }).click();
  await expect.poll(async () => Math.round((await cover.boundingBox())?.width ?? 0)).toBe(200);

  const [coverBox, titleBox, bylineBox] = await Promise.all([
    cover.boundingBox(),
    page.locator(".portal-object-title-block").boundingBox(),
    page.locator(".portal-object-byline").boundingBox()
  ]);
  expect(coverBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(bylineBox).not.toBeNull();
  expect(titleBox!.x).toBeGreaterThanOrEqual(coverBox!.x + coverBox!.width);
  expect(bylineBox!.y).toBeGreaterThanOrEqual(coverBox!.y + coverBox!.height);

  await page.getByRole("button", { name: "Open Live" }).click();
  await expect.poll(async () => Math.round((await cover.boundingBox())?.width ?? 0)).toBe(68);
});
