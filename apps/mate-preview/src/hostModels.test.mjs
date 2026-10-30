import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { modelDisplayName } from "../../../src/shared/modelDisplayName.ts";

describe("model display names", () => {
  it("uses catalog names and readable names for legacy routing IDs", () => {
    assert.equal(modelDisplayName("cf-openai-gpt-6-luna", "GPT-6 Luna (Cloudflare)"), "GPT-6 Luna");
    assert.equal(modelDisplayName("cf-anthropic-claude-haiku-5.5", "Claude Haiku 5.5 (Cloudflare)"), "Claude Haiku 5.5");
    assert.equal(modelDisplayName("cf-openai-gpt-6-luna", "cf-openai-gpt-6-luna"), "GPT-6 Luna");
    assert.equal(modelDisplayName("tencent-deepseek-v4-flash"), "DeepSeek V4 Flash");
    assert.equal(modelDisplayName("tencent-glm-5.3", "GLM-5.3"), "GLM-5.3");
  });
});

const modules = new Map();

async function loadModule(name) {
  if (modules.has(name)) return modules.get(name);
  const promise = (async () => {
    const outdir = await mkdtemp(join(tmpdir(), `workspace-mate-preview-${name}-`));
    const entryName = /\.[cm]?[jt]sx?$/.test(name) ? name : `${name}.ts`;
    const outfile = join(outdir, `${name.replace(/[^A-Za-z0-9_-]/g, "-")}.mjs`);
    await build({
      bundle: true,
      entryPoints: [new URL(`./${entryName}`, import.meta.url).pathname],
      format: "esm",
      loader: { ".gif": "dataurl" },
      logLevel: "silent",
      outfile,
      platform: "node",
      target: "node20"
    });
    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
    await rm(outdir, { force: true, recursive: true });
    return loaded;
  })();
  modules.set(name, promise);
  return promise;
}

function validSession(overrides = {}) {
  return {
    accessToken: "runtime-access-token-never-persisted",
    conversationId: "conv_preview_123456",
    conversationState: "persisted",
    expiresAt: "2099-01-01T00:00:00.000Z",
    mode: "preview",
    principalKey: "principal_opaque_123456",
    runtimeOrigin: "https://runtime.example.com",
    mate: {
      avatarUrl: "https://assets.example.com/mate.png",
      description: "Release candidate",
      displayName: "Knowledge Mate",
      id: "mate_123456",
      jobRole: "Research"
    },
    user: {
      avatarUrl: "https://assets.example.com/user.png",
      name: "Owner One"
    },
    release: {
      id: "release_123456",
      manifestSha256: `sha256:${"a".repeat(64)}`,
      version: 3
    },
    surface: {
      channels: ["sdk"],
      defaultExecutor: "knowledge_qa",
      entries: [{ channel: "sdk", kind: "conversation" }],
      kind: "conversation"
    },
    ...overrides
  };
}

describe("Mate Preview environment coordinate", () => {
  it("creates a bounded manually supplied semantic coordinate without authority or layout", async () => {
    const { createPreviewEnvironment, defaultPreviewSemanticCoordinate, previewHostPath } = await loadModule("environment");
    const environment = createPreviewEnvironment({
      coordinate: "portfolio:pf_123",
      debug: true,
      releaseId: "release_123456",
      releaseVersion: 3,
      revision: 4,
      mateId: "mate_123456"
    });

    assert.deepEqual(environment, {
      schemaVersion: "workspace.mate-environment/v1",
      revision: 4,
      host: { appId: "workspace-mate-preview", surface: "debug" },
      location: {
        kind: "host.semantic",
        ref: "portfolio:pf_123",
        route: "/mates/mate_123456/preview?release=release_123456&debug=1"
      },
      summary: {
        label: "portfolio:pf_123",
        state: "candidate",
        facets: { releaseVersion: 3, runtimeMode: "preview" }
      }
    });
    assert.equal(defaultPreviewSemanticCoordinate("mate_123456", "release_123456"), "mate:mate_123456/release:release_123456");
    assert.equal(previewHostPath("mate_123456", "release_123456"), "/mates/mate_123456/preview?release=release_123456");
    assert.doesNotMatch(JSON.stringify(environment), /token|grant|email|permission/i);
    assert.equal(Object.hasOwn(environment.host, "layout"), false);
  });

  it("reads canonical direct and hash fallback routes while rejecting malformed coordinates", async () => {
    const { readPreviewHostRoute } = await loadModule("environment");
    const direct = readPreviewHostRoute({
      hash: "",
      pathname: "/mates/mate_123456/preview",
      search: "?release=release_123456&debug=1"
    });

    assert.deepEqual(direct, {
      debug: true,
      releaseId: "release_123456",
      mateId: "mate_123456"
    });
    assert.deepEqual(readPreviewHostRoute({
      hash: "#/mates/mate_123456/preview?release=release_123456",
      pathname: "/",
      search: ""
    }), { ...direct, debug: false });
    assert.equal(readPreviewHostRoute({
      hash: "",
      pathname: "/mates/bad%2Fid/preview",
      search: "?release=release_123456"
    }), undefined);
  });

  it("creates a Live environment without borrowing Preview coordinates", async () => {
    const { createLiveMateEnvironment } = await loadModule("environment");
    assert.deepEqual(createLiveMateEnvironment({
      presentation: "embedded",
      revision: 2,
      mateId: "knowledge-access"
    }), {
      schemaVersion: "workspace.mate-environment/v1",
      revision: 2,
      host: { appId: "workspace-mate-workspace", surface: "embedded" },
      location: {
        kind: "mate.conversation",
        ref: "mate:knowledge-access",
        route: "/mates/knowledge-access/embed"
      },
      summary: {
        label: "knowledge-access",
        state: "live",
        facets: { runtimeMode: "live" }
      }
    });
  });
});

describe("Mate Embed frame bridge", () => {
  it("accepts configuration only from the exact parent and reports the active Conversation", async () => {
    const { connectMateEmbedFrame, mergeMateEmbedConfiguration } = await loadModule("embedBridge");
    const listeners = new Map();
    const posted = [];
    const parent = { postMessage: (message, origin) => posted.push({ message, origin }) };
    const frameWindow = {
      addEventListener: (type, listener) => listeners.set(type, listener),
      parent,
      removeEventListener: (type) => listeners.delete(type)
    };
    const configurations = [];
    const bridge = connectMateEmbedFrame({
      document: { referrer: "https://host.example.com/knowledge" },
      instanceId: "embed-1001",
      onConfigure: (configuration) => configurations.push(configuration),
      mateId: "knowledge-access",
      window: frameWindow
    });
    assert.equal(posted[0].message.type, "workspace.mate.embed.ready/v1");
    assert.equal(posted[0].origin, "https://host.example.com");
    const configure = {
      type: "workspace.mate.embed.configure/v1",
      version: 1,
      instanceId: "embed-1001",
      mateId: "knowledge-access",
      selection: { appIds: [], knowledgeServiceIds: ["ksvc-1001"] }
    };
    listeners.get("message")({ data: configure, origin: "https://attacker.example.com", source: parent });
    assert.equal(configurations.length, 0);
    listeners.get("message")({ data: configure, origin: "https://host.example.com", source: parent });
    assert.deepEqual(configurations[0].selection, { appIds: [], knowledgeServiceIds: ["ksvc-1001"] });
    const merged = mergeMateEmbedConfiguration({
      ...configure,
      conversationId: "conversation-1001",
      environment: {
        schemaVersion: "workspace.mate-environment/v1",
        revision: 1,
        host: { appId: "workspace-knowledge", surface: "embedded" },
        location: { kind: "knowledge.service", ref: "ksvc-1001" }
      }
    }, {
      ...configure,
      selection: { appIds: [], knowledgeServiceIds: ["ksvc-2002"] }
    });
    assert.equal(merged.conversationId, "conversation-1001");
    assert.equal(merged.environment.location.ref, "ksvc-1001");
    assert.deepEqual(merged.selection.knowledgeServiceIds, ["ksvc-2002"]);
    bridge.conversation("conversation-1001");
    bridge.state("ready");
    bridge.requestClose();
    assert.equal(posted.at(-3).message.conversationId, "conversation-1001");
    assert.equal(posted.at(-2).message.state, "ready");
    assert.equal(posted.at(-1).message.type, "workspace.mate.embed.close/v1");
    bridge.close();
    assert.equal(listeners.has("message"), false);
  });
});

