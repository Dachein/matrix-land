import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groupAgentActivities,
  groupCommunityActivities,
  latestActivityGroups,
  mergeRecentActivities,
  localizedAgentActivitySummary
} from "./agentActivityGroups.ts";

function activity(id, overrides = {}) {
  return {
    actorName: "Ada",
    agent: { id: "conn-1", name: "Codex", type: "codex" },
    channel: "agent",
    createdAt: "2026-07-21T04:00:00.000Z",
    id,
    metadata: {
      activitySummaryEn: "Codex updated research.md",
      activitySummaryZh: "Codex 更新了「research.md」",
      groupId: "ag_group_1",
      status: "succeeded"
    },
    priority: true,
    summary: "Codex 更新了「research.md」",
    ...overrides
  };
}

describe("Portal Agent activity groups", () => {
  it("folds events with the same server group id and keeps the latest activity", () => {
    const groups = groupAgentActivities([
      activity("event-1"),
      activity("event-2", {
        createdAt: "2026-07-21T04:05:00.000Z",
        metadata: {
          activitySummaryEn: "Codex uploaded appendix.md",
          activitySummaryZh: "Codex 上传了「appendix.md」",
          groupId: "ag_group_1",
          status: "succeeded"
        },
        summary: "Codex 上传了「appendix.md」"
      })
    ]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 2);
    assert.equal(groups[0].activity.id, "event-2");
    assert.equal(groups[0].succeededCount, 2);
    assert.equal(groups[0].failedCount, 0);
  });

  it("keeps ungrouped legacy events separate and counts failed outcomes", () => {
    const groups = groupAgentActivities([
      activity("event-1", { metadata: { status: "failed" } }),
      activity("event-2", { metadata: { status: "blocked" } })
    ]);

    assert.equal(groups.length, 2);
    assert.ok(groups.every((group) => group.failedCount === 1));
  });

  it("selects the stored localized summary", () => {
    const item = activity("event-1");
    assert.equal(localizedAgentActivitySummary(item, "zh-CN"), "Codex 更新了「research.md」");
    assert.equal(localizedAgentActivitySummary(item, "en-US"), "Codex updated research.md");
  });

  it("keeps only the latest 30 activity groups for either Live tab", () => {
    const groups = Array.from({ length: 35 }, (_, index) => ({
      activity: activity(`activity-${index}`, {
        createdAt: `2026-07-20T10:${String(index).padStart(2, "0")}:00.000Z`
      }),
      groupId: `group-${index}`
    }));
    const latest = latestActivityGroups(groups);

    assert.equal(latest.length, 30);
    assert.equal(latest[0].activity.id, "activity-34");
    assert.equal(latest.at(-1).activity.id, "activity-5");
  });

  it("folds repeated reactions by one actor in one topic while keeping replies separate", () => {
    const repeatedReaction = {
      actorName: "大澄",
      actorUserId: "user-1",
      channel: "community",
      entityType: "forum_post",
      eventType: "forum.reaction.created",
      href: "#/posts/topic-1",
      metadata: { parentId: "topic-1" },
      priority: false,
      summary: "大澄 回应了帖子《WorkBuddy》"
    };
    const groups = groupCommunityActivities([
      { ...repeatedReaction, createdAt: "2026-07-20T16:00:00.000Z", entityId: "post-2", id: "reaction-2" },
      { ...repeatedReaction, createdAt: "2026-07-20T15:59:55.000Z", entityId: "post-1", id: "reaction-1" },
      {
        ...repeatedReaction,
        createdAt: "2026-07-20T15:58:59.000Z",
        entityId: "post-3",
        eventType: "forum.reply.created",
        id: "reply-1",
        summary: "大澄 回复了帖子《WorkBuddy》"
      }
    ]);

    assert.equal(groups.length, 2);
    assert.equal(groups[0].activity.id, "reaction-2");
    assert.equal(groups[0].count, 2);
    assert.equal(groups[1].activity.id, "reply-1");
    assert.equal(groups[1].count, 1);
  });

  it("fills a short community event response with distinct forum snapshot items", () => {
    const loaded = [
      activity("event-topic-1", { channel: "community", entityId: "topic-1", entityType: "forum_topic", href: "#/posts/topic-1" }),
      activity("event-topic-2", { channel: "community", entityId: "topic-2", entityType: "forum_topic", href: "#/posts/topic-2" })
    ];
    const snapshot = [
      activity("discussion-activity-topic-1", { channel: "community", href: "#/posts/topic-1" }),
      ...Array.from({ length: 10 }, (_, index) => activity(`discussion-activity-fallback-${index}`, {
        channel: "community",
        createdAt: `2026-07-20T09:${String(index).padStart(2, "0")}:00.000Z`,
        href: `#/posts/fallback-${index}`
      }))
    ];

    const merged = mergeRecentActivities(loaded, snapshot, 10);

    assert.equal(merged.length, 10);
    assert.equal(merged.filter((item) => item.href === "#/posts/topic-1").length, 1);
    assert.ok(merged.some((item) => item.id.startsWith("discussion-activity-fallback-")));
  });
});
