import { expect, test } from "@playwright/test";
import { fallbackPortal } from "../../src/shared/fallbackPortal";
import type { Discussion, PortalCatalog } from "../../src/shared/types";
import { collectRuntimeErrors, mockPortalApis } from "./fixtures/portalApi";

const PROFILE_USER_ID = "user-profile-visual";
const PROFILE_AVATAR = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900" viewBox="0 0 1400 900">
    <rect width="1400" height="900" fill="#f0bd2e"/>
    <circle cx="700" cy="390" r="250" fill="#24211d"/>
  </svg>
`)}`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
});

test("uses one contained profile card across posts, participants, feed, and Live, then opens the enriched profile", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  const catalog = structuredClone(fallbackPortal) as PortalCatalog;
  const profileDiscussion: Discussion = {
    ...catalog.discussions[0],
    id: "profile-card-post",
    authorId: PROFILE_USER_ID,
    author: "Ivy Lin",
    authorEmail: "ivy.lin@example.test",
    authorAvatarUrl: PROFILE_AVATAR,
    bio: "Builds practical people experiences with the AI Adoption team.",
    department: "People & Culture",
    team: "AI Adoption",
    journeyLevelKey: "master",
    title: "A profile card interaction contract",
    createdAt: "2026-07-15T02:00:00.000Z",
    lastActive: "2026-07-15T02:00:00.000Z",
    replies: 1,
    replyPosts: [{
      id: "profile-card-reply",
      authorId: catalog.currentUser.id,
      author: catalog.currentUser.name,
      authorEmail: catalog.currentUser.email,
      authorAvatarUrl: catalog.currentUser.avatarUrl,
      body: "Looks good.",
      createdAt: "2026-07-15T03:00:00.000Z",
      department: catalog.currentUser.department,
      team: catalog.currentUser.team,
      journeyLevelKey: catalog.journey.level.key
    }]
  };
  catalog.discussions = [profileDiscussion, ...catalog.discussions.slice(1)];
  catalog.activityEvents = [];

  await mockPortalApis(page, { catalog: { json: catalog } });
  await page.route(/\/api\/forum\/topics(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    json: {
      discussions: catalog.discussions.filter((discussion) => !discussion.pinned),
      pinnedDiscussions: catalog.discussions.filter((discussion) => discussion.pinned)
    }
  }));
  await page.route("**/api/forum/topics/profile-card-post", (route) => route.fulfill({
    contentType: "application/json",
    json: { discussion: profileDiscussion }
  }));
  await page.route("**/api/users/batch**", async (route) => {
    const ids = new URL(route.request().url()).searchParams.get("ids")?.split(",") ?? [];
    await route.fulfill({
      contentType: "application/json",
      json: {
        users: ids.flatMap((id) => id === PROFILE_USER_ID ? [profilePayload()] : id === catalog.currentUser.id ? [{
          ...catalog.currentUser,
          journeyLevelKey: catalog.journey.level.key
        }] : [])
      }
    });
  });
  await page.route(`**/api/users/${PROFILE_USER_ID}/profile`, (route) => route.fulfill({
    contentType: "application/json",
    json: { user: profilePayload() }
  }));

  await page.goto("/#/posts/profile-card-post");

  const authorAvatar = page.locator(".portal-post-author .profileInlineAvatar");
  await authorAvatar.hover();
  const hoverCard = page.getByRole("tooltip");
  await expect(hoverCard).toBeVisible();
  await expect(hoverCard).toContainText("Ivy Lin");
  await expect(hoverCard).toContainText("Level 5 · Master");
  await expect(hoverCard).toContainText("People & Culture");
  await expect(hoverCard).toContainText("AI Adoption");
  await expect(hoverCard).toContainText("Builds practical people experiences");
  await expect(hoverCard).toContainText("ivy.lin@example.test");
  await expect(hoverCard.locator(".profileHoverDepartment strong")).toHaveText("People & Culture");

  const cardBox = await hoverCard.boundingBox();
  const cardAvatarBox = await hoverCard.locator(".profileHoverAvatar").boundingBox();
  const cardImageBox = await hoverCard.locator(".profileHoverAvatar img").boundingBox();
  expect(cardBox?.width).toBeLessThanOrEqual(305);
  expect(cardAvatarBox?.width).toBeCloseTo(56, 0);
  expect(cardAvatarBox?.height).toBeCloseTo(56, 0);
  expect(cardImageBox?.width).toBeGreaterThanOrEqual(54);
  expect(cardImageBox?.width).toBeLessThanOrEqual(56);
  expect(cardImageBox?.height).toBeGreaterThanOrEqual(54);
  expect(cardImageBox?.height).toBeLessThanOrEqual(56);

  await authorAvatar.click();
  const modal = page.getByRole("dialog", { name: "Ivy Lin profile" });
  await expect(modal).toBeVisible();
  await expect(modal.locator(".profileInfoGrid").getByText("Team", { exact: true })).toHaveCount(0);
  await expect(modal.locator(".profileInfoGrid").getByText("People & Culture", { exact: true })).toBeVisible();
  await expect(modal.getByText("640", { exact: true })).toBeVisible();
  await expect(modal.getByText("A profile card interaction contract", { exact: true })).toBeVisible();
  await expect(modal.getByText("People Ops Copilot", { exact: true })).toBeVisible();
  await expect(modal.getByText("Profile Ready", { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "Close profile" }).click();

  const participantButtons = page.locator(".portal-post-context .participantButton");
  await expect(participantButtons).toHaveCount(2);
  await participantButtons.first().hover();
  await expect(page.getByRole("tooltip")).toContainText("Ivy Lin");

  await page.goto("/#/home");
  const feedCard = page.locator("#discussion-profile-card-post");
  await feedCard.locator(".profileInlineAvatar").click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.getByRole("dialog", { name: "Ivy Lin profile" })).toBeVisible();
  await page.getByRole("dialog", { name: "Ivy Lin profile" }).getByRole("button", { name: "Close profile" }).click();
  await feedCard.locator(".portal-feed-open").click();
  await expect(page).toHaveURL(/#\/posts\/profile-card-post$/);

  await page.goto("/#/home");
  await page.getByRole("button", { name: "Open Live", exact: true }).click();
  const liveAvatar = page.locator(".portal-live-activity .profileInlineAvatar").first();
  await expect(liveAvatar).toBeVisible();
  await liveAvatar.hover();
  await expect(page.getByRole("tooltip")).toContainText("Ivy Lin");
  await liveAvatar.click();
  await expect(page.getByRole("dialog", { name: "Ivy Lin profile" })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

function profilePayload() {
  return {
    id: PROFILE_USER_ID,
    name: "Ivy Lin",
    email: "ivy.lin@example.test",
    avatarUrl: PROFILE_AVATAR,
    department: "People & Culture",
    team: "AI Adoption",
    jobTitle: "People Experience Lead",
    bio: "Builds practical people experiences with the AI Adoption team.",
    role: "member" as const,
    journeyLevelKey: "master" as const,
    journeyTotalPoints: 640,
    journeyBadgeCount: 1,
    journeyBadges: [{
      awardedAt: "2026-07-14T02:00:00.000Z",
      badgeKey: "profile_ready",
      descriptionEn: "Completed the public profile.",
      descriptionZh: "完成个人资料。",
      nameEn: "Profile Ready",
      nameZh: "资料就绪",
      points: 20
    }],
    recentPosts: [{
      createdAt: "2026-07-15T02:00:00.000Z",
      id: "profile-card-post",
      replyCount: 1,
      title: "A profile card interaction contract"
    }],
    publishedSkills: [{
      id: "listing-people-ops-copilot",
      targetId: "people-ops-copilot",
      name: "People Ops Copilot",
      summary: "Supports common People Operations workflows.",
      installs: 18,
      publishedAt: "2026-07-14T02:00:00.000Z"
    }]
  };
}
