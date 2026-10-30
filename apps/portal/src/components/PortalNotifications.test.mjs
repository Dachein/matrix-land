import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadNotifications() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-portal-notifications-"));
  const outfile = join(outdir, "PortalNotifications.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./PortalNotifications.tsx", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "node"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function notification(overrides = {}) {
  return {
    actorName: "Ada",
    actorUserId: "user-ada",
    createdAt: "2026-07-20T10:00:00.000Z",
    entityId: "post-1",
    entityType: "forum_post",
    href: "#/posts/topic-1",
    id: "notification-1",
    metadata: {},
    notificationType: "forum.thread_replied",
    status: "unread",
    summary: "Ada replied to your post",
    ...overrides
  };
}

describe("Portal notification presentation", () => {
  it("normalizes the unread badge", async () => {
    const { notificationUnreadBadge } = await loadNotifications();
    assert.equal(notificationUnreadBadge(12), "12");
    assert.equal(notificationUnreadBadge(140), "99+");
    assert.equal(notificationUnreadBadge(0), undefined);
  });

  it("resolves an approved listing to its concrete App cover", async () => {
    const { enrichPortalNotification } = await loadNotifications();
    const approved = enrichPortalNotification(notification({
      entityId: "listing-research-app",
      metadata: {
        listingId: "listing-research-app",
        listingName: "Research App",
        listingType: "app",
        targetId: "app-research"
      },
      notificationType: "apps.review_approved"
    }), {
      apps: [{ coverImageUrl: "/covers/research-app.png", id: "app-research", name: "Research App" }],
      hubListings: [],
      publicationListings: [],
      skills: []
    });

    assert.equal(approved.targetImageUrl, "/covers/research-app.png");
    assert.equal(approved.targetName, "Research App");
  });
});
