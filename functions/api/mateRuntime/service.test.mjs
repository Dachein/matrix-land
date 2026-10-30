import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMatePreviewSessionApi } from "./service.ts";

const mateId = "knowledge-mate";
const releaseId = "knowledge-mate-r3";
const digest = `sha256:${"a".repeat(64)}`;

function releaseManifest(surface = "conversation") {
  const conversation = surface === "conversation" || surface === "both";
  const taskInbox = surface === "task_inbox" || surface === "both";
  return {
    channels: {
      embedded: { enabled: conversation },
      inbox: {
        email: { enabled: taskInbox },
        schedule: { enabled: taskInbox },
        mateCall: { enabled: taskInbox }
      },
      standalone: { enabled: conversation }
    },
    mate: {
      avatarRef: "https://assets.example.com/knowledge-mate.png"
    },
    experiencePolicy: {
      conversation: { channels: conversation ? ["web", "sdk"] : [], enabled: conversation },
      taskInbox: { channels: taskInbox ? ["mate_call", "email", "schedule"] : [], enabled: taskInbox }
    },
    taskPolicy: { defaultExecutor: conversation ? "knowledge_qa" : "operations" }
  };
}

class TestHttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function currentUser() {
  return {
    id: "user-owner-1",
    name: "Owner One",
    email: "owner@example.com",
    avatarUrl: "https://assets.example.com/owner.png",
    team: "Workspace Wealth",
    department: "Research",
    departmentId: "department-research",
    departmentPath: ["department-research"],
    jobTitle: "",
    role: "member",
    roles: [],
    identity: {
      objectId: "entra-object-owner-1",
      provider: "entra",
      tenantId: "tenant-1"
    }
  };
}

function context(body, env = {}, headers = {}) {
  return {
    env: {
      APPS_ORG_ID: "example-org",
      APPS_ORG_SLUG: "workspace-wealth",
      APPS_WORKER_URL: "https://apps.example.com",
      PORTAL_ISSUER: "frontier-workspace",
      MATE_PREVIEW_HOST_ENABLED: "true",
      MATE_RUNTIME_URL: "https://runtime.example.com",
      ...env
    },
    request: new Request("https://portal.example.com/api/mate-runtime/preview-sessions", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        origin: "https://portal.example.com",
        ...headers
      },
      method: "POST"
    })
  };
}

function harness(options = {}) {
  const calls = [];
  const audits = [];
  const runtimeClaims = [];
  const api = createMatePreviewSessionApi({
    audit: async (...args) => { audits.push(args); return "audit-1"; },
    fetch: options.fetch ?? (async (url, init) => {
      calls.push({ init, url: String(url) });
      if (String(url).startsWith("https://runtime.example.com/")) {
        return Response.json({ conversations: options.previewConversations ?? [] });
      }
      if (String(url).endsWith(`/mates/${mateId}`)) {
        return Response.json({
          mate: {
            description: "Answers from the selected knowledge base.",
            displayName: "Knowledge Mate",
            id: mateId,
            jobRole: "Knowledge specialist",
            orgId: "example-org",
            ownerUserId: "user-owner-1",
            previewReleaseId: releaseId
          }
        });
      }
      return Response.json({
        release: {
          id: releaseId,
          manifest: options.manifest ?? releaseManifest(),
          manifestSha256: digest,
          status: options.releaseStatus ?? "candidate",
          mateId,
          version: 3
        }
      });
    }),
    httpError: (status, code) => new TestHttpError(status, code),
    now: () => Date.parse("2026-08-27T10:00:00.000Z"),
    opaquePrincipalKey: async () => `opaque-${"1".repeat(32)}`,
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    readBody: (request) => request.json(),
    resolveCurrentUser: async () => options.currentUser ?? currentUser(),
    signAppsToken: async (_env, claims) => {
      assert.equal(claims.sub, "user-owner-1");
      assert.deepEqual(claims.scopes, ["apps:mates:read"]);
      return "signed-apps-owner-token";
    },
    signRuntimeToken: async (_env, claims) => {
      runtimeClaims.push(claims);
      return "signed-preview-runtime-token";
    }
  });
  return { api, audits, calls, runtimeClaims };
}

