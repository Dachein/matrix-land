import {
  AIChatAgent,
  type ChatRecoveryContext,
  type ChatRecoveryExhaustedContext,
  type ChatResponseResult
} from "@cloudflare/ai-chat";
import { MessageType } from "@cloudflare/ai-chat/types";
import type { AgentContext, Connection, ConnectionContext, WSMessage } from "agents";
import type { UIMessage } from "ai";
import { CHAT_STREAM_STALL_MS, chatCheckpointChunks, chatToolOperationKey, executeChatToolOnce, parseChatCheckpoint, serializeChatCheckpoint, type ChatCheckpoint, type ChatToolRecord } from "./chatExecution.ts";
import { pinChatEnvironment, verifyPinnedChatEnvironment } from "./chatEnvironment.ts";
import { verifyMateChatGrant } from "./chatGrant.ts";
import {
  assertMateChatFrameworkAppend,
  assertMateChatGrantMatchesConnection,
  parseMateChatProtocolMessage,
  sanitizedMateChatRequestFrame,
  mateChatBindingFromRecovery,
  mateChatClaimsFromConnectionState,
  mateChatConnectionState,
  mateChatRecoveryContext,
  mateChatTurnBinding,
  mateChatUserMessageDigestInput,
  type MateChatRecoveryContext
} from "./chatAgentProtocol.ts";
import {
  chatPrincipalFromGrant,
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
  mateRoleConversation,
  mateRoleAttachmentMessages
} from "./chatAgentSupport.ts";
import { chatProjectionIds, digestChatMessage } from "./chatTaskStorage.ts";
import { createRoleConversationAgent } from "./conversationAgent.ts";
import {
  concludeChatTurnProjection,
  createChatTurnProjection,
  startChatTurnProjection
} from "./chatTurnStorage.ts";
import { loadRuntimeDefinition } from "./controlPlane.ts";
import { resolveRoleConversation } from "./roleConversation.ts";
import { concludeTask, readConversation, readTask } from "./storage.ts";
import { RuntimeHttpError, type RuntimeEnv, type RuntimeMode } from "./types.ts";

type EnvironmentPinRow = {
  digest: string;
  revision: number;
  sourceKey: string;
};

type PendingCompletionRow = {
  assistantMessageId: string;
  attempts: number;
  conclusionJson: string;
  createdAt: number;
  exhaustedAt: number | null;
  lastError: string | null;
  mode: RuntimeMode;
  nextRetryAt: number | null;
  releaseId: string;
  requestId: string;
  responseDigest: string;
  taskId: string;
  mateId: string;
  turnId: string;
  userId: string;
};

const PENDING_COMPLETION_TIMEOUT_MS = 15 * 60_000;
const COMPLETION_MAX_ATTEMPTS = 7;

type ActiveChatTurn = {
  mode: RuntimeMode;
  releaseId: string;
  taskId: string;
  mateId: string;
  turnId: string;
  userId: string;
};

type StoredTurnBindingRow = {
  recoveryJson: string;
  turnId: string;
};

export class MateChatAgent extends AIChatAgent<RuntimeEnv> {
  static override options = {
    hibernate: true,
    sendIdentityOnConnect: false
  };

  override maxPersistedMessages = undefined;
  override messageConcurrency = "drop" as const;
  override chatStreamStallTimeoutMs = CHAT_STREAM_STALL_MS;
  override chatRecovery = {
    maxAttempts: 3,
    maxOomRetries: 1,
    maxRecoveryWork: 32,
    noProgressTimeoutMs: CHAT_STREAM_STALL_MS,
    stableTimeoutMs: 15_000,
    terminalMessage: "This Mate turn was interrupted. Please send it again.",
    onExhausted: (context: ChatRecoveryExhaustedContext) => this.handleChatRecoveryExhausted(context)
  };

  private checkpointStorage: AgentContext["storage"];
  private protocolAdmissionTail: Promise<void> = Promise.resolve();
  private protocolRequestReservations = new Map<string, string>();

  constructor(ctx: AgentContext, env: RuntimeEnv) {
    super(ctx, env);
    this.checkpointStorage = ctx.storage;
    const frameworkOnMessage = this.onMessage.bind(this);
    this.onMessage = (connection, message) => this.handleProtocolMessage(
      frameworkOnMessage,
      connection,
      message
    );
  }

  override async onConnect(connection: Connection, context: ConnectionContext) {
    try {
      const token = new URL(context.request.url).searchParams.get("grant");
      const claims = await verifyMateChatGrant(token, chatGrantSecret(this.env));
      if (claims.instanceName !== this.name) throw new RuntimeHttpError(401, "mate_chat_grant_invalid");
      connection.setState(mateChatConnectionState(claims));
    } catch {
      connection.close(1008, "mate_chat_connection_unauthorized");
    }
  }

  private async handleProtocolMessage(
    frameworkOnMessage: (connection: Connection, message: WSMessage) => void | Promise<void>,
    connection: Connection,
    message: WSMessage
  ) {
    let requestId: string | undefined;
    let reservedTurnId: string | undefined;
    try {
      const decision = parseMateChatProtocolMessage(message, this.messages);
      const bootstrap = mateChatClaimsFromConnectionState(connection.state, this.name);
      if (decision.kind === "passthrough") return frameworkOnMessage(connection, message);
      requestId = decision.request.id;
      const claims = await verifyMateChatGrant(
        decision.request.chatGrant,
        chatGrantSecret(this.env),
        {
          conversationId: bootstrap.conversationId,
          mode: bootstrap.mode,
          mateId: bootstrap.mateId
        }
      );
      assertMateChatGrantMatchesConnection(bootstrap, claims);
      const turn = await this.admitProtocolTurn(decision.request, claims);
      reservedTurnId = turn.turnId;
      const sanitized = sanitizedMateChatRequestFrame(
        decision.request,
        this.messages,
        claims,
        turn
      );
      return await frameworkOnMessage(connection, sanitized);
    } catch (error) {
      const code = error instanceof RuntimeHttpError ? error.code : "mate_chat_protocol_error";
      if (requestId && code !== "mate_chat_grant_invalid" && code !== "mate_chat_grant_binding_changed") {
        try {
          connection.send(JSON.stringify({
            body: code,
            done: true,
            error: true,
            id: requestId,
            type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
          }));
          return;
        } catch { /* The close below is the final fail-closed path. */ }
      }
      connection.close(1008, code.slice(0, 120));
    } finally {
      if (requestId && reservedTurnId) this.releaseProtocolRequest(requestId, reservedTurnId);
    }
  }

