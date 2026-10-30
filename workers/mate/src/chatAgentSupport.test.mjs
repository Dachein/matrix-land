import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUIMessageStream } from "ai";
import { chatToolPreview } from "../../../src/shared/chatToolPreview.ts";
import {
  CHAT_MAX_STEPS, chatCheckpointChunks, chatExecutionState, chatSegmentStopReason,
  chatToolOperationKey, executeChatToolOnce, parseChatCheckpoint, serializeChatCheckpoint
} from "./chatExecution.ts";
import {
  chatPrincipalFromGrant,
  latestMateChatUserTurn,
  metadataOnlyChatConclusion,
  resolvedMateChatResponse,
  streamedMateChatResponse,
  mateChatCompletionRowsForResponse,
  mateChatCompletionRetryDelayMs,
  mateChatErrorResponse,
  mateChatAssistantMessageId,
  mateChatTaskConclusionMatches,
  mateChatTerminalMarkerMatches,
  mateChatUserTurn,
  mateKnowledgeConversation,
  mateRoleAttachmentMessages
} from "./chatAgentSupport.ts";

const resolution = {
  answer: "SENSITIVE ANSWER BODY [Policies · kyc.md]",
  artifacts: [{ type: "knowledge_source", serviceId: "policies", serviceName: "Policies", relativePath: "kyc.md" }],
  followUps: ["SENSITIVE FOLLOW UP"],
  outcome: "completed"
};

