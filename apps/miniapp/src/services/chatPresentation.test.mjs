import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatProcessStatus, chatTurnProcess, hasVisibleMessageContent, isVisibleChatPart, latestChatProcessStep, shouldShowChatProcess } from "./chatPresentation.ts";

describe("miniapp chat process presentation", () => {
  it("keeps paused checkpoint work paused instead of completed", () => {
    const process = chatTurnProcess({ id: "paused", role: "assistant", parts: [
      { type: "tool-search", state: "output-available" },
      { type: "data-mate-turn", data: { execution: { state: "paused", reason: "step_budget" } } },
      { type: "data-mate-process", data: { schemaVersion: "workspace.mate-process/v1", status: "paused" } }
    ] });
    assert.equal(chatProcessStatus(false, process), "paused");
  });
  it("uses actual approval execution results instead of successful proposal generation", () => {
    const message = { id: "approval", role: "assistant", parts: [
      { type: "tool-knowledge_library_write", state: "output-available", output: { approval: { id: "approval-1", status: "pending" } } },
      { type: "data-mate-process", data: { schemaVersion: "workspace.mate-process/v1", status: "completed" } }
    ] };
    assert.equal(chatProcessStatus(false, chatTurnProcess(message)), "waiting");
    assert.equal(chatTurnProcess(message, [{ id: "approval-1", status: "approved", task: { status: "failed" } }]).steps[0].status, "failed");
  });
  it("keeps reasoning drafts out of progress and leaves text parts for the answer", () => {
    const process = chatTurnProcess({ id: "a1", role: "assistant", parts: [
      { type: "reasoning", text: "private draft", state: "streaming" },
      { type: "text", text: "开始检索" },
      { type: "tool-public_web_search", toolCallId: "one", toolName: "public_web_search", input: { private: "tool input" }, state: "output-available" },
      { type: "reasoning", text: "继续核对" },
      { type: "tool-public_web_read", toolCallId: "two", toolName: "public_web_read", state: "input-available" },
      { type: "text", text: "最终答复" }
    ] });
    assert.deepEqual(process.steps.map((step) => step.kind), ["reasoning", "tool", "reasoning", "tool"]);
    assert.equal(process.steps[0].text, "进行中");
    assert.equal(JSON.stringify(process).includes("private draft"), false);
    assert.equal(JSON.stringify(process).includes("tool input"), false);
    assert.equal(JSON.stringify(process).includes("继续核对"), false);
    assert.equal(latestChatProcessStep(process.steps).label, "public_web_read");
    assert.equal(chatProcessStatus(true, process), "waiting");
  });

  it("shows the latest safe status and keeps approval requests visible", () => {
    const process = chatTurnProcess({ id: "a1", role: "assistant", parts: [
      { type: "tool-first", toolName: "first", state: "output-available" },
      { type: "tool-second", toolName: "second", state: "output-available" },
      { type: "reasoning", text: "收尾" },
      { type: "data-mate-process", data: { schemaVersion: "workspace.mate-process/v1", status: "completed" } }
    ] });
    assert.equal(latestChatProcessStep(process.steps).label, "思考");
    assert.equal(chatProcessStatus(false, process), "completed");
    const waiting = chatTurnProcess({ id: "a2", role: "assistant", parts: [
      { type: "tool-crm_write", toolName: "crm_write", state: "approval-requested", approval: { id: "approval-1" } },
      { type: "reasoning", text: "do not surface", state: "streaming" }
    ] });
    assert.equal(latestChatProcessStep(waiting.steps).label, "crm_write");
  });

  it("surfaces an approval request as waiting", () => {
    const process = chatTurnProcess({ id: "a1", role: "assistant", parts: [
      { type: "tool-crm_write", toolName: "crm_write", state: "approval-requested", approval: { id: "approval-1" } }
    ] });
    assert.equal(latestChatProcessStep(process.steps).text, "需要你的确认");
    assert.equal(chatProcessStatus(false, process), "waiting");
    assert.equal(shouldShowChatProcess(false, process), true);
  });

  it("hides settled tool and thinking traces from history but keeps the live turn visible", () => {
    const process = chatTurnProcess({ id: "a1", role: "assistant", parts: [
      { type: "tool-search", toolName: "search", state: "output-available" },
      { type: "reasoning", text: "internal reasoning" }
    ] });
    assert.equal(shouldShowChatProcess(false, process), false);
    assert.equal(shouldShowChatProcess(true, process), true);
  });

  it("does not create empty message rows for process metadata", () => {
    assert.equal(isVisibleChatPart({ type: "data-mate-process", data: { status: "running" } }), false);
    assert.equal(isVisibleChatPart({ type: "data-mate-turn", data: {} }), false);
    assert.equal(isVisibleChatPart({ type: "data-mate-citations", data: { sources: [{ title: "Forum topic" }] } }), false);
    assert.equal(isVisibleChatPart({ type: "data-mate-task", data: { schemaVersion: "workspace.mate-chat-terminal/v1" } }), false);
    assert.equal(isVisibleChatPart({ type: "step-start" }), false);
    assert.equal(isVisibleChatPart({ type: "data-progress", data: { percent: 50 } }), true);
  });
});


describe("settled transcript content", () => {
  const msg = parts => ({ id: "old", role: "assistant", parts });
  it("removes process-only history, retains current work and pending approval", () => {
    const done = msg([{ type: "tool-search", state: "output-available" }, { type: "reasoning", text: "draft" }]);
    assert.equal(hasVisibleMessageContent(done), false);
    assert.equal(hasVisibleMessageContent(done, true), true);
    assert.equal(hasVisibleMessageContent(msg([{ type: "tool-write", state: "approval-requested", approval: { id: "approval" } }])), true);
    assert.equal(hasVisibleMessageContent(msg([{ type: "text", text: "Final answer" }, ...done.parts])), true);
  });
  it("retains generated files, images, citation-only references and authorization links", () => {
    const file = { objectId: "art_12345678-1234-1234-1234-123456789abc", fileName: "report.pdf" };
    assert.equal(hasVisibleMessageContent(msg([{ type: "tool-workspace_file_create", state: "output-available", output: { file } }])), true);
    assert.equal(hasVisibleMessageContent(msg([{ type: "file", filename: "image.png", url: "/api/workspace-files/one/raw" }])), true);
    assert.equal(hasVisibleMessageContent(msg([{ type: "data-mate-citations", data: { sources: [{ title: "Reference", url: "https://example.com/reference" }] } }])), true);
    assert.equal(hasVisibleMessageContent(msg([{ type: "tool-mate_mcp_manage", state: "output-available", output: { authorizationUrl: "https://example.com/authorize" } }])), true);
  });
});
