import type { ChatCapabilitySelection, ChatGrant, ChatMessage, LiveSession, UploadedAttachment } from "../types";
import { chatUrl, createChatGrant, createConversation, loadMessages } from "./api";
import { applyChatChunk, resetAssistantForReplay } from "./chatProtocol";
import { mockMessages } from "./mock";
import { isRuntimeSessionExpired, isRuntimeSessionInvalid } from "./sessionRecovery";
import { connectChatSocket } from "./socket";
import { resumableMessage } from "./chatExecution";

export type ChatConnection = "connecting" | "connected" | "reconnecting" | "offline";
export type ChatSnapshot = { messages: ChatMessage[]; streaming: boolean; recovering: boolean; connection: ChatConnection; canContinue: boolean; error?: string };
type Listener = (state: ChatSnapshot) => void;
type SessionRenewal = (session: LiveSession) => Promise<LiveSession>;

const CONNECT_TIMEOUT_MS = 10_000;
const APPROVAL_RECOVERY_TIMEOUT_MS = 20_000;
const BASE_RECONNECT_DELAY_MS = 600;
const MAX_RECONNECT_DELAY_MS = 15_000;

/**
 * The slice of `Taro.SocketTask` this class depends on. Declaring it separately keeps the
 * socket transport injectable, so the reconnect/renewal/approval state machine can be
 * exercised deterministically without a WeChat runtime.
 */
export type ChatSocket = {
  close(options: Record<string, unknown>): void;
  onClose(handler: () => void): void;
  onError(handler: () => void): void;
  onMessage(handler: (event: { data: unknown }) => void): void;
  onOpen(handler: () => void): void;
  send(options: { data: string }): void;
};

/** Injection seams. Production callers omit these and get Taro plus the real clock. */
export type ChatDependencies = {
  clearTimeout: (handle: unknown) => void;
  createSocket: (options: { url: string }) => ChatSocket | Promise<ChatSocket>;
  loadHistory: typeof loadMessages;
  now: () => number;
  obtainGrant: typeof createChatGrant;
  openConversation: typeof createConversation;
  setTimeout: (handler: () => void, delayMs: number) => unknown;
  socketUrl: typeof chatUrl;
};

const DEFAULT_DEPENDENCIES: ChatDependencies = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  createSocket: connectChatSocket,
  loadHistory: loadMessages,
  now: () => Date.now(),
  obtainGrant: createChatGrant,
  openConversation: createConversation,
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  socketUrl: chatUrl
};