describe("Mate hosted capability profile", () => {
  it("keeps every current-user capability visible while applying one Host default selection", async () => {
    const { resolveHostedCapabilityProfile } = await loadModule("capabilityProfile");
    const profile = {
      appMcp: [
        { allowedToolNames: ["crm.read"], authorization: "invoking_user", id: "crm", kind: "app_mcp", name: "CRM" }
      ],
      knowledge: [
        { allowedOperations: ["search"], authorization: "invoking_user", id: "how_to", kind: "knowledge_service", name: "How To" },
        { allowedOperations: ["search"], authorization: "invoking_user", id: "policy", kind: "knowledge_service", name: "Policy" }
      ],
      models: {
        allowed: [{ id: "model-1", name: "Model 1" }],
        allowUserSelection: false,
        defaultModel: "model-1"
      },
      tools: []
    };

    const hosted = resolveHostedCapabilityProfile(profile, {
      appIds: [],
      knowledgeServiceIds: ["policy"]
    });

    assert.equal(hosted.profile, profile);
    assert.deepEqual(hosted.profile.knowledge.map((item) => item.id), ["how_to", "policy"]);
    assert.deepEqual(hosted.selection, { appIds: [], knowledgeServiceIds: ["policy"] });
  });
});

describe("Mate Preview session client", () => {
  it("renews an expired Live session before Weixin binding without changing the user or Mate", async () => {
    const { freshMateWeixinSession, requestMateWeixinBinding } = await loadModule("api");
    const stale = validSession({ mode: "live", conversationId: "conv_live_123456", expiresAt: "2020-01-01T00:00:00.000Z" });
    const fresh = { ...stale, accessToken: "fresh-runtime-token", expiresAt: "2099-01-01T00:00:00.000Z" };
    const requests = [];
    const fetcher = async (input, init) => {
      requests.push({ input: String(input), init });
      return requests.length === 1
        ? Response.json({ session: fresh })
        : Response.json({ state: "pending", sessionId: "c6ca87a8-5798-47ba-b265-60911158b5ac", qrContent: "https://liteapp.weixin.qq.com/q/test" }, { status: 201 });
    };
    const renewed = await freshMateWeixinSession({ fetch: fetcher, session: stale });
    await requestMateWeixinBinding({ fetch: fetcher, method: "POST", session: renewed });
    assert.equal(requests[0].input, "/api/mate-runtime/live-sessions");
    assert.equal(requests[1].init.headers.authorization, "Bearer fresh-runtime-token");
    assert.deepEqual(JSON.parse(requests[0].init.body), { conversationId: stale.conversationId, mateId: stale.mate.id });
    assert.equal(await freshMateWeixinSession({ fetch: async () => { throw new Error("unexpected refresh"); }, session: renewed }), renewed);
  });

  it("renews a draft Live session even when the server rotates its unused Conversation coordinate", async () => {
    const { freshMateWeixinSession } = await loadModule("api");
    const stale = validSession({ mode: "live", conversationState: "draft", expiresAt: "2020-01-01T00:00:00.000Z" });
    const fresh = { ...stale, conversationId: "conv_new_draft_123456", accessToken: "fresh-runtime-token", expiresAt: "2099-01-01T00:00:00.000Z" };
    let requestBody;
    const renewed = await freshMateWeixinSession({
      fetch: async (_input, init) => {
        requestBody = JSON.parse(init.body);
        return Response.json({ session: fresh });
      },
      session: stale
    });
    assert.deepEqual(requestBody, { mateId: stale.mate.id });
    assert.equal(renewed.accessToken, "fresh-runtime-token");
  });

  it("binds Weixin only through the Live Mate runtime bearer and exact Mate coordinate", async () => {
    const { requestMateWeixinBinding } = await loadModule("api");
    const requests = [];
    const session = validSession({ mode: "live", conversationId: "conv_live_123456" });
    const binding = await requestMateWeixinBinding({
      fetch: async (input, init) => {
        requests.push({ input: String(input), init });
        return Response.json({
          expiresAt: "2099-01-01T00:00:00.000Z",
          qrContent: "https://weixin.qq.com/x/mate-qr",
          sessionId: "c6ca87a8-5798-47ba-b265-60911158b5ac",
          state: "pending"
        }, { status: 201 });
      },
      method: "POST",
      session
    });
    assert.equal(binding.state, "pending");
    assert.equal(requests[0].input, "https://runtime.example.com/v1/mates/mate_123456/channels/weixin/authorize");
    assert.equal(requests[0].init.headers.authorization, "Bearer runtime-access-token-never-persisted");
    assert.throws(
      () => requestMateWeixinBinding({ fetch: async () => { throw new Error("must not fetch"); }, session: validSession() }),
      (error) => error.code === "owner_test_weixin_forbidden"
    );
  });

  it("uploads and downloads Live Workspace attachments with the current short-lived session bearer", async () => {
    const { downloadMateWorkspaceFile, uploadMateAttachment } = await loadModule("api");
    const requests = [];
    const session = validSession({ mode: "live", conversationId: "conv_live_123456" });
    const file = new File(["hello"], "brief.txt", { type: "text/plain" });
    const uploaded = await uploadMateAttachment({
      accessToken: "fresh-live-token",
      fetch: async (input, init) => {
        requests.push({ input: String(input), init });
        return Response.json({ file: {
          fileName: "brief.txt",
          mediaType: "text/plain",
          objectId: "object-123",
          sizeBytes: 5
        } }, { status: 201 });
      },
      file,
      session
    });
    assert.equal(uploaded.rawUrl, "/api/workspace-files/object-123/raw");
    assert.equal(uploaded.downloadUrl, "/api/workspace-files/object-123/download");
    assert.equal(requests[0].input, "https://runtime.example.com/v1/mates/mate_123456/workspace-attachments");
    assert.equal(requests[0].init.headers.authorization, "Bearer fresh-live-token");
    assert.ok(requests[0].init.body instanceof FormData);

    const blob = await downloadMateWorkspaceFile({
      accessToken: "fresh-live-token",
      fetch: async (input, init) => {
        requests.push({ input: String(input), init });
        return new Response("downloaded", { headers: { "content-type": "text/plain" } });
      },
      session,
      url: uploaded.rawUrl
    });
    assert.equal(await blob.text(), "downloaded");
    assert.equal(requests[1].input, "https://runtime.example.com/v1/mates/mate_123456/workspace-files/object-123/download");
    const preview = await downloadMateWorkspaceFile({
      accessToken: "fresh-live-token", session, url: uploaded.rawUrl, previewName: "Budget & Report.xlsx",
      fetch: async (input, init) => {
        const url = new URL(input);
        assert.equal(url.searchParams.get("preview"), "markdown");
        assert.equal(url.searchParams.get("fileName"), "Budget & Report.xlsx");
        assert.equal(init.headers.authorization, "Bearer fresh-live-token");
        return new Response("# Converted workbook", { headers: { "content-type": "text/markdown" } });
      }
    });
    assert.equal(await preview.text(), "# Converted workbook");
    await assert.rejects(
      uploadMateAttachment({ accessToken: "preview-token", fetch: async () => { throw new Error("must not fetch"); }, file, session: validSession() }),
      (error) => error.code === "owner_test_workspace_write_forbidden"
    );
  });

  it("normalizes Release multimodal input capabilities for the composer", async () => {
    const { requestMateRuntimeProfile } = await loadModule("api");
    const profile = await requestMateRuntimeProfile({
      fetch: async () => Response.json({
        capabilities: {
          appMcp: [],
          knowledge: [],
          models: {
            allowed: [{ id: "vision-model", name: "Vision Model" }],
            allowUserSelection: false,
            defaultModel: "vision-model",
            multimodal: { audioInput: false, documentInput: false, imageInput: true }
          },
          tools: []
        }
      }),
      session: validSession({ mode: "live" })
    });
    assert.deepEqual(profile.models.multimodal, {
      audioInput: false,
      documentInput: false,
      imageInput: true
    });
  });

  it("boots and refreshes the exact conversation through a credentialed same-origin POST", async () => {
    const { requestMatePreviewSession } = await loadModule("api");
    const requests = [];
    const fetch = async (input, init) => {
      requests.push({ input, init });
      return Response.json({ session: validSession() });
    };

    const result = await requestMatePreviewSession({
      conversationId: "conv_preview_123456",
      fetch,
      releaseId: "release_123456",
      mateId: "mate_123456"
    });

    assert.equal(result.conversationId, "conv_preview_123456");
    assert.equal(result.conversationState, "persisted");
    assert.equal(result.mate.avatarUrl, "https://assets.example.com/mate.png");
    assert.deepEqual(result.user, {
      avatarUrl: "https://assets.example.com/user.png",
      name: "Owner One"
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].input, "/api/mate-runtime/preview-sessions");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.credentials, "include");
    assert.equal(requests[0].init.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      conversationId: "conv_preview_123456",
      releaseId: "release_123456",
      mateId: "mate_123456"
    });
    assert.doesNotMatch(String(requests[0].input), /token|grant|conversation/i);
  });

  it("commits a draft Conversation with its first deterministic title", async () => {
    const { createMateConversation } = await loadModule("api");
    const requests = [];
    const session = validSession({ conversationState: "draft" });
    const result = await createMateConversation({
      fetch: async (input, init) => {
        requests.push({ input: String(input), init });
        return Response.json({ conversation: {
          channel: "sdk",
          id: session.conversationId,
          title: "请比较这两个 Portfolio"
        } }, { status: 201 });
      },
      session,
      title: "请比较这两个 Portfolio"
    });
    assert.deepEqual(result, { id: session.conversationId, title: "请比较这两个 Portfolio" });
    assert.equal(requests[0].input, "https://runtime.example.com/v1/owner-test/mates/mate_123456/conversations");
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      channel: "sdk",
      conversationId: session.conversationId,
      title: "请比较这两个 Portfolio"
    });
  });

  it("lists only SDK Conversations while retaining every current-user Task", async () => {
    const { requestMateRuntimeCollection } = await loadModule("api");
    const session = validSession({ mode: "live", conversationId: "conv_live_123456" });
    const fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/conversations")) return Response.json({ conversations: [
        { channel: "web", id: "conv_legacy_web", title: "Legacy Web" },
        { channel: "sdk", id: "conv_sdk_current", title: "SDK Conversation" }
      ] });
      if (path.endsWith("/reminders")) return Response.json({ reminders: [{
        id: "reminder_private_1",
        nextDueAt: "2026-08-30T10:00:00.000Z",
        status: "active",
        title: "Scheduled private follow-up"
      }] });
      return Response.json({ tasks: [{ channel: "email", id: "task_email_1", instruction: "Review inbox" }] });
    };
    assert.deepEqual(await requestMateRuntimeCollection({ fetch, session }, "conversations"), [{
      id: "conv_sdk_current",
      pinned: false,
      status: undefined,
      title: "SDK Conversation",
      updatedAt: undefined
    }]);
    const tasks = await requestMateRuntimeCollection({ fetch, session }, "tasks");
    assert.deepEqual(tasks.map((task) => task.id), ["scheduled-reminder_private_1", "task_email_1"]);
    assert.equal(tasks[0].status, "scheduled · active");
  });

  it("never exposes storage ids or Agent DO message references as directory titles", async () => {
    const { requestMateRuntimeCollection } = await loadModule("api");
    const session = validSession({ mode: "preview", conversationId: "conv_preview_123456" });
    const fetch = async (input) => Response.json(String(input).endsWith("/conversations") ? {
      conversations: [{ channel: "sdk", id: "conv_preview_123456", title: "" }]
    } : {
      tasks: [{ id: "task_chat_123456", instruction: "agent-do-message:msg_123:sha256:abc" }]
    });
    assert.equal((await requestMateRuntimeCollection({ fetch, session }, "conversations"))[0].title, "未命名对话");
    assert.equal((await requestMateRuntimeCollection({ fetch, session }, "tasks"))[0].title, "未命名任务");
  });

  it("clears only through the owner Preview collection with the short-lived runtime bearer", async () => {
    const { clearMatePreviewData } = await loadModule("api");
    const requests = [];
    const result = await clearMatePreviewData({
      fetch: async (input, init) => {
        requests.push({ input: String(input), init });
        return Response.json({
          cleared: {
            deletedConversations: 10,
            deletedSessions: 4,
            scheduledAgentInstances: 10
          }
        });
      },
      session: validSession()
    });
    assert.deepEqual(result, {
      deletedConversations: 10,
      deletedSessions: 4,
      scheduledAgentInstances: 10
    });
    assert.equal(requests[0].input, "https://runtime.example.com/v1/owner-test/mates/mate_123456/conversations");
    assert.equal(requests[0].init.method, "DELETE");
    assert.equal(requests[0].init.headers.authorization, "Bearer runtime-access-token-never-persisted");
    await assert.rejects(
      clearMatePreviewData({
        fetch: async () => { throw new Error("must not fetch"); },
        session: validSession({ mode: "live" })
      }),
      (error) => error.code === "preview_cleanup_only"
    );
  });

  it("boots a Live Standalone session without accepting a caller-selected Release", async () => {
    const { requestMateLiveSession } = await loadModule("api");
    const requests = [];
    const liveSession = validSession({ mode: "live", conversationId: "conv_live_123456" });
    const result = await requestMateLiveSession({
      fetch: async (input, init) => {
        requests.push({ input, init });
        return Response.json({ session: liveSession });
      },
      mateId: "mate_123456"
    });
    assert.equal(result.mode, "live");
    assert.equal(result.conversationId, "conv_live_123456");
    assert.equal(requests[0].input, "/api/mate-runtime/live-sessions");
    assert.deepEqual(JSON.parse(requests[0].init.body), { mateId: "mate_123456" });
  });

  it("accepts only an explicit Live recovery when a stale Workspace coordinate resolves to the current user's conversation", async () => {
    const { requestMateLiveSession, MatePreviewApiError } = await loadModule("api");
    const requestedConversationId = "conv_live_stale_123456";
    const recoveredConversationId = "conv_live_current_123456";
    const recovered = await requestMateLiveSession({
      conversationId: requestedConversationId,
      fetch: async () => Response.json({
        session: {
          ...validSession({ mode: "live", conversationId: recoveredConversationId }),
          conversationRecovered: true
        }
      }),
      mateId: "mate_123456"
    });
    assert.equal(recovered.conversationId, recoveredConversationId);

    await assert.rejects(
      () => requestMateLiveSession({
        conversationId: requestedConversationId,
        fetch: async () => Response.json({
          session: validSession({ mode: "live", conversationId: recoveredConversationId })
        }),
        mateId: "mate_123456"
      }),
      (error) => error instanceof MatePreviewApiError && error.code === "preview_session_conversation_mismatch"
    );
  });

  it("requests a fresh Live Conversation explicitly without smuggling a caller-selected Release", async () => {
    const { requestMateLiveSession } = await loadModule("api");
    const requests = [];
    await requestMateLiveSession({
      fetch: async (input, init) => {
        requests.push({ input, init });
        return Response.json({ session: validSession({ mode: "live", conversationId: "conv_live_new_123456" }) });
      },
      newConversation: true,
      mateId: "mate_123456"
    });
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      newConversation: true,
      mateId: "mate_123456"
    });
    assert.equal(JSON.parse(requests[0].init.body).releaseId, undefined);
  });

  it("fails closed when the control-plane response drifts from the requested coordinate", async () => {
    const { requestMatePreviewSession, MatePreviewApiError } = await loadModule("api");
    await assert.rejects(
      requestMatePreviewSession({
        conversationId: "conv_preview_123456",
        fetch: async () => Response.json({ session: validSession({ conversationId: "conv_preview_drifted" }) }),
        releaseId: "release_123456",
        mateId: "mate_123456"
      }),
      (error) => error instanceof MatePreviewApiError
        && error.status === 502
        && error.code === "preview_session_conversation_mismatch"
    );

    await assert.rejects(
      requestMatePreviewSession({
        conversationId: "conv_preview_123456",
        fetch: async () => Response.json({ session: {
          ...validSession({ conversationId: "conv_preview_drifted" }),
          conversationRecovered: true
        } }),
        releaseId: "release_123456",
        mateId: "mate_123456"
      }),
      (error) => error instanceof MatePreviewApiError
        && error.status === 502
        && error.code === "preview_session_response_invalid"
    );

    await assert.rejects(
      requestMatePreviewSession({
        fetch: async () => Response.json({ session: validSession({
          release: { ...validSession().release, id: "release_drifted" }
        }) }),
        releaseId: "release_123456",
        mateId: "mate_123456"
      }),
      (error) => error instanceof MatePreviewApiError
        && error.code === "preview_session_coordinate_mismatch"
    );
  });

  it("normalizes the Release-driven Task Inbox surface and rejects inconsistent capabilities", async () => {
    const { requestMatePreviewSession, MatePreviewApiError } = await loadModule("api");
    const session = await requestMatePreviewSession({
      fetch: async () => Response.json({ session: validSession({
        surface: {
          channels: ["sdk", "mate_call", "email"],
          defaultExecutor: "operations",
          entries: [
            { channel: "sdk", kind: "conversation" },
            { channel: "mate_call", kind: "task_inbox" },
            { channel: "email", kind: "task_inbox" }
          ],
          kind: "conversation"
        }
      }) }),
      releaseId: "release_123456",
      mateId: "mate_123456"
    });
    assert.deepEqual(session.surface, {
      channels: ["sdk", "mate_call", "email"],
      defaultExecutor: "operations",
      entries: [
        { channel: "sdk", kind: "conversation" },
        { channel: "mate_call", kind: "task_inbox" },
        { channel: "email", kind: "task_inbox" }
      ],
      kind: "conversation"
    });

    await assert.rejects(
      requestMatePreviewSession({
        fetch: async () => Response.json({ session: validSession({
          surface: { channels: ["sdk"], entries: [{ channel: "sdk", kind: "task_inbox" }], kind: "task_inbox" }
        }) }),
        releaseId: "release_123456",
        mateId: "mate_123456"
      }),
      (error) => error instanceof MatePreviewApiError
        && error.code === "preview_session_response_invalid"
    );
  });

  it("never sends the cookie-backed session exchange to a cross-origin endpoint", async () => {
    const { requestMatePreviewSession, MatePreviewApiError } = await loadModule("api");
    let called = false;

    await assert.rejects(
      requestMatePreviewSession({
        endpoint: "https://untrusted.example/preview-sessions",
        fetch: async () => {
          called = true;
          return Response.json({ session: validSession() });
        },
        releaseId: "release_123456",
        mateId: "mate_123456"
      }),
      (error) => error instanceof MatePreviewApiError
        && error.status === 400
        && error.code === "preview_session_endpoint_invalid"
    );
    assert.equal(called, false);
  });

  it("persists only the non-secret conversation coordinate in session-scoped storage", async () => {
    const { readPreviewConversationCoordinate, storePreviewConversationCoordinate } = await loadModule("api");
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value)
    };

    storePreviewConversationCoordinate(storage, "mate_123456", "release_123456", "conv_preview_123456");

    assert.equal(values.size, 1);
    assert.deepEqual([...values.values()], ["conv_preview_123456"]);
    assert.equal(
      readPreviewConversationCoordinate(storage, "mate_123456", "release_123456"),
      "conv_preview_123456"
    );
    assert.doesNotMatch(JSON.stringify([...values]), /access[_-]?token|bearer|grant/i);
  });
});

