import { MessageType } from "@cloudflare/ai-chat/types";
import type { UIMessage } from "ai";
import {
  WORKSPACE_MATE_ENVIRONMENT_ACCEPTED_SCHEMA_VERSION,
  type WorkspaceAcceptedMateEnvironment
} from "../../../sdk/mate/environment.ts";
import {
  MATE_CHAT_GRANT_AUDIENCE,
  MATE_CHAT_GRANT_VERSION,
  type MateChatGrantClaims
} from "./chatGrant.ts";
import { chatProjectionIds, digestChatMessage } from "./chatTaskStorage.ts";
import { RuntimeHttpError } from "./types.ts";

export const MATE_CHAT_CONNECTION_STATE_VERSION = "workspace.mate-chat-connection/v1" as const;
export const MATE_CHAT_RECOVERY_CONTEXT_VERSION = "workspace.mate-chat-recovery/v2" as const;

const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/;
const MAX_PROTOCOL_FRAME_CHARACTERS = 4_000_000;
const MAX_USER_FILES = 5;
const MAX_USER_TEXT_CHARACTERS = 12_000;
const GRANT_SCOPES = new Set(["mate:*", "mate:invoke"]);
const PASSTHROUGH_TYPES = new Set<string>([
  MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
  MessageType.CF_AGENT_STREAM_RESUME_ACK,
  MessageType.CF_AGENT_STREAM_RESUME_REQUEST
]);

type ChatRequestFrame = {
  id: string;
  type: typeof MessageType.CF_AGENT_USE_CHAT_REQUEST;
  init: {
    body: string;
    method: "POST";
  };
};

export type ParsedMateChatRequest = {
  chatGrant: string;
  continuationMessageId?: string;
  environment: unknown;
  id: string;
  selection?: MateChatCapabilitySelection;
  userMessage: UIMessage;
};

export type MateChatCapabilitySelection = {
  appIds?: string[];
  knowledgeServiceIds?: string[];
  modelId?: string;
};

export type MateChatProtocolDecision =
  | { kind: "passthrough" }
  | { kind: "request"; request: ParsedMateChatRequest };

export type MateChatConnectionState = {
  workspaceMateChat: {
    claims: MateChatGrantClaims;
    schemaVersion: typeof MATE_CHAT_CONNECTION_STATE_VERSION;
  };
};

export type MateChatTurnBinding = {
  environment: WorkspaceAcceptedMateEnvironment;
  continuationMessageId?: string;
  messageDigest: string;
  selection?: MateChatCapabilitySelection;
  startedAt?: string;
  taskId: string;
  turnId: string;
  userMessageId: string;
};

export type MateChatRecoveryContext = {
  claims: MateChatGrantClaims;
  schemaVersion: typeof MATE_CHAT_RECOVERY_CONTEXT_VERSION;
  turn: MateChatTurnBinding;
};

/**
 * Strictly admits only the protocol needed by the v3 SDK Host. Transcript
 * mutation, tool and unknown Agent frames fail closed before AIChatAgent sees
 * them. A submit may add exactly one user message to the server transcript.
 */
