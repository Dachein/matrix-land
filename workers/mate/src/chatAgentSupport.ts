import { createUIMessageStream, createUIMessageStreamResponse, type StreamTextResult, type ToolSet, type UIMessage } from "ai";
import { chatExecutionState, type ChatExecutionState, type ChatPauseReason } from "./chatExecution.ts";
import { chatToolPreview } from "../../../src/shared/chatToolPreview.ts";
import type { KnowledgeConversationMessage } from "./knowledgeExecutor.ts";
import type { MateChatGrantClaims } from "./chatGrant.ts";
import { RuntimeHttpError, type RuntimePrincipal } from "./types.ts";

const CHAT_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/;
const MAX_CHAT_MESSAGE_CHARACTERS = 12_000;
const MAX_CONVERSATION_CHARACTERS = 12_000;
const MAX_CONVERSATION_MESSAGES = 12;
export const MATE_CHAT_TERMINAL_MARKER_VERSION = "workspace.mate-conversation-turn/v1" as const;
export const MATE_PROCESS_VERSION = "workspace.mate-process/v1" as const;

type MessageLike = {
  id?: unknown;
  parts?: unknown;
  role?: unknown;
};

export type MateChatUserTurn = {
  id: string;
  text: string;
};

export type MateChatResolution = {
  answer: string;
  artifacts: unknown[];
  errorCode?: string;
  execution?: ChatExecutionState;
  followUps: string[];
  outcome: "completed" | "failed";
};

export function chatPrincipalFromGrant(claims: MateChatGrantClaims): RuntimePrincipal {
  return {
    callerKind: "user",
    ...(claims.departmentId ? { departmentId: claims.departmentId } : {}),
    ...(claims.departmentPath ? { departmentPath: claims.departmentPath } : {}),
    orgId: claims.orgId,
    scopes: [...claims.scopes],
    ...(claims.mode === "preview" ? {
      testGrant: { releaseId: claims.releaseId, mateId: claims.mateId }
    } : {}),
    userId: claims.userId
  };
}

export function latestMateChatUserTurn(messages: MessageLike[]): MateChatUserTurn {
  const message = [...messages].reverse().find((candidate) => candidate.role === "user");
  return mateChatUserTurn(messages, message?.id);
}

export function mateChatUserTurn(
  messages: MessageLike[],
  expectedMessageId: unknown
): MateChatUserTurn {
  const message = messages.find((candidate) => candidate.id === expectedMessageId && candidate.role === "user");
  const id = typeof message?.id === "string" ? message.id : "";
  if (!CHAT_MESSAGE_ID.test(id)) throw new RuntimeHttpError(422, "mate_chat_message_id_invalid");
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const text = parts.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const value = part as Record<string, unknown>;
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("\n").trim();
  if (!text) throw new RuntimeHttpError(422, "mate_chat_message_text_required");
  if (text.length > MAX_CHAT_MESSAGE_CHARACTERS) {
    throw new RuntimeHttpError(413, "mate_chat_message_too_large");
  }
  return { id, text };
}

export function mateRoleConversation(
  messages: MessageLike[],
  currentUserMessageId: string,
  releaseId: string
): KnowledgeConversationMessage[] {
  const completedPairs: Array<{
    assistant: KnowledgeConversationMessage;
    user: KnowledgeConversationMessage;
  }> = [];
  let pendingUser: KnowledgeConversationMessage | undefined;

  for (const message of messages) {
    if (message.role === "user") {
      pendingUser = message.id === currentUserMessageId
        ? undefined
        : conversationMessage(message, "user");
      continue;
    }
    if (message.role !== "assistant") continue;

    const user = pendingUser;
    pendingUser = undefined;
    const assistant = conversationMessage(message, "assistant");
    if (!user || !assistant || !isCompletedAssistantForRelease(message, releaseId)) continue;
    completedPairs.push({ assistant, user });
  }

  let remaining = MAX_CONVERSATION_CHARACTERS;
  const recent: KnowledgeConversationMessage[] = [];
  for (const pair of completedPairs.reverse()) {
    if (recent.length + 2 > MAX_CONVERSATION_MESSAGES || remaining < 2) break;
    const bounded = boundedConversationPair(pair, remaining);
    if (!bounded) break;
    remaining -= bounded.user.content.length + bounded.assistant.content.length;
    recent.unshift(bounded.user, bounded.assistant);
  }
  return recent;
}

/** Compatibility export for older integrations and persisted v1 transcripts. */
export const mateKnowledgeConversation = mateRoleConversation;

