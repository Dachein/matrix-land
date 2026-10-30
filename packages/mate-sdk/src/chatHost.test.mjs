import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createElement, Suspense } from "react";
import { renderToReadableStream } from "react-dom/server";
import {
  createWorkspaceMateChatGrantManager,
  requestWorkspaceMateChatGrant
} from "../dist/chatGrant.js";
import {
  createWorkspaceMateAgentConnectionConfig,
  createWorkspaceMateChatTurnBody,
  createWorkspaceMateInitialMessagesLoader,
  createWorkspaceMateMountInstanceId,
  WORKSPACE_MATE_CONNECTION_QUERY_CACHE_TTL_MS,
  WORKSPACE_MATE_CHAT_TRANSPORT_POLICY
} from "../dist/chatHost.js";
import {
  WorkspaceMateConversationCache,
  WorkspaceMatePersistentConversationCache
} from "../dist/conversationCache.js";
import {
  prepareWorkspaceMateUserMessage,
  reconcileCachedConversation,
  useWorkspaceMateChat
} from "../dist/react.js";

const origin = "https://runtime.example.com";
const mateId = "portfolio-mate";
const conversationId = "conversation-1001";

function environment(revision = 1, ref = "pf_123") {
  return {
    schemaVersion: "workspace.mate-environment/v1",
    revision,
    host: { appId: "portfolio-app", surface: "embedded" },
    location: { kind: "portfolio.portfolio", ref }
  };
}

function grant(expiresAt, token = "signed.chat.grant", releaseId = "release-1001") {
  return { expiresAt, grant: token, mode: "live", releaseId };
}

