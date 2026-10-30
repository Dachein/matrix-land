import { AlertTriangle, ArrowDown, RotateCw } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { UIMessage } from "ai";
import { useWorkspaceMateChat } from "../../../packages/mate-sdk/dist/react.js";
import type { WorkspaceMateCapabilitySelection } from "../../../packages/mate-sdk/dist/chatHost.js";
import type { WorkspaceMateEnvironmentContext } from "../../../sdk/mate/dist/environment.js";
import {
  downloadMateWorkspaceFile,
  requestMateLiveSession,
  requestMatePreviewSession,
  requestMateRuntimeProfile,
  saveMateWorkspaceFileToKnowledge,
  MatePreviewApiError,
  uploadMateAttachment,
  type MatePreviewSession,
  type MateRuntimeCapabilityProfile
} from "./api";
import { chatErrorCategory, chatErrorLabel, chatPauseLabel, safeChatError } from "./chatErrors";
import { setChatCapabilityCategory, toggleChatCapability, type ChatCapabilitySelection } from "./chatSelection";
import { resolveHostedCapabilityProfile } from "./capabilityProfile";
import {
  ChatComposer,
  type ChatAttachmentCapabilities,
  type PendingChatAttachment
} from "./components/ChatComposer";
import type { MateChatTextSize } from "./components/ConversationToolbar";
import { MateMessage } from "./components/MessageRenderer";
import { PendingTurnStatus, type PendingTurn } from "./components/PendingTurnStatus";
import type { RuntimeApprovalState } from "./approvalState";
import { FolderEditApprovals } from "./components/FolderEditApprovals";
import { MateAvatar } from "./components/MateAvatar";
import { createLiveMateEnvironment, createPreviewEnvironment } from "./environment";
import { previewMessageExecution, previewMessageResources, previewMessageTurnProcess, previewTranscriptMessages, previewTurnProcessStatus, type PreviewMessageLike } from "./messageParts";
import { nextPreviewTurnOutcome } from "./outcome";
import type { MateSurfaceSnapshot } from "./surfaceState";
import { mateConversationTitle } from "../../../src/shared/mateConversation";
import { mateAttachmentKind } from "../../../src/shared/mateAttachments";
import type { MatePetMotion } from "../../../src/shared/matePet";
import { useMateLocale, type MateLocale } from "./locale";

import { createChatCredentialManager, isRuntimeAuthenticationError, withChatRecoveryTimeout } from "./sessionRecovery";
import { useChatReturnCheck } from "./useChatReturnCheck";
import { ChatRecoveryDialog } from "./components/ChatRecoveryDialog";
import { attachmentUploadErrorLabel, prepareChatAttachments, type AttachmentUploadFailure } from "./attachments";

export type ChatRecoveryDraft = { text: string; attachments: PendingChatAttachment[] };

const EMPTY_SELECTION: ChatCapabilitySelection = { appIds: [], knowledgeServiceIds: [] };
const ConversationSourcePanel = lazy(() => import("./components/SourcePanel"));
const DebugInspector = lazy(() => import("./components/DebugInspector"));

export type DraftConversationSubmission = {
  attachments: PendingChatAttachment[];
  messageId: string;
  modelId: string;
  selection: ChatCapabilitySelection;
  startedAt: number;
  text: string;
  title: string;
};

