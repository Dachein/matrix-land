import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPublicationAppsAuthorIndexReader,
  createPublicationAppsHubAccessIndexReader,
  createPublicationAppsReviewAuthorReader,
  createPublicationAppsSourceReader,
  createPublicationAppsSkillVisibilitySync
} from "./appsSource.ts";

const currentUser = {
  id: "user-1",
  name: "Ada",
  email: "ada@example.com",
  team: "AI Adoption",
  department: "Group / Investment",
  departmentId: "dept-investment",
  departmentPath: ["dept-group", "dept-investment"],
  role: "admin",
  identity: {
    provider: "microsoft_entra_id",
    objectId: "oid-1",
    tenantId: "tenant-1"
  }
};

function makeDeps(overrides = {}) {
  return {
    getTtlSeconds() {
      return 1200;
    },
    httpError(status, message) {
      return Object.assign(new Error(message), { status });
    },
    appsOrgContext() {
      return { orgId: "example-org", orgSlug: "workspace-wealth" };
    },
    appsReadScopes: ["apps:apps:read", "apps:skills:read"],
    appsWorkerBaseUrl() {
      return "https://apps.example.com";
    },
    parseJson(value) {
      return JSON.parse(value);
    },
    async signAppsToken(_env, payload) {
      return `signed:${payload.org_id}:${payload.scopes.join("+")}:${payload.exp}`;
    },
    ...overrides
  };
}

