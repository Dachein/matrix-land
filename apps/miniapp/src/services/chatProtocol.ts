import type { ChatMessage, ChatPart } from "../types";

type Chunk = Record<string, any> & { type?: string };

/** Small, platform-neutral AI SDK UI-message reducer used by the mini-program. */
export function applyChatChunk(messages: ChatMessage[], rawChunk: unknown, fallbackId: string) {
  const chunk = asChunk(rawChunk);
  if (!chunk) return messages;
  const next = [...messages];
  let index = latestAssistant(messages);
  if (chunk.type === "start" && typeof chunk.messageId === "string") {
    index = next.findIndex((message) => message.id === chunk.messageId);
    if (index < 0) {
      const placeholderIndex = next.findIndex((message) => message.id === fallbackId && message.role === "assistant");
      if (placeholderIndex >= 0) next[placeholderIndex] = { ...next[placeholderIndex], id: chunk.messageId, ...(chunk.messageMetadata === undefined ? {} : { metadata: chunk.messageMetadata }) };
      else next.push({ id: chunk.messageId, role: "assistant", parts: [], ...(chunk.messageMetadata === undefined ? {} : { metadata: chunk.messageMetadata }) });
    } else if (chunk.messageMetadata !== undefined) next[index] = { ...next[index], metadata: chunk.messageMetadata };
    return next;
  }
  if (index < 0) {
    next.push({ id: fallbackId, role: "assistant", parts: [] });
    index = next.length - 1;
  } else {
    next[index] = { ...messages[index], parts: [...messages[index].parts] };
  }
  const message = next[index];
  const parts = message.parts;
  const id = typeof chunk.id === "string" ? chunk.id : "";
  const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : "";
  const toolIndex = toolCallId ? parts.findIndex((part) => part.toolCallId === toolCallId) : -1;

  switch (chunk.type) {
    case "text-start": parts.push({ id, type: "text", text: "", state: "streaming" }); break;
    case "text-delta": mutateText(parts, "text", id, String(chunk.delta || "")); break;
    case "text-end": finishText(parts, "text", id); break;
    case "reasoning-start": parts.push({ id, type: "reasoning", text: "", state: "streaming" }); break;
    case "reasoning-delta": mutateText(parts, "reasoning", id, String(chunk.delta || "")); break;
    case "reasoning-end": finishText(parts, "reasoning", id); break;
    case "file":
    case "reasoning-file": parts.push(copyPart(chunk, ["type", "url", "mediaType", "filename"])); break;
    case "source-url": parts.push(copyPart(chunk, ["type", "sourceId", "url", "title"])); break;
    case "source-document": parts.push(copyPart(chunk, ["type", "sourceId", "mediaType", "title", "filename"])); break;
    case "tool-input-start": upsertTool(parts, chunk, "input-streaming"); break;
    case "tool-input-delta": {
      const part = ensureToolPart(parts, chunk);
      if (part && !isInputBufferFull(part)) {
        const raw = `${partInputBuffer(part)}${String(chunk.inputTextDelta || "")}`;
        const updated = { ...part, input: partialJson(raw) };
        bufferInput(updated, raw);
        parts[parts.indexOf(part)] = updated;
      }
      break;
    }
    case "tool-input-available": upsertTool(parts, chunk, "input-available"); break;
    case "tool-input-error": upsertTool(parts, chunk, "output-error"); break;
    case "tool-approval-request": {
      const part = parts[toolIndex];
      if (part) parts[toolIndex] = { ...part, state: "approval-requested", approval: { id: String(chunk.approvalId || "") } };
      break;
    }
    case "tool-approval-response": {
      const partIndex = parts.findIndex((candidate) => candidate.approval?.id === chunk.approvalId);
      const part = parts[partIndex];
      if (part) parts[partIndex] = { ...part, state: "approval-responded", approval: { ...part.approval!, approved: Boolean(chunk.approved), ...(chunk.reason ? { reason: String(chunk.reason) } : {}) } };
      break;
    }
    case "tool-output-available": if (parts[toolIndex]) parts[toolIndex] = { ...parts[toolIndex], state: "output-available", output: chunk.output }; break;
    case "tool-output-error": if (parts[toolIndex]) parts[toolIndex] = { ...parts[toolIndex], state: "output-error", errorText: String(chunk.errorText || "执行失败") }; break;
    case "tool-output-denied": if (parts[toolIndex]) parts[toolIndex] = { ...parts[toolIndex], state: "output-denied" }; break;
    case "start-step": parts.push({ type: "step-start" }); break;
    case "message-metadata": if (chunk.messageMetadata !== undefined) message.metadata = chunk.messageMetadata; break;
    case "error": parts.push({ type: "data-error", data: { message: String(chunk.errorText || "生成失败") } }); break;
    default:
      if (typeof chunk.type === "string" && chunk.type.startsWith("data-") && !chunk.transient) {
        const partIndex = chunk.id ? parts.findIndex((part) => part.type === chunk.type && part.id === chunk.id) : -1;
        const part = copyPart(chunk, ["type", "id", "data"]);
        if (partIndex >= 0) parts[partIndex] = part; else parts.push(part);
      }
  }
  return next;
}