  private async admitProtocolTurn(
    request: Parameters<typeof mateChatTurnBinding>[0],
    claims: Parameters<typeof mateChatTurnBinding>[2]
  ) {
    const admission = this.protocolAdmissionTail.then(async () => {
      const environment = await this.acceptEnvironment(request.environment, { persist: false });
      const turn = await mateChatTurnBinding(request, environment.envelope, claims);
      this.reserveProtocolRequest(request.id, turn.turnId);
      return turn;
    });
    this.protocolAdmissionTail = admission.then(() => undefined, () => undefined);
    return admission;
  }

  private reserveProtocolRequest(requestId: string, turnId: string) {
    this.ensureAgentTables();
    const inFlight = this.protocolRequestReservations.get(requestId);
    const stored = this.sql<{ turnId: string }>`
      SELECT turn_id AS turnId
      FROM workspace_mate_chat_turn_requests
      WHERE request_id = ${requestId}
      LIMIT 1
    `[0];
    if (inFlight || stored) {
      throw new RuntimeHttpError(409, "mate_chat_request_binding_conflict");
    }
    this.protocolRequestReservations.set(requestId, turnId);
  }

  private releaseProtocolRequest(requestId: string, turnId: string) {
    if (this.protocolRequestReservations.get(requestId) === turnId) {
      this.protocolRequestReservations.delete(requestId);
    }
  }

  override async onRequest(request: Request) {
    const url = new URL(request.url);
    if (url.pathname !== "/workspace-chat-history") return super.onRequest(request);
    const claims = await verifyMateChatGrant(url.searchParams.get("grant"), chatGrantSecret(this.env));
    if (claims.instanceName !== this.name) throw new RuntimeHttpError(401, "mate_chat_grant_invalid");
    const cursor = url.searchParams.get("cursor");
    const offset = cursor ? this.messages.findIndex((message) => message.id === cursor) + 1 : 0;
    if (cursor && !offset) throw new RuntimeHttpError(409, "mate_chat_history_cursor_invalid");
    const page: UIMessage[] = [];
    let size = 2;
    for (const message of this.messages.slice(offset, offset + 50)) {
      const bytes = JSON.stringify(message).length + 1;
      if (size + bytes > 3_900_000 && page.length) break;
      page.push(message);
      size += bytes;
    }
    const nextCursor = offset + page.length < this.messages.length ? page.at(-1)?.id : undefined;
    return Response.json(page, { headers: nextCursor ? { "X-Workspace-Chat-Next-Cursor": nextCursor } : {} });
  }

  private ensureChatCheckpointTables() {
    this.sql`CREATE TABLE IF NOT EXISTS workspace_chat_checkpoints (
      turn_id TEXT PRIMARY KEY, checkpoint_json TEXT NOT NULL, state TEXT NOT NULL,
      continued_by TEXT, updated_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS workspace_chat_checkpoint_chunks (turn_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(turn_id, chunk_index))`;
    this.sql`CREATE TABLE IF NOT EXISTS workspace_chat_tool_operations (
      operation_key TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`;
  }

  private prepareChatCheckpoint(turnId: string, continuationMessageId: string | undefined, releaseId: string): ChatCheckpoint | undefined {
    this.ensureChatCheckpointTables();
    const own = this.sql<{ json: string }>`SELECT checkpoint_json AS json FROM workspace_chat_checkpoints WHERE turn_id = ${turnId}`[0];
    if (own) return this.readChatCheckpoint(turnId, own.json);
    if (!continuationMessageId) return undefined;
    const sourceTurnId = continuationMessageId.replace(/^assistant-/, "turn_chat_");
    const source = this.sql<{ json: string; state: string; continuedBy: string | null }>`
      SELECT checkpoint_json AS json, state, continued_by AS continuedBy FROM workspace_chat_checkpoints WHERE turn_id = ${sourceTurnId}
    `[0];
    if (!source || !["paused", "failed", "cancelled"].includes(source.state)) throw new RuntimeHttpError(409, "mate_chat_continuation_unavailable");
    if (source.continuedBy && source.continuedBy !== turnId) throw new RuntimeHttpError(409, "mate_chat_continuation_already_started");
    const latest = [...this.messages].reverse().find((message) => message.role === "assistant");
    if (latest?.id !== continuationMessageId) throw new RuntimeHttpError(409, "mate_chat_continuation_stale");
    const checkpoint = this.readChatCheckpoint(sourceTurnId, source.json);
    if (checkpoint.releaseId !== releaseId) throw new RuntimeHttpError(409, "mate_chat_release_changed");
    this.checkpointStorage.transactionSync(() => {
      this.sql`UPDATE workspace_chat_checkpoints SET continued_by = ${turnId}, updated_at = ${Date.now()} WHERE turn_id = ${sourceTurnId}`;
      this.storeChatCheckpoint(turnId, checkpoint, true);
    });
    return checkpoint;
  }

  private storeChatCheckpoint(turnId: string, checkpoint: ChatCheckpoint, withinTransaction = false) {
    this.ensureChatCheckpointTables();
    const serialized = serializeChatCheckpoint(checkpoint);
    const persist = () => {
      this.sql`INSERT INTO workspace_chat_checkpoints (turn_id, checkpoint_json, state, updated_at)
        VALUES (${turnId}, '@chunks', 'running', ${Date.now()})
        ON CONFLICT(turn_id) DO UPDATE SET checkpoint_json = excluded.checkpoint_json, state = 'running', updated_at = excluded.updated_at`;
      this.sql`DELETE FROM workspace_chat_checkpoint_chunks WHERE turn_id = ${turnId}`;
      for (const [index, content] of chatCheckpointChunks(serialized).entries()) {
        this.sql`INSERT INTO workspace_chat_checkpoint_chunks (turn_id, chunk_index, content)
          VALUES (${turnId}, ${index}, ${content})`;
      }
    };
    if (withinTransaction) persist();
    else this.checkpointStorage.transactionSync(persist);
  }