describe("publication apps source reader", () => {
  it("loads one live Hub access index with department identity in the APPS credential", async () => {
    const calls = [];
    const signedPayloads = [];
    const readHubAccessIndex = createPublicationAppsHubAccessIndexReader(makeDeps({
      async fetch(url, init) {
        calls.push({ url, init });
        return new Response(JSON.stringify({
          appIds: ["app-visible", "app-visible"],
          skillIds: ["skill-visible"]
        }));
      },
      async signAppsToken(_env, payload) {
        signedPayloads.push(payload);
        return "signed-hub-access";
      }
    }));

    const index = await readHubAccessIndex({
      request: new Request("https://portal.test/api/publication/hub-listings"),
      env: {}
    }, currentUser);

    assert.deepEqual(index, { appIds: ["app-visible"], skillIds: ["skill-visible"] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://apps.example.com/hub-access");
    assert.equal(calls[0].init.headers["x-workspace-department-id"], "dept-investment");
    assert.equal(calls[0].init.headers["x-workspace-department-path"], JSON.stringify(["dept-group", "dept-investment"]));
    assert.equal(signedPayloads[0].department_id, "dept-investment");
    assert.deepEqual(signedPayloads[0].department_path, ["dept-group", "dept-investment"]);
  });

  it("forwards filtered home App ids to the APPS Hub access projection", async () => {
    const calls = [];
    const readHubAccessIndex = createPublicationAppsHubAccessIndexReader(makeDeps({
      async fetch(url) {
        calls.push(url);
        return new Response(JSON.stringify({ appIds: ["app-home"], skillIds: [] }));
      }
    }));

    const index = await readHubAccessIndex({
      request: new Request("https://portal.test/api/publication/hub-listings?ids=app-home&type=app"),
      env: {}
    }, currentUser, ["app-home"], "app");

    assert.deepEqual(index, { appIds: ["app-home"], skillIds: [] });
    assert.deepEqual(calls, ["https://apps.example.com/hub-access?ids=app-home&type=app"]);
  });

  it("builds a complete author index with only the App and Skill collection requests", async () => {
    const calls = [];
    const readAuthorIndex = createPublicationAppsAuthorIndexReader(makeDeps({
      async fetch(url) {
        calls.push(url);
        if (url.endsWith("/apps")) {
          return new Response(JSON.stringify({
            apps: [
              { id: "app-owned", ownerUserId: "user-1" },
              { id: "app-shared", ownerUserId: "owner-2", collaboratorUserIds: ["ada@example.com"] },
              { id: "app-not-authored", ownerUserId: "owner-3", collaboratorUserIds: ["user-9"] }
            ]
          }));
        }
        return new Response(JSON.stringify({
          skills: [
            { id: "skill-org-visible", ownerUserId: "owner-4", collaboratorUserIds: ["user-8"], visibility: "org" },
            { id: "skill-shared", ownerUserId: "owner-5", collaboratorUserIds: ["user-1"], visibility: "team" }
          ]
        }));
      }
    }));

    const index = await readAuthorIndex({
      request: new Request("https://portal.test/api/listings"),
      env: {}
    }, currentUser);

    assert.deepEqual(calls.sort(), [
      "https://apps.example.com/apps",
      "https://apps.example.com/skills"
    ]);
    assert.deepEqual(index, {
      appIds: ["app-owned", "app-shared"],
      collaboratedAppIds: ["app-shared"],
      collaboratedSkillIds: ["skill-shared"],
      ownedAppIds: ["app-owned"],
      ownedSkillIds: [],
      skillIds: ["skill-shared"]
    });
  });

  it("fails closed per author-index type when one APPS collection is unavailable", async () => {
    const readAuthorIndex = createPublicationAppsAuthorIndexReader(makeDeps({
      async fetch(url) {
        if (url.endsWith("/apps")) {
          return new Response("temporarily unavailable", { status: 503 });
        }
        return new Response(JSON.stringify({
          skills: [
            { id: "skill-shared", ownerUserId: "owner-1", collaboratorUserIds: ["user-1"] }
          ]
        }));
      }
    }));

    const index = await readAuthorIndex({
      request: new Request("https://portal.test/api/listings"),
      env: {}
    }, currentUser);

    assert.deepEqual(index, {
      appIds: [],
      collaboratedAppIds: [],
      collaboratedSkillIds: ["skill-shared"],
      ownedAppIds: [],
      ownedSkillIds: [],
      skillIds: ["skill-shared"]
    });
  });

  it("loads app source snapshots with read-only APPS credentials", async () => {
    const calls = [];
    const readSource = createPublicationAppsSourceReader(makeDeps({
      async fetch(url, init) {
        calls.push({ url, init });
        return new Response(JSON.stringify({
          app: {
            id: "app-1",
            ownerUserId: "user-1",
            name: "Workspace App",
            status: "draft",
            visibility: "team",
            updatedAt: "2026-06-30T00:00:00.000Z",
            manifest: { runtime: "worker" }
          }
        }));
      }
    }));

    const source = await readSource({
      request: new Request("https://portal.test/api/market/submissions"),
      env: { PORTAL_ISSUER: "frontier-workspace" }
    }, currentUser, "app", "app-1");

    assert.equal(calls[0].url, "https://apps.example.com/apps/app-1");
    assert.equal(calls[0].init.headers.Accept, "application/json");
    assert.match(calls[0].init.headers.Authorization, /^Bearer signed:example-org:apps:apps:read\+apps:skills:read:/);
    assert.equal(calls[0].init.headers["x-workspace-user-id"], "ada@example.com");
    assert.equal(calls[0].init.headers["x-workspace-org-id"], "example-org");
    assert.equal(calls[0].init.headers["x-workspace-org-slug"], "workspace-wealth");
    assert.equal(calls[0].init.headers["x-workspace-scopes"], "apps:apps:read,apps:skills:read");
    assert.equal(source.version, "2026-06-30T00:00:00.000Z");
    assert.equal(source.versionId, "2026-06-30T00:00:00.000Z");
    assert.equal(source.builderSnapshot.app.id, "app-1");
    assert.deepEqual(source.builderSnapshot.manifest, { runtime: "worker" });
    assert.equal(source.verification.source, "apps-worker");
    assert.equal(source.verification.appStatus, "draft");
  });

  it("loads a target-bound author projection for an admin publication review", async () => {
    const calls = [];
    const signedPayloads = [];
    const readAuthors = createPublicationAppsReviewAuthorReader(makeDeps({
      async fetch(url, init) {
        calls.push({ url, init });
        return new Response(JSON.stringify({
          authors: {
            ownerUserId: "owner@example.com",
            collaboratorUserIds: ["collaborator@example.com", "collaborator@example.com"]
          }
        }));
      },
      async signAppsToken(_env, payload) {
        signedPayloads.push(payload);
        return "signed-publication-review";
      }
    }));

    const authors = await readAuthors({
      request: new Request("https://portal.test/api/listings/listing-app-1/status"),
      env: { PORTAL_ISSUER: "frontier-workspace" }
    }, currentUser, "app", "app-1");

    assert.deepEqual(authors, {
      ownerUserId: "owner@example.com",
      collaboratorUserIds: ["collaborator@example.com"]
    });
    assert.equal(calls[0].url, "https://apps.example.com/publication-review/apps/app-1/authors");
    assert.equal(calls[0].init.headers.Authorization, "Bearer signed-publication-review");
    assert.equal(calls[0].init.headers["x-workspace-scopes"], "apps:apps:read");
    assert.equal(signedPayloads[0].typ, "apps_publication_review");
    assert.equal(signedPayloads[0].app_id, "app-1");
    assert.equal(signedPayloads[0].skill_id, undefined);
    assert.deepEqual(signedPayloads[0].scopes, ["apps:apps:read"]);
  });

  it("selects requested skill versions and builds a portal download URL", async () => {
    const readSource = createPublicationAppsSourceReader(makeDeps({
      async fetch() {
        return new Response(JSON.stringify({
          skill: {
            id: "skill-1",
            ownerUserId: "user-1",
            name: "Research Skill",
            slug: "research-skill",
            kind: "skill",
            capabilities: ["search"],
            status: "draft",
            visibility: "team",
            currentVersionId: "ver-old",
            versions: [
              { id: "ver-old", version: "1.0.0", artifactSha256: "old-sha" },
              { id: "ver-new", version: "1.1.0", artifactSha256: "new-sha" }
            ]
          }
        }));
      }
    }));

    const source = await readSource({
      request: new Request("https://portal.test/api/market/submissions"),
      env: {}
    }, currentUser, "skill", "skill-1", "1.1.0");

    assert.equal(source.version, "1.1.0");
    assert.equal(source.versionId, "ver-new");
    assert.equal(source.artifactUrl, "https://portal.test/api/apps/skills/skill-1/versions/1.1.0/download.zip");
    assert.equal(source.builderSnapshot.skill.id, "skill-1");
    assert.deepEqual(source.builderSnapshot.skill.capabilities, ["search"]);
    assert.equal(source.builderSnapshot.version.artifactSha256, "new-sha");
    assert.equal(source.verification.artifactSha256, "new-sha");
  });

  it("rejects unknown requested skill versions instead of silently using current", async () => {
    const readSource = createPublicationAppsSourceReader(makeDeps({
      async fetch() {
        return new Response(JSON.stringify({
          skill: {
            id: "skill-1",
            ownerUserId: "user-1",
            currentVersionId: "ver-current",
            versions: [{ id: "ver-current", version: "1.2.0" }]
          }
        }));
      }
    }));

    await assert.rejects(
      () => readSource({
        request: new Request("https://portal.test/api/market/submissions"),
        env: {}
      }, currentUser, "skill", "skill-1", "9.9.9"),
      (error) => error.status === 404 && error.message === "apps_skill_version_not_found"
    );
  });

  it("maps missing APPS assets to stable portal errors", async () => {
    const readSource = createPublicationAppsSourceReader(makeDeps({
      async fetch() {
        return new Response("not found", { status: 404 });
      }
    }));

    await assert.rejects(
      () => readSource({
        request: new Request("https://portal.test/api/market/submissions"),
        env: {}
      }, currentUser, "app", "missing-app"),
      (error) => error.status === 404 && error.message === "apps_worker_validation_failed:404:not found"
    );
  });

  it("lets a collaborator submit an App or Skill to the publication as a co-author", async () => {
    const readSource = createPublicationAppsSourceReader(makeDeps({
      async fetch(url) {
        return new Response(JSON.stringify(url.includes("/apps/") ? {
          app: {
            id: "app-1",
            ownerUserId: "asset-owner-1",
            collaboratorUserIds: ["user-1"]
          }
        } : {
          skill: {
            id: "skill-1",
            ownerUserId: "asset-owner-1",
            collaboratorUserIds: ["user-1"],
            versions: [{ id: "ver-1", version: "1.0.0" }]
          }
        }));
      }
    }));
    const context = {
      request: new Request("https://portal.test/api/market/submissions"),
      env: {}
    };

    const appSource = await readSource(context, currentUser, "app", "app-1");
    const skillSource = await readSource(context, currentUser, "skill", "skill-1");

    assert.equal(appSource.builderSnapshot.app.id, "app-1");
    assert.equal(skillSource.builderSnapshot.skill.id, "skill-1");
    assert.equal(skillSource.version, "1.0.0");
  });

  it("still rejects a same-org user who is neither owner nor collaborator", async () => {
    const readSource = createPublicationAppsSourceReader(makeDeps({
      async fetch() {
        return new Response(JSON.stringify({
          app: {
            id: "app-1",
            ownerUserId: "asset-owner-1",
            collaboratorUserIds: ["different-user"]
          }
        }));
      }
    }));

    await assert.rejects(
      () => readSource({
        request: new Request("https://portal.test/api/market/submissions"),
        env: {}
      }, currentUser, "app", "app-1"),
      (error) => error.status === 404 && error.message === "apps_app_not_found"
    );
  });

  it("rejects unsupported APPS publication target types", async () => {
    const readSource = createPublicationAppsSourceReader(makeDeps());

    await assert.rejects(
      () => readSource({
        request: new Request("https://portal.test/api/market/submissions"),
        env: {}
      }, currentUser, "mcp", "server-1"),
      (error) => error.status === 400 && error.message === "apps_publication_target_not_supported"
    );
  });
});


describe("publication skill visibility sync", () => {
  it("uses a review credential bound to one skill without broad admin scopes", async () => {
    let payload, call;
    const sync = createPublicationAppsSkillVisibilitySync(makeDeps({
      async signAppsToken(_env, value) { payload = value; return "review-token"; },
      async fetch(url, init) { call = { url, init }; return new Response("{}"); }
    }));
    await sync({ request: new Request("https://portal.test"), env: {} }, currentUser, "skill-1", "org");
    assert.equal(payload.typ, "apps_publication_review");
    assert.equal(payload.skill_id, "skill-1");
    assert.equal(payload.sub, currentUser.id);
    assert.deepEqual(payload.scopes, ["apps:skills:write"]);
    assert.equal(call.url, "https://apps.example.com/publication-review/skills/skill-1/visibility");
    assert.equal(call.init.method, "PATCH");
    assert.deepEqual(JSON.parse(call.init.body), { visibility: "org" });
  });
  it("fails the review when the visibility sync fails", async () => {
    const sync = createPublicationAppsSkillVisibilitySync(makeDeps({ async fetch() { return new Response("denied", { status: 403 }); } }));
    await assert.rejects(sync({ request: new Request("https://portal.test"), env: {} }, currentUser, "skill-1", "org"), /apps_skill_visibility_sync_failed:403:denied/);
  });
});
