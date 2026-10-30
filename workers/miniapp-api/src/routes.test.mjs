import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dispatchMiniappRoutes } from "./routes.ts";

function context(method, path, init = {}) {
  return {
    env: {},
    request: new Request(`https://ai.example.invalid/api/${path}`, { method, ...init })
  };
}

describe("miniapp Worker routes", () => {
  it("exposes an unambiguous Worker health identity", async () => {
    const response = await dispatchMiniappRoutes(context("GET", "miniapp/v1/health"), {}, "miniapp/v1/health");

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: "workspace-miniapp-api" });
  });

  it("owns auth and Mate control-plane calls in the dedicated namespace", async () => {
    const calls = [];
    const services = {
      appsProxyApi: {
        proxyAppsWorkerRequest(_context, path) {
          calls.push(["apps", path]);
          return Response.json({ mates: [] });
        }
      },
      miniappFacadeApi: {
        proxyAuth(_context, path) {
          calls.push(["auth", path]);
          return Response.json({ authenticated: true });
        }
      }
    };

    await dispatchMiniappRoutes(context("POST", "miniapp/v1/auth/scan/prepare"), services, "miniapp/v1/auth/scan/prepare");
    await dispatchMiniappRoutes(context("POST", "miniapp/v1/auth/scan/exchange"), services, "miniapp/v1/auth/scan/exchange");
    await dispatchMiniappRoutes(context("GET", "miniapp/v1/mates"), services, "miniapp/v1/mates");
    await dispatchMiniappRoutes(context("GET", "miniapp/v1/mates/default"), services, "miniapp/v1/mates/default");
    await dispatchMiniappRoutes(context("POST", "miniapp/v1/mates/default"), services, "miniapp/v1/mates/default");
    await dispatchMiniappRoutes(
      context("POST", "miniapp/v1/mates/mate-1/releases/r1/publish"),
      services,
      "miniapp/v1/mates/mate-1/releases/r1/publish"
    );
    await dispatchMiniappRoutes(context("PATCH", "miniapp/v1/mates/mate-1"), services, "miniapp/v1/mates/mate-1");
    await dispatchMiniappRoutes(context("DELETE", "miniapp/v1/mates/mate-1"), services, "miniapp/v1/mates/mate-1");

    assert.deepEqual(calls, [
      ["auth", "/auth/miniapp/scan/prepare"],
      ["auth", "/auth/miniapp/scan/exchange"],
      ["apps", "apps/mates"],
      ["apps", "apps/mates/default"],
      ["apps", "apps/mates/default"],
      ["apps", "apps/mates/mate-1/releases/r1/publish"],
      ["apps", "apps/mates/mate-1"],
      ["apps", "apps/mates/mate-1"]
    ]);
  });

  it("returns canonical auth links and hides the upstream Runtime origin", async () => {
    const auth = await dispatchMiniappRoutes(
      context("GET", "miniapp/v1/auth/session"),
      {
        async readAuthSession() {
          return { authenticated: false };
        }
      },
      "miniapp/v1/auth/session"
    );
    assert.deepEqual(await auth.json(), {
      authenticated: false,
      emailLoginUrl: "/api/miniapp/v1/auth/email/login",
      loginUrl: "/api/miniapp/v1/auth/scan/exchange",
      logoutUrl: "/api/miniapp/v1/auth/logout"
    });

    const sessionResponse = await dispatchMiniappRoutes(
      context("POST", "miniapp/v1/sessions", {
        body: "{}",
        headers: { "content-type": "application/json" }
      }),
      {
        matePreviewSessionApi: {
          async createLiveSession() {
            return {
              conversations: [{ channel: "sdk", id: "conv-1" }],
              session: {
                accessToken: "runtime-token",
                conversationId: "conv-1",
                runtimeOrigin: "https://runtime.internal.test"
              }
            };
          }
        }
      },
      "miniapp/v1/sessions"
    );
    const sessionPayload = await sessionResponse.json();
    assert.equal(sessionResponse.status, 201);
    assert.equal(sessionPayload.session.runtimeOrigin, undefined);
    assert.equal(sessionPayload.session.accessToken, "runtime-token");
  });

  it("whitelists only the required Runtime HTTP and WebSocket routes", async () => {
    const calls = [];
    const services = {
      miniappFacadeApi: {
        proxyRuntime(_context, path) {
          calls.push(path);
          return new Response("proxied");
        }
      }
    };
    const base = "miniapp/v1/mates/mate-1/conversations/conv-1";
    await dispatchMiniappRoutes(context("POST", `${base}/chat-grants`), services, `${base}/chat-grants`);
    await dispatchMiniappRoutes(context("GET", `${base}/chat/get-messages`), services, `${base}/chat/get-messages`);
    await dispatchMiniappRoutes(
      context("GET", `${base}/chat`, { headers: { upgrade: "websocket" } }),
      services,
      `${base}/chat`
    );
    await dispatchMiniappRoutes(
      context("GET", "miniapp/v1/mates/mate-1/workspace-files/file-1/download"),
      services,
      "miniapp/v1/mates/mate-1/workspace-files/file-1/download"
    );
    const thumbnail = "miniapp/v1/mates/mate-1/workspace-files/file-1/thumbnail";
    await dispatchMiniappRoutes(context("GET", thumbnail), services, thumbnail);
    assert.equal((await dispatchMiniappRoutes(context("POST", thumbnail), services, thumbnail)).status, 404);
    const rejected = await dispatchMiniappRoutes(context("GET", "miniapp/v1/admin"), services, "miniapp/v1/admin");

    assert.deepEqual(calls, [
      "/v1/mates/mate-1/conversations/conv-1/chat-grants",
      "/v1/mates/mate-1/conversations/conv-1/chat/get-messages",
      "/v1/mates/mate-1/conversations/conv-1/chat",
      "/v1/mates/mate-1/workspace-files/file-1/download",
      "/v1/mates/mate-1/workspace-files/file-1/thumbnail"
    ]);
    assert.equal(rejected.status, 404);
    assert.deepEqual(await rejected.json(), { error: "miniapp_route_not_found" });
  });

  it("allows scoped task results and artifact saves without opening arbitrary runtime writes", async () => {
    const calls = [];
    const services = { miniappFacadeApi: { proxyRuntime(_context, path) { calls.push(path); return Response.json({}); } } };
    const task = "miniapp/v1/mates/mate-1/tasks";
    const save = "miniapp/v1/mates/mate-1/workspace-files/art_01234567-89ab-cdef-0123-456789abcdef/knowledge";
    await dispatchMiniappRoutes(context("GET", task), services, task);
    await dispatchMiniappRoutes(context("POST", save), services, save);
    assert.equal((await dispatchMiniappRoutes(context("POST", task), services, task)).status, 404);
    assert.equal((await dispatchMiniappRoutes(context("DELETE", save), services, save)).status, 404);
    assert.equal(calls.length, 2);
  });

  it("exposes the allow-listed Knowledge preview contract", async () => {
    const calls = [];
    const services = {
      knowledgeApi: {
        listServices() { calls.push("list"); return { services: [] }; },
        readService(_context, serviceId) { calls.push(["service", serviceId]); return { service: { id: serviceId } }; },
        readHandbook(_context, serviceId) { calls.push(["handbook", serviceId]); return { content: "# Handbook" }; },
        queryService(_context, serviceId, action, body) { calls.push([action, serviceId, body]); return { results: [] }; },
        resolvePreviewTarget(_context, body) { calls.push(["resolve", body]); return { target: body }; }
      }
    };

    await dispatchMiniappRoutes(context("GET", "miniapp/v1/knowledge-services"), services, "miniapp/v1/knowledge-services");
    await dispatchMiniappRoutes(context("GET", "miniapp/v1/knowledge-services/kb-1"), services, "miniapp/v1/knowledge-services/kb-1");
    await dispatchMiniappRoutes(context("GET", "miniapp/v1/knowledge-services/kb-1/handbook"), services, "miniapp/v1/knowledge-services/kb-1/handbook");
    await dispatchMiniappRoutes(
      context("POST", "miniapp/v1/knowledge-services/kb-1/read", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "docs/guide.md" })
      }),
      services,
      "miniapp/v1/knowledge-services/kb-1/read"
    );
    await dispatchMiniappRoutes(
      context("POST", "miniapp/v1/knowledge-preview/resolve", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serviceId: "kb-1", objectId: "file-1" })
      }),
      services,
      "miniapp/v1/knowledge-preview/resolve"
    );
    const rejected = await dispatchMiniappRoutes(
      context("DELETE", "miniapp/v1/knowledge-services/kb-1"),
      services,
      "miniapp/v1/knowledge-services/kb-1"
    );

    assert.deepEqual(calls, [
      "list",
      ["service", "kb-1"],
      ["handbook", "kb-1"],
      ["read", "kb-1", { path: "docs/guide.md" }],
      ["resolve", { serviceId: "kb-1", objectId: "file-1" }]
    ]);
    assert.equal(rejected.status, 404);
  });

  it("routes Knowledge file uploads through the scoped API", async () => {
    let uploaded = false;
    const response = await dispatchMiniappRoutes(
      context("POST", "miniapp/v1/knowledge-library/files", { body: new FormData() }),
      { knowledgeApi: { uploadFile() { uploaded = true; return { item: { id: "file-1" } }; } } },
      "miniapp/v1/knowledge-library/files"
    );
    assert.equal(uploaded, true);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { item: { id: "file-1" } });
  });

  it("routes staged file upload creation, chunks, and completion", async () => {
    const calls = [];
    const services = { fileUploadApi: {
      async start() { calls.push("start"); return { uploadId: "123" }; },
      async putChunk(_context, id, index) { calls.push(["chunk", id, index]); return { received: true }; },
      async complete(_context, id) { calls.push(["complete", id]); return Response.json({ item: { id: "file-1" } }, { status: 201 }); }
    } };
    const id = "00000000-0000-4000-8000-000000000001";
    await dispatchMiniappRoutes(context("POST", "miniapp/v1/file-uploads"), services, "miniapp/v1/file-uploads");
    await dispatchMiniappRoutes(context("PUT", `miniapp/v1/file-uploads/${id}/chunks/2`), services, `miniapp/v1/file-uploads/${id}/chunks/2`);
    const completed = await dispatchMiniappRoutes(context("POST", `miniapp/v1/file-uploads/${id}/complete`), services, `miniapp/v1/file-uploads/${id}/complete`);
    assert.deepEqual(calls, ["start", ["chunk", id, 2], ["complete", id]]);
    assert.equal(completed.status, 201);
  });
});