  private readChatCheckpoint(turnId: string, header: string) {
    if (header !== "@chunks") return parseChatCheckpoint(header);
    const chunks = this.sql<{ content: string }>`SELECT content FROM workspace_chat_checkpoint_chunks WHERE turn_id = ${turnId} ORDER BY chunk_index`;
    return parseChatCheckpoint(chunks.map((chunk) => chunk.content).join(""));
  }

  private setChatCheckpointState(turnId: string, state: string) {
    this.ensureChatCheckpointTables();
    this.sql`UPDATE workspace_chat_checkpoints SET state = ${state}, updated_at = ${Date.now()} WHERE turn_id = ${turnId}`;
  }

  private async executeCheckpointTool(rootTurnId: string, name: string, args: unknown, execute: () => PromiseLike<unknown> | unknown) {
    this.ensureChatCheckpointTables();
    const key = await digestChatMessage(chatToolOperationKey(rootTurnId, name, args));
    return executeChatToolOnce({ name, args, execute,
      load: () => {
        const row = this.sql<{ json: string }>`SELECT record_json AS json FROM workspace_chat_tool_operations WHERE operation_key = ${key}`[0];
        return row ? JSON.parse(row.json) as ChatToolRecord : undefined;
      },
      store: (record) => {
        this.sql`INSERT INTO workspace_chat_tool_operations (operation_key, record_json, updated_at)
          VALUES (${key}, ${JSON.stringify(record)}, ${Date.now()})
          ON CONFLICT(operation_key) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at`;
      }
    });
  }

  override async onStart() {
    this.ensureAgentTables();
    try {
      await this.reconcilePendingCompletions();
    } catch (error) {
      console.error("mate_chat_completion_recovery_failed", {
        code: error instanceof RuntimeHttpError ? error.code : "mate_chat_agent_error"
      });
    }
  }