describe("Mate Chat Agent support", () => {
  it("retains source links in bounded Exa transcript previews without modifying the model result", async () => {
    const output = { provider: "cloudflare_web_search", searchProvider: "exa", count: 2, query: "MAS official FAQ", results: [
      { title: "MAS FAQ", url: "https://www.mas.gov.sg/regulation/faqs/", description: "official text ".repeat(4000) },
      { title: "MAS PDF", url: "https://www.mas.gov.sg/faq.pdf", description: "PDF text ".repeat(4000) }
    ] };
    const preview = chatToolPreview(output, 16000);
    assert.equal(preview.truncated, true);
    assert.deepEqual(preview.results.map((item) => item.url), output.results.map((item) => item.url));
    assert.equal(preview.searchProvider, "exa");
    assert.ok(JSON.stringify(preview).length <= 16000);
    assert.ok(output.results[0].description.length > 16000);
    const inner = createUIMessageStream({ execute: ({ writer }) => {
      writer.write({ type: "start", messageId: "exa-preview" });
      writer.write({ type: "tool-input-available", toolCallId: "exa-1", toolName: "exa_web_search", input: { query: output.query } });
      writer.write({ type: "tool-output-available", toolCallId: "exa-1", output });
    } });
    const response = streamedMateChatResponse({ artifacts: [], result: {
      text: Promise.resolve("Official sources"), finishReason: Promise.resolve("stop"), steps: Promise.resolve([]), toUIMessageStream: () => inner
    } }, { assistantMessageId: "exa-preview", turnId: "turn-exa", releaseId: "release-exa", startedAt: new Date().toISOString(),
      onComplete: async () => undefined, onFailure: async () => assert.fail("preview should not fail") });
    const body = await response.text();
    const chunk = body.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6))).find((part) => part.type === "tool-output-available");
    assert.deepEqual(chunk.output, preview);
  });

  it("bounds generic previews even when JSON escaping expands the content", () => {
    const output = { text: '"\\\n'.repeat(10000) };
    assert.ok(JSON.stringify(chatToolPreview(output, 16000)).length <= 16000);
    const short = { found: 1 };
    assert.equal(chatToolPreview(short, 16000), short);
  });
  it("retains only earlier user file references from completed same-release turns", () => {
    const user = (id) => ({ id, role: "user", parts: [{ type: "file", filename: "test.xlsx", mediaType: "application/octet-stream", url: `/api/workspace-files/${id}/raw` }] });
    const assistant = (releaseId, outcome = "completed") => ({ id: `answer-${releaseId}-${outcome}`, role: "assistant", parts: [{ type: "data-mate-turn", data: { releaseId, outcome } }] });
    const eligible = user("earlier");
    assert.deepEqual(mateRoleAttachmentMessages([
      user("old-release"), assistant("old"), user("failed"), assistant("current", "failed"),
      eligible, assistant("current"),
      { id: "inline", role: "user", parts: [{ type: "file", filename: "image.png", mediaType: "image/png", url: "data:image/png;base64,AA==" }] }, assistant("current"),
      user("uncompleted"), user("now"), assistant("current"), user("future"), assistant("current")
    ], "now", "current"), [eligible]);
    const many = Array.from({ length: 8 }, (_, index) => [user(`file-${index}`), assistant("current")]).flat();
    assert.deepEqual(mateRoleAttachmentMessages([...many, user("now")], "now", "current").map((item) => item.id),
      ["file-2", "file-3", "file-4", "file-5", "file-6", "file-7"]);
  });
  it("extracts only the latest bounded user text", () => {
    assert.deepEqual(latestMateChatUserTurn([
      { id: "old-1", role: "user", parts: [{ type: "text", text: "old" }] },
      { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "answer" }] },
      { id: "message-2", role: "user", parts: [{ type: "text", text: " latest " }, { type: "file", url: "ignored" }] }
    ]), { id: "message-2", text: "latest" });
    assert.deepEqual(mateChatUserTurn([
      { id: "message-1", role: "user", parts: [{ type: "text", text: "bound" }] },
      { id: "message-2", role: "user", parts: [{ type: "text", text: "newer" }] }
    ], "message-1"), { id: "message-1", text: "bound" });
  });

  it("reconstructs invoking-user authority from signed claims only", () => {
    const principal = chatPrincipalFromGrant({
      aud: "workspace-mate-chat",
      callerKind: "user",
      conversationId: "conversation-1",
      exp: 10,
      iat: 1,
      instanceName: "mate-chat-instance",
      jti: "grant-1",
      mode: "live",
      orgId: "org-1",
      releaseId: "release-1",
      scopes: ["mate:invoke"],
      mateId: "knowledge-mate",
      userId: "user-a",
      version: 1
    });
    assert.deepEqual(principal, {
      callerKind: "user",
      orgId: "org-1",
      scopes: ["mate:invoke"],
      userId: "user-a"
    });
    assert.deepEqual(chatPrincipalFromGrant({
      aud: "workspace-mate-chat",
      callerKind: "user",
      conversationId: "conversation-preview",
      exp: 10,
      iat: 1,
      instanceName: "mate-chat-preview-instance",
      jti: "grant-preview",
      mode: "preview",
      orgId: "org-1",
      releaseId: "candidate-2",
      scopes: ["mate:invoke"],
      mateId: "knowledge-mate",
      userId: "owner-1",
      version: 1
    }), {
      callerKind: "user",
      orgId: "org-1",
      scopes: ["mate:invoke"],
      testGrant: { releaseId: "candidate-2", mateId: "knowledge-mate" },
      userId: "owner-1"
    });
  });

  it("builds bounded conversational context from DO text parts without the current user turn", () => {
    assert.deepEqual(mateKnowledgeConversation([
      { id: "message-1", role: "user", parts: [{ type: "text", text: "What is the KYC cadence?" }] },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "text", text: "It is annual." },
          { type: "data-private", data: "ignored" },
          { type: "data-mate-task", data: { outcome: "completed", releaseId: "release-1" } }
        ]
      },
      { id: "message-2", role: "user", parts: [{ type: "text", text: "Who owns it?" }] }
    ], "message-2", "release-1"), [
      { content: "What is the KYC cadence?", role: "user" },
      { content: "It is annual.", role: "assistant" }
    ]);
  });

  it("keeps only completed user/assistant pairs from the active release", () => {
    assert.deepEqual(mateKnowledgeConversation([
      { id: "message-old", role: "user", parts: [{ type: "text", text: "Old-release question" }] },
      {
        id: "assistant-old",
        role: "assistant",
        parts: [
          { type: "text", text: "Old-release answer" },
          { type: "data-mate-task", data: { outcome: "completed", releaseId: "release-old" } }
        ]
      },
      { id: "message-unmarked", role: "user", parts: [{ type: "text", text: "Unmarked question" }] },
      { id: "assistant-unmarked", role: "assistant", parts: [{ type: "text", text: "Unmarked answer" }] },
      { id: "message-failed", role: "user", parts: [{ type: "text", text: "Failed question" }] },
      {
        id: "assistant-failed",
        role: "assistant",
        parts: [
          { type: "text", text: "Failed answer" },
          { type: "data-mate-task", data: { outcome: "failed", releaseId: "release-2" } }
        ]
      },
      { id: "message-active", role: "user", parts: [{ type: "text", text: "Active-release question" }] },
      {
        id: "assistant-active",
        role: "assistant",
        parts: [
          { type: "text", text: "Active-release answer" },
          { type: "data-mate-task", data: { outcome: "completed", releaseId: "release-2" } }
        ]
      },
      { id: "message-current", role: "user", parts: [{ type: "text", text: "Current question" }] }
    ], "message-current", "release-2"), [
      { content: "Active-release question", role: "user" },
      { content: "Active-release answer", role: "assistant" }
    ]);
  });

  it("keeps answer and follow-up bodies out of the D1 conclusion", () => {
    const conclusion = metadataOnlyChatConclusion(resolution, {
      assistantMessageId: "assistant-12345678",
      responseDigest: `sha256:${"a".repeat(64)}`
    });
    const serialized = JSON.stringify(conclusion);
    assert.doesNotMatch(serialized, /SENSITIVE ANSWER BODY/);
    assert.doesNotMatch(serialized, /SENSITIVE FOLLOW UP/);
    assert.match(serialized, /agent_do_message/);
  });

  it("emits an AI SDK conversation stream with citations and a turn marker, never Task metadata", async () => {
    const turnId = `turn_chat_${"b".repeat(48)}`;
    const assistantMessageId = mateChatAssistantMessageId(turnId);
    const response = resolvedMateChatResponse(resolution, {
      assistantMessageId,
      releaseId: "release-1",
      responseDigest: `sha256:${"c".repeat(64)}`,
      startedAt: "2026-08-29T00:00:00.000Z",
      turnId
    });
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await response.text();
    assert.match(body, /SENSITIVE ANSWER BODY/);
    assert.match(body, /data-mate-citations/);
    assert.match(body, /data-mate-turn/);
    assert.match(body, /data-mate-process/);
    assert.match(body, /workspace\.mate-process\/v1/);
    assert.match(body, /2026-08-29T00:00:00\.000Z/);
    assert.match(body, /"status":"completed"/);
    assert.doesNotMatch(body, /data-mate-task/);
    assert.match(body, /release-1/);
  });

  it("preserves real reasoning/tool deltas and appends the exact Runtime terminal marker", async () => {
    const turnId = `turn_chat_${"7".repeat(48)}`;
    const assistantMessageId = mateChatAssistantMessageId(turnId);
    const completed = [];
    const inner = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId: assistantMessageId });
        writer.write({ type: "start-step" });
        writer.write({ type: "reasoning-start", id: "reasoning-1" });
        writer.write({ type: "reasoning-delta", id: "reasoning-1", delta: "核验授权资料" });
        writer.write({ type: "reasoning-end", id: "reasoning-1" });
        writer.write({ type: "tool-input-start", toolCallId: "tool-1", toolName: "knowledge_base_search" });
        writer.write({ type: "tool-input-available", toolCallId: "tool-1", toolName: "knowledge_base_search", input: { query: "KYC" } });
        writer.write({ type: "tool-output-available", toolCallId: "tool-1", output: { totalResults: 1 } });
        writer.write({ type: "text-start", id: "text-1" });
        writer.write({ type: "text-delta", id: "text-1", delta: "真实流式答案" });
        writer.write({ type: "text-end", id: "text-1" });
        writer.write({ type: "finish-step" });
      }
    });
    const response = streamedMateChatResponse({
      artifacts: [{ relativePath: "kyc.md", serviceId: "policy", serviceName: "Policy", type: "knowledge_source" }],
      result: {
        text: Promise.resolve("真实流式答案"),
        toUIMessageStream: () => inner
      }
    }, {
      assistantMessageId,
      onComplete: async (value) => {
        completed.push(value);
        return { responseDigest: `sha256:${"8".repeat(64)}` };
      },
      onFailure: async () => assert.fail("stream should not fail"),
      releaseId: "release-streaming",
      startedAt: "2026-08-29T00:00:00.000Z",
      turnId
    });
    const body = await response.text();
    assert.match(body, /reasoning-delta/);
    assert.match(body, /tool-output-available/);
    assert.match(body, /真实流式答案/);
    assert.match(body, /data-mate-citations/);
    assert.match(body, /data-mate-turn/);
    assert.match(body, /data-mate-process/);
    assert.match(body, /"status":"completed"/);
    assert.doesNotMatch(body, /responseDigest/);
    assert.ok(body.indexOf("tool-output-available") < body.indexOf("data-mate-turn"));
    assert.equal(completed.length, 1);
    assert.equal(completed[0].answer, "真实流式答案");
    const chunks = body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    assert.deepEqual(chunks.filter(part => part.type === "start"), [{ type: "start", messageId: assistantMessageId }]);
    assert.equal(chunks[0].type, "start", "progress must never create a second assistant before start");
  });

  it("persists a tool-only ending as a paused segment with no response digest or error", async () => {
    const turnId = `turn_chat_${"9".repeat(48)}`;
    const assistantMessageId = mateChatAssistantMessageId(turnId);
    let conclusion;
    const inner = createUIMessageStream({ execute: ({ writer }) => {
      writer.write({ type: "start", messageId: assistantMessageId });
      writer.write({ type: "tool-input-available", toolName: "search", toolCallId: "tool-only", input: {} });
      writer.write({ type: "tool-output-available", toolCallId: "tool-only", output: { found: 1 } });
    } });
    const response = streamedMateChatResponse({ artifacts: [], stopReason: () => "step_limit", result: {
      text: Promise.resolve(""), finishReason: Promise.resolve("tool-calls"), steps: Promise.resolve(Array(100).fill({})), toUIMessageStream: () => inner
    } }, { assistantMessageId, turnId, releaseId: "release-1", startedAt: new Date().toISOString(),
      onComplete: async (value) => { conclusion = value; }, onFailure: async () => assert.fail("normal pause must not fail") });
    const body = await response.text();
    assert.equal(conclusion.execution.state, "paused");
    assert.equal(conclusion.execution.reason, "step_limit");
    assert.match(body, /"status":"paused"/);
    assert.doesNotMatch(body, /"type":"error"|responseDigest/);
    assert.ok(body.indexOf("tool-output-available") < body.indexOf("data-mate-turn"));
  });

  it("uses persisted message identity rather than matching an old answer digest", () => {
    const marker = { assistantMessageId: "assistant-identity", outcome: "completed", releaseId: "r1", schemaVersion: "workspace.mate-conversation-turn/v1", turnId: "turn-identity", responseDigest: "different-old-digest" };
    const message = { id: marker.assistantMessageId, role: "assistant", parts: [{ type: "text", text: "intermediate plus final answer" }, { type: "data-mate-turn", data: marker }] };
    assert.equal(mateChatTerminalMarkerMatches(message, { ...marker, responseDigest: "old-expected-digest" }), true);
    assert.equal(mateChatTerminalMarkerMatches(message, { ...marker, turnId: "another-turn" }), false);
  });

  it("closes a failed provider stream with a timed failed process event", async () => {
    const turnId = `turn_chat_${"6".repeat(48)}`;
    const assistantMessageId = mateChatAssistantMessageId(turnId);
    const failures = [];
    const inner = createUIMessageStream({
      execute: ({ writer }) => writer.write({ type: "start", messageId: assistantMessageId })
    });
    const response = streamedMateChatResponse({
      artifacts: [],
      result: {
        text: Promise.reject(new Error("provider exploded with secret detail")),
        toUIMessageStream: () => inner
      }
    }, {
      assistantMessageId,
      onComplete: async () => assert.fail("failed stream must not complete"),
      onFailure: async (error) => {
        failures.push(error);
        return "failed";
      },
      releaseId: "release-streaming",
      startedAt: "2026-08-29T00:00:00.000Z",
      turnId
    });
    const body = await response.text();
    assert.match(body, /data-mate-process/);
    assert.match(body, /"status":"failed"/);
    assert.match(body, /mate_chat_response_stream_failed/);
    assert.doesNotMatch(body, /provider exploded with secret detail/);
    assert.equal(failures.length, 1);
  });

  it("publishes failed status before the first error chunk so error-stopping clients persist the failure", async () => {
    const assistantMessageId = "assistant-provider-rejected";
    let failures = 0;
    const inner = createUIMessageStream({ execute: ({ writer }) => {
      writer.write({ type: "start", messageId: "unexpected-provider-id" });
      writer.write({ type: "error", errorText: "provider detail must stay private" });
    } });
    const response = streamedMateChatResponse({ artifacts: [], result: {
      text: Promise.reject(new Error("private rejected schema")), toUIMessageStream: () => inner
    } }, { assistantMessageId, turnId: "turn-provider-rejected", releaseId: "release-1", startedAt: "2026-10-19T05:06:51.061Z",
      onComplete: async () => assert.fail("rejected requests never complete"),
      onFailure: async () => { failures++; return "failed"; }
    });
    const body = await response.text();
    const chunks = body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    assert.deepEqual(chunks.filter(part => part.type === "start"), [{ type: "start", messageId: assistantMessageId }]);
    const errorIndex = chunks.findIndex(part => part.type === "error");
    assert.ok(errorIndex > 0);
    assert.equal(chunks.filter(part => part.type === "error").length, 1);
    const received = chunks.slice(0, errorIndex);
    assert.equal(received.filter(part => part.type === "data-mate-process").at(-1).data.status, "failed");
    assert.ok(received.at(-1).data.completedAt);
    assert.equal(received.some(part => part.type === "data-mate-turn"), false);
    assert.doesNotMatch(body, /private rejected schema|provider detail|unexpected-provider-id/);
    assert.equal(failures, 1);
  });

  it("keeps a dependency failure aligned across the assistant terminal marker and D1 conclusion", async () => {
    const failedResolution = {
      answer: "Knowledge Mate 未能完成本次任务（knowledge_execution_timeout）。没有执行任何写操作。",
      artifacts: [],
      errorCode: "knowledge_execution_timeout",
      followUps: [],
      outcome: "failed"
    };
    const turnId = `turn_chat_${"f".repeat(48)}`;
    const assistantMessageId = mateChatAssistantMessageId(turnId);
    const responseDigest = `sha256:${"9".repeat(64)}`;
    const response = resolvedMateChatResponse(failedResolution, {
      assistantMessageId,
      releaseId: "release-failed",
      responseDigest,
      startedAt: "2026-08-29T00:00:00.000Z",
      turnId
    });
    const body = await response.text();
    assert.match(body, /"outcome":"failed"/);
    assert.match(body, /"finishReason":"error"/);
    assert.match(body, /data-mate-turn/);
    assert.match(body, /data-mate-process/);
    assert.match(body, /"status":"failed"/);
    assert.doesNotMatch(body, /data-mate-citations/);

    const conclusion = metadataOnlyChatConclusion(failedResolution, {
      assistantMessageId,
      responseDigest
    });
    assert.equal(conclusion.outcome, "failed");
    assert.equal(conclusion.errorCode, "knowledge_execution_timeout");
    assert.equal(conclusion.summary, "Agent DO response failed.");
    assert.equal(mateChatTaskConclusionMatches(
      { conclusion, releaseId: "release-failed", status: "failed" },
      { conclusion, releaseId: "release-failed" }
    ), true);
  });

  it("requires the full terminal marker and exact Release, turn, and digest", () => {
    const expected = {
      assistantMessageId: "assistant-12345678",
      outcome: "completed",
      releaseId: "release-1",
      responseDigest: `sha256:${"d".repeat(64)}`,
      turnId: `turn_chat_${"e".repeat(48)}`
    };
    const message = {
      id: expected.assistantMessageId,
      role: "assistant",
      parts: [{
        type: "data-mate-turn",
        data: { ...expected, schemaVersion: "workspace.mate-conversation-turn/v1" }
      }]
    };
    assert.equal(mateChatTerminalMarkerMatches(message, expected), true);
    assert.equal(mateChatTerminalMarkerMatches({
      ...message,
      parts: [{ ...message.parts[0], data: { ...message.parts[0].data, releaseId: "release-2" } }]
    }, expected), false);
    assert.equal(mateChatTerminalMarkerMatches({
      id: expected.assistantMessageId,
      role: "assistant",
      parts: [{ type: "text", text: "partial or recovery banner" }]
    }, expected), false);
  });

  it("bounds completion outbox backoff and verifies an already-concluded D1 projection", () => {
    assert.deepEqual([1, 2, 3, 7].map(mateChatCompletionRetryDelayMs), [5_000, 10_000, 20_000, 300_000]);
    const conclusion = {
      outcome: "completed",
      summary: "Agent DO response completed.",
      artifacts: [{ type: "agent_do_message", messageId: "assistant-1", digest: `sha256:${"a".repeat(64)}` }]
    };
    const task = { status: "completed", releaseId: "release-1", conclusion };
    assert.equal(mateChatTaskConclusionMatches(task, { conclusion, releaseId: "release-1" }), true);
    assert.equal(mateChatTaskConclusionMatches(
      { ...task, conclusion: { ...conclusion, artifacts: [{ ...conclusion.artifacts[0], digest: `sha256:${"b".repeat(64)}` }] } },
      { conclusion, releaseId: "release-1" }
    ), false);
  });

  it("falls back from a recovery request id to the deterministic assistant message id", () => {
    const root = { assistantMessageId: "assistant-task-1", requestId: "request-root" };
    let fallbackReads = 0;
    assert.deepEqual(mateChatCompletionRowsForResponse(
      [],
      () => {
        fallbackReads += 1;
        return [root, { assistantMessageId: "assistant-task-2", requestId: "request-other" }];
      },
      "assistant-task-1"
    ), [root]);
    assert.equal(fallbackReads, 1);

    const rebound = { ...root, requestId: "request-recovered" };
    assert.deepEqual(mateChatCompletionRowsForResponse(
      [rebound],
      () => {
        fallbackReads += 1;
        return [];
      },
      "assistant-task-1"
    ), [rebound]);
    assert.equal(fallbackReads, 1);
  });

  it("emits handler failures as protocol error chunks, not JSON assistant text", async () => {
    const response = mateChatErrorResponse("mate_chat_release_changed");
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await response.text();
    assert.match(body, /\"type\":\"error\"/);
    assert.match(body, /mate_chat_release_changed/);
    assert.doesNotMatch(body, /\"role\":\"assistant\"/);
  });
});



