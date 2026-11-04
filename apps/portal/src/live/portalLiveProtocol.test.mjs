import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadProtocol() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-live-protocol-"));
  const outfile = join(outdir, "protocol.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./portalLiveProtocol.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function activity(id, summary = id) {
  return {
    actorName: "Ada",
    createdAt: "2026-07-12T00:00:00.000Z",
    id,
    priority: false,
    summary
  };
}

describe("Portal Live protocol", () => {
  it("validates the versioned workspace subscription", async () => {
    const { parsePortalLiveClientMessage } = await loadProtocol();
    const valid = parsePortalLiveClientMessage(JSON.stringify({
      cursor: "c-1",
      sentAt: "2026-07-12T00:00:00.000Z",
      type: "subscribe",
      version: 1,
      workspaceId: "workspace-ai-playground"
    }));

    assert.equal(valid.workspaceId, "workspace-ai-playground");
    assert.equal(parsePortalLiveClientMessage(JSON.stringify({ ...valid, version: 2 })), undefined);
    assert.equal(parsePortalLiveClientMessage(JSON.stringify({ ...valid, workspaceId: "" })), undefined);
  });

  it("validates versioned server messages", async () => {
    const { parsePortalLiveServerMessage } = await loadProtocol();
    const message = parsePortalLiveServerMessage(JSON.stringify({
      activities: [{
        ...activity("evt-1"),
        agent: { id: "agent-codex", name: "Codex", type: "codex" },
        channel: "agent",
        entityId: "agent-codex",
        entityType: "agent",
        eventType: "agent.operation.started",
        metadata: { action: "Reading files" }
      }],
      cursor: "cur-1",
      onlinePeople: [{ detail: "Reviewing", id: "user-1", name: "Ada" }],
      sentAt: "2026-07-12T00:00:00.000Z",
      type: "snapshot",
      version: 1
    }));

    assert.equal(message?.type, "snapshot");
    assert.equal(message.activities[0].channel, "agent");
    assert.equal(message.activities[0].agent.type, "codex");
    assert.equal(parsePortalLiveServerMessage("not-json"), undefined);
    assert.equal(parsePortalLiveServerMessage(JSON.stringify({ ...message, version: 2 })), undefined);
  });

  it("normalizes legacy discussion links to the canonical Portal post route", async () => {
    const { normalizePortalLiveHref } = await loadProtocol();

    assert.equal(normalizePortalLiveHref("#/community/topic%201"), "#/posts/topic%201");
    assert.equal(normalizePortalLiveHref("#discussion-topic 2"), "#/posts/topic%202");
    assert.equal(normalizePortalLiveHref("#/community"), "#/community");
  });

  it("deduplicates activity ids and advances the resume cursor", async () => {
    const { reducePortalLiveMessage } = await loadProtocol();
    const snapshot = {
      activities: [activity("evt-1", "old")],
      connectionState: "connected",
      onlinePeople: []
    };
    const next = reducePortalLiveMessage(snapshot, {
      activity: activity("evt-1", "new"),
      cursor: "cur-2",
      sentAt: "2026-07-12T00:01:00.000Z",
      type: "activity.upsert",
      version: 1
    });

    assert.equal(next.activities.length, 1);
    assert.equal(next.activities[0].summary, "new");
    assert.equal(next.cursor, "cur-2");
  });

  it("keeps unchanged activity and heartbeat messages as semantic no-ops", async () => {
    const { reducePortalLiveMessage } = await loadProtocol();
    const snapshot = {
      activities: [activity("evt-1")],
      connectionState: "connected",
      cursor: "cur-1",
      onlinePeople: []
    };
    const duplicate = reducePortalLiveMessage(snapshot, {
      activity: activity("evt-1"),
      cursor: "cur-1",
      sentAt: "2026-07-12T00:01:00.000Z",
      type: "activity.upsert",
      version: 1
    });
    const heartbeat = reducePortalLiveMessage(snapshot, {
      cursor: "cur-1",
      sentAt: "2026-07-12T00:01:00.000Z",
      type: "heartbeat",
      version: 1
    });

    assert.strictEqual(duplicate, snapshot);
    assert.strictEqual(heartbeat, snapshot);
  });

  it("preserves a valid catalog avatar when the Live snapshot omits it", async () => {
    const { reducePortalLiveMessage } = await loadProtocol();
    const snapshot = {
      activities: [{ ...activity("evt-1"), actorAvatarUrl: "data:image/png;base64,full-avatar", actorUserId: "user-1" }],
      connectionState: "connecting",
      onlinePeople: []
    };
    const next = reducePortalLiveMessage(snapshot, {
      activities: [{ ...activity("evt-1"), actorUserId: "user-1" }],
      cursor: "cur-1",
      onlinePeople: [],
      sentAt: "2026-07-12T00:01:00.000Z",
      type: "snapshot",
      version: 1
    });

    assert.equal(next.activities[0].actorAvatarUrl, "data:image/png;base64,full-avatar");
  });

  it("merges a sparse Live snapshot without discarding the REST community baseline", async () => {
    const { reducePortalLiveMessage } = await loadProtocol();
    const snapshot = {
      activities: [
        { ...activity("community-1"), channel: "community", createdAt: "2026-07-12T00:02:00.000Z" },
        { ...activity("community-2"), channel: "community", createdAt: "2026-07-12T00:01:00.000Z" }
      ],
      connectionState: "connecting",
      onlinePeople: []
    };
    const next = reducePortalLiveMessage(snapshot, {
      activities: [{ ...activity("notification-1"), channel: "direct" }],
      cursor: "cur-1",
      onlinePeople: [],
      sentAt: "2026-07-12T00:03:00.000Z",
      type: "snapshot",
      version: 1
    });

    assert.deepEqual(next.activities.map((item) => item.id), [
      "community-1",
      "community-2",
      "notification-1"
    ]);
  });

  it("keeps presence as a de-duplicated snapshot", async () => {
    const { reducePortalLiveMessage } = await loadProtocol();
    const person = { detail: "Online", id: "user-1", name: "Ada" };
    const next = reducePortalLiveMessage({ activities: [], connectionState: "connecting", onlinePeople: [] }, {
      onlinePeople: [person, person],
      sentAt: "2026-07-12T00:01:00.000Z",
      type: "presence.sync",
      version: 1
    });

    assert.deepEqual(next.onlinePeople, [person]);
    assert.equal(next.connectionState, "connected");
  });
});
