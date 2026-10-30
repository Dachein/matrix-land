import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  workspaceMateEmbedUrl,
  workspaceMateWorkspaceUrl,
  mountWorkspaceMateEmbed
} from "../dist/embed.js";
import {
  WORKSPACE_MATE_EMBED_CLOSE,
  WORKSPACE_MATE_EMBED_CONVERSATION,
  WORKSPACE_MATE_EMBED_OPEN_WORKSPACE,
  WORKSPACE_MATE_EMBED_PROTOCOL_VERSION,
  WORKSPACE_MATE_EMBED_READY,
  normalizeWorkspaceMateEmbedConfigureMessage
} from "../dist/embedProtocol.js";

describe("Workspace Mate Embed SDK", () => {
  it("builds hosted embed and workspace URLs without putting Environment in the URL", () => {
    const embed = new URL(workspaceMateEmbedUrl({
      conversationId: "conversation-1001",
      instanceId: "embed-1001",
      origin: "https://ai.example.invalid",
      mateId: "knowledge-access"
    }));
    assert.equal(embed.pathname, "/mates/knowledge-access/embed");
    assert.equal(embed.searchParams.get("conversation"), "conversation-1001");
    assert.equal(embed.searchParams.get("embedInstance"), "embed-1001");
    assert.equal(embed.searchParams.has("environment"), false);
    assert.equal(
      workspaceMateWorkspaceUrl({
        conversationId: "conversation-1001",
        origin: "https://ai.example.invalid",
        mateId: "knowledge-access"
      }),
      "https://ai.example.invalid/mates/knowledge-access?conversation=conversation-1001"
    );
  });

  it("normalizes the versioned Host configuration and rejects sensitive Environment fields", () => {
    const message = normalizeWorkspaceMateEmbedConfigureMessage({
      type: "workspace.mate.embed.configure/v1",
      version: 1,
      instanceId: "embed-1001",
      mateId: "knowledge-access",
      environment: {
        schemaVersion: "workspace.mate-environment/v1",
        revision: 1,
        host: { appId: "workspace-knowledge", surface: "embedded" },
        location: { kind: "knowledge.service", ref: "ksvc-1001" }
      },
      selection: { appIds: [], knowledgeServiceIds: ["ksvc-1001"] }
    });
    assert.deepEqual(message.selection, { appIds: [], knowledgeServiceIds: ["ksvc-1001"] });
    assert.throws(
      () => normalizeWorkspaceMateEmbedConfigureMessage({
        ...message,
        environment: { ...message.environment, accessToken: "secret" }
      }),
      /mate_environment/
    );
  });

  it("mounts one iframe, handshakes, tracks Conversation, and opens the same Workspace conversation", () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const windowListeners = new Map();
    const posted = [];
    const iframeListeners = new Map();
    const frameWindow = { postMessage: (message, origin) => posted.push({ message, origin }) };
    const iframe = {
      addEventListener: (type, handler) => iframeListeners.set(type, handler),
      removeEventListener: (type) => iframeListeners.delete(type),
      remove: () => { iframe.removed = true; },
      focus: () => { iframe.focused = true; },
      contentWindow: frameWindow,
      dataset: {}
    };
    globalThis.window = {
      location: { origin: "https://ai.example.invalid" },
      addEventListener: (type, handler) => windowListeners.set(type, handler),
      removeEventListener: (type) => windowListeners.delete(type),
      open: () => undefined
    };
    globalThis.document = { createElement: () => iframe };
    const container = { replaceChildren: (child) => { container.child = child; } };
    const workspace = [];
    const cachedConversations = new Map([["workspace.mate.embed.conversation:user-1:knowledge", "conversation-cached"]]);
    const conversationStorage = {
      getItem: (key) => cachedConversations.get(key) ?? null,
      removeItem: (key) => cachedConversations.delete(key),
      setItem: (key, value) => cachedConversations.set(key, value)
    };
    let closeRequests = 0;
    try {
      const handle = mountWorkspaceMateEmbed({
        container,
        conversationCache: { key: "user-1:knowledge", storage: conversationStorage },
        mateId: "knowledge-access",
        environment: {
          schemaVersion: "workspace.mate-environment/v1",
          revision: 1,
          host: { appId: "workspace-knowledge", surface: "embedded" },
          location: { kind: "knowledge.service", ref: "ksvc-1001" }
        },
        selection: { appIds: [], knowledgeServiceIds: ["ksvc-1001"] },
        onClose: () => { closeRequests += 1; },
        onOpenWorkspace: (url, conversationId) => workspace.push({ url, conversationId })
      });
      assert.equal(container.child, iframe);
      assert.match(iframe.src, /\/mates\/knowledge-access\/embed/);
      assert.equal(new URL(iframe.src).searchParams.get("conversation"), "conversation-cached");
      iframeListeners.get("load")();
      assert.equal(posted.length, 1);
      const instanceId = iframe.dataset.embedInstance;
      const send = (data) => windowListeners.get("message")({
        data,
        origin: "https://ai.example.invalid",
        source: frameWindow
      });
      send({
        type: WORKSPACE_MATE_EMBED_READY,
        version: WORKSPACE_MATE_EMBED_PROTOCOL_VERSION,
        instanceId,
        mateId: "knowledge-access"
      });
      assert.equal(posted.length, 2);
      send({
        type: WORKSPACE_MATE_EMBED_CONVERSATION,
        version: WORKSPACE_MATE_EMBED_PROTOCOL_VERSION,
        instanceId,
        mateId: "knowledge-access",
        conversationId: "conversation-1001"
      });
      assert.equal(
        cachedConversations.get("workspace.mate.embed.conversation:user-1:knowledge"),
        "conversation-1001"
      );
      handle.update({ selection: { appIds: [], knowledgeServiceIds: ["ksvc-2002"] } });
      assert.deepEqual(posted.at(-1).message.selection, {
        appIds: [],
        knowledgeServiceIds: ["ksvc-2002"]
      });
      assert.equal(posted.at(-1).message.conversationId, undefined);
      assert.equal(handle.getConversationId(), "conversation-1001");
      send({
        type: WORKSPACE_MATE_EMBED_OPEN_WORKSPACE,
        version: WORKSPACE_MATE_EMBED_PROTOCOL_VERSION,
        instanceId,
        mateId: "knowledge-access",
        conversationId: "conversation-1001"
      });
      send({
        type: WORKSPACE_MATE_EMBED_CLOSE,
        version: WORKSPACE_MATE_EMBED_PROTOCOL_VERSION,
        instanceId,
        mateId: "knowledge-access"
      });
      assert.equal(handle.getConversationId(), "conversation-1001");
      assert.equal(closeRequests, 1);
      assert.deepEqual(workspace, [{
        conversationId: "conversation-1001",
        url: "https://ai.example.invalid/mates/knowledge-access?conversation=conversation-1001"
      }]);
      handle.destroy();
      assert.equal(iframe.removed, true);
      assert.equal(windowListeners.has("message"), false);
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }
  });
});
