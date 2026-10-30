import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createActivityApi, emitActivityEvent, readActivityEvents } from "./service.ts";

const currentUser = {
  id: "user-1",
  name: "Ada",
  email: "ada@example.com",
  team: "AI Adoption",
  identity: {
    provider: "microsoft_entra_id",
    objectId: "oid-1",
    tenantId: "tid-1"
  }
};

describe("activity service", () => {
  it("writes activity events with stable bindings", async () => {
    const state = {};
    const db = {
      prepare(sql) {
        state.sql = sql;
        return {
          bind(...bindings) {
            state.bindings = bindings;
            return {
              async run() {
                state.ran = true;
              }
            };
          }
        };
      }
    };

    const id = await emitActivityEvent(db, {
      scenario: "community",
      actionType: "community.member.joined",
      actor: currentUser,
      target: {
        type: "community",
        id: "default",
        title: "Frontier Workspace 社区"
      },
      summary: "Ada 新加入了社区",
      href: "#/community",
      teamId: "team-1",
      metadata: { source: "test" },
      sourceEventId: "community.member.joined:user-1"
    });

    assert.equal(typeof id, "string");
    assert.equal(state.ran, true);
    assert.match(state.sql, /INSERT OR IGNORE INTO activity_events/);
    assert.equal(state.bindings[1], "community");
    assert.equal(state.bindings[2], "community.member.joined");
    assert.equal(state.bindings[3], "user-1");
    assert.equal(state.bindings[15], "org");
    assert.equal(state.bindings[16], "team-1");
    assert.equal(state.bindings[17], JSON.stringify({ source: "test" }));
  });

  it("schedules Live publication only after the D1 insert succeeds", async () => {
    const state = {};
    let deferred;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 202 });
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async run() {
                state.committed = true;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }
    };

    try {
      const id = await emitActivityEvent(db, {
        scenario: "community",
        actionType: "forum.topic.created",
        actor: currentUser,
        target: {
          type: "forum_topic",
          id: "topic-1",
          title: "实时事件"
        },
        summary: "Ada 发布了帖子《实时事件》"
      }, {
        env: {
          PORTAL_LIVE_WORKSPACE_ID: "test-workspace", LIVE_PUBLISH_TOKEN: "live-secret",
          LIVE_WORKER_URL: "https://live.example.test"
        },
        waitUntil(promise) {
          assert.equal(state.committed, true);
          deferred = promise;
        }
      });

      assert.equal(typeof id, "string");
      assert.ok(deferred instanceof Promise);
      await deferred;
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reads activity events and maps rows", async () => {
    const state = {};
    const db = {
      prepare(sql) {
        state.sql = sql;
        return {
          bind(...bindings) {
            state.bindings = bindings;
            return {
              async all() {
                return {
                  results: [{
                    id: "evt-1",
                    scenario: "apps",
                    actionType: "apps.app.published",
                    actorUserId: "user-1",
                    actorName: "Ada",
                    actorAvatarUrl: "",
                    actorTeam: "AI Adoption",
                    targetType: "apps_app",
                    targetId: "app-1",
                    targetTitle: "Demo App",
                    parentType: "",
                    parentId: "",
                    parentTitle: "",
                    summary: "Ada 发布了应用《Demo App》",
                    href: "#/apps",
                    visibility: "team",
                    metadataJson: "{\"version\":\"v1\"}",
                    source: "apps-worker",
                    sourceEventId: "apps.app.published:app-1:v1",
                    createdAt: "2026-06-30T00:00:00.000Z"
                  }]
                };
              }
            };
          }
        };
      }
    };
    const events = await readActivityEvents(db, currentUser, { scenario: "apps", limit: 7, env: {} }, {
      async currentUserTeamId() {
        return "team-1";
      }
    });

    assert.match(state.sql, /FROM activity_events/);
    assert.deepEqual(state.bindings, ["apps", "apps", "team-1", "user-1", 7]);
    assert.equal(events.length, 1);
    assert.equal(events[0].scenario, "apps");
    assert.equal(events[0].source, "apps-worker");
    assert.deepEqual(events[0].metadata, { version: "v1" });
  });

  it("serves community events from a shared cache and queries only org/public rows", async () => {
    const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
    const cacheEntries = new Map();
    let databaseReads = 0;
    const db = {
      prepare(sql) {
        assert.match(sql, /scenario = 'community'/);
        assert.match(sql, /visibility IN \('org', 'public'\)/);
        assert.doesNotMatch(sql, /actor_user_id = \?/);
        return {
          bind(limit) {
            assert.equal(limit, 10);
            return {
              async all() {
                databaseReads += 1;
                return {
                  results: [{
                    id: "community-evt-1",
                    scenario: "community",
                    actionType: "community.member.joined",
                    actorUserId: "user-2",
                    actorName: "Lin",
                    actorAvatarUrl: "",
                    actorTeam: "AI Adoption",
                    targetType: "community",
                    targetId: "default",
                    targetTitle: "Frontier Workspace 社区",
                    summary: "Lin 加入了社区",
                    href: "#/community",
                    visibility: "org",
                    metadataJson: "{}",
                    source: "portal",
                    createdAt: "2026-09-24T00:00:00.000Z"
                  }]
                };
              }
            };
          }
        };
      }
    };
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: {
        default: {
          async match(request) {
            return cacheEntries.get(request.url)?.clone();
          },
          async put(request, response) {
            cacheEntries.set(request.url, response.clone());
          }
        }
      }
    });

    try {
      const api = createActivityApi({
        currentUserTeamId: async () => "team-1",
        requireDb: (value) => value,
        resolveCurrentUser: async () => currentUser
      });
      const context = {
        env: { DB: db, DEFAULT_TEAM_ID: "team-1" },
        request: new Request("https://portal.test/api/activity/events?scenario=community&limit=10")
      };

      const first = await api.listActivityEvents(context);
      const second = await api.listActivityEvents(context);

      assert.equal(databaseReads, 1);
      assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(first)));
      assert.equal(first.events.length, 1);
      assert.equal(first.events[0].actorName, "Lin");
    } finally {
      if (originalCaches) {
        Object.defineProperty(globalThis, "caches", originalCaches);
      } else {
        delete globalThis.caches;
      }
    }
  });

  it("returns an empty list when the activity table is missing", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                throw new Error("no such table: activity_events");
              }
            };
          }
        };
      }
    };
    const events = await readActivityEvents(db, currentUser, {}, {
      async currentUserTeamId() {
        return "team-1";
      }
    });

    assert.deepEqual(events, []);
  });

  it("persists authenticated Agent connector operations into activity_events", async () => {
    const state = {};
    const db = {
      prepare(sql) {
        state.sql = sql;
        return {
          bind(...bindings) {
            state.bindings = bindings;
            return {
              async run() {
                state.ran = true;
              }
            };
          }
        };
      }
    };
    const api = createActivityApi({
      currentUserTeamId: async () => "team-1",
      requireDb: (value) => value,
      resolveCurrentUser: async () => currentUser
    });

    const result = await api.publishAgentActivityEvent({
      env: { DB: db },
      request: new Request("https://portal.test/api/activity/agent-events", {
        body: JSON.stringify({
          action: "Reading project files",
          agentId: "agent-codex",
          agentName: "Codex",
          agentType: "codex",
          actionType: "agent.operation.started",
          operationId: "op-1"
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      })
    });

    assert.equal(typeof result.id, "string");
    assert.equal(state.ran, true);
    assert.equal(state.bindings[1], "agent");
    assert.equal(state.bindings[2], "agent.operation.started");
    assert.equal(state.bindings[7], "agent");
    assert.equal(state.bindings[8], "agent-codex");
    assert.equal(state.bindings[9], "Codex");
    assert.equal(state.bindings[18], "agent");
    assert.deepEqual(JSON.parse(state.bindings[17]), {
      action: "Reading project files",
      agentId: "agent-codex",
      agentName: "Codex",
      agentType: "codex",
      operationId: "op-1"
    });
  });

  it("uses safe defaults when an Agent event JSON body is not an object", async () => {
    const state = {};
    const db = {
      prepare() {
        return {
          bind(...bindings) {
            state.bindings = bindings;
            return { async run() {} };
          }
        };
      }
    };
    const api = createActivityApi({
      currentUserTeamId: async () => "team-1",
      requireDb: (value) => value,
      resolveCurrentUser: async () => currentUser
    });

    await api.publishAgentActivityEvent({
      env: { DB: db },
      request: new Request("https://portal.test/api/activity/agent-events", {
        body: "null",
        headers: { "content-type": "application/json" },
        method: "POST"
      })
    });

    assert.equal(state.bindings[2], "agent.operation.progress");
    assert.equal(state.bindings[8], "agent");
    assert.equal(state.bindings[9], "Agent");
  });
});