export function parseMateChatProtocolMessage(
  message: unknown,
  currentMessages: UIMessage[]
): MateChatProtocolDecision {
  if (typeof message !== "string" || message.length > MAX_PROTOCOL_FRAME_CHARACTERS) {
    throw new RuntimeHttpError(400, "mate_chat_protocol_frame_invalid");
  }
  const wire = parseRecord(message, "mate_chat_protocol_frame_invalid");
  if (PASSTHROUGH_TYPES.has(text(wire.type))) return { kind: "passthrough" };
  if (wire.type !== MessageType.CF_AGENT_USE_CHAT_REQUEST) {
    throw new RuntimeHttpError(403, "mate_chat_protocol_operation_forbidden");
  }
  const id = boundedId(wire.id, "mate_chat_request_id_invalid");
  const init = record(wire.init, "mate_chat_request_invalid");
  if (init.method !== "POST" || typeof init.body !== "string") {
    throw new RuntimeHttpError(400, "mate_chat_request_invalid");
  }
  const body = parseRecord(init.body, "mate_chat_request_body_invalid");
  assertKnownKeys(body, ["chatGrant", "clientTools", "continuationMessageId", "environment", "messages", "selection", "transcriptMode", "trigger"]);
  if (body.trigger !== "submit-message") {
    throw new RuntimeHttpError(422, "mate_chat_trigger_unsupported");
  }
  if (body.clientTools !== undefined && (!Array.isArray(body.clientTools) || body.clientTools.length > 0)) {
    throw new RuntimeHttpError(422, "mate_chat_client_tools_unsupported");
  }
  const chatGrant = typeof body.chatGrant === "string" ? body.chatGrant : "";
  if (!chatGrant || chatGrant.length > 8_192) {
    throw new RuntimeHttpError(401, "mate_chat_grant_invalid");
  }
  if (!Object.hasOwn(body, "environment")) {
    throw new RuntimeHttpError(422, "mate_chat_environment_required");
  }
  if (!Array.isArray(body.messages)) {
    throw new RuntimeHttpError(400, "mate_chat_messages_invalid");
  }
  if (body.transcriptMode === "server") {
    if (body.messages.length !== 1) throw new RuntimeHttpError(409, "mate_chat_transcript_not_append_only");
  } else {
    if (body.transcriptMode !== undefined) throw new RuntimeHttpError(400, "mate_chat_messages_invalid");
    if (body.messages.length !== currentMessages.length + 1) throw new RuntimeHttpError(409, "mate_chat_transcript_not_append_only");
    for (let index = 0; index < currentMessages.length; index += 1) {
      const incoming = record(body.messages[index], "mate_chat_messages_invalid");
      if (incoming.id !== currentMessages[index]?.id) throw new RuntimeHttpError(409, "mate_chat_transcript_not_append_only");
    }
  }
  const continuationMessageId = body.continuationMessageId === undefined ? undefined : boundedId(body.continuationMessageId, "mate_chat_continuation_invalid");
  const userMessage = sanitizeUserMessage(body.messages.at(-1), currentMessages);
  const selection = body.selection === undefined
    ? undefined
    : mateChatCapabilitySelection(body.selection, "mate_chat_capability_selection_invalid");
  return {
    kind: "request",
    request: { chatGrant, ...(continuationMessageId ? { continuationMessageId } : {}), environment: body.environment, id, ...(selection ? { selection } : {}), userMessage }
  };
}

/** Rebuilds the upstream request so neither the raw Grant nor client copies of
 * existing messages can reach AIChatAgent persistence. */
export function sanitizedMateChatRequestFrame(
  request: ParsedMateChatRequest,
  currentMessages: UIMessage[],
  claims: MateChatGrantClaims,
  turn: MateChatTurnBinding
) {
  const recovery = mateChatRecoveryContext(claims, turn);
  const frame: ChatRequestFrame = {
    id: request.id,
    init: {
      body: JSON.stringify({
        messages: [...currentMessages, request.userMessage],
        recovery,
        trigger: "submit-message"
      }),
      method: "POST"
    },
    type: MessageType.CF_AGENT_USE_CHAT_REQUEST
  };
  return JSON.stringify(frame);
}

/** Builds an immutable, server-owned identity for one accepted submit. */
export async function mateChatTurnBinding(
  request: ParsedMateChatRequest,
  environment: WorkspaceAcceptedMateEnvironment,
  claims: MateChatGrantClaims
): Promise<MateChatTurnBinding> {
  const messageDigest = await digestChatMessage(mateChatUserMessageDigestInput(request.userMessage));
  const { taskId } = await chatProjectionIds({
    clientMessageId: request.userMessage.id,
    conversationId: claims.conversationId,
    mode: claims.mode,
    releaseId: claims.releaseId,
    mateId: claims.mateId,
    userId: claims.userId
  });
  return {
    environment,
    ...(request.continuationMessageId ? { continuationMessageId: request.continuationMessageId } : {}),
    messageDigest,
    ...(request.selection ? { selection: request.selection } : {}),
    startedAt: new Date().toISOString(),
    taskId,
    turnId: taskId.replace(/^task_chat_/, "turn_chat_"),
    userMessageId: request.userMessage.id
  };
}

