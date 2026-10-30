import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPublicationAssetsApi } from "./assets.ts";
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

function makeDeps(overrides = {}) {
  const auditEvents = [];
  const categoryCalls = [];

  return {
    auditEvents,
    categoryCalls,
    assertHttpUrl(value, errorCode) {
      try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error(errorCode);
        }
        return url;
      } catch {
        throw Object.assign(new Error(errorCode), { status: 400 });
      }
    },
    async audit(_db, actorType, actorId, action, targetType, targetId, metadata) {
      auditEvents.push({ actorType, actorId, action, targetType, targetId, metadata });
      return "audit-1";
    },
    async ensureCategory(_db, value) {
      categoryCalls.push(value);
      return `category-${String(value).toLowerCase()}`;
    },
    httpError(status, message) {
      return Object.assign(new Error(message), { status });
    },
    normalizeAssetImageUrl(value) {
      return String(value ?? "").trim();
    },
    optionalText(value, maxLength) {
      return String(value ?? "").trim().slice(0, maxLength);
    },
    async readBody(request) {
      return request.headers.get("content-type")?.includes("json") ? request.json() : {};
    },
    async requireAdminPortalUser() {
      return adminUser;
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
    sanitizeTags(value) {
      return Array.isArray(value)
        ? [...new Set(value.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 8)
        : [];
    },
    ...overrides
  };
}

function makeDb(options = {}) {
  const state = {
    batches: [],
    firstCalls: [],
    runs: []
  };
  const db = {
    state,
    prepare(sql) {
      return {
        bind(...bindings) {
          const statement = {
            sql,
            bindings,
            async first() {
              state.firstCalls.push({ sql, bindings });

              if (sql.includes("FROM apps")) {
                return sql.includes("uses_workspace_auth")
                  ? options.authApp ?? options.app ?? null
                  : options.app ?? null;
              }
              if (sql.includes("FROM skills")) {
                return options.skill ?? null;
              }
              if (sql.includes("FROM publication_listings")) {
                return options.listing ?? null;
              }
              if (sql.includes("FROM publication_versions")) {
                return options.publicationVersion ?? null;
              }
              if (sql.includes("FROM mcp_servers")) {
                return options.mcp ?? null;
              }

              return null;
            },
            async run() {
              state.runs.push({ sql, bindings });
              return { success: true };
            }
          };

          return statement;
        }
      };
    },
    async batch(statements) {
      state.batches.push(statements);
      return statements.map(() => ({ success: true }));
    }
  };

  return db;
}

