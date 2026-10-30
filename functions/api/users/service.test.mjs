import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadAuthWorkerAdminUsers, loadMergedAdminUsers } from "./adminList.ts";
import { createUserDirectoryApi, filterDirectoryUsersToPortalUsers, loadUserDirectoryUsers } from "./directory.ts";
import { createUsersApi, profileDetailsFromRow, syncAuthUserRole } from "./service.ts";
import { cacheableUserAvatarUrl } from "./avatar.ts";

const currentUser = {
  id: "user-1",
  name: "Ada",
  email: "ada@example.com",
  team: "AI Adoption",
  role: "admin",
  identity: {
    provider: "microsoft_entra_id",
    objectId: "oid-1",
    tenantId: "tid-1"
  }
};

function makeDeps(overrides = {}) {
  return {
    async audit() {
      return "audit-1";
    },
    httpError(status, message) {
      return Object.assign(new Error(message), { status });
    },
    normalizeAvatarUrl(value) {
      return String(value ?? "");
    },
    normalizeEditableRole(value) {
      const role = String(value ?? "");
      if (role === "admin" || role === "member") {
        return role;
      }
      throw Object.assign(new Error("invalid_user_role"), { status: 400 });
    },
    normalizeIdentityProvider(value) {
      return value === "dingtalk" || value === "generic_oidc" ? value : "microsoft_entra_id";
    },
    normalizeProfileDepartment(value) {
      return String(value ?? "").trim();
    },
    normalizeRole(value) {
      return value === "admin" ? "admin" : "member";
    },
    optionalText(value, maxLength) {
      return String(value ?? "").trim().slice(0, maxLength);
    },
    async readBody(request) {
      return request.headers.get("content-type")?.includes("json") ? request.json() : {};
    },
    async requireAdminPortalUser() {
      return currentUser;
    },
    requireDb(db) {
      return db;
    },
    requireText(value, errorCode, maxLength) {
      const text = String(value ?? "").trim();
      if (!text) {
        throw Object.assign(new Error(errorCode), { status: 400 });
      }
      return text.slice(0, maxLength);
    },
    async resolveCurrentUser() {
      return currentUser;
    },
    async userProfileColumns() {
      return { avatarUrl: true, departmentId: false, departmentPathJson: false };
    },
    ...overrides
  };
}

function makePortalDirectoryDb({ avatarColumn, rows }) {
  const state = {};
  const db = {
    prepare(sql) {
      if (sql === "PRAGMA table_info(users)") {
        return {
          async all() {
            return {
              results: ["id", "name", "email", ...(avatarColumn ? ["avatar_url"] : [])]
                .map((name) => ({ name }))
            };
          }
        };
      }

      state.sql = sql;
      return {
        bind(...bindings) {
          state.bindings = bindings;
          return {
            async all() {
              return { results: rows };
            }
          };
        }
      };
    }
  };

  return { db, state };
}