export function mateChatConnectionState(claims: MateChatGrantClaims): MateChatConnectionState {
  return {
    workspaceMateChat: {
      claims: copyClaims(claims),
      schemaVersion: MATE_CHAT_CONNECTION_STATE_VERSION
    }
  };
}

export function mateChatClaimsFromConnectionState(value: unknown, expectedInstanceName: string) {
  const source = record(value, "mate_chat_connection_unauthorized");
  const state = record(source.workspaceMateChat, "mate_chat_connection_unauthorized");
  if (state.schemaVersion !== MATE_CHAT_CONNECTION_STATE_VERSION) {
    throw new RuntimeHttpError(401, "mate_chat_connection_unauthorized");
  }
  return mateChatClaims(state.claims, expectedInstanceName, "mate_chat_connection_unauthorized");
}

export function mateChatRecoveryContext(
  claims: MateChatGrantClaims,
  turn: MateChatTurnBinding
): MateChatRecoveryContext {
  return {
    claims: copyClaims(claims),
    schemaVersion: MATE_CHAT_RECOVERY_CONTEXT_VERSION,
    turn: copyTurn(turn)
  };
}

/** Reads only a server-injected, schema-closed recovery binding. Expiry is not
 * re-evaluated: it authorizes replay of the original turn, while downstream
 * resources still enforce the invoking user's current access. */
export function mateChatClaimsFromRecovery(value: unknown, expectedInstanceName: string) {
  return mateChatBindingFromRecovery(value, expectedInstanceName).claims;
}

export function mateChatBindingFromRecovery(
  value: unknown,
  expectedInstanceName: string
): MateChatRecoveryContext {
  const source = record(value, "mate_chat_recovery_context_invalid");
  assertExactKeys(source, ["claims", "schemaVersion", "turn"], "mate_chat_recovery_context_invalid");
  if (source.schemaVersion !== MATE_CHAT_RECOVERY_CONTEXT_VERSION) {
    throw new RuntimeHttpError(401, "mate_chat_recovery_context_invalid");
  }
  return {
    claims: mateChatClaims(source.claims, expectedInstanceName, "mate_chat_recovery_context_invalid"),
    schemaVersion: MATE_CHAT_RECOVERY_CONTEXT_VERSION,
    turn: mateChatBoundTurn(source.turn)
  };
}

function mateChatClaims(value: unknown, expectedInstanceName: string, code: string) {
  const claimsSource = record(value, code);
  const optionalKeys = new Set(["departmentId", "departmentPath"]);
  const requiredKeys = [
    "aud", "callerKind", "conversationId", "exp", "iat", "instanceName", "jti", "mode",
    "orgId", "releaseId", "scopes", "mateId", "userId", "version"
  ];
  if (
    requiredKeys.some((key) => !Object.hasOwn(claimsSource, key))
    || Object.keys(claimsSource).some((key) => !requiredKeys.includes(key) && !optionalKeys.has(key))
  ) throw new RuntimeHttpError(401, code);

  const instanceName = boundedText(claimsSource.instanceName, 128);
  const departmentId = claimsSource.departmentId === undefined
    ? undefined
    : boundedText(claimsSource.departmentId, 180);
  const departmentPath = claimsSource.departmentPath === undefined
    ? undefined
    : boundedTextArray(claimsSource.departmentPath, 16, 180);
  const scopes = boundedTextArray(claimsSource.scopes, 2, 64);
  if (
    claimsSource.aud !== MATE_CHAT_GRANT_AUDIENCE
    || claimsSource.callerKind !== "user"
    || (claimsSource.mode !== "live" && claimsSource.mode !== "preview")
    || claimsSource.version !== MATE_CHAT_GRANT_VERSION
    || instanceName !== expectedInstanceName
    || scopes.length < 1
    || scopes.some((scope) => !GRANT_SCOPES.has(scope))
    || !safeEpoch(claimsSource.iat)
    || !safeEpoch(claimsSource.exp)
  ) throw new RuntimeHttpError(401, code);

  return {
    aud: MATE_CHAT_GRANT_AUDIENCE,
    callerKind: "user",
    conversationId: boundedText(claimsSource.conversationId, 180),
    ...(departmentId ? { departmentId } : {}),
    ...(departmentPath ? { departmentPath } : {}),
    exp: Number(claimsSource.exp),
    iat: Number(claimsSource.iat),
    instanceName,
    jti: boundedText(claimsSource.jti, 180),
    mode: claimsSource.mode,
    orgId: boundedText(claimsSource.orgId, 180),
    releaseId: boundedText(claimsSource.releaseId, 180),
    scopes: scopes as MateChatGrantClaims["scopes"],
    mateId: boundedText(claimsSource.mateId, 180),
    userId: boundedText(claimsSource.userId, 180),
    version: MATE_CHAT_GRANT_VERSION
  } satisfies MateChatGrantClaims;
}

