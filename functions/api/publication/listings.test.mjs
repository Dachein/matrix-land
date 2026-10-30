import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { readPublicationListings } from "../catalog/readModels.ts";
import { createPublicationListingsApi } from "./listings.ts";
import { cacheableCatalogImageUrl } from "../catalog/coverImage.ts";
import { normalizeAssetImageUrl } from "../portalContent.ts";

const adminUser = {
  id: "admin-1",
  name: "Ada",
  email: "ada@example.com",
  team: "AI Adoption",
  role: "admin",
  identity: {
    provider: "microsoft_entra_id",
    objectId: "oid-1",
    tenantId: "tenant-1"
  }
};

const currentUser = {
  id: "user-1",
  name: "Grace",
  email: "grace@example.com",
  team: "AI Adoption",
  department: "Group / Investment",
  departmentId: "dept-investment",
  departmentPath: ["dept-group", "dept-investment"],
  role: "member",
  identity: {
    provider: "microsoft_entra_id",
    objectId: "oid-2",
    tenantId: "tenant-1"
  }
};

function makeDeps(overrides = {}) {
  const auditEvents = [];
  const categoryCalls = [];

  return {
    auditEvents,
    categoryCalls,
    async audit(_db, actorType, actorId, action, targetType, targetId, metadata) {
      auditEvents.push({ actorType, actorId, action, targetType, targetId, metadata });
      return "audit-1";
    },
    async currentUserTeamId() {
      return "team-ai-adoption";
    },
    async catalogCoverColumns() {
      return {
        appCatalogMetadata: false,
        publicationListings: false,
        skillCatalogMetadata: false
      };
    },
    async ensureCategory(_db, value) {
      categoryCalls.push(value);
      return `category-${String(value).toLowerCase()}`;
    },
    getTtlSeconds() {
      return 900;
    },
    httpError(status, message) {
      return Object.assign(new Error(message), { status });
    },
    appsOrgContext() {
      return { orgId: "example-org", orgSlug: "workspace-wealth" };
    },
    appsWorkerBaseUrl() {
      return "https://apps.example.com";
    },
    normalizeAssetImageUrl(value) {
      return typeof value === "string" ? value.trim() : "";
    },
    optionalText(value, maxLength) {
      return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
    },
    async readBody(request) {
      return request.headers.get("content-type")?.includes("json") ? request.json() : {};
    },
    async readAppsPublicationAuthorIndex() {
      return { appIds: [], skillIds: [] };
    },
    async readAppsPublicationAuthors() {
      throw Object.assign(new Error("apps_author_projection_unavailable"), { status: 502 });
    },
    async readAppsPublicationHubAccessIndex() {
      return { appIds: ["app-1"], skillIds: ["skill-1"] };
    },
    async readAppsPublicationSource() {
      throw Object.assign(new Error("apps_asset_not_found"), { status: 404 });
    },
    async requireAdminPortalUser() {
      return adminUser;
    },
    requireDb(db) {
      return db;
    },
    requireText(value, errorCode, maxLength) {
      const text = typeof value === "string" ? value.trim() : "";
      if (!text) {
        throw Object.assign(new Error(errorCode), { status: 400 });
      }
      return text.slice(0, maxLength);
    },
    async resolveCurrentUser() {
      return currentUser;
    },
    async signAppsToken(_env, payload) {
      return `signed:${payload.typ}:${payload.skill_id}:${payload.listing_id}`;
    },
    sanitizeTags(value) {
      return Array.isArray(value)
        ? [...new Set(value.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 8)
        : [];
    },
    async userProfileColumns() {
      return {
        avatarUrl: false,
        departmentId: false,
        departmentPathJson: false
      };
    },
    ...overrides
  };
}

function makeDb(options = {}) {
  const state = {
    allCalls: [],
    batches: [],
    firstCalls: [],
    runs: [],
    outbox: new Map(),
    listingDesiredStatus: options.listing?.desiredStatus ?? options.listing?.status,
    listingEffectiveStatus: options.listing?.effectiveStatus ?? options.listing?.status
  };
  const db = {
    state,
    prepare(sql) {
      return {
        bind(...bindings) {
          const bound = {
            bindings,
            sql,
            async first() {
              state.firstCalls.push({ sql, bindings });

              if (sql.includes("SELECT desired_status AS desiredStatus")) {
                return options.listing
                  ? { desiredStatus: state.listingDesiredStatus }
                  : null;
              }

              if (sql.includes("FROM publication_publication_outbox")) {
                if (sql.includes("WHERE id = ?")) {
                  return state.outbox.get(bindings[0]) ?? null;
                }
                return [...state.outbox.values()]
                  .filter((job) => job.listingId === bindings[0] && ["pending", "failed"].includes(job.state))
                  .at(-1) ?? null;
              }

              if (sql.includes("FROM publication_installations")) {
                return options.existingInstall ?? null;
              }

              if (sql.includes("FROM publication_listings")) {
                return options.listing ?? null;
              }

              if (sql.includes("FROM apps")) {
                return options.app ?? null;
              }

              if (sql.includes("FROM publication_versions")) {
                return options.publicationVersion ?? null;
              }

              if (sql.includes("FROM users")) {
                return options.userById?.[bindings[0]] ?? null;
              }

              return null;
            },
            async all() {
              state.allCalls.push({ sql, bindings });

              if (sql.includes("SELECT id, listing_type AS listingType")) {
                return { results: options.publicationCandidates ?? [] };
              }

              if (sql.includes("AS submittedById")) {
                const currentUserId = bindings[1];
                const role = bindings[2];
                const additionalAuthorListingIds = new Set(bindings.slice(3));
                const includeAllListed = sql.includes("effective_status = 'listed'");
                const results = (options.publicationListingRows ?? []).filter((row) => (
                  (row.targetPlane !== "apps" && row.submittedById === currentUserId)
                  || role === "admin"
                  || additionalAuthorListingIds.has(row.id)
                  || (includeAllListed && row.status === "listed")
                ));
                return {
                  results: results.map((row) => ({
                    ...row,
                    desiredStatus: row.desiredStatus ?? row.status,
                    effectiveStatus: row.effectiveStatus ?? row.status
                  }))
                };
              }

              if (sql.includes("FROM apps")) {
                return { results: options.portalAppRows ?? [] };
              }

              if (sql.includes("FROM skills")) {
                return { results: options.portalSkillRows ?? [] };
              }

              if (sql.includes("FROM users")) {
                return { results: options.ownerProfileRows ?? [] };
              }

              return { results: [] };
            },
            async run() {
              state.runs.push({ sql, bindings });
              if (sql.includes("UPDATE publication_publication_outbox") && sql.includes("state = 'processing'")) {
                const job = state.outbox.get(bindings[2]);
                if (!job || !["pending", "failed", "processing"].includes(job.state)) {
                  return { success: true, meta: { changes: 0 } };
                }
                job.state = "processing";
                job.attemptCount += 1;
                job.leaseToken = bindings[0];
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 1 } };
            }
          };

          return bound;
        }
      };
    },
    async batch(statements) {
      state.batches.push(statements);
      statements.forEach((statement) => {
        const { sql, bindings } = statement;
        if (sql.includes("UPDATE publication_listings") && sql.includes("desired_status = ?")) {
          state.listingDesiredStatus = bindings[1];
        } else if (sql.includes("UPDATE publication_listings") && sql.includes("desired_status = 'deleted'")) {
          state.listingDesiredStatus = "deleted";
        }
        if (sql.includes("INSERT INTO publication_publication_outbox")) {
          state.outbox.set(bindings[0], {
            attemptCount: 0,
            desiredStatus: bindings[4],
            endpointPath: bindings[5],
            id: bindings[0],
            listingId: bindings[1],
            payloadJson: bindings[6],
            lastRequestId: bindings[8],
            state: "pending",
            targetId: bindings[3],
            targetKind: bindings[2]
          });
        } else if (sql.includes("UPDATE publication_publication_outbox") && sql.includes("state = 'completed'")) {
          const job = state.outbox.get(bindings[1]);
          if (job) job.state = "completed";
        } else if (sql.includes("UPDATE publication_publication_outbox") && sql.includes("state = 'failed'")) {
          const job = state.outbox.get(bindings[4]);
          if (job) job.state = "failed";
        }
        if (sql.includes("UPDATE publication_listings") && sql.includes("effective_status = ?")) {
          state.listingEffectiveStatus = bindings[0];
        }
      });
      return statements.map(() => ({ success: true }));
    }
  };

  return db;
}

function makeApiBackedSkillDb({ listingId, resourceId, targetId }) {
  return makeDb({
    listing: {
      coverImageUrl: "/assets/cover.png",
      id: listingId,
      listingType: "skill",
      targetId,
      status: "pending_review",
      listedVersionId: "market-version-1",
      reviewVersionId: "market-version-1",
      createdByUserId: "publisher-1",
      name: "Research Skill",
      visibility: "company"
    },
    publicationVersion: {
      id: "market-version-1",
      version: "1.0.0",
      configJson: JSON.stringify({
        resourceApi: {
          id: resourceId,
          name: "Research Skill API",
          baseUrl: "https://api.research.example.com",
          tools: [{ name: "research_lookup", requiredScopes: ["research:read"] }]
        }
      })
    }
  });
}

function sqliteD1(database) {
  return {
    prepare(sql) {
      return {
        bind(...bindings) {
          const statement = database.prepare(sql);
          return {
            async all() {
              return { results: statement.all(...bindings) };
            },
            async first() {
              return statement.get(...bindings) ?? null;
            },
            async run() {
              return statement.run(...bindings);
            }
          };
        }
      };
    }
  };
}

function createVersionProjectionDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../../../db/schema.sql", import.meta.url), "utf8"));
  database.exec(`
    INSERT INTO teams (id, name, slug)
    VALUES ('team-1', 'Builders', 'builders');

    INSERT INTO users (id, team_id, name, email)
    VALUES ('owner-1', 'team-1', 'Listing Owner', 'owner@example.test');

    INSERT INTO publication_listings (
      id,
      listing_type,
      target_plane,
      target_id,
      listed_version_id,
      review_version_id,
      created_by_user_id,
      name,
      slug,
      status,
      desired_status,
      effective_status,
      visibility
    ) VALUES (
      'listing-projected-app',
      'app',
      'apps',
      'app-projected',
      'apps-listed-v1',
      'apps-review-v2',
      'owner-1',
      'Projected App',
      'projected-app',
      'listed',
      'listed',
      'listed',
      'org'
    );

    INSERT INTO publication_versions (
      id,
      listing_id,
      version,
      artifact_type,
      artifact_url,
      artifact_body,
      config_json,
      changelog,
      created_by_user_id,
      created_at
    ) VALUES
      (
        'market-version-listed',
        'listing-projected-app',
        '1.0.0',
        'app_config',
        'https://artifacts.example.test/listed.json',
        '{"release":"listed"}',
        '{"versionId":"apps-listed-v1","appsVerification":{"versionId":"apps-nested-v1"},"release":"listed"}',
        'Listed release',
        'owner-1',
        '2026-07-14 09:00:00'
      ),
      (
        'market-version-review',
        'listing-projected-app',
        '1.1.0',
        'app_config',
        'https://artifacts.example.test/pending.json',
        '{"release":"pending"}',
        '{"versionId":"apps-review-v2","release":"pending"}',
        'Pending release',
        'owner-1',
        '2026-07-15 09:00:00'
      );
  `);
  return database;
}

