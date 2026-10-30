import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createForumApi, validForumStorageKey } from "./service.ts";

function makeDeps(overrides = {}) {
  return {
    audit: async () => "audit-1",
    currentUserTeamId: async () => "team-1",
    emitActivityEvent: async () => undefined,
    excerpt(value) {
      return String(value).replace(/\s+/g, " ").trim().slice(0, 180);
    },
    httpError(status, message) {
      return Object.assign(new Error(message), { status });
    },
    readBody: async (request) => request.json(),
    refreshUserJourneyState: async () => undefined,
    requireDb(db) {
      if (!db) {
        throw Object.assign(new Error("database_not_configured"), { status: 503 });
      }
      return db;
    },
    requireText(value, errorCode, maxLength) {
      const text = String(value ?? "").trim();
      if (!text) {
        throw Object.assign(new Error(errorCode), { status: 400 });
      }
      return text.slice(0, maxLength);
    },
    resolveCurrentUser: async () => ({
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
      role: "member"
    }),
    sanitizeTags(value) {
      return Array.isArray(value) ? value : [];
    },
    userProfileColumns: async () => ({}),
    ...overrides
  };
}

describe("forum service", () => {
  it("validates forum media storage keys", () => {
    assert.equal(validForumStorageKey("forum/2026/06/file-name.png"), true);
    assert.equal(validForumStorageKey("avatars/file-name.png"), false);
    assert.equal(validForumStorageKey("forum/2026/../secret.png"), false);
    assert.equal(validForumStorageKey("forum/2026/06/<script>.png"), false);
  });

  it("rejects malformed topic-list cursors before querying the forum projection", async () => {
    const api = createForumApi(makeDeps());

    await assert.rejects(
      () => api.listForumTopics({
        env: { DB: {} },
        request: new Request("https://portal.test/api/forum/topics?cursor=malformed")
      }),
      (error) => error.status === 400 && error.message === "invalid_forum_cursor"
    );
  });

  it("does not make anonymous topics discoverable through their real author name", async () => {
    const db = makeRecordingDb();
    const api = createForumApi(makeDeps());

    await api.listForumTopics({
      env: { DB: db },
      request: new Request("https://portal.test/api/forum/topics?q=Ada")
    });

    const topicIndex = db.state.statements.find((statement) => (
      statement.sql.includes("FROM forum_topics")
      && statement.sql.includes("forum_topics.title LIKE")
    ));
    assert.match(topicIndex.sql, /forum_topics\.is_anonymous != 1 AND users\.name LIKE/);
  });

  it("builds YouTube previews without fetching remote HTML", async () => {
    const api = createForumApi(makeDeps());
    const result = await api.previewForumLink({
      env: {},
      request: new Request("https://portal.test/api/forum/link-preview?url=https://youtu.be/abcDEF12345")
    });

    assert.equal(result.preview.provider, "YouTube");
    assert.equal(result.preview.embedType, "video");
    assert.equal(result.preview.previewImageUrl, "https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg");
  });

  it("requires an authenticated user before previewing a forum link", async () => {
    let fetchCalls = 0;
    const api = createForumApi(makeDeps({
      async fetchForumLinkPreview() {
        fetchCalls += 1;
        return new Response("", { headers: { "content-type": "text/html" } });
      },
      async resolveCurrentUser() {
        throw Object.assign(new Error("authentication_required"), { status: 401 });
      }
    }));

    await assert.rejects(
      () => api.previewForumLink({
        env: {},
        request: new Request("https://portal.test/api/forum/link-preview?url=https://mp.weixin.qq.com/s/example")
      }),
      (error) => error.status === 401 && error.message === "authentication_required"
    );
    assert.equal(fetchCalls, 0);
  });

  it("rejects unsupported forum link protocols", async () => {
    const api = createForumApi(makeDeps());

    await assert.rejects(
      () => api.previewForumLink({
        env: {},
        request: new Request("https://portal.test/api/forum/link-preview?url=ftp://example.com/file")
      }),
      (error) => error.status === 400 && error.message === "invalid_forum_link_url"
    );
  });

  it("creates a forum topic with a listed item plugin without requiring a linked foreign key", async () => {
    const db = makeRecordingDb();
    const api = createForumApi(makeDeps());
    const result = await api.createForumTopic({
      env: { DB: db },
      request: new Request("https://portal.test/api/forum/topics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Question about Workspace LLM Wiki Finance",
          categorySlug: "platform-help",
          topicType: "question",
          contentPlugins: [{
            actionLabel: "View details",
            category: "Knowledge",
            description: "Maintain an internal finance LLM wiki covering model concepts.",
            iconUrl: "/assets/skill.png",
            installs: 42,
            owner: "AI Adoption",
            pluginType: "app_card",
            targetId: "skill-finance",
            targetType: "skill",
            title: "Workspace LLM Wiki Finance"
          }]
        })
      })
    });

    assert.equal(typeof result.id, "string");
    assert.equal(result.discussion.id, result.id);
    assert.equal(result.discussion.title, "Question about Workspace LLM Wiki Finance");
    assert.equal(db.state.batches.length, 1);

    const topicInsert = db.state.batches[0].find((statement) => statement.sql.includes("INSERT INTO forum_topics"));
    assert.equal(topicInsert.bindings[6], "question");
    assert.equal(topicInsert.bindings[8], null);

    const pluginInsert = db.state.batches[0].find((statement) => statement.sql.includes("INSERT INTO forum_content_plugins"));
    assert.equal(pluginInsert.bindings[3], "app_card");
    assert.equal(pluginInsert.bindings[4], "skill");
    assert.equal(pluginInsert.bindings[5], "skill-finance");
    const pluginConfig = JSON.parse(pluginInsert.bindings[6]);
    assert.equal(pluginConfig.actionLabel, "View details");
    assert.equal(pluginConfig.category, "Knowledge");
    assert.equal(pluginConfig.description, "Maintain an internal finance LLM wiki covering model concepts.");
    assert.equal(pluginConfig.iconUrl, "/assets/skill.png");
    assert.equal(pluginConfig.installs, 42);
    assert.equal(pluginConfig.owner, "AI Adoption");
    assert.equal(pluginConfig.title, "Workspace LLM Wiki Finance");
  });

  it("stores an anonymous topic persona while retaining the real author only in protected columns", async () => {
    const db = makeRecordingDb();
    const events = [];
    const api = createForumApi(makeDeps({
      emitActivityEvent: async (_db, event) => events.push(event)
    }));

    await api.createForumTopic({
      env: { DB: db },
      request: new Request("https://portal.test/api/forum/topics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          anonymous: true,
          anonymousPersona: "rising-finch",
          body: "An anonymous question",
          categorySlug: "platform-help",
          title: "Private question"
        })
      })
    });

    const topicInsert = db.state.batches[0].find((statement) => statement.sql.includes("INSERT INTO forum_topics"));
    const rootPostInsert = db.state.batches[0].find((statement) => statement.sql.includes("INSERT INTO forum_posts"));
    assert.equal(topicInsert.bindings[2], "user-1");
    assert.equal(topicInsert.bindings[3], 1);
    assert.equal(topicInsert.bindings[4], "rising-finch");
    assert.equal(rootPostInsert.bindings[2], "user-1");
    assert.equal(rootPostInsert.bindings[3], 1);
    assert.equal(rootPostInsert.bindings[4], "rising-finch");
    assert.equal(events[0].actor.id, "");
    assert.equal(events[0].actor.email, "");
    assert.equal(events[0].actor.name, "Rising Finch");
    assert.equal(events[0].actor.avatarUrl, "/assets/forum-anonymous/rising-finch.png");
  });

  it("rejects an anonymous topic with an unknown persona", async () => {
    const api = createForumApi(makeDeps());

    await assert.rejects(
      () => api.createForumTopic({
        env: { DB: makeRecordingDb() },
        request: new Request("https://portal.test/api/forum/topics", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            anonymous: true,
            anonymousPersona: "secret-sixth-animal",
            body: "Anonymous question",
            categorySlug: "platform-help",
            title: "Private question"
          })
        })
      }),
      (error) => error.status === 400 && error.message === "invalid_forum_anonymous_persona"
    );
  });

  it("reads one forum topic by its decoded canonical id", async () => {
    const db = makeRecordingDb({ title: "Pinned topic" });
    const api = createForumApi(makeDeps());
    const result = await api.getForumTopic({
      env: { DB: db },
      request: new Request("https://portal.test/api/forum/topics/topic%20one")
    }, "topic%20one");

    assert.equal(result.discussion.id, "topic one");
    assert.equal(result.discussion.title, "Pinned topic");
    const topicRead = db.state.statements.find((statement) => statement.sql.includes("root_posts.id AS rootPostId"));
    assert.deepEqual(topicRead.bindings, ["user-1", "user-1", "user-1", "topic one"]);
  });

  it("returns 404 when a canonical forum topic does not exist", async () => {
    const api = createForumApi(makeDeps());

    await assert.rejects(
      () => api.getForumTopic({
        env: { DB: makeRecordingDb({ topicFound: false }) },
        request: new Request("https://portal.test/api/forum/topics/missing")
      }, "missing"),
      (error) => error.status === 404 && error.message === "forum_topic_not_found"
    );
  });
});

