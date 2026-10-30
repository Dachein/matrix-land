import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MessageType } from "@cloudflare/ai-chat/types";
import { acceptWorkspaceMateEnvironment } from "../../../sdk/mate/environment.ts";
import {
  assertMateChatFrameworkAppend,
  assertMateChatGrantMatchesConnection,
  parseMateChatProtocolMessage,
  sanitizedMateChatRequestFrame,
  mateChatBindingFromRecovery,
  mateChatClaimsFromConnectionState,
  mateChatClaimsFromRecovery,
  mateChatConnectionState,
  mateChatRecoveryContext,
  mateChatTurnBinding,
  mateChatUserMessageDigestInput
} from "./chatAgentProtocol.ts";
import { effectiveConversationSelection } from "./roleConversation.ts";

function claims(overrides = {}) {
  return {
    aud: "workspace-mate-chat",
    callerKind: "user",
    conversationId: "conversation-1",
    exp: 200,
    iat: 100,
    instanceName: "mate-chat-instance",
    jti: "grant-1",
    mode: "live",
    orgId: "org-1",
    releaseId: "release-1",
    scopes: ["mate:invoke"],
    mateId: "knowledge-mate",
    userId: "user-a",
    version: 1,
    ...overrides
  };
}

function request(messages, body = {}) {
  return JSON.stringify({
    id: "request-1",
    init: {
      method: "POST",
      body: JSON.stringify({
        chatGrant: "signed.turn.grant",
        environment: { schemaVersion: "workspace.mate-environment/v1" },
        messages,
        trigger: "submit-message",
        ...body
      })
    },
    type: MessageType.CF_AGENT_USE_CHAT_REQUEST
  });
}

const firstUser = { id: "message-1", role: "user", parts: [{ type: "text", text: "First" }] };
const assistant = { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "Answer" }] };

async function acceptedEnvironment() {
  return acceptWorkspaceMateEnvironment({
    schemaVersion: "workspace.mate-environment/v1",
    revision: 1,
    host: { appId: "portfolio", surface: "embedded", instanceId: "mount-1" },
    location: { kind: "portfolio", ref: "portfolio-1" }
  });
}

