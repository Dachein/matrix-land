import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === "ERR_MODULE_NOT_FOUND" && (specifier.startsWith("./") || specifier.startsWith("../"))) {
        return nextResolve(`${specifier}.ts`, context);
      }

      throw error;
    }
  }
});

const { fallbackPortal } = await import("../../../src/shared/fallbackPortal.ts");
const {
  CATALOG_FORUM_TOPIC_LIMIT,
  catalogCoverColumns,
  createCatalogApi,
  hasCatalogContent,
  hasTableColumn,
  readPersistedCurrentUserSummary,
  selectedForumTopicIdsSql,
  userProfileColumns
} = await import("./service.ts");
const { mergeAdminUsers } = await import("../users/adminList.ts");
const { appFromRow, publicationListingFromRow } = await import("./mappers.ts");
const { cacheableCatalogImageUrl, restoreCatalogImageSource, readCatalogImageResponse } = await import("./coverImage.ts");
const { attachPublicationOwnerProfiles, readApps, readCurrentApp, readSkills } = await import("./readModels.ts");
const {
  decodeForumDiscussionCursor,
  encodeForumDiscussionCursor,
  readCatalogDiscussion,
  readCatalogDiscussionPage,
  validForumDiscussionCursor
} = await import("./forumProjection.ts");

const currentUser = {
  ...fallbackPortal.currentUser,
  id: "user-1",
  name: "Ada",
  email: "ada@example.com",
  role: "member"
};

const deps = {
  async currentUserTeamId() {
    return "team-1";
  },
  normalizeIdentityProvider(value) {
    return value === "dingtalk" || value === "generic_oidc" ? value : "microsoft_entra_id";
  },
  normalizeRole(value) {
    return value === "admin" ? "admin" : "member";
  }
};

function makeColumnDb(columnsByTable) {
  return {
    prepare(sql) {
      return {
        async all() {
          const tableName = sql.match(/^PRAGMA table_info\(([^)]+)\)$/)?.[1];
          return {
            results: (columnsByTable[tableName] ?? []).map((name) => ({ name }))
          };
        }
      };
    }
  };
}

function makeCatalogDb() {
  return {
    prepare(sql) {
      if (sql.includes("portal_user_journey_state")) {
        return {
          bind() {
            return {
              async first() {
                return {
                  journeyLevelKey: "newcomer",
                  mcpConnected: 0,
                  tokenApplied: 0
                };
              }
            };
          }
        };
      }

      return {
        async all() {
          if (sql.includes("FROM skill_categories")) {
            return { results: [{ name: "Finance" }, { name: "Research" }] };
          }

          throw new Error(`Unexpected SQL: ${sql}`);
        }
      };
    }
  };
}

function sqliteD1(database, calls = []) {
  return {
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async all() {
              calls.push({ bindings, sql });
              return { results: database.prepare(sql).all(...bindings) };
            },
            async first() {
              calls.push({ bindings, sql });
              return database.prepare(sql).get(...bindings);
            }
          };
        },
        async all() {
          calls.push({ bindings: [], sql });
          return { results: database.prepare(sql).all() };
        }
      };
    }
  };
}