describe("Mate composer attachments", () => {
  it("extracts pasted files while leaving clipboard text for normal input", async () => {
    const { filesFromClipboard } = await loadModule("attachments");
    const image = new File(["image"], "chart.png", { type: "image/png" });
    const document = new File(["document"], "brief.pdf", { type: "application/pdf" });
    assert.deepEqual(filesFromClipboard([
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => image },
      { kind: "file", getAsFile: () => null },
      { kind: "file", getAsFile: () => document }
    ]), [image, document]);
  });

  it("enables image picking for a multimodal Live release and clipboard images only in Standalone", async () => {
    const { acceptChatAttachments, resolveAttachmentCapabilities } = await loadModule("ChatSurface.tsx");
    const profile = {
      appMcp: [],
      knowledge: [],
      models: {
        allowed: [{ id: "vision-model", name: "Vision Model" }],
        allowUserSelection: false,
        defaultModel: "vision-model",
        multimodal: { audioInput: false, documentInput: false, imageInput: true }
      },
      tools: []
    };
    assert.deepEqual(resolveAttachmentCapabilities(profile, "live", "standalone"), {
      documents: false,
      images: true,
      paste: true
    });
    assert.deepEqual(resolveAttachmentCapabilities(profile, "live", "embedded"), {
      documents: false,
      images: true,
      paste: false
    });
    assert.deepEqual(resolveAttachmentCapabilities(profile, "preview", "standalone"), {
      documents: false,
      images: false,
      paste: false
    });

    const image = new File(["image"], "chart.png", { type: "image/png" });
    const document = new File(["document"], "brief.pdf", { type: "application/pdf" });
    const previewUrls = new Set();
    const result = acceptChatAttachments(
      [image, document],
      [],
      { documents: false, images: true, paste: true },
      previewUrls
    );
    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].file.name, "chart.png");
    assert.equal(result.rejected, true);
    previewUrls.forEach((url) => URL.revokeObjectURL(url));
  });

  it("accepts Mate attachments through 20 MiB and caps each turn at five files", async () => {
    const { acceptChatAttachments } = await loadModule("ChatSurface.tsx");
    const file = (name, size) => {
      const value = new File(["content"], name, { type: "application/pdf" });
      Object.defineProperty(value, "size", { value: size });
      return value;
    };
    const capabilities = { documents: true, images: false, paste: false };
    const first = acceptChatAttachments(
      [file("nine.pdf", 9 * 1024 * 1024), file("twenty.pdf", 20 * 1024 * 1024), file("oversize.pdf", 20 * 1024 * 1024 + 1)],
      [], capabilities, new Set()
    );
    assert.deepEqual(first.accepted.map((attachment) => attachment.file.name), ["nine.pdf", "twenty.pdf"]);
    assert.equal(first.rejected, true);
    const second = acceptChatAttachments(
      [file("three.pdf", 1), file("four.pdf", 1), file("five.pdf", 1), file("six.pdf", 1)],
      first.accepted, capabilities, new Set()
    );
    assert.equal(second.accepted.length, 3);
    assert.equal(second.rejected, true);
  });
});

