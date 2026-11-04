import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadWorkerModels() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-live-worker-index-"));
  const outfile = join(outdir, "index.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

describe("Portal Live worker row projections", () => {
  it("resolves an activity lookup after the producer commits it to D1", async () => {
    const { publishedLiveEventFromRequest } = await loadWorkerModels();
    const state = {};
    const db = lookupDb(state, {
      actionType: "forum.topic.created",
      actorName: "Ada",
      actorUserId: "user-ada",
      createdAt: "2026-07-23 08:00:00",
      id: "activity-lookup-1",
      summary: "Ada 发布了帖子《实时事件》",
      targetId: "topic-1",
      targetTitle: "实时事件",
      targetType: "forum_topic",
      visibility: "org"
    });

    const event = await publishedLiveEventFromRequest(db, {
      activityEventId: "activity-lookup-1"
    });

    assert.equal(state.binding, "activity-lookup-1");
    assert.match(state.sql, /FROM activity_events/);
    assert.equal(event.activity.id, "activity-lookup-1");
    assert.equal(event.activity.channel, "community");
  });

  it("resolves a notification lookup with its current read state", async () => {
    const { publishedLiveEventFromRequest } = await loadWorkerModels();
    const state = {};
    const db = lookupDb(state, {
      actorName: "Ada",
      actorUserId: "user-ada",
      createdAt: "2026-07-23 08:00:00",
      entityId: "post-1",
      entityType: "forum_post",
      id: "notification-lookup-1",
      notificationType: "forum.mention",
      recipientUserId: "user-grace",
      status: "read",
      summary: "Ada 提到了你"
    });

    const event = await publishedLiveEventFromRequest(db, {
      notificationId: "notification-lookup-1"
    });

    assert.equal(state.binding, "notification-lookup-1");
    assert.match(state.sql, /FROM notifications/);
    assert.equal(event.activity.eventType, "notification.read");
    assert.equal(event.activity.unread, false);
    assert.deepEqual(event.audience.recipientUserIds, ["user-grace"]);
  });

  it("projects agent activity_events into the agent channel", async () => {
    const { liveEventFromActivityRow } = await loadWorkerModels();
    const event = liveEventFromActivityRow({
      actionType: "agent.operation.started",
      actorName: "Codex",
      createdAt: "2026-07-12 12:00:00",
      id: "agent-event-1",
      metadataJson: JSON.stringify({
        agentId: "agent-codex",
        agentName: "Codex",
        agentType: "codex",
        action: "Reading V2 live files"
      }),
      summary: "Codex is reading V2 live files",
      targetId: "agent-codex",
      targetTitle: "Codex",
      targetType: "agent",
      visibility: "org"
    });

    assert.equal(event.activity.channel, "agent");
    assert.equal(event.activity.agent.type, "codex");
    assert.equal(event.activity.entityType, "agent");
    assert.equal(event.audience.visibility, "org");
  });

  it("keeps public forum events produced by MCP in the Community channel", async () => {
    const { liveEventFromActivityRow } = await loadWorkerModels();
    const event = liveEventFromActivityRow({
      actionType: "forum.reply.created",
      actorName: "Ivy Lin",
      actorUserId: "user-ivy",
      createdAt: "2026-08-10 10:42:16",
      id: "community-mcp-reply-1",
      metadataJson: JSON.stringify({ postId: "reply-1" }),
      parentId: "topic-1",
      parentTitle: "Deployment help",
      parentType: "forum_topic",
      scenario: "community",
      source: "mcp",
      summary: "Ivy Lin 回复了帖子《Deployment help》",
      targetId: "reply-1",
      targetTitle: "回复",
      targetType: "forum_post",
      visibility: "org"
    });

    assert.equal(event.activity.channel, "community");
    assert.equal(event.activity.eventType, "forum.reply.created");
    assert.equal(event.activity.metadata.source, "mcp");
    assert.equal(event.audience.visibility, "org");
  });

  it("projects unified notifications into private unread/read direct activities", async () => {
    const { liveEventFromNotificationRow } = await loadWorkerModels();
    const unread = liveEventFromNotificationRow({
      actorAvatarUrl: "https://example.test/grace.png",
      actorName: "Grace",
      actorUserId: "user-grace",
      createdAt: "2026-07-12T12:00:00.000Z",
      id: "notification-1",
      notificationType: "mention",
      postId: "post-1",
      recipientUserId: "user-ada",
      status: "unread",
      topicId: "topic-1",
      topicTitle: "Mention contract"
    });
    const read = liveEventFromNotificationRow({
      ...unread.activity.metadata,
      actorName: "Grace",
      actorUserId: "user-grace",
      createdAt: "2026-07-12T12:00:00.000Z",
      id: "notification-1",
      recipientUserId: "user-ada",
      status: "read"
    });

    assert.equal(unread.activity.channel, "direct");
    assert.equal(unread.activity.notificationId, "notification-1");
    assert.equal(unread.activity.unread, true);
    assert.deepEqual(unread.audience.recipientUserIds, ["user-ada"]);
    assert.equal(unread.audience.visibility, "private");
    assert.equal(read.activity.eventType, "notification.read");
    assert.equal(read.activity.unread, false);
  });

  it("summarizes community contribution notifications with the awarded points", async () => {
    const { liveEventFromNotificationRow } = await loadWorkerModels();
    const event = liveEventFromNotificationRow({
      actorName: "Billy Fung",
      actorUserId: "user-billy",
      createdAt: "2026-08-21T12:00:00.000Z",
      entityId: "reply-1",
      entityType: "forum_post",
      id: "notification-contribution-1",
      metadataJson: JSON.stringify({ points: 40, topicTitle: "模型调用报错排查" }),
      notificationType: "forum.contributor_awarded",
      recipientUserId: "user-ada",
      status: "unread"
    });

    assert.equal(event.activity.summary, "Billy Fung 给你的内容添加了社区贡献（+40）：《模型调用报错排查》");
    assert.equal(event.activity.channel, "direct");
    assert.deepEqual(event.audience.recipientUserIds, ["user-ada"]);
  });

  it("projects APPS approvals with their stored destination", async () => {
    const { liveEventFromNotificationRow } = await loadWorkerModels();
    const event = liveEventFromNotificationRow({
      actorName: "Admin",
      actorUserId: "admin-1",
      createdAt: "2026-07-20T12:00:00.000Z",
      entityId: "listing-1",
      entityType: "publication_listing",
      href: "#/apps/app-1",
      id: "notification-apps-1",
      metadataJson: JSON.stringify({ listingName: "Research App" }),
      notificationType: "apps.review_approved",
      recipientUserId: "owner-1",
      status: "unread",
      summary: "APPS「Research App」审核已通过"
    });

    assert.equal(event.activity.entityType, "publication_listing");
    assert.equal(event.activity.href, "#/apps/app-1");
    assert.equal(event.activity.summary, "APPS「Research App」审核已通过");
    assert.deepEqual(event.audience.recipientUserIds, ["owner-1"]);
  });
});

function lookupDb(state, row) {
  return {
    prepare(sql) {
      state.sql = sql;
      return {
        bind(binding) {
          state.binding = binding;
          return {
            async first() {
              return row;
            }
          };
        }
      };
    }
  };
}