describe("chat execution budgets and continuation", () => {
  it("allows 100 steps and yields only after a completed step", () => {
    const steps = Array.from({ length: CHAT_MAX_STEPS }, () => ({ text: "progress", toolCalls: [] }));
    assert.equal(chatSegmentStopReason(steps.slice(0, 99)), undefined);
    assert.equal(chatSegmentStopReason(steps), "step_limit");
    assert.equal(chatSegmentStopReason([{ text: "progress", toolCalls: [], content: "a".repeat(750_000) }]), "history_budget");
  });

  it("pauses tool-only, empty and truncated endings without falsely declaring work done", () => {
    for (const [finishReason, answer, reason] of [["tool-calls", "", "tool_pending"], ["stop", "", "no_text"], ["length", "partial", "output_limit"], ["unknown", "partial", "unknown_finish"]]) {
      assert.deepEqual(chatExecutionState({ finishReason, answer, steps: 12 }), { state: "paused", reason, steps: 12 });
    }
    assert.deepEqual(chatExecutionState({ finishReason: "stop", answer: "done", steps: 100, stopReason: "step_limit" }), { state: "completed", steps: 100 });
    assert.throws(() => chatExecutionState({ finishReason: "error", answer: "", steps: 0 }), /mate_conversation_model_stream_failed/);
    assert.throws(() => chatExecutionState({ finishReason: "content-filter", answer: "", steps: 0 }), /mate_model_response_filtered/);
  });

  it("detects repeated tool-only steps without treating different queries as a loop", () => {
    const step = { text: "", toolCalls: [{ toolName: "search", input: { query: "same" } }] };
    assert.equal(chatSegmentStopReason([step, step]), undefined);
    assert.equal(chatSegmentStopReason([step, step, step]), "no_progress");
    assert.equal(chatSegmentStopReason([step, step, { ...step, text: "new progress" }]), undefined);
    const progressing = [1, 2, 3].map((status) => ({ ...step, toolResults: [{ toolName: "search", output: { status } }] }));
    assert.equal(chatSegmentStopReason(progressing), undefined);
  });

  it("reuses a completed write result across recovery and refuses an uncertain write", async () => {
    let record;
    let writes = 0;
    const input = { name: "workspace_file_create", args: {}, load: () => record, store: (value) => { record = value; }, execute: async () => { writes++; return { fileId: "file-1" }; } };
    assert.deepEqual(await executeChatToolOnce(input), { fileId: "file-1" });
    assert.deepEqual(await executeChatToolOnce(input), { fileId: "file-1" });
    assert.equal(writes, 1);
    record = { state: "pending" };
    await assert.rejects(executeChatToolOnce(input), /mate_tool_outcome_unknown/);
    assert.equal(writes, 1);
    assert.equal(chatExecutionState({ finishReason: "stop", answer: "done", steps: 1, stopReason: "tool_outcome_unknown" }).state, "paused");
  });

  it("keeps failed write intents and allows read-only tools to fetch fresh results", async () => {
    let record;
    const base = { args: {}, load: () => record, store: (value) => { record = value; } };
    await assert.rejects(executeChatToolOnce({ ...base, name: "unknown_mcp_write", execute: async () => { throw new Error("disconnected after write"); } }));
    assert.equal(record.state, "pending");
    let reads = 0;
    for (let i = 0; i < 2; i++) await executeChatToolOnce({ ...base, name: "knowledge_base_search", execute: async () => ++reads });
    assert.equal(reads, 2);
  });

  it("keeps Unicode intact across checkpoint storage chunks", () => {
    const value = `${"a".repeat(7)}😀${"b".repeat(20)}`;
    const chunks = chatCheckpointChunks(value, 8);
    const decoder = new TextDecoder();
    assert.equal(chunks.map((chunk) => decoder.decode(new TextEncoder().encode(chunk))).join(""), value);
    assert.throws(() => chatCheckpointChunks(value, 1), RangeError);
  });

  it("round-trips binary image inputs in persisted checkpoints", () => {
    const checkpoint = { artifacts: [], messages: [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: { type: "data", data: new Uint8Array([0, 127, 255]) } }] }], releaseId: "r1", rootTurnId: "root", steps: 1 };
    const decoded = parseChatCheckpoint(serializeChatCheckpoint(checkpoint));
    assert.deepEqual(decoded.messages[0].content[0].data.data, new Uint8Array([0, 127, 255]));
  });

  it("deduplicates equivalent arguments only inside the same root task", () => {
    assert.equal(chatToolOperationKey("root-a", "write", { a: 1, b: 2 }), chatToolOperationKey("root-a", "write", { b: 2, a: 1 }));
    assert.notEqual(chatToolOperationKey("root-a", "write", {}), chatToolOperationKey("root-b", "write", {}));
  });
});
