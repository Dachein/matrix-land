import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { evaluatePortalBadgeEvidence, normalizeAgentPreference, readPortalJourney, readPortalJourneySnapshot, recomputePortalUserJourney } from "./service.ts";
import {
  monthlyBudgetUsdForPortalJourneyLevel,
  normalizePortalJourneyLevelKey,
  portalBadgeDefinitions,
  portalCommunityContributionRules,
  portalJourneyLevels,
  resolvePortalJourneyLevel
} from "../../../src/shared/journey.ts";

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

describe("journey service", () => {
  it("maps L1-L5 monthly budgets and falls back unknown levels to L1", () => {
    assert.deepEqual([
      monthlyBudgetUsdForPortalJourneyLevel("newcomer"),
      monthlyBudgetUsdForPortalJourneyLevel("explorer"),
      monthlyBudgetUsdForPortalJourneyLevel("contributor"),
      monthlyBudgetUsdForPortalJourneyLevel("builder"),
      monthlyBudgetUsdForPortalJourneyLevel("master")
    ], [10, 30, 50, 100, 200]);
    assert.equal(normalizePortalJourneyLevelKey("unknown"), "newcomer");
    assert.equal(monthlyBudgetUsdForPortalJourneyLevel("unknown"), 10);
    assert.equal(monthlyBudgetUsdForPortalJourneyLevel(undefined), 10);
  });

  it("uses the approved L4 and L5 point thresholds", () => {
    const levelsByKey = Object.fromEntries(portalJourneyLevels.map((level) => [level.key, level]));
    const pointsByLevel = Object.fromEntries(portalJourneyLevels.map((level) => [level.key, level.minPoints]));

    assert.deepEqual({ builder: pointsByLevel.builder, master: pointsByLevel.master }, { builder: 500, master: 700 });
    assert.equal(levelsByKey.builder.criteria.requiredBadge, "first_published_capability");
    assert.equal(levelsByKey.master.criteria.requiredBadge, "first_published_capability");
  });

  it("requires a formally published APPS for L4 and prevents bypassing it through L5", () => {
    const withoutPublication = [
      { badgeKey: "first_post", category: "community" },
      { badgeKey: "first_apps_draft", category: "builder" },
      { badgeKey: "skill_maker", category: "builder" },
      { badgeKey: "collaboration_master", category: "impact" }
    ];
    const withPublication = [
      ...withoutPublication,
      { badgeKey: "first_published_capability", category: "builder" }
    ];

    assert.equal(resolvePortalJourneyLevel(500, withoutPublication).key, "contributor");
    assert.equal(resolvePortalJourneyLevel(700, withoutPublication).key, "contributor");
    assert.equal(resolvePortalJourneyLevel(500, withPublication).key, "builder");
    assert.equal(resolvePortalJourneyLevel(700, withPublication).key, "master");
  });

  it("uses the approved APPS creation and impact badge points", () => {
    const pointsByBadge = Object.fromEntries(portalBadgeDefinitions.map((badge) => [badge.key, badge.points]));

    assert.deepEqual({
      firstAppsDraft: pointsByBadge.first_apps_draft,
      skillMaker: pointsByBadge.skill_maker,
      appMaker: pointsByBadge.app_maker,
      firstPublished: pointsByBadge.first_published_capability,
      publishedTwo: pointsByBadge.published_two_appss,
      reusedByTeam: pointsByBadge.reused_by_team,
      collaborationMaster: pointsByBadge.collaboration_master
    }, {
      firstAppsDraft: 50,
      skillMaker: 100,
      appMaker: 100,
      firstPublished: 150,
      publishedTwo: 200,
      reusedByTeam: 200,
      collaborationMaster: 200
    });
  });

  it("uses the approved forum activity threshold and points", () => {
    const forumActive = portalBadgeDefinitions.find((badge) => badge.key === "forum_active");

    assert.equal(forumActive?.nameZh, "论坛活跃者");
    assert.equal(forumActive?.points, 100);
    assert.deepEqual(forumActive?.triggerConfig, { kind: "forum_active", topics: 5 });
    assert.deepEqual(portalCommunityContributionRules, {
      contributionTagPoints: [10, 30, 50],
      contributionTagCustomMin: 1,
      contributionTagCustomMax: 100,
      replyPoints: 1,
      topicPoints: 5
    });
    assert.equal(portalBadgeDefinitions.some((badge) => badge.key === "workspace_ai_contributor"), false);
    assert.equal(portalBadgeDefinitions.some((badge) => badge.key === "helpful_reply"), false);
  });

  it("normalizes supported agent preferences", () => {
    assert.equal(normalizeAgentPreference("codex"), "codex");
    assert.equal(normalizeAgentPreference("ChatGPT"), "codex");
    assert.equal(normalizeAgentPreference(" claude-code "), "claude-code");
    assert.equal(normalizeAgentPreference("cursor"), "cursor");
    assert.equal(normalizeAgentPreference("unknown"), undefined);
    assert.equal(normalizeAgentPreference(null), undefined);
  });

  it("builds foundational badge evidence from profile state", async () => {
    const db = {
      prepare(sql) {
        return {
          bind(...bindings) {
            return {
              async first() {
                if (sql.includes("COUNT(") || sql.includes("COUNT(*)")) {
                  return { count: 0 };
                }

                return null;
              }
            };
          }
        };
      }
    };
    const evidences = await evaluatePortalBadgeEvidence(db, {
      ...currentUser,
      avatarUrl: "https://avatar.example.com/a.png",
      department: "Platform",
      bio: "Builds internal AI workflows."
    }, {
      agentPreference: "codex",
      mcpInstallConfirmedAt: "2026-06-30T00:00:00.000Z"
    });

    assert.deepEqual(evidences.map((evidence) => evidence.badgeKey), [
      "profile_ready",
      "agent_declared",
      "mcp_connected"
    ]);
    assert.deepEqual(evidences[1].metadata, { agentPreference: "codex" });
    assert.equal(evidences[2].source, "profile");
  });

  it("awards APPS builder badges from managed APPS assets before Skill Hub submission", async () => {
    const db = {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("COUNT(") || sql.includes("COUNT(*)")) {
                  return { count: 0 };
                }

                return null;
              }
            };
          }
        };
      }
    };
    const evidences = await evaluatePortalBadgeEvidence(db, currentUser, {}, {
      appIds: [],
      skillIds: ["apps-skill-1"]
    });

    assert.deepEqual(evidences.map((evidence) => evidence.badgeKey), [
      "first_apps_draft",
      "skill_maker"
    ]);
    assert.deepEqual(evidences[0].metadata, { apps: 0, skills: 1 });
    assert.equal(evidences[1].source, "apps");
  });

  it("awards Forum Regular after five non-archived topics", async () => {
    let topicCount = 4;
    const db = {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("SELECT COUNT(*) AS count FROM forum_topics")) {
                  return { count: topicCount };
                }
                if (sql.includes("COUNT(") || sql.includes("COUNT(*)")) {
                  return { count: 0 };
                }
                return null;
              }
            };
          }
        };
      }
    };

    const beforeThreshold = await evaluatePortalBadgeEvidence(db, currentUser, {});
    topicCount = 5;
    const atThreshold = await evaluatePortalBadgeEvidence(db, currentUser, {});

    assert.equal(beforeThreshold.some((evidence) => evidence.badgeKey === "forum_active"), false);
    assert.deepEqual(atThreshold.map((evidence) => evidence.badgeKey), ["forum_active"]);
    assert.deepEqual(atThreshold[0].metadata, { topics: 5 });
  });

  it("recognizes top-level Forum replies and the current App visit event", async () => {
    const observedSql = [];
    const db = {
      prepare(sql) {
        observedSql.push(sql);
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("SELECT forum_posts.id AS id")) {
                  return { id: "reply-1", title: "A useful thread" };
                }
                if (sql.includes("action IN ('issued direct jump token', 'app.visit_url')")) {
                  return { count: 1 };
                }
                if (sql.includes("COUNT(") || sql.includes("COUNT(*)")) {
                  return { count: 0 };
                }
                return null;
              }
            };
          }
        };
      }
    };

    const evidences = await evaluatePortalBadgeEvidence(db, currentUser, {});

    assert.deepEqual(evidences.map((evidence) => evidence.badgeKey), [
      "first_reply",
      "first_app_launch"
    ]);
    assert.ok(observedSql.some((sql) => sql.includes("ORDER BY root_post.created_at ASC, root_post.id ASC")));
  });

  it("adds topic, reply, and Contribution tag points to a separate community subtotal and the total", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE portal_badge_definitions (
        badge_key TEXT PRIMARY KEY,
        category TEXT,
        name_zh TEXT,
        name_en TEXT,
        description_zh TEXT,
        description_en TEXT,
        points INTEGER,
        active INTEGER,
        sort_order INTEGER
      );
      CREATE TABLE portal_user_badges (
        user_id TEXT,
        badge_key TEXT,
        source TEXT,
        source_event_id TEXT,
        metadata_json TEXT,
        awarded_at TEXT
      );
      CREATE TABLE forum_contributor_awards (recipient_user_id TEXT, points INTEGER);
      CREATE TABLE forum_topics (id TEXT, author_user_id TEXT, status TEXT);
      CREATE TABLE forum_posts (
        id TEXT, topic_id TEXT, author_user_id TEXT, parent_post_id TEXT, created_at TEXT
      );
      CREATE TABLE portal_user_journey_state (
        user_id TEXT PRIMARY KEY,
        journey_key TEXT,
        version TEXT,
        current_level_key TEXT,
        total_points INTEGER,
        community_contribution_points INTEGER,
        badge_count INTEGER,
        category_counts_json TEXT,
        next_badges_json TEXT,
        profile_json TEXT,
        recomputed_at TEXT,
        updated_at TEXT
      );

      INSERT INTO portal_badge_definitions VALUES (
        'profile_ready', 'foundation', '资料就绪', 'Profile Ready',
        '资料完整', 'Profile complete', 20, 1, 10
      );
      INSERT INTO portal_user_badges VALUES (
        'user-1', 'profile_ready', 'profile', NULL, '{}', '2026-08-20T00:00:00Z'
      );
      INSERT INTO forum_topics VALUES
        ('topic-1', 'user-1', 'open'),
        ('topic-2', 'user-1', 'closed'),
        ('topic-archived', 'user-1', 'archived'),
        ('topic-other', 'user-2', 'open');
      INSERT INTO forum_posts VALUES
        ('root-1', 'topic-1', 'user-1', NULL, '2026-08-20T00:00:00Z'),
        ('reply-1', 'topic-1', 'user-1', NULL, '2026-08-20T00:01:00Z'),
        ('root-2', 'topic-2', 'user-2', NULL, '2026-08-20T00:00:00Z'),
        ('reply-2', 'topic-2', 'user-1', NULL, '2026-08-20T00:01:00Z'),
        ('root-archived', 'topic-archived', 'user-2', NULL, '2026-08-20T00:00:00Z'),
        ('reply-archived', 'topic-archived', 'user-1', NULL, '2026-08-20T00:01:00Z'),
        ('reply-other', 'topic-1', 'user-2', NULL, '2026-08-20T00:02:00Z');
      INSERT INTO forum_contributor_awards VALUES ('user-1', 10), ('user-1', 30), ('user-2', 50);
    `);

    try {
      const journey = await readPortalJourneySnapshot(sqliteD1ReadWrite(sqlite), "user-1", {});
      assert.equal(journey.badgeCount, 1);
      assert.equal(journey.badges[0].points, 20);
      assert.deepEqual(journey.communityContributionBreakdown, {
        contributionTagPoints: 40,
        replyPoints: 2,
        topicPoints: 10
      });
      assert.equal(journey.communityContributionPoints, 52);
      assert.equal(journey.totalPoints, 72);
    } finally {
      sqlite.close();
    }
  });

  it("recomputes a recipient projection immediately after a Contribution award", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        avatar_url TEXT,
        role TEXT,
        status TEXT,
        team_id TEXT
      );
      CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE user_identity_profiles (
        user_id TEXT PRIMARY KEY,
        department TEXT,
        job_title TEXT,
        profile_json TEXT,
        provider TEXT,
        provider_tenant_id TEXT,
        provider_subject_id TEXT,
        principal_name TEXT
      );
      CREATE TABLE portal_journey_levels (
        journey_key TEXT, version TEXT, level_key TEXT, rank INTEGER,
        name_zh TEXT, name_en TEXT, description_zh TEXT, description_en TEXT,
        min_points INTEGER, criteria_json TEXT,
        PRIMARY KEY (journey_key, version, level_key)
      );
      CREATE TABLE portal_badge_definitions (
        badge_key TEXT PRIMARY KEY, journey_key TEXT, version TEXT, category TEXT,
        name_zh TEXT, name_en TEXT, description_zh TEXT, description_en TEXT,
        points INTEGER, trigger_type TEXT, trigger_config_json TEXT,
        sort_order INTEGER, active INTEGER DEFAULT 1
      );
      CREATE TABLE portal_user_badges (
        user_id TEXT, badge_key TEXT, source TEXT, source_event_id TEXT,
        metadata_json TEXT, awarded_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, badge_key)
      );
      CREATE TABLE portal_user_journey_state (
        user_id TEXT PRIMARY KEY, journey_key TEXT, version TEXT,
        current_level_key TEXT, total_points INTEGER,
        community_contribution_points INTEGER, badge_count INTEGER,
        category_counts_json TEXT, next_badges_json TEXT, profile_json TEXT,
        recomputed_at TEXT, updated_at TEXT
      );
      CREATE TABLE user_usage (user_id TEXT, active_tokens INTEGER);
      CREATE TABLE audit_logs (
        actor_type TEXT, actor_id TEXT, action TEXT,
        target_type TEXT, target_id TEXT
      );
      CREATE TABLE forum_topics (
        id TEXT, title TEXT, author_user_id TEXT, status TEXT,
        reply_count INTEGER, created_at TEXT
      );
      CREATE TABLE forum_posts (
        id TEXT, topic_id TEXT, author_user_id TEXT,
        parent_post_id TEXT, created_at TEXT
      );
      CREATE TABLE forum_post_likes (post_id TEXT, user_id TEXT);
      CREATE TABLE forum_contributor_awards (recipient_user_id TEXT, points INTEGER);
      CREATE TABLE publication_listings (
        id TEXT, listing_type TEXT, target_plane TEXT, target_id TEXT,
        created_by_user_id TEXT, effective_status TEXT
      );
      CREATE TABLE publication_installations (
        listing_id TEXT, user_id TEXT, install_type TEXT
      );

      INSERT INTO teams VALUES ('team-1', 'AI Adoption');
      INSERT INTO users VALUES (
        'user-1', 'Ada', 'ada@example.test', '', 'member', 'active', 'team-1'
      );
      INSERT INTO user_identity_profiles VALUES (
        'user-1', 'Technology', 'Engineer', '{}', 'microsoft_entra_id',
        'tenant-1', 'object-1', 'ada@example.test'
      );
      INSERT INTO forum_topics VALUES (
        'topic-1', 'Reusable diagnosis', 'user-1', 'open', 0, '2026-08-21T00:00:00Z'
      );
      INSERT INTO forum_posts VALUES (
        'post-1', 'topic-1', 'user-1', NULL, '2026-08-21T00:00:00Z'
      );
      INSERT INTO forum_contributor_awards VALUES ('user-1', 30);
    `);

    try {
      const db = sqliteD1ReadWrite(sqlite);
      const summary = await recomputePortalUserJourney(db, "user-1");
      const persisted = sqlite.prepare(`
        SELECT
          total_points AS totalPoints,
          community_contribution_points AS communityContributionPoints,
          badge_count AS badgeCount
        FROM portal_user_journey_state
        WHERE user_id = 'user-1'
      `).get();

      assert.deepEqual(summary, {
        journeyBadgeCount: 1,
        journeyCommunityContributionPoints: 35,
        journeyLevelKey: "newcomer",
        journeyTotalPoints: 75
      });
      assert.deepEqual({ ...persisted }, {
        badgeCount: 1,
        communityContributionPoints: 35,
        totalPoints: 75
      });
    } finally {
      sqlite.close();
    }
  });

  it("separates owned APPS creation from collaboration and awards Collaboration Master at three projects", async () => {
    const db = emptyEvidenceDb();
    const evidences = await evaluatePortalBadgeEvidence(db, currentUser, {}, {
      appIds: ["app-owned", "app-shared-1"],
      collaboratedAppIds: ["app-shared-1", "app-shared-2"],
      collaboratedSkillIds: ["skill-shared-1"],
      ownedAppIds: ["app-owned"],
      ownedSkillIds: ["skill-owned"],
      skillIds: ["skill-owned", "skill-shared-1"]
    });

    assert.deepEqual(evidences.map((evidence) => evidence.badgeKey), [
      "first_apps_draft",
      "skill_maker",
      "app_maker",
      "collaboration_master"
    ]);
    assert.deepEqual(evidences[3].metadata, { collaboratedProjects: 3 });
  });

  it("awards formal publishing and team reuse from distinct-user APPS evidence", async () => {
    const db = {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("COUNT(DISTINCT publication_listings.id)")) {
                  return { count: 2 };
                }
                if (sql.includes("WITH project_usage")) {
                  return { count: 1 };
                }
                if (sql.includes("COUNT(") || sql.includes("COUNT(*)")) {
                  return { count: 0 };
                }
                return null;
              }
            };
          }
        };
      }
    };
    const evidences = await evaluatePortalBadgeEvidence(db, currentUser, {}, {
      appIds: ["app-owned"],
      collaboratedAppIds: [],
      collaboratedSkillIds: [],
      ownedAppIds: ["app-owned"],
      ownedSkillIds: [],
      skillIds: []
    });

    assert.deepEqual(evidences.map((evidence) => evidence.badgeKey), [
      "first_apps_draft",
      "app_maker",
      "first_published_capability",
      "published_two_appss",
      "reused_by_team"
    ]);
    assert.deepEqual(evidences[4].metadata, {
      distinctUsersRequired: 5,
      reusedAppss: 1
    });
  });

  it("evaluates publishing and distinct-user reuse against SQLite", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE user_usage (user_id TEXT, active_tokens INTEGER);
      CREATE TABLE audit_logs (
        actor_type TEXT,
        actor_id TEXT,
        action TEXT,
        target_type TEXT,
        target_id TEXT
      );
      CREATE TABLE forum_topics (
        id TEXT,
        title TEXT,
        author_user_id TEXT,
        status TEXT,
        reply_count INTEGER,
        created_at TEXT
      );
      CREATE TABLE forum_posts (
        id TEXT,
        topic_id TEXT,
        author_user_id TEXT,
        parent_post_id TEXT,
        created_at TEXT
      );
      CREATE TABLE forum_post_likes (post_id TEXT, user_id TEXT);
      CREATE TABLE forum_contributor_awards (
        id TEXT,
        topic_id TEXT,
        post_id TEXT,
        recipient_user_id TEXT,
        awarded_by_user_id TEXT,
        points INTEGER,
        note TEXT,
        created_at TEXT
      );
      CREATE TABLE publication_listings (
        id TEXT,
        listing_type TEXT,
        target_plane TEXT,
        target_id TEXT,
        created_by_user_id TEXT,
        status TEXT,
        effective_status TEXT
      );
      CREATE TABLE publication_installations (
        listing_id TEXT,
        user_id TEXT,
        install_type TEXT
      );

      INSERT INTO publication_listings VALUES
        ('listing-app-1', 'app', 'apps', 'app-owned-1', 'user-1', 'listed', 'listed'),
        ('listing-app-2', 'app', 'apps', 'app-owned-2', 'user-1', 'listed', 'listed');
      INSERT INTO publication_installations VALUES
        ('listing-app-1', 'user-2', 'user'),
        ('listing-app-1', 'user-3', 'user'),
        ('listing-app-1', 'user-4', 'user'),
        ('listing-app-1', 'user-5', 'user'),
        ('listing-app-1', 'user-6', 'user'),
        ('listing-app-1', 'user-1', 'user'),
        ('listing-app-1', 'user-7', 'bookmark');
    `);

    try {
      const evidences = await evaluatePortalBadgeEvidence(sqliteD1(sqlite), currentUser, {}, {
        appIds: ["app-owned-1", "app-owned-2"],
        collaboratedAppIds: [],
        collaboratedSkillIds: [],
        ownedAppIds: ["app-owned-1", "app-owned-2"],
        ownedSkillIds: [],
        skillIds: []
      });

      assert.deepEqual(evidences.map((evidence) => evidence.badgeKey), [
        "first_apps_draft",
        "app_maker",
        "first_published_capability",
        "published_two_appss",
        "reused_by_team"
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("awards gateway token and MCP badges from their live service evidence", async () => {
    const db = {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("COUNT(") || sql.includes("COUNT(*)")) {
                  return { count: 0 };
                }

                return null;
              }
            };
          }
        };
      }
    };
    const evidences = await evaluatePortalBadgeEvidence(db, currentUser, {}, undefined, {
      activeGatewayTokenCount: 1,
      authorizedMcpConnectionCount: 2,
      connectedAgentPreference: "workbuddy"
    });

    assert.deepEqual(evidences.map((evidence) => evidence.badgeKey), [
      "agent_declared",
      "token_ready",
      "mcp_connected"
    ]);
    assert.deepEqual(evidences[0], {
      badgeKey: "agent_declared",
      source: "auth",
      metadata: { agentPreference: "workbuddy" }
    });
    assert.deepEqual(evidences[1], {
      badgeKey: "token_ready",
      source: "gateway",
      metadata: { activeTokens: 1 }
    });
    assert.equal(evidences[2].source, "auth");
    assert.equal(evidences[2].metadata.authorizedConnections, 2);
  });

  it("falls back to an empty journey when journey tables are missing", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {};
          }
        };
      },
      async batch() {
        throw new Error("no such table: portal_journey_levels");
      }
    };

    const journey = await readPortalJourney(db, currentUser);

    assert.equal(journey.level.key, "newcomer");
    assert.equal(journey.badgeCount, 0);
    assert.equal(journey.totalPoints, 0);
    assert.deepEqual(journey.profile, {});
  });

  it("forwards live MCP Agent evidence into the Journey evaluator", async () => {
    const db = createJourneyActivityDb({});
    const journey = await readPortalJourney(db, currentUser, {
      connectedAgentPreference: "workbuddy"
    });

    assert.equal(journey.badges.some((badge) => badge.badgeKey === "agent_declared"), true);
  });

  it("does not hide unrelated schema errors as an empty Journey", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {};
          }
        };
      },
      async batch() {
        throw new Error("no such column: publication_listings.effective_status");
      }
    };

    await assert.rejects(() => readPortalJourney(db, currentUser), /no such column/);
  });

  it("emits activity when new badges award and upgrade the journey level", async () => {
    const db = createJourneyActivityDb({
      agentPreference: "codex",
      mcpInstallConfirmedAt: "2026-06-30T00:00:00.000Z"
    });
    const emitted = [];
    const user = {
      ...currentUser,
      avatarUrl: "https://avatar.example.com/a.png",
      bio: "Builds internal AI workflows."
    };

    const journey = await readPortalJourney(db, user, {
      async emitActivityEvent(_db, input) {
        emitted.push(input);
        return `evt-${emitted.length}`;
      }
    });

    assert.equal(journey.level.key, "explorer");
    assert.deepEqual(emitted.map((event) => event.actionType), [
      "journey.badge.awarded",
      "journey.badge.awarded",
      "journey.badge.awarded",
      "journey.level.upgraded"
    ]);
    assert.equal(emitted[0].metadata.badgeKey, "profile_ready");
    assert.equal(emitted[3].target.type, "journey_level");
    assert.equal(emitted[3].metadata.levelKey, "explorer");
    assert.equal(emitted[3].metadata.levelRank, 2);

    await readPortalJourney(db, user, {
      async emitActivityEvent(_db, input) {
        emitted.push(input);
        return `evt-${emitted.length}`;
      }
    });

    assert.equal(emitted.length, 4);
  });

  it("syncs the initial and changed level once while skipping an unchanged level", async () => {
    const profile = {};
    const db = createJourneyActivityDb(profile);
    const user = { ...currentUser };
    const syncedLevels = [];
    const options = {
      async syncMonthlyBudget(levelKey) {
        syncedLevels.push(levelKey);
      }
    };

    await readPortalJourney(db, user, options);
    await readPortalJourney(db, user, options);

    user.avatarUrl = "https://avatar.example.com/a.png";
    user.bio = "Builds internal AI workflows.";
    profile.agentPreference = "codex";
    profile.mcpInstallConfirmedAt = "2026-06-30T00:00:00.000Z";

    await readPortalJourney(db, user, options);
    await readPortalJourney(db, user, options);

    assert.deepEqual(syncedLevels, ["newcomer", "explorer"]);
  });

  it("retries level budget sync after a failed attempt without persisting the level", async () => {
    const db = createJourneyActivityDb({});
    const syncedLevels = [];

    await assert.rejects(
      () => readPortalJourney(db, currentUser, {
        async syncMonthlyBudget(levelKey) {
          syncedLevels.push(levelKey);
          throw new Error("litellm_unavailable");
        }
      }),
      /litellm_unavailable/
    );

    await readPortalJourney(db, currentUser, {
      async syncMonthlyBudget(levelKey) {
        syncedLevels.push(levelKey);
      }
    });

    assert.deepEqual(syncedLevels, ["newcomer", "newcomer"]);
  });
});

function emptyEvidenceDb() {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("COUNT(") || sql.includes("COUNT(*)")) {
                return { count: 0 };
              }
              return null;
            }
          };
        }
      };
    }
  };
}

function sqliteD1(sqlite) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              return sqlite.prepare(sql).get(...params) ?? null;
            }
          };
        }
      };
    }
  };
}

function sqliteD1ReadWrite(sqlite) {
  return {
    async batch(statements) {
      return await Promise.all(statements.map((statement) => statement.run()));
    },
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...bindings) {
          params = bindings;
          return statement;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...params) };
        },
        async first() {
          return sqlite.prepare(sql).get(...params) ?? null;
        },
        async run() {
          const result = sqlite.prepare(sql).run(...params);
          return { meta: { changes: result.changes }, success: true };
        }
      };
      return statement;
    }
  };
}

function createJourneyActivityDb(profile) {
  const awardedBadgeKeys = new Set();
  let currentLevelKey;

  return {
    prepare(sql) {
      return {
        bind(...bindings) {
          const statement = {
            bindings,
            sql,
            async first() {
              if (sql.includes("profile_json AS profileJson")) {
                return { profileJson: JSON.stringify(profile) };
              }

              if (sql.includes("current_level_key AS currentLevelKey")) {
                return currentLevelKey ? { currentLevelKey } : null;
              }

              if (sql.includes("COUNT(") || sql.includes("COUNT(*)")) {
                return { count: 0 };
              }

              return null;
            },
            async all() {
              if (sql.includes("SELECT badge_key AS badgeKey FROM portal_user_badges")) {
                return {
                  results: Array.from(awardedBadgeKeys).map((badgeKey) => ({ badgeKey }))
                };
              }

              if (sql.includes("FROM portal_user_badges") && sql.includes("JOIN portal_badge_definitions")) {
                return {
                  results: Array.from(awardedBadgeKeys).map((badgeKey) => {
                    const definition = portalBadgeDefinitions.find((badge) => badge.key === badgeKey);

                    return {
                      badgeKey,
                      category: definition.category,
                      nameZh: definition.nameZh,
                      nameEn: definition.nameEn,
                      descriptionZh: definition.descriptionZh,
                      descriptionEn: definition.descriptionEn,
                      points: definition.points,
                      source: "profile",
                      sourceEventId: "",
                      metadataJson: "{}",
                      awardedAt: "2026-06-30T00:00:00.000Z"
                    };
                  })
                };
              }

              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO portal_user_journey_state")) {
                currentLevelKey = bindings[1];
              }
            }
          };

          return statement;
        }
      };
    },
    async batch(statements) {
      statements.forEach((statement) => {
        if (statement.sql.includes("INSERT OR IGNORE INTO portal_user_badges")) {
          awardedBadgeKeys.add(statement.bindings[1]);
        }
      });
    }
  };
}