  override async onChatMessage(
    _onFinish?: Parameters<AIChatAgent<RuntimeEnv>["onChatMessage"]>[0],
    options?: Parameters<AIChatAgent<RuntimeEnv>["onChatMessage"]>[1]
  ) {
    const callerSignal = options?.abortSignal;
    const signal = callerSignal ?? new AbortController().signal;
    let activeTurn: ActiveChatTurn | undefined;
    try {
      throwIfTurnAborted(signal, callerSignal);
      if (options?.clientTools?.length) {
        throw new RuntimeHttpError(422, "mate_chat_client_tools_unsupported");
      }
      const body = options?.body ?? {};
      const recovery = mateChatBindingFromRecovery(
        body.recovery ?? latestChannelRecovery(this.messages),
        this.name
      );
      const { claims, turn } = recovery;
      const requestId = requiredRequestId(options?.requestId);
      const environment = await this.acceptBoundEnvironment(turn.environment);
      // AIChatAgent decides whether an overlapping submit is dropped only after
      // our protocol wrapper has rebuilt the frame. Persist the binding here,
      // once the framework has actually admitted the turn, so a client cannot
      // advance the Environment pin or fill Durable Object SQLite with bindings
      // for dropped submissions.
      this.storeTurnBinding(requestId, recovery);
      this.linkTurnRequest(requestId, turn.turnId);

      const exactTurn = mateChatUserTurn(this.messages, turn.userMessageId);
      const currentUserMessage = this.messages.find((message) => message.id === turn.userMessageId && message.role === "user");
      if (!currentUserMessage) throw new RuntimeHttpError(409, "mate_chat_turn_binding_mismatch");
      const messageDigest = await digestChatMessage(mateChatUserMessageDigestInput(currentUserMessage));
      const expectedIds = await chatProjectionIds({
        clientMessageId: turn.userMessageId,
        conversationId: claims.conversationId,
        mode: claims.mode,
        releaseId: claims.releaseId,
        mateId: claims.mateId,
        userId: claims.userId
      });
      if (messageDigest !== turn.messageDigest || expectedIds.taskId !== turn.taskId) {
        throw new RuntimeHttpError(409, "mate_chat_turn_binding_mismatch");
      }
      throwIfTurnAborted(signal, callerSignal);

      const principal = chatPrincipalFromGrant(claims);
      await readConversation(
        this.env.RUNTIME_DB,
        claims.mateId,
        claims.userId,
        claims.mode,
        claims.conversationId
      );
      throwIfTurnAborted(signal, callerSignal);
      const definition = await loadRuntimeDefinition(
        this.env,
        principal,
        claims.mateId,
        claims.mode,
        { abortSignal: signal }
      );
      throwIfTurnAborted(signal, callerSignal);
      if (definition.release.id !== claims.releaseId) {
        throw new RuntimeHttpError(409, "mate_chat_release_changed");
      }
      const projection = await createChatTurnProjection(this.env.RUNTIME_DB, {
        agentInstanceName: this.name,
        clientMessageId: turn.userMessageId,
        conversationId: claims.conversationId,
        conversationTitle: exactTurn.text,
        environment,
        messageDigest,
        mode: claims.mode,
        releaseId: claims.releaseId,
        mateId: claims.mateId,
        turnId: turn.turnId,
        userId: claims.userId
      });
      throwIfTurnAborted(signal, callerSignal);
      if (projection.turnId !== turn.turnId) {
        throw new RuntimeHttpError(409, "mate_chat_turn_binding_mismatch");
      }
      if (projection.status === "completed") {
        // D1 reaches completed only after the exact DO terminal marker was
        // persisted. A late recovery must not overwrite that message.
        activeTurn = undefined;
        return undefined;
      }
      activeTurn = {
        mode: claims.mode,
        releaseId: claims.releaseId,
        taskId: turn.taskId,
        mateId: claims.mateId,
        turnId: projection.turnId,
        userId: claims.userId
      };

      if (projection.status === "accepted" || (projection.status === "cancelled" && !projection.errorCode)) {
        await startChatTurnProjection(this.env.RUNTIME_DB, activeTurn);
        throwIfTurnAborted(signal, callerSignal);
      } else if (projection.status !== "running") {
        throw new RuntimeHttpError(409, projection.errorCode || "mate_chat_turn_not_executable", {
          turnStatus: projection.status
        });
      }

      const conversation = mateRoleConversation(this.messages, turn.userMessageId, claims.releaseId);
      const assistantMessageId = mateChatAssistantMessageId(turn.turnId);
      const checkpoint = this.prepareChatCheckpoint(turn.turnId, turn.continuationMessageId, claims.releaseId);
      const streamed = await createRoleConversationAgent(this.env, definition, principal, {
        abortSignal: signal,
        checkpoint,
        onCheckpoint: (value) => this.storeChatCheckpoint(turn.turnId, value),
        executeTool: (name, args, execute) => this.executeCheckpointTool(checkpoint?.rootTurnId ?? turn.turnId, name, args, execute),
        conversation,
        attachmentMessages: mateRoleAttachmentMessages(this.messages, turn.userMessageId, claims.releaseId),
        conversationId: claims.conversationId,
        environment,
        instruction: exactTurn.text,
        mode: claims.mode,
        selection: turn.selection,
        turnId: turn.turnId,
        userMessage: currentUserMessage
      });
      if (streamed) {
        return streamedMateChatResponse(streamed, {
          assistantMessageId,
          onComplete: async (resolution) => {
            this.setChatCheckpointState(turn.turnId, resolution.execution?.state ?? "completed");
            console.info("mate_chat_generation_finished", { turnId: turn.turnId, state: resolution.execution?.state ?? "completed", reason: resolution.execution?.reason, steps: resolution.execution?.steps, emptyFinalRecovery: resolution.execution?.emptyFinalRecovery });
            await this.storePendingCompletion({
              assistantMessageId,
              conclusion: metadataOnlyChatConclusion(resolution, { assistantMessageId }),
              mode: claims.mode,
              releaseId: claims.releaseId,
              requestId,
              responseDigest: "",
              taskId: turn.taskId,
              mateId: claims.mateId,
              turnId: turn.turnId,
              userId: claims.userId
            });
            return;
          },
          onFailure: async (error) => {
            const runtimeError = chatTurnError(error, signal, callerSignal);
            const status = runtimeError.code === "mate_chat_request_aborted" ? "cancelled" : "failed";
            this.setChatCheckpointState(turn.turnId, status);
            // Transport disconnects keep the Agent running. An explicit
            // stop is recorded separately and may be continued from a checkpoint.
            if (activeTurn && runtimeError.code !== "mate_chat_request_aborted") {
              await this.failActiveTurn(
                activeTurn,
                runtimeError.code,
                status
              );
            } else if (activeTurn) {
              await this.failActiveTurn(activeTurn, runtimeError.code, "cancelled");
            }
            return status;
          },
          releaseId: claims.releaseId,
          startedAt: turn.startedAt ?? new Date().toISOString(),
          turnId: turn.turnId
        });
      }
      const resolution = await resolveRoleConversation(this.env, definition, principal, {
        abortSignal: signal,
        conversation,
        environment,
        instruction: exactTurn.text,
        selection: turn.selection,
        turnId: turn.turnId
      });
      throwIfTurnAborted(signal, callerSignal);
      await this.storePendingCompletion({
        assistantMessageId,
        conclusion: metadataOnlyChatConclusion(resolution, { assistantMessageId }),
        mode: claims.mode,
        releaseId: claims.releaseId,
        requestId,
        responseDigest: "",
        taskId: turn.taskId,
        mateId: claims.mateId,
        turnId: turn.turnId,
        userId: claims.userId
      });
      return resolvedMateChatResponse(resolution, {
        assistantMessageId,
        releaseId: claims.releaseId,
        startedAt: turn.startedAt ?? new Date().toISOString(),
        turnId: turn.turnId
      });
    } catch (error) {
      const runtimeError = chatTurnError(error, signal, callerSignal);
      if (activeTurn) this.setChatCheckpointState(activeTurn.turnId, runtimeError.code === "mate_chat_request_aborted" ? "cancelled" : "failed");
      if (activeTurn && runtimeError.code !== "mate_chat_request_aborted") {
        await this.failActiveTurn(
          activeTurn,
          runtimeError.code,
          "failed"
        );
      } else if (activeTurn) {
        await this.failActiveTurn(activeTurn, runtimeError.code, "cancelled");
      }
      return mateChatErrorResponse(runtimeError.code);
    }
  }

  protected override async onChatRecovery(context: ChatRecoveryContext) {
    const recovery = mateChatBindingFromRecovery(
      context.lastBody?.recovery ?? latestChannelRecovery(this.messages),
      this.name
    );
    // The framework can recover after persisting the accepted user message but
    // before the first onChatMessage instruction ran. In that narrow window the
    // server-injected recovery body is the first durable admission signal.
    await this.acceptBoundEnvironment(recovery.turn.environment);
    this.storeTurnBinding(context.recoveryRootRequestId, recovery);
    this.linkTurnRequest(context.requestId, recovery.turn.turnId);
    return { persist: false };
  }

