import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canReceiveCollaborationNotificationEmail,
  renderCollaborationNotificationEmail
} from "../../../src/shared/collaborationNotificationEmail.ts";
import { createNotificationsApi } from "./service.ts";

describe("collaboration notification email", () => {
  it("renders the unified invited-user treatment and escapes user content", () => {
    const email = renderCollaborationNotificationEmail({
      actorName: "Grace <Admin>",
      excerpt: "请查看 <script>alert('x')</script>",
      kind: "collaborator_added",
      recipientName: "Helen",
      recipientStatus: "invited",
      resourceName: "Investment Research",
      resourceType: "knowledge",
      resourceUrl: "https://portal.example.com/#/knowledge/investment",
      permissionLabel: "协作者"
    });

    assert.equal(email.subject, "[Frontier Workspace] 你已被添加为协作者 · Investment Research");
    assert.match(email.preheader, /Grace <Admin>/);
    assert.match(email.html, /账号仍处于邀请状态/);
    assert.match(email.html, /Grace &lt;Admin&gt;/);
    assert.doesNotMatch(email.html, /<script>/);
    assert.match(email.text, /完成首次登录/);
  });

  it("limits delivery eligibility to active and invited accounts", () => {
    assert.equal(canReceiveCollaborationNotificationEmail("active"), true);
    assert.equal(canReceiveCollaborationNotificationEmail("invited"), true);
    assert.equal(canReceiveCollaborationNotificationEmail("inactive"), false);
    assert.throws(() => renderCollaborationNotificationEmail({
      actorName: "Grace",
      kind: "mention",
      recipientStatus: "inactive",
      resourceName: "AI Forum",
      resourceType: "forum",
      resourceUrl: "https://portal.example.com/#/posts/topic-1"
    }), /recipient_status_not_notifiable/);
  });

  it("keeps forum mentions free of permission terminology", () => {
    const email = renderCollaborationNotificationEmail({
      actorName: "Michelle",
      excerpt: "请确认这段内容。",
      kind: "mention",
      permissionLabel: "被提及人",
      recipientName: "Helen",
      recipientStatus: "active",
      resourceName: "AI Meeting Notes",
      resourceType: "forum",
      resourceUrl: "https://portal.example.com/#/posts/topic-1"
    });

    assert.doesNotMatch(email.html, /你的权限|被提及人/);
    assert.doesNotMatch(email.text, /你的权限|被提及人/);
    assert.match(email.html, /#66765b/);
    assert.match(email.html, /bgcolor="#e85e19"/);
    assert.match(email.html, />FW<\/td>/);
    assert.doesNotMatch(email.html, /border-bottom:4px solid #b7f43a/);
    assert.doesNotMatch(email.html, /#ff5a1f/);
    assert.doesNotMatch(email.html, /#9f1239/);
  });

  it("renders community contribution awards without permission terminology", () => {
    const email = renderCollaborationNotificationEmail({
      actorName: "Billy Fung",
      excerpt: "修复重大缺陷，解决了自定义模型调用失败问题。",
      kind: "contribution_awarded",
      permissionLabel: "+40 积分",
      recipientName: "Ada",
      recipientStatus: "active",
      resourceName: "模型调用报错排查",
      resourceType: "forum",
      resourceUrl: "https://portal.example.com/#/community/topic-1"
    });

    assert.equal(email.subject, "[Frontier Workspace] 你获得了社区贡献 · 模型调用报错排查");
    assert.match(email.text, /社区贡献/);
    assert.match(email.text, /修复重大缺陷/);
    assert.doesNotMatch(email.text, /你的权限/);
  });
});

describe("notifications api", () => {
  it("lists unread notifications for the current user", async () => {
    const { db, state } = notificationsDb();
    const api = createNotificationsApi(deps());
    const result = await api.listNotifications(context(db, "GET", "/api/notifications"));

    assert.equal(result.unreadCount, 1);
    assert.equal(result.notifications[0].id, "notification-1");
    assert.equal(result.notifications[0].status, "unread");
    assert.equal(result.notifications[0].topicTitle, "Mention contract");
    assert.match(state.prepared[0], /LIMIT 10/);
  });

  it("returns the full unread count instead of counting only the page", async () => {
    const { db } = notificationsDb({ unreadCount: 63 });
    const api = createNotificationsApi(deps());
    const result = await api.listNotifications(context(db, "GET", "/api/notifications"));

    assert.equal(result.notifications.length, 1);
    assert.equal(result.unreadCount, 63);
  });

  it("marks either selected notifications or all notifications as read", async () => {
    const { db, state } = notificationsDb();
    const api = createNotificationsApi(deps());

    await api.markNotificationsRead(context(db, "POST", "/api/notifications/notification-1/read"), "notification-1");
    await api.markNotificationsRead(context(db, "POST", "/api/notifications/read", {}));

    assert.equal(state.batches.length, 1);
    assert.match(state.batches[0][0].sql, /WHERE id = \?/);
    assert.equal(state.batches[0][0].bindings[0], "notification-1");
    assert.equal(state.batches[0][0].bindings[1], "user-1");
    assert.equal(state.runs.length, 1);
    assert.match(state.runs[0].sql, /WHERE recipient_user_id = \?/);
    assert.equal(state.runs[0].bindings[0], "user-1");
  });

  it("defers a Live lookup after a notification read is committed", async () => {
    const { db } = notificationsDb();
    const api = createNotificationsApi(deps());
    const originalFetch = globalThis.fetch;
    const requests = [];
    let deferred;
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(null, { status: 202 });
    };

    try {
      const requestContext = context(db, "POST", "/api/notifications/notification-1/read");
      requestContext.env.LIVE_PUBLISH_TOKEN = "live-secret";
      requestContext.env.PORTAL_LIVE_WORKSPACE_ID = "test-workspace";
      requestContext.env.LIVE_WORKER_URL = "https://live.example.test";
      requestContext.waitUntil = (promise) => {
        deferred = promise;
      };

      await api.markNotificationsRead(requestContext, "notification-1");
      assert.ok(deferred instanceof Promise);
      await deferred;
      assert.deepEqual(requests, [{
        notificationId: "notification-1",
        workspaceId: "test-workspace"
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function context(db, method, path, body) {
  return {
    env: { DB: db },
    request: new Request(`https://portal.test${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { "content-type": "application/json" },
      method
    })
  };
}

function deps() {
  return {
    readBody: (request) => request.json().catch(() => ({})),
    requireDb: (db) => db,
    resolveCurrentUser: async () => ({
      email: "ada@example.test",
      id: "user-1",
      name: "Ada",
      role: "member",
      team: "AI Adoption"
    })
  };
}

function notificationsDb({ unreadCount = 1 } = {}) {
  const state = {
    batches: [],
    prepared: [],
    runs: []
  };
  const db = {
    prepare(sql) {
      state.prepared.push(sql);
      return {
        bind(...bindings) {
          const statement = {
            bindings,
            sql,
            async all() {
              if (sql.includes("SELECT COUNT(*) AS unreadCount")) {
                return { results: [{ unreadCount }] };
              }
              return {
                results: [{
                  actorAvatarUrl: "https://example.test/avatar.png",
                  actorName: "Grace",
                  actorUserId: "user-grace",
                  createdAt: "2026-07-12T00:00:00.000Z",
                  id: "notification-1",
                  notificationType: "mention",
                  postId: "post-1",
                  readAt: "",
                  status: "unread",
                  topicId: "topic-1",
                  topicTitle: "Mention contract"
                }]
              };
            },
            async run() {
              state.runs.push(statement);
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

  return { db, state };
}
