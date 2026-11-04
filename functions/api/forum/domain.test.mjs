import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultForumCategoryIdForTopicType, normalizeForumCategorySlug } from "./categories.ts";
import { mentionRecipientUserIds, parseMentionPrefixes, resolveMentionTargets } from "./mentions.ts";
import {
  appendForumAttachmentInserts,
  appendForumMentionInserts,
  forumPostSideEffectDeleteStatements,
  readForumAttachmentStorageKeys
} from "./postWrites.ts";
import { forumReactionSummary } from "./reactions.ts";

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

describe("forum domain helpers", () => {
  it("normalizes forum category aliases into canonical slugs", () => {
    assert.equal(normalizeForumCategorySlug("AI 应用探索"), "ai-exploration");
    assert.equal(normalizeForumCategorySlug("MCP & Data Services"), "platform-help");
    assert.equal(normalizeForumCategorySlug("杂谈闲聊"), "off-topic");
    assert.equal(normalizeForumCategorySlug("unknown"), undefined);
  });

  it("prefers topic-type category defaults and falls back to the first category", async () => {
    const slugDb = {
      prepare(sql) {
        return {
          bind(slug) {
            return {
              async first() {
                if (sql.includes("WHERE slug = ?") && slug === "platform-help") {
                  return { id: "cat-help" };
                }
                return null;
              }
            };
          },
          async first() {
            return { id: "cat-default" };
          }
        };
      }
    };

    assert.equal(await defaultForumCategoryIdForTopicType(slugDb, "help", { httpError }), "cat-help");
    assert.equal(await defaultForumCategoryIdForTopicType(slugDb, "showcase", { httpError }), "cat-default");
  });

  it("extracts unique mention prefixes and resolves only unambiguous users", async () => {
    assert.deepEqual(parseMentionPrefixes("Hi @Ada. @bob-b @Ada @UPPER_name!"), ["ada", "bob-b", "ada", "upper_name"]);
    assert.deepEqual(parseMentionPrefixes("Email ada@example.com, then notify (@Grace) and ：@Lin."), ["grace", "lin"]);

    const db = {
      prepare() {
        return {
          bind(prefix) {
            return {
              async all() {
                if (prefix === "ada") {
                  return { results: [{ id: "user-1" }] };
                }
                if (prefix === "bob-b") {
                  return { results: [{ id: "user-2" }, { id: "user-3" }] };
                }
                return { results: [] };
              }
            };
          }
        };
      }
    };

    assert.deepEqual(await resolveMentionTargets(db, ["ada", "bob-b", "ada", "missing"]), [
      { userId: "user-1", text: "@ada" }
    ]);
  });

  it("resolves an invited directory user and provisions a minimal Portal mention identity", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl;
    let portalUser;
    let insertedValues;

    globalThis.fetch = async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify({
        users: [
          {
            email: "invited.user@example.com",
            id: "auth-invited-user",
            name: "Invited User",
            status: "invited"
          },
          {
            email: "invited.user@example.com",
            id: "auth-inactive-user",
            name: "Inactive User",
            status: "inactive"
          }
        ]
      }), { headers: { "content-type": "application/json" } });
    };

    const db = {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async first() {
                if (/SELECT id\s+FROM users/i.test(sql)) return portalUser;
                return undefined;
              },
              async run() {
                if (/INSERT OR IGNORE INTO users/i.test(sql)) {
                  insertedValues = values;
                  portalUser = { id: values[0] };
                }
                return { success: true };
              }
            };
          }
        };
      }
    };

    try {
      const mentions = await resolveMentionTargets(db, ["invited.user"], {
        AUTH_SERVICE_TOKEN: "service-token",
        AUTH_WORKER_URL: "https://auth.example.com",
        DEFAULT_TEAM_ID: "team-company"
      });

      assert.deepEqual(requestedUrl.searchParams.getAll("status"), ["active", "invited"]);
      assert.deepEqual(mentions, [{ userId: "auth-invited-user", text: "@invited.user" }]);
      assert.deepEqual(insertedValues, [
        "auth-invited-user",
        "Invited User",
        "invited.user@example.com",
        "invited",
        "team-company"
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("builds a de-duplicated Live recipient list without the actor", () => {
    assert.deepEqual(mentionRecipientUserIds([
      { userId: "user-1" },
      { userId: "user-2" },
      { userId: "user-2" },
      { userId: "  " }
    ], "user-1"), ["user-2"]);
    assert.deepEqual(mentionRecipientUserIds([
      { userId: "user-2" },
      { userId: "user-3" }
    ], "user-1", ["user-2"]), ["user-3"]);
  });

  it("summarizes reactions with normalized reaction names", async () => {
    const db = {
      prepare() {
        return {
          bind(postId) {
            assert.equal(postId, "post-1");
            return {
              async all() {
                return {
                  results: [
                    { reaction: "heart", count: "2" },
                    { reaction: "unsupported", count: 1 }
                  ]
                };
              }
            };
          }
        };
      }
    };

    assert.deepEqual(await forumReactionSummary(db, "post-1"), [
      { reaction: "heart", count: 2 },
      { reaction: "thumbsup", count: 1 }
    ]);
  });

  it("builds forum attachment insert statements with stable binding order", () => {
    const { db, statements } = recordingDb();
    const batch = [];

    appendForumAttachmentInserts(batch, db, {
      attachments: [{
        storageProvider: "r2",
        storageKey: "forum/2026/07/file.png",
        publicUrl: "/api/forum/media/forum%2F2026%2F07%2Ffile.png",
        mimeType: "image/png",
        fileName: "file.png",
        fileSize: 123
      }],
      ownerUserId: "user-1",
      postId: "post-1",
      topicId: "topic-1"
    });

    assert.equal(batch.length, 1);
    assert.match(statements[0].sql, /INSERT INTO forum_attachments/);
    assert.deepEqual(statements[0].values.slice(1), [
      "topic-1",
      "post-1",
      "user-1",
      "r2",
      "forum/2026/07/file.png",
      "/api/forum/media/forum%2F2026%2F07%2Ffile.png",
      "image/png",
      "file.png",
      123,
      1
    ]);
  });

  it("builds mention notifications only for other users", () => {
    const { db, statements } = recordingDb();
    const batch = [];

    appendForumMentionInserts(batch, db, {
      actorUserId: "user-1",
      mentions: [
        { userId: "user-1", text: "@ada" },
        { userId: "user-2", text: "@grace" }
      ],
      notifyMentionedUsers: true,
      postId: "post-1",
      topicId: "topic-1"
    });

    assert.equal(batch.length, 3);
    assert.match(statements[0].sql, /INSERT INTO forum_mentions/);
    assert.match(statements[1].sql, /INSERT INTO forum_mentions/);
    assert.match(statements[2].sql, /INSERT OR IGNORE INTO notifications/);
    assert.deepEqual(statements[0].values.slice(1), ["topic-1", "post-1", "user-1", "@ada", "user-1"]);
    assert.deepEqual(statements[1].values.slice(1), ["topic-1", "post-1", "user-2", "@grace", "user-1"]);
    assert.deepEqual(statements[2].values.slice(1, 8), ["user-2", "user-1", "forum.mention", "forum_post", "post-1", "forum_topic", "topic-1"]);
  });

  it("persists English mention text while preserving user-authored titles", () => {
    const { db, statements } = recordingDb();
    appendForumMentionInserts([], db, {
      defaultLocale: "en", actorUserId: "user-1", actorName: "Ada",
      mentions: [{ userId: "user-2", text: "@grace" }], notifyMentionedUsers: true,
      postId: "post-1", topicId: "topic-1", topicTitle: "项目计划"
    });
    assert.ok(statements[1].values.includes('Ada mentioned you in "项目计划"'));
  });

  it("notifies only newly added mention recipients during an edit", () => {
    const { db, statements } = recordingDb();
    const batch = [];

    appendForumMentionInserts(batch, db, {
      actorUserId: "user-1",
      mentions: [
        { userId: "user-2", text: "@grace" },
        { userId: "user-3", text: "@lin" }
      ],
      notificationUserIds: ["user-3"],
      postId: "post-1",
      topicId: "topic-1"
    });

    assert.equal(batch.length, 3);
    assert.equal(statements.filter((statement) => /INSERT OR IGNORE INTO notifications/.test(statement.sql)).length, 1);
    assert.deepEqual(statements[2].values.slice(1, 8), ["user-3", "user-1", "forum.mention", "forum_post", "post-1", "forum_topic", "topic-1"]);
  });

  it("reads attachment storage keys and builds post side-effect deletes", async () => {
    const { db, statements } = recordingDb({
      allResults: [
        { storageKey: "forum/2026/07/a.png" },
        { storageKey: "" },
        { storageKey: "forum/2026/07/b.png" }
      ]
    });

    assert.deepEqual(await readForumAttachmentStorageKeys(db, "topic-1", "post-1"), [
      "forum/2026/07/a.png",
      "forum/2026/07/b.png"
    ]);

    const deletes = forumPostSideEffectDeleteStatements(db, "topic-1", "post-1");

    assert.equal(deletes.length, 7);
    assert.match(statements.at(-1).sql, /DELETE FROM forum_post_likes/);
    assert.deepEqual(statements.at(-1).values, ["post-1"]);
  });
});

function recordingDb(options = {}) {
  const statements = [];

  return {
    statements,
    db: {
      prepare(sql) {
        return {
          bind(...values) {
            const statement = {
              sql,
              values,
              async all() {
                return { results: options.allResults ?? [] };
              }
            };
            statements.push(statement);
            return statement;
          }
        };
      }
    }
  };
}