  async channelMessage(input: {
    message: UIMessage;
    recovery: MateChatRecoveryContext;
  }) {
    await this.waitUntilStable();
    const recovery = mateChatBindingFromRecovery(input.recovery, this.name);
    if (input.message.role !== "user" || input.message.id !== recovery.turn.userMessageId) {
      throw new RuntimeHttpError(409, "mate_chat_turn_binding_mismatch");
    }
    const existing = this.messages.find((candidate) => candidate.id === input.message.id);
    const assistantMessageId = mateChatAssistantMessageId(recovery.turn.turnId);
    if (existing) {
      if (existing.role !== "user" || uiMessageText(existing) !== uiMessageText(input.message)) {
        throw new RuntimeHttpError(409, "mate_channel_message_id_conflict");
      }
      const assistant = this.messages.find((candidate) => (
        candidate.id === assistantMessageId && candidate.role === "assistant"
      ));
      if (!assistant) throw new RuntimeHttpError(409, "mate_channel_message_incomplete");
      return { text: uiMessageText(assistant) };
    }
    const message: UIMessage = {
      ...input.message,
      metadata: { workspaceMateChannel: { recovery } }
    };
    const saved = await this.saveMessages((messages) => [...messages, message]);
    if (saved.status !== "completed") {
      throw new RuntimeHttpError(503, `mate_channel_turn_${saved.status}`);
    }
    const assistant = this.messages.find((candidate) => candidate.id === assistantMessageId && candidate.role === "assistant");
    return { text: assistant ? uiMessageText(assistant) : "" };
  }

  private async handleChatRecoveryExhausted(context: ChatRecoveryExhaustedContext) {
    try {
      const recovery = this.turnBindingForRequests(context.requestId, context.recoveryRootRequestId);
      const { claims, turn } = recovery;
      const pending = this.pendingCompletions().find((row) => row.taskId === turn.taskId);
      if (pending) {
        const message = this.messages.find((candidate) => candidate.id === pending.assistantMessageId);
        if (message && this.hasExactTerminalMarker(pending, message)) {
          await this.finalizePendingCompletion(pending, {
            continuation: false,
            message,
            requestId: pending.requestId,
            status: "completed"
          });
          return;
        }
        await this.applyTurnConclusion(pending, {
          errorCode: "mate_chat_recovery_exhausted",
          outcome: "failed",
          summary: "Agent DO recovery was exhausted before response persistence."
        });
        return;
      }
      await this.failActiveTurn({
        mode: claims.mode,
        releaseId: claims.releaseId,
        taskId: turn.taskId,
        mateId: claims.mateId,
        turnId: turn.turnId,
        userId: claims.userId
      }, `mate_chat_recovery_${context.reason}`);
    } catch (error) {
      console.error("mate_chat_recovery_conclusion_failed", {
        code: error instanceof RuntimeHttpError ? error.code : "mate_chat_agent_error",
        incidentId: context.incidentId
      });
    }
  }

  private async failActiveTurn(
    turn: ActiveChatTurn,
    errorCode: string,
    outcome: "cancelled" | "failed" = "failed"
  ) {
    try {
      this.setChatCheckpointState(turn.turnId, outcome);
      await concludeChatTurnProjection(
        this.env.RUNTIME_DB,
        {
          mode: turn.mode,
          mateId: turn.mateId,
          turnId: turn.turnId,
          userId: turn.userId,
          ...(outcome === "failed" ? { errorCode: errorCode.slice(0, 160) } : {}),
          outcome
        }
      );
    } catch (error) {
      if (error instanceof RuntimeHttpError && error.code === "mate_chat_turn_not_found") {
        return; // Safe for a brand-new submit whose preflight failed before projection.
      }
      console.error("mate_chat_turn_failure_projection_failed", {
        code: error instanceof RuntimeHttpError ? error.code : "mate_chat_agent_error",
        turnId: turn.turnId
      });
    }
  }

  override persistMessages(
    messages: UIMessage[],
    excludeBroadcastIds: string[] = [],
    options?: { _deleteStaleRows?: boolean }
  ) {
    if (options?._deleteStaleRows) assertMateChatFrameworkAppend(this.messages, messages);
    return super.persistMessages(messages, excludeBroadcastIds, {
      ...options,
      _deleteStaleRows: false
    });
  }

  protected override async onChatResponse(result: ChatResponseResult) {
    const checkpointTurnId = result.message.id.replace(/^assistant-/, "turn_chat_");
    if (result.status !== "completed") this.setChatCheckpointState(checkpointTurnId, result.status === "aborted" ? "cancelled" : "failed");
    const pending = mateChatCompletionRowsForResponse(
      this.pendingCompletions(result.requestId),
      () => this.pendingCompletions(),
      result.message.id
    );
    for (const row of pending) {
      await this.finalizePendingCompletion(row, result);
    }
  }

  private async acceptBoundEnvironment(value: MateChatRecoveryContext["turn"]["environment"]) {
    const verified = await verifyPinnedChatEnvironment(value);
    const accepted = await this.acceptEnvironment(verified.context);
    if (accepted.digest !== verified.digest) {
      throw new RuntimeHttpError(409, "mate_chat_environment_binding_mismatch");
    }
    return verified;
  }

  private async acceptEnvironment(value: unknown, options: { persist?: boolean } = {}) {
    this.ensureAgentTables();
    const candidate = await pinChatEnvironment(value);
    const rows = this.sql<EnvironmentPinRow>`
      SELECT source_key AS sourceKey, revision, digest
      FROM workspace_mate_chat_environment
      WHERE source_key = ${candidate.pin.sourceKey}
      LIMIT 1
    `;
    const accepted = await pinChatEnvironment(value, rows[0]);
    if (!accepted.idempotent && options.persist !== false) {
      const updatedAt = Date.now();
      this.sql`
        INSERT INTO workspace_mate_chat_environment (
          source_key, revision, digest, envelope_json, updated_at
        ) VALUES (
          ${accepted.pin.sourceKey},
          ${accepted.pin.revision},
          ${accepted.pin.digest},
          ${JSON.stringify(accepted.pin.envelope)},
          ${updatedAt}
        )
        ON CONFLICT(source_key) DO UPDATE SET
          revision = excluded.revision,
          digest = excluded.digest,
          envelope_json = excluded.envelope_json,
          updated_at = excluded.updated_at
      `;
      this.sql`
        DELETE FROM workspace_mate_chat_environment
        WHERE source_key NOT IN (
          SELECT source_key
          FROM workspace_mate_chat_environment
          ORDER BY updated_at DESC
          LIMIT 32
        )
      `;
    }
    return accepted.pin;
  }