describe("Mate chat capability selection", () => {
  it("selects Knowledge and App MCP together and toggles either category independently", async () => {
    const { allChatCapabilities, chatCapabilitySummary, setChatCapabilityCategory, toggleChatCapability } = await loadModule("chatSelection");
    const profile = {
      appMcp: [{ id: "portfolio-app" }, { id: "crm-app" }],
      knowledge: [{ id: "policy-kb" }],
      models: { allowUserSelection: true, allowed: [], defaultModel: "model-1" },
      tools: []
    };
    const all = allChatCapabilities(profile);
    assert.deepEqual(all, {
      appIds: ["portfolio-app", "crm-app"],
      knowledgeServiceIds: ["policy-kb"]
    });
    assert.equal(chatCapabilitySummary(all), "1 知识库 · 2 应用");
    assert.equal(chatCapabilitySummary(all, "en"), "1 knowledge · 2 apps");

    const withoutCrm = toggleChatCapability(all, "app", "crm-app");
    assert.deepEqual(withoutCrm, {
      appIds: ["portfolio-app"],
      knowledgeServiceIds: ["policy-kb"]
    });
    assert.deepEqual(toggleChatCapability(withoutCrm, "knowledge", "policy-kb"), {
      appIds: ["portfolio-app"],
      knowledgeServiceIds: []
    });

    const knowledgeOnly = setChatCapabilityCategory(all, "app", []);
    assert.deepEqual(knowledgeOnly, {
      appIds: [],
      knowledgeServiceIds: ["policy-kb"]
    });
    assert.equal(chatCapabilitySummary(knowledgeOnly), "1 知识库");
    assert.deepEqual(setChatCapabilityCategory(knowledgeOnly, "app", profile.appMcp.map((resource) => resource.id)), all);
    assert.deepEqual(setChatCapabilityCategory(knowledgeOnly, "app", ["crm-app", "crm-app", "portfolio-app"]), {
      appIds: ["crm-app", "portfolio-app"],
      knowledgeServiceIds: ["policy-kb"]
    });
    assert.equal(chatCapabilitySummary(setChatCapabilityCategory(knowledgeOnly, "knowledge", [])), "未选择");
    assert.equal(chatCapabilitySummary(setChatCapabilityCategory(knowledgeOnly, "knowledge", []), "en"), "None selected");
  });
});