export function resetAssistantForReplay(messages: ChatMessage[], messageId: string) {
  return messages.map((message) => message.id === messageId ? { ...message, parts: [] } : message);
}

/**
 * Raw `tool-input-delta` text is accumulated out-of-band: it is only ever needed to build
 * the partially-parsed `input`, and keeping it on the part meant every streamed tool
 * argument stayed in memory — and got serialized into session storage — for the whole
 * conversation. A WeakMap lets the buffer die with the part.
 */
const rawToolInputs = new WeakMap<ChatPart, string>();

/** Hard ceiling on a partially-buffered tool input; the authoritative value arrives with `tool-input-available`. */
const MAX_RAW_TOOL_INPUT_LENGTH = 256 * 1024;

function partInputBuffer(part: ChatPart) { return rawToolInputs.get(part) || ""; }
function bufferInput(part: ChatPart, raw: string) {
  rawToolInputs.set(part, raw.length > MAX_RAW_TOOL_INPUT_LENGTH ? raw.slice(0, MAX_RAW_TOOL_INPUT_LENGTH) : raw);
}
function isInputBufferFull(part: ChatPart) { return partInputBuffer(part).length >= MAX_RAW_TOOL_INPUT_LENGTH; }

/** Finds the tool part for a chunk, creating a streaming placeholder when deltas arrive first. */
function ensureToolPart(parts: ChatPart[], chunk: Chunk) {
  const toolCallId = String(chunk.toolCallId || "");
  const existing = parts.find((candidate) => candidate.toolCallId === toolCallId);
  if (existing) return existing;
  const toolName = String(chunk.toolName || "tool");
  const created: ChatPart = { type: chunk.dynamic ? "dynamic-tool" : `tool-${toolName}`, toolName, toolCallId, state: "input-streaming" };
  parts.push(created);
  return created;
}

function asChunk(value: unknown): Chunk | undefined {  if (value && typeof value === "object" && !Array.isArray(value)) return value as Chunk;
  if (typeof value !== "string") return undefined;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : undefined; } catch { return undefined; }
}
function latestAssistant(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return -1;
    if (messages[index].role === "assistant") return index;
  }
  return -1;
}
function mutateText(parts: ChatPart[], type: string, id: string, delta: string) {
  const index = parts.findIndex((candidate) => candidate.type === type && candidate.id === id);
  const part = parts[index];
  if (!part) parts.push({ id, type, text: delta, state: "streaming" });
  else parts[index] = { ...part, text: `${part.text || ""}${delta}` };
}
function finishText(parts: ChatPart[], type: string, id: string) { const index = parts.findIndex((candidate) => candidate.type === type && candidate.id === id); if (index >= 0) parts[index] = { ...parts[index], state: "done" }; }
function upsertTool(parts: ChatPart[], chunk: Chunk, state: string) {
  const toolCallId = String(chunk.toolCallId || "");
  const index = parts.findIndex((candidate) => candidate.toolCallId === toolCallId);
  const part = parts[index];
  const toolName = String(chunk.toolName || part?.toolName || "tool");
  const value: ChatPart = { ...(part || {}), type: chunk.dynamic ? "dynamic-tool" : `tool-${toolName}`, toolName, toolCallId, state, ...(chunk.input === undefined ? {} : { input: chunk.input }), ...(chunk.errorText === undefined ? {} : { errorText: String(chunk.errorText) }), ...(chunk.title === undefined ? {} : { title: String(chunk.title) }) };
  if (index >= 0) parts[index] = value; else parts.push(value);
}
function partialJson(value: string) { try { return JSON.parse(value); } catch { return value; } }
function copyPart(source: Chunk, keys: string[]) { return Object.fromEntries(keys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])) as ChatPart; }
