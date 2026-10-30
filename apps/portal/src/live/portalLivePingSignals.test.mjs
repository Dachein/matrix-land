import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadPingSignals() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-portal-live-ping-"));
  const outfile = join(outdir, "portalLivePingSignals.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./portalLivePingSignals.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "node"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

const pingSignalsModule = loadPingSignals();

function activity(id, overrides = {}) {
  return {
    actorName: "Ada",
    channel: "community",
    createdAt: "2026-07-21T08:00:00.000Z",
    id,
    priority: false,
    summary: `Activity ${id}`,
    ...overrides
  };
}

describe("Workspace Ping Live signals", () => {
  it("guides profile completion in avatar, Bio, then MCP Badge order", async () => {
    const { buildPortalLiveProfilePrompt } = await pingSignalsModule;
    const labels = {
      avatarSummary: "Set your profile picture",
      bioSummary: "Complete your bio",
      mcpSummary: "Connect Frontier Workspace MCP"
    };

    const avatarPrompt = buildPortalLiveProfilePrompt({
      ...labels,
      avatarUrl: " ",
      bio: "",
      hasMcpBadge: false
    });
    assert.equal(avatarPrompt.id, "profile:avatar");
    assert.equal(avatarPrompt.action, "open-profile");

    const bioPrompt = buildPortalLiveProfilePrompt({
      ...labels,
      avatarUrl: "/avatars/me.png",
      bio: " ",
      hasMcpBadge: false
    });
    assert.equal(bioPrompt.id, "profile:bio");
    assert.equal(bioPrompt.action, "open-profile");

    const mcpPrompt = buildPortalLiveProfilePrompt({
      ...labels,
      avatarUrl: "/avatars/me.png",
      bio: "Builder",
      hasMcpBadge: false
    });
    assert.equal(mcpPrompt.id, "profile:mcp");
    assert.equal(mcpPrompt.action, "open-mcp");

    assert.equal(buildPortalLiveProfilePrompt({
      ...labels,
      avatarUrl: "/avatars/me.png",
      bio: "Builder",
      hasMcpBadge: true
    }), undefined);
  });

  it("shows a profile prompt only after the latest Live message is more than one minute old", async () => {
    const { selectPortalLivePingSignals } = await pingSignalsModule;
    const latestMessage = {
      action: "none",
      createdAt: "2026-07-21T08:00:00.000Z",
      id: "activity:latest",
      indicator: "activity-avatar",
      intensity: "ambient",
      kind: "activity",
      state: "review",
      summary: "Latest message"
    };
    const profilePrompt = {
      action: "open-profile",
      createdAt: "",
      id: "profile:avatar",
      indicator: "profile-avatar",
      intensity: "ambient",
      kind: "profile",
      state: "review",
      summary: "Set your profile picture"
    };
    const messageTime = Date.parse(latestMessage.createdAt);

    assert.equal(selectPortalLivePingSignals({
      now: messageTime + 60_000,
      profilePrompt,
      signals: [latestMessage]
    })[0].id, "activity:latest");
    assert.equal(selectPortalLivePingSignals({
      now: messageTime + 60_001,
      profilePrompt,
      signals: [latestMessage]
    })[0].id, "profile:avatar");
    assert.equal(selectPortalLivePingSignals({
      now: messageTime,
      profilePrompt,
      signals: []
    })[0].id, "profile:avatar");
  });

  it("keeps unread notifications ahead of profile completion prompts", async () => {
    const { selectPortalLivePingSignals } = await pingSignalsModule;
    const notification = {
      action: "notifications",
      createdAt: "2026-07-21T08:00:00.000Z",
      id: "notification:1",
      indicator: "notification-avatar",
      intensity: "urgent",
      kind: "notification",
      state: "waving",
      summary: "Unread notification"
    };
    const profilePrompt = {
      action: "open-profile",
      createdAt: "",
      id: "profile:avatar",
      indicator: "profile-avatar",
      intensity: "ambient",
      kind: "profile",
      state: "review",
      summary: "Set your profile picture"
    };

    assert.equal(selectPortalLivePingSignals({
      now: Date.parse(notification.createdAt) + 120_000,
      profilePrompt,
      signals: [notification]
    })[0].id, "notification:1");
  });

  it("dismisses only the viewed signal and restores the bubble for a new signal or fresh page state", async () => {
    const { isPortalLivePingSignalDismissed } = await pingSignalsModule;
    assert.equal(isPortalLivePingSignalDismissed("presence:user-1:1", "presence:user-1:1", true), true);
    assert.equal(isPortalLivePingSignalDismissed("presence:user-1:1", "presence:user-1:1", false), false);
    assert.equal(isPortalLivePingSignalDismissed("presence:user-2:2", "presence:user-1:1", true), false);
    assert.equal(isPortalLivePingSignalDismissed("presence:user-1:1", undefined, true), false);
  });

  it("makes unread notifications exclusive highest priority and uses the latest sender avatar", async () => {
    const { buildPortalLivePingSignals } = await pingSignalsModule;
    const signals = buildPortalLivePingSignals({
      activities: [
        activity("notification-activity", {
          createdAt: "2026-07-21T09:00:00.000Z",
          notificationId: "notification-1",
          unread: true
        }),
        activity("agent-activity", { channel: "agent", createdAt: "2026-07-21T08:00:00.000Z" })
      ],
      locale: "zh-CN",
      latestUnreadNotification: {
        actorAvatarUrl: "/avatars/olivia.png",
        actorName: "Olivia",
        createdAt: "2026-07-21T09:00:00.000Z",
        id: "notification-1",
        notificationType: "forum.thread_replied",
        summary: "Olivia 回复了你"
      },
      multipleNotificationLabel: "2 条未读通知",
      unreadCount: 2
    });

    assert.deepEqual(signals.map((signal) => signal.id), ["notification:notification-1"]);
    assert.equal(signals[0].indicator, "notification-avatar");
    assert.equal(signals[0].actorAvatarUrl, "/avatars/olivia.png");
    assert.equal(signals[0].summary, "2 条未读通知");
  });

  it("shows the actual summary and sender avatar for a single mention", async () => {
    const { buildPortalLivePingSignals } = await pingSignalsModule;
    const signals = buildPortalLivePingSignals({
      activities: [],
      locale: "zh-CN",
      multipleNotificationLabel: "你有 1 条新消息",
      latestUnreadNotification: {
        actorAvatarUrl: "/avatars/olivia.png",
        actorName: "Olivia",
        createdAt: "2026-07-21T08:05:00.000Z",
        id: "notification-1",
        notificationType: "forum.mention",
        summary: "Olivia 在帖子中提到了你"
      },
      unreadCount: 1
    });

    assert.equal(signals[0].summary, "Olivia 在帖子中提到了你");
    assert.equal(signals[0].indicator, "notification-avatar");
    assert.equal(signals[0].actorAvatarUrl, "/avatars/olivia.png");
  });

  it("uses the approved App or Skill cover instead of a generic APPS icon", async () => {
    const { buildPortalLivePingSignals } = await pingSignalsModule;
    const signals = buildPortalLivePingSignals({
      activities: [],
      latestUnreadNotification: {
        actorName: "Reviewer",
        createdAt: "2026-07-21T08:05:00.000Z",
        id: "notification-review",
        notificationType: "apps.review_approved",
        summary: "Research App 审核通过",
        targetImageUrl: "/covers/research-app.png",
        targetName: "Research App"
      },
      locale: "zh-CN",
      multipleNotificationLabel: "你有 1 条新消息",
      unreadCount: 1
    });

    assert.equal(signals[0].indicator, "notification-target");
    assert.equal(signals[0].actorAvatarUrl, "/covers/research-app.png");
    assert.equal(signals[0].actorName, "Research App");
  });

  it("maps Live activity importance to distinct one-shot motions", async () => {
    const { pingIntensityForActivity, pingStateForActivity } = await pingSignalsModule;
    const community = activity("community");
    const priority = activity("priority", { priority: true });
    const agent = activity("agent", { channel: "agent" });
    const succeeded = activity("succeeded", { channel: "agent", metadata: { status: "succeeded" } });
    const blocked = activity("blocked", { channel: "agent", metadata: { status: "blocked" } });
    const failed = activity("failed", { channel: "agent", metadata: { status: "failed" } });

    assert.equal(pingStateForActivity(community), "review");
    assert.equal(pingStateForActivity(priority), "waving");
    assert.equal(pingStateForActivity(agent), "running");
    assert.equal(pingStateForActivity(succeeded), "jumping");
    assert.equal(pingStateForActivity(blocked), "waiting");
    assert.equal(pingStateForActivity(failed), "failed");
    assert.equal(pingIntensityForActivity(community), "ambient");
    assert.equal(pingIntensityForActivity(agent), "active");
    assert.equal(pingIntensityForActivity(priority), "urgent");
  });

  it("celebrates a successful post or reply authored by the current user", async () => {
    const { pingMotionForActivity } = await pingSignalsModule;
    assert.deepEqual(pingMotionForActivity(activity("reply", {
      actorUserId: "current-user",
      eventType: "forum.reply.created"
    }), "current-user"), {
      intensity: "active",
      reason: "self-success",
      state: "jumping"
    });
  });

  it("keeps only the latest Agent and latest Community activity, ordered by time", async () => {
    const { buildPortalLivePingSignals } = await pingSignalsModule;
    const signals = buildPortalLivePingSignals({
      activities: [
        activity("older", { createdAt: "2026-07-21T07:00:00.000Z" }),
        activity("newest", { createdAt: "2026-07-21T09:00:00.000Z" }),
        activity("agent", { channel: "agent", createdAt: "2026-07-21T08:30:00.000Z" }),
        activity("older-agent", { channel: "agent", createdAt: "2026-07-21T08:15:00.000Z" })
      ],
      locale: "zh-CN",
      multipleNotificationLabel: "没有新通知",
      unreadCount: 0
    });

    assert.deepEqual(signals.map((signal) => signal.id), [
      "activity:newest",
      "activity:agent"
    ]);
  });

  it("detects a new person entering the displayed Top 10 without reacting to reordering", async () => {
    const { findNewTopTenOnlinePerson } = await pingSignalsModule;
    const existing = Array.from({ length: 10 }, (_, index) => ({
      detail: "",
      id: `person-${index}`,
      name: `Person ${index}`
    }));
    const previousIds = new Set(existing.map((person) => person.id));

    assert.equal(findNewTopTenOnlinePerson(previousIds, [...existing].reverse()), undefined);

    const newcomer = { detail: "", id: "new-person", name: "Mina" };
    assert.deepEqual(findNewTopTenOnlinePerson(previousIds, [newcomer, ...existing]), newcomer);
    assert.equal(findNewTopTenOnlinePerson(previousIds, [...existing, newcomer]), undefined);
  });

  it("places a newly online member according to the local discovery time", async () => {
    const { buildPortalLivePingSignals } = await pingSignalsModule;
    const signals = buildPortalLivePingSignals({
      activities: [activity("community", { createdAt: "2026-07-21T08:00:00.000Z" })],
      locale: "zh-CN",
      multipleNotificationLabel: "没有新通知",
      newOnlinePerson: {
        createdAt: "2026-07-21T09:00:00.000Z",
        id: "new-person",
        name: "Mina",
        signalId: "presence:new-person:1"
      },
      newOnlineSummary: "Mina 上线了",
      unreadCount: 0
    });

    assert.equal(signals[0].id, "presence:new-person:1");
    assert.equal(signals[0].indicator, "presence-avatar");
    assert.equal(signals[0].createdAt, "2026-07-21T09:00:00.000Z");
  });
});
