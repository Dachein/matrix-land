import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadDataSource() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-live-catalog-source-"));
  const outfile = join(outdir, "live-data-source.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./liveDataSource.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

describe("Portal Live catalog snapshot", () => {
  it("does not expose organization data as online-person detail", async () => {
    const { createCatalogLiveDataSource } = await loadDataSource();
    const source = createCatalogLiveDataSource({
      activityEvents: [],
      currentUser: {
        avatarUrl: "https://avatar.example.com/ada.png",
        department: "Platform",
        id: "user-1",
        name: "Ada",
        team: "AI Adoption"
      },
      discussions: []
    }, "connected");

    assert.deepEqual(source.getSnapshot().onlinePeople, [{
      avatarUrl: "https://avatar.example.com/ada.png",
      detail: "",
      id: "user-1",
      name: "Ada"
    }]);
  });

  it("marks both legacy and array-shaped recipients as priority", async () => {
    const { activityTargetsUser } = await loadDataSource();

    assert.equal(activityTargetsUser({ recipientUserId: "user-1" }, "user-1"), true);
    assert.equal(activityTargetsUser({ recipientUserIds: ["user-2", "user-1"] }, "user-1"), true);
    assert.equal(activityTargetsUser({ recipientUserIds: ["user-2"] }, "user-1"), false);
    assert.equal(activityTargetsUser(undefined, "user-1"), false);
  });

  it("keeps twenty forum fallbacks even when formal activity events exist", async () => {
    const { createCatalogLiveDataSource } = await loadDataSource();
    const activityEvents = Array.from({ length: 30 }, (_, index) => ({
      actionType: "community.member.joined",
      actorName: `Member ${index}`,
      createdAt: `2026-09-24T00:${String(index).padStart(2, "0")}:00.000Z`,
      id: `event-${index}`,
      metadata: {},
      scenario: "community",
      source: "portal",
      summary: `Member ${index} joined`,
      targetId: "community",
      targetTitle: "Community",
      targetType: "community",
      visibility: "org"
    }));
    const discussions = Array.from({ length: 25 }, (_, index) => ({
      author: `Author ${index}`,
      authorId: `author-${index}`,
      id: `topic-${index}`,
      lastActive: `2026-09-23T00:${String(index).padStart(2, "0")}:00.000Z`,
      title: `Topic ${index}`
    }));

    const source = createCatalogLiveDataSource({
      activityEvents,
      currentUser: { id: "user-1", name: "Ada" },
      discussions
    }, "connected");
    const activities = source.getSnapshot().activities;

    assert.equal(activities.filter((activity) => activity.id.startsWith("event-")).length, 30);
    assert.equal(activities.filter((activity) => activity.id.startsWith("discussion-activity-")).length, 20);
  });

  it("classifies catalog activity into community, direct, and agent channels", async () => {
    const { activityFromCatalogEvent } = await loadDataSource();
    const baseEvent = {
      actionType: "forum.topic.created",
      actorName: "Ada",
      createdAt: "2026-07-12T00:00:00.000Z",
      id: "event-1",
      metadata: {},
      scenario: "community",
      source: "portal",
      summary: "Ada posted",
      targetId: "topic-1",
      targetTitle: "Topic",
      targetType: "forum_topic",
      visibility: "org"
    };

    assert.equal(activityFromCatalogEvent(baseEvent, "user-1").channel, "community");
    assert.equal(activityFromCatalogEvent({
      ...baseEvent,
      id: "event-2",
      metadata: { recipientUserIds: ["user-1"] }
    }, "user-1").channel, "direct");
    assert.equal(activityFromCatalogEvent({
      ...baseEvent,
      actionType: "agent.operation.started",
      id: "event-3",
      metadata: { agentId: "agent-codex", agentName: "Codex", agentType: "codex" },
      targetId: "agent-codex",
      targetTitle: "Codex",
      targetType: "agent"
    }, "user-1").channel, "agent");
  });
});
