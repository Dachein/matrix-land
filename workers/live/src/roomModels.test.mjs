import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadModels() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-live-room-models-"));
  const outfile = join(outdir, "room-models.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./roomModels.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

const activity = {
  actorName: "Maya Chen",
  createdAt: "2026-07-12T08:00:00.000Z",
  id: "activity-1",
  priority: false,
  summary: "Mentioned you in a discussion"
};

describe("Portal Live room models", () => {
  it("normalizes workspace ids and rejects unsafe names", async () => {
    const { normalizeWorkspaceId } = await loadModels();

    assert.equal(normalizeWorkspaceId(" Workspace-AI.Playground "), "workspace-ai.playground");
    assert.equal(normalizeWorkspaceId("../../room"), "");
  });

  it("deduplicates unchanged activity ids while preserving the original cursor", async () => {
    const { appendStoredActivity, normalizePublishedLiveEvent } = await loadModels();
    const event = normalizePublishedLiveEvent({ activity, audience: { visibility: "org" } });
    const first = appendStoredActivity([], event, "1");
    const duplicate = appendStoredActivity(first, event, "2");

    assert.equal(first.length, 1);
    assert.equal(duplicate.length, 1);
    assert.equal(duplicate[0].cursor, "1");
    assert.strictEqual(duplicate, first);
  });

  it("upserts changed activity ids with a new cursor", async () => {
    const { appendStoredActivity, normalizePublishedLiveEvent } = await loadModels();
    const firstEvent = normalizePublishedLiveEvent({ activity, audience: { visibility: "org" } });
    const changedEvent = normalizePublishedLiveEvent({
      activity: { ...activity, summary: "Read mention", unread: false },
      audience: { recipientUserIds: ["user-1"], visibility: "private" }
    });
    const first = appendStoredActivity([], firstEvent, "1");
    const changed = appendStoredActivity(first, changedEvent, "2");

    assert.equal(changed.length, 1);
    assert.equal(changed[0].cursor, "2");
    assert.equal(changed[0].activity.summary, "Read mention");
    assert.equal(changed[0].audience.visibility, "private");
  });

  it("compacts oversized activity state before Durable Object storage", async () => {
    const { appendStoredActivity, compactStoredActivityLog, normalizePublishedLiveEvent } = await loadModels();
    const oversized = normalizePublishedLiveEvent({
      activity: {
        ...activity,
        actorAvatarUrl: `data:image/png;base64,${"A".repeat(10_000)}`,
        metadata: {
          activitySummaryZh: "更".repeat(2_000),
          body: "private source body".repeat(50_000),
          groupId: "ag_test"
        },
        summary: "S".repeat(20_000)
      },
      audience: { actorUserId: "user-1", visibility: "private" }
    });
    const log = appendStoredActivity([], oversized, "cursor-1");
    const reloaded = compactStoredActivityLog(log);

    assert.equal(reloaded[0].activity.summary.length, 600);
    assert.equal(reloaded[0].activity.actorAvatarUrl, undefined);
    assert.equal(reloaded[0].activity.metadata.groupId, "ag_test");
    assert.equal(reloaded[0].activity.metadata.activitySummaryZh.length, 700);
    assert.equal(reloaded[0].activity.metadata.body, undefined);
    assert.ok(JSON.stringify(reloaded).length < 3_000);
  });

  it("caps historical activity state at the storage-safe limit", async () => {
    const { compactStoredActivityLog } = await loadModels();
    const log = Array.from({ length: 180 }, (_, index) => ({
      activity: { ...activity, id: `activity-${index}` },
      audience: { recipientUserIds: [], visibility: "org" },
      cursor: String(index)
    }));

    assert.equal(compactStoredActivityLog(log).length, 120);
  });

  it("reserves independent 60-item windows for community and Agent activity", async () => {
    const { compactStoredActivityLog } = await loadModels();
    const privateEntries = Array.from({ length: 80 }, (_, index) => ({
      activity: { ...activity, channel: "direct", id: `private-${index}`, notificationId: `notification-${index}` },
      audience: { recipientUserIds: [`user-${index}`], visibility: "private" },
      cursor: `private-${index}`
    }));
    const agentEntries = Array.from({ length: 80 }, (_, index) => ({
      activity: { ...activity, channel: "agent", id: `agent-${index}` },
      audience: { recipientUserIds: [`user-${index}`], visibility: "private" },
      cursor: `agent-${index}`
    }));
    const communityEntries = Array.from({ length: 80 }, (_, index) => ({
      activity: { ...activity, channel: "community", id: `community-${index}` },
      audience: { recipientUserIds: [], visibility: "org" },
      cursor: `community-${index}`
    }));
    const compacted = compactStoredActivityLog([...privateEntries, ...agentEntries, ...communityEntries]);

    assert.equal(compacted.length, 120);
    assert.equal(compacted.filter((entry) => entry.activity.channel === "community").length, 60);
    assert.equal(compacted.filter((entry) => entry.activity.channel === "agent").length, 60);
    assert.equal(compacted.filter((entry) => entry.activity.channel === "direct").length, 0);
    assert.equal(compacted[0].activity.id, "agent-0");
  });

  it("filters private and team activity per principal and marks direct events as priority", async () => {
    const { activityForPrincipal } = await loadModels();
    const privateEntry = {
      activity,
      audience: { recipientUserIds: ["user-1"], visibility: "private" },
      cursor: "3"
    };
    const teamEntry = {
      activity: { ...activity, id: "activity-2" },
      audience: { recipientUserIds: [], teamId: "team-a", visibility: "team" },
      cursor: "4"
    };

    assert.equal(activityForPrincipal(privateEntry, { id: "user-2", name: "Other" }), undefined);
    assert.equal(activityForPrincipal(privateEntry, { id: "user-1", name: "Target" }).priority, true);
    assert.equal(activityForPrincipal(teamEntry, { id: "user-1", name: "Target", teamId: "team-a" }).id, "activity-2");
    assert.equal(activityForPrincipal(teamEntry, { id: "user-1", name: "Target", teamId: "team-b" }), undefined);
  });

  it("deduplicates online people across multiple tabs", async () => {
    const { onlinePeopleFromAttachments } = await loadModels();
    const principal = { id: "user-1", name: "Maya", team: "AI Adoption" };
    const people = onlinePeopleFromAttachments([
      { connectionId: "1", principal, subscribed: true, workspaceId: "workspace" },
      { connectionId: "2", principal, subscribed: true, workspaceId: "workspace" },
      { connectionId: "3", principal: { id: "user-2", name: "Adrian" }, subscribed: false, workspaceId: "workspace" }
    ], "workspace");

    assert.deepEqual(people, [{ detail: "", id: "user-1", name: "Maya" }]);
  });
});
