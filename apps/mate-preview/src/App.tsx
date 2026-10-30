import { AlertTriangle, ArrowLeft, ExternalLink, MessageCircleMore, MessageSquarePlus, RefreshCw, RotateCw, Wifi, X } from "lucide-react";
import { Component, startTransition, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { UIMessage } from "ai";
import {
  clearWorkspaceMateConversationCache,
  clearWorkspaceMateConversationCacheScope,
  readWorkspaceMateConversationCache
} from "../../../packages/mate-sdk/dist/react.js";
import { workspaceMateWorkspaceUrl } from "../../../packages/mate-sdk/dist/embed.js";
import type { WorkspaceMateCapabilitySelection } from "../../../packages/mate-sdk/dist/chatHost.js";
import type { WorkspaceMateEnvironmentContext } from "../../../sdk/mate/dist/environment.js";
import {
  clearPreviewConversationCoordinate,
  clearMatePreviewData,
  createMateConversation,
  deleteMateConversation,
  readPreviewConversationCoordinate,
  requestMateLiveSession,
  requestMatePreviewSession,
  storePreviewConversationCoordinate,
  MatePreviewApiError,
  updateMateConversation,
  type MatePreviewSession
} from "./api";
import {
  MateChatSurface,
  MateDraftSurface,
  type ChatRecoveryDraft,
  type DraftConversationSubmission
} from "./ChatSurface";
import { safeChatError } from "./chatErrors";
import { withChatRecoveryTimeout } from "./sessionRecovery";
import { browserDirectoryStorage, clearMateDirectoryCache } from "./directoryCache";
import { ConversationTransitionSurface } from "./components/ConversationTransitionSurface";
import { WeixinBindingDialog } from "./components/WeixinBindingDialog";
import { StandaloneNavigation, type ConversationDirectoryAction } from "./components/StandaloneNavigation";
import { MateAvatar, UserAvatar } from "./components/MateAvatar";
import { PendingTurnStatus } from "./components/PendingTurnStatus";
import workspaceConnectionLogo from "../../../src/assets/workspace-ai-mcp-mono.svg";
import {
  ConversationTopbarControls,
  readMateChatTextSize,
  storeMateChatTextSize,
  type MateChatTextSize
} from "./components/ConversationToolbar";
import {
  readPreviewHostRoute
} from "./environment";
import {
  connectMateEmbedFrame,
  mergeMateEmbedConfiguration,
  type MateEmbedFrameBridge
} from "./embedBridge";
import type { WorkspaceMateEmbedConfigureMessage } from "../../../packages/mate-sdk/dist/embedProtocol.js";
import { PreviewOperationsSurface } from "./OperationsSurface";
import { INITIAL_SURFACE_SNAPSHOT, type MateSurfaceSnapshot } from "./surfaceState";
import { MateLaunchGate } from "./MateLaunchGate";
import { MateLocaleProvider, useMateLocale, type MateLocale } from "./locale";
import { MailTasksSurface } from "./MailTasksSurface";
import "./styles.css";

export type MatePreviewAppProps = {
  locale?: MateLocale;
  onLocaleChange?: (locale: MateLocale) => void;
  welcomeDescription?: string;
  avatarUrl?: string;
  conversationId?: string;
  debug?: boolean;
  embedInstanceId?: string;
  initialWorkspaceFileId?: string;
  endpoint?: string;
  environment?: WorkspaceMateEnvironmentContext;
  fetch?: typeof globalThis.fetch;
  mode?: "live" | "preview";
  onExit?: () => void;
  onPortalArtifactChange?: (open: boolean) => void;
  onPortalConversationCountChange?: (count: number) => void;
  onPortalSourceCountChange?: (count: number) => void;
  portalArtifactOpen?: boolean;
  portalNavigationTarget?: HTMLElement | null;
  portalNewConversationTarget?: HTMLElement | null;
  portalSourcesTarget?: HTMLElement | null;
  onPortalFilePreview?: (name: string, load: () => Promise<Blob>, save?: (folderId: string) => Promise<{ knowledgeFile: { objectId: string; path: string } }>, preview?: () => Promise<Blob>) => void;
  portalStatusTarget?: HTMLElement | null;
  portalSummary?: boolean;
  portalMailTaskMode?: boolean;
  portalMateEmail?: string;
  onPortalTaskSelect?: () => void;
  onPortalTaskCountChange?: (count: number) => void;
  onPortalMailTaskModeChange?: (active: boolean) => void;
  presentation?: "embedded" | "standalone";
  releaseId?: string;
  selection?: WorkspaceMateCapabilitySelection;
  mateId?: string;
};

export function MatePreviewApp(props: MatePreviewAppProps = {}) {
  return <MateLocaleProvider locale={props.locale} onLocaleChange={props.onLocaleChange}><MatePreviewAppContent {...props} /></MateLocaleProvider>;
}

function MatePreviewAppContent(props: MatePreviewAppProps = {}) {
  const { locale, text } = useMateLocale();
  const mode = props.mode ?? "preview";
  const presentation = props.presentation ?? "standalone";
  const browserRoute = typeof window === "undefined" ? undefined : readPreviewHostRoute(window.location);
  const mateId = props.mateId ?? browserRoute?.mateId ?? "";
  const releaseId = props.releaseId ?? browserRoute?.releaseId ?? "";
  const debug = props.debug ?? browserRoute?.debug ?? false;
  const embedInstanceId = props.embedInstanceId ?? "";
  const coordinateReleaseKey = mode === "preview" ? releaseId : "live";
  const [activeChannel, setActiveChannel] = useState("");
  const [bootRevision, setBootRevision] = useState(0);
  const [directoryRevision, setDirectoryRevision] = useState(0);
  const [directoryTitles, setDirectoryTitles] = useState<Record<string, string>>({});
  const [mountRevision, setMountRevision] = useState(0);
  const [recoveryDraft, setRecoveryDraft] = useState<{ conversationId: string; draft: ChatRecoveryDraft }>();
  const [pendingSubmission, setPendingSubmission] = useState<DraftConversationSubmission>();
  const [conversationActionError, setConversationActionError] = useState("");
  const [switchingConversationId, setSwitchingConversationId] = useState("");
  const [switchingMessages, setSwitchingMessages] = useState<UIMessage[]>([]);
  const [clearingPreview, setClearingPreview] = useState(false);
  const [chatTextSize, setChatTextSize] = useState<MateChatTextSize>(readMateChatTextSize);
  const [chatSourcesActivated, setChatSourcesActivated] = useState(false);
  const [chatSourcesOpen, setChatSourcesOpen] = useState(false);
  const sourcesOpen = props.portalArtifactOpen ?? chatSourcesOpen;
  useEffect(() => { if (props.portalArtifactOpen) setChatSourcesActivated(true); }, [props.portalArtifactOpen]);
  const changeSourcesOpen = (open: boolean) => {
    setChatSourcesOpen(open);
    if (open) setChatSourcesActivated(true);
    props.onPortalArtifactChange?.(open);
  };
  const [chatSourceCount, setChatSourceCount] = useState(0);
  useEffect(() => props.onPortalSourceCountChange?.(chatSourceCount), [chatSourceCount, props.onPortalSourceCountChange]);
  const [weixinOpen, setWeixinOpen] = useState(false);
  const [embedConfiguration, setEmbedConfiguration] = useState<WorkspaceMateEmbedConfigureMessage>();
  const [boot, setBoot] = useState<
    | { phase: "error"; error: MatePreviewApiError }
    | { phase: "loading" }
    | { phase: "ready"; session: MatePreviewSession }
  >({ phase: "loading" });
  const [defaultMateAvatar, setDefaultMateAvatar] = useState<{ id: string; avatarUrl: string }>();
  const [snapshot, setSnapshot] = useState(INITIAL_SURFACE_SNAPSHOT);
  const snapshotKeyRef = useRef("");
  const reconnectRequestRef = useRef<Promise<void> | undefined>(undefined);
  const conversationRequestRef = useRef<AbortController | undefined>(undefined);
  const embedBridgeRef = useRef<MateEmbedFrameBridge | undefined>(undefined);
  const configuredConversationId = embedConfiguration?.conversationId ?? props.conversationId;
  const embedConfigurationReady = Boolean(embedConfiguration);
  const hostEnvironment = embedConfiguration?.environment ?? props.environment;
  const hostSelection = embedConfiguration?.selection ?? props.selection;

  useEffect(() => {
    if (boot.phase !== "loading" || props.avatarUrl || !mateId || presentation !== "standalone") return undefined;
    const controller = new AbortController();
    void (props.fetch ?? fetch)("/api/apps/mates/default", { signal: controller.signal })
      .then((response) => response.ok ? response.json() : undefined)
      .then((payload: { mate?: { id?: string; avatarUrl?: string } } | undefined) => {
        if (!controller.signal.aborted && payload?.mate?.id === mateId && payload.mate.avatarUrl) {
          setDefaultMateAvatar({ id: mateId, avatarUrl: payload.mate.avatarUrl });
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [boot.phase, presentation, props.avatarUrl, props.fetch, mateId]);

  const requestSession = useCallback((input: {
    conversationId?: string;
    newConversation?: boolean;
    signal: AbortSignal;
  }) => mode === "preview" ? requestMatePreviewSession({
    conversationId: input.conversationId,
    endpoint: props.endpoint,
    fetch: props.fetch,
    newConversation: input.newConversation,
    releaseId,
    signal: input.signal,
    mateId
  }) : requestMateLiveSession({
    conversationId: input.conversationId,
    endpoint: props.endpoint,
    fetch: props.fetch,
    newConversation: input.newConversation,
    signal: input.signal,
    mateId
  }), [mode, props.endpoint, props.fetch, releaseId, mateId]);

  useEffect(() => {
    setActiveChannel("");
    setDirectoryTitles({});
    setConversationActionError("");
    setSwitchingMessages([]);
  }, [mateId, releaseId, mode]);

  useEffect(() => () => conversationRequestRef.current?.abort(), []);
  useEffect(() => storeMateChatTextSize(chatTextSize), [chatTextSize]);

  useEffect(() => {
    if (presentation !== "embedded" || !embedInstanceId || !mateId || typeof window === "undefined") {
      embedBridgeRef.current = undefined;
      return undefined;
    }
    const bridge = connectMateEmbedFrame({
      instanceId: embedInstanceId,
      onConfigure: (next) => setEmbedConfiguration((current) => {
        const merged = mergeMateEmbedConfiguration(current, next);
        return current && JSON.stringify(current) === JSON.stringify(merged) ? current : merged;
      }),
      mateId
    });
    embedBridgeRef.current = bridge;
    return () => {
      bridge.close();
      if (embedBridgeRef.current === bridge) embedBridgeRef.current = undefined;
    };
  }, [embedInstanceId, presentation, mateId]);

  useEffect(() => {
    const bridge = embedBridgeRef.current;
    if (!bridge) return;
    bridge.state(boot.phase === "error" ? "error" : boot.phase);
    if (boot.phase === "error") bridge.error(boot.error.code);
    if (boot.phase === "ready") bridge.conversation(boot.session.conversationId);
  }, [boot]);

  useEffect(() => {
    if (!mateId || (mode === "preview" && !releaseId)) {
      setBoot({
        phase: "error",
        error: new MatePreviewApiError(400, mode === "preview" ? "preview_route_invalid" : "live_route_invalid")
      });
      return undefined;
    }
    const hostedEmbed = presentation === "embedded" && Boolean(embedInstanceId);
    if (hostedEmbed && !embedConfigurationReady) {
      setBoot({ phase: "loading" });
      return undefined;
    }
    const controller = new AbortController();
    setBoot({ phase: "loading" });
    setSnapshot(INITIAL_SURFACE_SNAPSHOT);
    const coordinateStorage = browserSessionStorage();
    const storedConversationId = configuredConversationId ?? (hostedEmbed ? undefined : readPreviewConversationCoordinate(
      coordinateStorage,
      mateId,
      coordinateReleaseKey
    ));
    const sessionRequest = requestSession({
      conversationId: storedConversationId,
      newConversation: hostedEmbed && !storedConversationId,
      signal: controller.signal
    });
    void sessionRequest.then((session) => {
      if (!controller.signal.aborted) {
        if (
          mode === "live"
          && presentation === "standalone"
          && configuredConversationId
          && configuredConversationId !== session.conversationId
        ) {
          replaceLiveConversationCoordinate(
            session.conversationState === "persisted" ? session.conversationId : undefined
          );
        }
        if (session.conversationState === "persisted" && session.surface.entries.some((entry) => entry.channel === "sdk")) {
          storePreviewConversationCoordinate(
            coordinateStorage,
            mateId,
            coordinateReleaseKey,
            session.conversationId
          );
        } else {
          clearPreviewConversationCoordinate(coordinateStorage, mateId, coordinateReleaseKey);
        }
        setBoot({ phase: "ready", session });
      }
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setBoot({
        phase: "error",
        error: error instanceof MatePreviewApiError
          ? error
          : new MatePreviewApiError(503, mode === "preview" ? "preview_session_unavailable" : "live_session_unavailable")
      });
    });
    return () => controller.abort();
  }, [bootRevision, configuredConversationId, coordinateReleaseKey, embedConfigurationReady, embedInstanceId, mode, presentation, releaseId, requestSession, mateId]);

  const updateSnapshot = useCallback((next: MateSurfaceSnapshot) => {
    const key = JSON.stringify(next);
    if (key === snapshotKeyRef.current) return;
    snapshotKeyRef.current = key;
    setSnapshot(next);
  }, []);

  const reconnect = useCallback((draft?: ChatRecoveryDraft): Promise<void> => {
    if (reconnectRequestRef.current) return reconnectRequestRef.current;
    if (boot.phase !== "ready") return Promise.reject(new Error("runtime_session_unavailable"));
    const original = boot.session;
    const controller = new AbortController();
    conversationRequestRef.current?.abort();
    conversationRequestRef.current = controller;
    snapshotKeyRef.current = "";
    setSnapshot((current) => ({ ...current, connection: "connecting" }));
    const request = withChatRecoveryTimeout((signal) => requestSession({ conversationId: original.conversationId, signal }), controller.signal).then((next) => {
      if (controller.signal.aborted) throw new Error("runtime_session_recovery_cancelled");
      if (next.conversationId !== original.conversationId || next.principalKey !== original.principalKey
        || next.mate.id !== original.mate.id || next.runtimeOrigin !== original.runtimeOrigin
        || next.release.id !== original.release.id || next.mode !== original.mode) {
        throw new Error("preview_session_refresh_mismatch");
      }
      // Remount only after a fresh session has been obtained; keep unsent input separate from submissions.
      setRecoveryDraft(draft ? { conversationId: original.conversationId, draft } : undefined);
      setBoot({ phase: "ready", session: next });
      setMountRevision((current) => current + 1);
    }).catch((error) => {
      if (!controller.signal.aborted) setSnapshot((current) => ({ ...current, connection: "error", lastError: safeChatError(error) }));
      throw error;
    }).finally(() => {
      if (reconnectRequestRef.current === request) reconnectRequestRef.current = undefined;
    });
    reconnectRequestRef.current = request;
    return request;
  }, [boot, requestSession]);

  if (boot.phase === "loading") {
    return <MateLaunchGate avatarUrl={props.avatarUrl || (defaultMateAvatar?.id === mateId ? defaultMateAvatar.avatarUrl : undefined)} mode={mode} testId="preview-host-loading" />;
  }

  if (boot.phase === "error") {
    return (
      <PreviewGate
        action={<button onClick={() => setBootRevision((value) => value + 1)} type="button"><RefreshCw size={16} />{text("重试", "Retry")}</button>}
        detail={sessionErrorMessage(mode, boot.error, locale)}
        error
        requestId={boot.error.requestId}
        testId="preview-host-error"
        title={mode === "preview" ? text("无法打开 Preview", "Unable to open Preview") : text("无法打开 Mate", "Unable to open Mate")}
      />
    );
  }

  const session = boot.session;
  const defaultEntry = (presentation === "embedded"
    ? session.surface.entries.find((candidate) => candidate.kind === "conversation")
    : session.surface.entries.find((candidate) => candidate.kind === session.surface.kind))
    ?? session.surface.entries[0];
  const entry = session.surface.entries.find((candidate) => candidate.channel === activeChannel)
    ?? defaultEntry;
  const activeSurface = entry?.kind ?? "unavailable";
  const selectEntry = (channel: string) => {
    if (channel === entry?.channel) return;
    setActiveChannel(channel);
    snapshotKeyRef.current = "";
    setSnapshot(INITIAL_SURFACE_SNAPSHOT);
    setMountRevision((current) => current + 1);
  };
  const commitConversationSession = (
    nextSession: MatePreviewSession,
    controller: AbortController,
    options: { cleared?: boolean } = {}
  ) => {
    if (controller.signal.aborted) return;
    conversationRequestRef.current = undefined;
    const storage = browserSessionStorage();
    if (nextSession.conversationState === "persisted") {
      storePreviewConversationCoordinate(
        storage,
        mateId,
        coordinateReleaseKey,
        nextSession.conversationId
      );
    }
    snapshotKeyRef.current = "";
    startTransition(() => {
      setChatSourceCount(0);
      setBoot({ phase: "ready", session: nextSession });
      setActiveChannel(nextSession.surface.entries.find((candidate) => candidate.kind === "conversation")?.channel ?? "");
      setSnapshot(INITIAL_SURFACE_SNAPSHOT);
      setMountRevision((current) => current + 1);
      setSwitchingConversationId("");
      setSwitchingMessages([]);
      setClearingPreview(false);
      if (options.cleared) {
        setDirectoryTitles({});
        setDirectoryRevision((value) => value + 1);
      }
    });
  };
  const transitionConversation = async (input: { conversationId?: string; newConversation?: boolean }) => {
    conversationRequestRef.current?.abort();
    const controller = new AbortController();
    conversationRequestRef.current = controller;
    setConversationActionError("");
    setSwitchingConversationId(input.conversationId ?? "new");
    try {
      const nextSession = await requestSession({ ...input, signal: controller.signal });
      commitConversationSession(nextSession, controller);
    } catch (error) {
      if (controller.signal.aborted) return;
      conversationRequestRef.current = undefined;
      setSwitchingConversationId("");
      setSwitchingMessages([]);
      setConversationActionError(conversationActionMessage(error, locale));
    }
  };
  const selectConversation = (conversationId: string) => {
    if (conversationId === session.conversationId || switchingConversationId) return;
    setSwitchingMessages(readWorkspaceMateConversationCache<UIMessage>({
      conversationId,
      mode: session.mode,
      principalKey: session.principalKey,
      releaseId: session.mode === "preview" ? session.release.id : undefined,
      mateId: session.mate.id
    }) ?? []);
    void transitionConversation({ conversationId });
  };
  const createConversation = () => {
    if (switchingConversationId || clearingPreview) return;
    setSwitchingMessages([]);
    void transitionConversation({ newConversation: true });
  };
  const commitDraftConversation = async (submission: DraftConversationSubmission) => {
    if (session.conversationState !== "draft" || switchingConversationId || clearingPreview) return;
    conversationRequestRef.current?.abort();
    const controller = new AbortController();
    conversationRequestRef.current = controller;
    setConversationActionError("");
    try {
      const draftSession = Date.parse(session.expiresAt) > Date.now() + 30_000
        ? session
        : await requestSession({ newConversation: true, signal: controller.signal });
      if (draftSession.conversationState !== "draft") {
        throw new MatePreviewApiError(502, "conversation_draft_expected");
      }
      await createMateConversation({
        fetch: props.fetch,
        session: draftSession,
        signal: controller.signal,
        title: submission.title
      });
      if (controller.signal.aborted) return;
      clearMateDirectoryCache(browserDirectoryStorage(), draftSession, "conversations");
      setDirectoryTitles((current) => ({
        ...current,
        [draftSession.conversationId]: submission.title
      }));
      setPendingSubmission(submission);
      commitConversationSession({ ...draftSession, conversationState: "persisted" }, controller);
      setDirectoryRevision((value) => value + 1);
    } catch (error) {
      if (controller.signal.aborted) return;
      conversationRequestRef.current = undefined;
      const message = conversationActionMessage(error, locale);
      setConversationActionError(message);
      throw error;
    }
  };
  const clearPreviewRecords = async () => {
    if (mode !== "preview" || clearingPreview || switchingConversationId) return;
    const confirmed = typeof window !== "undefined" && window.confirm(
      text(
        "将删除当前 Mate、当前 Owner 的全部 Preview 对话、任务和 Agent DO 记录。Live 数据及其他用户不受影响。确定继续？",
        "Delete all Preview conversations, tasks, and Agent DO transcripts for this Mate and owner? Live data and other users are not affected."
      )
    );
    if (!confirmed) return;
    conversationRequestRef.current?.abort();
    const controller = new AbortController();
    conversationRequestRef.current = controller;
    setConversationActionError("");
    setClearingPreview(true);
    try {
      await clearMatePreviewData({ fetch: props.fetch, session, signal: controller.signal });
      clearWorkspaceMateConversationCacheScope({
        mode: session.mode,
        principalKey: session.principalKey,
        releaseId: session.release.id,
        mateId: session.mate.id
      });
      clearMateDirectoryCache(browserDirectoryStorage(), session);
      clearPreviewConversationCoordinate(browserSessionStorage(), mateId, coordinateReleaseKey);
      const nextSession = await requestSession({ newConversation: true, signal: controller.signal });
      commitConversationSession(nextSession, controller, { cleared: true });
    } catch (error) {
      if (controller.signal.aborted) return;
      conversationRequestRef.current = undefined;
      setClearingPreview(false);
      setConversationActionError(conversationActionMessage(error, locale));
    }
  };
  const manageConversation = async (action: ConversationDirectoryAction) => {
    if (switchingConversationId || clearingPreview) return;
    setConversationActionError("");
    try {
      if (action.type === "delete") {
        await deleteMateConversation({
          conversationId: action.id,
          fetch: props.fetch,
          session
        });
        clearMateDirectoryCache(browserDirectoryStorage(), session, "conversations");
        clearWorkspaceMateConversationCache({
          conversationId: action.id,
          mode: session.mode,
          principalKey: session.principalKey,
          releaseId: session.mode === "preview" ? session.release.id : undefined,
          mateId: session.mate.id
        });
        setDirectoryTitles((current) => {
          const next = { ...current };
          delete next[action.id];
          return next;
        });
        setDirectoryRevision((value) => value + 1);
        if (action.id === session.conversationId) {
          clearPreviewConversationCoordinate(browserSessionStorage(), mateId, coordinateReleaseKey);
          await transitionConversation({ newConversation: true });
        }
        return;
      }
      const patch = action.type === "rename"
        ? { title: action.title }
        : action.type === "pin"
          ? { pinned: action.pinned }
          : { status: action.status };
      const updated = await updateMateConversation({
        conversationId: action.id,
        fetch: props.fetch,
        patch,
        session
      });
      if (action.type === "rename") {
        setDirectoryTitles((current) => ({ ...current, [action.id]: updated.title }));
      }
      setDirectoryRevision((value) => value + 1);
    } catch (error) {
      setConversationActionError(conversationActionMessage(error, locale));
      throw error;
    }
  };
  return (
    <div
      className="tm-preview-host"
      data-connection-state={snapshot.connection}
      data-hydration-state={snapshot.hydration}
      data-mode={mode}
      data-presentation={presentation}
      data-recovering={String(snapshot.recovering)}
      data-entry-channel={entry?.channel ?? "unavailable"}
      data-surface={activeSurface}
      data-streaming={String(snapshot.streaming)}
      data-testid="mate-preview-host"
    >
      <header className="tm-preview-topbar">
        <div className="tm-preview-heading">
          {presentation === "standalone" && (
            <button
              aria-label={text("返回 Mate", "Back to Mate")}
              className="tm-preview-icon-button"
              onClick={props.onExit ?? defaultExit}
              type="button"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <MateAvatar
            avatarUrl={session.mate.avatarUrl}
            ambientWalk
            className="tm-preview-avatar"
            motion={snapshot.streaming ? "running" : snapshot.recovering || snapshot.connection !== "connected" ? "waiting" : snapshot.lastOutcome === "failed" ? "failed" : snapshot.lastOutcome === "completed" ? "jumping" : snapshot.lastOutcome === "cancelled" ? "review" : snapshot.lastOutcome === "resuming" ? "running-right" : snapshot.messageCount === 0 ? "waving" : "idle"}
            name={session.mate.displayName}
          />
          <div>
            <span className="tm-preview-eyebrow">Mate 3.0{presentation === "embedded" ? ` · ${text("嵌入式", "Embedded")}` : mode === "preview" ? ` · ${text("所有者预览", "Owner Preview")}` : ""}</span>
            <h1>{session.mate.displayName}</h1>
            <p>{session.mate.jobRole || session.mate.description || text("候选 Release 验证", "Candidate release validation")}</p>
          </div>
        </div>
        {!props.portalMailTaskMode && <PortalSlot target={props.portalStatusTarget}><div className="tm-preview-topbar-status">
          {presentation === "embedded" && activeSurface === "conversation" && (
            <button
              aria-label={text("新对话", "New conversation")}
              className="tm-preview-new-conversation"
              disabled={Boolean(switchingConversationId || clearingPreview)}
              onClick={createConversation}
              title={text("新对话", "New conversation")}
              type="button"
            >
              <MessageSquarePlus size={15} />
            </button>
          )}
          {presentation === "embedded" && (
            <button
              aria-label={text("在 Mate 工作台中继续", "Continue in Mate workspace")}
              className="tm-preview-workspace-link"
              onClick={() => {
                const conversationId = session.conversationState === "persisted" ? session.conversationId : undefined;
                if (embedBridgeRef.current) {
                  embedBridgeRef.current.openWorkspace(conversationId);
                  return;
                }
                window.open(workspaceMateWorkspaceUrl({
                  conversationId,
                  origin: window.location.origin,
                  mateId
                }), "_blank", "noopener,noreferrer");
              }}
              type="button"
              title={text("在 Mate 工作台中继续", "Continue in Mate workspace")}
            >
              <ExternalLink size={15} />
            </button>
          )}
          {presentation === "standalone" && activeSurface === "conversation" && (
            <ConversationTopbarControls
              filesDisabled={session.conversationState === "draft"}
              onToggleSources={() => {
                changeSourcesOpen(!sourcesOpen);
              }}
              resourceCount={chatSourceCount}
              sourcesActivated={chatSourcesActivated}
              sourcesOpen={sourcesOpen}
            />
          )}
          {mode === "live" && presentation === "standalone" && (
            <button
              aria-label={text("通过微信访问", "Access through WeChat")}
              className="tm-preview-weixin-button"
              onClick={() => setWeixinOpen(true)}
              title={text("扫码登录小程序或连接微信 Q-Claw", "Scan to sign in to the miniapp or connect WeChat Q-Claw")}
              type="button"
            >
              <MessageCircleMore size={14} /><span>{props.portalStatusTarget ? text("在微信继续：点击扫码", "Continue in WeChat: scan QR") : text("微信", "WeChat")}</span>
            </button>
          )}
          <span
            aria-label={connectionLabel(snapshot.connection, locale)}
            className={`tm-preview-connection is-${snapshot.connection}`}
            title={connectionLabel(snapshot.connection, locale)}
          >
            {props.portalStatusTarget ? <img alt="" className="tm-preview-connection-logo" src={workspaceConnectionLogo} /> : <Wifi size={14} />}
            {presentation === "standalone" && (props.portalStatusTarget ? <span>{text("连接状态：", "Connection: ")}<strong>{connectionLabel(snapshot.connection, locale)}</strong></span> : connectionLabel(snapshot.connection, locale))}
          </span>
          {presentation === "embedded" && embedInstanceId && (
            <button
              aria-label={text("关闭", "Close")}
              className="tm-preview-embed-close"
              onClick={() => embedBridgeRef.current?.requestClose()}
              type="button"
            >
              <X size={17} />
            </button>
          )}
        </div></PortalSlot>}
      </header>

      <main className="tm-preview-main">
        {presentation === "standalone" && props.portalSummary && !props.portalMailTaskMode && (
          <PortalSlot target={props.portalNewConversationTarget}>
            <button className="portal-mate-new-conversation" disabled={Boolean(switchingConversationId || clearingPreview)} onClick={createConversation} type="button">
              <MessageSquarePlus size={16} />{text("新对话", "New conversation")}
            </button>
          </PortalSlot>
        )}
        <div className="tm-preview-surface-layout">
          {presentation === "standalone" && !props.portalMailTaskMode && (
            <PortalSlot target={props.portalNavigationTarget}><StandaloneNavigation
              conversationActionError={conversationActionError}
              clearingPreview={clearingPreview}
              directoryRevision={directoryRevision}
              directoryTitles={directoryTitles}
              entry={entry}
              fetch={props.fetch}
              onClearPreview={() => void clearPreviewRecords()}
              onConversationAction={manageConversation}
              onCreateConversation={createConversation}
              onSelectConversation={selectConversation}
              onSelectEntry={selectEntry}
              onPortalConversationCountChange={props.onPortalConversationCountChange}
              session={session}
              switchingConversationId={switchingConversationId}
              textSize={chatTextSize}
              onTextSizeChange={setChatTextSize}
              portalSummary={props.portalSummary}
            /></PortalSlot>
          )}
          {props.portalNavigationTarget && <MailTasksSurface description={props.welcomeDescription} active={Boolean(props.portalMailTaskMode)} email={props.portalMateEmail} fetcher={props.fetch} session={session} onExit={() => props.onPortalMailTaskModeChange?.(false)} onCountChange={props.onPortalTaskCountChange} onOpenConversation={(id) => { props.onPortalMailTaskModeChange?.(false); selectConversation(id); }} />}
          <div className="tm-preview-surface-frame" hidden={Boolean(props.portalMailTaskMode)}>
            {activeSurface === "conversation" && switchingConversationId && switchingConversationId !== "new" ? (
              <ConversationTransitionSurface
                messages={switchingMessages}
                session={session}
                textSize={chatTextSize}
              />
            ) : activeSurface === "conversation" && session.conversationState === "draft" ? (
              <MateDraftSurface
                welcomeDescription={props.welcomeDescription}
                fetch={props.fetch}
                initialSelection={hostSelection}
                key={`draft-${session.conversationId}`}
                onCommit={commitDraftConversation}
                onSnapshot={updateSnapshot}
                presentation={presentation}
                session={session}
                textSize={chatTextSize}
              />
            ) : activeSurface === "conversation" ? (
              <ChatErrorBoundary
                failureTitle={text("对话连接未能恢复", "Chat connection could not recover")}
                key={`boundary-${session.principalKey}-${mountRevision}`}
                onFailure={() => updateSnapshot({ ...snapshot, connection: "error", hydration: "error", lastOutcome: "failed" })}
                onRetry={() => { void reconnect().catch((error) => setBoot({ phase: "error", error: new MatePreviewApiError(503, safeChatError(error)) })); }}
                retryLabel={text("重新认证并加载", "Reauthenticate and reload")}
              >
                <Suspense fallback={<ChatHydrationFallback initialSubmission={pendingSubmission} presentation={presentation} session={session} />}>
                  <MateChatSurface
                    welcomeDescription={props.welcomeDescription}
                    debug={debug}
                    endpoint={props.endpoint}
                    environment={hostEnvironment}
                    fetch={props.fetch}
                    initialSelection={hostSelection}
                    initialSubmission={pendingSubmission}
                    key={`chat-${session.principalKey}-${mountRevision}`}
                    onDirectoryChange={() => setDirectoryRevision((value) => value + 1)}
                    onInitialSubmissionConsumed={() => setPendingSubmission(undefined)}
                    onReconnect={reconnect}
                    onCloseConversation={createConversation}
                    recoveryDraft={recoveryDraft?.conversationId === session.conversationId ? recoveryDraft.draft : undefined}
                    onRecoveryDraftConsumed={() => setRecoveryDraft(undefined)}
                    onSourceCountChange={setChatSourceCount}
                    onSourcesOpenChange={changeSourcesOpen}
                    onSnapshot={updateSnapshot}
                    presentation={presentation}
                    session={session}
                    sourcesActivated={chatSourcesActivated}
                    sourcesOpen={sourcesOpen}
                    sourcesTarget={props.portalSourcesTarget}
                    onFilePreview={props.onPortalFilePreview}
                    initialWorkspaceFileId={props.initialWorkspaceFileId}
                    textSize={chatTextSize}
                  />
                </Suspense>
              </ChatErrorBoundary>
            ) : activeSurface === "task_inbox" && entry ? (
              <PreviewOperationsSurface
                channel={entry.channel}
                debug={debug}
                endpoint={props.endpoint}
                fetch={props.fetch}
                key={`operations-${session.principalKey}-${mountRevision}`}
                onDirectoryChange={() => setDirectoryRevision((value) => value + 1)}
                onSnapshot={updateSnapshot}
                session={session}
              />
            ) : (
              <PreviewUnavailableSurface onSnapshot={updateSnapshot} session={session} />
            )}
          </div>
        </div>
      </main>
      {mode === "live" && (
        <WeixinBindingDialog
          endpoint={props.endpoint}
          fetch={props.fetch}
          onClose={() => setWeixinOpen(false)}
          open={weixinOpen}
          session={session}
        />
      )}
    </div>
  );
}

function PortalSlot({ children, target }: { children: ReactNode; target?: HTMLElement | null }) {
  return target ? createPortal(children, target) : children;
}

function PreviewUnavailableSurface({
  onSnapshot,
  session
}: {
  onSnapshot: (snapshot: MateSurfaceSnapshot) => void;
  session: MatePreviewSession;
}) {
  const { text } = useMateLocale();
  useEffect(() => {
    onSnapshot({
      connection: "error",
      hydration: "ready",
      lastError: "mate_preview_surface_unavailable",
      lastOutcome: "failed",
      messageCount: 0,
      recovering: false,
      streaming: false
    });
  }, [onSnapshot]);
  return (
    <div className="tm-preview-chat-error" data-testid="preview-surface-unavailable" role="alert">
      <AlertTriangle size={22} />
      <h2>{text("这个候选 Release 没有可用界面", "This candidate release has no available surface")}</h2>
      <p>{text(`${session.mate.displayName} 需要启用对话或任务收件箱后才能进入 Preview。`, `${session.mate.displayName} must enable Conversations or Task Inbox before opening Preview.`)}</p>
    </div>
  );
}

export default MatePreviewApp;

function ChatHydrationFallback({
  initialSubmission,
  presentation,
  session
}: {
  initialSubmission?: DraftConversationSubmission;
  presentation: "embedded" | "standalone";
  session: MatePreviewSession;
}) {
  const { text } = useMateLocale();
  const [startedAt] = useState(() => Date.now());
  return (
    <div className={`tm-preview-workspace is-${presentation}`} data-testid="preview-chat-hydrating">
      <section className="tm-preview-conversation" aria-label={text("Mate 对话", "Mate conversation")}>
        <div className="tm-preview-transcript" role="log" aria-live="polite" aria-busy="true">
          {initialSubmission && <article className="tm-preview-message is-user" data-message-id={initialSubmission.messageId}>
            <UserAvatar avatarUrl={session.user?.avatarUrl} name={session.user?.name} />
            <div className="tm-preview-message-column">
              <div className="tm-preview-message-role">{session.user?.name || text("你", "You")}</div>
              <div className="tm-preview-message-body">
                <p>{initialSubmission.text}</p>
                {initialSubmission.attachments.map(({ file }) => <p key={file.name}>{file.name}</p>)}
              </div>
            </div>
          </article>}
          <PendingTurnStatus turn={{ phase: "preparing", startedAt: initialSubmission?.startedAt ?? startedAt }} />
        </div>
      </section>
    </div>
  );
}

class ChatErrorBoundary extends Component<{
  children: ReactNode;
  failureTitle: string;
  onFailure: () => void;
  onRetry: () => void;
  retryLabel: string;
}, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    this.props.onFailure();
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="tm-preview-chat-error" data-testid="preview-chat-error" role="alert">
        <AlertTriangle size={22} />
        <h2>{this.props.failureTitle}</h2>
        <p>{safeChatError(this.state.error)}</p>
        <button onClick={this.props.onRetry} type="button"><RotateCw size={15} />{this.props.retryLabel}</button>
      </div>
    );
  }
}

function PreviewGate({
  action,
  detail,
  error = false,
  requestId,
  testId,
  title
}: {
  action?: ReactNode;
  detail: string;
  error?: boolean;
  requestId?: string;
  testId: string;
  title: string;
}) {
  return (
    <main className={error ? "tm-preview-gate is-error" : "tm-preview-gate"} data-testid={testId}>
      <span>{error ? <AlertTriangle size={23} /> : <RefreshCw size={23} />}</span>
      <p className="tm-preview-eyebrow">Mate</p>
      <h1>{title}</h1>
      <p>{detail}</p>
      {requestId && <small>Request ID: {requestId}</small>}
      {action}
    </main>
  );
}

function sessionErrorMessage(mode: "live" | "preview", error: MatePreviewApiError, locale: MateLocale) {
  const english = locale === "en";
  if (mode === "live") {
    if (error.status === 401) return english ? "Your session has expired. Sign in to Workspace Portal and try again." : "登录 Session 已失效。请重新登录 Workspace Portal 后再试。";
    if (error.status === 403) return english ? "You do not have access to this Mate." : "当前用户无权访问这个 Mate。";
    if (error.status === 404) return english ? "This Mate or its live release is unavailable." : "Mate 或其正式 Release 当前不可用。";
    if (error.code === "live_route_invalid") return english ? "The Mate URL is missing a valid coordinate." : "Mate URL 缺少合法坐标。";
    return english ? "The Mate session is temporarily unavailable. Try again later." : "Mate Session 暂时不可用，请稍后重试。";
  }
  if (error.status === 401) return english ? "Your session has expired. Sign in to Workspace Portal and try again." : "登录 Session 已失效。请重新登录 Workspace Portal 后再试。";
  if (error.status === 403 || error.status === 404) return english ? "You are not the owner of this candidate release, or the Preview has expired." : "当前用户不是该候选 Release 的 Owner，或 Preview 已失效。";
  if (error.status === 409 || error.code === "mate_preview_release_changed") return english ? "The candidate release was published, replaced, or expired. Open the current Preview from Mate Builder." : "候选 Release 已发布、被替换或失效，请从 Mate Builder 打开当前 Preview。";
  if (error.code === "preview_route_invalid") return english ? "The Preview URL is missing a valid Mate or release coordinate." : "Preview URL 缺少合法的 Mate 或 Release 坐标。";
  if (error.code === "preview_session_coordinate_mismatch") return english ? "The host session does not match the candidate release in the URL." : "Host Session 与 URL 中的候选 Release 不一致，已拒绝连接。";
  return english ? "The Preview session is temporarily unavailable. Live is unaffected." : "Preview Session 暂时不可用。Live 不受影响。";
}

function replaceLiveConversationCoordinate(conversationId?: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (conversationId) url.searchParams.set("conversation", conversationId);
  else url.searchParams.delete("conversation");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function conversationActionMessage(error: unknown, locale: MateLocale) {
  const english = locale === "en";
  if (error instanceof MatePreviewApiError) {
    if (error.status === 401) return english ? "Your session has expired. Sign in and try again." : "Session 已失效，请重新登录后再试。";
    if (error.status === 403 || error.status === 404) return english ? "Preview access or the candidate release has expired." : "当前 Preview 权限或候选 Release 已失效。";
    if (error.code === "preview_cleanup_response_invalid") return english ? "The cleanup result could not be verified. Refresh and try again." : "清空结果无法校验，请刷新后重试。";
  }
  return english ? "The conversation action failed. The current conversation is unchanged." : "会话操作暂时失败，当前对话保持不变。";
}

function connectionLabel(value: MateSurfaceSnapshot["connection"], locale: MateLocale) {
  if (locale === "en") {
    if (value === "connected") return "Connected";
    if (value === "streaming") return "Streaming";
    if (value === "recovering") return "Recovering";
    if (value === "error") return "Connection error";
    return "Connecting";
  }
  if (value === "connected") return "已连接";
  if (value === "streaming") return "生成中";
  if (value === "recovering") return "恢复中";
  if (value === "error") return "连接异常";
  return "连接中";
}

function defaultExit() {
  window.location.assign("/#/apps");
}

function browserSessionStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