describe("user directory", () => {
  it("requests active and invited collaborators while rejecting explicit inactive rows", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl;
    globalThis.fetch = async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify({
        users: [
          { id: "active-user", email: "active@example.com", status: "active" },
          { id: "invited-user", email: "invited@example.com", status: "invited" },
          { id: "inactive-user", email: "inactive@example.com", status: "inactive" }
        ]
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    };

    try {
      const users = await loadUserDirectoryUsers({
        AUTH_SERVICE_TOKEN: "service-token",
        AUTH_WORKER_URL: "https://auth.example.com"
      }, {
        limit: 1000,
        statuses: ["active", "invited"]
      });

      assert.deepEqual(requestedUrl.searchParams.getAll("status"), ["active", "invited"]);
      assert.deepEqual(users.map((user) => user.id), ["active-user", "invited-user"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("loads people-only mention candidates from active Portal members without the Auth service", async () => {
    const { db, state } = makePortalDirectoryDb({
      avatarColumn: true,
      rows: [{
        id: "user-2",
        name: "Grace Hopper",
        email: "grace@example.com",
        avatarUrl: "https://cdn.example.com/grace.png",
        team: "Platform",
        department: "Engineering"
      }]
    });
    const api = createUserDirectoryApi({
      httpError(status, message) {
        return Object.assign(new Error(message), { status });
      },
      requireDb() {
        return db;
      },
      async resolveCurrentUser() {
        return currentUser;
      }
    });

    const users = await api.listUserDirectory({
      request: new Request("https://portal.test/api/users/directory?purpose=mention&q=grace&limit=8"),
      env: { DB: db }
    });

    assert.match(state.sql, /users\.status = 'active'/);
    assert.deepEqual(state.bindings, ["%grace%", "%grace%", 8]);
    assert.deepEqual(users, [{
      id: "user-2",
      name: "Grace Hopper",
      email: "grace@example.com",
      emailPrefix: "grace",
      avatarUrl: "https://cdn.example.com/grace.png",
      team: "",
      department: "Engineering"
    }]);
  });

  it("enriches mention candidates with the Portal profile avatar", async () => {
    const { db, state } = makePortalDirectoryDb({
      avatarColumn: true,
      rows: [{
        id: "user-2",
        name: "Grace Hopper",
        email: "grace@portal.example.com",
        avatarUrl: "https://cdn.example.com/grace.png",
        team: "Platform",
        department: "Engineering"
      }]
    });

    const users = await filterDirectoryUsersToPortalUsers(db, [{
      id: "user-2",
      name: "Grace",
      email: "grace@directory.example.com",
      emailPrefix: "grace"
    }]);

    assert.match(state.sql, /COALESCE\(users\.avatar_url, ''\) AS avatarUrl/);
    assert.deepEqual(state.bindings, ["user-2"]);
    assert.deepEqual(users, [{
      id: "user-2",
      name: "Grace Hopper",
      email: "grace@portal.example.com",
      emailPrefix: "grace",
      avatarUrl: "https://cdn.example.com/grace.png",
      team: "",
      department: "Engineering"
    }]);
  });

  it("keeps mention candidates compatible with Portal schemas without avatar_url", async () => {
    const { db, state } = makePortalDirectoryDb({
      avatarColumn: false,
      rows: [{
        id: "user-2",
        name: "Grace Hopper",
        email: "grace@example.com",
        avatarUrl: "",
        team: "Platform",
        department: "Engineering"
      }]
    });

    const [user] = await filterDirectoryUsersToPortalUsers(db, [{
      id: "user-2",
      email: "grace@example.com",
      emailPrefix: "grace"
    }]);

    assert.match(state.sql, /'' AS avatarUrl/);
    assert.doesNotMatch(state.sql, /users\.avatar_url/);
    assert.equal(Object.hasOwn(user, "avatarUrl"), false);
  });

  it("keeps access-directory loading independent of the Portal DB schema", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      users: [{
        id: "user-2",
        name: "Grace Hopper",
        email: "grace@example.com",
        avatarUrl: "https://cdn.example.com/grace.png"
      }]
    }), {
      headers: { "content-type": "application/json" },
      status: 200
    });

    try {
      const api = createUserDirectoryApi({
        httpError(status, message) {
          return Object.assign(new Error(message), { status });
        },
        requireDb() {
          throw new Error("access_directory_must_not_read_portal_db");
        },
        async resolveCurrentUser() {
          return currentUser;
        }
      });
      const users = await api.listUserDirectory({
        request: new Request("https://portal.test/api/users/directory?purpose=access"),
        env: {
          AUTH_SERVICE_TOKEN: "service-token",
          AUTH_WORKER_URL: "https://auth.example.com"
        }
      });

      assert.equal(users[0].avatarUrl, "https://cdn.example.com/grace.png");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("users service", () => {
  it("preserves canonical hierarchy IDs for department selection and profile display", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://auth.example.test/v1/admin/departments");
      assert.equal(init.headers.authorization, "Bearer service-token");
      return new Response(JSON.stringify({ departments: [
        { id: "dept-root", name: "Workspace Wealth Group Limited", path: ["dept-root"], status: "active" },
        { id: "dept-group", name: "Group", parentId: "dept-root", path: ["dept-root", "dept-group"], status: "active" }
      ] }), { headers: { "content-type": "application/json" } });
    };
    try {
      const api = createUsersApi(makeDeps());
      const departments = await api.listUserDepartments({
        env: { AUTH_WORKER_URL: "https://auth.example.test", PORTAL_AUTH_SERVICE_TOKEN: "service-token" },
        request: new Request("https://portal.test/api/users/departments")
      });
      assert.deepEqual(departments, [
        { id: "dept-root", name: "Workspace Wealth Group Limited", path: ["dept-root"], status: "active" },
        { id: "dept-group", name: "Group", parentId: "dept-root", path: ["dept-root", "dept-group"], status: "active" }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps profile details from profile_json", () => {
    assert.deepEqual(profileDetailsFromRow({
      department: "Platform",
      jobTitle: "Engineer",
      profileJson: "{\"bio\":\"Builds internal tools.\",\"location\":\"HK\"}"
    }), {
      department: "Platform",
      jobTitle: "Engineer",
      bio: "Builds internal tools.",
      location: "HK"
    });
  });

  it("includes the public bio when loading batch user summaries", async () => {
    const state = {};
    const db = {
      prepare(sql) {
        if (sql.includes("sqlite_master")) {
          return {
            async first() {
              return { name: "portal_user_journey_state" };
            }
          };
        }

        state.sql = sql;
        return {
          bind(...bindings) {
            state.bindings = bindings;
            return {
              async all() {
                return {
                  results: [{
                    id: "user-2",
                    name: "Grace",
                    email: "grace@example.com",
                    avatarUrl: "https://avatar.example.com/grace.png",
                    team: "AI Adoption",
                    department: "Platform",
                    departmentId: "dept-ai",
                    departmentPathJson: '["dept-root","dept-group","dept-ai"]',
                    jobTitle: "Engineer",
                    profileJson: JSON.stringify({
                      bio: "  Builds useful agents for the community.  ",
                      location: "Hong Kong"
                    }),
                    journeyLevelKey: "explorer",
                    journeyTotalPoints: 480,
                    journeyCommunityContributionPoints: 80
                  }]
                };
              }
            };
          }
        };
      }
    };
    const api = createUsersApi(makeDeps({
      async userProfileColumns() {
        return { avatarUrl: true, departmentId: true, departmentPathJson: true };
      }
    }));
    const [user] = await api.readUserBatch({
      request: new Request("https://portal.test/api/users/batch?ids=user-2"),
      env: { DB: db }
    });

    assert.match(state.sql, /user_identity_profiles\.profile_json AS profileJson/);
    assert.deepEqual(state.bindings, ["user-2"]);
    assert.equal(user.bio, "Builds useful agents for the community.");
    assert.equal(user.departmentId, "dept-ai");
    assert.deepEqual(user.departmentPath, ["dept-root", "dept-group", "dept-ai"]);
    assert.equal(user.journeyTotalPoints, 480);
    assert.equal(user.journeyCommunityContributionPoints, 80);
    assert.equal(Object.hasOwn(user, "location"), false);
  });

  it("enriches a public profile with read-only journey, recent post, and published skill summaries", async () => {
    const state = { queries: [] };
    const profileRow = {
      id: "user-2",
      name: "Grace Hopper",
      email: "grace@example.com",
      avatarUrl: "https://avatar.example.com/grace.png",
      role: "member",
      status: "active",
      department: "Platform",
      departmentId: "",
      departmentPathJson: "[]",
      jobTitle: "Engineer",
      profileJson: JSON.stringify({ bio: "Builds useful agents.", location: "Hong Kong" }),
      team: "AI Adoption",
      journeyLevelKey: "builder",
      journeyTotalPoints: 480,
      journeyBadgeCount: 2
    };
    const journeyRows = [{
      currentLevelKey: "builder",
      totalPoints: 480,
      communityContributionPoints: 80,
      badgeCount: 2
    }];
    const badgeRows = [{
      badgeKey: "forum-helper",
      nameZh: "社区助人",
      nameEn: "Forum Helper",
      descriptionZh: "帮助社区成员解决问题。",
      descriptionEn: "Helped community members solve problems.",
      points: 300,
      awardedAt: "2026-07-14T09:00:00.000Z"
    }, {
      badgeKey: "profile-ready",
      nameZh: "资料就绪",
      nameEn: "Profile Ready",
      descriptionZh: "完成个人资料。",
      descriptionEn: "Completed the public profile.",
      points: 180,
      awardedAt: "2026-07-12T08:00:00.000Z"
    }];
    const postRows = [{
      id: "topic-new",
      title: "Newest public update",
      replyCount: 7,
      replies: 7,
      createdAt: "2026-07-15T08:00:00.000Z"
    }, {
      id: "topic-older",
      title: "Earlier public update",
      replyCount: 2,
      replies: 2,
      createdAt: "2026-07-10T08:00:00.000Z"
    }];
    const skillRows = [{
      id: "listing-skill-1",
      targetId: "skill-1",
      name: "Contract Risk Review",
      summary: "Reviews contracts before approval.",
      coverImageUrl: "https://assets.example.com/contract-risk.png",
      installs: 42,
      publishedAt: "2026-07-13T08:00:00.000Z"
    }];

    function rowsFor(sql) {
      if (/FROM\s+users\b/i.test(sql) && /WHERE\s+users\.id\s*=\s*\?/i.test(sql)) return [profileRow];
      if (/FROM\s+portal_user_journey_state\b/i.test(sql)) return journeyRows;
      if (/FROM\s+portal_user_badges\b/i.test(sql)) return badgeRows;
      if (/FROM\s+forum_topics\b/i.test(sql)) return postRows;
      if (/FROM\s+publication_listings\b/i.test(sql)) return skillRows;
      if (/sqlite_master/i.test(sql)) return [{ name: "available" }];
      return [];
    }

    function queryResult(sql, bindings = []) {
      const rows = rowsFor(sql);
      state.queries.push({ bindings, sql });
      return {
        async all() {
          return { results: rows };
        },
        async first() {
          return rows[0] ?? null;
        }
      };
    }

    const db = {
      prepare(sql) {
        return {
          bind(...bindings) {
            return queryResult(sql, bindings);
          },
          async all() {
            return queryResult(sql).all();
          },
          async first() {
            return queryResult(sql).first();
          }
        };
      }
    };
    const api = createUsersApi(makeDeps());
    const profile = await api.readUserProfile({
      request: new Request("https://portal.test/api/users/user-2/profile"),
      env: { DB: db }
    }, "user-2");

    assert.deepEqual(profile, {
      id: "user-2",
      name: "Grace Hopper",
      email: "grace@example.com",
      avatarUrl: "https://avatar.example.com/grace.png",
      team: "",
      department: "Platform",
      jobTitle: "Engineer",
      bio: "Builds useful agents.",
      location: "Hong Kong",
      role: "member",
      journeyLevelKey: "builder",
      journeyTotalPoints: 480,
      journeyCommunityContributionPoints: 80,
      journeyBadgeCount: 2,
      journeyBadges: badgeRows,
      recentPosts: postRows.map(({ replies: _replies, ...post }) => post),
      publishedSkills: skillRows
    });

    const badgeQuery = state.queries.find(({ sql }) => /FROM\s+portal_user_badges\b/i.test(sql));
    const postsQuery = state.queries.find(({ sql }) => /FROM\s+forum_topics\b/i.test(sql));
    const skillsQuery = state.queries.find(({ sql }) => /FROM\s+publication_listings\b/i.test(sql));
    assert.ok(badgeQuery);
    assert.ok(postsQuery);
    assert.ok(skillsQuery);
    assert.ok(badgeQuery.bindings.includes("user-2"));
    assert.match(postsQuery.sql, /status\s*!=\s*'archived'/i);
    assert.match(postsQuery.sql, /ORDER BY[\s\S]*created_at\s+DESC/i);
    assert.match(postsQuery.sql, /LIMIT\s+5/i);
    assert.ok(postsQuery.bindings.includes("user-2"));
    const skillContract = `${skillsQuery.sql}\n${skillsQuery.bindings.join("\n")}`;
    assert.match(skillContract, /listing_type[\s\S]*skill/i);
    assert.match(skillContract, /status[\s\S]*listed/i);
    assert.match(skillContract, /visibility[\s\S]*org/i);
    assert.ok(skillsQuery.bindings.includes("user-2"));
    assert.equal(state.queries.some(({ sql }) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
  });

  it("deduplicates batch user ids and binds them safely", async () => {
    const state = {};
    const db = {
      prepare(sql) {
        if (sql.includes("sqlite_master")) {
          return {
            async first() {
              return { name: "portal_user_journey_state" };
            }
          };
        }

        state.sql = sql;
        return {
          bind(...bindings) {
            state.bindings = bindings;
            return {
              async all() {
                return {
                  results: [{
                    id: "user-2",
                    name: "Grace",
                    email: "grace@example.com",
                    avatarUrl: "https://avatar.example.com/grace.png",
                    team: "AI Adoption",
                    department: "Platform",
                    jobTitle: "Engineer",
                    journeyLevelKey: "explorer"
                  }]
                };
              }
            };
          }
        };
      }
    };
    const api = createUsersApi(makeDeps());
    const users = await api.readUserBatch({
      request: new Request("https://portal.test/api/users/batch?ids=user-2,user-3&ids=user-2,,"),
      env: { DB: db }
    });

    assert.match(state.sql, /users\.id IN \(\?, \?\)/);
    assert.deepEqual(state.bindings, ["user-2", "user-3"]);
    assert.equal(users.length, 1);
    assert.equal(users[0].id, "user-2");
    assert.equal(users[0].department, "Platform");
    assert.equal(users[0].journeyLevelKey, "explorer");
    assert.match(state.sql, /LEFT JOIN portal_user_journey_state/);
  });

  it("does not invent a journey level when no materialized state exists", async () => {
    const db = {
      prepare(sql) {
        if (sql.includes("sqlite_master")) {
          return { async first() { return { name: "portal_user_journey_state" }; } };
        }

        return {
          bind() {
            return {
              async all() {
                return {
                  results: [{
                    id: "user-2",
                    name: "Grace",
                    email: "grace@example.com",
                    avatarUrl: "",
                    team: "AI Adoption",
                    department: "Platform",
                    jobTitle: "Engineer",
                    journeyLevelKey: null
                  }]
                };
              }
            };
          }
        };
      }
    };
    const api = createUsersApi(makeDeps());
    const [user] = await api.readUserBatch({
      request: new Request("https://portal.test/api/users/batch?ids=user-2"),
      env: { DB: db }
    });

    assert.equal(user.journeyLevelKey, undefined);
  });

  it("does not demote the last active admin", async () => {
    const state = { writes: 0 };
    const db = {
      prepare(sql) {
        return {
          bind(...bindings) {
            state.lastBindings = bindings;
            return {
              async first() {
                if (sql.includes("SELECT COUNT(*) AS count")) {
                  return { count: 0 };
                }

                return { id: "admin-1", role: "admin", status: "active" };
              },
              async run() {
                state.writes += 1;
              }
            };
          }
        };
      }
    };
    const api = createUsersApi(makeDeps());

    await assert.rejects(
      () => api.updateAdminUserRole({
        request: new Request("https://portal.test/api/admin/users/admin-1/role", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "member" })
        }),
        env: { DB: db }
      }, "admin-1"),
      (error) => error.status === 400 && error.message === "last_admin_required"
    );
    assert.equal(state.writes, 0);
  });

  it("persists multiple assigned roles while keeping the legacy IT admin role", async () => {
    const state = { batches: [] };
    const profileRow = {
      id: "user-2",
      name: "Grace",
      email: "grace@example.com",
      avatarUrl: "",
      role: "admin",
      roles: "admin,community_admin",
      status: "active",
      team: "Platform",
      journeyLevelKey: "newcomer",
      journeyTotalPoints: 0,
      journeyBadgeCount: 0
    };
    const db = {
      prepare(sql) {
        const base = {
          async first() {
            if (sql.includes("sqlite_master")) return { name: sql.includes("user_roles") ? "user_roles" : "portal_user_journey_state" };
            return null;
          },
          bind(...bindings) {
            return {
              bindings,
              sql,
              async first() {
                if (/SELECT\s+id,\s+role,\s+status\s+FROM users/s.test(sql)) return { id: "user-2", role: "member", status: "active" };
                if (sql.includes("FROM users") && sql.includes("JOIN teams")) return profileRow;
                return null;
              }
            };
          }
        };
        return base;
      },
      async batch(statements) {
        state.batches.push(statements);
        return statements.map(() => ({ success: true }));
      }
    };
    const api = createUsersApi(makeDeps());
    const updated = await api.updateAdminUserRole({
      request: new Request("https://portal.test/api/admin/users/user-2/roles", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roles: ["admin", "community_admin"] })
      }),
      env: { DB: db }
    }, "user-2");

    assert.deepEqual(updated.roles, ["admin", "community_admin"]);
    assert.equal(updated.role, "admin");
    assert.equal(state.batches[0].filter((statement) => statement.sql.includes("INSERT INTO user_roles")).length, 2);
    assert.deepEqual(state.batches[0].at(-1).bindings, ["admin", "user-2"]);
  });

  it("syncs Platform Admin role changes to the Auth Worker", async () => {
    let captured;
    const synced = await syncAuthUserRole({
      AUTH_SERVICE_TOKEN: "portal-service-token",
      AUTH_WORKER_URL: "https://auth.example.com/"
    }, "user/2", "admin", async (input, init) => {
      captured = { input: String(input), init };
      return Response.json({ user: { id: "user/2", role: "admin" } });
    });

    assert.equal(synced, true);
    assert.equal(captured.input, "https://auth.example.com/v1/admin/users/user%2F2/role");
    assert.equal(captured.init.method, "PATCH");
    assert.equal(captured.init.headers.authorization, "Bearer portal-service-token");
    assert.deepEqual(JSON.parse(captured.init.body), { role: "admin" });
  });

  it("serves the authenticated versioned avatar endpoint from the stored profile image", async () => {
    const avatarUrl = "data:image/png;base64,SGVsbG8=";
    const db = {
      prepare(sql) {
        assert.match(sql, /SELECT avatar_url AS avatarUrl/);
        return {
          bind(userId) {
            assert.equal(userId, "user-2");
            return { first: async () => ({ avatarUrl }) };
          }
        };
      }
    };
    const api = createUsersApi(makeDeps());
    const versionedUrl = cacheableUserAvatarUrl("user-2", avatarUrl);
    const response = await api.readUserAvatar({
      env: { DB: db },
      request: new Request(`https://portal.test${versionedUrl}`)
    }, "user-2");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.equal(await response.text(), "Hello");
  });

  it("rejects a partial admin inventory when the configured identity directory fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network_timeout"); };
    const db = { prepare() { return { bind() { return this; }, async first() { return undefined; }, async all() { return { results: [] }; } }; } };
    try {
      await assert.rejects(() => loadMergedAdminUsers(db, { avatarUrl: false, departmentId: false, departmentPathJson: false }, {
        AUTH_SERVICE_TOKEN: "service-token", AUTH_WORKER_URL: "https://auth.example.com"
      }, makeDeps()), { status: 503, message: "admin_users_source_unavailable" });
      assert.deepEqual(await loadMergedAdminUsers(db, { avatarUrl: false, departmentId: false, departmentPathJson: false }, {}, makeDeps()), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports unavailable Auth Worker users to its caller", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network_timeout");
    };

    try {
      const users = await loadAuthWorkerAdminUsers({
        AUTH_SERVICE_TOKEN: "service-token",
        AUTH_WORKER_URL: "https://auth.example.com"
      }, makeDeps());

      assert.equal(users, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