export function MateDraftSurface({
  welcomeDescription,
  fetch: fetcher,
  initialSelection,
  onCommit,
  onSnapshot,
  presentation,
  session,
  textSize
}: {
  welcomeDescription?: string;
  fetch?: typeof globalThis.fetch;
  initialSelection?: WorkspaceMateCapabilitySelection;
  onCommit: (submission: DraftConversationSubmission) => Promise<void>;
  onSnapshot: (snapshot: MateSurfaceSnapshot) => void;
  presentation: "embedded" | "standalone";
  session: MatePreviewSession;
  textSize: MateChatTextSize;
}) {
  const { locale, text } = useMateLocale();
  const [attachments, setAttachments] = useState<PendingChatAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [lastError, setLastError] = useState("");
  const [modelId, setModelId] = useState("");
  const [optimisticSubmission, setOptimisticSubmission] = useState<DraftConversationSubmission>();
  const [profile, setProfile] = useState<MateRuntimeCapabilityProfile>();
  const [selection, setSelection] = useState<ChatCapabilitySelection>(EMPTY_SELECTION);
  const previewUrlsRef = useRef(new Set<string>());

  useEffect(() => {
    onSnapshot({
      connection: "connected",
      hydration: "ready",
      lastError: lastError || "none",
      lastOutcome: lastError ? "failed" : "idle",
      messageCount: 0,
      recovering: false,
      streaming: false
    });
  }, [lastError, onSnapshot]);

  useEffect(() => {
    const controller = new AbortController();
    void requestMateRuntimeProfile({ fetch: fetcher, session, signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return;
        const hosted = resolveHostedCapabilityProfile(next, initialSelection);
        setProfile(hosted.profile);
        setModelId(modelForHost(next, initialSelection?.modelId));
        setSelection(hosted.selection);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLastError(safeChatError(error));
      });
    return () => controller.abort();
  }, [fetcher, initialSelection, session]);

  useEffect(() => () => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current.clear();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const messageText = draft.trim() || (attachments.length ? text("请读取并分析这些附件。", "Please read and analyze these attachments.") : "");
    if (!messageText || busy) return;
    const title = mateConversationTitle({
      attachmentNames: attachments.map((attachment) => attachment.file.name),
      text: draft
    });
    if (!title) return;
    const submission: DraftConversationSubmission = {
      attachments,
      messageId: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      modelId,
      selection,
      startedAt: Date.now(),
      text: messageText,
      title
    };
    setBusy(true);
    setDraft("");
    setAttachments([]);
    setOptimisticSubmission(submission);
    setLastError("");
    try {
      await onCommit(submission);
      attachments.forEach((attachment) => revokeAttachmentPreview(attachment, previewUrlsRef.current));
    } catch (error) {
      setBusy(false);
      setDraft(messageText);
      setAttachments(attachments);
      setOptimisticSubmission(undefined);
      setLastError(safeChatError(error));
    }
  }

  function addAttachments(files: File[]) {
    if (session.mode !== "live") return;
    const capabilities = resolveAttachmentCapabilities(profile, session.mode, presentation);
    const { accepted, rejected } = acceptChatAttachments(
      files,
      attachments,
      capabilities,
      previewUrlsRef.current
    );
    setAttachments((current) => [...current, ...accepted]);
    if (rejected) setLastError(attachmentLimitMessage(locale, capabilities));
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) revokeAttachmentPreview(removed, previewUrlsRef.current);
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  return (
    <div className={`tm-preview-workspace is-${presentation}`} data-testid="preview-draft-surface">
      <section className="tm-preview-conversation" aria-label={text("对话草稿", "Conversation draft")}>
        <div className="tm-preview-transcript" data-testid="preview-transcript" data-text-size={textSize} role="log">
          {optimisticSubmission ? (
            <><MateMessage
              message={optimisticSubmissionMessage(optimisticSubmission)}
              mate={session.mate}
              user={session.user}
            /><PendingTurnStatus turn={{ phase: "starting", startedAt: optimisticSubmission.startedAt }} /></>
          ) : (
            <div className="tm-preview-welcome">
              <MateAvatar avatarUrl={session.mate.avatarUrl} className="tm-preview-welcome-avatar" name={session.mate.displayName} />
              <p className="tm-preview-eyebrow">{text("草稿 · 尚未创建", "Draft · not created yet")}</p>
              <h2>{text(`今天想和 ${session.mate.displayName} 讨论什么？`, `What would you like to discuss with ${session.mate.displayName}?`)}</h2>
              <p>{welcomeDescription ?? (session.mate.description || text("发出第一条消息后，才会建立云端对话与 Agent DO。", "The cloud conversation and Agent DO are created only after the first message is sent."))}</p>
            </div>
          )}
        </div>
        {lastError && <div className="tm-preview-profile-error" role="alert">{lastError}</div>}
        <ChatComposer
          attachmentCapabilities={resolveAttachmentCapabilities(profile, session.mode, presentation)}
          attachments={attachments}
          busy={busy}
          canStop={false}
          draft={draft}
          modelId={modelId}
          onAddAttachments={addAttachments}
          onDraftChange={setDraft}
          onModelChange={setModelId}
          onRemoveAttachment={removeAttachment}
          onResume={() => undefined}
          onStop={() => undefined}
          onSubmit={(event) => void submit(event)}
          onSetResources={(kind, ids) => setSelection((current) => setChatCapabilityCategory(current, kind, ids))}
          onToggleResource={(kind, id) => setSelection((current) => toggleChatCapability(current, kind, id))}
          profile={profile}
          selection={selection}
          showResume={false}
          mateName={session.mate.displayName}
        />
      </section>
    </div>
  );
}