describe("catalog service", () => {
  it("fails closed when the production catalog database binding is unavailable", async () => {
    const api = createCatalogApi(deps);

    await assert.rejects(
      () => api.loadCatalog(undefined, currentUser),
      (error) => error.status === 503 && error.message === "database_not_configured"
    );
  });

  it("keeps the DB-backed catalog response slim and leaves heavy read models empty", async () => {
    const api = createCatalogApi(deps);
    const catalog = await api.loadCatalog(makeCatalogDb(), currentUser);

    assert.deepEqual(catalog.categories, ["Finance", "Research"]);
    assert.deepEqual(catalog.hubListings, []);
    assert.deepEqual(catalog.publicationListings, []);
    assert.deepEqual(catalog.skills, []);
    assert.deepEqual(catalog.dataServices, []);
    assert.deepEqual(catalog.apps, []);
    assert.deepEqual(catalog.discussions, []);
    assert.deepEqual(catalog.activityEvents, []);
    assert.equal(catalog.currentUser.id, "user-1");
    assert.deepEqual(catalog.currentUser.status, {
      journeyLevelKey: "newcomer",
      mcpConnected: false,
      tokenApplied: false
    });
    assert.equal(catalog.journey.level.key, "newcomer");
    assert.equal("homeApplications" in catalog.portal, false);
  });

  it("loads the persisted Home user summary without recomputing external evidence", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(readFileSync(new URL("../../../db/schema.sql", import.meta.url), "utf8"));
    database.exec(`
      INSERT INTO teams (id, name, slug) VALUES ('team-1', 'Builders', 'builders');
      INSERT INTO users (id, team_id, name, email) VALUES ('user-1', 'team-1', 'Ada', 'ada@example.test');
      INSERT INTO portal_badge_definitions (
        badge_key, category, name_zh, name_en, trigger_type
      ) VALUES
        ('mcp_connected', 'foundation', 'MCP 已连接', 'MCP connected', 'gateway'),
        ('token_ready', 'foundation', 'Token 已就绪', 'Token ready', 'gateway');
      INSERT INTO portal_user_badges (user_id, badge_key) VALUES
        ('user-1', 'mcp_connected'),
        ('user-1', 'token_ready');
      INSERT INTO portal_user_journey_state (
        user_id, current_level_key, total_points, badge_count, updated_at
      ) VALUES ('user-1', 'builder', 870, 12, '2026-08-20 09:30:00');
    `);

    const summary = await readPersistedCurrentUserSummary(sqliteD1(database), "user-1");

    assert.deepEqual(summary, {
      journeyLevelKey: "builder",
      mcpConnected: true,
      tokenApplied: true,
      updatedAt: "2026-08-20 09:30:00"
    });
  });

  it("checks whether catalog projections contain read-side content", () => {
    assert.equal(hasCatalogContent({
      apps: [],
      dataServices: [],
      discussions: [],
      publicationListings: [],
      skills: []
    }), false);
    assert.equal(hasCatalogContent({
      apps: [{ id: "app-1" }],
      dataServices: [],
      discussions: [],
      publicationListings: [],
      skills: []
    }), true);
  });

  it("uses the Market listing as the effective App and Skill publication status", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(readFileSync(new URL("../../../db/schema.sql", import.meta.url), "utf8"));
    database.exec(`
      INSERT INTO teams (id, name, slug) VALUES ('team-1', 'Builders', 'builders');
      INSERT INTO users (id, team_id, name, email) VALUES ('user-1', 'team-1', 'Builder', 'builder@example.test');
      INSERT INTO apps (id, owner_team_id, publisher_user_id, name, slug, description, launch_url, status)
      VALUES ('app-reviewing', 'team-1', 'user-1', 'Reviewing App', 'reviewing-app', 'Pending review', 'https://app.example.test', 'listed');
      INSERT INTO skills (id, owner_team_id, name, slug, description, status)
      VALUES
        ('skill-reviewing', 'team-1', 'Reviewing Skill', 'reviewing-skill', 'Pending review', 'listed'),
        ('skill-listed', 'team-1', 'Listed Skill', 'listed-skill', 'Already listed', 'listed');
      INSERT INTO publication_listings (
        id, listing_type, target_plane, target_id, created_by_user_id, name, slug, status
      ) VALUES
        ('listing-app-reviewing', 'app', 'portal', 'app-reviewing', 'user-1', 'Reviewing App', 'reviewing-app-listing', 'pending_review'),
        ('listing-skill-reviewing', 'skill', 'portal', 'skill-reviewing', 'user-1', 'Reviewing Skill', 'reviewing-skill-listing', 'pending_review');
    `);
    const db = sqliteD1(database);
    const coverColumns = {
      appCatalogMetadata: false,
      publicationListings: false,
      skillCatalogMetadata: false
    };

    try {
      const apps = await readApps(db, {
        avatarUrl: false,
        departmentId: false,
        departmentPathJson: false
      }, coverColumns);
      const currentApp = await readCurrentApp(db, {
        avatarUrl: false,
        departmentId: false,
        departmentPathJson: false
      }, coverColumns, "app-reviewing");
      const skills = await readSkills(db, coverColumns);

      assert.equal(apps.find((app) => app.id === "app-reviewing").status, "pending_review");
      assert.equal(currentApp.status, "listed");
      assert.equal(skills.find((skill) => skill.id === "skill-reviewing").status, "pending_review");
      assert.equal(skills.find((skill) => skill.id === "skill-listed").status, "listed");
    } finally {
      database.close();
    }
  });

  it("filters the App read model by requested home target ids", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(readFileSync(new URL("../../../db/schema.sql", import.meta.url), "utf8"));
    database.exec(`
      INSERT INTO teams (id, name, slug) VALUES ('team-1', 'Builders', 'builders');
      INSERT INTO users (id, team_id, name, email) VALUES ('user-1', 'team-1', 'Builder', 'builder@example.test');
      INSERT INTO apps (id, owner_team_id, publisher_user_id, name, slug, description, launch_url, status)
      VALUES
        ('app-home', 'team-1', 'user-1', 'Home App', 'home-app', 'Shown on home', 'https://home.example.test', 'listed'),
        ('app-other', 'team-1', 'user-1', 'Other App', 'other-app', 'Not shown on home', 'https://other.example.test', 'listed');
    `);
    const calls = [];
    const db = sqliteD1(database, calls);

    try {
      const apps = await readApps(db, {
        avatarUrl: false,
        departmentId: false,
        departmentPathJson: false
      }, {
        appCatalogMetadata: false,
        publicationListings: false,
        skillCatalogMetadata: false
      }, ["app-home"]);

      assert.deepEqual(apps.map((app) => app.id), ["app-home"]);
      assert.deepEqual(calls.at(-1).bindings, ["app-home"]);
      assert.match(calls.at(-1).sql, /apps\.id IN \(\?\)/);
    } finally {
      database.close();
    }
  });

  it("discovers catalog and user profile optional columns", async () => {
    const db = makeColumnDb({
      skill_catalog_metadata: ["skill_id", "cover_image_url"],
      app_catalog_metadata: ["app_id"],
      publication_listings: ["id", "cover_image_url"],
      users: ["id", "email", "avatar_url"],
      user_identity_profiles: ["user_id", "department_id", "department_path_json"]
    });

    assert.deepEqual(await catalogCoverColumns(db), {
      skillCatalogMetadata: true,
      appCatalogMetadata: false,
      publicationListings: true
    });
    assert.deepEqual(await userProfileColumns(db), {
      avatarUrl: true,
      departmentId: true,
      departmentPathJson: true
    });
    assert.equal(await hasTableColumn(db, "users", "missing_column"), false);
  });

  it("merges auth users with portal profile details by auth user id", () => {
    const merged = mergeAdminUsers([
      {
        id: "auth-ada",
        name: "Ada Zhang",
        email: "ada@example.com",
        team: "",
        department: "GH / Investment Research",
        departmentId: "dept-research",
        departmentPath: ["dept-gh", "dept-research"],
        role: "member",
        status: "active",
        lastSeenAt: "2026-07-09T00:00:00.000Z",
        createdAt: "2026-07-02T00:00:00.000Z",
        identityProvider: "microsoft_entra_id",
        principalName: "ada@example.com"
      },
      {
        id: "invited-bob",
        name: "Bob Chan",
        email: "bob@example.com",
        team: "",
        department: "Gentleman / Trading",
        departmentPath: ["dept-gentleman", "dept-trading"],
        role: "member",
        status: "invited"
      }
    ], [
      {
        id: "auth-ada",
        name: "Old Ada",
        email: "ada@example.com",
        avatarUrl: "https://avatar.example.com/ada.png",
        team: "Portal Team",
        department: "Portal Department",
        journeyLevelKey: "builder",
        journeyTotalPoints: 120,
        journeyBadgeCount: 3,
        bio: "Builds research tools.",
        location: "HK",
        role: "admin",
        roles: ["community_admin"],
        status: "active",
        lastSeenAt: "2026-07-10T00:00:00.000Z",
        createdAt: "2026-07-01T00:00:00.000Z"
      },
      {
        id: "portal-cara",
        name: "Cara Lee",
        email: "cara@example.com",
        team: "Portal Team",
        role: "member",
        status: "active"
      }
    ]);

    assert.equal(merged.length, 2);

    const ada = merged.find((user) => user.email === "ada@example.com");
    assert.equal(ada.id, "auth-ada");
    assert.equal(ada.name, "Ada Zhang");
    assert.equal(ada.department, "GH / Investment Research");
    assert.deepEqual(ada.departmentPath, ["dept-gh", "dept-research"]);
    assert.equal(ada.avatarUrl, "https://avatar.example.com/ada.png");
    assert.equal(ada.bio, "Builds research tools.");
    assert.equal(ada.journeyLevelKey, "builder");
    assert.equal(ada.role, "admin");
    assert.deepEqual(ada.roles, ["admin", "community_admin"]);
    assert.equal(ada.lastSeenAt, "2026-07-10T00:00:00.000Z");
    assert.equal(ada.createdAt, "2026-07-01T00:00:00.000Z");

    const bob = merged.find((user) => user.email === "bob@example.com");
    assert.equal(bob.status, "invited");
    assert.equal(bob.department, "Gentleman / Trading");

    assert.equal(merged.some((user) => user.email === "cara@example.com"), false);
  });

  it("does not merge portal profile rows by email when the auth user id differs", () => {
    const merged = mergeAdminUsers([
      {
        id: "auth-ada",
        name: "Ada Zhang",
        email: "ada@example.com",
        team: "",
        department: "GH / Investment Research",
        role: "member",
        status: "active"
      }
    ], [
      {
        id: "portal-ada",
        name: "Old Ada",
        email: "ada@example.com",
        avatarUrl: "https://avatar.example.com/ada.png",
        team: "Portal Team",
        role: "admin",
        status: "active"
      }
    ]);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "auth-ada");
    assert.equal(merged[0].name, "Ada Zhang");
    assert.equal(merged[0].avatarUrl, undefined);
    assert.equal(merged[0].role, "member");
  });

  it("projects Journey points for Publication author hover cards", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT, email TEXT, avatar_url TEXT, team_id TEXT
      );
      CREATE TABLE user_identity_profiles (
        user_id TEXT PRIMARY KEY, department TEXT, job_title TEXT
      );
      CREATE TABLE portal_user_journey_state (
        user_id TEXT PRIMARY KEY, current_level_key TEXT,
        total_points INTEGER, community_contribution_points INTEGER
      );
      INSERT INTO teams VALUES ('team-1', 'AI Adoption');
      INSERT INTO users VALUES (
        'user-owner', 'Ivy Lin', 'ivy@example.test', 'https://assets.example.test/ivy.png', 'team-1'
      );
      INSERT INTO user_identity_profiles VALUES ('user-owner', 'Technology', 'Engineer');
      INSERT INTO portal_user_journey_state VALUES ('user-owner', 'builder', 790, 80);
    `);

    try {
      const [listing] = await attachPublicationOwnerProfiles(
        sqliteD1(database),
        [{ id: "listing-1" }],
        { avatarUrl: true },
        new Map([["listing-1", ["user-owner"]]])
      );

      assert.deepEqual(listing.ownerProfiles[0], {
        avatarUrl: "https://assets.example.test/ivy.png",
        department: "Technology",
        email: "ivy@example.test",
        id: "user-owner",
        jobTitle: "Engineer",
        journeyCommunityContributionPoints: 80,
        journeyLevelKey: "builder",
        journeyTotalPoints: 790,
        name: "Ivy Lin",
        team: "AI Adoption"
      });
    } finally {
      database.close();
    }
  });

  it("scopes forum child projections to the same bounded catalog topic set", () => {
    const sql = selectedForumTopicIdsSql();

    assert.match(sql, /FROM forum_topics/);
    assert.match(sql, /WHERE status = 'open'/);
    assert.match(sql, /ORDER BY is_pinned DESC, pinned_at DESC, MAX\(/);
    assert.match(sql, /activity_posts\.topic_id = forum_topics\.id/);
    assert.match(sql, new RegExp(`LIMIT ${CATALOG_FORUM_TOPIC_LIMIT}`));
  });

  it("round-trips an opaque forum cursor with a stable activity and id tie-breaker", () => {
    const cursor = encodeForumDiscussionCursor({
      id: "topic-002",
      lastActive: "2026-07-24T09:30:00.000Z"
    });

    assert.equal(validForumDiscussionCursor(cursor), true);
    assert.deepEqual(decodeForumDiscussionCursor(cursor), {
      id: "topic-002",
      lastActive: "2026-07-24T09:30:00.000Z"
    });
    assert.equal(validForumDiscussionCursor("not-a-valid-cursor"), false);
  });

  it("returns only open forum topics and never falls back to legacy discussions", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(readFileSync(new URL("../../../db/schema.sql", import.meta.url), "utf8"));
    database.exec(`
      INSERT INTO teams (id, name, slug) VALUES ('team-1', 'Builders', 'builders');
      INSERT INTO users (id, team_id, name, email) VALUES ('user-1', 'team-1', 'Ada', 'ada@example.test');
      INSERT INTO forum_categories (id, name, slug) VALUES ('category-1', 'General', 'general');
      INSERT INTO forum_topics (
        id, category_id, author_user_id, title, excerpt, status, is_pinned,
        created_at, updated_at, last_active_at
      ) VALUES
        ('topic-open', 'category-1', 'user-1', 'Open', 'Visible', 'open', 0,
          '2026-08-25 03:00:00', '2026-08-25 03:00:00', '2026-08-25 03:00:00'),
        ('topic-archived', 'category-1', 'user-1', 'Archived', 'Hidden', 'archived', 0,
          '2026-08-25 02:00:00', '2026-08-25 02:00:00', '2026-08-25 02:00:00'),
        ('topic-deleted', 'category-1', 'user-1', 'Deleted', 'Hidden', 'deleted', 0,
          '2026-08-25 01:00:00', '2026-08-25 01:00:00', '2026-08-25 01:00:00');
      INSERT INTO forum_posts (
        id, topic_id, author_user_id, body_markdown, parent_post_id, created_at, updated_at
      ) VALUES
        ('post-open', 'topic-open', 'user-1', 'Visible body', NULL,
          '2026-08-25 03:00:00', '2026-08-25 03:00:00'),
        ('reply-first', 'topic-open', 'user-1', 'First reply body', 'post-open',
          '2026-08-25 03:10:00', '2026-08-25 03:10:00'),
        ('reply-latest', 'topic-open', 'user-1', 'Latest reply preview', 'reply-first',
          '2026-08-25 03:20:00', '2026-08-25 03:20:00'),
        ('post-archived', 'topic-archived', 'user-1', 'Hidden body', NULL,
          '2026-08-25 02:00:00', '2026-08-25 02:00:00'),
        ('post-deleted', 'topic-deleted', 'user-1', 'Hidden body', NULL,
          '2026-08-25 01:00:00', '2026-08-25 01:00:00');
      INSERT INTO portal_discussions (
        id, author_user_id, title, tag, excerpt, replies, views, last_active
      ) VALUES (
        'topic-deleted', 'user-1', 'Legacy deleted topic', 'General', 'Must stay hidden', 0, 0,
        '2026-08-25 01:00:00'
      );
    `);
    const longRootBody = "Root post with detailed context. ".repeat(2_000);
    const longReplyBody = "Reply with a substantial explanation. ".repeat(500);
    database.prepare("UPDATE forum_posts SET body_markdown = ? WHERE id = ?").run(longRootBody, "post-open");
    const insertLargeReply = database.prepare(`
      INSERT INTO forum_posts (
        id, topic_id, author_user_id, body_markdown, parent_post_id, created_at, updated_at
      ) VALUES (?, 'topic-open', 'user-1', ?, 'post-open', '2026-08-25 03:30:00', '2026-08-25 03:30:00')
    `);
    for (let index = 0; index < 24; index += 1) {
      insertLargeReply.run(`reply-heavy-${String(index).padStart(2, "0")}`, longReplyBody);
    }

    try {
      const page = await readCatalogDiscussionPage(sqliteD1(database), currentUser, {
        avatarUrl: false,
        departmentId: false,
        departmentPathJson: false
      });

      assert.deepEqual(page.discussions.map((discussion) => discussion.id), ["topic-open"]);
      assert.deepEqual(page.pinnedDiscussions, []);
      assert.equal(page.discussions[0].body, undefined);
      assert.equal(page.discussions[0].replyPosts.length, 1);
      assert.equal(page.discussions[0].replyPosts[0].body.length, 600);

      const fullDetail = await readCatalogDiscussion(sqliteD1(database), currentUser, {
        avatarUrl: false,
        departmentId: false,
        departmentPathJson: false
      }, "topic-open");
      assert.equal(fullDetail.body, longRootBody.trimEnd());
      assert.ok(fullDetail.body.startsWith("Root post with detailed context."));
      assert.equal(fullDetail.replyPosts.length, 26);
      const listResponseBytes = Buffer.byteLength(JSON.stringify({
        discussions: page.discussions,
        pinnedDiscussions: page.pinnedDiscussions
      }));
      const detailResponseBytes = Buffer.byteLength(JSON.stringify(fullDetail));
      assert.ok(listResponseBytes < detailResponseBytes * 0.1);
      if (process.env.REPORT_PERFORMANCE_METRICS === "1") {
        console.log(`Forum fixture JSON: list=${listResponseBytes} B, detail=${detailResponseBytes} B, reduction=${(100 * (1 - listResponseBytes / detailResponseBytes)).toFixed(1)}%`);
      }

      database.exec("UPDATE forum_topics SET status = 'archived' WHERE id = 'topic-open'");
      const emptyPage = await readCatalogDiscussionPage(sqliteD1(database), currentUser, {
        avatarUrl: false,
        departmentId: false,
        departmentPathJson: false
      });
      const deletedDetail = await readCatalogDiscussion(sqliteD1(database), currentUser, {
        avatarUrl: false,
        departmentId: false,
        departmentPathJson: false
      }, "topic-deleted");

      assert.deepEqual(emptyPage.discussions, []);
      assert.deepEqual(emptyPage.pinnedDiscussions, []);
      assert.equal(deletedDetail, undefined);
    } finally {
      database.close();
    }
  });

  it("returns pinned topics separately and builds the next cursor from the last regular topic", async () => {
    const indexRows = {
      pinned: [{ id: "pinned-1", lastActive: "2026-07-20T00:00:00.000Z" }],
      regular: [
        { id: "topic-3", lastActive: "2026-07-24T03:00:00.000Z" },
        { id: "topic-2", lastActive: "2026-07-24T02:00:00.000Z" },
        { id: "topic-1", lastActive: "2026-07-24T01:00:00.000Z" }
      ]
    };
    const db = {
      prepare(sql) {
        let bindings = [];
        return {
          bind(...values) {
            bindings = values;
            return this;
          },
          async all() {
            if (sql.includes("forum_topics.id,") && !sql.includes("forum_topics.title")) {
              return { results: bindings[0] === 1 ? indexRows.pinned : indexRows.regular };
            }
            if (sql.includes("forum_topics.title")) {
              return {
                results: bindings.slice(1).map((id) => {
                  const index = [...indexRows.pinned, ...indexRows.regular].find((row) => row.id === id);
                  return {
                    author: "Ada",
                    category: "AI Exploration",
                    excerpt: `${id} excerpt`,
                    id,
                    lastActive: index?.lastActive,
                    pinned: id.startsWith("pinned") ? 1 : 0,
                    replies: 0,
                    tag: "AI Exploration",
                    tags: "",
                    title: `${id} title`,
                    views: 0
                  };
                })
              };
            }
            return { results: [] };
          }
        };
      }
    };

    const page = await readCatalogDiscussionPage(db, currentUser, {
      avatarUrl: false,
      departmentId: false,
      departmentPathJson: false
    }, { limit: 2 });

    assert.deepEqual(page.pinnedDiscussions.map((discussion) => discussion.id), ["pinned-1"]);
    assert.deepEqual(page.discussions.map((discussion) => discussion.id), ["topic-3", "topic-2"]);
    assert.deepEqual(decodeForumDiscussionCursor(page.nextCursor), {
      id: "topic-2",
      lastActive: "2026-07-24T02:00:00.000Z"
    });
  });

  it("maps publication listing rows with normalized status, target plane, and JSON config", () => {
    const listing = publicationListingFromRow({
      artifactType: "worker",
      artifactUrl: "https://example.com/app.zip",
      category: "Operations",
      comments: "3",
      configJson: "{\"verified\":true}",
      coverImageUrl: "https://example.com/cover.png",
      description: "Description",
      agentAddCount: "7",
      downloadCount: "11",
      id: "listing-1",
      installs: "12",
      name: "Example Listing",
      ownerAliasName: "Platform Studio",
      submittedByAvatarUrl: "https://example.com/publisher.png",
      submittedByDepartment: "AI",
      submittedByEmail: "publisher@example.com",
      submittedById: "publisher-1",
      submittedByJobTitle: "Builder",
      submittedByName: "Publisher User",
      submittedByTeam: "AI Adoption",
      rating: "4.5",
      reviewNotes: "",
      riskLevel: "high",
      status: "listed",
      summary: "Summary",
      tagsJson: "[\"app\",\"ops\"]",
      targetId: "app-1",
      targetPlane: "apps",
      type: "app",
      updatedAt: "2026-07-01",
      visitCount: "19",
      visibility: "company"
    });

    assert.equal(listing.targetPlane, "apps");
    assert.equal(listing.status, "listed");
    assert.equal(listing.riskLevel, "high");
    assert.equal(listing.ownerAliasName, "Platform Studio");
    assert.deepEqual(listing.config, { verified: true });
    assert.deepEqual(listing.tags, ["app", "ops"]);
    assert.equal(listing.installs, 12);
    assert.equal(listing.agentAddCount, 7);
    assert.equal(listing.downloadCount, 11);
    assert.equal(listing.visitCount, 19);
    assert.equal(listing.rating, 4.5);
    assert.equal(listing.submittedByProfile.name, "Publisher User");
    assert.equal(listing.submittedByProfile.department, "AI");
  });

  it("maps app rows with profile snapshots and array fields", () => {
    const app = appFromRow({
      accessMode: "approval",
      accessTargetsJson: "[\"department:AI\"]",
      appType: "agent_chat",
      dataRegion: "cn",
      dataTypesJson: "[\"profile\"]",
      deploymentMethod: "worker",
      deploymentProvider: "cloudflare",
      knowledgeSourcesJson: "[\"handbook\"]",
      launchCount: "9",
      publisherEmail: "publisher@example.com",
      publisherId: "publisher-1",
      publisherName: "Publisher User",
      publisherTeam: "Platform",
      scopes: "app:read,app:write",
      screenshotsJson: "[\"/shot.png\"]",
      sensitiveDataJson: "[\"email\"]",
      tagsJson: "[\"hr\"]",
      usesWorkspaceAuth: 1,
      viewCount: "42"
    });

    assert.equal(app.appType, "agent_chat");
    assert.equal(app.usesWorkspaceAuth, true);
    assert.deepEqual(app.tags, ["hr"]);
    assert.deepEqual(app.scopes, ["app:read", "app:write"]);
    assert.equal(app.publisherProfile.email, "publisher@example.com");
    assert.equal(app.viewCount, 42);
    assert.equal(app.launchCount, 9);
  });

  it("restores only current asset image projections, including full Portal URLs", () => {
    const image = "data:image/png;base64,SGVsbG8=";
    const url = cacheableCatalogImageUrl("app", "app-1", image);
    assert.equal(restoreCatalogImageSource("app", "app-1", url, image), image);
    for (const scheme of ["https", "http"]) {
      assert.equal(restoreCatalogImageSource("app", "app-1", `${scheme}://portal.test${url}`, image, "https://portal.test"), image);
    }
    const stale = cacheableCatalogImageUrl("app", "app-1", "data:image/png;base64,V29ybGQ=");
    const other = cacheableCatalogImageUrl("skill", "other", image);
    for (const rejected of [stale, other]) {
      assert.equal(restoreCatalogImageSource("app", "app-1", `https://portal.test${rejected}`, image, "https://portal.test"), rejected);
    }
    assert.equal(restoreCatalogImageSource("app", "app-1", url, url, "https://portal.test"), url);
    const external = `https://cdn.test${url}`;
    assert.equal(restoreCatalogImageSource("app", "app-1", external, image, "https://portal.test"), external);
  });

  it("replaces inline App and Skill images with stable versioned URLs", () => {
    const image = "data:image/png;base64,SGVsbG8=";
    const appUrl = cacheableCatalogImageUrl("app", "app-1", image);
    const skillUrl = cacheableCatalogImageUrl("skill", "skill-1", image);

    assert.match(appUrl, /^\/api\/assets\/app\/app-1\/image\?v=/);
    assert.match(skillUrl, /^\/api\/assets\/skill\/skill-1\/image\?v=/);
    assert.equal(cacheableCatalogImageUrl("app", "app-1", image), appUrl);
    assert.equal(cacheableCatalogImageUrl("app", "app-1", "https://cdn.example.test/cover.png"), "https://cdn.example.test/cover.png");

    const app = appFromRow({
      coverImageUrl: image,
      id: "app-1",
      screenshotsJson: JSON.stringify([image, "/assets/static-cover.png"])
    });
    assert.equal(app.coverImageUrl, appUrl);
    assert.deepEqual(app.screenshots, [appUrl, "/assets/static-cover.png"]);
  });

  it("serves catalog image bytes with immutable browser caching", async () => {
    const image = "data:image/png;base64,SGVsbG8=";
    const imageUrl = cacheableCatalogImageUrl("skill", "skill-1", image);
    const version = new URL(`https://portal.test${imageUrl}`).searchParams.get("v");
    const db = {
      prepare(sql) {
        assert.match(sql, /FROM publication_listings/);
        assert.match(sql, /FROM skill_catalog_metadata/);
        return {
          bind(type, targetId, metadataId) {
            assert.deepEqual([type, targetId, metadataId], ["skill", "skill-1", "skill-1"]);
            return {
              async all() {
                return { results: [{ imageUrl: image, screenshotsJson: "[]" }] };
              }
            };
          }
        };
      }
    };

    const response = await readCatalogImageResponse(db, "skill", "skill-1", version, new Headers());
    assert.equal(response?.status, 200);
    assert.equal(response?.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.equal(response?.headers.get("content-type"), "image/png");
    assert.equal(await response?.text(), "Hello");

    const cached = await readCatalogImageResponse(db, "skill", "skill-1", version, new Headers({
      "if-none-match": response?.headers.get("etag") ?? ""
    }));
    assert.equal(cached?.status, 304);
  });
});
