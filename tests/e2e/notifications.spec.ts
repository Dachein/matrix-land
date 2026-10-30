import { expect, test, type Page } from "@playwright/test";
import { collectRuntimeErrors, mockPortalApis } from "./fixtures/portalApi";

type NotificationFixture = {
  actorAvatarUrl?: string;
  actorName: string;
  actorUserId: string;
  createdAt: string;
  entityId: string;
  entityType: string;
  href?: string;
  id: string;
  metadata: Record<string, unknown>;
  notificationType: string;
  status: "read" | "unread";
  summary: string;
};

function notification(id: string, overrides: Partial<NotificationFixture> = {}): NotificationFixture {
  return {
    actorName: "Ada",
    actorUserId: "user-ada",
    createdAt: "2026-07-20T10:00:00.000Z",
    entityId: `post-${id}`,
    entityType: "forum_post",
    href: `#/posts/topic-${id}`,
    id,
    metadata: {},
    notificationType: "forum.thread_replied",
    status: "unread",
    summary: "Ada replied to your post",
    ...overrides
  };
}

async function mockNotifications(page: Page, notifications: NotificationFixture[]) {
  await page.route("**/api/notifications**", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ contentType: "application/json", json: { updated: true } });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: {
        notifications,
        unreadCount: notifications.filter((item) => item.status === "unread").length
      }
    });
  });
}

test("shows the empty notification state inside the right Live rail", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await mockPortalApis(page);
  await mockNotifications(page, []);
  await page.goto("/#/home");

  const liveRail = page.locator(".portal-live-rail");
  await liveRail.getByRole("button", { exact: true, name: "Notification" }).click();
  await expect(liveRail.locator(".portal-live-notification-state")).toHaveText("No notifications yet");
  await expect(page.locator(".portal-left-footer .portal-notification-trigger")).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("opens one unread reply directly and marks it read", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await mockPortalApis(page);
  await mockNotifications(page, [notification("one")]);
  await page.goto("/#/home");

  const notificationSignal = page.locator(".portal-live-ping-bubble.notification");
  await expect(notificationSignal).toContainText("Ada replied to your post");
  await notificationSignal.click();
  await expect(page).toHaveURL(/#\/posts\/topic-one$/);
  expect(runtimeErrors).toEqual([]);
});

test("shows an icon and count in the collapsed Live control for multiple unread messages", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ height: 900, width: 1100 });
  await mockPortalApis(page);
  await mockNotifications(page, [
    notification("one"),
    notification("two", { actorName: "Bob" }),
    notification("three", { actorName: "Claire" })
  ]);
  await page.goto("/#/home");

  const pingAvatar = page.locator(".portal-live-ping-avatar");
  await expect(pingAvatar.locator(".portal-live-ping-count")).toHaveText("3");
  const notificationSignal = page.locator(".portal-live-ping-bubble.notification");
  await expect(notificationSignal).toContainText("3 unread notifications");
  await notificationSignal.click();
  await expect(page.locator(".portal-live-rail")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Notification/ })).toHaveAttribute("aria-pressed", "true");
  expect(runtimeErrors).toEqual([]);
});