  private ensureAgentTables() {
    this.sql`
      CREATE TABLE IF NOT EXISTS workspace_mate_chat_environment (
        source_key TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        digest TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS workspace_mate_chat_completion_outbox (
        task_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        mate_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        runtime_mode TEXT NOT NULL DEFAULT 'live' CHECK (runtime_mode IN ('live', 'preview')),
        release_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        response_digest TEXT NOT NULL,
        conclusion_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        last_error TEXT,
        exhausted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    const completionColumns = this.sql<{ name: string }>`
      PRAGMA table_info(workspace_mate_chat_completion_outbox)
    `;
    if (!completionColumns.some((column) => column.name === "runtime_mode")) {
      // Phase 1 Agent DOs already have this table. Their rows are all Live, so
      // the additive default is both a safe backfill and an idempotent upgrade.
      this.sql`
        ALTER TABLE workspace_mate_chat_completion_outbox
        ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'live'
        CHECK (runtime_mode IN ('live', 'preview'))
      `;
    }
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_workspace_mate_chat_outbox_request
      ON workspace_mate_chat_completion_outbox(request_id)
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS workspace_mate_chat_turn_bindings (
        turn_id TEXT PRIMARY KEY,
        recovery_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS workspace_mate_chat_turn_requests (
        request_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_workspace_mate_chat_turn_request_turn
      ON workspace_mate_chat_turn_requests(turn_id)
    `;
  }

  private storeTurnBinding(requestId: string, recovery: MateChatRecoveryContext) {
    this.ensureAgentTables();
    const normalized = mateChatRecoveryContext(recovery.claims, recovery.turn);
    const recoveryJson = canonicalJson(normalized);
    const existing = this.sql<StoredTurnBindingRow>`
      SELECT turn_id AS turnId, recovery_json AS recoveryJson
      FROM workspace_mate_chat_turn_bindings
      WHERE turn_id = ${recovery.turn.turnId}
      LIMIT 1
    `[0];
    if (existing && existing.recoveryJson !== recoveryJson) {
      throw new RuntimeHttpError(409, "mate_chat_turn_binding_conflict");
    }
    const now = Date.now();
    this.sql`
      INSERT INTO workspace_mate_chat_turn_bindings (turn_id, recovery_json, created_at, updated_at)
      VALUES (${recovery.turn.turnId}, ${recoveryJson}, ${now}, ${now})
      ON CONFLICT(turn_id) DO UPDATE SET updated_at = excluded.updated_at
    `;
    this.linkTurnRequest(requestId, recovery.turn.turnId);
  }

  private linkTurnRequest(requestId: string, turnId: string) {
    this.ensureAgentTables();
    const existing = this.sql<{ turnId: string }>`
      SELECT turn_id AS turnId
      FROM workspace_mate_chat_turn_requests
      WHERE request_id = ${requestId}
      LIMIT 1
    `[0];
    if (existing && existing.turnId !== turnId) {
      throw new RuntimeHttpError(409, "mate_chat_request_binding_conflict");
    }
    this.sql`
      INSERT INTO workspace_mate_chat_turn_requests (request_id, turn_id, created_at)
      VALUES (${requestId}, ${turnId}, ${Date.now()})
      ON CONFLICT(request_id) DO NOTHING
    `;
  }

  private turnBindingForRequests(...requestIds: string[]) {
    this.ensureAgentTables();
    for (const requestId of requestIds) {
      const row = this.sql<StoredTurnBindingRow>`
        SELECT binding.turn_id AS turnId, binding.recovery_json AS recoveryJson
        FROM workspace_mate_chat_turn_requests AS request
        JOIN workspace_mate_chat_turn_bindings AS binding ON binding.turn_id = request.turn_id
        WHERE request.request_id = ${requestId}
        LIMIT 1
      `[0];
      if (row) return mateChatBindingFromRecovery(JSON.parse(row.recoveryJson), this.name);
    }
    throw new RuntimeHttpError(404, "mate_chat_turn_binding_not_found");
  }

  private async storePendingCompletion(input: {
    assistantMessageId: string;
    conclusion: Record<string, unknown>;
    mode: RuntimeMode;
    releaseId: string;
    requestId: string;
    responseDigest: string;
    taskId: string;
    mateId: string;
    turnId: string;
    userId: string;
  }) {
    this.ensureAgentTables();
    const now = Date.now();
    this.sql`
      INSERT INTO workspace_mate_chat_completion_outbox (
        task_id, request_id, mate_id, user_id, runtime_mode, release_id, turn_id,
        assistant_message_id, response_digest, conclusion_json, created_at, updated_at
      ) VALUES (
        ${input.taskId}, ${input.requestId}, ${input.mateId}, ${input.userId},
        ${input.mode}, ${input.releaseId}, ${input.turnId},
        ${input.assistantMessageId}, ${input.responseDigest}, ${JSON.stringify(input.conclusion)},
        ${now}, ${now}
      )
      ON CONFLICT(task_id) DO NOTHING
    `;
    const stored = this.pendingCompletionByTask(input.taskId);
    if (
      !stored
      || stored.mateId !== input.mateId
      || stored.userId !== input.userId
      || stored.mode !== input.mode
      || stored.releaseId !== input.releaseId
      || stored.turnId !== input.turnId
      || stored.assistantMessageId !== input.assistantMessageId
      || stored.attempts !== 0
      || stored.exhaustedAt !== null
    ) throw new RuntimeHttpError(409, "mate_chat_completion_intent_conflict");
    this.sql`
      UPDATE workspace_mate_chat_completion_outbox
      SET request_id = ${input.requestId}, response_digest = ${input.responseDigest},
          conclusion_json = ${JSON.stringify(input.conclusion)}, updated_at = ${Date.now()}
      WHERE task_id = ${input.taskId}
    `;
    await this.scheduleCompletionRetry(
      input.taskId,
      Math.max(1_000, stored.createdAt + PENDING_COMPLETION_TIMEOUT_MS - Date.now()),
      0
    );
  }