describe("Mate Preview message rendering model", () => {
  it('shows authorization links only for completed native MCP management tools and rejects unsafe URLs', async () => {
    const { previewMessagePartViews } = await loadModule('messageParts');
    const message = url => ({ id: 'oauth', role: 'assistant', parts: [{ type: 'tool-mate_mcp_manage', state: 'output-available',
      output: { connection: { name: 'Plaud' }, authorizationUrl: url, accessToken: 'must-not-render' } }] });
    const result = previewMessagePartViews(message('https://mcp.plaud.ai/authorize?state=once'));
    assert.equal(result[1].kind, 'authorization'); assert.equal(result[1].label, 'Plaud');
    assert.ok(!JSON.stringify(result).includes('must-not-render'));
    for (const url of ['javascript:alert(1)', 'http://provider.test/auth', 'https://secret:password@provider.test/auth']) {
      assert.equal(previewMessagePartViews(message(url)).length, 1);
    }
    const foreign = message('https://provider.test/auth'); foreign.parts[0].type = 'tool-unknown';
    assert.equal(previewMessagePartViews(foreign).length, 1);
  });
  it("renders safe text, citation, tool, and data summaries without dumping arbitrary secrets", async () => {
    const { previewMessagePartViews, previewMessageText } = await loadModule("messageParts");
    const message = {
      id: "message_123",
      role: "assistant",
      parts: [
        { type: "text", text: "Answer" },
        { type: "source-url", title: "Source", url: "https://example.com/source" },
        { type: "tool-search", state: "output-available" },
        { type: "data-progress", data: { status: "recovering" } },
        { type: "data-secret", data: { accessToken: "must-not-render" } }
      ]
    };
    const views = previewMessagePartViews(message);

    assert.equal(previewMessageText(message), "Answer");
    assert.deepEqual(views.map((part) => part.kind), ["text", "citation", "tool", "data", "data"]);
    assert.deepEqual(views[2], {
      details: [],
      kind: "tool",
      label: "search",
      status: "completed",
      text: "已完成"
    });
    assert.equal(views.at(-1).text, "Structured data");
    assert.doesNotMatch(JSON.stringify(views), /must-not-render/);
  });

  it("renders real Mate citations but hides current and legacy Conversation Turn markers", async () => {
    const { previewMessagePartViews } = await loadModule("messageParts");
    const views = previewMessagePartViews({
      id: "assistant_123",
      role: "assistant",
      parts: [
        { type: "text", text: "Answer" },
        {
          type: "data-mate-citations",
          data: { sources: [
            { serviceName: "Policies", relativePath: "kyc.md" },
            { serviceName: "Policies", objectId: "kobj_policy-1", relativePath: "reports/policy.pdf" }
          ] }
        },
        {
          type: "data-mate-turn",
          data: { outcome: "completed", turnId: "turn_chat_12345678" }
        },
        {
          type: "data-mate-task",
          data: {
            outcome: "completed",
            schemaVersion: "workspace.mate-chat-terminal/v1",
            taskId: "task_chat_legacy"
          }
        }
      ]
    });

    assert.deepEqual(views, [
      { kind: "text", text: "Answer" },
      { kind: "artifact", label: "policy.pdf", text: "/api/workspace-files/kobj_policy-1/download" },
      { kind: "citation", label: "Policies", text: "kyc.md" }
    ]);
  });

  it("extracts deduplicated Knowledge, public web, Forum sources and Workspace files from tool output", async () => {
    const { previewMessageResources } = await loadModule("messageParts");
    const resources = previewMessageResources([{
      id: "assistant_tools_1",
      role: "assistant",
      parts: [
        {
          output: {
            file: {
              relativePath: "policy/kyc.md",
              serviceId: "knowledge-policy",
              serviceName: "Policy"
            }
          },
          state: "output-available",
          type: "tool-knowledge_file_read"
        },
        {
          output: {
            file: {
              downloadUrl: "/api/workspace-files/file_123/download",
              fileName: "summary.md"
            }
          },
          state: "output-available",
          type: "tool-workspace_file_create"
        },
        {
          output: {
            file: {
              relativePath: "policy/kyc.md",
              serviceId: "knowledge-policy",
              serviceName: "Policy"
            }
          },
          state: "output-available",
          type: "tool-knowledge_file_read"
        },
        {
          output: {
            results: [{ title: "Cloudflare Agents", url: "https://developers.cloudflare.com/agents/" }]
          },
          state: "output-available",
          type: "tool-public_web_search"
        },
        {
          output: { id: "topic-1", title: "Runtime design" },
          state: "output-available",
          type: "tool-workspace_forum_topic_read"
        }
      ]
    }]);
    assert.deepEqual(resources, [
      { kind: "citation", label: "Policy", text: "policy/kyc.md" },
      { kind: "artifact", label: "summary.md", text: "/api/workspace-files/file_123/download" },
      { kind: "citation", label: "Cloudflare Agents", text: "https://developers.cloudflare.com/agents/" },
      { kind: "citation", label: "Runtime design", text: "Workspace Forum · topic-1" }
    ]);
  });

  it("shows Exa search sources as citations and omits unsafe URLs", async () => {
    const { previewMessageResources } = await loadModule("messageParts");
    const resources = previewMessageResources([{
      id: "exa-sources", role: "assistant", parts: [{
        type: "tool-exa_web_search", state: "output-available",
        output: { searchProvider: "exa", results: [
          { title: "MAS official FAQ", url: "https://www.mas.gov.sg/regulation/faqs/" },
          { title: "Unsafe", url: "javascript:alert(1)" }
        ] }
      }]
    }]);
    assert.deepEqual(resources, [{ kind: "citation", label: "MAS official FAQ", text: "https://www.mas.gov.sg/regulation/faqs/" }]);
  });

  it("keeps compact Exa links in tool details and sources after transcript truncation", async () => {
    const { previewMessagePartViews, previewMessageResources } = await loadModule("messageParts");
    const message = { id: "exa-compact", role: "assistant", parts: [{ type: "tool-exa_web_search", state: "output-available", output: {
      truncated: true, searchProvider: "exa", count: 2, results: [
        { title: "MAS official FAQ", url: "https://www.mas.gov.sg/regulation/faqs/" },
        { title: "Unsafe", url: "https://user:secret@example.test/" }
      ]
    } }] };
    const details = previewMessagePartViews(message)[0].details;
    assert.match(details[0].text, /1 source links retained/);
    assert.deepEqual(previewMessageResources([message]), [{ kind: "citation", label: "MAS official FAQ", text: "https://www.mas.gov.sg/regulation/faqs/" }]);
    assert.equal(details.filter((detail) => detail.kind === "citation").length, 1);
  });

  it("exposes a Knowledge file object as the same authenticated file link used by Workspace", async () => {
    const { previewMessageResources } = await loadModule("messageParts");
    const resources = previewMessageResources([{
      id: "assistant_knowledge_file", role: "assistant", parts: [{
        type: "tool-knowledge_file_read", state: "output-available",
        output: { file: { objectId: "kobj_policy-1", fileName: "policy.pdf", serviceId: "policies" } }
      }]
    }]);
    assert.deepEqual(resources, [{ kind: "artifact", label: "policy.pdf", text: "/api/workspace-files/kobj_policy-1/download" }]);
  });

  it("keeps each tool's safe result details nested under its own progress step", async () => {
    const { previewMessagePartViews } = await loadModule("messageParts");
    const views = previewMessagePartViews({
      id: "assistant_forum_search",
      role: "assistant",
      parts: [{
        output: [
          { id: "topic-1", title: "Runtime design" },
          { id: "topic-2", title: "Agent architecture" }
        ],
        state: "output-available",
        toolName: "workspace_forum_search",
        type: "dynamic-tool"
      }, {
        state: "input-streaming",
        type: "tool-workspace_forum_topic_read"
      }]
    });

    assert.equal(views.length, 2);
    assert.deepEqual(views[0], {
      details: [
        { kind: "citation", label: "Runtime design", text: "Workspace Forum · topic-1" },
        { kind: "citation", label: "Agent architecture", text: "Workspace Forum · topic-2" }
      ],
      kind: "tool",
      label: "workspace_forum_search",
      status: "completed",
      text: "已完成"
    });
    assert.deepEqual(views[1], {
      details: [],
      kind: "tool",
      label: "workspace_forum_topic_read",
      status: "running",
      text: "正在准备参数"
    });
  });

  it("renders citations from the current Forum MCP read response", async () => {
    const { previewMessagePartViews } = await loadModule("messageParts");
    const views = previewMessagePartViews({
      id: "assistant_forum_mcp",
      role: "assistant",
      parts: [{
        output: { topics: [{ id: "topic-1", title: "Runtime design" }] },
        state: "output-available",
        toolName: "forum_read",
        type: "dynamic-tool"
      }, {
        output: { topic: { id: "topic-1", title: "Runtime design" } },
        state: "output-available",
        toolName: "forum_read",
        type: "dynamic-tool"
      }]
    });
    assert.deepEqual(views.map((view) => view.details), [
      [{ kind: "citation", label: "Runtime design", text: "Workspace Forum · topic-1" }],
      [{ kind: "citation", label: "Runtime design", text: "Workspace Forum · topic-1" }]
    ]);
  });

  it("aggregates interleaved reasoning summaries and tools into one timed turn process", async () => {
    const { previewMessagePartViews, previewMessageTurnProcess } = await loadModule("messageParts");
    const message = {
      id: "assistant_process_1",
      role: "assistant",
      parts: [
        { text: "先定位相关资料。", type: "text" },
        { text: "确认授权范围。", type: "reasoning" },
        { text: "选择最相关的检索词。", type: "reasoning" },
        {
          output: [{ id: "topic-1", title: "Runtime design" }],
          state: "output-available",
          toolName: "workspace_forum_search",
          type: "dynamic-tool"
        },
        { text: "读取最相关主题。", type: "reasoning" },
        {
          output: { id: "topic-1", title: "Runtime design" },
          state: "output-available",
          type: "tool-workspace_forum_topic_read"
        },
        { text: "这是最终 Markdown 回答。", type: "text" },
        {
          data: {
            completedAt: "2026-08-29T00:00:05.400Z",
            durationMs: 5_400,
            schemaVersion: "workspace.mate-process/v1",
            startedAt: "2026-08-29T00:00:00.000Z",
            status: "completed"
          },
          id: "turn-1:process",
          type: "data-mate-process"
        }
      ]
    };

    assert.deepEqual(previewMessagePartViews(message).map((part) => part.kind), [
      "text", "reasoning", "reasoning", "tool", "reasoning", "tool", "text"
    ]);
    const process = previewMessageTurnProcess(message);
    assert.equal(process.startPartIndex, 0);
    assert.equal(process.endPartIndex, 5);
    assert.deepEqual(process.steps.map((step) => step.kind), ["progress", "reasoning", "tool", "reasoning", "tool"]);
    assert.equal(process.steps[1].text, "确认授权范围。\n\n选择最相关的检索词。");
    assert.equal(process.steps[2].details[0].text, "Workspace Forum · topic-1");
    assert.deepEqual(process.timing, {
      completedAt: "2026-08-29T00:00:05.400Z",
      durationMs: 5_400,
      startedAt: "2026-08-29T00:00:00.000Z",
      status: "completed"
    });
    assert.equal(previewMessagePartViews(message).at(-1).text, "这是最终 Markdown 回答。");
  });

  it("keeps a direct answer outside an empty timed process", async () => {
    const { previewMessageTurnProcess } = await loadModule("messageParts");
    const process = previewMessageTurnProcess({
      id: "assistant_direct_1",
      role: "assistant",
      parts: [
        { text: "直接回答仍然正常显示。", type: "text" },
        {
          data: {
            durationMs: 900,
            schemaVersion: "workspace.mate-process/v1",
            startedAt: "2026-08-29T00:00:00.000Z",
            status: "completed"
          },
          type: "data-mate-process"
        }
      ]
    });
    assert.equal(process.endPartIndex, -1);
    assert.deepEqual(process.steps, []);
    assert.equal(process.timing.durationMs, 900);
  });

  it("keeps recoverable tool failures visible without marking a completed turn incomplete", async () => {
    const { previewTurnProcessStatus } = await loadModule("messageParts");
    const completedProcess = {
      endPartIndex: 2,
      startPartIndex: 0,
      steps: [
        { kind: "tool", label: "knowledge_library_list", status: "failed", text: "执行失败" },
        { kind: "reasoning", label: "过程摘要", text: "改用其他资料继续处理。" },
        { kind: "tool", label: "knowledge_base_search", status: "completed", text: "已完成" }
      ],
      timing: {
        completedAt: "2026-09-01T00:00:26.000Z",
        durationMs: 26_000,
        startedAt: "2026-09-01T00:00:00.000Z",
        status: "completed"
      }
    };

    assert.equal(previewTurnProcessStatus(false, completedProcess), "completed");
    assert.equal(previewTurnProcessStatus(true, completedProcess), "completed");
    assert.equal(previewTurnProcessStatus(false, {
      ...completedProcess,
      timing: { ...completedProcess.timing, status: "failed" }
    }), "failed");
    assert.equal(previewTurnProcessStatus(false, {
      ...completedProcess,
      timing: undefined,
      steps: completedProcess.steps.slice(0, 1)
    }), "failed");
  });
});