describe("publication listings service", () => {
  it("lets a current APPS author request deletion while retaining a reconciliable tombstone", async () => {
    const db = makeDb({
      listing: {
        id: "listing-apps-app",
        listingType: "app",
        targetPlane: "apps",
        targetId: "app-1",
        createdByUserId: "user-1",
        status: "listed"
      }
    });
    const authorizationCalls = [];
    const deps = makeDeps({
      async readAppsPublicationSource(_context, user, targetType, targetId) {
        authorizationCalls.push({ userId: user.id, targetType, targetId });
        return { builderSnapshot: {}, verification: {} };
      }
    });
    const api = createPublicationListingsApi(deps);

    const result = await api.deletePublicationListing({
      request: new Request("https://portal.test/api/listings/listing-apps-app", { method: "DELETE" }),
      env: { DB: db }
    }, "listing-apps-app");

    assert.deepEqual(result, {
      deleted: true,
      listingId: "listing-apps-app",
      listingType: "app",
      targetId: "app-1"
    });
    assert.equal(db.state.batches.length, 2);
    assert.equal(db.state.runs.length, 1);
    assert.match(db.state.runs[0].sql, /UPDATE publication_publication_outbox/);
    assert.equal(db.state.batches[0].length, 3);
    assert.match(db.state.batches[0][0].sql, /desired_status = 'deleted'/);
    assert.equal(
      db.state.batches.flat().some((batch) => batch.sql.includes("DELETE FROM publication_listings")),
      false
    );
    assert.deepEqual(authorizationCalls, [{
      userId: "user-1",
      targetType: "app",
      targetId: "app-1"
    }]);
    assert.equal(deps.auditEvents.length, 1);
    assert.equal(deps.auditEvents[0].action, "deleted publication listing");
    assert.equal(deps.auditEvents[0].metadata.desiredStatus, "deleted");
    assert.equal(deps.auditEvents[0].metadata.authPublicationStatus, "failed");
    assert.match(deps.auditEvents[0].metadata.publicationJobId, /^market-pub-/);
  });

  it("revokes a Portal App projection in Auth before deleting its listing", async () => {
    const db = makeDb({
      listing: {
        id: "listing-portal-app",
        listingType: "app",
        targetPlane: "portal",
        targetId: "app-portal",
        createdByUserId: "user-1",
        status: "listed"
      },
      app: {
        id: "app-portal",
        name: "Portal App",
        status: "listed",
        sdkStatus: "connected",
        launchUrl: "https://app.example.test",
        callbackUrl: "https://app.example.test/auth/workspace/callback",
        accessMode: "public",
        accessTargetsJson: "[]",
        usesWorkspaceAuth: 1,
        publisherUserId: "user-1",
        businessOwnerUserId: null
      }
    });
    const fetchCalls = [];
    const deps = makeDeps({
      async fetch(input, init) {
        fetchCalls.push({ input, init });
        return new Response("{}", { status: 201 });
      }
    });
    const api = createPublicationListingsApi(deps);

    const result = await api.deletePublicationListing({
      request: new Request("https://portal.test/api/listings/listing-portal-app", {
        method: "DELETE",
        headers: { "x-request-id": "delete-portal-app-1" }
      }),
      env: {
        DB: db,
        AUTH_WORKER_URL: "https://auth.workspace.internal",
        AUTH_SERVICE_TOKEN: "service-token"
      }
    }, "listing-portal-app");

    assert.equal(result.deleted, true);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].input, "https://auth.workspace.internal/v1/admin/apps");
    assert.equal(fetchCalls[0].init.headers["x-request-id"], "delete-portal-app-1");
    assert.equal(JSON.parse(fetchCalls[0].init.body).status, "deleted");
    assert.deepEqual(deps.auditEvents[0].metadata.authSync, {
      appId: "app-portal",
      status: "deleted",
      synced: true
    });
  });

  it("rejects a former APPS author even when they originally submitted the listing", async () => {
    const db = makeDb({
      listing: {
        id: "listing-apps-app",
        listingType: "app",
        targetPlane: "apps",
        targetId: "app-1",
        createdByUserId: "user-1",
        status: "listed"
      }
    });
    const authorizationCalls = [];
    const api = createPublicationListingsApi(makeDeps({
      async readAppsPublicationSource(_context, user, targetType, targetId) {
        authorizationCalls.push({ userId: user.id, targetType, targetId });
        throw Object.assign(new Error("apps_asset_not_found"), { status: 404 });
      }
    }));

    await assert.rejects(
      () => api.deletePublicationListing({
        request: new Request("https://portal.test/api/listings/listing-apps-app", { method: "DELETE" }),
        env: { DB: db }
      }, "listing-apps-app"),
      (error) => error.status === 403 && error.message === "listing_delete_forbidden"
    );
    assert.equal(db.state.batches.length, 0);
    assert.deepEqual(authorizationCalls, [{
      userId: "user-1",
      targetType: "app",
      targetId: "app-1"
    }]);
  });

  it("allows a APPS coauthor to delete the shared listing", async () => {
    const db = makeDb({
      listing: {
        id: "listing-apps-skill",
        listingType: "skill",
        targetPlane: "apps",
        targetId: "skill-1",
        createdByUserId: "owner-1",
        status: "pending_review"
      }
    });
    const authorizationCalls = [];
    const deps = makeDeps({
      async readAppsPublicationSource(_context, user, targetType, targetId) {
        authorizationCalls.push({ userId: user.id, targetType, targetId });
        return { builderSnapshot: {}, verification: {} };
      }
    });
    const api = createPublicationListingsApi(deps);

    const result = await api.deletePublicationListing({
      request: new Request("https://portal.test/api/listings/listing-apps-skill", { method: "DELETE" }),
      env: { DB: db }
    }, "listing-apps-skill");

    assert.equal(result.deleted, true);
    assert.equal(db.state.batches.length, 2);
    assert.deepEqual(authorizationCalls, [{
      userId: "user-1",
      targetType: "skill",
      targetId: "skill-1"
    }]);
  });

  it("shows an unlisted APPS submission to a verified coauthor", async () => {
    const pendingRows = [
      {
        id: "listing-shared-app",
        type: "app",
        targetPlane: "apps",
        targetId: "app-shared",
        submittedById: "owner-1",
        name: "Shared App",
        status: "pending_review",
        visibility: "company"
      },
      {
        id: "listing-private-skill",
        type: "skill",
        targetPlane: "apps",
        targetId: "skill-private",
        submittedById: "owner-2",
        name: "Someone Else's Skill",
        status: "pending_review",
        visibility: "company"
      }
    ];
    const db = makeDb({
      publicationCandidates: pendingRows.map((row) => ({
        id: row.id,
        listingType: row.type,
        targetId: row.targetId
      })),
      publicationListingRows: pendingRows
    });
    const authorIndexCalls = [];
    const api = createPublicationListingsApi(makeDeps({
      async readAppsPublicationAuthorIndex(_context, user) {
        authorIndexCalls.push(user.id);
        return { appIds: ["app-shared"], skillIds: [] };
      }
    }));

    const result = await api.listPublicationListings({
      request: new Request("https://portal.test/api/listings"),
      env: { DB: db }
    });

    assert.deepEqual(result.publicationListings.map((listing) => listing.id), ["listing-shared-app"]);
    const listingRead = db.state.allCalls.find((call) => call.sql.includes("AS submittedById"));
    assert.ok(listingRead);
    assert.match(listingRead.sql, /publication_listings\.id IN \(\?\)/);
    assert.deepEqual(listingRead.bindings.slice(3), ["listing-shared-app"]);
    assert.deepEqual(authorIndexCalls, ["user-1"]);
    const candidateRead = db.state.allCalls.find((call) => call.sql.includes("SELECT id, listing_type AS listingType"));
    assert.ok(candidateRead);
    assert.doesNotMatch(candidateRead.sql, /created_by_user_id/);
    assert.deepEqual(candidateRead.bindings, []);
  });

  it("hides a submitted APPS listing after the submitter loses live author rights", async () => {
    const db = makeDb({
      publicationCandidates: [{
        id: "listing-former-author",
        listingType: "app",
        targetId: "app-former-author"
      }],
      publicationListingRows: [{
        id: "listing-former-author",
        type: "app",
        targetPlane: "apps",
        targetId: "app-former-author",
        submittedById: "user-1",
        name: "Former Author App",
        status: "pending_review",
        visibility: "company"
      }]
    });
    const api = createPublicationListingsApi(makeDeps({
      async readAppsPublicationAuthorIndex() {
        return { appIds: [], skillIds: [] };
      }
    }));

    const result = await api.listPublicationListings({
      request: new Request("https://portal.test/api/listings"),
      env: { DB: db }
    });

    assert.deepEqual(result.publicationListings, []);
    const listingRead = db.state.allCalls.find((call) => call.sql.includes("AS submittedById"));
    assert.ok(listingRead);
    assert.match(listingRead.sql, /target_plane, 'portal'\) != 'apps'/);
    const candidateRead = db.state.allCalls.find((call) => call.sql.includes("SELECT id, listing_type AS listingType"));
    assert.ok(candidateRead);
    assert.deepEqual(candidateRead.bindings, []);
  });

  it("keeps another author's unlisted APPS submission hidden", async () => {
    const db = makeDb({
      publicationCandidates: [{
        id: "listing-not-mine",
        listingType: "app",
        targetId: "app-not-mine"
      }],
      publicationListingRows: [{
        id: "listing-not-mine",
        type: "app",
        targetPlane: "apps",
        targetId: "app-not-mine",
        submittedById: "owner-2",
        name: "Not Mine",
        status: "pending_review",
        visibility: "company"
      }]
    });
    const api = createPublicationListingsApi(makeDeps());

    const result = await api.listPublicationListings({
      request: new Request("https://portal.test/api/listings"),
      env: { DB: db }
    });

    assert.deepEqual(result.publicationListings, []);
    const listingRead = db.state.allCalls.find((call) => call.sql.includes("AS submittedById"));
    assert.ok(listingRead);
    assert.doesNotMatch(listingRead.sql, /publication_listings\.id IN/);
    assert.deepEqual(listingRead.bindings, ["user-1", "user-1", "member"]);
  });

  it("resolves listed APPS authors from the live App instead of the Listing snapshot", async () => {
    const db = makeDb({
      publicationListingRows: [{
        category: "Workflow",
        comments: 0,
        configJson: JSON.stringify({
          builderSnapshot: {
            appsVerified: {
              app: {
                ownerUserId: "stale-owner@example.com",
                collaboratorUserIds: []
              }
            }
          }
        }),
        description: "Shared app",
        id: "listing-shared-app",
        installs: 0,
        name: "Shared App",
        ownerAliasName: "",
        rating: 0,
        status: "listed",
        submittedById: "submitter-1",
        summary: "Shared app",
        tagsJson: "[]",
        targetId: "app-shared",
        targetPlane: "apps",
        type: "app",
        updatedAt: "2026-07-14",
        visibility: "company"
      }],
      ownerProfileRows: [
        { id: "owner-1", name: "Ivy Lin", email: "owner@example.com", team: "AI" },
        { id: "collaborator-1", name: "Ada Zhang", email: "collaborator@example.com", team: "AI" }
      ]
    });
    const authorCalls = [];
    const api = createPublicationListingsApi(makeDeps({
      async readAppsPublicationHubAccessIndex() {
        return { appIds: ["app-shared"], skillIds: [] };
      },
      async readAppsPublicationAuthors(_context, user, targetType, targetId) {
        authorCalls.push({ userId: user.id, targetType, targetId });
        return {
          ownerUserId: "owner@example.com",
          collaboratorUserIds: ["collaborator@example.com"]
        };
      }
    }));

    const result = await api.listHubPublicationListings({
      request: new Request("https://portal.test/api/listings"),
      env: { DB: db }
    });

    assert.deepEqual(result.hubListings[0].ownerProfiles.map((profile) => profile.name), ["Ivy Lin", "Ada Zhang"]);
    assert.equal(result.hubListings[0].submittedByProfile, undefined);
    assert.deepEqual(authorCalls, [{
      userId: "user-1",
      targetType: "app",
      targetId: "app-shared"
    }]);
  });

  it("uses live APPS authors for listed entries in the management listing response", async () => {
    const db = makeDb({
      publicationCandidates: [{
        id: "listing-shared-skill",
        listingType: "skill",
        targetId: "skill-shared"
      }],
      publicationListingRows: [{
        configJson: JSON.stringify({
          builderSnapshot: {
            appsVerified: {
              skill: {
                ownerUserId: "stale-owner@example.com",
                collaboratorUserIds: ["stale-collaborator@example.com"]
              }
            }
          }
        }),
        id: "listing-shared-skill",
        type: "skill",
        targetPlane: "apps",
        targetId: "skill-shared",
        submittedById: "user-1",
        name: "Shared Skill",
        status: "listed",
        visibility: "company"
      }],
      ownerProfileRows: [
        { id: "owner-live", name: "Live Owner", email: "live-owner@example.com" },
        { id: "collaborator-live", name: "Live Collaborator", email: "live-collaborator@example.com" }
      ]
    });
    const api = createPublicationListingsApi(makeDeps({
      async readAppsPublicationAuthorIndex() {
        return { appIds: [], skillIds: ["skill-shared"] };
      },
      async readAppsPublicationAuthors() {
        return {
          ownerUserId: "live-owner@example.com",
          collaboratorUserIds: ["live-collaborator@example.com"]
        };
      }
    }));

    const result = await api.listPublicationListings({
      request: new Request("https://portal.test/api/publication/listings"),
      env: { DB: db }
    });

    assert.deepEqual(
      result.publicationListings[0].ownerProfiles.map((profile) => profile.name),
      ["Live Owner", "Live Collaborator"]
    );
  });

  it("returns a compact admin review view with all lifecycle states and current authors", async () => {
    const cover = "https://cdn.example.com/review-cover.png";
    const draft = { nameZh: "Review App", accessMode: "targeted", accessTargets: ["team-1"], permissionNotes: "Owner only", coverImageUrl: cover, screenshots: [cover] };
    const rows = ["listed", "pending_review", "delisted"].map((status, index) => ({
      id: `review-${index}`, type: "app", targetPlane: "apps", targetId: `app-${index}`,
      name: `Review ${index}`, status, desiredStatus: status, effectiveStatus: status,
      listedVersionId: "released-1", reviewVersionId: "review-2", coverImageUrl: cover,
      configJson: JSON.stringify({ reviewDraft: draft, builderSnapshot: { appsVerified: { app: { ownerUserId: "snapshot@example.com", deployments: [{ source: "x".repeat(100_000) }] } } } })
    }));
    const db = makeDb({ publicationListingRows: rows });
    const calls = [];
    const api = createPublicationListingsApi(makeDeps({
      async resolveCurrentUser() { throw new Error("review must require admin"); },
      async readAppsPublicationAuthorIndex() { throw new Error("admin must see all listings"); },
      async readAppsPublicationAuthors(_context, _user, type, id) {
        calls.push([type, id]);
        return { ownerUserId: "live@example.com", collaboratorUserIds: [] };
      }
    }));
    const result = await api.listPublicationListings({ request: new Request("https://portal.test/api/publication/listings?view=review"), env: { DB: db } });
    assert.equal(result.publicationListings.length, 3);
    assert.deepEqual(result.publicationListings.map((listing) => listing.status), ["listed", "pending_review", "delisted"]);
    assert.deepEqual(calls, [["app", "app-0"]]);
    assert.equal(result.publicationListings[0].ownerProfiles[0].email, "live@example.com");
    assert.equal(result.publicationListings[1].ownerProfiles[0].email, "snapshot@example.com");
    for (const listing of result.publicationListings) {
      assert.deepEqual(listing.config, { reviewDraft: draft });
      assert.equal(listing.listedVersionId, "released-1");
      assert.equal(listing.reviewVersionId, "review-2");
    }
    assert.ok(JSON.stringify(result).length < 10_000);
    const query = db.state.allCalls.find((call) => call.sql.includes("AS submittedById"));
    assert.equal(query.bindings[2], "admin");
  });

  it("requires admin authorization before reading the review view", async () => {
    const api = createPublicationListingsApi(makeDeps({
      async requireAdminPortalUser() { throw Object.assign(new Error("admin_required"), { status: 403 }); },
      async resolveCurrentUser() { throw new Error("must not use member scope"); },
      async catalogCoverColumns() { throw new Error("must not query data before authorization"); }
    }));
    await assert.rejects(() => api.listPublicationListings({ request: new Request("https://portal.test/api/publication/listings?view=review"), env: { DB: makeDb() } }), { status: 403, message: "admin_required" });
  });

  it("fails closed instead of falling back to stale Listing authors when the live APPS read fails", async () => {
    const db = makeDb({
      publicationCandidates: [{
        id: "listing-live-read-failed",
        listingType: "app",
        targetId: "app-live-read-failed"
      }],
      publicationListingRows: [{
        configJson: JSON.stringify({
          builderSnapshot: {
            appsVerified: {
              app: {
                ownerUserId: "stale-owner@example.com",
                collaboratorUserIds: ["stale-collaborator@example.com"]
              }
            }
          }
        }),
        id: "listing-live-read-failed",
        type: "app",
        targetPlane: "apps",
        targetId: "app-live-read-failed",
        submittedById: "user-1",
        name: "Unavailable Live App",
        status: "listed",
        visibility: "company"
      }]
    });
    const api = createPublicationListingsApi(makeDeps({
      async readAppsPublicationAuthorIndex() {
        return { appIds: ["app-live-read-failed"], skillIds: [] };
      }
    }));

    await assert.rejects(
      () => api.listPublicationListings({
        request: new Request("https://portal.test/api/publication/listings"),
        env: { DB: db }
      }),
      (error) => error.status === 502 && error.message === "apps_author_projection_unavailable"
    );
  });

  it("resolves lifecycle pins through every supported publication version reference and fails closed", async () => {
    const database = createVersionProjectionDatabase();
    const db = sqliteD1(database);
    const userColumns = { avatarUrl: false, departmentId: false, departmentPathJson: false };
    const coverColumns = { appCatalogMetadata: false, publicationListings: false, skillCatalogMetadata: false };
    const readProjectedListing = async () => (await readPublicationListings(
      db,
      adminUser,
      userColumns,
      coverColumns,
      [],
      { attachOwnerProfiles: false }
    ))[0];

    try {
      for (const reference of [
        "market-version-listed",
        "1.0.0",
        "apps-listed-v1",
        "apps-nested-v1"
      ]) {
        database.prepare(`
          UPDATE publication_listings
          SET status = 'listed', listed_version_id = ?, review_version_id = 'apps-review-v2'
          WHERE id = 'listing-projected-app'
        `).run(reference);
        const listing = await readProjectedListing();
        assert.equal(listing.config.release, "listed", `listed pin ${reference}`);
        assert.equal(listing.artifactUrl, "https://artifacts.example.test/listed.json");
      }

      database.exec(`
        UPDATE publication_listings
        SET status = 'delisted', listed_version_id = 'apps-nested-v1', review_version_id = 'apps-review-v2'
        WHERE id = 'listing-projected-app'
      `);
      assert.equal((await readProjectedListing()).config.release, "listed");

      database.exec(`
        UPDATE publication_listings
        SET status = 'pending_review', review_version_id = 'apps-review-v2'
        WHERE id = 'listing-projected-app'
      `);
      assert.equal((await readProjectedListing()).config.release, "pending");

      for (const invalidPin of ["missing-version", ""]) {
        database.prepare(`
          UPDATE publication_listings
          SET status = 'listed', listed_version_id = ?
          WHERE id = 'listing-projected-app'
        `).run(invalidPin);
        const listing = await readProjectedListing();
        assert.deepEqual(listing.config, {});
        assert.equal(listing.artifactType, undefined);
        assert.equal(listing.artifactUrl, undefined);
      }
    } finally {
      database.close();
    }
  });

  it("keeps a newer pending version out of listed Hub config, artifact metadata, and downloads", async () => {
    const database = createVersionProjectionDatabase();
    const db = sqliteD1(database);
    const api = createPublicationListingsApi(makeDeps({
      async readAppsPublicationAuthors() {
        return { ownerUserId: "owner-1", collaboratorUserIds: [] };
      },
      async readAppsPublicationHubAccessIndex() {
        return { appIds: ["app-projected"], skillIds: [] };
      },
      async resolveCurrentUser() {
        return adminUser;
      }
    }));

    try {
      const { hubListings } = await api.listHubPublicationListings({
        request: new Request("https://portal.test/api/publication/hub"),
        env: { DB: db }
      });

      assert.equal(hubListings.length, 1);
      assert.equal(hubListings[0].config.release, "listed");
      assert.equal(hubListings[0].artifactUrl, "https://artifacts.example.test/listed.json");

      const response = await api.downloadPublicationListing({
        request: new Request("https://portal.test/api/listings/listing-projected-app/download"),
        env: { DB: db }
      }, "listing-projected-app");

      assert.equal(await response.text(), '{"release":"listed"}');
    } finally {
      database.close();
    }
  });

  it("uses one live APPS access index for Hub discovery and does not let admins bypass it", async () => {
    const db = makeDb({
      publicationListingRows: [
        { id: "listing-visible-app", type: "app", targetPlane: "apps", targetId: "app-visible", submittedById: "owner-1", status: "listed" },
        { id: "listing-delisting-app", type: "app", targetPlane: "apps", targetId: "app-visible", submittedById: "owner-1", status: "listed", desiredStatus: "delisted" },
        { id: "listing-hidden-app", type: "app", targetPlane: "apps", targetId: "app-hidden", submittedById: "admin-1", status: "listed" },
        { id: "listing-visible-skill", type: "skill", targetPlane: "apps", targetId: "skill-visible", submittedById: "owner-2", status: "listed" },
        { id: "listing-pending", type: "skill", targetPlane: "apps", targetId: "skill-visible", submittedById: "admin-1", status: "pending_review" }
      ]
    });
    const accessCalls = [];
    const authorCalls = [];
    const api = createPublicationListingsApi(makeDeps({
      async readAppsPublicationHubAccessIndex(_context, user) {
        accessCalls.push(user.id);
        return { appIds: ["app-visible"], skillIds: ["skill-visible"] };
      },
      async readAppsPublicationAuthors(_context, _user, targetType, targetId) {
        authorCalls.push(`${targetType}:${targetId}`);
        return { ownerUserId: `owner-${targetId}`, collaboratorUserIds: [] };
      },
      async resolveCurrentUser() {
        return adminUser;
      }
    }));

    const result = await api.listHubPublicationListings({
      request: new Request("https://portal.test/api/publication/hub-listings"),
      env: { DB: db }
    });

    assert.deepEqual(result.hubListings.map((listing) => listing.id), [
      "listing-visible-app",
      "listing-visible-skill"
    ]);
    assert.deepEqual(accessCalls, ["admin-1"]);
    assert.deepEqual(authorCalls, ["app:app-visible", "skill:skill-visible"]);
  });

  it("filters legacy Portal targets with current App and Skill consumer access", async () => {
    const db = makeDb({
      publicationListingRows: [
        { id: "listing-targeted-app", type: "app", targetPlane: "portal", targetId: "app-targeted", submittedById: "owner-1", status: "listed" },
        { id: "listing-hidden-app", type: "app", targetPlane: "portal", targetId: "app-hidden", submittedById: "owner-2", status: "listed" },
        { id: "listing-company-skill", type: "skill", targetPlane: "portal", targetId: "skill-company", submittedById: "owner-3", status: "listed" },
        { id: "listing-private-skill", type: "skill", targetPlane: "portal", targetId: "skill-private", submittedById: "user-1", status: "listed" }
      ],
      portalAppRows: [
        { id: "app-targeted", accessMode: "targeted", accessTargetsJson: JSON.stringify(["department:dept-group"]) },
        { id: "app-hidden", accessMode: "targeted", accessTargetsJson: JSON.stringify(["department:dept-other"]) }
      ],
      portalSkillRows: [
        { id: "skill-company", ownerTeamId: "team-other", visibility: "internal" },
        { id: "skill-private", ownerTeamId: "team-ai-adoption", visibility: "private" }
      ]
    });
    let appsAccessCalled = false;
    const api = createPublicationListingsApi(makeDeps({
      async readAppsPublicationHubAccessIndex() {
        appsAccessCalled = true;
        return { appIds: [], skillIds: [] };
      }
    }));

    const result = await api.listHubPublicationListings({
      request: new Request("https://portal.test/api/publication/hub-listings"),
      env: { DB: db }
    });

    assert.deepEqual(result.hubListings.map((listing) => listing.id), [
      "listing-targeted-app",
      "listing-company-skill"
    ]);
    assert.equal(appsAccessCalled, false);
  });

  it("filters the home Hub projection before resolving App access", async () => {
    const db = makeDb({
      publicationListingRows: [
        { id: "listing-home", type: "app", targetPlane: "portal", targetId: "app-home", submittedById: "owner-1", status: "listed" },
        { id: "listing-other", type: "app", targetPlane: "portal", targetId: "app-other", submittedById: "owner-2", status: "listed" },
        { id: "listing-skill", type: "skill", targetPlane: "portal", targetId: "skill-home", submittedById: "owner-3", status: "listed" }
      ],
      portalAppRows: [
        { id: "app-home", accessMode: "public", accessTargetsJson: "[]" },
        { id: "app-other", accessMode: "public", accessTargetsJson: "[]" }
      ],
      portalSkillRows: [
        { id: "skill-home", ownerTeamId: "team-ai-adoption", visibility: "company" }
      ]
    });
    const api = createPublicationListingsApi(makeDeps());

    const result = await api.listHubPublicationListings({
      request: new Request("https://portal.test/api/publication/hub-listings?ids=app-home&type=app"),
      env: { DB: db }
    });

    assert.deepEqual(result.hubListings.map((listing) => listing.id), ["listing-home"]);
    const listingQuery = db.state.allCalls.find((call) => call.sql.includes("AS submittedById"));
    const appAccessQuery = db.state.allCalls.find((call) => call.sql.includes("access_mode AS accessMode"));
    assert.match(listingQuery.sql, /target_id IN \(\?\)/);
    assert.deepEqual(listingQuery.bindings.slice(1, 3), ["app-home", "app"]);
    assert.match(appAccessQuery.sql, /id IN \(\?\)/);
    assert.deepEqual(appAccessQuery.bindings, ["app-home"]);
    assert.equal(db.state.allCalls.some((call) => call.sql.includes("owner_team_id AS ownerTeamId")), false);
  });

  it("keeps coauthor management listings available without exposing unrelated listed records", async () => {
    const db = makeDb({
      publicationCandidates: [
        {
          id: "listing-verification-unavailable",
          listingType: "app",
          targetId: "app-verification-unavailable"
        },
        {
          id: "listing-shared-skill",
          listingType: "skill",
          targetId: "skill-shared"
        }
      ],
      publicationListingRows: [
        {
          id: "listing-verification-unavailable",
          type: "app",
          targetPlane: "apps",
          targetId: "app-verification-unavailable",
          submittedById: "owner-2",
          name: "Pending App",
          status: "pending_review",
          visibility: "company"
        },
        {
          id: "listing-shared-skill",
          type: "skill",
          targetPlane: "apps",
          targetId: "skill-shared",
          submittedById: "owner-4",
          name: "Shared Skill",
          status: "pending_review",
          visibility: "company"
        },
        {
          id: "listing-public",
          type: "skill",
          targetPlane: "apps",
          targetId: "skill-public",
          submittedById: "owner-3",
          name: "Public Skill",
          status: "listed",
          visibility: "company"
        }
      ]
    });
    const api = createPublicationListingsApi(makeDeps({
      async readAppsPublicationAuthorIndex() {
        return { appIds: [], skillIds: ["skill-shared"] };
      }
    }));

    const result = await api.listPublicationListings({
      request: new Request("https://portal.test/api/listings"),
      env: { DB: db }
    });

    assert.deepEqual(result.publicationListings.map((listing) => listing.id), ["listing-shared-skill"]);
    const candidateRead = db.state.allCalls.find((call) => call.sql.includes("SELECT id, listing_type AS listingType"));
    assert.ok(candidateRead);
    assert.doesNotMatch(candidateRead.sql, /\bLIMIT\b/);
  });

  it("does not truncate coauthor visibility after the fortieth pending APPS listing", async () => {
    const publicationCandidates = Array.from({ length: 41 }, (_, index) => ({
      id: `listing-${index}`,
      listingType: "app",
      targetId: `app-${index}`
    }));
    const publicationListingRows = publicationCandidates.map((candidate, index) => ({
      id: candidate.id,
      type: "app",
      targetPlane: "apps",
      targetId: candidate.targetId,
      submittedById: `owner-${index}`,
      name: `Pending App ${index}`,
      status: "pending_review",
      visibility: "company"
    }));
    const db = makeDb({ publicationCandidates, publicationListingRows });
    const api = createPublicationListingsApi(makeDeps({
      async readAppsPublicationAuthorIndex() {
        return { appIds: ["app-40"], skillIds: [] };
      }
    }));

    const result = await api.listPublicationListings({
      request: new Request("https://portal.test/api/listings"),
      env: { DB: db }
    });

    assert.deepEqual(result.publicationListings.map((listing) => listing.id), ["listing-40"]);
    const candidateRead = db.state.allCalls.find((call) => call.sql.includes("SELECT id, listing_type AS listingType"));
    assert.ok(candidateRead);
    assert.doesNotMatch(candidateRead.sql, /\bLIMIT\b/);
  });

  it("preserves source covers when App and Skill reviews return accelerated URLs", async () => {
    for (const listingType of ["app", "skill"]) {
      const image = "data:image/png;base64,SGVsbG8=";
      const targetId = `${listingType}-1`;
      const db = makeDb({ listing: {
        id: "listing-1", listingType, targetId, targetPlane: "apps",
        coverImageUrl: image, status: "pending_review", name: "Review",
        description: "Review description", tagsJson: "[]", visibility: "org"
      } });
      await createPublicationListingsApi(makeDeps({ normalizeAssetImageUrl }))
        .updatePublicationListingStatus({
          request: new Request("https://portal.test/api/listings/listing-1/status", {
            method: "PATCH", headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "listed", riskLevel: "low",
              coverImageUrl: cacheableCatalogImageUrl(listingType, targetId, image) })
          }), env: { DB: db }
        }, "listing-1");
      const update = db.state.batches.flat().find((statement) => statement.sql.includes("UPDATE publication_listings"));
      assert.ok(update.bindings.includes(image));
      assert.ok(!update.bindings.some((value) => typeof value === "string" && value.startsWith("/api/assets/")));
    }
  });

  it("rejects accelerated covers for another asset or a stale image version", async () => {
    const image = "data:image/png;base64,SGVsbG8=";
    for (const coverImageUrl of [
      cacheableCatalogImageUrl("skill", "other-skill", image),
      cacheableCatalogImageUrl("skill", "skill-1", "data:image/png;base64,V29ybGQ=")
    ]) {
      const db = makeDb({ listing: { id: "listing-1", listingType: "skill", targetId: "skill-1",
        coverImageUrl: image, status: "pending_review" } });
      await assert.rejects(createPublicationListingsApi(makeDeps({ normalizeAssetImageUrl }))
        .updatePublicationListingStatus({ request: new Request("https://portal.test/api/listings/listing-1/status", {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "pending_review", coverImageUrl })
        }), env: { DB: db } }, "listing-1"), /invalid_cover_image_url/);
      assert.equal(db.state.batches.length, 0);
    }
  });

  it("syncs the selected APPS Skill review visibility, including private and targeted scopes", async () => {
    for (const [previous, requested, expected] of [["private", undefined, "private"], ["team", undefined, "team"], ["org", "private", "private"], ["org", "team", "team"], ["private", "org", "org"], ["company", undefined, "org"]]) {
      const db = makeDb({ listing: {
        id: "listing-1", listingType: "skill", targetId: "skill-1", targetPlane: "apps",
        coverImageUrl: "/assets/cover.png", status: "pending_review", name: "Review",
        description: "Review description", tagsJson: "[]", visibility: previous
      } });
      const calls = [];
      const result = await createPublicationListingsApi(makeDeps({
        async syncAppsSkillVisibility(_ctx, user, id, visibility) { calls.push({ user, id, visibility }); }
      })).updatePublicationListingStatus({
        request: new Request("https://portal.test/api/listings/listing-1/status", {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "listed", riskLevel: "low", ...(requested ? { visibility: requested } : {}) })
        }), env: { DB: db }
      }, "listing-1");
      assert.equal(result.status, "listed");
      assert.equal(calls.length, 1, `${previous} -> ${requested}`);
      assert.deepEqual(calls[0], { user: adminUser, id: "skill-1", visibility: expected });
    }
  });

  it("updates listing review status and writes an audit event", async () => {
    const db = makeDb({
      listing: {
        coverImageUrl: "/assets/cover.png",
        categoryId: "category-research",
        description: "Old description",
        id: "listing-1",
        listingType: "skill",
        name: "Old name",
        reviewNotes: "",
        summary: "Old summary",
        tagsJson: "[]",
        targetId: "skill-1",
        status: "pending_review",
        visibility: "company"
      }
    });
    const deps = makeDeps();
    const api = createPublicationListingsApi(deps);

    const result = await api.updatePublicationListingStatus({
      request: new Request("https://portal.test/api/listings/listing-1/status", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "listed",
          riskLevel: "medium",
          category: "设计创作",
          reviewNote: " Ready to publish ",
          name: "中文标点全角规范化",
          ownerAliasName: "  Workspace Typography Lab  ",
          summary: "统一中英文排版标点。",
          description: "规范中文全角标点及中英文之间的排版关系。",
          coverImageUrl: "/assets/new-cover.png",
          tags: ["Skill", "CJK", "Office"],
          visibility: "team"
        })
      }),
      env: { DB: db }
    }, "listing-1");

    assert.deepEqual(result, {
      listingId: "listing-1",
      status: "listed",
      riskLevel: "medium",
      category: "Design",
      reviewNote: "Ready to publish"
    });
    const listingUpdate = db.state.batches[0].find((statement) => (
      statement.sql.includes("UPDATE publication_listings")
      && statement.sql.includes("desired_status = ?")
    ));
    assert.ok(listingUpdate);
    assert.deepEqual(listingUpdate.bindings, [
      "listed",
      "listed",
      "medium",
      "中文标点全角规范化",
      "Workspace Typography Lab",
      "统一中英文排版标点。",
      "规范中文全角标点及中英文之间的排版关系。",
      "/assets/new-cover.png",
      "category-design",
      '["skill","cjk","office"]',
      "team",
      "Ready to publish",
      "listed",
      "listed",
      "listing-1"
    ]);
    assert.deepEqual(deps.auditEvents[0], {
      actorType: "user",
      actorId: "admin-1",
      action: "set publication listing status",
      targetType: "publication_listing",
      targetId: "listing-1",
      metadata: {
        status: "listed",
        riskLevel: "medium",
        category: "Design",
        reviewNote: "Ready to publish",
        editedFields: ["name", "ownerAliasName", "summary", "description", "coverImageUrl", "tags", "visibility"],
        coverChanged: true,
        listingType: "skill",
        targetId: "skill-1",
        effectiveStatus: "listed",
        publicationJobId: deps.auditEvents[0].metadata.publicationJobId
      }
    });
    assert.match(deps.auditEvents[0].metadata.publicationJobId, /^market-pub-/);
  });

  it("notifies the APPS submitter and owner when a pending review is approved", async () => {
    const db = makeDb({
      app: { id: "app-1", usesWorkspaceAuth: 0 },
      listing: {
        builderSnapshotJson: JSON.stringify({ appsVerified: { app: { ownerUserId: "owner-1" } } }),
        coverImageUrl: "/assets/cover.png",
        createdByUserId: "creator-1",
        description: "APPS app",
        id: "listing-app-1",
        listingType: "app",
        name: "Notification App",
        reviewVersionId: "review-version-1",
        status: "pending_review",
        summary: "Review me",
        tagsJson: "[]",
        targetId: "app-1",
        targetPlane: "apps",
        visibility: "company"
      },
      publicationVersion: { createdByUserId: "submitter-1" },
      userById: { "owner-1": { id: "owner-1" } }
    });
    const api = createPublicationListingsApi(makeDeps());

    await api.updatePublicationListingStatus({
      request: new Request("https://portal.test/api/listings/listing-app-1/status", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "listed", riskLevel: "low" })
      }),
      env: { DB: db }
    }, "listing-app-1");

    assert.equal(db.state.batches.length, 2);
    const notificationWrites = db.state.batches[0].filter((statement) => statement.sql.includes("INSERT OR IGNORE INTO notifications"));
    assert.deepEqual(notificationWrites.map((statement) => statement.bindings[1]).sort(), ["creator-1", "owner-1", "submitter-1"]);
    assert.ok(notificationWrites.every((statement) => statement.bindings[3] === "apps.review_approved"));
  });

  it("projects the reviewed listing status to Auth Worker even when apps.status is stale", async () => {
    const db = makeDb({
      listing: {
        coverImageUrl: "/assets/cover.png",
        id: "listing-app-1",
        listingType: "app",
        targetId: "app-ops",
        status: "pending_review"
      },
      app: {
        id: "app-ops",
        name: "Ops Copilot",
        status: "pending_review",
        sdkStatus: "connected",
        launchUrl: "https://ops.example.com",
        callbackUrl: "https://ops.example.com/auth/workspace/callback",
        accessMode: "targeted",
        accessTargetsJson: JSON.stringify(["department:dept-ops", "user:user-7"]),
        usesWorkspaceAuth: 1,
        publisherUserId: "publisher-1",
        businessOwnerUserId: "owner-1"
      }
    });
    const fetchCalls = [];
    const deps = makeDeps({
      async fetch(input, init) {
        fetchCalls.push({ input, init });
        return new Response(JSON.stringify({ id: "app-ops" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });
    const api = createPublicationListingsApi(deps);

    const result = await api.updatePublicationListingStatus({
      request: new Request("https://portal.test/api/listings/listing-app-1/status", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "listed",
          riskLevel: "high",
          reviewNote: " Auth ready "
        })
      }),
      env: {
        DB: db,
        AUTH_WORKER_URL: "https://auth.workspace.internal",
        AUTH_SERVICE_TOKEN: "service-token"
      }
    }, "listing-app-1");

    assert.deepEqual(result, {
      listingId: "listing-app-1",
      status: "listed",
      riskLevel: "high",
      reviewNote: "Auth ready",
      authPublicationStatus: "synced",
      authSync: {
        appId: "app-ops",
        status: "listed",
        synced: true
      }
    });
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].input, "https://auth.workspace.internal/v1/admin/apps");
    assert.equal(fetchCalls[0].init.method, "POST");
    assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer service-token");
    assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
      id: "app-ops",
      name: "Ops Copilot",
      status: "listed",
      sdkStatus: "connected",
      accessMode: "targeted",
      accessTargets: ["department:dept-ops", "user:user-7"],
      publisherUserId: "publisher-1",
      businessOwnerUserId: "owner-1",
      callbackUrls: ["https://ops.example.com/auth/workspace/callback"],
      launchUrl: "https://ops.example.com"
    });
    assert.deepEqual(deps.auditEvents[0].metadata.authSync, {
      appId: "app-ops",
      status: "listed",
      synced: true
    });
    assert.equal(deps.auditEvents[0].metadata.authPublicationStatus, "synced");
  });

  it("publishes a reviewed APPS App from its verified builder snapshot without a Portal apps row", async () => {
    const db = makeDb({
      listing: {
        builderSnapshotJson: JSON.stringify({
          appsVerified: {
            app: {
              accessTargets: [],
              collaboratorUserIds: ["collaborator-1"],
              id: "apps-academy",
              loginRequired: true,
              manifest: {
                auth: {
                  callbackUrls: { production: "https://academy.example.test/auth/workspace/callback" }
                }
              },
              name: "APPS Academy",
              ownerUserId: "owner-1",
              productionUrl: "https://academy.example.test",
              visibility: "org"
            }
          }
        }),
        coverImageUrl: "/api/forum/media/academy.webp",
        createdByUserId: "publisher-1",
        desiredStatus: "pending_review",
        effectiveStatus: "pending_review",
        id: "listing-apps-academy",
        listedVersionId: "",
        listingType: "app",
        name: "Workspace Academy",
        reviewVersionId: "0.1.0",
        status: "pending_review",
        targetId: "apps-academy",
        targetPlane: "apps",
        visibility: "company"
      }
    });
    const delivered = [];
    const deps = makeDeps({
      async fetch(input, init) {
        delivered.push({ input, payload: JSON.parse(init.body) });
        return new Response("{}", { status: 201 });
      }
    });
    const api = createPublicationListingsApi(deps);

    const result = await api.updatePublicationListingStatus({
      request: new Request("https://portal.test/api/listings/listing-apps-academy/status", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-request-id": "review-apps-academy" },
        body: JSON.stringify({ status: "listed", riskLevel: "medium" })
      }),
      env: {
        DB: db,
        AUTH_SERVICE_TOKEN: "service-token",
        AUTH_WORKER_URL: "https://auth.example.test"
      }
    }, "listing-apps-academy");

    assert.equal(result.authPublicationStatus, "synced");
    assert.deepEqual(result.authSync, {
      appId: "apps-academy",
      status: "listed",
      synced: true
    });
    assert.deepEqual(delivered, [{
      input: "https://auth.example.test/v1/admin/apps",
      payload: {
        accessMode: "public",
        accessTargets: ["user:collaborator-1"],
        businessOwnerUserId: "owner-1",
        callbackUrls: ["https://academy.example.test/auth/workspace/callback"],
        id: "apps-academy",
        launchUrl: "https://academy.example.test",
        name: "Workspace Academy",
        publisherUserId: "owner-1",
        sdkStatus: "connected",
        status: "listed"
      }
    }]);
  });

  it("returns an explicit failed publication status when Auth Worker rejects the projection", async () => {
    const db = makeDb({
      listing: {
        coverImageUrl: "/assets/cover.png",
        id: "listing-app-failed",
        listingType: "app",
        targetId: "app-failed",
        status: "pending_review"
      },
      app: {
        id: "app-failed",
        name: "Failed Projection App",
        status: "pending_review",
        sdkStatus: "connected",
        launchUrl: "https://failed.example.com",
        callbackUrl: "https://failed.example.com/auth/workspace/callback",
        accessMode: "public",
        accessTargetsJson: "[]",
        usesWorkspaceAuth: 1,
        publisherUserId: "publisher-1",
        businessOwnerUserId: "owner-1"
      }
    });
    const deps = makeDeps({
      async fetch() {
        return new Response("upstream stack contains Bearer service-token and private context", {
          status: 503,
          headers: { "x-request-id": "auth-request-503" }
        });
      }
    });
    const api = createPublicationListingsApi(deps);

    const result = await api.updatePublicationListingStatus({
      request: new Request("https://portal.test/api/listings/listing-app-failed/status", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-request-id": "portal-review-503"
        },
        body: JSON.stringify({ status: "listed", riskLevel: "high" })
      }),
      env: {
        DB: db,
        AUTH_WORKER_URL: "https://auth.workspace.internal",
        AUTH_SERVICE_TOKEN: "service-token"
      }
    }, "listing-app-failed");

    assert.equal(result.status, "listed");
    assert.equal(result.authPublicationStatus, "failed");
    assert.deepEqual(result.authSync, {
      appId: "app-failed",
      errorCode: "auth_worker_rejected_projection",
      requestId: "auth-request-503",
      status: 503,
      synced: false
    });
    assert.doesNotMatch(JSON.stringify(result), /service-token|private context|upstream stack/);
    assert.equal(deps.auditEvents[0].metadata.authPublicationStatus, "failed");
    assert.deepEqual(deps.auditEvents[0].metadata.authSync, result.authSync);
    assert.doesNotMatch(JSON.stringify(deps.auditEvents[0]), /service-token|private context|upstream stack/);
  });

  it("does not expose a raw network error through the review response or audit event", async () => {
    const db = makeDb({
      listing: {
        coverImageUrl: "/assets/cover.png",
        id: "listing-app-network-failed",
        listingType: "app",
        targetId: "app-network-failed",
        status: "pending_review"
      },
      app: {
        id: "app-network-failed",
        name: "Network Failure App",
        status: "pending_review",
        sdkStatus: "connected",
        launchUrl: "https://network-failed.example.com",
        callbackUrl: "",
        accessMode: "public",
        accessTargetsJson: "[]",
        usesWorkspaceAuth: 1,
        publisherUserId: "publisher-1",
        businessOwnerUserId: null
      }
    });
    const deps = makeDeps({
      async fetch() {
        throw new Error("socket failed while sending Bearer service-token to secret.internal");
      }
    });
    const api = createPublicationListingsApi(deps);

    const result = await api.updatePublicationListingStatus({
      request: new Request("https://portal.test/api/listings/listing-app-network-failed/status", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-request-id": "portal-network-failure-1"
        },
        body: JSON.stringify({ status: "listed", riskLevel: "high" })
      }),
      env: {
        DB: db,
        AUTH_WORKER_URL: "https://auth.workspace.internal",
        AUTH_SERVICE_TOKEN: "service-token"
      }
    }, "listing-app-network-failed");

    assert.equal(result.authPublicationStatus, "failed");
    assert.deepEqual(result.authSync, {
      appId: "app-network-failed",
      errorCode: "auth_worker_request_failed",
      requestId: "portal-network-failure-1",
      synced: false,
    });
    assert.doesNotMatch(JSON.stringify(result), /service-token|secret\.internal|socket failed/);
    assert.doesNotMatch(JSON.stringify(deps.auditEvents[0]), /service-token|secret\.internal|socket failed/);
  });

  it("returns a pending publication status when Auth Worker is not configured", async () => {
    const db = makeDb({
      listing: {
        coverImageUrl: "/assets/cover.png",
        id: "listing-app-pending",
        listingType: "app",
        targetId: "app-pending",
        status: "pending_review"
      },
      app: {
        id: "app-pending",
        name: "Pending Projection App",
        status: "pending_review",
        sdkStatus: "connected",
        launchUrl: "https://pending.example.com",
        callbackUrl: "",
        accessMode: "public",
        accessTargetsJson: "[]",
        usesWorkspaceAuth: 1,
        publisherUserId: null,
        businessOwnerUserId: null
      }
    });
    const api = createPublicationListingsApi(makeDeps());

    const result = await api.updatePublicationListingStatus({
      request: new Request("https://portal.test/api/listings/listing-app-pending/status", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "listed", riskLevel: "low" })
      }),
      env: { DB: db }
    }, "listing-app-pending");

    assert.equal(result.authPublicationStatus, "pending");
    assert.deepEqual(result.authSync, {
      appId: "app-pending",
      skipped: true,
      reason: "auth_worker_not_configured"
    });
  });

  it("syncs API-backed skill resource configuration to Auth Worker", async () => {
    const db = makeDb({
      listing: {
        coverImageUrl: "/assets/cover.png",
        id: "listing-funds",
        listingType: "skill",
        targetId: "skill-funds",
        status: "listed",
        listedVersionId: "market-version-1",
        reviewVersionId: "market-version-1",
        createdByUserId: "publisher-1",
        name: "Fund Query",
        visibility: "company"
      },
      publicationVersion: {
        id: "market-version-1",
        version: "1.0.0",
        configJson: JSON.stringify({
          resourceApi: {
            id: "resource-funds",
            name: "Fund Query API",
            baseUrl: "https://api.funds.example.com",
            audience: "https://api.funds.example.com",
            accessMode: "targeted",
            accessTargets: ["department:dept-investment"],
            tools: [
              {
                name: "fund_lookup",
                method: "POST",
                path: "/v1/lookup",
                requiredScopes: ["funds:read"]
              },
              {
                name: "fund_compare",
                method: "POST",
                path: "/v1/compare",
                scopes: ["funds:read", "funds:compare"]
              }
            ]
          }
        })
      }
    });
    const fetchCalls = [];
    const deps = makeDeps({
      async fetch(input, init) {
        fetchCalls.push({ input, init });
        return new Response(JSON.stringify({ resource: { id: "resource-funds" } }), {
          status: 201,
          headers: { "content-type": "application/json" }
        });
      }
    });
    const api = createPublicationListingsApi(deps);

    const result = await api.updatePublicationListingStatus({
      request: new Request("https://portal.test/api/listings/listing-funds/status", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "listed",
          riskLevel: "medium",
          reviewNote: "API-backed skill"
        })
      }),
      env: {
        DB: db,
        AUTH_WORKER_URL: "https://auth.workspace.internal",
        AUTH_SERVICE_TOKEN: "service-token"
      }
    }, "listing-funds");

    assert.deepEqual(result.resourceSync, {
      resourceId: "resource-funds",
      status: "listed",
      synced: true
    });
    assert.equal(result.authPublicationStatus, "synced");
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].input, "https://auth.workspace.internal/v1/admin/resources");
    assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer service-token");
    assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
      id: "resource-funds",
      name: "Fund Query API",
      status: "listed",
      audience: "https://api.funds.example.com",
      accessMode: "targeted",
      accessTargets: ["department:dept-investment"],
      allowedScopes: ["funds:read", "funds:compare"],
      publisherUserId: "publisher-1"
    });
    assert.deepEqual(deps.auditEvents[0].metadata.resourceSync, {
      resourceId: "resource-funds",
      status: "listed",
      synced: true
    });
    assert.equal(deps.auditEvents[0].metadata.authPublicationStatus, "synced");
  });

  it("returns pending publication when an API-backed Skill cannot reach an unconfigured Auth Worker", async () => {
    const db = makeApiBackedSkillDb({
      listingId: "listing-skill-pending",
      resourceId: "resource-skill-pending",
      targetId: "skill-pending"
    });
    const deps = makeDeps();
    const api = createPublicationListingsApi(deps);

    const result = await api.updatePublicationListingStatus({
      request: new Request("https://portal.test/api/listings/listing-skill-pending/status", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "listed", riskLevel: "medium" })
      }),
      env: { DB: db }
    }, "listing-skill-pending");

    assert.equal(result.authPublicationStatus, "pending");
    assert.deepEqual(result.resourceSync, {
      resourceId: "resource-skill-pending",
      skipped: true,
      reason: "auth_worker_not_configured"
    });
    assert.equal(deps.auditEvents[0].metadata.authPublicationStatus, "pending");
  });

  it("returns a safe failed publication for an API-backed Skill without exposing the Auth response body", async () => {
    const db = makeApiBackedSkillDb({
      listingId: "listing-skill-failed",
      resourceId: "resource-skill-failed",
      targetId: "skill-failed"
    });
    const deps = makeDeps({
      async fetch() {
        return new Response("resource failure includes Bearer service-token and internal stack", {
          status: 502,
          headers: { "x-request-id": "resource-request-502" }
        });
      }
    });
    const api = createPublicationListingsApi(deps);

    const result = await api.updatePublicationListingStatus({
      request: new Request("https://portal.test/api/listings/listing-skill-failed/status", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-request-id": "portal-skill-failure-1"
        },
        body: JSON.stringify({ status: "listed", riskLevel: "high" })
      }),
      env: {
        DB: db,
        AUTH_WORKER_URL: "https://auth.workspace.internal",
        AUTH_SERVICE_TOKEN: "service-token"
      }
    }, "listing-skill-failed");

    assert.equal(result.authPublicationStatus, "failed");
    assert.deepEqual(result.resourceSync, {
      resourceId: "resource-skill-failed",
      errorCode: "auth_worker_rejected_projection",
      requestId: "resource-request-502",
      status: 502,
      synced: false
    });
    assert.equal(deps.auditEvents[0].metadata.authPublicationStatus, "failed");
    assert.deepEqual(deps.auditEvents[0].metadata.resourceSync, result.resourceSync);
    assert.doesNotMatch(JSON.stringify(result), /service-token|internal stack|Bearer/);
    assert.doesNotMatch(JSON.stringify(deps.auditEvents[0]), /service-token|internal stack|Bearer/);
  });

  it("does not call Auth Worker for apps that do not use Workspace Auth", async () => {
    const db = makeDb({
      listing: {
        coverImageUrl: "/assets/cover.png",
        id: "listing-app-2",
        listingType: "app",
        targetId: "external-app",
        status: "pending_review"
      },
      app: {
        id: "external-app",
        name: "External App",
        status: "listed",
        sdkStatus: "pending",
        launchUrl: "https://external.example.com",
        callbackUrl: "",
        accessMode: "public",
        accessTargetsJson: "[]",
        usesWorkspaceAuth: 0,
        publisherUserId: null,
        businessOwnerUserId: null
      }
    });
    let fetchCalled = false;
    const deps = makeDeps({
      async fetch() {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      }
    });
    const api = createPublicationListingsApi(deps);

    const result = await api.updatePublicationListingStatus({
      request: new Request("https://portal.test/api/listings/listing-app-2/status", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "listed",
          riskLevel: "low"
        })
      }),
      env: {
        DB: db,
        AUTH_WORKER_URL: "https://auth.workspace.internal",
        AUTH_SERVICE_TOKEN: "service-token"
      }
    }, "listing-app-2");

    assert.equal(fetchCalled, false);
    assert.deepEqual(result.authSync, {
      appId: "external-app",
      skipped: true,
      reason: "workspace_auth_disabled"
    });
    assert.equal(result.authPublicationStatus, "not_required");
  });

  it("rejects unknown listing review statuses instead of normalizing them to pending review", async () => {
    const db = makeDb();
    const api = createPublicationListingsApi(makeDeps());

    await assert.rejects(
      () => api.updatePublicationListingStatus({
        request: new Request("https://portal.test/api/listings/listing-1/status", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "reviewing" })
        }),
        env: { DB: db }
      }, "listing-1"),
      (error) => error.status === 400 && error.message === "invalid_listing_status"
    );
    assert.equal(db.state.firstCalls.length, 0);
    assert.equal(db.state.runs.length, 0);
  });

  it("rejects manual listed-to-pending transitions because resubmission owns re-review", async () => {
    const db = makeDb({
      listing: {
        id: "listing-1",
        listingType: "skill",
        targetId: "skill-1",
        status: "listed"
      }
    });
    const api = createPublicationListingsApi(makeDeps());

    await assert.rejects(
      () => api.updatePublicationListingStatus({
        request: new Request("https://portal.test/api/listings/listing-1/status", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "pending_review" })
        }),
        env: { DB: db }
      }, "listing-1"),
      (error) => error.status === 409 && error.message === "invalid_listing_status_transition"
    );
    assert.equal(db.state.firstCalls.length, 1);
    assert.equal(db.state.runs.length, 0);
  });

  it("lets a APPS author delist a published listing", async () => {
    const db = makeDb({
      listing: {
        createdByUserId: currentUser.id,
        id: "listing-app-1",
        listingType: "app",
        riskLevel: "high",
        targetId: "app-1",
        targetPlane: "apps",
        status: "listed"
      }
    });
    const deps = makeDeps({
      async readAppsPublicationSource() {
        return { id: "app-1" };
      }
    });
    const api = createPublicationListingsApi(deps);

    const result = await api.updatePublicationListingStatus({
      request: new Request("https://portal.test/api/listings/listing-app-1/status", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "delisted" })
      }),
      env: { DB: db }
    }, "listing-app-1");

    assert.equal(result.status, "delisted");
    assert.equal(result.riskLevel, "high");
    assert.equal(db.state.batches[0][0].bindings[1], "delisted");
    assert.equal(deps.auditEvents[0].actorId, currentUser.id);
    assert.equal(deps.auditEvents[0].metadata.status, "delisted");
  });

  it("rejects delisting by a user who cannot access the APPS source", async () => {
    const db = makeDb({
      listing: {
        createdByUserId: "publisher-2",
        id: "listing-app-1",
        listingType: "app",
        targetId: "app-1",
        targetPlane: "apps",
        status: "listed"
      }
    });
    const api = createPublicationListingsApi(makeDeps());

    await assert.rejects(
      () => api.updatePublicationListingStatus({
        request: new Request("https://portal.test/api/listings/listing-app-1/status", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "delisted" })
        }),
        env: { DB: db }
      }, "listing-app-1"),
      (error) => error.status === 403 && error.message === "listing_status_update_forbidden"
    );
    assert.equal(db.state.batches.length, 0);
  });

  it("requires a new review submission before a delisted listing can be listed again", async () => {
    const db = makeDb({
      listing: {
        coverImageUrl: "/assets/cover.png",
        id: "listing-1",
        listingType: "app",
        targetId: "app-1",
        status: "delisted"
      }
    });
    const api = createPublicationListingsApi(makeDeps());

    await assert.rejects(
      () => api.updatePublicationListingStatus({
        request: new Request("https://portal.test/api/listings/listing-1/status", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "listed", riskLevel: "low" })
        }),
        env: { DB: db }
      }, "listing-1"),
      (error) => error.status === 409 && error.message === "invalid_listing_status_transition"
    );
    assert.equal(db.state.batches.length, 0);
  });

  it("requires explicit risk level when listing a publication item", async () => {
    const db = makeDb({
      listing: {
        id: "listing-1",
        listingType: "skill",
        targetId: "skill-1",
        status: "pending_review"
      }
    });
    const api = createPublicationListingsApi(makeDeps());

    await assert.rejects(
      () => api.updatePublicationListingStatus({
        request: new Request("https://portal.test/api/listings/listing-1/status", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "listed" })
        }),
        env: { DB: db }
      }, "listing-1"),
      (error) => error.status === 400 && error.message === "missing_review_risk_level"
    );
    assert.equal(db.state.firstCalls.length, 0);
    assert.equal(db.state.runs.length, 0);
  });

  it("requires a valid cover before listing a publication item", async () => {
    const db = makeDb({
      listing: {
        id: "listing-1",
        listingType: "skill",
        targetId: "skill-1",
        status: "pending_review"
      }
    });
    const api = createPublicationListingsApi(makeDeps());

    await assert.rejects(
      () => api.updatePublicationListingStatus({
        request: new Request("https://portal.test/api/listings/listing-1/status", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "listed", riskLevel: "low" })
        }),
        env: { DB: db }
      }, "listing-1"),
      (error) => error.status === 400 && error.message === "missing_valid_cover_image"
    );
    assert.equal(db.state.firstCalls.length, 1);
    assert.equal(db.state.runs.length, 0);
  });

  it("records every Add to Agent click while keeping legacy installation uniqueness", async () => {
    const db = makeDb({
      listing: {
        id: "listing-1",
        name: "Research Skill",
        listingType: "skill",
        targetPlane: "apps",
        targetId: "skill-1",
        status: "listed"
      },
      existingInstall: { id: "install-1" }
    });
    const deps = makeDeps();
    const api = createPublicationListingsApi(deps);

    for (let click = 0; click < 2; click += 1) {
      const result = await api.recordPublicationInteraction({
        request: new Request("https://portal.test/api/publication/interactions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "skill.add_to_agent",
            listingId: "listing-1",
            source: "publication_detail",
            targetId: "skill-1",
            version: "1.1.0"
          })
        }),
        env: { DB: db }
      });

      assert.deepEqual(result, {
        action: "skill.add_to_agent",
        listingId: "listing-1",
        recorded: true
      });
    }

    assert.equal(db.state.runs.filter(({ sql }) => sql.includes("agent_add_count")).length, 2);
    assert.equal(db.state.batches.length, 0);
    assert.deepEqual(deps.auditEvents.map((event) => event.action), [
      "skill.add_to_agent",
      "skill.add_to_agent"
    ]);
    assert.equal(deps.auditEvents[0].actorId, "user-1");
    assert.equal(deps.auditEvents[0].metadata.source, "publication_detail");
    assert.equal(deps.auditEvents[0].metadata.targetId, "skill-1");
  });

  it("records App URL visits by target id without creating downloads or installs", async () => {
    const db = makeDb({
      listing: {
        id: "listing-app-1",
        listingType: "app",
        targetPlane: "apps",
        targetId: "app-1",
        status: "listed"
      }
    });
    const deps = makeDeps();
    const api = createPublicationListingsApi(deps);

    const result = await api.recordPublicationInteraction({
      request: new Request("https://portal.test/api/publication/interactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "app.visit_url",
          source: "home_shortcut",
          targetId: "app-1"
        })
      }),
      env: { DB: db }
    });

    assert.deepEqual(result, {
      action: "app.visit_url",
      listingId: "listing-app-1",
      recorded: true
    });
    assert.equal(db.state.runs.filter(({ sql }) => sql.includes("visit_count")).length, 1);
    assert.equal(db.state.batches.length, 0);
    assert.equal(deps.auditEvents[0].action, "app.visit_url");
    assert.equal(deps.auditEvents[0].metadata.source, "home_shortcut");
  });

  it("returns existing installations without writing duplicate rows", async () => {
    const db = makeDb({
      listing: {
        id: "listing-1",
        name: "Research Skill",
        listingType: "skill",
        targetPlane: "apps",
        targetId: "skill-1",
        status: "listed"
      },
      existingInstall: { id: "install-1" }
    });
    const deps = makeDeps();
    const api = createPublicationListingsApi(deps);

    const result = await api.installPublicationListing({
      request: new Request("https://portal.test/api/listings/listing-1/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installType: "bookmark" })
      }),
      env: { DB: db }
    }, "listing-1");

    assert.deepEqual(result, {
      id: "install-1",
      listingId: "listing-1",
      installed: false,
      message: "already_installed"
    });
    assert.equal(db.state.batches.length, 0);
    assert.equal(deps.auditEvents.length, 0);
  });

  it("creates a new installation and increments listing install count", async () => {
    const db = makeDb({
      listing: {
        id: "listing-1",
        name: "Research Skill",
        listingType: "skill",
        targetPlane: "apps",
        targetId: "skill-1",
        status: "listed"
      }
    });
    const refreshedUserIds = [];
    const deps = makeDeps({
      refreshUserJourneyState: async (_db, userId) => {
        refreshedUserIds.push(userId);
      }
    });
    const api = createPublicationListingsApi(deps);

    const result = await api.installPublicationListing({
      request: new Request("https://portal.test/api/listings/listing-1/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installType: "team", version: "1.1.0" })
      }),
      env: { DB: db }
    }, "listing-1");

    assert.equal(result.listingId, "listing-1");
    assert.equal(result.installed, true);
    assert.match(result.id, /^[0-9a-f-]{36}$/);
    assert.equal(db.state.batches.length, 1);
    assert.equal(db.state.batches[0].length, 2);
    assert.deepEqual(db.state.batches[0][0].bindings, [
      result.id,
      "listing-1",
      "user-1",
      "team-ai-adoption",
      "1.1.0",
      "team"
    ]);
    assert.deepEqual(db.state.batches[0][1].bindings, ["listing-1"]);
    assert.equal(deps.auditEvents[0].action, "installed publication listing");
    assert.equal(deps.auditEvents[0].metadata.installId, result.id);
    assert.equal(deps.auditEvents[0].metadata.installType, "team");
    assert.deepEqual(refreshedUserIds, ["user-1"]);
  });

  it("downloads listed APPS Skill packages through a publication-scoped token", async () => {
    const db = makeDb({
      listing: {
        id: "listing-skill-1",
        name: "Research Skill",
        listingType: "skill",
        targetPlane: "apps",
        targetId: "skill-1",
        status: "listed",
        version: "1.1.0",
        versionConfigJson: JSON.stringify({
          versionId: "skv-latest-1"
        })
      }
    });
    const fetchCalls = [];
    const deps = makeDeps({
      async fetch(input, init) {
        fetchCalls.push({ input, init });
        return new Response("zip-bytes", {
          headers: {
            "content-disposition": "attachment; filename=\"research-skill-1.1.0.zip\"",
            "content-type": "application/zip"
          }
        });
      }
    });
    const api = createPublicationListingsApi(deps);

    const response = await api.downloadPublicationListing({
      request: new Request("https://portal.test/api/listings/listing-skill-1/download"),
      env: { DB: db, PORTAL_ISSUER: "portal" }
    }, "listing-skill-1");

    assert.equal(fetchCalls[0].input, "https://apps.example.com/skills/skill-1/versions/skv-latest-1/download.zip");
    assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer signed:publication_access:skill-1:listing-skill-1");
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.equal(response.headers.get("content-disposition"), "attachment; filename=\"research-skill-1.1.0.zip\"");
    assert.equal(await response.text(), "zip-bytes");
    assert.equal(db.state.runs.filter(({ sql }) => sql.includes("zip_download_count")).length, 1);
    assert.equal(deps.auditEvents[0].action, "skill.download_zip");
    assert.equal(deps.auditEvents[0].metadata.source, "publication_detail");
  });

  it("returns not found for direct install and download attempts outside live Hub access", async () => {
    const db = makeDb({
      listing: {
        id: "listing-hidden-skill",
        name: "Hidden Skill",
        listingType: "skill",
        targetPlane: "apps",
        targetId: "skill-hidden",
        status: "listed",
        version: "1.0.0",
        versionConfigJson: JSON.stringify({ versionId: "skv-hidden" })
      }
    });
    let artifactFetched = false;
    const api = createPublicationListingsApi(makeDeps({
      async fetch() {
        artifactFetched = true;
        return new Response("should-not-fetch");
      },
      async readAppsPublicationHubAccessIndex() {
        return { appIds: [], skillIds: [] };
      }
    }));
    const context = { request: new Request("https://portal.test"), env: { DB: db } };

    await assert.rejects(
      () => api.installPublicationListing({
        ...context,
        request: new Request("https://portal.test/api/listings/listing-hidden-skill/install", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ installType: "user" })
        })
      }, "listing-hidden-skill"),
      (error) => error.status === 404 && error.message === "listing_not_found"
    );
    await assert.rejects(
      () => api.downloadPublicationListing({
        ...context,
        request: new Request("https://portal.test/api/listings/listing-hidden-skill/download")
      }, "listing-hidden-skill"),
      (error) => error.status === 404 && error.message === "listing_not_found"
    );

    assert.equal(artifactFetched, false);
    assert.equal(db.state.batches.length, 0);
  });

  it("lets administrators download pending APPS Skill packages for review without recording an install", async () => {
    const db = makeDb({
      listing: {
        id: "listing-skill-review",
        name: "Pending Skill",
        listingType: "skill",
        targetPlane: "apps",
        targetId: "skill-review",
        status: "pending_review",
        version: "1.0.0",
        versionConfigJson: JSON.stringify({ versionId: "skv-review-1" })
      }
    });
    const fetchCalls = [];
    const deps = makeDeps({
      async fetch(input, init) {
        fetchCalls.push({ input, init });
        return new Response("review-zip", { headers: { "content-type": "application/zip" } });
      },
      async resolveCurrentUser() {
        return adminUser;
      }
    });
    const api = createPublicationListingsApi(deps);

    const response = await api.downloadPublicationListing({
      request: new Request("https://portal.test/api/listings/listing-skill-review/download"),
      env: { DB: db, PORTAL_ISSUER: "portal" }
    }, "listing-skill-review");

    assert.equal(fetchCalls[0].input, "https://apps.example.com/skills/skill-review/versions/skv-review-1/download.zip");
    assert.equal(await response.text(), "review-zip");
    assert.equal(db.state.batches.length, 0);
  });

  it("rejects pending Skill package downloads by non-administrators", async () => {
    const db = makeDb({
      listing: {
        id: "listing-skill-review",
        listingType: "skill",
        status: "pending_review"
      }
    });
    const api = createPublicationListingsApi(makeDeps());

    await assert.rejects(
      () => api.downloadPublicationListing({
        request: new Request("https://portal.test/api/listings/listing-skill-review/download"),
        env: { DB: db }
      }, "listing-skill-review"),
      (error) => error.status === 409 && error.message === "listing_not_listed"
    );
    assert.equal(db.state.batches.length, 0);
  });

  it("rejects installs for unlisted publication items", async () => {
    const db = makeDb({
      listing: {
        id: "listing-1",
        name: "Research Skill",
        listingType: "skill",
        status: "pending_review"
      }
    });
    const api = createPublicationListingsApi(makeDeps());

    await assert.rejects(
      () => api.installPublicationListing({
        request: new Request("https://portal.test/api/listings/listing-1/install", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ installType: "user" })
        }),
        env: { DB: db }
      }, "listing-1"),
      (error) => error.status === 409 && error.message === "listing_not_listed"
    );
    assert.equal(db.state.batches.length, 0);
  });
});

