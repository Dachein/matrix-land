import type { ModelMessage, StepResult, ToolSet, UIMessage } from "ai";
import type { EmptyFinalRecovery } from "./emptyFinalResponse.ts";
import { RuntimeHttpError } from "./types.ts";

export const CHAT_MAX_STEPS = 100;
// Stop at a completed step, so tool results can be saved before yielding.
export const CHAT_STREAM_STALL_MS = 5 * 60_000;

export type ChatPauseReason = "step_limit" | "output_limit" | "no_text" | "tool_pending" | "no_progress" | "tool_outcome_unknown" | "history_budget" | "unknown_finish";
export type ChatExecutionState = { state: "completed" | "paused"; reason?: ChatPauseReason; steps: number; emptyFinalRecovery?: EmptyFinalRecovery };
export type ChatCheckpoint = {
  artifacts: unknown[];
  messages: ModelMessage[];
  releaseId: string;
  rootTurnId: string;
  segmentTurnId?: string;
  userMessage?: UIMessage;
  steps: number;
};

export function chatSegmentStopReason(steps: readonly (Pick<StepResult<ToolSet>, "toolCalls" | "text"> & { content?: unknown; toolResults?: readonly { toolName: string; output: unknown }[] })[]): ChatPauseReason | undefined {
  const checkpointBytes = steps.reduce((sum, step) => sum + new TextEncoder().encode(JSON.stringify(step.content ?? { text: step.text, toolCalls: step.toolCalls })).byteLength, 0);
  if (checkpointBytes >= 750_000) return "history_budget";
  if (steps.length >= CHAT_MAX_STEPS) return "step_limit";
  const recent = steps.slice(-3);
  if (recent.length === 3 && recent.every((step) => step.toolCalls.length > 0)) {
    const signatures = recent.map((step) => JSON.stringify(stableValue({
      calls: step.toolCalls.map((call) => [call.toolName, call.input]),
      results: step.toolResults?.map((result) => [result.toolName, result.output])
    })));
    if (signatures.every((signature) => signature === signatures[0]) && recent.every((step) => !step.text.trim())) return "no_progress";
  }
  return undefined;
}

export function chatExecutionState(input: { answer: string; finishReason: string; steps: number; stopReason?: ChatPauseReason }): ChatExecutionState {
  if (input.stopReason === "tool_outcome_unknown") return { state: "paused", reason: input.stopReason, steps: input.steps };
  // A final answer on the budget boundary is still a finished generation.
  if (input.finishReason === "stop" && input.answer.trim()) return { state: "completed", steps: input.steps };
  if (input.finishReason === "error" || input.finishReason === "content-filter") {
    throw new RuntimeHttpError(502, input.finishReason === "content-filter" ? "mate_model_response_filtered" : "mate_conversation_model_stream_failed");
  }
  const reason = input.stopReason ?? (input.finishReason === "length" ? "output_limit" : input.finishReason === "tool-calls" ? "tool_pending" : input.answer.trim() ? "unknown_finish" : "no_text");
  return { state: "paused", reason, steps: input.steps };
}

const READ_TOOLS = new Set([
  "mate_skill_read", "mate_definition_review", "attachment_read", "image_analyze",
  "knowledge_folder_list", "knowledge_folder_search", "knowledge_folder_file_read",
  "knowledge_base_list", "knowledge_base_search", "knowledge_file_read", "knowledge_base_handbook",
  "knowledge_library_list", "knowledge_library_search", "knowledge_library_file_read", "knowledge_library_file_versions",
  "public_web_read", "public_web_search", "todo_list", "reminder_list", "workspace_folder_list"
]);
export function isReadOnlyChatTool(name: string) { return READ_TOOLS.has(name); }

export type ChatToolRecord = { state: "pending" | "completed"; output?: unknown };
export async function executeChatToolOnce(input: {
  name: string;
  args: unknown;
  execute: () => PromiseLike<unknown> | unknown;
  load: () => ChatToolRecord | undefined;
  store: (record: ChatToolRecord) => void;
}) {
  if (isReadOnlyChatTool(input.name)) return input.execute();
  const previous = input.load();
  if (previous?.state === "completed") return previous.output;
  if (previous) throw new RuntimeHttpError(409, "mate_tool_outcome_unknown");
  input.store({ state: "pending" });
  // An exception does not prove that an external write failed. Keep its intent
  // pending rather than repeating a possibly successful side effect.
  const output = await input.execute();
  input.store({ state: "completed", output });
  return output;
}

export function chatToolOperationKey(rootTurnId: string, name: string, args: unknown) {
  return JSON.stringify([rootTurnId, name, stableValue(args)]);
}
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
  return value;
}

export function serializeChatCheckpoint(checkpoint: ChatCheckpoint) {
  return JSON.stringify(checkpoint, (_key, value) => {
    if (!(value instanceof Uint8Array)) return value;
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return { __workspaceCheckpointBytes: btoa(binary) };
  });
}
export function parseChatCheckpoint(value: string): ChatCheckpoint {
  return JSON.parse(value, (_key, item) => {
    if (item && typeof item === "object" && Object.keys(item).length === 1 && typeof item.__workspaceCheckpointBytes === "string") {
      return Uint8Array.from(atob(item.__workspaceCheckpointBytes), (character) => character.charCodeAt(0));
    }
    return item;
  }) as ChatCheckpoint;
}

export function chatCheckpointChunks(value: string, maxCharacters = 200_000) {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 2) throw new RangeError("Checkpoint chunk size must be at least 2 characters");
  const chunks: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + maxCharacters);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xD800 && last <= 0xDBFF) end--;
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}