describe("Mate Preview turn outcome", () => {
  it("omits only empty transport observers after a failed turn without changing the transcript", async () => {
    const { previewTranscriptMessages } = await loadModule("messageParts");
    const messages = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "Read only" }] },
      { id: "failed", role: "assistant", parts: [{ type: "data-mate-process", data: {
        schemaVersion: "workspace.mate-process/v1", startedAt: "2026-10-19T05:06:51.061Z", status: "failed"
      } }] },
      { id: "observer", role: "assistant", parts: [] },
      { id: "details", role: "assistant", parts: [{ type: "text", text: "Failure detail" }] },
      { id: "user-2", role: "user", parts: [{ type: "text", text: "Next turn" }] },
      { id: "new-assistant", role: "assistant", parts: [] }
    ];
    const original = JSON.stringify(messages);
    assert.deepEqual(previewTranscriptMessages(messages).map(message => message.id), ["user-1", "failed", "details", "user-2", "new-assistant"]);
    assert.equal(JSON.stringify(messages), original);
  });

  it("uses SDK terminal events and never lets finish/error overwrite an explicit cancel", async () => {
    const { nextPreviewTurnOutcome } = await loadModule("outcome");

    assert.equal(nextPreviewTurnOutcome("idle", "send"), "running");
    assert.equal(nextPreviewTurnOutcome("running", "finish"), "completed");
    assert.equal(nextPreviewTurnOutcome("running", "error"), "failed");
    assert.equal(nextPreviewTurnOutcome("running", "cancel"), "cancelled");
    assert.equal(nextPreviewTurnOutcome("cancelled", "finish"), "cancelled");
    assert.equal(nextPreviewTurnOutcome("cancelled", "error"), "cancelled");
    assert.equal(nextPreviewTurnOutcome("cancelled", "send"), "running");
    assert.equal(nextPreviewTurnOutcome("failed", "resume"), "resuming");
    assert.equal(nextPreviewTurnOutcome("failed", "finish"), "failed");
    assert.equal(nextPreviewTurnOutcome("failed", "send"), "running");
  });
});

