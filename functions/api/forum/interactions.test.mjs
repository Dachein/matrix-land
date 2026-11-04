import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createForumApi } from "./service.ts";

describe("forum interaction contracts", () => {
  it("publishes a topic mention to notifications and Live recipients", async () => {
    const { db, state } = interactionDb();
    const events = [];
    const refreshedUserIds = [];
    const api = createForumApi(makeDeps(events, {
      refreshUserJourneyState: async (_db, userId) => {
        refreshedUserIds.push(userId);
      }
    }));
    const result = await api.createForumTopic(context(db, "/api/forum/topics", {
      body: "Please review @grace",
      categorySlug: "ai-exploration",
      title: "Mention contract"
    }));

    assert.ok(result.id);
    assert.equal(state.batches.length, 1);
    assert.equal(state.batches[0].filter((statement) => statement.sql.includes("INSERT OR IGNORE INTO notifications")).length, 1);
    assert.deepEqual(events[0].metadata.mentionedUserIds, ["user-grace"]);
    assert.equal(events[0].actionType, "forum.topic.created");
    assert.deepEqual(refreshedUserIds, ["user-ada"]);
  });

  it("publishes anonymous topic activity with only the selected public persona", async () => {
    const { db } = interactionDb();
    const events = [];
    const api = createForumApi(makeDeps(events));
    await api.createForumTopic(context(db, "/api/forum/topics", {
      anonymous: true,
      anonymousPersona: "morning-owl",
      body: "A private question with a public anonymous identity",
      categorySlug: "ai-exploration",
      title: "Anonymous activity contract"
    }));

    assert.equal(events[0].actionType, "forum.topic.created");
    assert.equal(events[0].actor.id, "");
    assert.equal(events[0].actor.email, "");
    assert.equal(events[0].actor.team, "");
    assert.equal(events[0].actor.name, "Morning Owl");
    assert.equal(events[0].actor.avatarUrl, "/assets/forum-anonymous/morning-owl.png");
    assert.equal(events[0].metadata.anonymous, true);
    assert.equal(events[0].metadata.anonymousPersona, "morning-owl");
    assert.match(events[0].summary, /^Morning Owl /);
  });

  it("publishes a reply mention to notifications and Live recipients", async () => {
    const { db, state } = interactionDb({ topicAuthorId: "user-grace" });
    const events = [];
    const refreshedUserIds = [];
    const api = createForumApi(makeDeps(events, {
      refreshUserJourneyState: async (_db, userId) => {
        refreshedUserIds.push(userId);
      }
    }));
    const result = await api.createForumReply(context(db, "/api/forum/topics/topic-1/replies", {
      body: "Acknowledged @grace"
    }), "topic-1");

    assert.ok(result.id);
    assert.equal(state.batches.length, 1);
    assert.equal(state.batches[0].filter((statement) => statement.sql.includes("INSERT OR IGNORE INTO notifications")).length, 1);
    assert.deepEqual(events[0].metadata.mentionedUserIds, ["user-grace"]);
    assert.equal(events[0].actionType, "forum.reply.created");
    assert.equal(events[0].href, "#/community/topic-1");
    assert.deepEqual(refreshedUserIds, ["user-ada", "user-grace"]);
  });

  it("notifies the topic author for an ordinary reply", async () => {
    const { db, state } = interactionDb({ topicAuthorId: "user-owner" });
    const events = [];
    const api = createForumApi(makeDeps(events));
    await api.createForumReply(context(db, "/api/forum/topics/topic-1/replies", {
      body: "A plain reply"
    }), "topic-1");

    const notificationWrites = state.batches[0].filter((statement) => statement.sql.includes("INSERT OR IGNORE INTO notifications"));
    assert.equal(notificationWrites.length, 1);
    assert.equal(notificationWrites[0].bindings[1], "user-owner");
    assert.equal(notificationWrites[0].bindings[3], "forum.thread_replied");
  });

  it("reuses one anonymous persona for the same user throughout a topic", async () => {
    const { db, state } = interactionDb({
      existingAnonymousPersona: "morning-lark",
      topicAuthorId: "user-owner"
    });
    const events = [];
    const api = createForumApi(makeDeps(events));
    const result = await api.createForumReply(context(db, "/api/forum/topics/topic-1/replies", {
      anonymous: true,
      anonymousPersona: "curious-fox",
      body: "An anonymous follow-up"
    }), "topic-1");

    assert.equal(result.anonymous, true);
    assert.equal(result.anonymousPersona, "morning-lark");
    const replyInsert = state.batches[0].find((statement) => statement.sql.includes("INSERT INTO forum_posts"));
    assert.equal(replyInsert.bindings[2], "user-ada");
    assert.equal(replyInsert.bindings[3], 1);
    assert.equal(replyInsert.bindings[4], "morning-lark");

    const notification = state.batches[0].find((statement) => statement.sql.includes("INSERT OR IGNORE INTO notifications"));
    assert.equal(notification.bindings[2], "");
    assert.match(notification.bindings[8], /^Morning Lark /);
    assert.equal(events[0].actor.id, "");
    assert.equal(events[0].actor.email, "");
    assert.equal(events[0].actor.name, "Morning Lark");
  });

  it("removes only deselected reply attachments during an edit", async () => {
    const { db, state } = interactionDb({
      attachments: [
        { id: "attachment-1", storageKey: "forum/2026/07/one.png" },
        { id: "attachment-2", storageKey: "forum/2026/07/two.png" }
      ]
    });
    const deletedStorageKeys = [];
    const events = [];
    const api = createForumApi(makeDeps(events));
    const requestContext = context(db, "/api/forum/topics/topic-1/replies/reply-1", {
      body: "Updated reply",
      retainedAttachmentIds: ["forum/2026/07/two.png"]
    });
    requestContext.env.FORUM_MEDIA = {
      delete: async (storageKey) => deletedStorageKeys.push(storageKey)
    };

    const result = await api.updateForumReply(requestContext, "topic-1", "reply-1");

    assert.equal(result.updated, true);
    const attachmentDeletes = state.batches[0].filter((statement) => statement.sql.includes("DELETE FROM forum_attachments"));
    assert.equal(attachmentDeletes.length, 1);
    assert.deepEqual(attachmentDeletes[0].bindings, ["attachment-1", "topic-1", "reply-1"]);
    assert.deepEqual(deletedStorageKeys, ["forum/2026/07/one.png"]);
  });

  it("adds and removes topic attachments during an edit", async () => {
    const { db, state } = interactionDb({
      attachments: [
        { id: "attachment-1", storageKey: "forum/2026/07/one.png", displayOrder: 1 },
        { id: "attachment-2", storageKey: "forum/2026/07/two.png", displayOrder: 2 }
      ]
    });
    const deletedStorageKeys = [];
    const api = createForumApi(makeDeps([]));
    const requestContext = context(db, "/api/forum/topics/topic-1", {
      title: "Updated topic",
      body: "Updated body",
      retainedAttachmentIds: ["attachment-2"],
      attachments: [{
        storageProvider: "r2",
        storageKey: "forum/2026/07/three.png",
        publicUrl: "/api/forum/media/forum/2026/07/three.png",
        mimeType: "image/png",
        fileName: "three.png",
        fileSize: 300
      }]
    });
    requestContext.env.FORUM_MEDIA = {
      delete: async (storageKey) => deletedStorageKeys.push(storageKey)
    };

    const result = await api.updateForumTopic(requestContext, "topic-1");

    assert.equal(result.updated, true);
    const attachmentDeletes = state.batches[0].filter((statement) => statement.sql.includes("DELETE FROM forum_attachments"));
    assert.equal(attachmentDeletes.length, 1);
    assert.deepEqual(attachmentDeletes[0].bindings, ["attachment-1", "topic-1", "root-1"]);
    const attachmentInserts = state.batches[0].filter((statement) => statement.sql.includes("INSERT INTO forum_attachments"));
    assert.equal(attachmentInserts.length, 1);
    assert.equal(attachmentInserts[0].bindings[5], "forum/2026/07/three.png");
    assert.equal(attachmentInserts[0].bindings[10], 3);
    assert.deepEqual(deletedStorageKeys, ["forum/2026/07/one.png"]);
  });

  it("adds inline file attachments during a reply edit", async () => {
    const { db, state } = interactionDb({
      attachments: [{ id: "attachment-1", storageKey: "forum/2026/07/one.png", displayOrder: 1 }]
    });
    const api = createForumApi(makeDeps([]));
    const result = await api.updateForumReply(context(db, "/api/forum/topics/topic-1/replies/reply-1", {
      body: "Updated reply\n\n[guide.pdf](/api/forum/media/forum/2026/08/guide.pdf)",
      retainedAttachmentIds: ["attachment-1"],
      attachments: [{
        storageProvider: "r2",
        storageKey: "forum/2026/08/guide.pdf",
        publicUrl: "/api/forum/media/forum/2026/08/guide.pdf",
        mimeType: "application/pdf",
        fileName: "guide.pdf",
        fileSize: 300
      }]
    }), "topic-1", "reply-1");

    assert.equal(result.updated, true);
    const attachmentInserts = state.batches[0].filter((statement) => statement.sql.includes("INSERT INTO forum_attachments"));
    assert.equal(attachmentInserts.length, 1);
    assert.equal(attachmentInserts[0].bindings[5], "forum/2026/08/guide.pdf");
    assert.equal(attachmentInserts[0].bindings[10], 2);
  });

  it("persists and projects topic reactions", async () => {
    const { db, state } = interactionDb();
    const events = [];
    const api = createForumApi(makeDeps(events));
    const result = await api.setForumTopicLike(context(db, "/api/forum/topics/topic-1/like", {
      reaction: "heart"
    }), "topic-1", true);

    assert.equal(result.liked, true);
    assert.equal(result.reaction, "heart");
    assert.deepEqual(result.reactions, [{ count: 1, reaction: "heart" }]);
    assert.ok(state.runs.some((statement) => statement.sql.includes("INSERT INTO forum_post_likes")));
    assert.equal(events[0].actionType, "forum.reaction.created");
  });

  it("refreshes the topic author's Journey after a new reaction", async () => {
    const { db } = interactionDb();
    const refreshedUserIds = [];
    const api = createForumApi(makeDeps([], {
      refreshUserJourneyState: async (_db, userId) => {
        refreshedUserIds.push(userId);
      }
    }));

    await api.setForumTopicLike(context(db, "/api/forum/topics/topic-1/like", {
      reaction: "heart"
    }), "topic-1", true);

    assert.deepEqual(refreshedUserIds, ["user-owner"]);
  });

  it("persists and projects reply reactions", async () => {
    const { db, state } = interactionDb();
    const events = [];
    const api = createForumApi(makeDeps(events));
    const result = await api.setForumReplyLike(context(db, "/api/forum/topics/topic-1/replies/reply-1/like", {
      reaction: "tada"
    }), "topic-1", "reply-1", true);

    assert.equal(result.liked, true);
    assert.equal(result.reaction, "tada");
    assert.deepEqual(result.reactions, [{ count: 1, reaction: "tada" }]);
    assert.ok(state.runs.some((statement) => statement.sql.includes("INSERT INTO forum_post_likes")));
    assert.equal(events[0].target.id, "reply-1");
  });

  it("lets a community admin pin topics and rejects ordinary members", async () => {
    const { db, state } = interactionDb();
    const events = [];
    const adminApi = createForumApi(makeDeps(events, {
      resolveCurrentUser: async () => ({
        email: "moderator@example.test",
        id: "user-moderator",
        name: "Moderator",
        role: "member",
        roles: ["community_admin"]
      })
    }));

    const result = await adminApi.setForumTopicPinned(context(db, "/api/forum/topics/topic-1/pin", {}), "topic-1", true);
    assert.equal(result.pinned, true);
    assert.ok(state.runs.some((statement) => statement.sql.includes("SET is_pinned = 1")));

    const memberApi = createForumApi(makeDeps(events));
    await assert.rejects(
      () => memberApi.setForumTopicPinned(context(db, "/api/forum/topics/topic-1/pin", {}), "topic-1", true),
      (error) => error.status === 403 && error.message === "community_admin_required"
    );
  });

  it("uses the canonical community-admin assignment for writes and does not allow platform admins", async () => {
    const canonicalDb = interactionDb({ communityAdminUserId: "user-moderator" }).db;
    const canonicalApi = createForumApi(makeDeps([], {
      resolveCurrentUser: async () => ({
        id: "user-moderator",
        name: "Moderator",
        role: "member",
        roles: []
      })
    }));

    const result = await canonicalApi.setForumTopicPinned(
      context(canonicalDb, "/api/forum/topics/topic-1/pin", {}),
      "topic-1",
      true
    );
    assert.equal(result.pinned, true);

    const platformAdminApi = createForumApi(makeDeps([], {
      resolveCurrentUser: async () => ({
        id: "user-platform-admin",
        name: "Platform Admin",
        role: "admin",
        roles: ["admin"]
      })
    }));
    await assert.rejects(
      () => platformAdminApi.setForumTopicPinned(
        context(interactionDb().db, "/api/forum/topics/topic-1/pin", {}),
        "topic-1",
        true
      ),
      (error) => error.status === 403 && error.message === "community_admin_required"
    );
  });

  it("lets a community admin add a tiered Contribution Post tag with a public note", async () => {
    const { db, state } = interactionDb();
    const audits = [];
    const events = [];
    const refreshedUserIds = [];
    const api = createForumApi(makeDeps(events, {
      audit: async (...args) => {
        audits.push(args);
        return "audit-contributor";
      },
      refreshUserJourneyState: async (_db, userId) => {
        refreshedUserIds.push(userId);
        return {
          journeyBadgeCount: 3,
          journeyCommunityContributionPoints: 80,
          journeyLevelKey: "contributor",
          journeyTotalPoints: 230
        };
      },
      resolveCurrentUser: async () => ({
        email: "moderator@example.test",
        id: "user-moderator",
        name: "Moderator",
        role: "member",
        roles: ["community_admin"]
      })
    }));

    const result = await api.awardForumReplyContributor(context(db, "/api/forum/topics/topic-1/replies/reply-1/contributor-award", {
      note: "A concrete answer the whole team can reuse.",
      points: 30
    }), "topic-1", "reply-1");

    assert.equal(result.award.points, 30);
    assert.equal(result.award.note, "A concrete answer the whole team can reuse.");
    assert.equal(result.recipientUserId, "user-ada");
    assert.equal(result.journeyCommunityContributionPoints, 80);
    assert.equal(result.journeyTotalPoints, 230);
    assert.deepEqual(refreshedUserIds, ["user-ada"]);
    const writes = state.batches.at(-1);
    assert.equal(writes.filter((statement) => statement.sql.includes("INSERT INTO forum_contributor_awards")).length, 1);
    assert.equal(writes.filter((statement) => statement.sql.includes("INSERT OR IGNORE INTO portal_user_badges")).length, 0);
    assert.equal(writes.filter((statement) => statement.sql.includes("INSERT OR IGNORE INTO notifications")).length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].actionType, "forum.contribution.awarded");
    assert.equal(events[0].actor.id, "user-ada");
    assert.equal(events[0].summary, "user-ada 获得了社区贡献（+30）：A concrete answer the whole team can reuse.");
    assert.equal(events[0].metadata.note, "A concrete answer the whole team can reuse.");
    assert.equal(events[0].metadata.points, 30);
    assert.equal(events[0].href, "#/community/topic-1");
    assert.equal(audits[0][3], "tagged forum contribution");
  });

  it("accepts a custom Contribution Post point value", async () => {
    const { db, state } = interactionDb();
    const api = createForumApi(makeDeps([], {
      resolveCurrentUser: async () => ({
        id: "user-moderator",
        name: "Moderator",
        role: "member",
        roles: ["community_admin"]
      })
    }));

    const result = await api.awardForumTopicContributor(context(db, "/api/forum/topics/topic-1/contributor-award", {
      note: "Useful custom contribution.",
      points: 40
    }), "topic-1");

    assert.equal(result.award.points, 40);
    assert.equal(state.batches.at(-1).filter((statement) => statement.sql.includes("INSERT INTO forum_contributor_awards")).length, 1);
  });

  it("rejects a Contribution Post point value outside the custom range", async () => {
    const api = createForumApi(makeDeps([], {
      resolveCurrentUser: async () => ({
        id: "user-moderator",
        name: "Moderator",
        role: "member",
        roles: ["community_admin"]
      })
    }));

    await assert.rejects(
      () => api.awardForumTopicContributor(context(interactionDb().db, "/api/forum/topics/topic-1/contributor-award", {
        note: "Useful, but invalid range.",
        points: 101
      }), "topic-1"),
      (error) => error.status === 400 && error.message === "invalid_forum_contributor_award_points"
    );
  });

  it("rejects duplicate Contributor awards and non-moderators", async () => {
    const duplicateDb = interactionDb({ existingContributorAward: true }).db;
    const adminApi = createForumApi(makeDeps([], {
      resolveCurrentUser: async () => ({
        id: "user-moderator",
        name: "Moderator",
        role: "member",
        roles: ["community_admin"]
      })
    }));

    await assert.rejects(
      () => adminApi.awardForumTopicContributor(context(duplicateDb, "/api/forum/topics/topic-1/contributor-award", { note: "Again" }), "topic-1"),
      (error) => error.status === 409 && error.message === "forum_contributor_award_exists"
    );

    const memberApi = createForumApi(makeDeps([]));
    await assert.rejects(
      () => memberApi.awardForumTopicContributor(context(interactionDb().db, "/api/forum/topics/topic-1/contributor-award", { note: "Not allowed" }), "topic-1"),
      (error) => error.status === 403 && error.message === "community_admin_required"
    );
  });

  it("prevents a community admin from awarding their own post", async () => {
    const api = createForumApi(makeDeps([], {
      resolveCurrentUser: async () => ({
        email: "ada@example.test",
        id: "user-ada",
        name: "Ada",
        role: "member",
        roles: ["community_admin"]
      })
    }));

    await assert.rejects(
      () => api.awardForumTopicContributor(context(interactionDb().db, "/api/forum/topics/topic-1/contributor-award", {
        note: "Self award must not be allowed.",
        points: 10
      }), "topic-1"),
      (error) => error.status === 400 && error.message === "forum_contributor_self_award_not_allowed"
    );
  });

  it("sends a contributor award email after the request completes", async () => {
    const { scheduleContributorAwardEmail } = await import("./contributorAwardEmail.ts");
    const requests = [];
    let deferred;
    const requestContext = context(interactionDb().db, "/api/forum/topics/topic-1/contributor-award", {});
    requestContext.env.AUTH_WORKER_URL = "https://auth.example.test";
    requestContext.env.PORTAL_AUTH_SERVICE_TOKEN = "portal-auth-token";
    requestContext.env.PORTAL_EMAIL_FROM = "community@example.test";
    requestContext.env.PORTAL_URL = "https://ai.example.test";
    requestContext.waitUntil = (promise) => {
      deferred = promise;
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      requests.push({ init, url });
      return new Response(JSON.stringify({ sent: true }), { status: 202 });
    };

    try {
      assert.equal(scheduleContributorAwardEmail(requestContext, {
        currentUser: { id: "user-admin", name: "Billy Fung" },
        note: "修复重大缺陷",
        points: 40,
        target: {
          recipientEmail: "ada@example.test",
          recipientName: "Ada",
          recipientStatus: "active",
          recipientUserId: "user-ada",
          topicId: "topic-1",
          topicTitle: "模型调用报错排查"
        }
      }), true);
      await deferred;
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "https://auth.example.test/v1/notifications/email");
      assert.equal(requests[0].init.headers.Authorization, "Bearer portal-auth-token");
      const payload = JSON.parse(requests[0].init.body);
      assert.equal(payload.to, "ada@example.test");
      assert.equal(payload.subject, "[Matrix land] 你获得了社区贡献 · 模型调用报错排查");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function context(db, path, body) {
  return {
    env: { DB: db, DEFAULT_TEAM_ID: "team-1" },
    request: new Request(`https://portal.test${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    })
  };
}

function makeDeps(events, overrides = {}) {
  return {
    audit: async () => "audit-1",
    currentUserTeamId: async () => "team-1",
    emitActivityEvent: async (_db, event) => events.push(event),
    excerpt: (value) => String(value).slice(0, 180),
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    readBody: (request) => request.json(),
    refreshUserJourneyState: async () => undefined,
    requireDb: (db) => db,
    requireText(value, errorCode, maxLength) {
      const text = String(value ?? "").trim();
      if (!text) throw Object.assign(new Error(errorCode), { status: 400 });
      return text.slice(0, maxLength);
    },
    resolveCurrentUser: async () => ({
      email: "ada@example.test",
      id: "user-ada",
      name: "Ada",
      role: "member",
      team: "AI Adoption"
    }),
    sanitizeTags: (value) => Array.isArray(value) ? value : [],
    userProfileColumns: async () => ({}),
    ...overrides
  };
}

function interactionDb(options = {}) {
  const state = {
    batches: [],
    currentReaction: "",
    runs: [],
    statements: []
  };

  const db = {
    state,
    prepare(sql) {
      return {
        bind(...bindings) {
          const statement = {
            bindings,
            sql,
            async all() {
              if (sql.includes("root_posts.id AS rootPostId") && sql.includes("FROM forum_topics")) {
                const topicInsert = state.batches.flat().find((candidate) => candidate.sql.includes("INSERT INTO forum_topics"));
                const rootPostInsert = state.batches.flat().find((candidate) => candidate.sql.includes("INSERT INTO forum_posts"));
                return {
                  results: [{
                    id: bindings[3],
                    rootPostId: rootPostInsert?.bindings[0] ?? "root-1",
                    title: topicInsert?.bindings[5] ?? "Forum topic",
                    authorId: "user-ada",
                    author: "Ada",
                    authorEmail: "ada@example.test",
                    category: "AI exploration",
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

              if (sql.includes("storage_key AS storageKey")) {
                return { results: options.attachments ?? [] };
              }
              if (sql.includes("FROM users") && sql.includes("lower(substr(email")) {
                return { results: [{ id: "user-grace" }] };
              }
              if (sql.includes("GROUP BY COALESCE(reaction")) {
                return state.currentReaction
                  ? { results: [{ count: 1, reaction: state.currentReaction }] }
                  : { results: [] };
              }
              return { results: [] };
            },
            async first() {
              if (sql.includes("FROM user_roles") && sql.includes("role = 'community_admin'")) {
                return bindings[0] === options.communityAdminUserId ? { assigned: 1 } : null;
              }
              if (sql.includes("AS recipientUserId") && !sql.includes("FROM forum_contributor_awards")) {
                const isReply = sql.includes("forum_posts.id = ?");
                return {
                  postId: isReply ? "reply-1" : "root-1",
                  recipientUserId: "user-ada",
                  topicId: "topic-1",
                  topicTitle: "Forum topic"
                };
              }
              if (sql.includes("SELECT id FROM forum_contributor_awards")) {
                return options.existingContributorAward ? { id: "award-existing" } : null;
              }
              if (sql.includes("SELECT anonymous_persona AS anonymousPersona")) {
                return options.existingAnonymousPersona
                  ? { anonymousPersona: options.existingAnonymousPersona }
                  : null;
              }
              if (sql.includes("FROM forum_categories")) {
                return { id: "category-1" };
              }
              if (sql.includes("SELECT team_id AS teamId")) {
                return { teamId: "team-1" };
              }
              if (sql.includes("SELECT id, title FROM forum_topics")) {
                return { id: "topic-1", title: "Forum topic" };
              }
              if (sql.includes("SELECT id FROM forum_topics")) {
                return { id: "topic-1" };
              }
              if (sql.includes("SELECT author_user_id AS authorUserId FROM forum_topics")) {
                return { authorUserId: options.topicAuthorId ?? "user-owner" };
              }
              if (sql.includes("forum_posts.author_user_id AS authorUserId")) {
                return { id: "reply-1", authorUserId: "user-ada", rootPostId: "root-1", topicId: "topic-1" };
              }
              if (sql.includes("forum_topics.author_user_id AS authorUserId")) {
                const isReactionRoot = sql.includes("forum_posts.id AS postId");
                return {
                  id: "topic-1",
                  authorUserId: isReactionRoot ? options.topicAuthorId ?? "user-owner" : "user-ada",
                  rootPostId: "root-1",
                  postId: "root-1",
                  topicTitle: "Forum topic"
                };
              }
              if (sql.includes("forum_posts.id AS postId") && sql.includes("forum_posts.id = ?")) {
                return { postId: "reply-1", rootPostId: "root-1", topicId: "topic-1", topicTitle: "Forum topic" };
              }
              if (sql.includes("forum_posts.id AS postId")) {
                return { postId: "root-1", topicTitle: "Forum topic", authorUserId: "user-owner" };
              }
              if (sql.includes("COUNT(*) AS likes")) {
                return { likes: state.currentReaction ? 1 : 0 };
              }
              return null;
            },
            async run() {
              state.runs.push(statement);
              if (sql.includes("INSERT INTO forum_post_likes")) {
                state.currentReaction = String(bindings[2] ?? "thumbsup");
              }
              if (sql.includes("DELETE FROM forum_post_likes")) {
                state.currentReaction = "";
              }
              return { success: true };
            }
          };
          state.statements.push(statement);
          return statement;
        },
        async first() {
          return null;
        }
      };
    },
    async batch(statements) {
      state.batches.push(statements);
      return statements.map(() => ({ success: true }));
    }
  };

  return { db, state };
}
