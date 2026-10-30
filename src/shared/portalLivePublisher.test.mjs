import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  publishPortalLiveEvent,
  schedulePortalLiveEvent
} from "./portalLivePublisher.ts";

describe("Portal Live publisher", () => {
  it("schedules an authenticated activity lookup without blocking the request", async () => {
    let deferred;
    let captured;
    const context = {
      env: {
        PORTAL_LIVE_WORKSPACE_ID: "test-workspace", LIVE_PUBLISH_TOKEN: "live-secret",
        LIVE_WORKER_URL: "https://live.example.test/",
        PORTAL_LIVE_WORKSPACE_ID: "workspace-1"
      },
      request: new Request("https://portal.example.test/api/forum/topics", {
        headers: { "x-request-id": "request-1" }
      }),
      waitUntil(promise) {
        deferred = promise;
      }
    };

    const scheduled = schedulePortalLiveEvent(context, { activityEventId: "activity-1" }, {
      fetch: async (url, init) => {
        captured = { init, url };
        return new Response(JSON.stringify({ published: true }), { status: 200 });
      }
    });

    assert.equal(scheduled, true);
    assert.ok(deferred instanceof Promise);
    await deferred;
    assert.equal(captured.url, "https://live.example.test/v1/events");
    assert.equal(captured.init.headers.Authorization, "Bearer live-secret");
    assert.equal(captured.init.headers["x-request-id"], "request-1");
    assert.deepEqual(JSON.parse(captured.init.body), {
      activityEventId: "activity-1",
      workspaceId: "workspace-1"
    });
  });

  it("does not schedule when the shared publisher secret is absent", () => {
    let called = false;
    const scheduled = schedulePortalLiveEvent(
      { env: {}, waitUntil() { called = true; } },
      { notificationId: "notification-1" }
    );

    assert.equal(scheduled, false);
    assert.equal(called, false);
  });

  it("rejects non-success responses so the scheduler can log and polling can reconcile", async () => {
    await assert.rejects(
      () => publishPortalLiveEvent(
        { LIVE_PUBLISH_TOKEN: "live-secret",LIVE_WORKER_URL:"https://live.example.test",PORTAL_LIVE_WORKSPACE_ID:"test-workspace" },
        { notificationId: "notification-1" },
        {
          fetch: async () => new Response(null, { status: 404 }),
          timeoutMs: 500
        }
      ),
      /portal_live_publish_http_404/
    );
  });
});