function mateChatBoundTurn(value: unknown): MateChatTurnBinding {
  const source = record(value, "mate_chat_recovery_context_invalid");
  const turnKeys = ["environment", "messageDigest", "taskId", "turnId", "userMessageId"];
  if (Object.hasOwn(source, "selection")) turnKeys.push("selection");
  if (Object.hasOwn(source, "startedAt")) turnKeys.push("startedAt");
  if (Object.hasOwn(source, "continuationMessageId")) turnKeys.push("continuationMessageId");
  assertExactKeys(source, turnKeys, "mate_chat_recovery_context_invalid");
  const environment = record(source.environment, "mate_chat_recovery_context_invalid");
  assertExactKeys(
    environment,
    ["context", "digest", "schemaVersion", "trust"],
    "mate_chat_recovery_context_invalid"
  );
  const digest = boundedDigest(environment.digest);
  if (
    environment.schemaVersion !== WORKSPACE_MATE_ENVIRONMENT_ACCEPTED_SCHEMA_VERSION
    || environment.trust !== "host_asserted"
    || !environment.context
    || typeof environment.context !== "object"
    || Array.isArray(environment.context)
  ) throw new RuntimeHttpError(401, "mate_chat_recovery_context_invalid");
  const taskId = boundedId(source.taskId, "mate_chat_recovery_context_invalid");
  const turnId = boundedId(source.turnId, "mate_chat_recovery_context_invalid");
  if (!taskId.startsWith("task_chat_") || turnId !== taskId.replace(/^task_chat_/, "turn_chat_")) {
    throw new RuntimeHttpError(401, "mate_chat_recovery_context_invalid");
  }
  return {
    environment: {
      context: environment.context as WorkspaceAcceptedMateEnvironment["context"],
      digest,
      schemaVersion: WORKSPACE_MATE_ENVIRONMENT_ACCEPTED_SCHEMA_VERSION,
      trust: "host_asserted"
    },
    ...(source.continuationMessageId === undefined ? {} : { continuationMessageId: boundedId(source.continuationMessageId, "mate_chat_recovery_context_invalid") }),
    messageDigest: boundedDigest(source.messageDigest),
    ...(source.selection === undefined ? {} : {
      selection: mateChatCapabilitySelection(source.selection, "mate_chat_recovery_context_invalid")
    }),
    ...(source.startedAt === undefined ? {} : {
      startedAt: boundedIsoTimestamp(source.startedAt, "mate_chat_recovery_context_invalid")
    }),
    taskId,
    turnId,
    userMessageId: boundedId(source.userMessageId, "mate_chat_recovery_context_invalid")
  };
}

function boundedIsoTimestamp(value: unknown, code: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new RuntimeHttpError(401, code);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RuntimeHttpError(401, code);
  }
  return value;
}