/** Only persisted user attachments from completed turns in this release are eligible. */
export function mateRoleAttachmentMessages(
  messages: UIMessage[], currentUserMessageId: string, releaseId: string
): UIMessage[] {
  const completed: UIMessage[] = [];
  let pending: UIMessage | undefined;
  for (const message of messages) {
    if (message.id === currentUserMessageId) break;
    if (message.role === "user") { pending = message; continue; }
    if (message.role !== "assistant") continue;
    const user = pending;
    pending = undefined;
    if (!user || !isCompletedAssistantForRelease(message, releaseId)) continue;
    // Historical inline images are not reloaded or sent to the model automatically.
    const parts = user.parts.filter((part) => part.type === "file" && !part.url.startsWith("data:")).slice(0, 5);
    if (parts.length) completed.push({ id: user.id, role: "user", parts });
  }
  return completed.slice(-6);
}

export function metadataOnlyChatConclusion(
  resolution: MateChatResolution,
  input: { assistantMessageId: string; responseDigest?: string }
) {
  return {
    artifacts: [
      ...resolution.artifacts,
      {
        ...(input.responseDigest ? { digest: input.responseDigest } : {}),
        messageId: input.assistantMessageId,
        type: "agent_do_message"
      }
    ],
    ...(resolution.errorCode ? { errorCode: resolution.errorCode } : {}),
    ...(resolution.execution ? { execution: resolution.execution } : {}),
    followUps: [],
    outcome: resolution.outcome,
    summary: resolution.outcome === "completed"
      ? "Agent DO response completed."
      : "Agent DO response failed."
  };
}

export function mateChatAssistantMessageId(turnId: string) {
  const suffix = turnId.startsWith("turn_chat_")
    ? turnId.slice("turn_chat_".length)
    : turnId.startsWith("task_chat_")
      ? turnId.slice("task_chat_".length)
      : turnId;
  if (!/^[A-Za-z0-9_.:-]{8,180}$/.test(suffix)) {
    throw new RuntimeHttpError(500, "mate_chat_turn_id_invalid");
  }
  return `assistant-${suffix}`;
}

export function resolvedMateChatResponse(
  resolution: MateChatResolution,
  input: {
    assistantMessageId: string;
    releaseId: string;
    responseDigest?: string;
    startedAt: string;
    turnId: string;
  }
) {
  const textPartId = `text-${input.assistantMessageId}`;
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "start", messageId: input.assistantMessageId });
      writer.write(mateProcessPart(input.turnId, input.startedAt, "running"));
      writer.write({ type: "start-step" });
      writer.write({ type: "text-start", id: textPartId });
      for (const delta of textChunks(resolution.answer)) {
        writer.write({ type: "text-delta", id: textPartId, delta });
      }
      writer.write({ type: "text-end", id: textPartId });
      if (resolution.artifacts.length > 0) {
        writer.write({
          type: "data-mate-citations",
          id: input.turnId,
          data: {
            sources: resolution.artifacts
          }
        });
      }
      writer.write({
        type: "data-mate-turn",
        id: input.turnId,
        data: {
          assistantMessageId: input.assistantMessageId,
          outcome: resolution.outcome,
          releaseId: input.releaseId,
          ...(input.responseDigest ? { responseDigest: input.responseDigest } : {}),
          schemaVersion: MATE_CHAT_TERMINAL_MARKER_VERSION,
          turnId: input.turnId
        }
      });
      writer.write(mateProcessPart(
        input.turnId,
        input.startedAt,
        resolution.outcome === "completed" ? "completed" : "failed",
        new Date().toISOString()
      ));
      writer.write({ type: "finish-step" });
      writer.write({ type: "finish", finishReason: resolution.outcome === "completed" ? "stop" : "error" });
    },
    onError: (error) => error instanceof RuntimeHttpError ? error.code : "mate_chat_response_stream_failed"
  });
  return createUIMessageStreamResponse({ stream });
}

/**
 * Merge a real AI SDK agent stream with the Runtime's terminal marker. The
 * pending D1 completion is stored only after the provider/tool stream has
 * finished its execution segment, and the marker is appended before AIChatAgent
 * persists the assistant message.
 */
