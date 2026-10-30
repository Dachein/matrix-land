import { cacheableCatalogImageUrl } from "../catalog/coverImage.ts";
import { normalizeAssetImageUrl } from "../portalContent.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPublicationSubmissionsApi } from "./submissions.ts";

const currentUser = {
  id: "user-1",
  name: "Ada",
  email: "ada@example.com",
  team: "AI Adoption",
  role: "member",
  identity: {
    provider: "microsoft_entra_id",
    objectId: "oid-1",
    tenantId: "tenant-1"
  }
};

function makeDeps(overrides = {}) {
  const auditEvents = [];
  const shortIds = ["aa11", "bb22", "cc33", "dd44", "ee55", "ff66", "gg77"];

  return {
    auditEvents,
    async audit(_db, actorType, actorId, action, targetType, targetId, metadata) {
      auditEvents.push({ actorType, actorId, action, targetType, targetId, metadata });
      return "audit-1";
    },
    async catalogCoverColumns() {
      return {
        publicationListings: true,
        skillCatalogMetadata: true
      };
    },
    async currentUserTeamId() {
      return "team-ai-adoption";
    },
    async ensureCategory(_db, value) {
      return `category-${String(value).toLowerCase().replaceAll(" ", "-")}`;
    },
    excerpt(value) {
      return String(value).replace(/\s+/g, " ").trim().slice(0, 180);
    },
    httpError(status, message) {
      return Object.assign(new Error(message), { status });
    },
    normalizeAssetImageUrl(value) {
      return String(value ?? "").trim();
    },
    normalizeCoverImageUrl(value) {
      return String(value ?? "").trim();
    },
    optionalText(value, maxLength) {
      return String(value ?? "").trim().slice(0, maxLength);
    },
    async readBody(request) {
      return request.headers.get("content-type")?.includes("json") ? request.json() : {};
    },
    async readAppsPublicationSource() {
      return undefined;
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
    sanitizeTags(value) {
      return Array.isArray(value) ? value.map(String).map((tag) => tag.trim().toLowerCase()).filter(Boolean) : [];
    },
    shortId() {
      return shortIds.shift() ?? "zz99";
    },
    async uniquePublicationVersion(_db, _listingId, value) {
      return value;
    },
    async uniqueSlug() {
      return "research-skill";
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
              if (sql.includes("FROM publication_listings")) {
                return options.existingListing ?? null;
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

describe("publication submissions service", () => {
  it("retains existing App and Skill covers on resubmission without storing accelerated references", async () => {
    const image = "data:image/png;base64,SGVsbG8=";
    for (const targetType of ["app", "skill"]) {
      const targetId = `${targetType}-1`;
      const url = cacheableCatalogImageUrl(targetType, targetId, image);
      for (const coverImageUrl of [undefined, url, `https://portal.test${url}`, "data:image/png;base64,V29ybGQ="]) {
        const db = makeDb({ existingListing: { id: "listing-existing", slug: "existing", coverImageUrl: image } });
        await createPublicationSubmissionsApi(makeDeps({ normalizeAssetImageUrl })).createPublicationSubmission({
          request: new Request("https://portal.test/api/market/submissions", { method: "POST", headers: {"content-type":"application/json"},
            body: JSON.stringify({ targetPlane: "portal", targetType, targetId, name: "Existing", description: "Description", coverImageUrl }) }),
          env: { DB: db }
        });
        const update = db.state.batches[0].find(x => x.sql.includes("UPDATE publication_listings"));
        assert.equal(update.bindings[5], coverImageUrl?.startsWith("data:") ? coverImageUrl : image);
      }
      for (const url of [cacheableCatalogImageUrl(targetType, "other", image), cacheableCatalogImageUrl(targetType, targetId, "data:image/png;base64,V29ybGQ=")]) {
        const db = makeDb({ existingListing: { id: "listing-existing", slug: "existing", coverImageUrl: image } });
        await assert.rejects(createPublicationSubmissionsApi(makeDeps({ normalizeAssetImageUrl })).createPublicationSubmission({
          request: new Request("https://portal.test/api/market/submissions", { method: "POST", headers: {"content-type":"application/json"},
            body: JSON.stringify({ targetPlane:"portal", targetType, targetId, name:"Existing", description:"Description", coverImageUrl: `https://portal.test${url}` }) }),
          env: { DB: db }
        }), /invalid_cover_image_url/);
        assert.equal(db.state.batches.length, 0);
      }
    }
  });

  it("creates a skill listing with skill, version, listing, and publication version rows", async () => {
    const db = makeDb();
    const deps = makeDeps();
    const api = createPublicationSubmissionsApi(deps);

    const result = await api.createSkillListing({
      request: new Request("https://portal.test/api/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Research Skill",
          description: "Summarizes internal research.",
          kind: "app",
          category: "Knowledge",
          coverImageUrl: "/assets/cover.png",
          tags: ["Research", "AI"],
          skillMarkdown: "# Research Skill",
          version: "1.2.3"
        })
      }),
      env: { DB: db }
    });

    assert.deepEqual(result, {
      listingId: "listing-skill-research-skill-aa11",
      skillId: "skill-research-skill-aa11",
      version: "1.2.3",
      status: "pending_review"
    });
    assert.equal(db.state.batches.length, 1);
    assert.equal(db.state.batches[0].length, 5);
    assert.deepEqual(db.state.batches[0][0].bindings, [
      "skill-research-skill-aa11",
      "team-ai-adoption",
      "Research Skill",
      "research-skill",
      "Summarizes internal research.",
      "# Research Skill"
    ]);
    assert.deepEqual(db.state.batches[0][2].bindings, [
      "version-skill-research-skill-aa11-1-2-3",
      "skill-research-skill-aa11",
      "1.2.3",
      "skill_md"
    ]);
    assert.equal(deps.auditEvents[0].action, "submitted skill for review");
    assert.equal(deps.auditEvents[0].targetId, "listing-skill-research-skill-aa11");
    assert.equal(deps.auditEvents[0].metadata.hasCoverImage, true);
  });

  it("creates APPS-backed publication submissions with verification in config and builder snapshot", async () => {
    const db = makeDb();
    const appsCalls = [];
    const deps = makeDeps({
      async readAppsPublicationSource(_context, _currentUser, targetType, targetId, requestedVersion) {
        appsCalls.push({ targetType, targetId, requestedVersion });
        return {
          artifactUrl: "https://portal.test/api/apps/skills/skill-1/versions/1.1.0/download.zip",
          builderSnapshot: {
            skill: { id: "skill-1", name: "Apps Skill" },
            version: { id: "ver-1", version: "1.1.0" }
          },
          verification: {
            source: "apps-worker",
            targetType,
            targetId,
            versionId: "ver-1"
          },
          version: "1.1.0",
          versionId: "ver-1"
        };
      },
      async uniqueSlug() {
        return "apps-skill";
      }
    });
    const api = createPublicationSubmissionsApi(deps);

    const result = await api.createPublicationSubmission({
      request: new Request("https://portal.test/api/market/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetPlane: "apps",
          targetType: "skill",
          targetId: "skill-1",
          version: "1.1.0",
          name: "Apps Skill",
          description: "Published from Apps Builder.",
          coverImageUrl: "data:image/png;base64,aGVsbG8=",
          builderSnapshot: { submittedFrom: "portal", reviewDraft: { tags: ["legacy"] }, tags: ["legacy-root"] },
          config: { channel: "review", reviewDraft: { tags: ["legacy"] }, tags: ["legacy-root"] },
          tags: ["apps"],
          riskLevel: "medium"
        })
      }),
      env: { DB: db }
    });

    assert.deepEqual(appsCalls, [{ targetType: "skill", targetId: "skill-1", requestedVersion: "1.1.0" }]);
    assert.equal(result.listingId, "listing-skill-aa11-bb22");
    assert.equal(result.publicationVersionId, "market-version-cc33-dd44");
    assert.equal(result.version, "1.1.0");
    assert.equal(db.state.batches.length, 1);
    assert.equal(db.state.batches[0].length, 3);
    const listingBindings = db.state.batches[0][0].bindings;
    assert.deepEqual(listingBindings.slice(0, 7), [
      "listing-skill-aa11-bb22",
      "skill",
      "apps",
      "skill-1",
      "ver-1",
      "user-1",
      "Apps Skill"
    ]);
    assert.equal(listingBindings[10], "data:image/png;base64,aGVsbG8=");
    assert.equal(listingBindings[12], "[]");

    const publicationVersionBindings = db.state.batches[0][1].bindings;
    const config = JSON.parse(publicationVersionBindings[6]);
    assert.equal(publicationVersionBindings[0], "market-version-cc33-dd44");
    assert.equal(publicationVersionBindings[3], "package");
    assert.equal(publicationVersionBindings[4], "/api/listings/listing-skill-aa11-bb22/download");
    assert.equal(config.source, "apps-worker");
    assert.equal(config.channel, "review");
    assert.equal(config.tags, undefined);
    assert.equal(config.reviewDraft.tags, undefined);
    assert.deepEqual(config.appsVerification, {
      source: "apps-worker",
      targetType: "skill",
      targetId: "skill-1",
      versionId: "ver-1"
    });
    assert.equal(config.builderSnapshot.submittedFrom, "portal");
    assert.equal(config.builderSnapshot.tags, undefined);
    assert.equal(config.builderSnapshot.reviewDraft.tags, undefined);
    assert.equal(config.builderSnapshot.appsVerified.skill.id, "skill-1");
    assert.equal(deps.auditEvents[0].metadata.appsVerified, true);
  });

  it("keeps the APPS App readiness report optional by default and enforces it when the gate is enabled", async () => {
    const appsSource = {
      builderSnapshot: {
        app: {
          id: "app-1",
          productionUrl: "https://request-app.example.invalid"
        }
      },
      verification: { source: "apps-worker", targetType: "app", targetId: "app-1" },
      version: "1.0.0",
      versionId: "dep-1"
    };
    const body = {
      targetPlane: "apps",
      targetType: "app",
      targetId: "app-1",
      version: "1.0.0",
      name: "Request App",
      description: "Published from APPS Builder."
    };

    const optionalDb = makeDb();
    const optionalDeps = makeDeps({ async readAppsPublicationSource() { return appsSource; } });
    const optionalApi = createPublicationSubmissionsApi(optionalDeps);
    await optionalApi.createPublicationSubmission({
      request: new Request("https://portal.test/api/market/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }),
      env: { DB: optionalDb }
    });
    const optionalConfig = JSON.parse(optionalDb.state.batches[0][1].bindings[6]);
    assert.equal(optionalConfig.releaseReadiness, undefined);

    const requiredDb = makeDb();
    const requiredDeps = makeDeps({ async readAppsPublicationSource() { return appsSource; } });
    const requiredApi = createPublicationSubmissionsApi(requiredDeps);
    await assert.rejects(
      () => requiredApi.createPublicationSubmission({
        request: new Request("https://portal.test/api/market/submissions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }),
        env: { DB: requiredDb, WORKSPACE_RELEASE_READINESS_REPORT_REQUIRED: "true" }
      }),
      (error) => error.status === 400 && error.message === "invalid_harness_report_url"
    );
    assert.equal(requiredDb.state.batches.length, 0);

    await requiredApi.createPublicationSubmission({
      request: new Request("https://portal.test/api/market/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...body,
          harnessReportUrl: "https://request-app.example.invalid/harness/report.html",
          harnessSelfCheckConfirmed: true
        })
      }),
      env: { DB: requiredDb, WORKSPACE_RELEASE_READINESS_REPORT_REQUIRED: "true" }
    });
    const requiredConfig = JSON.parse(requiredDb.state.batches[0][1].bindings[6]);
    assert.deepEqual(requiredConfig.releaseReadiness, {
      reportName: "Workspace Release Readiness Report",
      reportUrl: "https://request-app.example.invalid/harness/report.html",
      schemaVersion: "workspace.release-readiness-report/v1",
      selfCheckConfirmed: true
    });
  });

  it("resubmits existing portal listings into review without reading APPS source", async () => {
    const db = makeDb({
      existingListing: {
        id: "listing-existing",
        slug: "existing-app"
      }
    });
    let appsReads = 0;
    let uniqueSlugCalls = 0;
    const deps = makeDeps({
      async readAppsPublicationSource() {
        appsReads += 1;
        return undefined;
      },
      async uniqueSlug() {
        uniqueSlugCalls += 1;
        return "should-not-be-used";
      },
      async uniquePublicationVersion(_db, listingId, value) {
        assert.equal(listingId, "listing-existing");
        return `${value}-2`;
      }
    });
    const api = createPublicationSubmissionsApi(deps);

    const result = await api.createPublicationSubmission({
      request: new Request("https://portal.test/api/market/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetPlane: "portal",
          targetType: "app",
          targetId: "app-1",
          version: "2.0.0",
          name: "Existing App",
          description: "Existing listing update.",
          artifactType: "app_config",
          artifactUrl: "https://app.example.com/config.json"
        })
      }),
      env: { DB: db }
    });

    assert.equal(result.listingId, "listing-existing");
    assert.equal(result.version, "2.0.0-2");
    assert.equal(appsReads, 0);
    assert.equal(uniqueSlugCalls, 0);
    assert.match(db.state.batches[0][0].sql, /UPDATE publication_listings/);
    assert.match(db.state.batches[0][0].sql, /status = 'pending_review'/);
    assert.match(db.state.batches[0][0].sql, /desired_status = 'pending_review'/);
    assert.equal(deps.auditEvents[0].metadata.appsVerified, false);
  });

  it("requires a target id before reading APPS source", async () => {
    const db = makeDb();
    let appsReads = 0;
    const deps = makeDeps({
      async readAppsPublicationSource() {
        appsReads += 1;
        return undefined;
      }
    });
    const api = createPublicationSubmissionsApi(deps);

    await assert.rejects(
      () => api.createPublicationSubmission({
        request: new Request("https://portal.test/api/market/submissions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetPlane: "apps",
            targetType: "skill",
            name: "Missing Target",
            description: "Missing target id"
          })
        }),
        env: { DB: db }
      }),
      (error) => error.status === 400 && error.message === "missing_target_id"
    );
    assert.equal(appsReads, 0);
    assert.equal(db.state.batches.length, 0);
  });
});