describe("Mate Preview relative time", () => {
  it("uses compact X-style buckets before falling back to a calendar date", async () => {
    const { formatCompactRelativeTime, formatExactTimestamp } = await loadModule("relativeTime");
    const now = Date.parse("2026-08-30T12:00:00.000Z");

    assert.equal(formatCompactRelativeTime("2026-08-30T11:59:30.000Z", now), "刚刚");
    assert.equal(formatCompactRelativeTime("2026-08-30T11:55:00.000Z", now), "5分钟");
    assert.equal(formatCompactRelativeTime("2026-08-30T09:00:00.000Z", now), "3小时");
    assert.equal(formatCompactRelativeTime("2026-08-27T12:00:00.000Z", now), "3天");
    assert.equal(formatCompactRelativeTime("2026-08-30T11:55:00.000Z", now, "en"), "5m");
    assert.equal(formatCompactRelativeTime("2026-08-27T12:00:00.000Z", now, "en"), "3d");
    assert.match(formatCompactRelativeTime("2026-08-20T12:00:00.000Z", now), /8月20日/);
    assert.match(formatCompactRelativeTime("2025-08-20T12:00:00.000Z", now), /2025/);
    assert.equal(formatCompactRelativeTime("not-a-date", now), "");
    assert.match(formatExactTimestamp("2026-08-30T11:55:00.000Z"), /2026/);
  });
});