export function streamedMateChatResponse(
  streamed: {
    artifacts: unknown[];
    result: StreamTextResult<ToolSet, any, any>;
    stopReason?: () => ChatPauseReason | undefined;
    emptyFinalRecovery?: () => ChatExecutionState["emptyFinalRecovery"];
  },
  input: {
    assistantMessageId: string;
    onComplete: (resolution: MateChatResolution) => Promise<unknown>;
    onFailure: (error: unknown) => Promise<"cancelled" | "failed">;
    releaseId: string;
    startedAt: string;
    turnId: string;
  }
) {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Bind progress and provider failures to the same persisted assistant.
      writer.write({ type: "start", messageId: input.assistantMessageId });
      writer.write(mateProcessPart(input.turnId, input.startedAt, "running"));
      const reader = streamed.result.toUIMessageStream({
        generateMessageId: () => input.assistantMessageId,
        onError: (error) => error instanceof RuntimeHttpError ? error.code : "mate_conversation_model_stream_failed",
        sendStart: false,
        sendFinish: false,
        sendReasoning: true,
        sendSources: true
      }).getReader();
      const metadata = Promise.all([streamed.result.text, streamed.result.finishReason, streamed.result.steps]).then((value) => ({ value }), (error: unknown) => ({ error }));
      let toolPreviewCharacters = 0;
      let answer: string;
      let execution: ChatExecutionState;
      try {
        let streamFailed = false;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const part = next.value;
          // Consumers stop reading at an error chunk. Persist/broadcast the
          // terminal process status first, then emit one sanitized error.
          if (part.type === "error") { streamFailed = true; continue; }
          if (part.type === "start") continue;
          if (part.type === "tool-output-available") {
            const allowance = Math.max(0, Math.min(16_000, 200_000 - toolPreviewCharacters));
            const output = chatToolPreview(part.output, allowance);
            writer.write({ ...part, output });
            toolPreviewCharacters += JSON.stringify(output).length;
          } else writer.write(part);
        }
        if (streamFailed) throw new RuntimeHttpError(502, "mate_conversation_model_stream_failed");
        const resultMetadata = await metadata;
        if ("error" in resultMetadata) throw resultMetadata.error;
        const [text, finishReason, steps] = resultMetadata.value;
        answer = String(text).trim();
        execution = chatExecutionState({ answer, finishReason: finishReason ?? "stop", steps: steps?.length ?? 0, stopReason: streamed.stopReason?.() });
        const recovery = streamed.emptyFinalRecovery?.();
        if (recovery) execution.emptyFinalRecovery = recovery;
      } catch (error) {
        const status = await input.onFailure(error);
        writer.write(mateProcessPart(input.turnId, input.startedAt, status, new Date().toISOString()));
        throw error;
      }
      const resolution: MateChatResolution = {
        answer,
        artifacts: deduplicatedArtifacts(streamed.artifacts),
        followUps: [],
        execution,
        // This terminal marker closes a persisted execution segment. Work may
        // be paused while the transport turn has completed successfully.
        outcome: "completed"
      };
      try {
        await input.onComplete(resolution);
      } catch (error) {
        const status = await input.onFailure(error);
        writer.write(mateProcessPart(input.turnId, input.startedAt, status, new Date().toISOString()));
        throw error;
      }
      if (resolution.artifacts.length > 0) {
        writer.write({
          type: "data-mate-citations",
          id: input.turnId,
          data: { sources: resolution.artifacts }
        });
      }
      writer.write({
        type: "data-mate-turn",
        id: input.turnId,
        data: {
          assistantMessageId: input.assistantMessageId,
          outcome: "completed",
          releaseId: input.releaseId,
          execution,
          schemaVersion: MATE_CHAT_TERMINAL_MARKER_VERSION,
          turnId: input.turnId
        }
      });
      writer.write(mateProcessPart(
        input.turnId,
        input.startedAt,
        execution.state === "paused" ? "paused" : "completed",
        new Date().toISOString()
      ));
      writer.write({ type: "finish", finishReason: "stop" });
    },
    onError: (error) => error instanceof RuntimeHttpError ? error.code : "mate_chat_response_stream_failed"
  });
  return createUIMessageStreamResponse({ stream });
}

function mateProcessPart(
  turnId: string,
  startedAt: string,
  status: "cancelled" | "completed" | "failed" | "paused" | "running",
  completedAt?: string
) {
  const startedMs = Date.parse(startedAt);
  const completedMs = completedAt ? Date.parse(completedAt) : undefined;
  const durationMs = completedMs === undefined || !Number.isFinite(startedMs) || !Number.isFinite(completedMs)
    ? undefined
    : Math.max(0, completedMs - startedMs);
  return {
    type: "data-mate-process" as const,
    id: `${turnId}:process`,
    data: {
      ...(completedAt ? { completedAt } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      schemaVersion: MATE_PROCESS_VERSION,
      startedAt,
      status,
      turnId
    }
  };
}

export function mateChatTerminalMarkerMatches(
  message: MessageLike,
  expected: {
    assistantMessageId: string;
    outcome: string;
    releaseId: string;
    responseDigest?: string;
    turnId: string;
  }
) {
  if (message.id !== expected.assistantMessageId || message.role !== "assistant" || !Array.isArray(message.parts)) {
    return false;
  }
  const markers = message.parts.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const source = part as Record<string, unknown>;
    if (source.type !== "data-mate-turn" || !source.data || typeof source.data !== "object" || Array.isArray(source.data)) {
      return [];
    }
    return [source.data as Record<string, unknown>];
  });
  if (markers.length !== 1) return false;
  const marker = markers[0];
  return marker?.schemaVersion === MATE_CHAT_TERMINAL_MARKER_VERSION
    && marker.assistantMessageId === expected.assistantMessageId
    && marker.outcome === expected.outcome
    && marker.releaseId === expected.releaseId
    && marker.turnId === expected.turnId;
}