  private pendingCompletions(requestId?: string) {
    this.ensureAgentTables();
    if (requestId) {
      return this.sql<PendingCompletionRow>`
        SELECT task_id AS taskId, request_id AS requestId, mate_id AS mateId,
               user_id AS userId, runtime_mode AS mode, release_id AS releaseId, turn_id AS turnId,
               assistant_message_id AS assistantMessageId,
               response_digest AS responseDigest, conclusion_json AS conclusionJson,
               attempts, next_retry_at AS nextRetryAt, last_error AS lastError,
               exhausted_at AS exhaustedAt, created_at AS createdAt
        FROM workspace_mate_chat_completion_outbox
        WHERE request_id = ${requestId}
      `;
    }
    return this.sql<PendingCompletionRow>`
      SELECT task_id AS taskId, request_id AS requestId, mate_id AS mateId,
             user_id AS userId, runtime_mode AS mode, release_id AS releaseId, turn_id AS turnId,
             assistant_message_id AS assistantMessageId,
             response_digest AS responseDigest, conclusion_json AS conclusionJson,
             attempts, next_retry_at AS nextRetryAt, last_error AS lastError,
             exhausted_at AS exhaustedAt, created_at AS createdAt
      FROM workspace_mate_chat_completion_outbox
      ORDER BY created_at ASC
      LIMIT 64
    `;
  }

  private pendingCompletionByTask(taskId: string) {
    this.ensureAgentTables();
    return this.sql<PendingCompletionRow>`
      SELECT task_id AS taskId, request_id AS requestId, mate_id AS mateId,
             user_id AS userId, runtime_mode AS mode, release_id AS releaseId, turn_id AS turnId,
             assistant_message_id AS assistantMessageId,
             response_digest AS responseDigest, conclusion_json AS conclusionJson,
             attempts, next_retry_at AS nextRetryAt, last_error AS lastError,
             exhausted_at AS exhaustedAt, created_at AS createdAt
      FROM workspace_mate_chat_completion_outbox
      WHERE task_id = ${taskId}
      LIMIT 1
    `[0];
  }

  private async reconcilePendingCompletions() {
    for (const row of this.pendingCompletions()) {
      if (row.exhaustedAt) continue;
      const message = this.messages.find((candidate) => candidate.id === row.assistantMessageId);
      if (message && this.hasExactTerminalMarker(row, message)) {
        await this.finalizePendingCompletion(row, {
          continuation: false,
          message,
          requestId: row.requestId,
          status: "completed"
        });
        continue;
      }
      const now = Date.now();
      if (now - row.createdAt >= PENDING_COMPLETION_TIMEOUT_MS) {
        await this.applyTurnConclusion(row, {
          errorCode: "mate_chat_response_interrupted",
          outcome: "failed",
          summary: "Agent DO response was interrupted before persistence."
        });
        continue;
      }
      if (row.nextRetryAt && row.nextRetryAt <= now) {
        await this.applyTurnConclusion(row, parseConclusion(row.conclusionJson));
        continue;
      }
      const dueAt = row.nextRetryAt ?? row.createdAt + PENDING_COMPLETION_TIMEOUT_MS;
      await this.scheduleCompletionRetry(row.taskId, Math.max(1_000, dueAt - now), row.attempts);
    }
  }

  async retryChatCompletionOutbox(payload: { generation: number; taskId: string }) {
    const row = this.pendingCompletionByTask(payload.taskId);
    if (!row || row.exhaustedAt || payload.generation !== row.attempts) return;
    const message = this.messages.find((candidate) => candidate.id === row.assistantMessageId);
    if (message && this.hasExactTerminalMarker(row, message)) {
      await this.finalizePendingCompletion(row, {
        continuation: false,
        message,
        requestId: row.requestId,
        status: "completed"
      });
      return;
    }
    const now = Date.now();
    if (now - row.createdAt >= PENDING_COMPLETION_TIMEOUT_MS && !row.nextRetryAt) {
      await this.applyTurnConclusion(row, {
        errorCode: "mate_chat_response_interrupted",
        outcome: "failed",
        summary: "Agent DO response was interrupted before persistence."
      });
      return;
    }
    if (!row.nextRetryAt || row.nextRetryAt > now) {
      const dueAt = row.nextRetryAt ?? row.createdAt + PENDING_COMPLETION_TIMEOUT_MS;
      await this.scheduleCompletionRetry(row.taskId, Math.max(1_000, dueAt - now), row.attempts);
      return;
    }
    await this.applyTurnConclusion(row, parseConclusion(row.conclusionJson));
  }

  private async finalizePendingCompletion(row: PendingCompletionRow, result: ChatResponseResult) {
    if (result.status !== "completed") {
      await this.applyTurnConclusion(row, result.status === "aborted"
        ? { outcome: "cancelled", summary: "Agent DO response was cancelled." }
        : {
            errorCode: "mate_chat_response_stream_failed",
            outcome: "failed",
            summary: "Agent DO response stream failed."
          });
      return;
    }
    if (!this.hasExactTerminalMarker(row, result.message)) return;
    await this.applyTurnConclusion(row, parseConclusion(row.conclusionJson));
  }