describe("Runtime approval process state", () => {
  it("distinguishes a completed proposal from a completed write and uses the matching approval result", async () => {
    const { previewMessagePartViews, previewMessageTurnProcess, previewTurnProcessStatus } = await loadModule("messageParts");
    const message = {
      id: "hitl-turn", role: "assistant", parts: [
        { type: "dynamic-tool", toolName: "forum_write", state: "output-available", output: {
          approval: { id: "approval-1", status: "pending", expiresAt: "2099-01-01T00:00:00.000Z" },
          task: { id: "task-1", status: "waiting_for_approval" }
        } },
        { type: "text", text: "Original pending / waiting_for_approval proposal" },
        { type: "data-mate-process", data: { schemaVersion: "workspace.mate-process/v1", startedAt: "2026-10-08T00:00:00.000Z", status: "completed" } }
      ]
    };
    const cases = [
      [[], "waiting", "提案已生成，等待审核"],
      [[{ id: "approval-other", status: "consumed", task: { status: "completed" } }], "waiting", "提案已生成，等待审核"],
      [[{ id: "approval-1", status: "denied" }], "cancelled", "未获批准，已取消"],
      [[{ id: "approval-1", status: "consumed", task: { status: "completed" } }], "completed", "审核通过，执行成功"],
      [[{ id: "approval-1", status: "consumed", task: { status: "failed" } }], "failed", "审核通过，执行失败"],
      [[{ id: "approval-1", status: "approved" }], "waiting", "审核通过，等待执行结果"],
      [[{ id: "approval-1", status: "consumed" }], "waiting", "审核通过，等待执行结果"],
      [[{ id: "approval-1", status: "expired" }], "cancelled", "审批已过期，未执行"]
    ];
    const original = JSON.stringify(message);
    for (const [states, status, label] of cases) {
      const process = previewMessageTurnProcess(message, states);
      assert.equal(previewTurnProcessStatus(false, process), status);
      assert.equal(process.steps[0].text, label);
      assert.equal(previewMessagePartViews(message, states).at(-1).text, "Original pending / waiting_for_approval proposal");
      assert.equal(JSON.stringify(message), original, "historical assistant/tool output must remain intact");
    }
  });
});

describe("chat credential recovery", () => {
  it("shares one expiry refresh across concurrent reads and uses the refreshed token afterwards", async () => {
    const { createChatCredentialManager } = await loadModule("sessionRecovery");
    const initial = validSession({ expiresAt: "2000-01-01T00:00:00.000Z", accessToken: "old-token" });
    let release;
    let calls = 0;
    const refreshed = { ...initial, expiresAt: "2099-01-01T00:00:00.000Z", accessToken: "fresh-token" };
    const manager = createChatCredentialManager(initial, () => { calls += 1; return new Promise((resolve) => { release = resolve; }); });
    const requests = [manager.accessToken(), manager.accessToken(), manager.accessToken()];
    assert.equal(calls, 1);
    release(refreshed);
    assert.deepEqual(await Promise.all(requests), ["fresh-token", "fresh-token", "fresh-token"]);
    assert.equal(await manager.accessToken(), "fresh-token");
    assert.equal(manager.session(), refreshed);
    assert.equal(calls, 1);
  });

  it("rejects refreshes that switch conversation, identity, mode, mate, or release, and allows retry after failure", async () => {
    const { createChatCredentialManager } = await loadModule("sessionRecovery");
    const initial = validSession({ expiresAt: "2000-01-01T00:00:00.000Z" });
    const changes = [ { conversationId: "other" }, { principalKey: "other" }, { runtimeOrigin: "https://other.test" }, { mode: "live" }, { mate: { ...initial.mate, id: "other" } }, { release: { ...initial.release, id: "other" } } ];
    for (const change of changes) {
      let attempt = 0;
      const manager = createChatCredentialManager(initial, async () => { attempt += 1; return attempt === 1 ? { ...initial, ...change } : { ...initial, expiresAt: "2099-01-01T00:00:00.000Z", accessToken: "retry-token" }; });
      await assert.rejects(manager.accessToken(), /preview_session_refresh_mismatch/);
      assert.equal(manager.session(), initial);
      assert.equal(await manager.accessToken(), "retry-token");
    }
  });

  it("uses a 30-minute absence threshold while detecting suspension and the actual Runtime auth codes", async () => {
    const { CHAT_ABSENCE_THRESHOLD_MS, isRuntimeAuthenticationError, longChatAbsence } = await loadModule("sessionRecovery");
    assert.equal(CHAT_ABSENCE_THRESHOLD_MS, 30 * 60_000);
    assert.equal(longChatAbsence({ now: 1_800_000, awayAt: 0, lastHeartbeat: 1_799_000 }), true);
    assert.equal(longChatAbsence({ now: 1_799_999, awayAt: 0, lastHeartbeat: 1_799_000 }), false);
    assert.equal(longChatAbsence({ now: 1_800_000, lastHeartbeat: 0 }), true);
    assert.equal(longChatAbsence({ now: 1_800_000, lastHeartbeat: 1_799_000 }), false);
    for (const code of ["runtime_token_required", "runtime_token_invalid", "runtime_token_expired", "mate_chat_grant_invalid", "mate_chat_grant_expired", "mate_chat_grant_binding_changed"]) assert.equal(isRuntimeAuthenticationError(code), true);
    assert.equal(isRuntimeAuthenticationError("provider_timeout"), false);
  });
});

describe("bounded chat recovery", () => {
  it("times out hanging requests, aborts reads, and remains retryable", async () => {
    const { withChatRecoveryTimeout } = await loadModule("sessionRecovery");
    let signal;
    await assert.rejects(withChatRecoveryTimeout((next) => { signal = next; return new Promise(() => {}); }, undefined, 5), /runtime_session_recovery_timeout/);
    assert.equal(signal.aborted, true);
    assert.equal(await withChatRecoveryTimeout(async () => "recovered", undefined, 5), "recovered");
    const parent = new AbortController();
    const pending = withChatRecoveryTimeout(() => new Promise(() => {}), parent.signal);
    parent.abort();
    await assert.rejects(pending, /runtime_session_recovery_cancelled/);
  });
});


describe("conversation directory pages", () => {
  it("requests independent status cursors and preserves page metadata", async () => {
    const { requestMateConversationPage } = await loadModule("api");
    const calls = [];
    const fetch = async (url) => {
      calls.push(new URL(url));
      return Response.json({ conversations: [{ id: "archived-1", channel: "sdk", title: "Archived conversation", status: "archived" }], nextCursor: "next-page" });
    };
    const page = await requestMateConversationPage({ fetch, session: validSession(), status: "archived", cursor: '{"id":"previous","updatedAt":"2026-10-08"}' });
    assert.equal(calls[0].searchParams.get("status"), "archived");
    assert.equal(calls[0].searchParams.get("cursor"), '{"id":"previous","updatedAt":"2026-10-08"}');
    assert.equal(page.items[0].id, "archived-1");
    assert.equal(page.nextCursor, "next-page");
  });
});