export function mateChatCompletionRetryDelayMs(attempt: number) {
  const boundedAttempt = Math.max(1, Math.min(7, Math.floor(attempt)));
  return Math.min(5 * 60_000, 5_000 * (2 ** (boundedAttempt - 1)));
}

/**
 * Recovery can finish under a framework-generated request id while the outbox
 * still carries the recovery root id. Prefer the direct lookup, then fall back
 * to the bounded outbox window and the deterministic assistant message id. The
 * caller still verifies the persisted marker and its turn/release identity.
 */
export function mateChatCompletionRowsForResponse<
  Row extends { assistantMessageId: string }
>(
  directlyBound: Row[],
  boundedFallback: () => Row[],
  assistantMessageId: string
) {
  const direct = directlyBound.filter((row) => row.assistantMessageId === assistantMessageId);
  if (direct.length) return direct;
  return boundedFallback().filter((row) => row.assistantMessageId === assistantMessageId);
}

export function mateChatTaskConclusionMatches(
  task: unknown,
  expected: { conclusion: Record<string, unknown>; releaseId: string }
) {
  const source = recordValue(task);
  const conclusion = recordValue(source.conclusion);
  const outcome = typeof expected.conclusion.outcome === "string" ? expected.conclusion.outcome : "";
  if (
    source.releaseId !== expected.releaseId
    || source.status !== outcome
    || conclusion.outcome !== outcome
    || conclusion.summary !== expected.conclusion.summary
  ) return false;
  const expectedReference = agentDoReference(expected.conclusion.artifacts);
  if (!expectedReference) return true;
  const storedReference = agentDoReference(conclusion.artifacts);
  return Boolean(
    storedReference
    && storedReference.digest === expectedReference.digest
    && storedReference.messageId === expectedReference.messageId
  );
}

/** A protocol-native error stream. Unlike Response.json(), AIChatAgent will not
 * reinterpret an HTTP error document as assistant text. */
export function mateChatErrorResponse(code: string) {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "error", errorText: code });
    },
    onError: () => "mate_chat_error_stream_failed"
  });
  return createUIMessageStreamResponse({ stream });
}

function textChunks(value: string) {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += 512) chunks.push(value.slice(index, index + 512));
  return chunks.length ? chunks : [""];
}

function deduplicatedArtifacts(values: unknown[]) {
  const unique = new Map<string, unknown>();
  for (const value of values.slice(0, 64)) {
    const key = stableArtifactKey(value);
    if (!unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()];
}

function stableArtifactKey(value: unknown) {
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

function messageText(message: MessageLike) {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const value = part as Record<string, unknown>;
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("\n");
}

function conversationMessage(
  message: MessageLike,
  role: "assistant" | "user"
): KnowledgeConversationMessage | undefined {
  const content = messageText(message).trim();
  return content ? { content, role } : undefined;
}

function isCompletedAssistantForRelease(message: MessageLike, releaseId: string) {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.some((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return false;
    const value = part as Record<string, unknown>;
    if (
      value.type !== "data-mate-turn"
      && value.type !== "data-mate-task"
    ) return false;
    if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) {
      return false;
    }
    const data = value.data as Record<string, unknown>;
    return data.outcome === "completed" && data.releaseId === releaseId;
  });
}

function boundedConversationPair(
  pair: { assistant: KnowledgeConversationMessage; user: KnowledgeConversationMessage },
  budget: number
) {
  const total = pair.user.content.length + pair.assistant.content.length;
  if (total <= budget) return pair;

  const userBudget = Math.min(pair.user.content.length, Math.max(1, Math.floor(budget / 2)));
  const assistantBudget = Math.min(pair.assistant.content.length, Math.max(1, budget - userBudget));
  const unused = budget - userBudget - assistantBudget;
  const finalUserBudget = Math.min(pair.user.content.length, userBudget + unused);
  const finalAssistantBudget = Math.min(pair.assistant.content.length, budget - finalUserBudget);
  if (finalUserBudget <= 0 || finalAssistantBudget <= 0) return undefined;

  return {
    assistant: {
      content: pair.assistant.content.slice(-finalAssistantBudget),
      role: "assistant" as const
    },
    user: {
      content: pair.user.content.slice(-finalUserBudget),
      role: "user" as const
    }
  };
}

function agentDoReference(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const source = recordValue(item);
    if (
      source.type === "agent_do_message"
      && typeof source.digest === "string"
      && typeof source.messageId === "string"
    ) return { digest: source.digest, messageId: source.messageId };
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
