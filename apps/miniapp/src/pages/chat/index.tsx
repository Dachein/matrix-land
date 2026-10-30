import { Button, Image, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, useLoad, useUnload } from "@tarojs/taro";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatViewport } from "../../hooks/useChatViewport";
import { ChatContentResize } from "../../components/ChatContentResize";
import { ChatMessageRow } from "../../components/ChatMessageRow";
import { Composer } from "../../components/Composer";
import { type ApprovalHandler, type PartOpenHandler } from "../../components/MessageParts";
import { SessionDrawer, type DrawerAction } from "../../components/SessionDrawer";
import { MateAvatar } from "../../components/Avatar";
import { MateSidebar } from "../../components/MateSidebar";
import { MateIdentityForm, type MateIdentity } from "../../components/MateIdentityForm";
import { RuntimeApprovalCards } from "../../components/RuntimeApprovalCards";
import { randomMateAvatarUrl } from "../../components/mateAvatarChoices";
import { TypingIndicator } from "../../components/TypingIndicator";
import { useConversationActions } from "../../hooks/useConversationActions";
import { createChatGrant, createLiveSession, createQuickMate, decideRuntimeApproval, listApprovals, listApprovalTasks, listConversations, listMates, loadMessages, logout, redirectToLogin, refreshCurrentUserProfile, requireAuth, uploadAttachment } from "../../services/api";
import { isAuthRequiredError } from "../../services/auth";
import { WorkspaceMiniChat, type ChatConnection } from "../../services/chat";
import { hasVisibleMessageContent } from "../../services/chatPresentation";
import { windowMessages, shiftMessageWindow, anchoredScrollTop, type MessageWindowCursor } from "../../services/messageWindow";
import { getCachedMessages, setCachedMessages } from "../../services/messageCache";
import { chooseFiles, chooseFileSource, isPickerCancelled, type SelectedFile } from "../../services/fileSelection";
import { uploadAttachmentBatch } from "../../services/attachmentQueue";
import { selectFilePreview } from "../../services/filePreview";
import { quickCreateErrorMessage } from "../../services/quickCreate";
import { isRuntimeSessionExpired, isRuntimeSessionInvalid, reuseRuntimeSession, shouldRefreshSession } from "../../services/sessionRecovery";
import { state } from "../../state";
import { translate, useI18n } from "../../services/i18n";
import type { ChatCapabilitySelection, ChatMessage, ChatPart, Conversation, LiveSession, RuntimeApproval, UploadedAttachment } from "../../types";
import { newestFirst } from "../../utils/format";
import { fileTypeIcon } from "../../services/fileTypeIcons";
import { mateFileReferenceFromUrl, mateFileReferencesFromCitations, mateFileReferencesFromTool } from "../../../../../src/shared/mateFileReference.js";
import { mergeApprovalStates } from "../../../../../src/shared/mateApprovalPresentation";
import "./index.scss";

const ACTION_SCROLL_THRESHOLD = 26;
const ACTION_SCROLL_NOISE = 2;
const SESSION_REUSE_WINDOW_MS = 30_000;
/** How long a "load earlier" scroll anchor is held while the window grows. */
const ACTION_ANCHOR_RELEASE_MS = 400;
const MAX_ATTACHMENTS = 5;