function makeRecordingDb(options = {}) {
  const state = {
    batches: [],
    statements: []
  };

  return {
    state,
    prepare(sql) {
      return {
        bind(...bindings) {
          const statement = {
            bindings,
            sql,
            async all() {
              if (sql.includes("root_posts.id AS rootPostId") && sql.includes("FROM forum_topics")) {
                if (options.topicFound === false) {
                  return { results: [] };
                }

                const topicId = bindings[3];
                const topicInsert = state.batches.flat().find((candidate) => candidate.sql.includes("INSERT INTO forum_topics"));
                const rootPostInsert = state.batches.flat().find((candidate) => candidate.sql.includes("INSERT INTO forum_posts"));
                return {
                  results: [{
                    id: topicId,
                    rootPostId: rootPostInsert?.bindings[0] ?? "post-root",
                    title: options.title ?? topicInsert?.bindings[5] ?? "Forum topic",
                    authorId: "user-1",
                    author: "Ada",
                    authorEmail: "ada@example.com",
                    category: "Platform help",
                    tags: "",
                    replies: 0,
                    views: 0,
                    likes: 0,
                    lastActive: "2026-07-23T00:00:00Z",
                    excerpt: "Forum topic",
                    body: "Forum topic"
                  }]
                };
              }

              return { results: [] };
            },
            async first() {
              if (sql.includes("FROM forum_categories")) {
                return { id: "cat-platform-help" };
              }

              if (sql.includes("FROM users")) {
                return { teamId: "team-1" };
              }

              return null;
            }
          };
          state.statements.push(statement);
          return statement;
        }
      };
    },
    async batch(statements) {
      state.batches.push(statements);
      return statements.map(() => ({ success: true }));
    }
  };
}