export class WorkspaceMiniChat {
  private socket?: ChatSocket;
  private connecting?: Promise<void>;
  private grant?: ChatGrant;
  private messages: ChatMessage[];
  private streaming = false;
  private recovering = false;
  private connection: ChatConnection = "offline";
  private activeRequestId = "";
  private reconnectAttempt = 0;
  private reconnectTimer?: unknown;
  private approvalTimer?: unknown;
  private explicitlyClosed = false;
  private replayReset = new Set<string>();
  /**
   * Every socket this instance opened. `onClose`/`onError` clear `this.socket` before the
   * reconnect runs, so without this ledger the dropped socket would never be released and a
   * reconnect would leave the previous transport open.
   */
  private readonly openSockets = new Set<ChatSocket>();
  private lastSubmission?: { user: ChatMessage; continuationMessageId?: string; delivered?: boolean };
  private submissionRevision = 0;
  private deliveredRevision = 0;
  private latestResumeRevision = 0;
  private readonly resumeProbes = new Map<string, number>();
  private readonly deps: ChatDependencies;
  private readonly instanceId = `miniapp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  private session: LiveSession;
  private listener: Listener;
  private selection: () => ChatCapabilitySelection | undefined;
  private renewSession?: SessionRenewal;

  constructor(
    session: LiveSession,
    initial: ChatMessage[],
    listener: Listener,
    selection: () => ChatCapabilitySelection | undefined,
    grant?: ChatGrant,
    renewSession?: SessionRenewal,
    dependencies: Partial<ChatDependencies> = {}
  ) {
    this.session = session; this.listener = listener; this.selection = selection; this.renewSession = renewSession;
    this.messages = initial; this.grant = grant;
    this.deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  // Production always connects; `USE_MOCKS` is replaced with a literal at build time, which
  // also keeps this module free of the Taro-backed request layer so it stays unit-testable.
  async connect() { if (this.session.conversationState !== "draft") await this.ensureConnected(); }
  setSelection(provider: () => ChatCapabilitySelection | undefined) { this.selection = provider; }

  private async ensureConnected() {
    if (this.socket) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.openSocket();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }

  private async openSocket(): Promise<void> {
    this.connection = this.reconnectAttempt ? "reconnecting" : "connecting"; this.emit();
    // The grant exchange may renew the runtime session, so the socket URL is built from
    // whatever session/credential is current *after* the refresh, never the stale one.
    const grant = await this.validGrant();
    if (this.explicitlyClosed) return;
    const tokenAtStart = this.session.accessToken;
    const socket = await this.deps.createSocket({ url: this.deps.socketUrl(this.session, "chat", grant, "wss") });
    if (this.explicitlyClosed) { this.discardSocket(socket); return; }
    if (!this.explicitlyClosed && tokenAtStart !== this.session.accessToken) {
      // The session rotated while the socket was opening; this socket is bound to a
      // revoked token, so discard it and reconnect against the fresh one.
      this.discardSocket(socket);
      return this.openSocket();
    }
    this.socket = socket;
    this.openSockets.add(socket);
    socket.onMessage(({ data }) => { if (this.socket === socket && !this.explicitlyClosed) this.onFrame(String(data)); });
    socket.onClose(() => {
      this.openSockets.delete(socket);
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.connection = "offline"; this.emit();
      if (!this.explicitlyClosed) this.scheduleReconnect();
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; this.deps.clearTimeout(timer); error ? reject(error) : resolve(); };
      const timer = this.deps.setTimeout(() => { socket.close({}); finish(new Error("聊天连接超时")); }, CONNECT_TIMEOUT_MS);
      socket.onOpen(() => {
        this.connection = "connected"; this.reconnectAttempt = 0; this.emit(); finish();
        if (this.session.conversationState === "persisted") this.probeResume();
      });
      socket.onError(() => {
        if (this.socket === socket) this.socket = undefined;
        this.discardSocket(socket);
        if (!this.explicitlyClosed) this.scheduleReconnect();
        finish(new Error("聊天连接失败"));
      });
    });
  }

  send(text: string, attachments: UploadedAttachment[] = [], continuationMessageId?: string) {
    const clean = text.trim();
    if (!clean || this.streaming || attachments.length > 5) return;
    const user: ChatMessage = { id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, role: "user", parts: [
      { type: "text", text: clean },
      ...attachments.map((file) => ({ type: "file", filename: file.fileName, mediaType: file.mediaType, sizeBytes: file.sizeBytes, url: file.rawUrl }))
    ] };
    this.lastSubmission = { user, continuationMessageId };
    this.submissionRevision += 1;
    this.messages = [...this.messages, user]; this.streaming = true; this.emit();
    void this.sendFrame();
  }

  stop() {
    this.submissionRevision += 1;
    const hadActiveRequest = Boolean(this.activeRequestId);
    if (hadActiveRequest) this.sendSocket({ type: "cf_agent_chat_request_cancel", id: this.activeRequestId });
    this.activeRequestId = "";
    this.clearApprovalTimer();
    this.streaming = false; this.recovering = false;
    this.emit();
    // A cancel for an unknown request id cannot reach the runtime, so reconcile from the
    // server to make sure we are not showing a stream the runtime has already finished.
    if (!hadActiveRequest) void this.reconcileMessages();
  }

  retry() {
    if (!this.lastSubmission || this.streaming) return;
    if (!this.lastSubmission.delivered) {
      if (!this.messages.some((message) => message.id === this.lastSubmission!.user.id)) this.messages = [...this.messages, this.lastSubmission.user];
      this.submissionRevision += 1;
      this.streaming = true; this.recovering = false; this.emit();
      void this.sendFrame();
      return;
    }
    // A retry must not create a fresh user turn after an uncertain submission.
    // Reattach/read server state before the user decides to submit new work.
    void this.recover();
  }

  async recover() {
    try { await this.ensureConnected(); this.probeResume(); await this.reconcileMessages(); }
    catch (error) { this.emit(error instanceof Error ? error.message : "连接失败"); }
  }

  continue(text: string) {
    const source = resumableMessage(this.messages);
    if (!source || this.streaming || this.recovering) return;
    this.send(text, [], source.id);
  }

  respondToolApproval(toolCallId: string, approved: boolean) {
    void this.submitToolApproval(toolCallId, approved);
  }

  private async submitToolApproval(toolCallId: string, approved: boolean) {
    // Optimistically show progress, then confirm delivery. A mid-reconnect tap is retried
    // on the fresh socket instead of being reported as a failure the user cannot recover from.
    this.streaming = true; this.recovering = true; this.emit();
    let delivered = false;
    // A failed connection attempt here must not escape as an unhandled rejection: this method
    // is fire-and-forget from the UI.
    try { delivered = await this.deliverSocket({ type: "cf_agent_tool_approval", toolCallId, approved, autoContinue: true }); }
    catch { delivered = false; }
    if (!delivered) {
      if (this.explicitlyClosed) return;
      this.streaming = false; this.recovering = false;
      this.emit("连接已断开，无法提交审批，请重试");
      return;
    }
    this.clearApprovalTimer();
    // The runtime acknowledges with a resume/recovering frame. If nothing arrives, the
    // approval never landed; drop the optimistic "recovering" state so the UI unsticks.
    this.approvalTimer = this.deps.setTimeout(() => {
      this.approvalTimer = undefined;
      if (this.explicitlyClosed || !this.recovering) return;
      this.streaming = false; this.recovering = false;
      this.emit("审批结果未确认，请重试");
    }, APPROVAL_RECOVERY_TIMEOUT_MS);
    this.deps.setTimeout(() => this.probeResume(), 120);
  }

  close() {
    this.submissionRevision += 1;
    this.explicitlyClosed = true;
    if (this.reconnectTimer) { this.deps.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.clearApprovalTimer();
    this.teardownSocket();
    // Surface the closed state immediately: the socket's own close handler is suppressed
    // once `explicitlyClosed` is set, so this is the last chance to clear it.
    this.connection = "offline"; this.emit();
  }

  /**
   * Closes and forgets every socket this instance opened, so a later reconnect cannot be
   * clobbered by a previous transport's handlers and no stale socket is left open.
   */
  private teardownSocket() {
    this.socket = undefined;
    for (const socket of this.openSockets) this.discardSocket(socket);
  }

  private discardSocket(socket: ChatSocket) {
    this.openSockets.delete(socket);
    try { socket.close({}); } catch { /* already gone */ }
  }

  private onFrame(raw: string) {
    let frame: any; try { frame = JSON.parse(raw); } catch { return; }
    switch (frame.type) {
      case "cf_agent_chat_clear": this.messages = []; this.streaming = false; this.recovering = false; this.emit(); return;
      case "cf_agent_chat_messages": if (Array.isArray(frame.messages)) { this.messages = frame.messages; this.emit(); } return;
      case "cf_agent_message_updated": this.upsertMessage(frame.message); return;
      case "cf_agent_chat_recovering": this.recovering = Boolean(frame.recovering); this.clearApprovalTimer(); this.emit(); return;
      case "cf_agent_stream_pending": this.streaming = true; this.recovering = true; this.emit(); return;
      case "cf_agent_stream_resuming":
        if (typeof frame.id === "string") { this.clearApprovalTimer(); this.activeRequestId = frame.id; this.streaming = true; this.recovering = false; this.sendSocket({ type: "cf_agent_stream_resume_ack", id: frame.id }); this.emit(); }
        return;
      case "cf_agent_stream_resume_none": {
        const probedRevision = typeof frame.probeId === "string" ? this.resumeProbes.get(frame.probeId) : this.latestResumeRevision;
        if (typeof frame.probeId === "string") this.resumeProbes.delete(frame.probeId);
        // An idle answer issued before a newly delivered message cannot clear that message's busy state.
        if (probedRevision !== this.deliveredRevision) return;
        if (frame.reason === "idle") { this.clearApprovalTimer(); this.streaming = false; this.recovering = false; this.activeRequestId = ""; this.emit(); void this.reconcileMessages(); }
        return;
      }
      case "cf_agent_use_chat_response": this.onResponse(frame); return;
    }
  }

  private onResponse(frame: any) {
    if (frame.error) {
      this.clearApprovalTimer();
      this.streaming = false; this.recovering = false;
      this.activeRequestId = "";
      this.emit(typeof frame.body === "string" && frame.body ? frame.body : "回复生成失败");
      return;
    }
    if (frame.body) {
      let chunk: any; try { chunk = JSON.parse(frame.body); } catch { chunk = undefined; }
      if (chunk?.type === "start" && chunk.messageId && frame.replay && !frame.continuation && !this.replayReset.has(frame.id)) {
        this.messages = resetAssistantForReplay(this.messages, chunk.messageId); this.replayReset.add(frame.id);
      }
      this.messages = applyChatChunk(this.messages, chunk, `assistant_${frame.id || Date.now()}`);
    }
    if (frame.done) { if (!frame.id || frame.id === this.activeRequestId) this.activeRequestId = ""; this.streaming = false; this.recovering = false; this.clearApprovalTimer(); this.replayReset.delete(frame.id); }
    this.emit();
  }

  private async sendFrame() {
    const submission = this.lastSubmission;
    const revision = this.submissionRevision;
    if (!submission) return;
    try {
      if (this.session.conversationState === "draft") {
        try { await this.deps.openConversation(this.session, this.lastSubmission?.user.parts.find((part) => part.type === "text")?.text || "新对话"); }
        catch (error) {
          if (!await this.recoverRuntimeSession(error)) throw error;
          await this.deps.openConversation(this.session, this.lastSubmission?.user.parts.find((part) => part.type === "text")?.text || "新对话");
        }
      }
      if (revision !== this.submissionRevision || this.explicitlyClosed) return;
      const requestId = Math.random().toString(36).slice(2, 10); this.activeRequestId = requestId;
      const frame = { id: requestId, init: { method: "POST", body: JSON.stringify({
        chatGrant: await this.validGrant(),
        environment: { schemaVersion: "workspace.mate-environment/v1", revision: 1, host: { appId: "workspace-miniapp", surface: "wechat-miniapp", instanceId: this.instanceId }, location: { kind: "conversation", ref: this.session.conversationId, route: "/pages/chat/index" }, summary: { label: this.session.mate.displayName, state: "active" } },
        // Size is local presentation metadata; preserve the established wire protocol.
        messages: [{ ...submission.user, parts: submission.user.parts.map(({ sizeBytes: _size, ...part }) => part) }], transcriptMode: "server",
        ...(submission.continuationMessageId ? { continuationMessageId: submission.continuationMessageId } : {}),
        selection: this.selection(), trigger: "submit-message"
      }) }, type: "cf_agent_use_chat_request" };
      // The grid may be mid-reconnect here, in which case the socket is intentionally
      // absent. Establishing the connection must happen before the frame is written,
      // otherwise the submission is silently dropped.
      const stillActive = () => !this.explicitlyClosed && revision === this.submissionRevision && this.activeRequestId === requestId && this.streaming;
      if (!stillActive()) return;
      const delivered = await this.deliverSocket(frame, stillActive);
      if (!stillActive()) return;
      if (!delivered) throw new Error("聊天连接不可用，请稍后重试");
      submission.delivered = true;
      this.deliveredRevision += 1;
    } catch (error) { if (revision !== this.submissionRevision || this.explicitlyClosed) return; this.streaming = false; this.activeRequestId = ""; this.emit(error instanceof Error ? error.message : "发送失败，请稍后重试"); }
  }

  private upsertMessage(message: ChatMessage) {
    if (!message?.id || !Array.isArray(message.parts)) return;
    let index = this.messages.findIndex((candidate) => candidate.id === message.id);
    if (index < 0) { const ids = new Set(message.parts.map((part) => part.toolCallId).filter(Boolean)); index = this.messages.findIndex((candidate) => candidate.parts.some((part) => part.toolCallId && ids.has(part.toolCallId))); }
    if (index >= 0) { const next = [...this.messages]; next[index] = { ...message, id: next[index].id }; this.messages = next; } else this.messages = [...this.messages, message];
    this.emit();
  }

  private probeResume() {
    if (!this.socket) return;
    const probeId = Math.random().toString(36).slice(2, 10);
    this.latestResumeRevision = this.deliveredRevision;
    this.resumeProbes.set(probeId, this.deliveredRevision);
    while (this.resumeProbes.size > 16) this.resumeProbes.delete(this.resumeProbes.keys().next().value!);
    this.sendSocket({ type: "cf_agent_stream_resume_request", probeId });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.explicitlyClosed || this.session.conversationState === "draft") return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * (2 ** this.reconnectAttempt++));
    this.connection = "reconnecting"; this.emit();
    this.reconnectTimer = this.deps.setTimeout(() => { this.reconnectTimer = undefined; void this.reconnect(); }, delay);
  }

  /**
   * Reconnects with a fresh runtime token when the current one has lapsed. Without this
   * step an expired token makes every retry fail with 401 and the backoff never escapes.
   */
  private async reconnect() {
    try {
      // Forget any socket left over from the failed attempt so its close handler cannot
      // clobber the connection that is about to replace it.
      this.teardownSocket();
      if (isRuntimeSessionExpired(this.session, this.deps.now())) await this.renewCurrentSession();
      await this.ensureConnected();
    } catch {
      this.scheduleReconnect();
    }
  }

  private async reconcileMessages() {
    const revision = this.submissionRevision;
    try { const messages = await this.deps.loadHistory(this.session, this.grant); if (!this.explicitlyClosed && revision === this.submissionRevision) { this.messages = messages; this.emit(); } }
    catch (error) {
      if (!await this.recoverRuntimeSession(error)) return;
      try { this.grant = await this.deps.obtainGrant(this.session); const messages = await this.deps.loadHistory(this.session, this.grant); if (!this.explicitlyClosed && revision === this.submissionRevision) { this.messages = messages; this.emit(); } } catch { /* retry on next reconnect */ }
    }
  }

  /** @returns whether the frame actually reached the socket. */
  private sendSocket(frame: unknown) {
    if (!this.socket) return false;
    try { this.socket.send({ data: JSON.stringify(frame) }); return true; }
    catch { return false; }
  }

  /** Sends a frame, opening the socket first when it is not connected yet. */
  private async deliverSocket(frame: unknown, shouldSend = () => !this.explicitlyClosed) {
    if (!shouldSend()) return false;
    if (this.sendSocket(frame)) return true;
    await this.ensureConnected();
    if (!shouldSend()) return false;
    return this.sendSocket(frame);
  }

  private async validGrant() {
    if (!this.grant || Date.parse(this.grant.expiresAt) - this.deps.now() < 15_000) {
      try { this.grant = await this.deps.obtainGrant(this.session); }
      catch (error) {
        if (!await this.recoverRuntimeSession(error)) throw error;
        this.grant = await this.deps.obtainGrant(this.session);
      }
    }
    return this.grant.grant;
  }

  /**
   * Renews the runtime session in place. The renewal may be requested concurrently (a
   * reconnect racing a grant refresh), so the previous token guards against the renewer
   * handing the same stale session back.
   */
  private async renewCurrentSession() {
    if (!this.renewSession) throw new Error("runtime_session_renewal_unavailable");
    const tokenBefore = this.session.accessToken;
    const renewed = await this.renewSession(this.session);
    if (renewed.accessToken === tokenBefore) throw new Error("runtime_session_renewal_failed");
    this.session = renewed;
    this.grant = undefined;
    return renewed;
  }

  private async recoverRuntimeSession(error: unknown) {
    if (!this.renewSession || !isRuntimeSessionInvalid(error)) return false;
    try { await this.renewCurrentSession(); return true; }
    catch { return false; }
  }

  private clearApprovalTimer() {
    if (this.approvalTimer) { this.deps.clearTimeout(this.approvalTimer); this.approvalTimer = undefined; }
  }

  private emit(error?: string) { this.listener({ messages: this.messages, streaming: this.streaming, recovering: this.recovering, connection: this.connection, canContinue: !this.streaming && !this.recovering && Boolean(resumableMessage(this.messages)), ...(error ? { error } : {}) }); }
}

export function resetMockMessages() { return [...mockMessages]; }
