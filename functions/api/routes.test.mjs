import { defaultPortalConfig } from "../../src/shared/portalConfig.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dispatchApiRoute } from "./routes.ts";

function makeContext(method, path) {
  return {
    env: { DB: "db", WORKSPACE_MODULES_JSON: JSON.stringify(["models","mate","knowledge","studio","connections","discussions","operations"]) },
    request: new Request(`https://portal.test/api/${path}`, { method })
  };
}

async function jsonBody(response) {
  return response.json();
}

describe("api route dispatcher", () => {
  it("publishes only validated brand fields before authentication", async () => {
    const context = makeContext("GET", "public/brand");
    context.env = {
      PLATFORM_BRAND_JSON: JSON.stringify({ name: "Example AI", logoText: "EA" }),
      AUTH_SERVICE_TOKEN: "must-stay-private", CF_API_TOKEN: "also-private"
    };
    const services = new Proxy({}, { get() { throw new Error("public brand must not resolve a user or database"); } });
    const response = await dispatchApiRoute(context, services, "public/brand");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=60");
    const payload = await response.json();
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.brand.name, "Example AI");
    assert.doesNotMatch(JSON.stringify(payload), /private|TOKEN/);
  });

  it("routes admin Home application display changes with a decoded listing id", async () => {
    const calls = [];
    const response = await dispatchApiRoute(makeContext("PATCH", "listings/app%20one/home-display"), {
      publicationListingsApi: {
        async updateHomeApplicationDisplay(_context, id) { calls.push(id); return { homeDisplay: "hidden" }; }
      }
    }, "listings/app%20one/home-display");
    assert.deepEqual(await response.json(), { homeDisplay: "hidden" });
    assert.deepEqual(calls, ["app one"]);
  });

  it("opens private workspace references in the authenticated Mate preview", async () => {
    const artifactId = "art_fa3d5783-2f1f-45bc-9e60-81f44944664f";
    const response = await dispatchApiRoute(makeContext("GET", `workspace-files/${artifactId}/raw`), {}, `workspace-files/${artifactId}/raw`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `https://portal.test/#/mate?artifact=${artifactId}`);
  });
  it("dispatches auth session routes through the auth boundary group", async () => {
    const calls = [];
    const services = {
      async readAuthSession(context) {
        calls.push(["readAuthSession", context.request.method]);
        return { authenticated: true };
      }
    };

    const response = await dispatchApiRoute(makeContext("GET", "auth/session"), services, "auth/session");

    assert.equal(response.status, 200);
    assert.deepEqual(await jsonBody(response), { authenticated: true });
    assert.deepEqual(calls, [["readAuthSession", "GET"]]);
  });

  it("returns the home auth and catalog from one bootstrap request", async () => {
    const calls = [];
    const currentUser = { id: "user-1" };
    const services = {
      async readAuthSession() {
        calls.push("auth");
        return { authenticated: true, configured: true, user: currentUser };
      },
      async resolveCurrentUser() {
        throw new Error("bootstrap should reuse the authenticated user");
      },
      catalogApi: {
        async loadCatalog(database, user) {
          calls.push(["catalog", database, user.id]);
          return { currentUser: user, portal: {} };
        }
      }
    };

    const response = await dispatchApiRoute(makeContext("GET", "home-bootstrap"), services, "home-bootstrap");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("server-timing"), /^auth;dur=\d+, catalog;dur=\d+$/);
    assert.deepEqual(await jsonBody(response), {
      auth: { authenticated: true, configured: true, user: currentUser },
      catalog: { currentUser, portal: defaultPortalConfig },
      me: currentUser
    });
    assert.deepEqual(calls, ["auth", ["catalog", "db", "user-1"]]);
  });

  it("returns only auth from Home bootstrap when the session is signed out", async () => {
    const auth = { authenticated: false, configured: true, loginUrl: "/auth/login" };
    const response = await dispatchApiRoute(makeContext("GET", "home-bootstrap"), {
      async readAuthSession() {
        return auth;
      },
      async resolveCurrentUser() {
        throw new Error("signed-out bootstrap must not resolve a user");
      },
      catalogApi: {
        async loadCatalog() {
          throw new Error("signed-out bootstrap must not load the catalog");
        }
      }
    }, "home-bootstrap");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("server-timing"), /^auth;dur=\d+$/);
    assert.deepEqual(await jsonBody(response), { auth });
  });

  it("returns profile, Journey, MCP, and Token readiness from the global Me endpoint", async () => {
    const journey = {
      badges: [{ badgeKey: "mcp_connected" }, { badgeKey: "token_ready" }],
      level: { key: "builder" },
      updatedAt: "2026-08-20T09:30:00.000Z"
    };
    const currentUser = { id: "user-1", name: "Ada" };
    const status = {
      journeyLevelKey: "builder",
      mcpConnected: true,
      tokenApplied: true,
      updatedAt: "2026-08-20T09:30:00.000Z"
    };
    const response = await dispatchApiRoute(makeContext("GET", "me"), {
      journeyApi: {
        async readCurrentUserOverview() {
          return { currentUser, journey, status };
        }
      }
    }, "me");

    assert.deepEqual(await jsonBody(response), {
      journey,
      me: { ...currentUser, status }
    });
    assert.equal(response.headers.get("cache-control"), "private, no-cache");
  });

  it("keeps llm gateway token action routes ahead of generic token routes", async () => {
    const calls = [];
    const services = {
      llmGatewayAccessApi: {
        async rotateAccessToken(_context, tokenId) {
          calls.push(["rotate", tokenId]);
          return new Response(JSON.stringify({ rotated: tokenId }), {
            headers: { "content-type": "application/json" }
          });
        }
      }
    };

    const response = await dispatchApiRoute(
      makeContext("POST", "llm-gateway/access/tokens/token-1/rotate"),
      services,
      "llm-gateway/access/tokens/token-1/rotate"
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await jsonBody(response), { rotated: "token-1" });
    assert.deepEqual(calls, [["rotate", "token-1"]]);
  });

  it("routes manual personal usage refreshes through the access service", async () => {
    const calls = [];
    const services = {
      llmGatewayAccessApi: {
        async refreshAccessUsage(context) {
          calls.push(["refresh", context.request.method]);
          return new Response(JSON.stringify({ refreshed: true }), {
            headers: { "content-type": "application/json" }
          });
        }
      }
    };

    const response = await dispatchApiRoute(
      makeContext("POST", "llm-gateway/access/usage/refresh"),
      services,
      "llm-gateway/access/usage/refresh"
    );

    assert.deepEqual(await jsonBody(response), { refreshed: true });
    assert.deepEqual(calls, [["refresh", "POST"]]);
  });

  it("routes the fast personal cumulative-token summary through the access service", async () => {
    const calls = [];
    const services = {
      llmGatewayAccessApi: {
        async getUsageSummary(context) {
          calls.push([context.request.method, context.request.url]);
          return new Response(JSON.stringify({ hasSnapshot: true, cumulativeTokens: 48_200 }), {
            headers: { "content-type": "application/json" }
          });
        }
      }
    };

    const response = await dispatchApiRoute(
      makeContext("GET", "llm-gateway/access/usage/summary"),
      services,
      "llm-gateway/access/usage/summary"
    );

    assert.deepEqual(await jsonBody(response), { hasSnapshot: true, cumulativeTokens: 48_200 });
    assert.deepEqual(calls, [["GET", "https://portal.test/api/llm-gateway/access/usage/summary"]]);
  });

  it("routes the authenticated Group usage summary through the cached service", async () => {
    const calls = [];
    const services = {
      llmGatewayGroupUsageApi: {
        async getGroupUsage(context) {
          calls.push(["group-usage", context.request.method]);
          return new Response(JSON.stringify({ totalTokens: 48_200 }), {
            headers: { "content-type": "application/json" }
          });
        }
      }
    };

    const response = await dispatchApiRoute(
      makeContext("GET", "llm-gateway/group-usage"),
      services,
      "llm-gateway/group-usage"
    );

    assert.deepEqual(await jsonBody(response), { totalTokens: 48_200 });
    assert.deepEqual(calls, [["group-usage", "GET"]]);
  });

  it("routes V2 Admin token controls through the LiteLLM allocation service", async () => {
    const calls = [];
    const services = {
      llmGatewayAdminAllocationsApi: {
        async suspendAdminToken(_context, tokenId) {
          calls.push(["suspend", tokenId]);
          return new Response(JSON.stringify({ suspended: tokenId }), {
            headers: { "content-type": "application/json" }
          });
        }
      }
    };

    const response = await dispatchApiRoute(
      makeContext("POST", "llm-gateway/admin/tokens/hash%2F1/suspend"),
      services,
      "llm-gateway/admin/tokens/hash%2F1/suspend"
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await jsonBody(response), { suspended: "hash/1" });
    assert.deepEqual(calls, [["suspend", "hash/1"]]);
  });

  it("routes apps token before the catch-all and proxies handoff link to the apps worker", async () => {
    const calls = [];
    const services = {
      appsProxyApi: {
        async proxyAppsWorkerRequest(_context, path) {
          calls.push(["proxy", path]);
          return new Response("proxied");
        }
      },
      appsTokenApi: {
        async issueAppsToken() {
          calls.push(["token"]);
          return { token: "apps-token" };
        }
      }
    };

    const tokenResponse = await dispatchApiRoute(makeContext("POST", "apps/token"), services, "apps/token");
    const handoffResponse = await dispatchApiRoute(makeContext("POST", "apps/apps/app%201/handoff-link"), services, "apps/apps/app%201/handoff-link");
    const proxyResponse = await dispatchApiRoute(makeContext("GET", "apps/apps"), services, "apps/apps");

    assert.deepEqual(await jsonBody(tokenResponse), { token: "apps-token" });
    assert.equal(await handoffResponse.text(), "proxied");
    assert.equal(await proxyResponse.text(), "proxied");
    assert.deepEqual(calls, [["token"], ["proxy", "apps/apps/app%201/handoff-link"], ["proxy", "apps/apps"]]);
  });

  it("decodes publication asset ids before calling the asset service", async () => {
    const calls = [];
    const services = {
      publicationAssetsApi: {
        async updateAssetLifecycleStatus(_context, assetType, assetId) {
          calls.push([assetType, assetId]);
          return { assetType, assetId };
        }
      }
    };

    const response = await dispatchApiRoute(
      makeContext("PATCH", "assets/app/app%201/status"),
      services,
      "assets/app/app%201/status"
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await jsonBody(response), { assetType: "app", assetId: "app 1" });
    assert.deepEqual(calls, [["app", "app 1"]]);
  });

  it("routes admin user list through the users service", async () => {
    const calls = [];
    const services = {
      adminUsersApi: {
        async listAdminUsers(context) {
          calls.push(["listAdminUsers", context.request.method]);
          return [{ id: "user-1", email: "user@example.com" }];
        }
      }
    };

    const response = await dispatchApiRoute(makeContext("GET", "admin/users"), services, "admin/users");

    assert.equal(response.status, 200);
    assert.deepEqual(await jsonBody(response), { users: [{ id: "user-1", email: "user@example.com" }] });
    assert.deepEqual(calls, [["listAdminUsers", "GET"]]);
  });

  it("routes multi-role user updates through the protected users service", async () => {
    const calls = [];
    const services = {
      usersApi: {
        async updateAdminUserRole(_context, userId) {
          calls.push(userId);
          return { id: userId, roles: ["admin", "community_admin"] };
        }
      }
    };

    const response = await dispatchApiRoute(makeContext("PATCH", "admin/users/user%201/roles"), services, "admin/users/user%201/roles");
    assert.deepEqual(await jsonBody(response), { user: { id: "user 1", roles: ["admin", "community_admin"] } });
    assert.deepEqual(calls, ["user 1"]);
  });

  it("routes admin MCP connection queries and disable actions through the MCP service", async () => {
    const calls = [];
    const services = {
      mcpPortalApi: {
        async readAdminConnections(context) {
          calls.push(["list", context.request.method]);
          return Response.json({ connections: [] });
        },
        async disableAdminConnection(_context, connectionId) {
          calls.push(["disable", connectionId]);
          return Response.json({ connection: { id: decodeURIComponent(connectionId), status: "inactive" } });
        }
      }
    };

    const listResponse = await dispatchApiRoute(
      makeContext("GET", "admin/mcp/connections?status=active"),
      services,
      "admin/mcp/connections"
    );
    const disableResponse = await dispatchApiRoute(
      makeContext("POST", "admin/mcp/connections/conn%2F1/disable"),
      services,
      "admin/mcp/connections/conn%2F1/disable"
    );

    assert.deepEqual(await jsonBody(listResponse), { connections: [] });
    assert.deepEqual(await jsonBody(disableResponse), { connection: { id: "conn/1", status: "inactive" } });
    assert.deepEqual(calls, [["list", "GET"], ["disable", "conn%2F1"]]);
  });

  it("routes login email policy reads and updates through the admin service", async () => {
    const calls = [];
    const services = {
      mcpPortalApi: {
        async readAdminLoginEmailPolicy() {
          calls.push("read");
          return Response.json({ policy: { mode: "company_email_only" } });
        },
        async updateAdminLoginEmailPolicy() {
          calls.push("update");
          return Response.json({ policy: { mode: "open" } });
        }
      }
    };

    const readResponse = await dispatchApiRoute(makeContext("GET", "admin/login-email-policy"), services, "admin/login-email-policy");
    const updateResponse = await dispatchApiRoute(makeContext("POST", "admin/login-email-policy"), services, "admin/login-email-policy");

    assert.deepEqual(await jsonBody(readResponse), { policy: { mode: "company_email_only" } });
    assert.deepEqual(await jsonBody(updateResponse), { policy: { mode: "open" } });
    assert.deepEqual(calls, ["read", "update"]);
  });

  it("routes user directory through the unified user service", async () => {
    const calls = [];
    const services = {
      userDirectoryApi: {
        async listUserDirectory(context, defaults) {
          calls.push(["listUserDirectory", context.request.method, defaults]);
          return [{ id: "user-1", email: "user@example.com", emailPrefix: "user" }];
        }
      }
    };

    const response = await dispatchApiRoute(makeContext("GET", "users/directory?purpose=mention&q=user"), services, "users/directory");

    assert.equal(response.status, 200);
    assert.deepEqual(await jsonBody(response), { users: [{ id: "user-1", email: "user@example.com", emailPrefix: "user" }] });
    assert.deepEqual(calls, [["listUserDirectory", "GET", undefined]]);
  });

  it("routes publication listings through the publication read endpoint", async () => {
    const calls = [];
    const services = {
      publicationListingsApi: {
        async listHubPublicationListings(context) {
          calls.push(["listHubPublicationListings", context.request.method]);
          return { hubListings: [{ id: "listing-visible" }] };
        },
        async listPublicationListings(context) {
          calls.push(["listPublicationListings", context.request.method]);
          return { publicationListings: [{ id: "listing-1" }] };
        },
        async recordPublicationInteraction(context) {
          calls.push(["recordPublicationInteraction", context.request.method]);
          return { action: "app.visit_url", recorded: true };
        }
      }
    };

    const response = await dispatchApiRoute(makeContext("GET", "publication/listings"), services, "publication/listings");
    const hubResponse = await dispatchApiRoute(makeContext("GET", "publication/hub-listings"), services, "publication/hub-listings");
    const interactionResponse = await dispatchApiRoute(
      makeContext("POST", "publication/interactions"),
      services,
      "publication/interactions"
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await jsonBody(response), { publicationListings: [{ id: "listing-1" }] });
    assert.deepEqual(await jsonBody(hubResponse), { hubListings: [{ id: "listing-visible" }] });
    assert.equal(interactionResponse.status, 201);
    assert.deepEqual(await jsonBody(interactionResponse), { action: "app.visit_url", recorded: true });
    assert.deepEqual(calls, [
      ["listPublicationListings", "GET"],
      ["listHubPublicationListings", "GET"],
      ["recordPublicationInteraction", "POST"]
    ]);
  });

  it("routes forum topics through the forum read endpoint", async () => {
    const calls = [];
    const services = {
      forumApi: {
        async listForumTopics(context) {
          calls.push(["listForumTopics", context.request.method]);
          return {
            discussions: [{ id: "topic-1" }],
            nextCursor: "cursor-2",
            pinnedDiscussions: [{ id: "pinned-1" }]
          };
        }
      }
    };

    const response = await dispatchApiRoute(makeContext("GET", "forum/topics"), services, "forum/topics");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await jsonBody(response), {
      discussions: [{ id: "topic-1" }],
      nextCursor: "cursor-2",
      pinnedDiscussions: [{ id: "pinned-1" }]
    });
    assert.deepEqual(calls, [["listForumTopics", "GET"]]);
  });

  it("routes one canonical forum topic by id", async () => {
    const calls = [];
    const services = {
      forumApi: {
        async getForumTopic(_context, topicId) {
          calls.push(topicId);
          return { discussion: { id: decodeURIComponent(topicId), title: "Pinned topic" } };
        }
      }
    };

    const response = await dispatchApiRoute(
      makeContext("GET", "forum/topics/topic%20one"),
      services,
      "forum/topics/topic%20one"
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await jsonBody(response), {
      discussion: { id: "topic one", title: "Pinned topic" }
    });
    assert.deepEqual(calls, ["topic%20one"]);
  });

  it("returns 201 and a canonical Location after creating a forum topic", async () => {
    const services = {
      forumApi: {
        async createForumTopic() {
          return {
            id: "topic one",
            postId: "post-1",
            discussion: { id: "topic one", title: "Created topic" }
          };
        }
      }
    };

    const response = await dispatchApiRoute(makeContext("POST", "forum/topics"), services, "forum/topics");

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("location"), "/api/forum/topics/topic%20one");
    assert.equal((await jsonBody(response)).discussion.id, "topic one");
  });

  it("routes activity events through the dedicated activity read endpoint", async () => {
    const calls = [];
    const services = {
      activityApi: {
        async listActivityEvents(context) {
          calls.push(["listActivityEvents", context.request.method, new URL(context.request.url).searchParams.get("scenario")]);
          return { events: [{ id: "activity-1" }] };
        }
      }
    };

    const response = await dispatchApiRoute(
      makeContext("GET", "activity/events?scenario=community"),
      services,
      "activity/events"
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await jsonBody(response), { events: [{ id: "activity-1" }] });
    assert.deepEqual(calls, [["listActivityEvents", "GET", "community"]]);
  });

  it("routes catalog read models through purpose-built endpoints", async () => {
    const calls = [];
    const services = {
      readModelsApi: {
        async getApp(context, appId) {
          calls.push(["getApp", context.request.method, appId]);
          return { app: { id: appId } };
        },
        async listApps(context) {
          calls.push(["listApps", context.request.method]);
          return { apps: [{ id: "app-1" }] };
        },
        async listSkills(context) {
          calls.push(["listSkills", context.request.method]);
          return { skills: [{ id: "skill-1" }] };
        },
        async listDataServices(context) {
          calls.push(["listDataServices", context.request.method]);
          return { dataServices: [{ id: "mcp-1" }] };
        }
      }
    };

    const appResponse = await dispatchApiRoute(makeContext("GET", "apps/app%20one"), services, "apps/app%20one");
    const appsResponse = await dispatchApiRoute(makeContext("GET", "apps"), services, "apps");
    const skillsResponse = await dispatchApiRoute(makeContext("GET", "skills"), services, "skills");
    const dataServicesResponse = await dispatchApiRoute(makeContext("GET", "data-services"), services, "data-services");

    assert.deepEqual(await jsonBody(appResponse), { app: { id: "app one" } });
    assert.deepEqual(await jsonBody(appsResponse), { apps: [{ id: "app-1" }] });
    assert.deepEqual(await jsonBody(skillsResponse), { skills: [{ id: "skill-1" }] });
    assert.deepEqual(await jsonBody(dataServicesResponse), { dataServices: [{ id: "mcp-1" }] });
    assert.deepEqual(calls, [
      ["getApp", "GET", "app one"],
      ["listApps", "GET"],
      ["listSkills", "GET"],
      ["listDataServices", "GET"]
    ]);
  });

  it("dispatches forum reply like routes with the method-derived enabled flag", async () => {
    const calls = [];
    const services = {
      forumApi: {
        async setForumReplyLike(_context, topicId, replyId, enabled) {
          calls.push([topicId, replyId, enabled]);
          return { enabled, replyId, topicId };
        }
      }
    };

    const postResponse = await dispatchApiRoute(
      makeContext("POST", "forum/topics/topic-1/replies/reply-1/like"),
      services,
      "forum/topics/topic-1/replies/reply-1/like"
    );
    const deleteResponse = await dispatchApiRoute(
      makeContext("DELETE", "forum/topics/topic-1/replies/reply-1/like"),
      services,
      "forum/topics/topic-1/replies/reply-1/like"
    );

    assert.deepEqual(await jsonBody(postResponse), { enabled: true, replyId: "reply-1", topicId: "topic-1" });
    assert.deepEqual(await jsonBody(deleteResponse), { enabled: false, replyId: "reply-1", topicId: "topic-1" });
    assert.deepEqual(calls, [
      ["topic-1", "reply-1", true],
      ["topic-1", "reply-1", false]
    ]);
  });

  it("dispatches forum topic and reply pin routes with method-derived state", async () => {
    const calls = [];
    const services = {
      forumApi: {
        async setForumTopicPinned(_context, topicId, pinned) {
          calls.push(["topic", topicId, pinned]);
          return { id: topicId, pinned };
        },
        async setForumReplyPinned(_context, topicId, replyId, pinned) {
          calls.push(["reply", topicId, replyId, pinned]);
          return { id: replyId, pinned, topicId };
        }
      }
    };

    await dispatchApiRoute(makeContext("POST", "forum/topics/topic-1/pin"), services, "forum/topics/topic-1/pin");
    await dispatchApiRoute(makeContext("DELETE", "forum/topics/topic-1/replies/reply-1/pin"), services, "forum/topics/topic-1/replies/reply-1/pin");
    assert.deepEqual(calls, [["topic", "topic-1", true], ["reply", "topic-1", "reply-1", false]]);
  });

  it("dispatches forum Contributor award routes for topics and replies", async () => {
    const calls = [];
    const services = {
      forumApi: {
        async awardForumTopicContributor(_context, topicId) {
          calls.push(["topic", topicId]);
          return { topicId };
        },
        async awardForumReplyContributor(_context, topicId, replyId) {
          calls.push(["reply", topicId, replyId]);
          return { replyId, topicId };
        }
      }
    };

    const topicResponse = await dispatchApiRoute(
      makeContext("POST", "forum/topics/topic%201/contributor-award"),
      services,
      "forum/topics/topic%201/contributor-award"
    );
    const replyResponse = await dispatchApiRoute(
      makeContext("POST", "forum/topics/topic-1/replies/reply%201/contributor-award"),
      services,
      "forum/topics/topic-1/replies/reply%201/contributor-award"
    );

    assert.equal(topicResponse.status, 201);
    assert.equal(replyResponse.status, 201);
    assert.deepEqual(calls, [
      ["topic", "topic%201"],
      ["reply", "topic-1", "reply%201"]
    ]);
  });

  it("returns a stable 404 payload when no route matches", async () => {
    const response = await dispatchApiRoute(makeContext("GET", "missing/path"), {}, "missing/path");

    assert.equal(response.status, 404);
    assert.deepEqual(await jsonBody(response), { error: "not_found", path: "missing/path" });
  });

  it("does not expose the legacy activity-events catalog route", async () => {
    const response = await dispatchApiRoute(makeContext("GET", "activity-events"), {}, "activity-events");

    assert.equal(response.status, 404);
    assert.deepEqual(await jsonBody(response), { error: "not_found", path: "activity-events" });
  });
});
