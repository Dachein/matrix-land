import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyChatChunk, resetAssistantForReplay } from "./chatProtocol.ts";

describe("miniapp chat protocol reducer", () => {
  it("streams text and reasoning into one assistant message", () => {
    let messages = [{ id: "user-1", role: "user", parts: [{ type: "text", text: "hello" }] }];
    messages = applyChatChunk(messages, { type: "start", messageId: "assistant-1" }, "fallback");
    messages = applyChatChunk(messages, { type: "reasoning-start", id: "r1" }, "fallback");
    messages = applyChatChunk(messages, { type: "reasoning-delta", id: "r1", delta: "think" }, "fallback");
    messages = applyChatChunk(messages, { type: "text-start", id: "t1" }, "fallback");
    messages = applyChatChunk(messages, { type: "text-delta", id: "t1", delta: "answer" }, "fallback");
    assert.deepEqual(messages.at(-1).parts.map(({ type, text, state }) => ({ type, text, state })), [
      { type: "reasoning", text: "think", state: "streaming" },
      { type: "text", text: "answer", state: "streaming" }
    ]);
  });

  it("replaces the streamed text part reference so memoized UI parts re-render each delta", () => {
    let messages = [{ id: "assistant-1", role: "assistant", parts: [{ id: "t1", type: "text", text: "Hel", state: "streaming" }] }];
    const previousMessage = messages[0];
    const previousPart = messages[0].parts[0];
    messages = applyChatChunk(messages, { type: "text-delta", id: "t1", delta: "lo" }, "fallback");

    assert.equal(messages[0].parts[0].text, "Hello");
    assert.notEqual(messages[0], previousMessage);
    assert.notEqual(messages[0].parts[0], previousPart);
    assert.equal(previousPart.text, "Hel", "the previous snapshot must remain unchanged");
  });

  it("keeps unchanged part identities stable while updating a streamed part", () => {
    let messages = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "question" }] },
      { id: "assistant-1", role: "assistant", parts: [
        { id: "t1", type: "text", text: "A", state: "streaming" },
        { id: "t2", type: "text", text: "settled", state: "done" }
      ] }
    ];
    const stableUserMessage = messages[0];
    const settledPart = messages[1].parts[1];
    messages = applyChatChunk(messages, { type: "text-delta", id: "t1", delta: "B" }, "fallback");

    assert.equal(messages[1].parts[0].text, "AB");
    assert.equal(messages[0], stableUserMessage, "history rows should not be invalidated by each stream delta");
    assert.equal(messages[1].parts[1], settledPart, "unchanged memoized parts should not be invalidated");
  });

  it("tracks tools, approvals, outputs, sources, files, and durable data parts", () => {
    let messages = [{ id: "assistant-1", role: "assistant", parts: [] }];
    messages = applyChatChunk(messages, { type: "tool-input-available", toolCallId: "call-1", toolName: "crm_write", input: { id: 1 } }, "fallback");
    messages = applyChatChunk(messages, { type: "tool-approval-request", toolCallId: "call-1", approvalId: "approval-1" }, "fallback");
    messages = applyChatChunk(messages, { type: "tool-approval-response", approvalId: "approval-1", approved: true }, "fallback");
    messages = applyChatChunk(messages, { type: "tool-output-available", toolCallId: "call-1", output: { ok: true } }, "fallback");
    messages = applyChatChunk(messages, { type: "source-url", sourceId: "s1", url: "https://example.test", title: "Source" }, "fallback");
    messages = applyChatChunk(messages, { type: "file", url: "/api/workspace-files/f1/raw", mediaType: "application/pdf" }, "fallback");
    messages = applyChatChunk(messages, { type: "data-progress", id: "p1", data: { percent: 50 } }, "fallback");
    messages = applyChatChunk(messages, { type: "data-progress", id: "p1", data: { percent: 100 } }, "fallback");
    const parts = messages[0].parts;
    assert.equal(parts[0].state, "output-available");
    assert.equal(parts[0].approval.approved, true);
    assert.deepEqual(parts[0].output, { ok: true });
    assert.deepEqual(parts.map((part) => part.type), ["tool-crm_write", "source-url", "file", "data-progress"]);
    assert.deepEqual(parts.at(-1).data, { percent: 100 });
  });

  it("accumulates streamed tool input off the part so it is never persisted", () => {
    let messages = [{ id: "assistant-1", role: "assistant", parts: [] }];
    messages = applyChatChunk(messages, { type: "tool-input-start", toolCallId: "call-1", toolName: "crm_write" }, "fallback");
    messages = applyChatChunk(messages, { type: "tool-input-delta", toolCallId: "call-1", inputTextDelta: '{"id":' }, "fallback");
    messages = applyChatChunk(messages, { type: "tool-input-delta", toolCallId: "call-1", inputTextDelta: "1}" }, "fallback");
    const part = messages[0].parts[0];
    assert.deepEqual(part.input, { id: 1 });
    // The raw buffer must live outside the part: it used to be stored as `_rawInput`, which
    // kept every streamed tool argument in memory and serialized it into session storage.
    assert.equal("_rawInput" in part, false);
    assert.equal(JSON.stringify(part).includes("_rawInput"), false);
  });

  it("still surfaces partial JSON while a tool input is incomplete", () => {
    let messages = [{ id: "assistant-1", role: "assistant", parts: [] }];
    messages = applyChatChunk(messages, { type: "tool-input-start", toolCallId: "call-2", toolName: "crm_write" }, "fallback");
    messages = applyChatChunk(messages, { type: "tool-input-delta", toolCallId: "call-2", inputTextDelta: '{"id":1' }, "fallback");
    assert.equal(messages[0].parts[0].input, '{"id":1');
  });

  it("creates a placeholder when tool input deltas arrive before the start frame", () => {
    let messages = [{ id: "assistant-1", role: "assistant", parts: [] }];
    messages = applyChatChunk(messages, { type: "tool-input-delta", toolCallId: "call-3", inputTextDelta: '{"a":1}' }, "fallback");
    assert.equal(messages[0].parts.length, 1);
    assert.deepEqual(messages[0].parts[0].input, { a: 1 });
    assert.equal(messages[0].parts[0].toolCallId, "call-3");
  });

  it("resets a hydrated assistant before a replay", () => {    assert.deepEqual(resetAssistantForReplay([{ id: "a1", role: "assistant", parts: [{ type: "text", text: "partial" }] }], "a1")[0].parts, []);
  });

  it("keeps pre-start process events off the previous assistant and merges the placeholder on start", () => {
    let messages = [
      { id: "assistant-old", role: "assistant", parts: [{ type: "text", text: "old answer" }] },
      { id: "user-new", role: "user", parts: [{ type: "text", text: "new task" }] }
    ];
    messages = applyChatChunk(messages, { type: "data-mate-process", id: "process", data: { status: "running" } }, "assistant-request");
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[0].parts, [{ type: "text", text: "old answer" }]);
    assert.equal(messages[2].id, "assistant-request");
    messages = applyChatChunk(messages, { type: "start", messageId: "assistant-real" }, "assistant-request");
    assert.equal(messages.length, 3);
    assert.equal(messages[2].id, "assistant-real");
    assert.equal(messages[2].parts[0].type, "data-mate-process");
  });
});