export function mateChatCapabilitySelection(value: unknown, code = "mate_chat_capability_selection_invalid") {
  const source = record(value, code);
  assertExactOptionalKeys(source, ["appIds", "knowledgeServiceIds", "modelId"], code);
  const appIds = boundedSelectionIds(source.appIds, 32, code);
  const knowledgeServiceIds = boundedSelectionIds(source.knowledgeServiceIds, 12, code);
  const modelId = source.modelId === undefined ? undefined : boundedSelectionId(source.modelId, code);
  return {
    ...(appIds ? { appIds } : {}),
    ...(knowledgeServiceIds ? { knowledgeServiceIds } : {}),
    ...(modelId ? { modelId } : {})
  } satisfies MateChatCapabilitySelection;
}

export function assertMateChatGrantMatchesConnection(
  bootstrap: MateChatGrantClaims,
  turn: MateChatGrantClaims
) {
  if (
    bootstrap.instanceName !== turn.instanceName
    || bootstrap.mateId !== turn.mateId
    || bootstrap.conversationId !== turn.conversationId
    || bootstrap.userId !== turn.userId
    || bootstrap.orgId !== turn.orgId
    || bootstrap.mode !== turn.mode
    || (bootstrap.mode === "preview" && bootstrap.releaseId !== turn.releaseId)
  ) throw new RuntimeHttpError(401, "mate_chat_grant_binding_changed");
}

export function assertMateChatFrameworkAppend(
  currentMessages: UIMessage[],
  incomingMessages: UIMessage[]
) {
  if (
    incomingMessages.length !== currentMessages.length + 1
    || !currentMessages.every((message, index) => incomingMessages[index]?.id === message.id)
    || incomingMessages.at(-1)?.role !== "user"
  ) throw new RuntimeHttpError(409, "mate_chat_transcript_not_append_only");
}

function sanitizeUserMessage(value: unknown, currentMessages: UIMessage[]): UIMessage {
  const message = record(value, "mate_chat_messages_invalid");
  const id = boundedId(message.id, "mate_chat_message_id_invalid");
  if (message.role !== "user" || currentMessages.some((candidate) => candidate.id === id)) {
    throw new RuntimeHttpError(409, "mate_chat_transcript_not_append_only");
  }
  if (!Array.isArray(message.parts) || message.parts.length < 1 || message.parts.length > 16) {
    throw new RuntimeHttpError(422, "mate_chat_message_parts_invalid");
  }
  let fileCount = 0;
  const parts = message.parts.map((part) => {
    const source = record(part, "mate_chat_message_parts_invalid");
    if (source.type === "text" && typeof source.text === "string") {
      return { text: source.text, type: "text" as const };
    }
    if (source.type === "file") {
      fileCount += 1;
      if (fileCount > MAX_USER_FILES) throw new RuntimeHttpError(422, "mate_chat_message_files_invalid");
      const filename = boundedFileName(source.filename);
      const mediaType = boundedMediaType(source.mediaType);
      const url = boundedWorkspaceFileUrl(source.url);
      return { filename, mediaType, type: "file" as const, url };
    }
    throw new RuntimeHttpError(422, "mate_chat_message_parts_unsupported");
  });
  const content = parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
  if (!content) throw new RuntimeHttpError(422, "mate_chat_message_text_required");
  if (content.length > MAX_USER_TEXT_CHARACTERS) {
    throw new RuntimeHttpError(413, "mate_chat_message_too_large");
  }
  const files = parts.filter((part): part is Extract<(typeof parts)[number], { type: "file" }> => part.type === "file");
  return { id, parts: [{ text: content, type: "text" }, ...files], role: "user" };
}

function copyClaims(claims: MateChatGrantClaims): MateChatGrantClaims {
  return {
    aud: claims.aud,
    callerKind: claims.callerKind,
    conversationId: claims.conversationId,
    ...(claims.departmentId ? { departmentId: claims.departmentId } : {}),
    ...(claims.departmentPath ? { departmentPath: [...claims.departmentPath] } : {}),
    exp: claims.exp,
    iat: claims.iat,
    instanceName: claims.instanceName,
    jti: claims.jti,
    mode: claims.mode,
    orgId: claims.orgId,
    releaseId: claims.releaseId,
    scopes: [...claims.scopes],
    mateId: claims.mateId,
    userId: claims.userId,
    version: claims.version
  };
}