export function MateChatSurface({
  welcomeDescription,
  debug,
  endpoint,
  environment: hostEnvironment,
  fetch: fetcher,
  initialSelection,
  initialSubmission,
  initialWorkspaceFileId,
  onDirectoryChange,
  onInitialSubmissionConsumed,
  onReconnect,
  onCloseConversation,
  recoveryDraft,
  onRecoveryDraftConsumed,
  onSourceCountChange,
  onSourcesOpenChange,
  onSnapshot,
  presentation,
  session,
  sourcesActivated,
  sourcesOpen,
  sourcesTarget,
  onFilePreview,
  textSize
}: {
  welcomeDescription?: string;
  debug: boolean;
  endpoint?: string;
  environment?: WorkspaceMateEnvironmentContext;
  fetch?: typeof globalThis.fetch;
  initialSelection?: WorkspaceMateCapabilitySelection;
  initialSubmission?: DraftConversationSubmission;
  initialWorkspaceFileId?: string;
  onDirectoryChange: () => void;
  onInitialSubmissionConsumed: () => void;
  onReconnect: (draft?: ChatRecoveryDraft) => Promise<void>;
  onCloseConversation: () => void;
  recoveryDraft?: ChatRecoveryDraft;
  onRecoveryDraftConsumed?: () => void;
  onSourceCountChange: (count: number) => void;
  onSourcesOpenChange: (open: boolean) => void;
  onSnapshot: (snapshot: MateSurfaceSnapshot) => void;
  presentation: "embedded" | "standalone";
  session: MatePreviewSession;
  sourcesActivated: boolean;
  sourcesOpen: boolean;
  sourcesTarget?: HTMLElement | null;
  onFilePreview?: (name: string, load: () => Promise<Blob>, save?: (folderId: string) => Promise<{ knowledgeFile: { objectId: string; path: string } }>, preview?: () => Promise<Blob>) => void;
  textSize: MateChatTextSize;
}) {
  const { locale, text } = useMateLocale();
  const [draft, setDraft] = useState(recoveryDraft?.text ?? "");
  const [attachments, setAttachments] = useState<PendingChatAttachment[]>(() => (
    withAttachmentPreviews(initialSubmission?.attachments ?? recoveryDraft?.attachments ?? [])
  ));
  const [profile, setProfile] = useState<MateRuntimeCapabilityProfile>();
  const [profileError, setProfileError] = useState("");
  const [selection, setSelection] = useState<ChatCapabilitySelection>(initialSubmission?.selection ?? selectionWithoutProfile(initialSelection));
  const [modelId, setModelId] = useState(initialSubmission?.modelId ?? initialSelection?.modelId ?? "");
  const [lastError, setLastError] = useState("none");
  const [lastOutcome, setLastOutcome] = useState<MateSurfaceSnapshot["lastOutcome"]>("idle");
  const [attachmentUploadFailures, setAttachmentUploadFailures] = useState<AttachmentUploadFailure[]>([]);
  const [preparingSubmission, setPreparingSubmission] = useState(false);
  const submissionInProgress = useRef(false);
  const [approvalStates, setApprovalStates] = useState<RuntimeApprovalState[]>([]);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [connectionIssue, setConnectionIssue] = useState("");
  const recoveryPrompted = useRef(false);
  const chatConnectionFault = useRef("");
  const [pendingTurn, setPendingTurn] = useState<PendingTurn>();
  const explicitCancelRef = useRef(false);
  const credentialRef = useRef(session);
  const previewUrlsRef = useRef(new Set<string>());
  const initialSubmissionRef = useRef(initialSubmission);
  const initialSubmissionStartedRef = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const lastTranscriptScrollTopRef = useRef(0);
  const [showLatestButton, setShowLatestButton] = useState(false);

  const scrollToLatest = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTop = transcript.scrollHeight;
    lastTranscriptScrollTopRef.current = transcript.scrollTop;
    setShowLatestButton(false);
  }, []);

  function handleTranscriptScroll() {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const atLatest = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 48;
    if (atLatest) {
      followLatestRef.current = true;
      setShowLatestButton(false);
    } else if (transcript.scrollTop < lastTranscriptScrollTopRef.current - 2) {
      followLatestRef.current = false;
      setShowLatestButton(true);
    }
    lastTranscriptScrollTopRef.current = transcript.scrollTop;
  }

  function jumpToLatest() {
    followLatestRef.current = true;
    scrollToLatest();
  }

  if (previewUrlsRef.current.size === 0) {
    attachments.forEach((attachment) => {
      if (attachment.previewUrl) previewUrlsRef.current.add(attachment.previewUrl);
    });
  }

  useEffect(() => { onRecoveryDraftConsumed?.(); }, []);
  useEffect(() => () => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current.clear();
  }, []);


  const environment = useMemo(() => hostEnvironment ?? (session.mode === "preview"
    ? createPreviewEnvironment({
        coordinate: `mate:${session.mate.id}`,
        debug,
        releaseId: session.release.id,
        releaseVersion: session.release.version,
        revision: 1,
        mateId: session.mate.id
      })
    : createLiveMateEnvironment({
        presentation,
        revision: 1,
        mateId: session.mate.id
      })), [debug, hostEnvironment, presentation, session.mode, session.release.id, session.release.version, session.mate.id]);

  const promptRecovery = useCallback((code: string) => {
    setConnectionIssue(code);
    setPendingTurn(undefined);
    if (!recoveryPrompted.current) { recoveryPrompted.current = true; setRecoveryOpen(true); }
  }, []);
  const credentials = useMemo(() => createChatCredentialManager(session, (current) => withChatRecoveryTimeout((signal) => current.mode === "preview"
    ? requestMatePreviewSession({ conversationId: current.conversationId, endpoint, fetch: fetcher, releaseId: current.release.id, mateId: current.mate.id, signal })
    : requestMateLiveSession({ conversationId: current.conversationId, endpoint, fetch: fetcher, mateId: current.mate.id, signal })
  )), [session, endpoint, fetcher]);
  const accessToken = useCallback(async () => {
    try {
      const token = await credentials.accessToken();
      credentialRef.current = credentials.session();
      return token;
    } catch (error) {
      promptRecovery(safeChatError(error));
      throw error;
    }
  }, [credentials, promptRecovery]);

  useEffect(() => {
    const controller = new AbortController();
    setProfileError("");
    void accessToken().then(() => requestMateRuntimeProfile({ fetch: fetcher, session: credentialRef.current, signal: controller.signal }))
      .then((next) => {
        if (controller.signal.aborted) return;
        setProfile(next);
        setModelId((current) => modelForHost(next, current || initialSelection?.modelId));
        setSelection((current) => resolveHostedCapabilityProfile(
          next,
          initialSubmissionRef.current ? current : initialSelection
        ).selection);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          const code = safeChatError(error);
          setProfileError(code);
          if (isRuntimeAuthenticationError(code)) promptRecovery(code);
        }
      });
    return () => controller.abort();
  }, [accessToken, fetcher, initialSelection, promptRecovery]);

  useChatReturnCheck(async (returnSignal) => {
    if (chatConnectionFault.current) {
      setConnectionIssue(chatConnectionFault.current); setPendingTurn(undefined); recoveryPrompted.current = true; setRecoveryOpen(true); return;
    }
    const current = credentials.session();
    if (Date.parse(current.expiresAt) <= Date.now()) {
      setConnectionIssue("runtime_token_expired"); setPendingTurn(undefined); recoveryPrompted.current = true; setRecoveryOpen(true); return;
    }
    try { await withChatRecoveryTimeout((signal) => requestMateRuntimeProfile({ fetch: fetcher, session: current, signal }), returnSignal); }
    catch (error) { if (returnSignal.aborted) return; setConnectionIssue(safeChatError(error)); setPendingTurn(undefined); recoveryPrompted.current = true; setRecoveryOpen(true); }
  });

  const updateOutcome = useCallback((event: Parameters<typeof nextPreviewTurnOutcome>[1]) => {
    if (event === "send" || event === "resume") explicitCancelRef.current = false;
    if (event === "cancel") explicitCancelRef.current = true;
    setLastOutcome((current) => nextPreviewTurnOutcome(
      explicitCancelRef.current && (event === "finish" || event === "error") ? "cancelled" : current,
      event
    ));
  }, []);

  const chat = useWorkspaceMateChat<unknown, UIMessage>({
    accessToken,
    chatOptions: {
      onData: (part) => {
        if (part.type === "data-mate-turn" && (part.data as { execution?: { state?: string } })?.execution?.state === "paused") {
          setPendingTurn(undefined);
          updateOutcome("pause");
        }
      },
      onError: (error) => {
        setLastError(safeChatError(error));
        setPendingTurn(undefined);
        updateOutcome("error");
      },
      onFinish: ({ isAbort, isError }) => {
        if (isError) {
          setPendingTurn(undefined);
          updateOutcome("error");
          return;
        }
        setPendingTurn((current) => isAbort || !current ? undefined : { ...current, completedAt: Date.now(), phase: "completed" });
        updateOutcome(isAbort ? "cancel" : "finish");
      },
      throttle: 50
    },
    conversationId: session.conversationId,
    environment,
    fetch: fetcher,
    mode: session.mode,
    principalKey: session.principalKey,
    releaseId: session.mode === "preview" ? session.release.id : undefined,
    runtimeOrigin: session.runtimeOrigin,
    selection: () => ({
      appIds: selection.appIds,
      knowledgeServiceIds: selection.knowledgeServiceIds,
      ...(modelId ? { modelId } : {})
    }),
    mateId: session.mate.id
  });

  useLayoutEffect(() => {
    if (followLatestRef.current) scrollToLatest();
  }, [chat.messages, pendingTurn, scrollToLatest]);

  useEffect(() => {
    const content = transcriptContentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followLatestRef.current) scrollToLatest();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToLatest]);

  const busy = preparingSubmission || chat.isStreaming || chat.isRecovering || chat.status === "submitted" || chat.status === "streaming";
  useEffect(() => {
    const url = new URL(window.location.href);
    const nonce = url.searchParams.get('remoteMcpReturn');
    const connectionId = url.searchParams.get('remoteMcp');
    const route = new URLSearchParams(url.hash.split('?')[1] || '');
    if (session.mode !== 'live' || busy || !profile || !nonce || !connectionId || connectionId === 'failed'
      || route.get('mate') !== session.mate.id || route.get('conversation') !== session.conversationId) return;
    const key = `mate-mcp-return:${nonce}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, 'consumed');
    url.searchParams.delete('remoteMcpReturn');
    window.history.replaceState(null, '', url);
    void sendSubmission(text(`MCP 授权流程已返回。请核验连接 ${connectionId} 的授权状态，自行测试连接；测试通过后提出启用最少必要工具的方案。`,
      `MCP authorization returned. Verify connection ${connectionId}, test it, and propose enabling the minimum tools needed.`), []);
  }, [busy, profile, session.conversationId, session.mate.id]);
  const previousAssistantIndex = pendingTurn?.previousAssistantId
    ? chat.messages.findIndex((message) => message.id === pendingTurn.previousAssistantId)
    : -1;
  const pendingAssistantId = pendingTurn
    ? [...chat.messages.slice(previousAssistantIndex + 1)].reverse().find((message) => message.role === "assistant")?.id
    : undefined;
  const authenticationError = isRuntimeAuthenticationError(safeChatError(chat.error));
  chatConnectionFault.current = connectionIssue || (chat.connectionError || chat.hydrationError || authenticationError ? safeChatError(chat.connectionError ?? chat.hydrationError ?? chat.error) : "");
  const connection = chat.connectionError || chat.hydrationError || connectionIssue || authenticationError
    ? "error"
    : chat.isRecovering
      ? "recovering"
      : chat.isStreaming || chat.status === "streaming"
        ? "streaming"
        : "connected";
  useEffect(() => {
    const error = chat.connectionError ?? chat.hydrationError ?? chat.error;
    if (!error) return;
    setPendingTurn(undefined);
    const code = safeChatError(error);
    setLastError(code);
    if (isRuntimeAuthenticationError(code)) promptRecovery(code);
  }, [chat.connectionError, chat.hydrationError, chat.error, promptRecovery]);
  const resources = useMemo(
    () => sourcesActivated ? previewMessageResources(chat.messages as PreviewMessageLike[]) : [],
    [chat.messages, sourcesActivated]
  );
  const visibleMessages = previewTranscriptMessages(chat.messages);
  const latestAssistantMessage = [...visibleMessages].reverse().find((message) => message.role === "assistant");
  const latestUserIndex = chat.messages.length - 1 - [...chat.messages].reverse().findIndex((message) => message.role === "user");
  const latestExecution = latestAssistantMessage && chat.messages.indexOf(latestAssistantMessage) > latestUserIndex ? previewMessageExecution(latestAssistantMessage) : undefined;
  const errorCategory = chatErrorCategory(chat);
  const continuationBusyRef = useRef(false);
  const latestAssistantProcess = latestAssistantMessage
    ? previewMessageTurnProcess(latestAssistantMessage as PreviewMessageLike, approvalStates)
    : undefined;
  const latestAssistantMotion: MatePetMotion = avatarMotionForTurn({
    active: busy,
    lastOutcome,
    process: latestAssistantProcess,
    recovering: chat.isRecovering
  });
  const visibleResources = useMemo(
    () => sourcesTarget ? resources.filter((resource) => resource.kind === "artifact" && resource.text.startsWith("/api/workspace-files/")) : resources,
    [resources, sourcesTarget]
  );
  useEffect(() => onSourceCountChange(visibleResources.length), [onSourceCountChange, visibleResources.length]);
  useEffect(() => {
    onSnapshot({
      connection,
      hydration: chat.hydrationError ? "error" : "ready",
      lastError: connectionIssue || (chat.hydrationError ? safeChatError(chat.hydrationError) : lastError),
      lastOutcome: lastOutcome === "idle" && latestExecution?.state === "paused" ? "paused" : lastOutcome,
      messageCount: chat.messages.length,
      recovering: chat.isRecovering,
      streaming: chat.isStreaming
    });
  }, [chat.hydrationError, chat.isRecovering, chat.isStreaming, chat.messages.length, connection, connectionIssue, lastError, lastOutcome, latestExecution?.state, onSnapshot]);

  useEffect(() => {
    const submission = initialSubmissionRef.current;
    if (!submission || initialSubmissionStartedRef.current) return;
    initialSubmissionStartedRef.current = true;
    initialSubmissionRef.current = undefined;
    onInitialSubmissionConsumed();
    void sendSubmission(submission.text, attachments, submission.messageId);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const messageText = draft.trim() || (attachments.length ? text("请读取并分析这些附件。", "Please read and analyze these attachments.") : "");
    if (!messageText || busy) return;
    await sendSubmission(messageText, attachments);
  }

  async function sendSubmission(text: string, pendingAttachments: PendingChatAttachment[], messageId?: string) {
    if (submissionInProgress.current) return;
    submissionInProgress.current = true;
    setPreparingSubmission(true);
    followLatestRef.current = true;
    scrollToLatest();
    setPendingTurn({
      phase: "preparing",
      previousAssistantId: [...chat.messages].reverse().find((message) => message.role === "assistant")?.id,
      startedAt: messageId && initialSubmission?.messageId === messageId ? initialSubmission.startedAt : Date.now()
    });
    setDraft("");
    setAttachments([]);
    setLastError("none");
    setAttachmentUploadFailures([]);
    let preparedAttachments = pendingAttachments;
    try {
      if (pendingAttachments.length) {
        // Upload failures stay in the composer, outside the chat SDK's error and
        // continuation state. Capture credentials once for the whole batch.
        const uploadSession = credentialRef.current;
        const scope = JSON.stringify([uploadSession.runtimeOrigin, uploadSession.mate.id, uploadSession.principalKey]);
        let token: Promise<string> | undefined;
        const prepared = await prepareChatAttachments(pendingAttachments, scope, async (file) => uploadMateAttachment({
          accessToken: await (token ??= accessToken()),
          fetch: fetcher,
          file,
          session: credentialRef.current
        }));
        preparedAttachments = prepared.pending;
        if (prepared.failures.length) {
          setPendingTurn(undefined);
          setDraft((current) => current.trim() ? current : text);
          setAttachments(prepared.pending);
          setAttachmentUploadFailures(prepared.failures);
          return;
        }
      }
      const uploaded = preparedAttachments.flatMap((attachment) => attachment.uploaded ? [attachment.uploaded.file] : []);
      setPreparingSubmission(false);
      updateOutcome("send");
      await chat.sendMessage(text, {
        files: uploaded.map((file) => ({
          filename: file.fileName,
          mediaType: file.mediaType,
          type: "file" as const,
          url: file.rawUrl
        })),
        ...(messageId ? { messageId } : {})
      });
      onDirectoryChange();
      pendingAttachments.forEach((attachment) => revokeAttachmentPreview(attachment, previewUrlsRef.current));
    } catch (error) {
      setPendingTurn(undefined);
      setDraft((current) => current.trim() ? current : text);
      setAttachments((current) => current.length ? current : preparedAttachments);
      setLastError(safeChatError(error));
      updateOutcome("error");
    } finally {
      submissionInProgress.current = false;
      setPreparingSubmission(false);
    }
  }

  function addAttachments(files: File[]) {
    if (session.mode !== "live") return;
    const capabilities = resolveAttachmentCapabilities(profile, session.mode, presentation);
    const { accepted, rejected } = acceptChatAttachments(
      files,
      attachments,
      capabilities,
      previewUrlsRef.current
    );
    setAttachments((current) => [...current, ...accepted]);
    if (rejected) setLastError(attachmentLimitMessage(locale, capabilities));
  }

  function removeAttachment(id: string) {
    setAttachmentUploadFailures((current) => current.filter((failure) => failure.id !== id));
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) revokeAttachmentPreview(removed, previewUrlsRef.current);
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  async function downloadWorkspaceFile(url: string, fileName: string) {
    if (session.mode !== "live") return;
    try {
      const blob = await downloadMateWorkspaceFile({
        accessToken: await accessToken(),
        fetch: fetcher,
        session: credentialRef.current,
        url
      });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = fileName || "mate-file";
      anchor.rel = "noreferrer";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (error) {
      setLastError(safeChatError(error));
    }
  }

  const loadWorkspaceFile = useCallback(async (url: string) => downloadMateWorkspaceFile({
    accessToken: await accessToken(), fetch: fetcher, session: credentialRef.current, url
  }), [accessToken, fetcher]);

  async function saveWorkspaceFile(url: string, folderId: string) {
    if (session.mode !== "live") return false;
    try {
      await saveMateWorkspaceFileToKnowledge({
        accessToken: await accessToken(),
        fetch: fetcher,
        session: credentialRef.current,
        url,
        parentObjectId: folderId
      });
      setLastError("");
      return true;
    } catch (error) {
      setLastError(safeChatError(error));
      return false;
    }
  }

  function previewWorkspaceFile(url: string, name: string) {
    onFilePreview?.(
      name,
      async () => downloadMateWorkspaceFile({ accessToken: await accessToken(), fetch: fetcher, session: credentialRef.current, url }),
      /^\/api\/workspace-files\/art_[0-9a-f-]{36}\/(raw|download)$/.test(url)
        ? async (folderId: string) => saveMateWorkspaceFileToKnowledge({ accessToken: await accessToken(), fetch: fetcher, session: credentialRef.current, url, parentObjectId: folderId })
        : undefined,
      /\.(docx|xlsx|xls|xlsb|xlsm|ods|odt|numbers)$/i.test(name)
        ? async () => downloadMateWorkspaceFile({ accessToken: await accessToken(), fetch: fetcher, session: credentialRef.current, url, previewName: name })
        : undefined
    );
  }
  const openedWorkspaceFileRef = useRef("");
  useEffect(() => {
    if (!initialWorkspaceFileId || !onFilePreview || session.mode !== "live" || openedWorkspaceFileRef.current === initialWorkspaceFileId) return;
    openedWorkspaceFileRef.current = initialWorkspaceFileId;
    previewWorkspaceFile(`/api/workspace-files/${initialWorkspaceFileId}/raw`, text("文件预览", "File preview"));
  }, [initialWorkspaceFileId, onFilePreview, session.mode]);

  function openWorkspaceLink(event: ReactMouseEvent<HTMLElement>) {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!anchor) return;
    let url: URL;
    try { url = new URL(anchor.href, window.location.origin); }
    catch { return; }
    if (url.origin !== window.location.origin && url.origin !== "https://ai.example.invalid") return;
    if (!/^\/api\/workspace-files\/[A-Za-z0-9_.%-]{1,540}\/(?:raw|download)$/.test(url.pathname)) return;
    event.preventDefault();
    const fileName = anchor.textContent?.trim() || text("文件", "File");
    if (onFilePreview) previewWorkspaceFile(url.pathname, fileName);
    else void downloadWorkspaceFile(url.pathname, fileName);
  }

  async function stop() {
    setPendingTurn(undefined);
    updateOutcome("cancel");
    await chat.stop().catch(() => undefined);
  }

  async function resume() {
    if (continuationBusyRef.current || busy) return;
    continuationBusyRef.current = true;
    chat.clearError();
    setLastError("none");
    updateOutcome("resume");
    try {
      if (chat.isServerStreaming) await chat.resumeStream();
      else {
        const lastUserIndex = chat.messages.length - 1 - [...chat.messages].reverse().findIndex((message) => message.role === "user");
        const assistant = [...chat.messages.slice(lastUserIndex + 1)].reverse().find((message) => message.role === "assistant");
        if (assistant) {
          await chat.sendMessage(text("继续执行上一个任务，从已保存的进度继续。", "Continue the previous task from the saved progress."), { continuationMessageId: assistant.id });
        } else {
          const user = chat.messages[lastUserIndex];
          if (!user) { setLastOutcome("idle"); return; }
          const original = user.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
          await chat.sendMessage(original, { files: user.parts.filter((part) => part.type === "file").map((part) => ({ ...part, filename: part.filename ?? "attachment" })) });
        }
      }
    } catch (error) {
      setLastError(safeChatError(error));
      updateOutcome("error");
    } finally { continuationBusyRef.current = false; }
  }

  function reconnectCurrentConversation() { return onReconnect({ text: draft, attachments }); }

  function recoverFromError() {
    if (chat.connectionError || chat.hydrationError || connectionIssue || authenticationError) {
      setRecoveryOpen(true);
      return;
    }
    chat.clearError();
    setLastError("none");
    setLastOutcome("idle");
  }

  return (
    <div className={`${sourcesOpen && presentation === "standalone" ? "tm-preview-workspace has-sources" : "tm-preview-workspace"} is-${presentation}`} data-testid="preview-sdk-surface">
      <section className="tm-preview-conversation" aria-label={session.mode === "preview" ? text("Preview 对话", "Preview conversation") : text("Mate 对话", "Mate conversation")}>
        <div className="tm-preview-transcript-shell">
          <div className="tm-preview-transcript" data-testid="preview-transcript" data-text-size={textSize} onClick={openWorkspaceLink} onScroll={handleTranscriptScroll} ref={transcriptRef} role="log">
            <div ref={transcriptContentRef}>
              {chat.messages.length === 0 && !pendingTurn ? (
                <div className="tm-preview-welcome">
                  <MateAvatar avatarUrl={session.mate.avatarUrl} className="tm-preview-welcome-avatar" motion="waving" name={session.mate.displayName} />
                  <p className="tm-preview-eyebrow">{text("Release 固定对话", "Release-pinned conversation")}</p>
                  <h2>{session.mode === "preview" ? text(`测试 ${session.mate.displayName}`, `Test ${session.mate.displayName}`) : text(`今天想和 ${session.mate.displayName} 讨论什么？`, `What would you like to discuss with ${session.mate.displayName}?`)}</h2>
                  <p>{session.mode === "preview" ? text("这里连接候选 Release 的独立 Preview 空间；Live 产品数据不会被修改。", "This is an isolated Preview namespace for the candidate release. Live product data will not be changed.") : welcomeDescription ?? (session.mate.description || text("这是当前用户的独立云端 Agent 对话。", "This is the current user's private cloud Agent conversation."))}</p>
                </div>
              ) : visibleMessages.map((message, index) => (
                <MateMessage
                  active={busy && index === visibleMessages.length - 1 && message.role === "assistant"}
                  key={message.id}
                  approvals={approvalStates}
                  message={message}
                  onLoadFile={session.mode === "live" ? loadWorkspaceFile : undefined}
                  onOpenFile={session.mode === "live" ? onFilePreview ? previewWorkspaceFile : (url, name) => { void downloadWorkspaceFile(url, name); } : undefined}
                  pendingTurn={message.id === pendingAssistantId ? pendingTurn : undefined}
                  motion={message.id === latestAssistantMessage?.id ? latestAssistantMotion : "idle"}
                  mate={session.mate}
                  user={session.user}
                />
              ))}
              {pendingTurn && !pendingAssistantId && <PendingTurnStatus turn={pendingTurn} />}
              <FolderEditApprovals session={session} accessToken={accessToken} fetcher={fetcher}
                refreshKey={`${chat.messages.length}:${busy}`} conversationId={session.conversationId} onStateChange={setApprovalStates} />
            </div>
          </div>
          {showLatestButton && <button aria-label={text("回到最新对话", "Go to latest message")} className="tm-preview-jump-latest" onClick={jumpToLatest} type="button"><ArrowDown size={15} />{text("回到最新对话", "Latest message")}</button>}
        </div>

        {recoveryOpen && <ChatRecoveryDialog onClose={onCloseConversation} onReconnect={reconnectCurrentConversation} />}
        {(chat.error || chat.connectionError || chat.hydrationError || connectionIssue || lastOutcome === "failed") && (
          <div className="tm-preview-inline-error" role="alert">
            <AlertTriangle size={16} />
            <span title={chat.error || chat.connectionError || chat.hydrationError ? safeChatError(chat.connectionError ?? chat.hydrationError ?? chat.error) : lastError}>{chatErrorLabel(connectionIssue || authenticationError ? "connection" : errorCategory ?? "reply", locale === "en")}</span>
            <button onClick={recoverFromError} type="button">
              <RotateCw size={14} />{chat.connectionError || chat.hydrationError || connectionIssue || authenticationError ? text("重新连接", "Reconnect") : text("继续对话", "Continue")}
            </button>
          </div>
        )}
        {profileError && <div className="tm-preview-profile-error" role="status">{text("资源目录暂不可用：", "Resource directory unavailable: ")}{profileError}</div>}

        {attachmentUploadFailures.length > 0 && <div className="tm-preview-inline-error" data-testid="preview-attachment-upload-error" role="alert">
          <AlertTriangle aria-hidden="true" size={16} />
          <span>{attachmentUploadErrorLabel(attachmentUploadFailures, locale === "en")}</span>
          <button disabled={busy} onClick={() => void sendSubmission(draft.trim() || text("请读取并分析这些附件。", "Please read and analyze these attachments."), attachments)} type="button">
            <RotateCw aria-hidden="true" size={14} />{text("重试上传", "Retry upload")}
          </button>
        </div>}

        {latestExecution?.state === "paused" && !busy && <div className="tm-preview-paused-status" role="status">{chatPauseLabel(latestExecution.reason, locale === "en")}</div>}

        <ChatComposer
          attachmentCapabilities={resolveAttachmentCapabilities(profile, session.mode, presentation)}
          attachments={attachments}
          busy={busy}
          canStop={!preparingSubmission}
          draft={draft}
          modelId={modelId}
          onAddAttachments={addAttachments}
          onDraftChange={setDraft}
          onModelChange={setModelId}
          onRemoveAttachment={removeAttachment}
          onResume={() => void resume()}
          onStop={() => void stop()}
          onSubmit={(event) => void submit(event)}
          onSetResources={(kind, ids) => setSelection((current) => setChatCapabilityCategory(current, kind, ids))}
          onToggleResource={(kind, id) => setSelection((current) => toggleChatCapability(current, kind, id))}
          profile={profile}
          selection={selection}
          showResume={latestExecution?.state === "paused" || lastOutcome === "cancelled" || lastOutcome === "failed"}
          mateName={session.mate.displayName}
        />
      </section>

      {presentation === "standalone" && sourcesOpen && (sourcesTarget ? createPortal(
        <Suspense fallback={<SourcePanelFallback />}>
          <ConversationSourcePanel
            downloadsEnabled={session.mode === "live"}
            filesOnly
            onClose={() => onSourcesOpenChange(false)}
            onPreview={onFilePreview ? previewWorkspaceFile : undefined}
            onDownload={(url, fileName) => void downloadWorkspaceFile(url, fileName)}
            resources={visibleResources}
          />
        </Suspense>, sourcesTarget
      ) : (
        <Suspense fallback={<SourcePanelFallback />}>
          <ConversationSourcePanel
            downloadsEnabled={session.mode === "live"}
            onClose={() => onSourcesOpenChange(false)}
            onPreview={onFilePreview ? previewWorkspaceFile : undefined}
            onDownload={(url, fileName) => void downloadWorkspaceFile(url, fileName)}
            onSave={saveWorkspaceFile}
            resources={resources}
          />
        </Suspense>
      ))}

      {presentation === "standalone" && session.mode === "preview" && debug && (
        <Suspense fallback={<DebugFallback />}>
          <DebugInspector
            connection={connection}
            isRecovering={chat.isRecovering}
            isStreaming={chat.isStreaming}
            lastError={lastError}
            lastOutcome={lastOutcome}
            messageCount={chat.messages.length}
            onReconnect={() => { void reconnectCurrentConversation().catch(() => setRecoveryOpen(true)); }}
            session={session}
          />
        </Suspense>
      )}
    </div>
  );
}

function avatarMotionForTurn({ active, lastOutcome, process, recovering }: {
  active: boolean;
  lastOutcome: MateSurfaceSnapshot["lastOutcome"];
  process?: ReturnType<typeof previewMessageTurnProcess>;
  recovering: boolean;
}): MatePetMotion {
  if (recovering) return "running-left";
  if (process && previewTurnProcessStatus(active, process) === "waiting") return "waiting";
  if (active) {
    const latestStep = process?.steps.at(-1);
    return latestStep?.kind === "reasoning" ? "review" : "running";
  }
  if (lastOutcome === "paused") return "waiting";
  if (lastOutcome === "failed") return "failed";
  if (lastOutcome === "completed") return "jumping";
  if (lastOutcome === "cancelled") return "review";
  if (lastOutcome === "resuming") return "running-right";
  return "idle";
}

function SourcePanelFallback() {
  const { text } = useMateLocale();
  return <aside className="tm-preview-sources tm-preview-lazy-panel" aria-label={text("正在加载文件与来源", "Loading files and sources")}>{text("正在加载文件与来源…", "Loading files and sources…")}</aside>;
}

function DebugFallback() {
  const { text } = useMateLocale();
  return <aside className="tm-preview-debug tm-preview-lazy-panel" aria-label={text("正在加载调试面板", "Loading debug panel")}>{text("调试面板…", "Debug…")}</aside>;
}

function isSupportedAttachment(file: File, capabilities: ChatAttachmentCapabilities) {
  const kind = mateAttachmentKind(file.name, file.type);
  return kind === "image" ? capabilities.images : kind === "document" && capabilities.documents;
}

function withAttachmentPreviews(attachments: PendingChatAttachment[]) {
  return attachments.map(({ file, id }) => {
    const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
    return { file, id, ...(previewUrl ? { previewUrl } : {}) };
  });
}

export function acceptChatAttachments(
  files: File[],
  current: PendingChatAttachment[],
  capabilities: ChatAttachmentCapabilities,
  previewUrls: Set<string>
) {
  const supported = files.filter((file) => isSupportedAttachment(file, capabilities));
  const accepted: PendingChatAttachment[] = [];
  for (const file of supported) {
    if (current.length + accepted.length >= 5 || file.size <= 0 || file.size > 20 * 1024 * 1024) continue;
    const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
    if (previewUrl) previewUrls.add(previewUrl);
    accepted.push({ file, id: crypto.randomUUID(), ...(previewUrl ? { previewUrl } : {}) });
  }
  return { accepted, rejected: accepted.length !== files.length };
}

export function resolveAttachmentCapabilities(
  profile: MateRuntimeCapabilityProfile | undefined,
  mode: MatePreviewSession["mode"],
  presentation: "embedded" | "standalone"
): ChatAttachmentCapabilities {
  const live = mode === "live";
  const tools = new Set(profile?.tools.map((tool) => tool.id) ?? []);
  const images = live && Boolean(
    profile?.models.multimodal.imageInput
    || tools.has("ocr")
    || tools.has("document_read")
  );
  const documents = live && tools.has("document_read");
  return {
    documents,
    images,
    paste: presentation === "standalone" && images
  };
}

function optimisticSubmissionMessage(submission: DraftConversationSubmission): UIMessage {
  return {
    id: submission.messageId,
    role: "user",
    parts: [
      { text: submission.text, type: "text" },
      ...submission.attachments.map(({ file, previewUrl }) => ({
        filename: file.name,
        mediaType: file.type || "application/octet-stream",
        type: "file" as const,
        url: previewUrl || file.name
      }))
    ]
  };
}

function revokeAttachmentPreview(attachment: PendingChatAttachment, previewUrls: Set<string>) {
  if (!attachment.previewUrl) return;
  URL.revokeObjectURL(attachment.previewUrl);
  previewUrls.delete(attachment.previewUrl);
}

function attachmentLimitMessage(locale: MateLocale, capabilities: ChatAttachmentCapabilities) {
  const kinds = capabilities.documents
    ? locale === "en" ? "images, PDF, Word (.docx), Excel, Markdown, TXT, CSV and common office files" : "图片、PDF、Word（.docx）、Excel、Markdown、TXT、CSV 与常见办公文件"
    : locale === "en" ? "PNG, JPEG, GIF, WebP, BMP, and SVG images" : "PNG、JPEG、GIF、WebP、BMP 与 SVG 图片";
  return locale === "en"
    ? `Some attachments were not added. Supported: ${kinds}; 20 MiB per file, up to 5 files.`
    : `部分附件未加入：支持${kinds}；单个 20 MiB、最多 5 个。`;
}

function selectionWithoutProfile(selection?: WorkspaceMateCapabilitySelection): ChatCapabilitySelection {
  return {
    appIds: selection?.appIds ?? [],
    knowledgeServiceIds: selection?.knowledgeServiceIds ?? []
  };
}

function modelForHost(profile: MateRuntimeCapabilityProfile, candidate?: string) {
  return candidate && profile.models.allowed.some((model) => model.id === candidate)
    ? candidate
    : profile.models.defaultModel;
}
