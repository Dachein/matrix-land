import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentActivityGroupId,
  describeAgentTool,
  recordAgentToolActivity
} from "./activity.ts";

const principal = {
  agentType: "codex",
  connectionId: "conn-codex-1",
  email: "ada@example.invalid",
  name: "Ada",
  scopes: ["workspace:knowledge:read", "workspace:knowledge:write"],
  sub: "user-ada",
  team: "Research",
  teamId: "team-research"
};

function activityDb() {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async run() {
              writes.push({ bindings, sql });
            }
          };
        }
      };
    }
  };
}

describe("Workspace MCP Agent activity", () => {
  it("classifies common Knowledge, Forum, Hub, and APPS actions", () => {
    assert.equal(describeAgentTool("knowledge_edit_file_update").actionType, "agent.knowledge.file.updated");
    assert.equal(describeAgentTool("knowledge_edit_service_update").actionType, "agent.knowledge.service.updated");
    assert.equal(describeAgentTool("knowledge_service_search").actionType, "agent.knowledge.consulted");
    assert.equal(describeAgentTool("forum_create_topic").actionType, "agent.forum.topic.created");
    assert.equal(describeAgentTool("forum_update_topic").actionType, "agent.forum.topic.updated");
    assert.equal(describeAgentTool("upload_finalize").actionType, "agent.forum.media.uploaded");
    assert.equal(describeAgentTool("upload_begin").actionType, "agent.forum.media.uploaded");
    assert.equal(describeAgentTool("forum_upload_media").actionType, "agent.forum.media.uploaded");
    assert.equal(describeAgentTool("hub_submit_listing").actionType, "agent.hub.listing.submitted");
    assert.equal(describeAgentTool("apps_deployments_publish").actionType, "agent.apps.deployment.published");
  });

  it("keeps one group for the same user, connection, capability family, target, and 15-minute bucket", async () => {
    const base = {
      actorUserId: "user-ada",
      capability: "knowledge",
      connectionId: "conn-1",
      family: "knowledge.write",
      occurredAt: new Date("2026-07-21T04:02:00.000Z"),
      targetScopeId: "service-1"
    };
    const first = await agentActivityGroupId(base);
    const sameBucket = await agentActivityGroupId({ ...base, occurredAt: new Date("2026-07-21T04:14:59.000Z") });
    const nextBucket = await agentActivityGroupId({ ...base, occurredAt: new Date("2026-07-21T04:15:00.000Z") });
    const otherUser = await agentActivityGroupId({ ...base, actorUserId: "user-grace" });

    assert.match(first, /^ag_[0-9a-f]{24}$/);
    assert.equal(first, sameBucket);
    assert.notEqual(first, nextBucket);
    assert.notEqual(first, otherUser);
  });

  it("writes a private, user-bound activity without storing file contents", async () => {
    const db = activityDb();
    const result = await recordAgentToolActivity({ DB: db }, {
      args: {
        contentText: "confidential body must not enter activity metadata",
        fileName: "research.md",
        objectId: "file-1"
      },
      durationMs: 42,
      now: new Date("2026-07-21T04:03:00.000Z"),
      principal,
      requestId: "request-1",
      result: {
        item: {
          id: "file-1",
          knowledgeServiceId: "service-1",
          name: "research.md"
        },
        version: { id: "version-12", version: 12 }
      },
      rpcId: 7,
      status: "succeeded",
      toolName: "knowledge_edit_file_update"
    });

    assert.equal(db.writes.length, 1);
    assert.match(db.writes[0].sql, /'private'/);
    assert.equal(db.writes[0].bindings[1], "agent.knowledge.file.updated");
    assert.equal(db.writes[0].bindings[2], "user-ada");
    assert.equal(db.writes[0].bindings[5], "knowledge_file");
    assert.equal(db.writes[0].bindings[6], "file-1");
    assert.equal(db.writes[0].bindings[7], "research.md");
    assert.equal(result.visibility, "private");
    assert.equal(result.metadata.status, "succeeded");
    assert.equal(result.metadata.versionId, "version-12");
    assert.equal(result.metadata.versionNumber, "12");
    assert.equal(JSON.stringify(result.metadata).includes("confidential body"), false);
  });

  it("defers Live publication after the Agent activity row is committed", async () => {
    const db = activityDb();
    const originalFetch = globalThis.fetch;
    const published = [];
    let deferred;
    globalThis.fetch = async (_url, init) => {
      published.push(JSON.parse(init.body));
      return new Response(null, { status: 202 });
    };

    try {
      const result = await recordAgentToolActivity({
        DB: db,
        PORTAL_LIVE_WORKSPACE_ID: "test-workspace", LIVE_PUBLISH_TOKEN: "live-secret",
        LIVE_WORKER_URL: "https://live.example.test"
      }, {
        args: { query: "risk controls" },
        durationMs: 12,
        now: new Date("2026-07-21T04:03:00.000Z"),
        principal,
        requestId: "request-live-1",
        result: { matches: [] },
        rpcId: 10,
        status: "succeeded",
        toolName: "knowledge_service_search"
      }, {
        waitUntil(promise) {
          assert.equal(db.writes.length, 1);
          deferred = promise;
        }
      });

      assert.ok(deferred instanceof Promise);
      await deferred;
      assert.deepEqual(published, [{
        activityEventId: result.eventId,
        workspaceId: "test-workspace"
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("groups multiple file writes by their Knowledge Service and records confirmation blocks", async () => {
    const db = activityDb();
    const common = {
      durationMs: 10,
      now: new Date("2026-07-21T04:03:00.000Z"),
      principal,
      rpcId: 8,
      status: "succeeded"
    };
    const updated = await recordAgentToolActivity({ DB: db }, {
      ...common,
      args: { fileName: "a.md", objectId: "file-a" },
      requestId: "request-2",
      result: { item: { id: "file-a", knowledgeServiceId: "service-1", name: "a.md" } },
      toolName: "knowledge_edit_file_update"
    });
    const uploaded = await recordAgentToolActivity({ DB: db }, {
      ...common,
      args: { fileName: "b.md" },
      requestId: "request-3",
      result: { item: { id: "file-b", knowledgeServiceId: "service-1", name: "b.md" } },
      toolName: "knowledge_edit_file_upload"
    });
    const blocked = await recordAgentToolActivity({ DB: db }, {
      args: { fileId: "file-a" },
      durationMs: 3,
      error: { code: "tool_confirmation_required" },
      now: common.now,
      principal,
      requestId: "request-4",
      rpcId: 9,
      status: "blocked",
      toolName: "knowledge_file_public_share_create"
    });

    assert.equal(updated.groupId, uploaded.groupId);
    assert.notEqual(updated.groupId, blocked.groupId);
    assert.equal(blocked.actionType, "agent.tool.blocked");
    assert.match(blocked.summary, /等待确认/);
  });
});