describe("Home application presentation settings", () => {
  function request(body) {
    return new Request("https://portal.test/api/listings/listing-app/home-display", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
  }

  it("saves recommendation in the same batch as approval and preserves it when omitted", async () => {
    for (const homeDisplay of ["recommended", "normal", undefined]) {
      const db = makeDb({ listing: { id: "listing-app", listingType: "app", targetId: "app-1", status: "pending_review", visibility: "org", coverImageUrl: "/assets/cover.png" } });
      const deps = makeDeps();
      await createPublicationListingsApi(deps).updatePublicationListingStatus({
        env: { DB: db }, request: new Request("https://portal.test/api/listings/listing-app/status", {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "listed", riskLevel: "low", homeDisplay })
        })
      }, "listing-app");
      const updates = db.state.batches[0].filter((statement) => statement.sql.includes("SET home_display"));
      assert.equal(updates.length, homeDisplay === undefined ? 0 : 1);
      if (homeDisplay !== undefined) assert.deepEqual(updates[0].bindings, [homeDisplay, "listing-app"]);
      assert.equal(deps.auditEvents.at(-1).metadata.homeDisplay, homeDisplay);
    }
  });

  it("rejects review recommendations for non-public scope, Skills and malformed values before any write", async () => {
    for (const [listingType, visibility, homeDisplay] of [
      ["app", "private", "recommended"], ["app", "team", "recommended"],
      ["skill", "org", "recommended"], ["app", "org", ["recommended"]], ["app", "org", true]
    ]) {
      const db = makeDb({ listing: { id: "listing-app", listingType, targetId: "app-1", status: "pending_review", visibility, coverImageUrl: "/assets/cover.png" } });
      await assert.rejects(() => createPublicationListingsApi(makeDeps()).updatePublicationListingStatus({
        env: { DB: db }, request: new Request("https://portal.test/api/listings/listing-app/status", {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "listed", riskLevel: "low", homeDisplay })
        })
      }, "listing-app"), { status: 400 });
      assert.equal(db.state.batches.length, 0);
    }
  });

  it("requires admin permission before reading or changing settings", async () => {
    const db = makeDb();
    const api = createPublicationListingsApi(makeDeps({
      async requireAdminPortalUser() { throw Object.assign(new Error("admin_required"), { status: 403 }); }
    }));
    await assert.rejects(() => api.updateHomeApplicationDisplay({ env: { DB: db }, request: request({ display: "recommended" }) }, "listing-app"), { status: 403 });
    assert.equal(db.state.firstCalls.length, 0);
    assert.equal(db.state.runs.length, 0);
  });

  it("persists display independently of publication, permissions, versions, and content update time", async () => {
    const db = makeDb({ listing: { id: "listing-app", type: "app" } });
    const deps = makeDeps();
    const result = await createPublicationListingsApi(deps).updateHomeApplicationDisplay({
      env: { DB: db }, request: request({ display: "hidden" })
    }, "listing-app");
    assert.deepEqual(result, { listingId: "listing-app", homeDisplay: "hidden" });
    assert.deepEqual(db.state.runs[0].bindings, ["hidden", "listing-app"]);
    assert.doesNotMatch(db.state.runs[0].sql, /updated_at|visibility|status|version/i);
    assert.equal(deps.auditEvents[0].actorId, adminUser.id);
    assert.deepEqual(deps.auditEvents[0].metadata, { display: "hidden" });
  });

  it("rejects invalid states, coercible types and non-App listings", async () => {
    const api = createPublicationListingsApi(makeDeps());
    for (const body of [{ display: "bad" }, { display: ["normal"] }, { display: 1 }, {}]) {
      await assert.rejects(() => api.updateHomeApplicationDisplay({ env: { DB: makeDb() }, request: request(body) }, "listing-app"), { status: 400 });
    }
    for (const listing of [undefined, { id: "skill", type: "skill" }]) {
      await assert.rejects(() => api.updateHomeApplicationDisplay({ env: { DB: makeDb({ listing }) }, request: request({ display: "normal" }) }, "listing-app"), { status: 404 });
    }
  });

  it("groups Hub apps using live source access scope even when published configuration is stale", async () => {
    const db = makeDb({ publicationListingRows: [
      { id: "listing-public", type: "app", targetPlane: "apps", targetId: "public", status: "listed", visibility: "org" },
      { id: "listing-targeted", type: "app", targetPlane: "apps", targetId: "targeted", status: "listed", visibility: "org" }
    ] });
    const api = createPublicationListingsApi(makeDeps({
      async readAppsPublicationHubAccessIndex() { return { appIds: ["public", "targeted"], publicAppIds: ["public"], skillIds: [] }; },
      async readAppsPublicationAuthors() { return { ownerUserId: "owner", collaboratorUserIds: [] }; }
    }));
    const result = await api.listHubPublicationListings({ env: { DB: db }, request: new Request("https://portal.test/api/publication/hub-listings?type=app") });
    assert.deepEqual(result.hubListings.map((listing) => [listing.targetId, listing.homeScope]), [["public", "public"], ["targeted", "exclusive"]]);
  });
});