describe("Mate Chat Agent protocol boundary", () => {
  it("persists turn bindings only after AIChatAgent admits a submit or enters trusted recovery", () => {
    const source = readFileSync(new URL("./chatAgent.ts", import.meta.url), "utf8");
    const admission = source.slice(
      source.indexOf("private async admitProtocolTurn"),
      source.indexOf("override async onStart")
    );
    const admittedTurn = source.slice(
      source.indexOf("override async onChatMessage"),
      source.indexOf("protected override async onChatRecovery")
    );
    const recovery = source.slice(
      source.indexOf("protected override async onChatRecovery"),
      source.indexOf("private async handleChatRecoveryExhausted")
    );

    assert.doesNotMatch(admission, /storeTurnBinding/);
    assert.match(admission, /acceptEnvironment\(request\.environment, \{ persist: false \}\)/);
    assert.match(admittedTurn, /this\.storeTurnBinding\(requestId, recovery\)/);
    assert.match(admittedTurn, /acceptBoundEnvironment\(turn\.environment\)/);
    assert.match(admittedTurn, /projection\.status === "completed"[\s\S]+return undefined/);
    assert.match(admittedTurn, /mode: claims\.mode/);
    assert.match(admittedTurn, /createChatTurnProjection\([\s\S]+turnId: turn\.turnId/);
    assert.match(admittedTurn, /startChatTurnProjection\(this\.env\.RUNTIME_DB, activeTurn\)/);
    assert.equal(
      [...admittedTurn.matchAll(/activeTurn && runtimeError\.code !== "mate_chat_request_aborted"/g)].length,
      2
    );
    assert.doesNotMatch(admittedTurn, /createChatTaskProjection|startTask\(/);
    assert.match(recovery, /acceptBoundEnvironment\(recovery\.turn\.environment\)/);
    assert.match(recovery, /this\.storeTurnBinding\(context\.recoveryRootRequestId, recovery\)/);
    assert.match(source, /ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'live'/);
    assert.match(source, /runtime_mode AS mode/);
    assert.match(source, /row\.mode,[\s\S]+row\.taskId/);
  });

  it("accepts exactly one pure-text user append and rebuilds a token-free body", async () => {
    const current = [firstUser, assistant];
    const decision = parseMateChatProtocolMessage(request([
      { ...firstUser, parts: [{ type: "text", text: "CLIENT TAMPER" }] },
      assistant,
      { id: "message-2", role: "user", parts: [{ type: "text", text: " Next question " }] }
    ]), current);
    assert.equal(decision.kind, "request");
    const turn = await mateChatTurnBinding(decision.request, await acceptedEnvironment(), claims());
    const sanitized = JSON.parse(sanitizedMateChatRequestFrame(
      decision.request,
      current,
      claims(),
      turn
    ));
    const body = JSON.parse(sanitized.init.body);
    assert.equal(body.chatGrant, undefined);
    assert.equal(body.messages[0].parts[0].text, "First");
    assert.equal(body.messages.at(-1).parts[0].text, "Next question");
    assert.equal(body.recovery.claims.userId, "user-a");
    assert.equal(body.recovery.turn.userMessageId, "message-2");
    assert.match(body.recovery.turn.turnId, /^turn_chat_/);
    assert.equal(body.environment, undefined);
  });

  it("pins a bounded Resource/model selection into the server-owned recovery turn", async () => {
    const decision = parseMateChatProtocolMessage(request([firstUser], {
      selection: {
        appIds: ["portfolio-app"],
        knowledgeServiceIds: ["portfolio-policies"],
        modelId: "model-a"
      }
    }), []);
    assert.equal(decision.kind, "request");
    const turn = await mateChatTurnBinding(decision.request, await acceptedEnvironment(), claims());
    const recovered = mateChatBindingFromRecovery(
      mateChatRecoveryContext(claims(), turn),
      claims().instanceName
    );
    assert.deepEqual(recovered.turn.selection, {
      appIds: ["portfolio-app"],
      knowledgeServiceIds: ["portfolio-policies"],
      modelId: "model-a"
    });
    assert.throws(() => parseMateChatProtocolMessage(request([firstUser], {
      selection: { knowledgeServiceIds: ["duplicate", "duplicate"] }
    }), []));
    assert.throws(() => mateChatBindingFromRecovery({
      ...mateChatRecoveryContext(claims(), turn),
      turn: { ...turn, selection: { modelId: " model-a " } }
    }, claims().instanceName));
  });

  it("accepts a compact new user message after 80 messages while keeping server history authoritative", async () => {
    const current = Array.from({ length: 100 }, (_, i) => ({ id: `old-${i}`, role: i % 2 ? "assistant" : "user", parts: [{ type: "text", text: "server-owned" }] }));
    const user = { id: "message-new", role: "user", parts: [{ type: "text", text: "Continue" }] };
    const decision = parseMateChatProtocolMessage(request([user], { transcriptMode: "server", continuationMessageId: "old-99" }), current);
    assert.equal(decision.request.continuationMessageId, "old-99");
    const turn = await mateChatTurnBinding(decision.request, await acceptedEnvironment(), claims());
    assert.equal(mateChatBindingFromRecovery(mateChatRecoveryContext(claims(), turn), claims().instanceName).turn.continuationMessageId, "old-99");
    const frame = JSON.parse(sanitizedMateChatRequestFrame(decision.request, current, claims(), turn));
    const body = JSON.parse(frame.init.body);
    assert.equal(body.messages.length, 101);
    assert.equal(body.messages[0].parts[0].text, "server-owned");
    assert.throws(() => parseMateChatProtocolMessage(request([user, user], { transcriptMode: "server" }), current));
    assert.throws(() => parseMateChatProtocolMessage(request([current[0]], { transcriptMode: "server" }), current));
  });

  it("rejects transcript deletion, replacement, extra messages and unsupported parts", () => {
    const current = [firstUser, assistant];
    for (const messages of [
      [{ id: "message-2", role: "user", parts: [{ type: "text", text: "Next" }] }],
      [firstUser, { ...assistant, id: "other-assistant" }, { id: "message-2", role: "user", parts: [{ type: "text", text: "Next" }] }],
      [firstUser, assistant, { id: "message-2", role: "user", parts: [{ type: "text", text: "Next" }] }, { id: "message-3", role: "user", parts: [{ type: "text", text: "Extra" }] }],
      [firstUser, assistant, { id: "message-2", role: "user", parts: [{ type: "file", url: "https://example.com" }] }]
    ]) {
      assert.throws(() => parseMateChatProtocolMessage(request(messages), current));
    }
  });

  it("sanitizes Workspace attachments and binds their immutable references into the turn digest", async () => {
    const submitted = {
      id: "message-file-1",
      role: "user",
      parts: [
        { type: "text", text: "Read this" },
        { type: "file", filename: "allocation.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", url: "/api/workspace-files/object-123/raw" }
      ]
    };
    const decision = parseMateChatProtocolMessage(request([submitted]), []);
    assert.equal(decision.kind, "request");
    assert.deepEqual(decision.request.userMessage, submitted);
    assert.match(mateChatUserMessageDigestInput(decision.request.userMessage), /file:allocation\.xlsx/);
    const original = await mateChatTurnBinding(decision.request, await acceptedEnvironment(), claims());
    const changed = parseMateChatProtocolMessage(request([{
      ...submitted,
      parts: [submitted.parts[0], { ...submitted.parts[1], url: "/api/workspace-files/object-456/raw" }]
    }]), []);
    assert.equal(changed.kind, "request");
    const changedTurn = await mateChatTurnBinding(changed.request, await acceptedEnvironment(), claims());
    assert.notEqual(original.messageDigest, changedTurn.messageDigest);
  });

  it("rejects clear, messages, tool, unknown, regenerate and client-tool frames", () => {
    for (const wire of [
      { type: MessageType.CF_AGENT_CHAT_CLEAR },
      { type: MessageType.CF_AGENT_CHAT_MESSAGES, messages: [] },
      { type: MessageType.CF_AGENT_TOOL_RESULT, toolCallId: "tool-1", output: {} },
      { type: MessageType.CF_AGENT_TOOL_APPROVAL, toolCallId: "tool-1", approved: true },
      { type: "rpc", id: "rpc-1", method: "x", args: [] }
    ]) {
      assert.throws(() => parseMateChatProtocolMessage(JSON.stringify(wire), []));
    }
    assert.throws(() => parseMateChatProtocolMessage(request([firstUser], { trigger: "regenerate-message" }), []));
    assert.throws(() => parseMateChatProtocolMessage(request([firstUser], { clientTools: [{ name: "browser" }] }), []));
  });

  it("allows only cancellation and resume handshakes through unchanged", () => {
    for (const wire of [
      { id: "request-1", type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL },
      { id: "request-1", type: MessageType.CF_AGENT_STREAM_RESUME_ACK },
      { probeId: "probe-1", type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST }
    ]) {
      assert.deepEqual(parseMateChatProtocolMessage(JSON.stringify(wire), []), { kind: "passthrough" });
    }
  });

  it("round-trips strict server-owned connection and recovery claims plus the exact turn", async () => {
    const value = claims();
    const decision = parseMateChatProtocolMessage(request([firstUser]), []);
    const turn = await mateChatTurnBinding(decision.request, await acceptedEnvironment(), value);
    const recovery = mateChatRecoveryContext(value, turn);
    assert.match(turn.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(
      mateChatClaimsFromConnectionState(mateChatConnectionState(value), value.instanceName),
      value
    );
    assert.deepEqual(
      mateChatClaimsFromRecovery(recovery, value.instanceName),
      value
    );
    assert.deepEqual(mateChatBindingFromRecovery(recovery, value.instanceName).turn, turn);
    const legacyRecovery = {
      ...recovery,
      turn: Object.fromEntries(Object.entries(turn).filter(([key]) => key !== "startedAt"))
    };
    assert.equal(mateChatBindingFromRecovery(legacyRecovery, value.instanceName).turn.startedAt, undefined);
    assert.throws(() => mateChatClaimsFromRecovery({
      ...recovery,
      injected: true
    }, value.instanceName));
    assert.throws(() => mateChatBindingFromRecovery({
      ...recovery,
      turn: { ...turn, taskId: `task_chat_${"a".repeat(48)}` }
    }, value.instanceName));
  });

  it("keeps Preview connection/recovery claims and deterministic turn ids isolated from Live", async () => {
    const decision = parseMateChatProtocolMessage(request([firstUser]), []);
    const environment = await acceptedEnvironment();
    const liveClaims = claims();
    const previewClaims = claims({ mode: "preview", instanceName: "mate-chat-preview-instance" });
    const liveTurn = await mateChatTurnBinding(decision.request, environment, liveClaims);
    const previewTurn = await mateChatTurnBinding(decision.request, environment, previewClaims);
    assert.notEqual(liveTurn.taskId, previewTurn.taskId);
    assert.deepEqual(
      mateChatClaimsFromConnectionState(
        mateChatConnectionState(previewClaims),
        previewClaims.instanceName
      ),
      previewClaims
    );
    assert.deepEqual(
      mateChatClaimsFromRecovery(
        mateChatRecoveryContext(previewClaims, previewTurn),
        previewClaims.instanceName
      ),
      previewClaims
    );
  });

  it("allows Live release rollover but pins Preview connections to the exact candidate", () => {
    assert.doesNotThrow(() => assertMateChatGrantMatchesConnection(
      claims(),
      claims({ releaseId: "release-2", scopes: ["mate:*"] })
    ));
    assert.throws(() => assertMateChatGrantMatchesConnection(
      claims({ mode: "preview", releaseId: "candidate-1" }),
      claims({ mode: "preview", releaseId: "candidate-2", scopes: ["mate:*"] })
    ));
    assert.doesNotThrow(() => assertMateChatGrantMatchesConnection(
      claims({ mode: "preview", releaseId: "candidate-1" }),
      claims({ mode: "preview", releaseId: "candidate-1", scopes: ["mate:*"] })
    ));
    assert.throws(() => assertMateChatGrantMatchesConnection(claims(), claims({ userId: "user-b" })));
    assert.throws(() => assertMateChatGrantMatchesConnection(claims(), claims({ orgId: "org-2" })));
  });

  it("turns framework delete mode into an append-only assertion", () => {
    assert.doesNotThrow(() => assertMateChatFrameworkAppend(
      [firstUser, assistant],
      [firstUser, assistant, { id: "message-2", role: "user", parts: [{ type: "text", text: "Next" }] }]
    ));
    assert.throws(() => assertMateChatFrameworkAppend([firstUser, assistant], [firstUser]));
  });

  it("accepts an SDK host echo of a fixed Release default model without enabling model switching", () => {
    const definition = {
      release: {
        manifest: {
          modelPolicy: {
            allowedModels: ["tencent-deepseek-v4-flash"],
            allowUserSelection: false,
            defaultModel: "tencent-deepseek-v4-flash"
          },
          resources: { appMcpBindings: [], knowledgeServiceBindings: [] }
        }
      }
    };

    assert.equal(effectiveConversationSelection(definition, {
      modelId: "tencent-deepseek-v4-flash"
    }).modelId, "tencent-deepseek-v4-flash");
    assert.throws(
      () => effectiveConversationSelection(definition, { modelId: "tencent-kimi-k3" }),
      (error) => error?.code === "mate_model_not_allowed"
    );
  });

  it("allows every configured model when a legacy Release still carries the old switch flag", () => {
    const definition = {
      release: {
        manifest: {
          modelPolicy: {
            allowedModels: ["model-alpha", "model-beta"],
            allowUserSelection: false,
            defaultModel: "model-alpha"
          },
          resources: { appMcpBindings: [], knowledgeServiceBindings: [] }
        }
      }
    };

    assert.equal(effectiveConversationSelection(definition, { modelId: "model-beta" }).modelId, "model-beta");
    assert.throws(
      () => effectiveConversationSelection(definition, { modelId: "model-outside-target-list" }),
      /mate_model_not_allowed/
    );
  });

  it("limits an all-visible Knowledge Release to the invoking user's resolved service ids", () => {
    const definition = {
      release: {
        manifest: {
          modelPolicy: {
            allowedModels: ["tencent-deepseek-v4-flash"],
            allowUserSelection: false,
            defaultModel: "tencent-deepseek-v4-flash"
          },
          resources: {
            appMcpBindings: [],
            knowledgeServiceBindings: [],
            knowledgeServiceScope: {
              allowedOperations: ["search", "read"],
              mode: "all_visible_to_invoking_user",
              requiresCurrentUserAuthorization: true
            }
          }
        }
      }
    };

    assert.deepEqual(
      effectiveConversationSelection(definition, undefined, ["user-a", "user-b"]).knowledgeServiceIds,
      ["user-a", "user-b"]
    );
    assert.deepEqual(
      effectiveConversationSelection(definition, {
        knowledgeServiceIds: ["owner-only", "user-b"]
      }, ["user-a", "user-b"]).knowledgeServiceIds,
      ["user-b"]
    );
  });
});