  private async applyTurnConclusion(row: PendingCompletionRow, conclusion: Record<string, unknown>) {
    const conclusionJson = JSON.stringify(conclusion);
    this.sql`
      UPDATE workspace_mate_chat_completion_outbox
      SET conclusion_json = ${conclusionJson}, updated_at = ${Date.now()}
      WHERE task_id = ${row.taskId}
    `;
    const current = { ...row, conclusionJson };
    try {
      const outcome = String(conclusion.outcome ?? "");
      if (outcome === "failed" || outcome === "cancelled") this.setChatCheckpointState(row.turnId, outcome);
      if (outcome !== "completed" && outcome !== "failed" && outcome !== "cancelled") {
        throw new RuntimeHttpError(500, "mate_chat_turn_conclusion_invalid");
      }
      await concludeChatTurnProjection(
        this.env.RUNTIME_DB,
        {
          assistantMessageId: row.assistantMessageId,
          ...(typeof conclusion.errorCode === "string" ? { errorCode: conclusion.errorCode } : {}),
          mode: row.mode,
          outcome,
          // New turns rely on persisted message identity, not text digests.
          ...(row.responseDigest ? { responseDigest: row.responseDigest } : {}),
          mateId: row.mateId,
          turnId: row.turnId,
          userId: row.userId
        }
      );
    } catch (error) {
      if (error instanceof RuntimeHttpError && error.code === "mate_chat_turn_not_found") {
        // Compatibility for a v1 outbox created before Conversation Turns were
        // separated from business Tasks. New conversation turns never enter
        // this path and never create or mutate a Runtime Task.
        if (await this.applyLegacyTaskConclusion(current, conclusion)) {
          this.deletePendingCompletion(row.taskId);
          return;
        }
      }
      await this.recordCompletionRetry(current, error);
      return;
    }
    this.deletePendingCompletion(row.taskId);
  }

  private hasExactTerminalMarker(row: PendingCompletionRow, message: UIMessage) {
    const conclusion = parseConclusion(row.conclusionJson);
    return mateChatTerminalMarkerMatches(message, {
      assistantMessageId: row.assistantMessageId,
      outcome: String(conclusion.outcome ?? ""),
      releaseId: row.releaseId,
      responseDigest: row.responseDigest,
      turnId: row.turnId
    });
  }

  private async readActiveTask(task: PendingCompletionRow) {
    return readTask(
      this.env.RUNTIME_DB,
      task.mateId,
      { callerKind: "user", orgId: "", scopes: [], userId: task.userId },
      task.mode,
      task.taskId
    );
  }

  private async applyLegacyTaskConclusion(row: PendingCompletionRow, conclusion: Record<string, unknown>) {
    try {
      const before = await this.readActiveTask(row);
      if (before.releaseId !== row.releaseId) return false;
      if (["completed", "failed", "cancelled"].includes(String(before.status))) {
        return mateChatTaskConclusionMatches(before, { conclusion, releaseId: row.releaseId });
      }
      await concludeTask(
        this.env.RUNTIME_DB,
        row.mateId,
        row.userId,
        row.mode,
        row.taskId,
        conclusion
      );
      return true;
    } catch (error) {
      if (error instanceof RuntimeHttpError && error.code === "task_already_concluded") {
        const task = await this.readActiveTask(row).catch(() => undefined);
        return Boolean(task && mateChatTaskConclusionMatches(task, {
          conclusion,
          releaseId: row.releaseId
        }));
      }
      return false;
    }
  }

  private async recordCompletionRetry(row: PendingCompletionRow, error: unknown) {
    const attempts = row.attempts + 1;
    const lastError = error instanceof RuntimeHttpError ? error.code : "mate_chat_completion_projection_failed";
    if (attempts >= COMPLETION_MAX_ATTEMPTS) {
      this.sql`
        UPDATE workspace_mate_chat_completion_outbox
        SET attempts = ${attempts}, next_retry_at = NULL, last_error = ${lastError},
            exhausted_at = ${Date.now()}, updated_at = ${Date.now()}
        WHERE task_id = ${row.taskId}
      `;
      console.error("mate_chat_completion_outbox_exhausted", {
        code: lastError,
        taskId: row.taskId
      });
      return;
    }
    const delay = mateChatCompletionRetryDelayMs(attempts);
    const nextRetryAt = Date.now() + delay;
    this.sql`
      UPDATE workspace_mate_chat_completion_outbox
      SET attempts = ${attempts}, next_retry_at = ${nextRetryAt}, last_error = ${lastError},
          updated_at = ${Date.now()}
      WHERE task_id = ${row.taskId}
    `;
    await this.scheduleCompletionRetry(row.taskId, delay, attempts);
  }

  private async scheduleCompletionRetry(taskId: string, delayMs: number, generation: number) {
    await this.schedule(
      Math.max(1, Math.ceil(delayMs / 1_000)),
      "retryChatCompletionOutbox",
      { generation, taskId },
      { idempotent: true }
    );
  }

  private deletePendingCompletion(taskId: string) {
    this.sql`
      DELETE FROM workspace_mate_chat_completion_outbox
      WHERE task_id = ${taskId}
    `;
  }
}

function requiredRequestId(value: unknown) {
  const requestId = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/.test(requestId)) {
    throw new RuntimeHttpError(422, "mate_chat_request_id_invalid");
  }
  return requestId;
}

function latestChannelRecovery(messages: UIMessage[]) {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  const metadata = latest?.metadata as { workspaceMateChannel?: { recovery?: unknown } } | undefined;
  return metadata?.workspaceMateChannel?.recovery;
}

function uiMessageText(message: UIMessage) {
  return message.parts.flatMap((part) => (
    part.type === "text" && typeof part.text === "string" ? [part.text] : []
  )).join("").trim();
}

function parseConclusion(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* Fall through to the integrity error. */ }
  return {
    errorCode: "mate_chat_completion_intent_invalid",
    outcome: "failed",
    summary: "Agent DO completion metadata was invalid."
  };
}

function chatGrantSecret(env: RuntimeEnv) {
  return env.MATE_CHAT_GRANT_SECRET?.trim() || "";
}

function throwIfTurnAborted(signal: AbortSignal, callerSignal?: AbortSignal) {
  if (!signal.aborted) return;
  if (callerSignal?.aborted) throw new RuntimeHttpError(499, "mate_chat_request_aborted");
  throw new RuntimeHttpError(504, "mate_chat_turn_timeout");
}

function chatTurnError(error: unknown, signal: AbortSignal, callerSignal?: AbortSignal) {
  if (callerSignal?.aborted) return new RuntimeHttpError(499, "mate_chat_request_aborted");
  if (signal.aborted) return new RuntimeHttpError(504, "mate_chat_turn_timeout");
  return error instanceof RuntimeHttpError
    ? error
    : new RuntimeHttpError(500, "mate_chat_agent_error");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