describe("Workspace Mate SDK Host Cloudflare adapter", () => {
  it("keeps a bounded per-Conversation transcript cache in tab memory", () => {
    let now = 1_000;
    const cache = new WorkspaceMateConversationCache({
      maxConversations: 2,
      maxMessages: 2,
      now: () => now,
      ttlMs: 5_000
    });
    const coordinate = (conversationId) => ({
      conversationId,
      mode: "live",
      principalKey: "opaque-principal",
      mateId
    });
    cache.write(coordinate("conversation-1"), [{ id: "m1" }, { id: "m2" }, { id: "m3" }]);
    assert.deepEqual(cache.read(coordinate("conversation-1")).map((message) => message.id), ["m2", "m3"]);
    cache.write(coordinate("conversation-2"), [{ id: "m4" }]);
    cache.write(coordinate("conversation-3"), [{ id: "m5" }]);
    assert.equal(cache.read(coordinate("conversation-1")), undefined);
    now += 5_001;
    assert.equal(cache.read(coordinate("conversation-3")), undefined);
  });

  it("retains local transcripts across cache instances without expiry or cross-principal reads", () => {
    const values = new Map();
    const storage = {
      get length() { return values.size; },
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, value)
    };
    const coordinate = {
      conversationId: "conversation-1",
      mode: "preview",
      principalKey: "opaque-principal-a",
      releaseId: "release-1",
      mateId
    };
    const messages = [{ id: "user-1", role: "user", parts: [{ type: "text", text: "Saved locally" }] }];
    new WorkspaceMatePersistentConversationCache(() => storage).write(coordinate, messages);
    const reloaded = new WorkspaceMatePersistentConversationCache(() => storage);
    assert.deepEqual(reloaded.read(coordinate), messages);
    assert.equal(reloaded.read({ ...coordinate, principalKey: "opaque-principal-b" }), undefined);
    assert.equal(reloaded.read({ ...coordinate, releaseId: "release-2" }), undefined);
    reloaded.clearScope({
      mode: coordinate.mode,
      principalKey: coordinate.principalKey,
      releaseId: coordinate.releaseId,
      mateId
    });
    assert.equal(reloaded.read(coordinate), undefined);
  });

  it("keeps chat usable when browser storage is unavailable", () => {
    const cache = new WorkspaceMatePersistentConversationCache(() => ({
      setItem() { throw new Error("quota_exceeded"); }
    }));
    assert.doesNotThrow(() => cache.write({ conversationId, mode: "live", principalKey: "opaque", mateId }, []));
  });

  it("revalidates cached messages without dropping a locally submitted tail", () => {
    const baseline = [{ id: "user-1", role: "user", parts: [{ type: "text", text: "old" }] }];
    const current = [
      ...baseline,
      { id: "user-2", role: "user", parts: [{ type: "text", text: "new local" }] }
    ];
    const authoritative = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "server" }] },
      { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "answer" }] }
    ];
    assert.deepEqual(
      reconcileCachedConversation(authoritative, current, baseline).map((message) => message.id),
      ["user-1", "assistant-1", "user-2"]
    );
  });

  it("appends a caller-identified user message without invoking AI SDK replacement semantics", () => {
    assert.deepEqual(prepareWorkspaceMateUserMessage("  hello Preview  "), {
      text: "hello Preview"
    });
    assert.deepEqual(prepareWorkspaceMateUserMessage("  hello Preview  ", {
      messageId: "preview-message-1001"
    }), {
      id: "preview-message-1001",
      parts: [{ text: "hello Preview", type: "text" }],
      role: "user"
    });
    assert.throws(
      () => prepareWorkspaceMateUserMessage("hello", { messageId: "invalid id" }),
      /mate_chat_message_id_invalid/
    );
  });

  it("admits only bounded Workspace attachment references into a new user message", () => {
    const prepared = prepareWorkspaceMateUserMessage("请分析附件", {
      files: [{
        filename: "allocation.xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        type: "file",
        url: "/api/workspace-files/object-123/raw"
      }]
    });
    assert.deepEqual(prepared, {
      parts: [
        { text: "请分析附件", type: "text" },
        {
          filename: "allocation.xlsx",
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          type: "file",
          url: "/api/workspace-files/object-123/raw"
        }
      ],
      role: "user"
    });
    assert.throws(
      () => prepareWorkspaceMateUserMessage("test", {
        files: [{ filename: "bad.pdf", mediaType: "application/pdf", type: "file", url: "https://evil.example/file" }]
      }),
      (error) => error?.code === "mate_chat_message_files_invalid"
    );
  });

  it("gets a short-lived grant with the Runtime Bearer only on the protected POST", async () => {
    const calls = [];
    const response = grant("2026-08-27T10:02:00.000Z");
    const result = await requestWorkspaceMateChatGrant({
      accessToken: async () => "runtime-user-bearer",
      conversationId,
      fetch: async (url, init) => {
        calls.push({ init, url: String(url) });
        return Response.json(response, { status: 201 });
      },
      runtimeOrigin: origin,
      mateId
    });

    assert.deepEqual(result, response);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${origin}/v1/mates/${mateId}/conversations/${conversationId}/chat-grants`);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer runtime-user-bearer");
    assert.equal(calls[0].init.body, undefined);
  });

  it("coalesces grant requests and refreshes inside the expiry skew", async () => {
    let now = Date.parse("2026-08-27T10:00:00.000Z");
    let requests = 0;
    const manager = createWorkspaceMateChatGrantManager({
      accessToken: "runtime-user-bearer",
      conversationId,
      fetch: async () => {
        requests += 1;
        return Response.json(grant(new Date(now + 120_000).toISOString(), `grant-${requests}`), { status: 201 });
      },
      now: () => now,
      principalKey: "auth-session-principal-a",
      refreshSkewMs: 30_000,
      runtimeOrigin: origin,
      mateId
    });

    const [first, concurrent] = await Promise.all([manager.get(), manager.get()]);
    assert.equal(first.grant, "grant-1");
    assert.equal(concurrent.grant, "grant-1");
    assert.equal(requests, 1);
    now += 89_999;
    assert.equal((await manager.get()).grant, "grant-1");
    now += 2;
    assert.equal((await manager.get()).grant, "grant-2");
    assert.equal(requests, 2);
  });

  it("keeps Suspense manager and query keys stable while isolating auth principals", () => {
    const first = createWorkspaceMateChatGrantManager({
      accessToken: () => "first-inline-bearer",
      conversationId,
      fetch: async () => Response.json({}),
      principalKey: "opaque-auth-session-a",
      runtimeOrigin: origin,
      mateId
    });
    const reconstructed = createWorkspaceMateChatGrantManager({
      accessToken: () => "rotated-inline-bearer",
      conversationId,
      fetch: async () => Response.json({}),
      principalKey: "opaque-auth-session-a",
      runtimeOrigin: origin,
      mateId
    });
    const otherPrincipal = createWorkspaceMateChatGrantManager({
      accessToken: () => "other-principal-bearer",
      conversationId,
      fetch: async () => Response.json({}),
      principalKey: "opaque-auth-session-b",
      runtimeOrigin: origin,
      mateId
    });
    const firstConnection = createWorkspaceMateAgentConnectionConfig({
      conversationId,
      grantManager: first,
      runtimeOrigin: origin,
      mateId
    });
    const reconstructedConnection = createWorkspaceMateAgentConnectionConfig({
      conversationId,
      grantManager: reconstructed,
      runtimeOrigin: origin,
      mateId
    });
    const otherConnection = createWorkspaceMateAgentConnectionConfig({
      conversationId,
      grantManager: otherPrincipal,
      runtimeOrigin: origin,
      mateId
    });

    assert.equal(first.dependencyKey, reconstructed.dependencyKey);
    assert.equal(firstConnection.name, reconstructedConnection.name);
    assert.deepEqual(firstConnection.queryDeps, reconstructedConnection.queryDeps);
    assert.notEqual(first.dependencyKey, otherPrincipal.dependencyKey);
    assert.notEqual(firstConnection.name, otherConnection.name);
    assert.notDeepEqual(firstConnection.queryDeps, otherConnection.queryDeps);
    for (const sensitive of [
      "first-inline-bearer",
      "rotated-inline-bearer",
      "opaque-auth-session-a"
    ]) {
      assert.equal(first.dependencyKey.includes(sensitive), false);
      assert.equal(firstConnection.name.includes(sensitive), false);
      assert.equal(JSON.stringify(firstConnection.queryDeps).includes(sensitive), false);
    }
  });

  it("uses the latest bearer provider and fetch without changing the resource key", async () => {
    const now = Date.parse("2026-08-27T10:00:00.000Z");
    let initialFetchCalled = false;
    const manager = createWorkspaceMateChatGrantManager({
      accessToken: "old-bearer",
      conversationId,
      fetch: async () => {
        initialFetchCalled = true;
        return Response.json({});
      },
      now: () => now,
      principalKey: "opaque-auth-session-a",
      runtimeOrigin: origin,
      mateId
    });
    const dependencyKey = manager.dependencyKey;
    const authorizations = [];
    manager.updateCredentials({
      accessToken: () => "new-inline-bearer",
      fetch: async (_url, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return Response.json(grant("2026-08-27T10:02:00.000Z"), { status: 201 });
      }
    });

    assert.equal((await manager.get()).grant, "signed.chat.grant");
    assert.equal(initialFetchCalled, false);
    assert.deepEqual(authorizations, ["Bearer new-inline-bearer"]);
    assert.equal(manager.dependencyKey, dependencyKey);
  });

  it("puts only the short-lived grant in the WebSocket query and isolates CF caches", async () => {
    const manager = {
      dependencyKey: `workspace-chat-resource-v1-${"1".repeat(32)}`,
      get: async () => grant("2026-08-27T10:02:00.000Z", "ws-grant")
    };
    const config = createWorkspaceMateAgentConnectionConfig({
      conversationId,
      grantManager: manager,
      runtimeOrigin: origin,
      mateId
    });
    const otherHost = createWorkspaceMateAgentConnectionConfig({
      conversationId,
      grantManager: { ...manager, dependencyKey: `workspace-chat-resource-v1-${"2".repeat(32)}` },
      runtimeOrigin: "https://runtime-two.example.com",
      mateId
    });

    assert.equal(config.agent, "MateChatAgent");
    assert.equal(config.basePath, `v1/mates/${mateId}/conversations/${conversationId}/chat`);
    assert.equal(config.host, "runtime.example.com");
    assert.equal(config.protocol, "wss");
    assert.equal(config.cacheTtl, WORKSPACE_MATE_CONNECTION_QUERY_CACHE_TTL_MS);
    assert.ok(config.cacheTtl > 5 * 60_000, "an open connection must outlive short chat grants without suspending the UI");
    assert.deepEqual(await config.query(), { grant: "ws-grant" });
    assert.notEqual(config.name, otherHost.name);
    assert.notDeepEqual(config.queryDeps, otherHost.queryDeps);
    const wsUrl = new URL(`wss://${config.host}/${config.basePath}`);
    Object.entries(await config.query()).forEach(([key, value]) => wsUrl.searchParams.set(key, value));
    assert.deepEqual([...wsUrl.searchParams.keys()], ["grant"]);
    assert.equal(wsUrl.search.includes("runtime-user-bearer"), false);
    assert.equal(wsUrl.search.includes("environment"), false);
  });

  it("honors the real React Suspense/basePath contract and runtime-allowlists Host options", async () => {
    const calls = [];
    let forbiddenOptionReads = 0;
    const agentOptions = { onConnectionError: () => {} };
    const chatOptions = { onError: () => {} };
    for (const [target, properties] of [
      [agentOptions, ["host", "path", "query", "onOpen", "onMessage"]],
      [chatOptions, ["agent", "body", "getInitialMessages", "messages", "prepareSendMessagesRequest", "tools"]]
    ]) {
      for (const property of properties) {
        Object.defineProperty(target, property, {
          enumerable: true,
          get() {
            forbiddenOptionReads += 1;
            return property === "path" ? "attacker-controlled-path" : undefined;
          }
        });
      }
    }
    const reactConversationId = "conversation-react-1001";
    const reactMateId = "portfolio-react-mate";
    const hostFetch = async (url, init = {}) => {
      calls.push({
        authorization: new Headers(init.headers).get("authorization"),
        method: init.method ?? "GET",
        url: String(url)
      });
      if (init.method === "POST") {
        return Response.json(grant(
          new Date(Date.now() + 5 * 60_000).toISOString(),
          "react.signed.grant"
        ), { status: 201 });
      }
      return Response.json([{ id: "server-message-1", role: "assistant", parts: [] }]);
    };

    function SuspenseChat() {
      const chat = useWorkspaceMateChat({
        accessToken: "runtime-user-bearer",
        agentOptions,
        chatOptions,
        conversationId: reactConversationId,
        environment: environment(),
        fetch: hostFetch,
        principalKey: "opaque-react-auth-session",
        runtimeOrigin: origin,
        mateId: reactMateId
      });
      return createElement("div", null, chat.messages.map((message) => message.id).join(","));
    }

    const stream = await renderToReadableStream(createElement(
      Suspense,
      { fallback: createElement("span", null, "loading") },
      createElement(SuspenseChat)
    ));
    await stream.allReady;
    const markup = await new Response(stream).text();

    assert.match(markup, /server-message-1/);
    assert.equal(forbiddenOptionReads, 0);
    assert.deepEqual(calls, [
      {
        authorization: "Bearer runtime-user-bearer",
        method: "POST",
        url: `${origin}/v1/mates/${reactMateId}/conversations/${reactConversationId}/chat-grants`
      },
      {
        authorization: null,
        method: "GET",
        url: `${origin}/v1/mates/${reactMateId}/conversations/${reactConversationId}/chat/get-messages?grant=react.signed.grant`
      }
    ]);
  });

  it("reads the latest complete raw Environment snapshot for every turn", async () => {
    let current = environment(1, "pf_123");
    let currentGrant = "turn-grant-1";
    const grantManager = {
      get: async () => grant("2026-08-27T10:02:00.000Z", currentGrant)
    };
    const first = await createWorkspaceMateChatTurnBody({
      environment: () => current,
      grantManager,
      mountInstanceId: "tm3-mount-test-1"
    });
    current = environment(2, "pf_456");
    currentGrant = "turn-grant-2";
    const second = await createWorkspaceMateChatTurnBody({
      environment: () => current,
      grantManager,
      mountInstanceId: "tm3-mount-test-1"
    });

    assert.deepEqual(first, {
      chatGrant: "turn-grant-1",
      environment: {
        ...environment(1, "pf_123"),
        host: { ...environment().host, instanceId: "tm3-mount-test-1" }
      }
    });
    assert.deepEqual(second, {
      chatGrant: "turn-grant-2",
      environment: {
        ...environment(2, "pf_456"),
        host: { ...environment().host, instanceId: "tm3-mount-test-1" }
      }
    });
    assert.equal(Object.hasOwn(second.environment, "digest"), false);
    assert.equal(Object.hasOwn(second.environment, "trust"), false);
    current.location.ref = "mutated-after-send";
    assert.equal(second.environment.location.ref, "pf_456");
  });

  it("keeps Resource/model selection separate from Environment and snapshots it per turn", async () => {
    let selection = {
      appIds: ["portfolio-app"],
      knowledgeServiceIds: ["portfolio-policies"],
      modelId: "model-a"
    };
    const body = await createWorkspaceMateChatTurnBody({
      environment: environment(),
      grantManager: { get: async () => grant("2026-08-27T10:02:00.000Z") },
      mountInstanceId: "tm3-mount-selection",
      selection: () => selection
    });
    selection.knowledgeServiceIds[0] = "mutated-after-send";

    assert.deepEqual(body.selection, {
      appIds: ["portfolio-app"],
      knowledgeServiceIds: ["portfolio-policies"],
      modelId: "model-a"
    });
    assert.equal(Object.hasOwn(body.environment, "selection"), false);
    await assert.rejects(
      () => createWorkspaceMateChatTurnBody({
        environment: environment(),
        grantManager: { get: async () => grant("2026-08-27T10:02:00.000Z") },
        mountInstanceId: "tm3-mount-selection",
        selection: { knowledgeServiceIds: ["duplicate", "duplicate"] }
      }),
      /mate_capability_selection_invalid/
    );
  });

  it("loads the authoritative transcript and refreshes one stale query grant", async () => {
    const calls = [];
    let invalidations = 0;
    const grantManager = {
      get: async (options) => {
        assert.deepEqual(options, { forceRefresh: true });
        return grant("2026-08-27T10:02:00.000Z", "refreshed-query-grant");
      },
      invalidate: () => {
        invalidations += 1;
      }
    };
    const loader = createWorkspaceMateInitialMessagesLoader({
      fetch: () => async (url, init) => {
        calls.push({ init, url: String(url) });
        if (calls.length === 1) {
          return Response.json({ error: "chat_grant_expired" }, { status: 401 });
        }
        return Response.json([{ id: "server-message-1", role: "assistant", parts: [] }]);
      },
      grantManager
    });

    const messages = await loader({
      agent: "MateChatAgent",
      name: "opaque-address",
      url: `${origin}/v1/mates/${mateId}/conversations/${conversationId}/chat?grant=stale-query-grant&_pk=cf-internal`
    });

    assert.equal(invalidations, 1);
    assert.deepEqual(messages, [{ id: "server-message-1", role: "assistant", parts: [] }]);
    assert.equal(new URL(calls[0].url).searchParams.get("grant"), "stale-query-grant");
    assert.equal(new URL(calls[1].url).searchParams.get("grant"), "refreshed-query-grant");
    assert.equal(calls.every((call) => call.url.endsWith("/get-messages?grant=" + new URL(call.url).searchParams.get("grant"))), true);
    assert.equal(calls.every((call) => !new URL(call.url).searchParams.has("_pk")), true);
    assert.equal(calls.every((call) => call.init.method === "GET"), true);
  });

  it("fails closed with typed errors when transcript hydration cannot be trusted", async () => {
    const grantManager = {
      get: async () => grant("2026-08-27T10:02:00.000Z"),
      invalidate: () => {}
    };
    const forbidden = createWorkspaceMateInitialMessagesLoader({
      fetch: () => async () => Response.json({ error: "mate_scope_insufficient" }, { status: 403 }),
      grantManager
    });
    await assert.rejects(
      () => forbidden({
        agent: "MateChatAgent",
        name: "opaque-address",
        url: `${origin}/chat?grant=query-grant`
      }),
      (error) => error?.name === "WorkspaceMateChatHostError"
        && error?.status === 403
        && error?.code === "mate_scope_insufficient"
    );

    const malformed = createWorkspaceMateInitialMessagesLoader({
      fetch: () => async () => new Response("{}", { status: 200 }),
      grantManager
    });
    await assert.rejects(
      () => malformed({
        agent: "MateChatAgent",
        name: "opaque-address",
        url: `${origin}/chat?grant=query-grant`
      }),
      (error) => error?.status === 502
        && error?.code === "mate_chat_initial_messages_response_invalid"
    );

    const malformedEnvelope = createWorkspaceMateInitialMessagesLoader({
      fetch: () => async () => Response.json([null]),
      grantManager
    });
    await assert.rejects(
      () => malformedEnvelope({
        agent: "MateChatAgent",
        name: "opaque-address",
        url: `${origin}/chat?grant=query-grant`
      }),
      (error) => error?.status === 502
        && error?.code === "mate_chat_initial_messages_response_invalid"
    );
  });

  it("loads paginated histories beyond 80 messages and refreshes a grant between pages", async () => {
    const messages = Array.from({ length: 101 }, (_, index) => ({ id: `msg-${index}`, role: index % 2 ? "assistant" : "user", parts: [] }));
    let refreshed = 0;
    const cursors = [];
    const loader = createWorkspaceMateInitialMessagesLoader({
      grantManager: { invalidate() {}, get: async () => { refreshed++; return { grant: "fresh" }; } },
      fetch: () => async (value) => {
        const url = new URL(value);
        const cursor = url.searchParams.get("cursor");
        cursors.push(cursor);
        if (cursor === "msg-49" && url.searchParams.get("grant") !== "fresh") return new Response("", { status: 401 });
        const start = cursor ? Number(cursor.slice(4)) + 1 : 0;
        const page = messages.slice(start, start + 50);
        return Response.json(page, { headers: start + page.length < messages.length ? { "X-Workspace-Chat-Next-Cursor": page.at(-1).id } : {} });
      }
    });
    assert.deepEqual(await loader({ agent: "MateChatAgent", name: "test", url: `${origin}/chat?grant=old` }), messages);
    assert.deepEqual(cursors, [null, "msg-49", "msg-49", "msg-99"]);
    assert.equal(refreshed, 1);
  });

  it("rejects a history page loop instead of repeatedly fetching it", async () => {
    const loader = createWorkspaceMateInitialMessagesLoader({
      grantManager: { invalidate() {}, get: async () => ({ grant: "fresh" }) },
      fetch: () => async () => Response.json([{ id: "same", role: "assistant", parts: [] }], { headers: { "X-Workspace-Chat-Next-Cursor": "same" } })
    });
    await assert.rejects(loader({ agent: "MateChatAgent", name: "test", url: `${origin}/chat?grant=old` }), /mate_chat_initial_messages_response_invalid/);
  });

  it("uses the owner-only Preview namespace for grants and transport", async () => {
    const previewGrant = { ...grant("2026-08-27T10:02:00.000Z"), mode: "preview" };
    const calls = [];
    const issued = await requestWorkspaceMateChatGrant({
      accessToken: "preview-runtime-user-bearer",
      conversationId,
      fetch: async (url, init) => {
        calls.push({ init, url: String(url) });
        return Response.json(previewGrant, { status: 201 });
      },
      mode: "preview",
      runtimeOrigin: origin,
      mateId
    });
    const connection = createWorkspaceMateAgentConnectionConfig({
      conversationId,
      grantManager: {
        dependencyKey: `workspace-chat-resource-v1-${"3".repeat(32)}`,
        get: async () => previewGrant
      },
      mode: "preview",
      runtimeOrigin: origin,
      mateId
    });

    assert.equal(issued.mode, "preview");
    assert.equal(calls[0].url, `${origin}/v1/owner-test/mates/${mateId}/conversations/${conversationId}/chat-grants`);
    assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer preview-runtime-user-bearer");
    assert.equal(connection.basePath, `v1/owner-test/mates/${mateId}/conversations/${conversationId}/chat`);
    assert.ok(connection.queryDeps.includes("preview"));
  });

  it("creates a unique opaque Environment instance for every mount", () => {
    const ids = [
      createWorkspaceMateMountInstanceId(() => "mount-uuid-1"),
      createWorkspaceMateMountInstanceId(() => "mount-uuid-2")
    ];
    assert.deepEqual(ids, ["tm3-mount-mount-uuid-1", "tm3-mount-mount-uuid-2"]);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("locks the server-authoritative transcript and resumable stream policy", () => {
    assert.deepEqual(WORKSPACE_MATE_CHAT_TRANSPORT_POLICY, {
      cancelOnClientAbort: false,
      resume: true,
      syncMessagesToServer: false
    });
    assert.equal(Object.isFrozen(WORKSPACE_MATE_CHAT_TRANSPORT_POLICY), true);
  });

  it("fails closed on grant errors and malformed Runtime responses", async () => {
    await assert.rejects(
      () => requestWorkspaceMateChatGrant({
        accessToken: "runtime-user-bearer",
        conversationId,
        fetch: async () => Response.json({ error: "mate_scope_insufficient" }, { status: 403 }),
        runtimeOrigin: origin,
        mateId
      }),
      (error) => error?.status === 403 && error?.code === "mate_scope_insufficient"
    );
    await assert.rejects(
      () => requestWorkspaceMateChatGrant({
        accessToken: "runtime-user-bearer",
        conversationId,
        fetch: async () => Response.json({ grant: "token", expiresAt: "never", mode: "preview", releaseId: "release" }, { status: 201 }),
        runtimeOrigin: origin,
        mateId
      }),
      (error) => error?.status === 502 && error?.code === "mate_chat_grant_response_invalid"
    );
    await assert.rejects(
      () => requestWorkspaceMateChatGrant({
        accessToken: "runtime-user-bearer",
        conversationId,
        fetch: async () => Response.json({
          grant: "token",
          expiresAt: "2026-08-27T10:02:00.000Z",
          mode: "live",
          releaseId: "release"
        }, { status: 201 }),
        mode: "preview",
        runtimeOrigin: origin,
        mateId
      }),
      (error) => error?.status === 502 && error?.code === "mate_chat_grant_response_invalid"
    );
  });

  it("keeps legacy API compatibility and React dependencies in additive exports", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.ok(pkg.exports["."]);
    assert.ok(pkg.exports["./react"]);
    assert.equal(pkg.peerDependencies["@frontier-workspace/mate"], "^0.1.0-preview.1");
    assert.equal(pkg.peerDependencies.agents, ">=0.20.1 <1");
    assert.equal(pkg.peerDependencies.react, "^19.0.0");
    const declaration = readFileSync(new URL("../dist/react.d.ts", import.meta.url), "utf8");
    const optionsDeclaration = declaration.slice(
      declaration.indexOf("export type UseWorkspaceMateChatOptions"),
      declaration.indexOf("export type WorkspaceMateSendOptions")
    );
    assert.match(optionsDeclaration, /principalKey: string/);
    assert.equal(optionsDeclaration.includes("agentClass"), false);
    assert.equal(declaration.includes("ProtectedUseAgentOptions"), false);
    assert.equal(declaration.includes("ProtectedUseAgentChatOptions"), false);
    const publicHook = declaration.slice(declaration.indexOf("export declare function useWorkspaceMateChat"));
    for (const forbidden of [
      "agent:",
      "grantManager:",
      "setMessages:",
      "clearHistory:",
      "regenerate:",
      "addToolOutput:",
      "addToolResult:",
      "addToolApprovalResponse:"
    ]) assert.equal(publicHook.includes(forbidden), false, `${forbidden} must stay outside the public hook`);
    assert.match(publicHook, /sendMessage: \(text: string/);
  });
});