describe("Portal Mate Preview session boot", () => {
  it("boots a current-user Live Web draft without creating a Conversation", async () => {
    const calls = [];
    const { api, runtimeClaims } = harness({
      fetch: async (url, init) => {
        calls.push({ init, url: String(url) });
        const pathname = new URL(url).pathname;
        if (pathname.endsWith("/runtime")) return Response.json({
          release: { id: "knowledge-mate-r2", manifestSha256: digest, version: 2 },
          surface: { channels: ["sdk"], entries: [{ channel: "sdk", kind: "conversation" }], kind: "conversation" },
          mate: { avatarUrl: "https://assets.example.com/live-mate.png", description: "Answers", displayName: "Knowledge Mate", id: mateId, jobRole: "Research" }
        });
        if (pathname.endsWith("/conversations")) return Response.json({
          conversations: [{ channel: "web", id: "conv_legacy_web_1", title: "Legacy Web Conversation" }]
        });
        throw new Error(`unexpected runtime request ${url}`);
      }
    });
    const result = await api.createLiveSession(context({ mateId }));
    assert.equal(result.session.mode, "live");
    assert.equal(result.session.conversationId, "conv_00000000000040008000000000000001");
    assert.equal(result.session.conversationState, "draft");
    assert.equal(result.session.release.id, "knowledge-mate-r2");
    assert.equal(result.session.mate.avatarUrl, "https://assets.example.com/live-mate.png");
    assert.deepEqual(result.session.user, {
      avatarUrl: "https://assets.example.com/owner.png",
      name: "Owner One"
    });
    assert.equal(runtimeClaims[0].token_use, "mate_web_session");
    assert.equal(runtimeClaims[0].runtime_mode, "live");
    assert.equal(runtimeClaims[0].exp - runtimeClaims[0].iat, 30 * 60);
    assert.equal(result.session.expiresAt, "2026-08-27T10:30:00.000Z");
    assert.deepEqual(runtimeClaims[0].scopes, ["mate:invoke", "mate:preferences"]);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => new Headers(call.init.headers).get("authorization") === "Bearer signed-preview-runtime-token"));
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 0);
  });

  it("creates only a local Live draft coordinate from an explicit bounded intent", async () => {
    const calls = [];
    const { api } = harness({
      fetch: async (url, init) => {
        calls.push({ init, url: String(url) });
        const pathname = new URL(url).pathname;
        if (pathname.endsWith("/runtime")) return Response.json({
          release: { id: "knowledge-mate-r2", manifestSha256: digest, version: 2 },
          surface: { channels: ["sdk"], entries: [{ channel: "sdk", kind: "conversation" }], kind: "conversation" },
          mate: { displayName: "Knowledge Mate", id: mateId }
        });
        if (pathname.endsWith("/conversations")) {
          return Response.json({ conversations: [{ id: "conv_live_existing_1", title: "已有对话" }] });
        }
        throw new Error(`unexpected runtime request ${url}`);
      }
    });
    const result = await api.createLiveSession(context({ newConversation: true, mateId }));
    assert.equal(result.session.conversationId, "conv_00000000000040008000000000000001");
    assert.equal(result.session.conversationState, "draft");
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 0);

    await assert.rejects(
      () => api.createLiveSession(context({ conversationId: "conv_live_existing_1", newConversation: true, mateId })),
      (error) => error.status === 400 && error.message === "conversation_intent_ambiguous"
    );
    await assert.rejects(
      () => api.createLiveSession(context({ newConversation: "yes", mateId })),
      (error) => error.status === 400 && error.message === "new_conversation_invalid"
    );
  });

  it("optionally reuses the protected runtime directory without returning inline avatar data", async () => {
    const inlineAvatar = `data:image/jpeg;base64,${"a".repeat(60_000)}`;
    const { api } = harness({
      currentUser: { ...currentUser(), avatarUrl: inlineAvatar },
      fetch: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname.endsWith("/runtime")) return Response.json({
          release: { id: "knowledge-mate-r2", manifestSha256: digest, version: 2 },
          surface: { channels: ["sdk"], entries: [{ channel: "sdk", kind: "conversation" }], kind: "conversation" },
          mate: { displayName: "Knowledge Mate", id: mateId }
        });
        if (pathname.endsWith("/conversations")) return Response.json({
          conversations: [
            { channel: "sdk", id: "conv_live_current_1", title: "当前用户最近对话" },
            { channel: "web", id: "conv_live_web_1", title: "Web-only Conversation" }
          ]
        });
        throw new Error(`unexpected runtime request ${url}`);
      }
    });

    const result = await api.createLiveSession(context({ includeConversations: true, mateId }));

    assert.deepEqual(result.conversations, [
      { channel: "sdk", id: "conv_live_current_1", title: "当前用户最近对话" }
    ]);
    assert.deepEqual(result.session.user, { name: "Owner One" });
    assert.ok(JSON.stringify(result).length < 2_000);
  });

  it("recovers a stale Live Workspace coordinate inside the current user's own directory", async () => {
    const { api } = harness({
      fetch: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname.endsWith("/runtime")) return Response.json({
          release: { id: "knowledge-mate-r2", manifestSha256: digest, version: 2 },
          surface: { channels: ["sdk"], entries: [{ channel: "sdk", kind: "conversation" }], kind: "conversation" },
          mate: { displayName: "Knowledge Mate", id: mateId }
        });
        if (pathname.endsWith("/conversations")) return Response.json({
          conversations: [
            { channel: "sdk", id: "conv_live_current_1", title: "当前用户最近对话" },
            { channel: "web", id: "conv_legacy_web_1", title: "Legacy Web Conversation" }
          ]
        });
        throw new Error(`unexpected runtime request ${url}`);
      }
    });

    const result = await api.createLiveSession(context({
      conversationId: "conv_live_stale_1",
      mateId
    }));

    assert.equal(result.session.conversationId, "conv_live_current_1");
    assert.equal(result.session.conversationRecovered, true);
    assert.equal(result.session.conversationState, "persisted");
    assert.equal(result.session.mode, "live");
  });

  it("binds an owner session to the exact candidate Release and Preview namespace", async () => {
    const { api, audits, calls, runtimeClaims } = harness();
    const result = await api.createPreviewSession(context({ mateId, releaseId }));

    assert.equal(result.session.accessToken, "signed-preview-runtime-token");
    assert.equal(result.session.conversationId, "conv_preview_00000000000040008000000000000001");
    assert.equal(result.session.conversationState, "draft");
    assert.equal(result.session.mode, "preview");
    assert.equal(result.session.runtimeOrigin, "https://runtime.example.com");
    assert.equal(result.session.mate.avatarUrl, "https://assets.example.com/knowledge-mate.png");
    assert.deepEqual(result.session.user, {
      avatarUrl: "https://assets.example.com/owner.png",
      name: "Owner One"
    });
    assert.deepEqual(result.session.release, { id: releaseId, manifestSha256: digest, version: 3 });
    assert.deepEqual(result.session.surface, {
      channels: ["sdk"],
      entries: [{ channel: "sdk", kind: "conversation" }],
      kind: "conversation"
    });
    assert.equal(result.session.principalKey.includes("user-owner-1"), false);
    assert.equal(calls.length, 3);
    assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer signed-apps-owner-token");
    assert.equal(new Headers(calls[1].init.headers).get("authorization"), "Bearer signed-apps-owner-token");
    assert.equal(new Headers(calls[2].init.headers).get("authorization"), "Bearer signed-preview-runtime-token");
    assert.equal(runtimeClaims.length, 1);
    assert.deepEqual(runtimeClaims[0].scopes, ["mate:owner_test", "mate:invoke"]);
    assert.equal(runtimeClaims[0].runtime_mode, "preview");
    assert.equal(runtimeClaims[0].exp - runtimeClaims[0].iat, 5 * 60);
    assert.equal(result.session.expiresAt, "2026-08-27T10:05:00.000Z");
    assert.equal(runtimeClaims[0].mate_id, mateId);
    assert.equal(runtimeClaims[0].release_id, releaseId);
    assert.equal(runtimeClaims[0].sub, "user-owner-1");
    assert.equal(audits.length, 1);
    assert.equal(JSON.stringify(audits).includes("signed-preview-runtime-token"), false);
  });

  it("selects the Task Inbox surface from the exact candidate Release manifest", async () => {
    const { api } = harness({ manifest: releaseManifest("task_inbox") });
    const result = await api.createPreviewSession(context({ mateId, releaseId }));

    assert.deepEqual(result.session.surface, {
      channels: ["mate_call", "email", "schedule"],
      entries: [
        { channel: "mate_call", kind: "task_inbox" },
        { channel: "email", kind: "task_inbox" },
        { channel: "schedule", kind: "task_inbox" }
      ],
      kind: "task_inbox"
    });
  });

  it("exposes SDK conversation and Task Inbox as simultaneous owner Preview entries", async () => {
    const { api } = harness({ manifest: releaseManifest("both") });
    const result = await api.createPreviewSession(context({ mateId, releaseId }));

    assert.deepEqual(result.session.surface, {
      channels: ["sdk", "mate_call", "email", "schedule"],
      entries: [
        { channel: "sdk", kind: "conversation" },
        { channel: "mate_call", kind: "task_inbox" },
        { channel: "email", kind: "task_inbox" },
        { channel: "schedule", kind: "task_inbox" }
      ],
      kind: "conversation"
    });
  });

  it("reuses only a valid opaque conversation coordinate for hydration", async () => {
    const { api } = harness({
      previewConversations: [{ channel: "sdk", id: "conv_preview_existing_1", title: "已有对话" }]
    });
    const result = await api.createPreviewSession(context({
      conversationId: "conv_preview_existing_1",
      mateId,
      releaseId
    }));
    assert.equal(result.session.conversationId, "conv_preview_existing_1");
    assert.equal(result.session.conversationState, "persisted");

    await assert.rejects(
      () => api.createPreviewSession(context({ conversationId: "../../live", mateId, releaseId })),
      (error) => error.status === 400 && error.message === "conversation_id_invalid"
    );
  });

  it("fails closed when the Preview pointer moved or is no longer a candidate", async () => {
    const { api } = harness({ releaseStatus: "published" });
    await assert.rejects(
      () => api.createPreviewSession(context({ mateId, releaseId })),
      (error) => error.status === 409 && error.message === "mate_preview_release_changed"
    );
  });

  it("rejects cross-origin token minting and a disabled Host before authentication", async () => {
    let resolved = 0;
    const { api } = harness();
    await assert.rejects(
      () => api.createPreviewSession(context(
        { mateId, releaseId },
        {},
        { origin: "https://attacker.example.com" }
      )),
      (error) => error.status === 403 && error.message === "mate_preview_origin_invalid"
    );

    const disabled = createMatePreviewSessionApi({
      httpError: (status, code) => new TestHttpError(status, code),
      opaquePrincipalKey: async () => "unused",
      readBody: async () => ({}),
      resolveCurrentUser: async () => { resolved += 1; return currentUser(); },
      signAppsToken: async () => "unused",
      signRuntimeToken: async () => "unused"
    });
    await assert.rejects(
      () => disabled.createPreviewSession(context({ mateId, releaseId }, { MATE_PREVIEW_HOST_ENABLED: "false" })),
      (error) => error.status === 404 && error.message === "mate_preview_host_disabled"
    );
    assert.equal(resolved, 0);
  });

  it("maps owner/control-plane denial to a non-enumerable not-found response", async () => {
    const { api } = harness({
      fetch: async () => Response.json({ error: "mate_not_found" }, { status: 403 })
    });
    await assert.rejects(
      () => api.createPreviewSession(context({ mateId, releaseId })),
      (error) => error.status === 404 && error.message === "mate_preview_not_found"
    );
  });
});