function copyTurn(turn: MateChatTurnBinding): MateChatTurnBinding {
  return JSON.parse(JSON.stringify(turn)) as MateChatTurnBinding;
}

export function mateChatUserMessageDigestInput(message: UIMessage) {
  return message.parts.flatMap((part) => {
    if (part.type === "text" && typeof part.text === "string") return [`text:${part.text.trim()}`];
    if (part.type === "file") {
      const source = part as Record<string, unknown>;
      return [`file:${text(source.filename)}\u0000${text(source.mediaType)}\u0000${text(source.url)}`];
    }
    return [];
  }).join("\n");
}

function boundedFileName(value: unknown) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 180 || /[\u0000-\u001f\u007f/\\]/.test(value)) {
    throw new RuntimeHttpError(422, "mate_chat_message_files_invalid");
  }
  return value;
}

function boundedMediaType(value: unknown) {
  if (typeof value !== "string" || value !== value.trim().toLowerCase() || !/^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/i.test(value)) {
    throw new RuntimeHttpError(422, "mate_chat_message_files_invalid");
  }
  return value;
}

function boundedWorkspaceFileUrl(value: unknown) {
  if (typeof value !== "string" || !/^\/api\/workspace-files\/[A-Za-z0-9_.%-]{1,540}\/raw$/.test(value)) {
    throw new RuntimeHttpError(422, "mate_chat_message_files_invalid");
  }
  try {
    const match = value.match(/^\/api\/workspace-files\/([^/]+)\/raw$/);
    const objectId = decodeURIComponent(match?.[1] || "");
    if (!/^[A-Za-z0-9_.-]{1,180}$/.test(objectId)) throw new Error();
    return `/api/workspace-files/${encodeURIComponent(objectId)}/raw`;
  } catch {
    throw new RuntimeHttpError(422, "mate_chat_message_files_invalid");
  }
}

function parseRecord(value: string, code: string) {
  try { return record(JSON.parse(value) as unknown, code); }
  catch (error) {
    if (error instanceof RuntimeHttpError) throw error;
    throw new RuntimeHttpError(400, code);
  }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeHttpError(400, code);
  return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new RuntimeHttpError(422, "mate_chat_request_body_field_unknown");
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], code: string) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new RuntimeHttpError(401, code);
  }
}

function assertExactOptionalKeys(value: Record<string, unknown>, keys: string[], code: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new RuntimeHttpError(422, code);
}

function boundedSelectionIds(value: unknown, maximumItems: number, code: string) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems) throw new RuntimeHttpError(422, code);
  const result = value.map((item) => boundedSelectionId(item, code));
  if (new Set(result).size !== result.length) throw new RuntimeHttpError(422, code);
  return result;
}

function boundedSelectionId(value: unknown, code: string) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > 180
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new RuntimeHttpError(422, code);
  return value;
}

function boundedId(value: unknown, code: string) {
  if (typeof value !== "string" || !CHAT_ID.test(value)) throw new RuntimeHttpError(422, code);
  return value;
}

function boundedDigest(value: unknown) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new RuntimeHttpError(401, "mate_chat_recovery_context_invalid");
  }
  return value;
}

function boundedText(value: unknown, maximum: number) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new RuntimeHttpError(401, "mate_chat_recovery_context_invalid");
  return value;
}

function boundedTextArray(value: unknown, maximumItems: number, maximumText: number) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new RuntimeHttpError(401, "mate_chat_recovery_context_invalid");
  }
  const result = value.map((item) => boundedText(item, maximumText));
  if (new Set(result).size !== result.length) {
    throw new RuntimeHttpError(401, "mate_chat_recovery_context_invalid");
  }
  return result;
}

function safeEpoch(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}