describe("publication assets service", () => {
  it("restores accelerated covers in both legacy App metadata and listing edits", async () => {
    const image = "data:image/png;base64,SGVsbG8=";
    const coverImageUrl = cacheableCatalogImageUrl("app", "app-1", image);
    const db = makeDb({ app: { id: "app-1", status: "pending_review", coverImageUrl: image } });
    await createPublicationAssetsApi(makeDeps({ normalizeAssetImageUrl })).updateAssetLifecycleStatus({
      request: new Request("https://portal.test/api/assets/app/app-1/status", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "pending_review", name: "App", description: "Description", coverImageUrl,
          app: { nameZh: "App", description: "Description", launchUrl: "https://app.example.com", coverImageUrl } })
      }), env: { DB: db }
    }, "app", "app-1");
    const values = db.state.batches.flat().flatMap((statement) => statement.bindings);
    assert.ok(values.includes(image));
    assert.ok(!values.includes(coverImageUrl));
    assert.ok(values.includes(JSON.stringify([image])));
  });

  it("updates an app with review metadata across app, catalog, and listing rows", async () => {
    const db = makeDb({
      app: { id: "app-1", status: "pending_review" },
      authApp: {
        id: "app-1",
        name: "Research App",
        status: "listed",
        sdkStatus: "connected",
        launchUrl: "https://app.example.com/start",
        callbackUrl: "https://app.example.com/callback",
        accessMode: "targeted",
        accessTargetsJson: JSON.stringify(["department:dept-research"]),
        usesWorkspaceAuth: 1,
        publisherUserId: "publisher-1",
        businessOwnerUserId: "owner-1"
      }
    });
    const fetchCalls = [];
    const deps = makeDeps({
      async fetch(input, init) {
        fetchCalls.push({ input, init });
        return new Response(JSON.stringify({ id: "app-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });
    const api = createPublicationAssetsApi(deps);

    const result = await api.updateAssetLifecycleStatus({
      request: new Request("https://portal.test/api/assets/app/app-1/status", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "listed",
          riskLevel: "medium",
          category: "金融投研",
          reviewNote: " Approved ",
          app: {
            nameEn: "Research App",
            subtitle: "Research intelligence",
            description: "Research app description",
            launchUrl: "https://app.example.com/start",
            callbackUrl: "https://app.example.com/callback",
            coverImageUrl: "/assets/research.png",
            accessMode: "targeted",
            accessTargets: ["management"],
            usesWorkspaceAuth: true,
            version: "2.0.0"
          }
        })
      }),
      env: {
        DB: db,
        AUTH_WORKER_URL: "https://auth.workspace.internal/",
        AUTH_SERVICE_TOKEN: "service-token"
      }
    }, "app", "app-1");

    assert.deepEqual(result, {
      targetType: "app",
      targetId: "app-1",
      status: "listed",
      riskLevel: "medium",
      reviewNote: "Approved",
      category: "Finance",
      authSync: {
        appId: "app-1",
        status: "listed",
        synced: true
      }
    });
    assert.equal(db.state.firstCalls.length, 2);
    assert.match(db.state.firstCalls[0].sql, /FROM apps/);
    assert.match(db.state.firstCalls[1].sql, /uses_workspace_auth/);
    assert.equal(db.state.batches.length, 1);
    assert.equal(db.state.batches[0].length, 3);
    assert.deepEqual(db.state.batches[0][0].bindings.slice(0, 14), [
      "listed",
      "medium",
      "Approved",
      "Approved",
      "Research App",
      "",
      "Research App",
      "Research intelligence",
      "web",
      "Research app description",
      "",
      "",
      "https://app.example.com/start",
      "https://app.example.com/callback"
    ]);
    assert.equal(db.state.batches[0][0].bindings.at(-1), "app-1");
    assert.deepEqual(db.state.batches[0][1].bindings, [
      "/assets/research.png",
      JSON.stringify(["/assets/research.png"]),
      0,
      "[]",
      "category-finance",
      "category-finance",
      "app-1"
    ]);
    assert.deepEqual(db.state.batches[0][2].bindings, [
      "listed",
      "Research App",
      "Research intelligence",
      "Research app description",
      "/assets/research.png",
      0,
      "[]",
      0,
      "org",
      "category-finance",
      "category-finance",
      "listed",
      "app-1"
    ]);
    assert.equal(deps.auditEvents[0].action, "set app status");
    assert.equal(deps.auditEvents[0].metadata.riskLevel, "medium");
    assert.equal(deps.auditEvents[0].metadata.category, "Finance");
    assert.deepEqual(deps.auditEvents[0].metadata.authSync, {
      appId: "app-1",
      status: "listed",
      synced: true
    });
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].input, "https://auth.workspace.internal/v1/admin/apps");
    assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
      id: "app-1",
      name: "Research App",
      status: "listed",
      sdkStatus: "connected",
      accessMode: "targeted",
      accessTargets: ["department:dept-research"],
      publisherUserId: "publisher-1",
      businessOwnerUserId: "owner-1",
      callbackUrls: ["https://app.example.com/callback"],
      launchUrl: "https://app.example.com/start"
    });
  });

  it("updates skill lifecycle with paired listing status update", async () => {
    const db = makeDb({ skill: { coverImageUrl: "/assets/cover.png", id: "skill-1", status: "pending_review" } });
    const deps = makeDeps();
    const api = createPublicationAssetsApi(deps);

    const result = await api.updateAssetLifecycleStatus({
      request: new Request("https://portal.test/api/assets/skill/skill-1/status", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "listed",
          riskLevel: "low",
          reviewNote: "Ship it"
        })
      }),
      env: { DB: db }
    }, "skill", "skill-1");

    assert.equal(result.status, "listed");
    assert.equal(db.state.batches.length, 1);
    assert.equal(db.state.batches[0].length, 3);
    assert.deepEqual(db.state.batches[0][0].bindings, [
      "listed",
      "low",
      "Ship it",
      "Ship it",
      "",
      "",
      "",
      "",
      "skill-1"
    ]);
    assert.deepEqual(db.state.batches[0][1].bindings, ["", "", 0, "", "skill-1"]);
    assert.deepEqual(db.state.batches[0][2].bindings, [
      "listed",
      "",
      "",
      "",
      "",
      "",
      "",
      0,
      "",
      0,
      "[]",
      0,
      "org",
      "",
      "",
      "listed",
      "skill-1"
    ]);
    assert.equal(deps.auditEvents[0].action, "set skill status");
  });

  it("syncs API-backed skill resources when updating skill lifecycle", async () => {
    const db = makeDb({
      skill: { coverImageUrl: "/assets/cover.png", id: "skill-funds", status: "pending_review" },
      listing: {
        id: "listing-funds",
        listingType: "skill",
        targetId: "skill-funds",
        status: "listed",
        listedVersionId: "1.0.0",
        reviewVersionId: "1.0.0",
        createdByUserId: "publisher-1",
        name: "Fund Query",
        visibility: "org"
      },
      publicationVersion: {
        id: "market-version-1",
        version: "1.0.0",
        configJson: JSON.stringify({
          resourceApi: {
            id: "resource-funds",
            baseUrl: "https://api.funds.example.com",
            audience: "https://api.funds.example.com",
            allowedScopes: ["funds:read"],
            tools: [
              {
                name: "fund_lookup",
                path: "/v1/lookup",
                requiredScopes: ["funds:read"]
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
    const api = createPublicationAssetsApi(deps);

    const result = await api.updateAssetLifecycleStatus({
      request: new Request("https://portal.test/api/assets/skill/skill-funds/status", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "listed",
          riskLevel: "medium",
          reviewNote: "API backed"
        })
      }),
      env: {
        DB: db,
        AUTH_WORKER_URL: "https://auth.workspace.internal",
        AUTH_SERVICE_TOKEN: "service-token"
      }
    }, "skill", "skill-funds");

    assert.deepEqual(result.resourceSync, {
      resourceId: "resource-funds",
      status: "listed",
      synced: true
    });
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].input, "https://auth.workspace.internal/v1/admin/resources");
    assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
      id: "resource-funds",
      name: "Fund Query",
      status: "listed",
      audience: "https://api.funds.example.com",
      accessMode: "public",
      accessTargets: [],
      allowedScopes: ["funds:read"],
      publisherUserId: "publisher-1"
    });
    assert.deepEqual(deps.auditEvents[0].metadata.resourceSync, {
      resourceId: "resource-funds",
      status: "listed",
      synced: true
    });
  });

  it("deletes MCP runtime assets across server and tools", async () => {
    const db = makeDb({ mcp: { id: "mcp-1", status: "listed" } });
    const deps = makeDeps();
    const api = createPublicationAssetsApi(deps);

    const result = await api.deleteAsset({
      request: new Request("https://portal.test/api/assets/mcp/mcp-1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewNote: " Retired " })
      }),
      env: { DB: db }
    }, "mcp", "mcp-1");

    assert.deepEqual(result, {
      targetType: "mcp",
      targetId: "mcp-1",
      status: "deleted"
    });
    assert.equal(db.state.batches.length, 1);
    assert.equal(db.state.batches[0].length, 2);
    assert.deepEqual(db.state.batches[0].map((statement) => statement.bindings), [
      ["mcp-1"],
      ["mcp-1"]
    ]);
    assert.equal(deps.auditEvents[0].action, "deleted mcp");
    assert.deepEqual(deps.auditEvents[0].metadata, { reviewNote: "Retired" });
  });

  it("rejects listed status without an explicit risk level before reading the asset", async () => {
    const db = makeDb({ skill: { id: "skill-1", status: "pending_review" } });
    const api = createPublicationAssetsApi(makeDeps());

    await assert.rejects(
      () => api.updateAssetLifecycleStatus({
        request: new Request("https://portal.test/api/assets/skill/skill-1/status", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "listed" })
        }),
        env: { DB: db }
      }, "skill", "skill-1"),
      (error) => error.status === 400 && error.message === "missing_review_risk_level"
    );
    assert.equal(db.state.firstCalls.length, 0);
    assert.equal(db.state.batches.length, 0);
  });

  it("rejects listed status when an App or Skill has no valid cover", async () => {
    const db = makeDb({ skill: { id: "skill-1", status: "pending_review" } });
    const api = createPublicationAssetsApi(makeDeps());

    await assert.rejects(
      () => api.updateAssetLifecycleStatus({
        request: new Request("https://portal.test/api/assets/skill/skill-1/status", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "listed", riskLevel: "low" })
        }),
        env: { DB: db }
      }, "skill", "skill-1"),
      (error) => error.status === 400 && error.message === "missing_valid_cover_image"
    );
    assert.equal(db.state.firstCalls.length, 1);
    assert.equal(db.state.batches.length, 0);
  });

  it("rejects updates for deleted or missing assets", async () => {
    const deletedDb = makeDb({ app: { id: "app-1", status: "deleted" } });
    const missingDb = makeDb();
    const api = createPublicationAssetsApi(makeDeps());

    await assert.rejects(
      () => api.updateAssetLifecycleStatus({
        request: new Request("https://portal.test/api/assets/app/app-1/status", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "delisted", reviewNote: "Already deleted" })
        }),
        env: { DB: deletedDb }
      }, "app", "app-1"),
      (error) => error.status === 409 && error.message === "asset_deleted"
    );

    await assert.rejects(
      () => api.deleteAsset({
        request: new Request("https://portal.test/api/assets/skill/missing", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        }),
        env: { DB: missingDb }
      }, "skill", "missing"),
      (error) => error.status === 404 && error.message === "skill_not_found"
    );
  });
});