export default function ChatPage() {
  const { language, t } = useI18n();
  const viewport = useChatViewport();
  const [composerRevision, setComposerRevision] = useState(0);
  const onComposerResize = useCallback(() => setComposerRevision((revision) => revision + 1), []);
  const [session, setSession] = useState<LiveSession | undefined>(() => state.getLiveSession());
  const sessionRef = useRef(session);
  const initialMate = session?.mate || state.getMate();
  const initialSelection = initialMate ? state.getCapabilitySelection(initialMate.id) : { appIds: [], knowledgeServiceIds: [] };
  const selectionRef = useRef<ChatCapabilitySelection | undefined>(initialSelection);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runtimeApprovals, setRuntimeApprovals] = useState<RuntimeApproval[]>([]);
  const [approvalBusyId, setApprovalBusyId] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const [approvalNotice, setApprovalNotice] = useState("");
  const [pageVisible, setPageVisible] = useState(true);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [failedUploads, setFailedUploads] = useState<SelectedFile[]>([]);
  const attachmentBusyRef = useRef(false);
  const [streaming, setStreaming] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [canContinue, setCanContinue] = useState(false);
  const [connection, setConnection] = useState<ChatConnection>("offline");
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState("");
  const [drawerError, setDrawerError] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [creatingMate, setCreatingMate] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [identity, setIdentity] = useState<MateIdentity>(() => ({ displayName: "", jobRole: "", avatarUrl: randomMateAvatarUrl() }));
  const createInFlight = useRef(false);
  const [user, setUser] = useState(() => state.getUser());
  const [mates, setMates] = useState(() => state.getMates());
  const [conversations, setConversations] = useState<Conversation[]>(() => newestFirst(session?.conversations || []));
  const [switchingId, setSwitchingId] = useState("");
  const [actionsVisible, setActionsVisible] = useState(() => session?.conversationState !== "persisted");
  const chatRef = useRef<WorkspaceMiniChat>();
  const approvalIdsRef = useRef("");
  const approvalRevisionRef = useRef(0);
  const approvalDecidingRef = useRef(false);
  const initializationRef = useRef(0);
  const initializingRef = useRef(false);
  const contentResizeTimer = useRef<ReturnType<typeof setTimeout>>();
  const onContentResize = useCallback(() => {
    if (contentResizeTimer.current) return;
    contentResizeTimer.current = setTimeout(() => {
      contentResizeTimer.current = undefined;
      setComposerRevision(revision => revision + 1);
    }, 80);
  }, []);
  const anchorTimer = useRef<ReturnType<typeof setTimeout>>();
  const userScrolling = useRef(false);
  const actionScrollDistance = useRef(0);
  const actionToggleUntil = useRef(0);
  const autoScrollUntil = useRef(0);
  const [historyCursor, setHistoryCursor] = useState<MessageWindowCursor>();
  const historyTransition = useRef(0);
  const historyMoving = useRef(false);
  const [followTail, setFollowTail] = useState(true);
  const [latestScrollTop, setLatestScrollTop] = useState<number>();
  const followTailRef = useRef(true);
  const lastScrollTop = useRef(0);
  const [scrollTick, setScrollTick] = useState(0);
  // Set when older messages are prepended, so the view keeps its place instead of jumping to
  // the bottom of the newly grown list.
  const [scrollAnchorId, setScrollAnchorId] = useState("");
  const activeMessageId = (streaming || recovering) && messages[messages.length - 1]?.role === "assistant" ? messages[messages.length - 1].id : undefined;
  const visibleMessages = useMemo(() => messages.filter(message => hasVisibleMessageContent(message, message.id === activeMessageId)), [messages, activeMessageId]);
  // Bounds the rendered history: see `services/messageWindow.ts` for the node-count rationale.
  const windowed = useMemo(() => windowMessages(visibleMessages, historyCursor), [visibleMessages, historyCursor]);
  const shownMessages = windowed.messages;
  const atNewestWindow = windowed.newerCount === 0;
  const activeAssistantIndex = atNewestWindow && activeMessageId && shownMessages[shownMessages.length - 1]?.id === activeMessageId ? shownMessages.length - 1 : -1;
  const showTypingRow = atNewestWindow && (streaming || recovering) && activeAssistantIndex < 0;
  // Alternate two stable tail IDs so every new stream snapshot moves the viewport to the
  // bottom. Pointing scrollIntoView at the unchanged message ID only scrolls once.
  const scrollId = scrollAnchorId || (followTail ? `chat-tail-${scrollTick % 2}` : "");
  const navigation = useMemo(() => customNavigationMetrics(), []);
  const actions = useConversationActions(session, async (active) => { await syncConversations(active); });

  useLoad((query) => {
    if (!sessionRef.current?.mate?.id && !state.getMate()?.id) { void Taro.redirectTo({ url: "/pages/mates/index" }); return; }
    if (!requireAuth()) return;
    if (query.create === "1") setCreatingMate(true);
    void initializeChat();
  });
  useDidShow(() => {
    setPageVisible(true);
    const active = sessionRef.current;
    if (!active?.mate?.id) return;
    const next = state.getCapabilitySelection(active.mate.id);
    selectionRef.current = next;
  });
  useDidHide(() => { setPageVisible(false); });
  useUnload(() => { historyTransition.current++; initializationRef.current += 1; initializingRef.current = false; chatRef.current?.close(); if (contentResizeTimer.current) clearTimeout(contentResizeTimer.current); if (anchorTimer.current) clearTimeout(anchorTimer.current); });

  const refreshRuntimeApprovals = useCallback(async (active: LiveSession) => {
    const revision = approvalRevisionRef.current;
    let listed: RuntimeApproval[];
    try { listed = await listApprovals(active); }
    catch (error) {
      if (!isRuntimeSessionInvalid(error)) throw error;
      active = await renewRuntimeSession(active);
      listed = await listApprovals(active);
    }
    let scoped = listed.filter((item) => item.conversationId === active.conversationId && (!active.release?.id || item.releaseId === active.release.id));
    let resultsUnavailable = false;
    if (scoped.some((item) => item.status === "approved" || item.status === "consumed")) {
      try {
        const tasks = await listApprovalTasks(active);
        scoped = scoped.map((item) => ({ ...item, task: tasks.find((task) => task.id === item.taskId) }));
      } catch (error) {
        if (isAuthRequiredError(error)) throw error;
        resultsUnavailable = true;
      }
    }
    if (sessionRef.current?.principalKey !== active.principalKey || sessionRef.current.conversationId !== active.conversationId) return;
    if (revision !== approvalRevisionRef.current || approvalDecidingRef.current) return;
    setRuntimeApprovals((previous) => mergeApprovalStates(previous, scoped));
    setApprovalError(resultsUnavailable ? translate("approval.resultUnavailable") : "");
    const ids = scoped.map((item) => `${item.id}:${item.status}:${item.task?.status || ""}`).join(":");
    if (ids !== approvalIdsRef.current) {
      approvalIdsRef.current = ids;
      if (followTailRef.current) setScrollTick((tick) => tick + 1);
    }
  }, []);

  useEffect(() => {
    if (!pageVisible || initializing || session?.conversationState !== "persisted") return;
    let cancelled = false;
    let loading = false;
    const refresh = async () => {
      if (loading || cancelled) return;
      const active = sessionRef.current;
      if (!active || active.conversationState !== "persisted") return;
      loading = true;
      try { await refreshRuntimeApprovals(active); }
      catch (caught) {
        if (!cancelled) {
          if (isAuthRequiredError(caught)) redirectToLogin();
          else setApprovalError(t("approval.loadFailed"));
        }
      } finally { loading = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pageVisible, initializing, session?.mate.id, session?.conversationId, session?.accessToken, session?.conversationState, streaming, refreshRuntimeApprovals]);

  // Release the "load earlier" anchor after the older window has been positioned. The
  // reader stays in control until they scroll back to the bottom or send a new message.
  useEffect(() => {
    if (!scrollAnchorId) return;
    if (anchorTimer.current) clearTimeout(anchorTimer.current);
    anchorTimer.current = setTimeout(() => { anchorTimer.current = undefined; setScrollAnchorId(""); }, ACTION_ANCHOR_RELEASE_MS);
  }, [scrollAnchorId]);

  // The initial message history can arrive after the scroll view mounts. Move its
  // scrollTop after Taro has rendered the new rows; the tail ID alone is unreliable
  // when restoring a long conversation in the WeChat scroll view.
  useEffect(() => {
    if (!followTail || !shownMessages.length) return;
    let active = true;
    Taro.nextTick(() => {
      if (!active || !followTailRef.current) return;
      autoScrollUntil.current = Date.now() + 350;
      setLatestScrollTop((top) => top === undefined || top >= 10000000 ? 100000 : top + 100000);
    });
    return () => { active = false; };
  }, [shownMessages, showTypingRow, followTail, viewport.height, composerRevision]);

  useEffect(() => {
    if (!navOpen) return;
    let current = true;
    void refreshCurrentUserProfile().then((profile) => {
      if (current && profile) setUser(profile);
    }).catch(() => { /* Show the cached profile when refresh is unavailable. */ });
    return () => { current = false; };
  }, [navOpen]);

  async function signOut() {
    setNavOpen(false);
    const confirmed = await Taro.showModal({
      title: t("account.logoutTitle"),
      content: t("account.logoutBody"),
      confirmText: t("account.logout"),
      confirmColor: "#a02920"
    });
    if (!confirmed.confirm) return;
    try {
      await logout();
      await Taro.reLaunch({ url: "/pages/login/index" });
    } catch {
      await Taro.showToast({ title: t("account.logoutFailed"), icon: "none" });
    }
  }

  function setAutoFollow(value: boolean) {
    if (value) { historyTransition.current++; historyMoving.current = false; setHistoryCursor(undefined); }
    if (!value && followTailRef.current) {
      setLatestScrollTop(lastScrollTop.current);
      if (shownMessages.length) setHistoryCursor({ firstId: shownMessages[0].id, count: shownMessages.length });
    }
    followTailRef.current = value;
    setFollowTail(value);
  }

  function applySession(next: LiveSession) {
    if (sessionRef.current?.conversationId !== next.conversationId || sessionRef.current?.mate.id !== next.mate.id) {
      approvalRevisionRef.current += 1;
      setRuntimeApprovals([]);
      setApprovalNotice("");
      setApprovalError("");
      approvalIdsRef.current = "";
    }
    sessionRef.current = next;
    state.setLiveSession(next);
    setSession(next);
  }

  /** Exchanges the runtime token, keeping the current conversation where one exists. */
  async function renewRuntimeSession(current: LiveSession) {
    const conversationId = current.conversationState === "persisted" ? current.conversationId : undefined;
    const next = await createLiveSession(current.mate, conversationId);
    next.conversations = current.conversations;
    applySession(next);
    return next;
  }

  /** Routes an authentication loss to the login page; returns true when it handled the error. */
  function handleAuthFailure(caught: unknown) {
    if (!isAuthRequiredError(caught)) return false;
    redirectToLogin();
    return true;
  }

  async function initializeChat(forceRefresh = false) {
    const previous = sessionRef.current;
    const mate = previous?.mate?.id ? previous.mate : state.getMate();
    const stored = previous?.mate?.id && previous.mate.id === mate?.id ? previous : undefined;
    if (previous && !stored) {
      sessionRef.current = undefined;
      setSession(undefined);
      state.clearLiveSession();
    }
    if (!mate || initializingRef.current) return;
    const generation = ++initializationRef.current;
    initializingRef.current = true; setInitializing(true); setError(""); setConnection("connecting");
    historyTransition.current++; historyMoving.current = false; setHistoryCursor(undefined); setScrollAnchorId(""); setLatestScrollTop(undefined); setAutoFollow(true);
    if (stored && stored.mate.id === mate.id && stored.conversationState === "persisted") {
      const cached = getCachedMessages(stored.principalKey, stored.mate.id, stored.conversationId);
      if (cached) { setMessages(cached); setActionsVisible(cached.length < 4); setScrollTick((tick) => tick + 1); }
    }
    chatRef.current?.close(); chatRef.current = undefined;
    try {
      let active = stored
        ? forceRefresh || shouldRefreshSession(stored) ? await renewRuntimeSession(stored) : stored
        : await restoreLiveSession(mate);
      if (!stored) applySession(active);
      if (generation !== initializationRef.current) return;
      try { await startChat(active, generation); }
      catch (caught) {
        if (!isRuntimeSessionInvalid(caught)) throw caught;
        active = await renewRuntimeSession(active);
        if (generation !== initializationRef.current) return;
        await startChat(active, generation);
      }
      void syncConversations(active, generation, Boolean(stored));
    } catch (caught) {
      if (generation === initializationRef.current) failChat(caught);
    } finally {
      if (generation === initializationRef.current) { initializingRef.current = false; setInitializing(false); }
    }
  }

  function failChat(caught: unknown) {
    if (handleAuthFailure(caught)) return;
    setConnection("offline"); setError(chatLoadError(caught, t));
  }

  async function startChat(active: LiveSession, generation: number) {
    const grant = active.conversationState === "persisted" ? await createChatGrant(active) : undefined;
    const initial = grant ? await loadMessages(active, grant) : [];
    if (generation !== initializationRef.current) return;
    setMessages(initial);
    if (initial.length) setCachedMessages(active.principalKey, active.mate.id, active.conversationId, initial);
    setActionsVisible(initial.length < 4);
    autoScrollUntil.current = Date.now() + 350;
    setScrollTick((tick) => tick + 1);
    const chat = new WorkspaceMiniChat(active, initial, (snapshot) => {
      setMessages(snapshot.messages); setStreaming(snapshot.streaming); setRecovering(snapshot.recovering); setConnection(snapshot.connection);
      setCanContinue(snapshot.canContinue);
      if (!snapshot.streaming && !snapshot.recovering && snapshot.messages.length) {
        setCachedMessages(active.principalKey, active.mate.id, active.conversationId, snapshot.messages);
      }
      setError(snapshot.error || "");
      if (followTailRef.current) {
        autoScrollUntil.current = Date.now() + 350;
        setScrollTick((tick) => tick + 1);
        // After a manual jump, keep scrollTop advancing as new stream chunks arrive.
        setLatestScrollTop((top) => top === undefined ? undefined : top >= 10000000 ? 100000 : top + 100000);
      }
    }, () => selectionRef.current, grant, renewRuntimeSession);
    chatRef.current = chat;
    try { await chat.connect(); }
    catch (caught) { if (chatRef.current === chat) chatRef.current = undefined; chat.close(); throw caught; }
    const imported = state.consumePendingImport(active.mate.id);
    if (imported) chat.send("请读取这个文件，等我下一步指示。", [imported]);
  }

  /** Refreshes the server-side conversation list. Auth loss is routed to login either way. */
  async function syncConversations(active: LiveSession, generation?: number, force = false) {
    try {
      const sorted = newestFirst(await listConversations(active, { force }));
      if (generation !== undefined && generation !== initializationRef.current) return;
      active.conversations = sorted;
      applySession(active);
      setConversations(sorted);
    } catch (caught) {
      if (handleAuthFailure(caught)) return;
      if (generation !== undefined && generation !== initializationRef.current) return;
      setDrawerError(t("chat.loadSessionsFailed"));
    }
  }

  function retryChat() {
    if (chatRef.current) chatRef.current.retry();
    else void initializeChat(true);
  }

  function send() {
    const value = input.trim(); if ((!value && !attachments.length) || uploading || failedUploads.length) return;
    setAutoFollow(true); setScrollAnchorId(""); autoScrollUntil.current = Date.now() + 350; setScrollTick((tick) => tick + 1);
    setLatestScrollTop((top) => top === undefined ? undefined : top >= 10000000 ? 100000 : top + 100000);
    setInput(""); const files = attachments; setAttachments([]); chatRef.current?.send(value || t("chat.filePrompt"), files);
  }

  async function attach() {
    if (!sessionRef.current || attachmentBusyRef.current || attachments.length + failedUploads.length >= MAX_ATTACHMENTS) return;
    attachmentBusyRef.current = true;
    const active = sessionRef.current;
    try {
      const source = await chooseFileSource();
      const chosen = await chooseFiles(source, MAX_ATTACHMENTS - attachments.length - failedUploads.length);
      if (!chosen.length) return;
      setUploading(true);
      const result = await uploadAttachmentBatch(chosen, (file) => uploadAttachment(active, file));
      setAttachments((current) => [...current, ...result.uploaded]);
      setFailedUploads((current) => [...current, ...result.failed.map((item) => item.file)]);
      const authFailure = result.failed.find((item) => isAuthRequiredError(item.error));
      if (authFailure) throw authFailure.error;
      if (result.failed.length) throw result.failed[0].error;
    } catch (caught) {
      if (handleAuthFailure(caught)) return;
      if (!isPickerCancelled(caught)) {
        const code = caught instanceof Error ? caught.message : "";
        setError(code === "workspace_attachment_type_unsupported" ? t("chat.uploadUnsupported") :
          code === "workspace_attachment_too_large" || code === "upload_file_too_large" ? t("chat.uploadTooLarge") : t("chat.uploadFailed"));
      }
    } finally { attachmentBusyRef.current = false; setUploading(false); }
  }

  async function retryUploads() {
    const active = sessionRef.current;
    if (!active || attachmentBusyRef.current || !failedUploads.length) return;
    attachmentBusyRef.current = true; setUploading(true);
    try {
      const result = await uploadAttachmentBatch(failedUploads, (file) => uploadAttachment(active, file));
      setAttachments((current) => [...current, ...result.uploaded]);
      setFailedUploads(result.failed.map((item) => item.file));
      setError(result.failed.length ? t("chat.uploadFailed") : "");
      if (result.failed.some((item) => isAuthRequiredError(item.error))) redirectToLogin();
    } finally { attachmentBusyRef.current = false; setUploading(false); }
  }

  const openPart: PartOpenHandler = useCallback(async (part) => {
    const current = sessionRef.current;
    if (!current || !part.url) return;
    try {
      if (/^\/api\/workspace-files\//.test(part.url)) {
        const id = `workspace:${part.url}`;
        selectFilePreview({ id, name: part.filename || t("parts.generatedFile"), mimeType: part.mediaType, sizeBytes: part.sizeBytes, workspace: { session: current, url: part.url } });
        await Taro.navigateTo({ url: `/pages/knowledge-preview/index?id=${encodeURIComponent(id)}` });
      } else if (/^https?:\/\//.test(part.url)) {
        await Taro.setClipboardData({ data: part.url });
        await Taro.showToast({ title: t("chat.copySuccess"), icon: "success" });
      }
    } catch (caught) {
      if (handleAuthFailure(caught)) return;
      setError(t("chat.openFileFailed"));
    }
  }, []);

  const handleApproval: ApprovalHandler = useCallback((toolCallId, approved) => {
    chatRef.current?.respondToolApproval(toolCallId, approved);
  }, []);

  async function handleRuntimeApproval(approvalId: string, decision: "approve" | "deny") {
    const current = sessionRef.current;
    if (!current || approvalDecidingRef.current) return;
    approvalDecidingRef.current = true;
    approvalRevisionRef.current += 1;
    setApprovalBusyId(approvalId);
    setApprovalNotice("");
    setApprovalError("");
    try {
      const active = shouldRefreshSession(current) ? await renewRuntimeSession(current) : current;
      const result = await decideRuntimeApproval(active, approvalId, decision) as { approval?: RuntimeApproval; task?: RuntimeApproval["task"] };
      if (sessionRef.current?.principalKey !== current.principalKey || sessionRef.current.conversationId !== current.conversationId) return;
      if (!result.approval || result.approval.id !== approvalId || result.approval.status === "pending") throw new Error("decision_not_confirmed");
      setRuntimeApprovals((previous) => mergeApprovalStates(previous, [{ ...result.approval!, task: result.task }]));
      setApprovalNotice(result.task?.conclusion?.summary || t("approval.completed"));
    } catch (caught) {
      if (sessionRef.current?.principalKey !== current.principalKey || sessionRef.current.conversationId !== current.conversationId) return;
      if (isAuthRequiredError(caught)) redirectToLogin();
      else setApprovalError(t("approval.decisionFailed"));
    } finally {
      approvalDecidingRef.current = false;
      approvalRevisionRef.current += 1;
      setApprovalBusyId("");
      const active = sessionRef.current;
      if (active) void refreshRuntimeApprovals(active).catch(() => {});
    }
  }

  function handleMessagesScroll(event: { detail?: { scrollTop?: number } }) {
    const top = event.detail?.scrollTop;
    if (typeof top !== "number") return;
    const delta = top - lastScrollTop.current;
    lastScrollTop.current = top;
    // Taro reapplies scrollTop on a render. Track the reader's position before any
    // layout update, including programmatic scroll events during the settling period.
    if (!followTailRef.current && !historyMoving.current) setLatestScrollTop(top);
    if (drawerOpen || (!userScrolling.current && Date.now() < autoScrollUntil.current)) return;
    if (delta < -4) setAutoFollow(false);
    if (top <= 16) { actionScrollDistance.current = 0; setActionsVisible(true); return; }
    // Collapsing the row changes the scroll view height; ignore that layout adjustment.
    if (Date.now() < actionToggleUntil.current) return;
    if (Math.abs(delta) < ACTION_SCROLL_NOISE) return;
    if (Math.sign(delta) !== Math.sign(actionScrollDistance.current)) actionScrollDistance.current = 0;
    actionScrollDistance.current += delta;
    if (Math.abs(actionScrollDistance.current) < ACTION_SCROLL_THRESHOLD) return;
    setActionsVisible(actionScrollDistance.current < 0);
    actionScrollDistance.current = 0;
    actionToggleUntil.current = Date.now() + 180;
  }

  function handleMessagesTouchStart() {
    userScrolling.current = true;
    actionScrollDistance.current = 0;
    autoScrollUntil.current = 0;
  }

  function handleMessagesTouchEnd() {
    userScrolling.current = false;
    actionScrollDistance.current = 0;
  }

  function handleMessagesScrollToLower() {
    // Paging can emit a delayed lower-edge event after rows are replaced. Only an
    // explicit jump/send exits a pinned history window; never discard it on that event.
    if (historyCursor || followTailRef.current || windowed.newerCount > 0 || historyMoving.current || Date.now() < autoScrollUntil.current) return;
    setAutoFollow(true);
    setScrollTick((tick) => tick + 1);
  }

  function jumpToLatest() {
    setAutoFollow(true);
    setActionsVisible(false);
    setScrollAnchorId("");
    autoScrollUntil.current = Date.now() + 350;
    // An explicit scrollTop is more reliable than scrollIntoView for a manual jump
    // in the WeChat simulator, where switching the tail anchor can land at the top.
    setLatestScrollTop((top) => top === undefined || top >= 10000000 ? 100000 : top + 100000);
  }

  // Both directions overlap by ten rows, leaving a mounted anchor for pixel restoration.
  async function moveHistory(direction: "earlier" | "newer") {
    if (!shownMessages.length || historyMoving.current) return;
    const anchor = direction === "earlier" ? shownMessages[0] : shownMessages[shownMessages.length - 1];
    const next = shiftMessageWindow(visibleMessages, windowed, direction);
    if (!next) return;
    setAutoFollow(false);
    const revision = ++historyTransition.current;
    historyMoving.current = true;
    const selector = `#message-${anchor.id}`;
    const readPosition = () => new Promise<{ top: number; scrollTop: number } | undefined>(resolve => {
      const timeout = setTimeout(() => resolve(undefined), 800);
      try {
        const query = Taro.createSelectorQuery();
        query.select(selector).boundingClientRect();
        query.select('.messages').scrollOffset();
        query.exec(results => {
          clearTimeout(timeout);
          const [row, scroll] = results || [];
          resolve(row && scroll && Number.isFinite(row.top) && Number.isFinite(scroll.scrollTop)
            ? { top: row.top, scrollTop: scroll.scrollTop } : undefined);
        });
      } catch { clearTimeout(timeout); resolve(undefined); }
    });
    const before = await readPosition();
    if (revision !== historyTransition.current) return;
    autoScrollUntil.current = Date.now() + 600;
    setLatestScrollTop(undefined);
    setScrollAnchorId("");
    setHistoryCursor(next);
    // Wait for the React update and Taro bridge before measuring the retained row.
    setTimeout(() => Taro.nextTick(() => {
      void readPosition().then(after => {
        if (revision !== historyTransition.current) return;
        if (before && after) {
          const top = anchoredScrollTop(after.scrollTop, before.top, after.top);
          lastScrollTop.current = top;
          setLatestScrollTop(top);
        } else setScrollAnchorId(`message-${anchor.id}`);
        historyMoving.current = false;
      });
    }), 0);
  }

  function openSessionDrawer() {
    setActionsVisible(true); setDrawerError(""); setDrawerOpen(true);
  }

  async function openNavigation() {
    setNavOpen(true);
    try { setMates(await listMates()); } catch { setMates(state.getMates()); }
  }

  async function switchMate(mate: NonNullable<LiveSession["mate"]>) {
    if (mate.id === sessionRef.current?.mate.id) { setNavOpen(false); return; }
    if (mate.status !== "published") {
      await Taro.showToast({ title: t("home.unpublished"), icon: "none" });
      return;
    }
    chatRef.current?.close();
    state.setMate(mate);
    state.clearLiveSession();
    setNavOpen(false);
    await Taro.redirectTo({ url: "/pages/chat/index" });
  }

  function closeCreateMate() {
    setCreatingMate(false);
    setCreateError("");
    setIdentity({ displayName: "", jobRole: "", avatarUrl: randomMateAvatarUrl() });
  }

  async function createMate() {
    if (createInFlight.current || !identity.displayName.trim() || !identity.jobRole.trim()) return;
    createInFlight.current = true;
    setCreateBusy(true);
    setCreateError("");
    try {
      const mate = await createQuickMate({
        displayName: identity.displayName.trim(),
        jobRole: identity.jobRole.trim(),
        description: `你的 ${identity.jobRole.trim()} 数字分身`,
        avatarUrl: identity.avatarUrl
      });
      const nextMates = [mate, ...mates.filter((mate) => mate.id !== mate.id)];
      state.setMates(nextMates);
      setMates(nextMates);
      closeCreateMate();
      if (mate.status !== "published") {
        await Taro.showToast({ title: t("home.unpublished"), icon: "none" });
        return;
      }
      chatRef.current?.close();
      state.setMate(mate);
      state.clearLiveSession();
      try { await Taro.redirectTo({ url: "/pages/chat/index" }); }
      catch { await Taro.showToast({ title: t("home.cannotOpen"), icon: "none" }); }
    } catch (caught) {
      if (handleAuthFailure(caught)) return;
      setCreateError(quickCreateErrorMessage(caught, language));
      void listMates({ force: true }).then((listed) => setMates(listed)).catch(() => {});
    } finally {
      createInFlight.current = false;
      setCreateBusy(false);
    }
  }

  /**
   * Switches the active conversation. The runtime token is reused only when it is still
   * valid for this Mate; `conversationId` no longer comes from a potentially unrelated session.
   */
  async function switchSession(conversation?: Conversation) {
    const current = sessionRef.current;
    if (!current || switchingId) return;
    if (conversation?.id === current.conversationId) { setDrawerOpen(false); return; }
    const targetId = conversation?.id || "new";
    setSwitchingId(targetId); setDrawerError("");
    try {
      if (conversation && !isRuntimeSessionExpired(current, Date.now(), SESSION_REUSE_WINDOW_MS)) {
        applySession(reuseRuntimeSession(current, conversation));
      } else {
        const next = await createLiveSession(current.mate, conversation?.id);
        next.conversations = conversations;
        applySession(next);
      }
      chatRef.current?.close();
      await Taro.redirectTo({ url: "/pages/chat/index" });
    } catch (caught) {
      if (handleAuthFailure(caught)) return;
      setDrawerError(t("chat.switchFailed"));
    } finally { setSwitchingId(""); }
  }

  /** Applies a drawer mutation result. The hook already refreshed the list via `onMutated`. */
  async function handleDrawerAction(item: Conversation, action: DrawerAction) {
    if (!sessionRef.current) return;
    const result = await actions.manage(item, action);
    if (result.message) void Taro.showToast({ title: result.message, icon: "none" });
    setDrawerError(result.error || "");
  }

  const statusText = initializing ? t("chat.statusRestoringSession") : recovering ? t("chat.statusRestoring") : streaming ? t("chat.statusProcessing") : connection === "reconnecting" ? t("chat.statusReconnecting") : connection === "connected" ? t("chat.statusOnline") : session?.conversationState === "draft" && !error ? t("chat.statusReady") : t("chat.statusOffline");
  const conversationFiles = useMemo(() => {
    const seen = new Set<string>();
    return messages.flatMap((message) => message.parts).flatMap((part): ChatPart[] => {
      if (part.type === "file") {
        const file = mateFileReferenceFromUrl(part.url, part.filename);
        return file ? [{ ...part, url: file.url }] : part.url ? [part] : [];
      }
      return (part.type === "data-mate-citations"
        ? mateFileReferencesFromCitations(part.data)
        : mateFileReferencesFromTool(part.toolName || part.type.replace(/^tool-/, ""), part.output))
        .map((file) => ({ type: "file", filename: file.fileName, url: file.url }));
    }).filter((part) => {
      if (!part.url || seen.has(part.url)) return false;
      seen.add(part.url);
      return true;
    }).reverse();
  }, [messages]);
  const selectedMate = session?.mate || state.getMate();

  return <View className="chat-page" style={viewport.height ? { height: `${viewport.height}px` } : undefined}>
    <View className="chat-nav" style={{ height: `${navigation.height}px`, paddingTop: `${navigation.statusBarHeight}px` }}>
      <Text className="menu-trigger" onClick={() => void openNavigation()} aria-label={t("chat.menu")}>☰</Text>
      <View className="chat-identity">
        <View onClick={() => void openNavigation()}><MateAvatar avatarUrl={selectedMate?.avatarUrl} className="nav-avatar" /></View>
        <View><Text className="nav-name">{selectedMate?.displayName}</Text><Text className={`online ${connection === "offline" ? "offline" : ""}`}>● {statusText}</Text></View>
      </View>
      <Text className="more" onClick={() => Taro.navigateTo({ url: "/pages/capabilities/index" })}>•••</Text>
    </View>
    <View className={`chat-actions ${actionsVisible || drawerOpen || filesOpen ? "visible" : "hidden"}`}>
      <View className="chat-action-tab" onClick={openSessionDrawer}><Text>{t("chat.sessions")}</Text></View>
      <View className="chat-action-tab" onClick={() => setFilesOpen(true)}><Text>{t("chat.files")}</Text>{conversationFiles.length > 0 && <Text className="chat-action-count">{conversationFiles.length}</Text>}</View>
      <View className="chat-action-tab" onClick={() => Taro.navigateTo({ url: "/pages/capabilities/index" })}><Text>{t("chat.capabilities")}</Text></View>
    </View>
    <ChatContentResize.Provider value={onContentResize}>
    <View className="messages-shell">
    <ScrollView className="messages" scrollY enhanced showScrollbar={false} scrollIntoView={latestScrollTop === undefined ? scrollId : ""} scrollTop={latestScrollTop} lowerThreshold={80} onScroll={handleMessagesScroll} onScrollToLower={handleMessagesScrollToLower} onTouchStart={handleMessagesTouchStart} onTouchEnd={handleMessagesTouchEnd}>
      {initializing && !messages.length && <View className="chat-initial-loading"><Text>{t("chat.statusRestoringSession")}…</Text></View>}
      <View className="day-pill">{t("chat.today")}</View>
      {windowed.hiddenCount > 0 && <View className="load-earlier" onClick={() => void moveHistory("earlier")}>
        <Text className="load-earlier-label">{t("chat.earlier", { count: windowed.hiddenCount })}</Text>
      </View>}
      {shownMessages.map((message, index) => <ChatMessageRow key={message.id} message={message}
        active={index === activeAssistantIndex} recovering={index === activeAssistantIndex && recovering}
        session={session} avatarUrl={session?.mate?.avatarUrl || selectedMate?.avatarUrl}
        approvals={runtimeApprovals} onApproval={handleApproval} onOpen={openPart} />)}
      {windowed.newerCount > 0 && <View className="load-earlier load-newer" onClick={() => void moveHistory("newer")}>
        <Text className="load-earlier-label">{t("chat.newer", { count: windowed.newerCount })}</Text>
      </View>}
      {atNewestWindow && <RuntimeApprovalCards approvals={runtimeApprovals} busyId={approvalBusyId} error={approvalError}
        notice={approvalNotice} onDecision={(id, decision) => { void handleRuntimeApproval(id, decision); }} />}
      {showTypingRow && <View className="message-row assistant">
        <MateAvatar avatarUrl={session?.mate?.avatarUrl || selectedMate?.avatarUrl} className="message-avatar" motion={recovering ? "waiting" : "running"} />
        <TypingIndicator label={recovering ? t("chat.statusRestoring") : ""} />
      </View>}
      <View className="message-spacer" />
      <View id="chat-tail-0" className="scroll-tail" />
      <View id="chat-tail-1" className="scroll-tail" />
    </ScrollView>
    {!followTail && <Button className="jump-to-latest" onClick={jumpToLatest}><Text>{t("chat.latest")}</Text></Button>}
    </View>
    </ChatContentResize.Provider>
    <Composer
      keyboardOpen={viewport.keyboardOpen}
      onKeyboardHeight={viewport.onKeyboardHeight}
      onFocus={viewport.onFocus}
      onBlur={viewport.onBlur}
      onResize={onComposerResize}
      attachments={attachments}
      busy={initializing}
      error={error}
      input={input}
      onAttach={attach}
      onChange={setInput}
      onRemove={(index) => setAttachments((items) => items.filter((_, cursor) => cursor !== index))}
      onRetry={retryChat}
      onSend={send}
      onStop={() => chatRef.current?.stop()}
      canContinue={canContinue}
      onContinue={() => chatRef.current?.continue(t("chat.continueInstruction"))}
      streaming={streaming}
      uploading={uploading}
      failedFiles={failedUploads}
      onRetryUploads={() => void retryUploads()}
      onRemoveFailed={(index) => setFailedUploads((items) => items.filter((_, cursor) => cursor !== index))}
    />
    <SessionDrawer
      busyId={actions.busyId}
      error={drawerError}
      mateName={session?.mate?.displayName || selectedMate?.displayName || ""}
      onAction={handleDrawerAction}
      onClose={() => setDrawerOpen(false)}
      onNew={() => switchSession()}
      onSelect={switchSession}
      open={drawerOpen}
      selectedId={session?.conversationId}
      sessions={conversations}
      switchingId={switchingId}
    />
    {filesOpen && <View className="chat-files-drawer">
      <View className="chat-files-mask" onClick={() => setFilesOpen(false)} />
      <View className="chat-files-panel">
        <View className="chat-files-head"><Text>{t("chat.files")}</Text><Text className="chat-files-close" onClick={() => setFilesOpen(false)}>×</Text></View>
        <ScrollView className="chat-files-list" scrollY>
          {conversationFiles.length ? conversationFiles.map((part) => <View key={part.url} className="chat-files-row" onClick={() => { setFilesOpen(false); void openPart(part); }}>
            <Image src={fileTypeIcon(part.filename || "", part.mediaType)} className="chat-files-icon" mode="aspectFit" />
            <Text>{part.filename || t("parts.generatedFile")}</Text><Text className="chat-files-chevron">›</Text>
          </View>) : <Text className="chat-files-empty">{t("chat.noFiles")}</Text>}
        </ScrollView>
      </View>
    </View>}
    <MateSidebar
      active="chat"
      mates={mates}
      onClose={() => setNavOpen(false)}
      onCreate={() => { setNavOpen(false); setCreateError(""); setCreatingMate(true); }}
      onKnowledge={() => { setNavOpen(false); void Taro.redirectTo({ url: "/pages/knowledge/index" }); }}
      onLogout={() => void signOut()}
      onSelect={(mate) => void switchMate(mate)}
      onSetup={() => { setNavOpen(false); void Taro.redirectTo({ url: "/pages/mates/index" }); }}
      onSettings={(mate) => { setNavOpen(false); void Taro.navigateTo({ url: `/pages/mate-settings/index?id=${encodeURIComponent(mate.id)}` }); }}
      open={navOpen}
      selectedMateId={selectedMate?.id}
      showSetup={!mates.some((mate) => mate.isDefault && mate.status === "published")}
      user={user}
    />
    {creatingMate && <View className="mate-create-overlay" onClick={() => { if (!createBusy) closeCreateMate(); }}>
      <View className="mate-create-panel" onClick={(event) => event.stopPropagation()}>
        <View className="mate-create-header"><Text>{t("home.createTitle")}</Text><Text className="mate-create-close" onClick={() => { if (!createBusy) closeCreateMate(); }}>×</Text></View>
        <ScrollView className="mate-create-content" scrollY>
          <MateIdentityForm busy={createBusy} value={identity} onChange={(next) => { setIdentity(next); setCreateError(""); }} />
          {createError && <Text className="mate-create-error">{createError}</Text>}
        </ScrollView>
        <View className="mate-create-actions"><Button disabled={createBusy} onClick={closeCreateMate}>{t("common.cancel")}</Button><Button className="mate-create-submit" disabled={createBusy || !identity.displayName.trim() || !identity.jobRole.trim()} onClick={() => void createMate()}>{createBusy ? t("common.processing") : t("home.createAndStart")}</Button></View>
      </View>
    </View>}
  </View>;
}

function chatLoadError(error: unknown, t: ReturnType<typeof useI18n>["t"]) {
  if (isRuntimeSessionInvalid(error)) return t("chat.sessionExpired");
  if (error instanceof Error && error.message && !/^[a-z0-9_]+$/i.test(error.message)) return error.message;
  return t("chat.loadFailed");
}

async function restoreLiveSession(mate: NonNullable<LiveSession["mate"]>) {
  const base = await createLiveSession(mate, undefined, { includeConversations: true, newConversation: false });
  const latest = newestFirst(base.conversations || [])[0];
  if (latest) {
    const restored = { ...base, conversationId: latest.id, conversationState: "persisted" as const };
    state.setLiveSession(restored);
    return restored;
  }
  // No history yet: create an explicit first conversation after the page is already visible.
  const created = await createLiveSession(mate, undefined, { includeConversations: true, newConversation: true });
  created.conversations = [];
  state.setLiveSession(created);
  return created;
}

function customNavigationMetrics() {
  const windowInfo = Taro.getWindowInfo();
  const capsule = Taro.getMenuButtonBoundingClientRect();
  const statusBarHeight = windowInfo.statusBarHeight || capsule.top || 20;
  const gap = Math.max(4, capsule.top - statusBarHeight);
  return { height: capsule.bottom + gap, statusBarHeight };
}
