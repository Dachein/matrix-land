import {
  Archive, ArchiveRestore, Languages, ListTodo, LoaderCircle, MessageSquarePlus,
  MessageSquareText, MoreHorizontal, Pencil, Pin, PinOff, Settings2, Trash2, Type
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  requestMateRuntimeCollection,
  requestMateConversationPage,
  type MatePreviewSession,
  type MateRuntimeDirectoryItem
} from "../api";
import { browserDirectoryStorage, readMateDirectoryCache, mateDirectoryCacheKey, writeMateDirectoryCache } from "../directoryCache";
import { groupConversationDirectoryItems } from "../directoryOrdering";
import { formatCompactRelativeTime, formatExactTimestamp, timestampMs } from "../relativeTime";
import { useMateLocale } from "../locale";
import { UserAvatar } from "./MateAvatar";
import type { MateChatTextSize } from "./ConversationToolbar";

export type ConversationDirectoryAction =
  | { id: string; type: "delete" }
  | { id: string; pinned: boolean; type: "pin" }
  | { id: string; status: "active" | "archived"; type: "archive" }
  | { id: string; title: string; type: "rename" };

export function StandaloneNavigation({
  conversationActionError,
  clearingPreview,
  directoryRevision,
  directoryTitles,
  entry,
  fetch: fetcher,
  onClearPreview,
  onConversationAction,
  onCreateConversation,
  onSelectConversation,
  onSelectEntry,
  onPortalConversationCountChange,
  portalSummary = false,
  session,
  switchingConversationId,
  textSize,
  onTextSizeChange
}: {
  conversationActionError: string;
  clearingPreview: boolean;
  directoryRevision: number;
  directoryTitles: Record<string, string>;
  entry?: MatePreviewSession["surface"]["entries"][number];
  fetch?: typeof globalThis.fetch;
  onClearPreview: () => void;
  onConversationAction: (action: ConversationDirectoryAction) => Promise<void>;
  onCreateConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onSelectEntry: (channel: string) => void;
  onPortalConversationCountChange?: (count: number) => void;
  portalSummary?: boolean;
  session: MatePreviewSession;
  switchingConversationId: string;
  textSize: MateChatTextSize;
  onTextSizeChange: (textSize: MateChatTextSize) => void;
}) {
  const { locale, setLocale, text } = useMateLocale();
  const resource = entry?.kind === "task_inbox" ? "tasks" : "conversations";
  const cacheKey = mateDirectoryCacheKey(session, resource);
  const [directory, setDirectory] = useState<{ key: string; items: MateRuntimeDirectoryItem[] }>(() => ({
    key: cacheKey,
    items: readMateDirectoryCache(browserDirectoryStorage(), session, resource) ?? []
  }));
  const items = directory.key === cacheKey ? directory.items : [];
  const [menu, setMenu] = useState<{ item: MateRuntimeDirectoryItem; x: number; y: number }>();
  const [busyId, setBusyId] = useState("");
  const [directoryTab, setDirectoryTab] = useState<"active" | "archived">("active");
  const [cursors, setCursors] = useState<Record<"active" | "archived", string | null>>({ active: null, archived: null });
  const [loading, setLoading] = useState(false);
  const [directoryRevisionRetry, setDirectoryRevisionRetry] = useState(0);
  const [pageError, setPageError] = useState("");
  const loadedPages = useRef({ key: cacheKey, active: 1, archived: 1 });
  const archiveOverrides = useRef(new Map<string, "active" | "archived">());
  const pinOverrides = useRef(new Map<string, { pinned: boolean; updatedAt: string }>());
  const loadMoreController = useRef<AbortController | null>(null);
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const taskEntry = session.surface.entries.find((candidate) => candidate.kind === "task_inbox");
  const conversationEntry = session.surface.entries.find((candidate) => candidate.kind === "conversation");
  const selectedConversationId = switchingConversationId && switchingConversationId !== "new"
    ? switchingConversationId
    : session.conversationId;

  useEffect(() => {
    const controller = new AbortController();
    const storage = browserDirectoryStorage();
    const cached = readMateDirectoryCache(storage, session, resource);
    if (loadedPages.current.key !== cacheKey) {
      loadedPages.current = { key: cacheKey, active: 1, archived: 1 };
      archiveOverrides.current.clear();
      pinOverrides.current.clear();
      setDirectoryTab("active");
      setCursors({ active: null, archived: null });
    }
    // Keep the visible list while revalidating after an action.
    setDirectory((current) => current.key === cacheKey ? current : { key: cacheKey, items: cached ?? [] });
    setLoading(true);
    setPageError("");
    const load = async () => {
      if (resource === "tasks") return requestMateRuntimeCollection({ fetch: fetcher, session, signal: controller.signal }, resource);
      const pages = await Promise.all((["active", "archived"] as const).map(async (status) => {
        let cursor: string | null = null;
        const result: MateRuntimeDirectoryItem[] = [];
        for (let page = 0; page < loadedPages.current[status]; page++) {
          const next = await requestMateConversationPage({ fetch: fetcher, session, signal: controller.signal, status, cursor: cursor ?? undefined });
          result.push(...next.items);
          cursor = next.nextCursor;
          if (!cursor) break;
        }
        return { status, items: result, cursor };
      }));
      if (!controller.signal.aborted) setCursors({ active: pages[0].cursor, archived: pages[1].cursor });
      return pages.flatMap((page) => page.items);
    };
    void load().then((next) => {
      if (controller.signal.aborted) return;
      const merged = next.map((item) => {
        const status = archiveOverrides.current.get(item.id);
        if (status === item.status) archiveOverrides.current.delete(item.id);
        const pin = pinOverrides.current.get(item.id);
        if (pin?.pinned === item.pinned) pinOverrides.current.delete(item.id);
        return status ? { ...item, status, pinned: false } : pin ? { ...item, ...pin } : item;
      });
      writeMateDirectoryCache(storage, session, resource, merged);
      setDirectory({ key: cacheKey, items: merged });
    }).catch(() => {
      if (!controller.signal.aborted) setPageError(text("加载失败，请重试。", "Could not load conversations. Please retry."));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); loadMoreController.current?.abort(); };
  }, [cacheKey, directoryRevision, directoryRevisionRetry, fetcher, resource, session]);

  const loadMore = async () => {
    const cursor = cursors[directoryTab];
    if (!cursor || loading) return;
    const controller = new AbortController();
    loadMoreController.current = controller;
    setLoading(true);
    setPageError("");
    try {
      const next = await requestMateConversationPage({ fetch: fetcher, session, status: directoryTab, cursor, signal: controller.signal });
      if (controller.signal.aborted) return;
      loadedPages.current[directoryTab]++;
      setCursors((current) => ({ ...current, [directoryTab]: next.nextCursor }));
      setDirectory((current) => {
        const ids = new Set(current.items.map((item) => item.id));
        const merged = [...current.items, ...next.items.filter((item) => !ids.has(item.id)).map((item) => {
          const status = archiveOverrides.current.get(item.id);
          const pin = pinOverrides.current.get(item.id);
          return status ? { ...item, status, pinned: false } : pin ? { ...item, ...pin } : item;
        })];
        writeMateDirectoryCache(browserDirectoryStorage(), session, resource, merged);
        return { key: cacheKey, items: merged };
      });
    } catch {
      if (!controller.signal.aborted) setPageError(text("加载失败，请重试。", "Could not load conversations. Please retry."));
    } finally { if (!controller.signal.aborted) setLoading(false); }
  };

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(undefined);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    const timer = window.setInterval(() => setRelativeTimeNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setSettingsOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [settingsOpen]);

  const visibleItems = entry?.kind === "conversation"
    && session.conversationState === "persisted"
    && !archiveOverrides.current.has(session.conversationId)
    && !items.some((item) => item.id === session.conversationId)
    ? [{ id: session.conversationId, pinned: false, status: "active", title: session.mode === "preview" ? text("当前 Preview 对话", "Current Preview conversation") : text("当前对话", "Current conversation") }, ...items]
    : items;
  const titledItems = visibleItems.map((item) => (
    directoryTitles[item.id] ? { ...item, title: directoryTitles[item.id] } : item
  ));
  const conversationItems = entry?.kind === "conversation" ? titledItems : [];
  const { pinned: pinnedItems, recent: activeItems, archived: archivedItems, active: recentConversationItems } =
    groupConversationDirectoryItems(conversationItems);
  useEffect(() => onPortalConversationCountChange?.(recentConversationItems.length), [onPortalConversationCountChange, recentConversationItems.length]);

  const act = async (action: ConversationDirectoryAction) => {
    if (busyId || switchingConversationId || clearingPreview) return;
    setMenu(undefined);
    setBusyId(action.id);
    const previous = items.find((item) => item.id === action.id);
    if (action.type === "pin") {
      const patch = { pinned: action.pinned, updatedAt: new Date().toISOString() };
      pinOverrides.current.set(action.id, patch);
      const next = items.map((item) => item.id === action.id ? { ...item, ...patch } : item);
      setDirectory({ key: cacheKey, items: next });
      writeMateDirectoryCache(browserDirectoryStorage(), session, resource, next);
    }
    if (action.type === "archive") {
      archiveOverrides.current.set(action.id, action.status);
      const next = items.map((item) => item.id === action.id ? { ...item, status: action.status, pinned: false } : item);
      setDirectory({ key: cacheKey, items: next });
      writeMateDirectoryCache(browserDirectoryStorage(), session, resource, next);
    }
    try {
      await onConversationAction(action);
    } catch {
      archiveOverrides.current.delete(action.id);
      pinOverrides.current.delete(action.id);
      if (previous) setDirectory((current) => {
        const next = current.items.map((item) => item.id === action.id ? previous : item);
        writeMateDirectoryCache(browserDirectoryStorage(), session, resource, next);
        return { ...current, items: next };
      });
    } finally { setBusyId(""); }
  };
  const openMenu = (item: MateRuntimeDirectoryItem, x: number, y: number) => {
    setMenu({ item, x: Math.min(x, window.innerWidth - 176), y: Math.min(y, window.innerHeight - 190) });
  };
  const renderItem = (item: MateRuntimeDirectoryItem) => {
    const showTimestamp = entry?.kind !== "task_inbox" || item.status?.startsWith("scheduled");
    const updatedTimestamp = showTimestamp ? timestampMs(item.updatedAt) : 0;
    const relativeTime = updatedTimestamp
      ? formatCompactRelativeTime(item.updatedAt, relativeTimeNow, locale)
      : "";
    return <div className={`tm-preview-directory-item${item.status === "archived" ? " is-archived" : ""}`} key={item.id}>
      <button
        aria-current={item.id === selectedConversationId ? "page" : undefined}
        className={item.id === selectedConversationId ? "is-active" : ""}
        disabled={busyId === item.id}
        onClick={() => entry?.kind === "conversation" && onSelectConversation(item.id)}
        onContextMenu={(event) => {
          if (entry?.kind !== "conversation") return;
          event.preventDefault();
          openMenu(item, event.clientX, event.clientY);
        }}
        type="button"
      >
        {entry?.kind === "conversation" && item.pinned ? <Pin aria-label={text("已置顶", "Pinned")} size={14} /> : busyId === item.id ? <LoaderCircle className="is-spinning" size={14} /> : entry?.kind === "task_inbox" ? <ListTodo size={14} /> : <MessageSquareText aria-hidden="true" size={14} />}
        <span>
          <strong>{item.title}</strong>
          {(entry?.kind === "task_inbox" ? item.status || relativeTime : relativeTime) && <small>
            {entry?.kind === "task_inbox" && item.status}
            {entry?.kind === "task_inbox" && item.status && relativeTime && " · "}
            {relativeTime && <time dateTime={new Date(updatedTimestamp).toISOString()} title={formatExactTimestamp(item.updatedAt, locale)}>{relativeTime}</time>}
          </small>}
        </span>
      </button>
      {entry?.kind === "conversation" && (
        <button aria-label={text("更多操作", "More actions")} className="tm-preview-directory-more" onClick={(event) => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); openMenu(item, box.right, box.bottom); }} title={text(`${item.title} 更多操作`, `More actions for ${item.title}`)} type="button">
          <MoreHorizontal size={13} />
        </button>
      )}
    </div>;
  };

  return (
    <aside className="tm-preview-navigation-rail" aria-label={session.mode === "preview" ? text("Mate Preview 导航", "Mate Preview navigation") : text("Mate 导航", "Mate navigation")}>
      <nav className={`tm-preview-rail-tabs${taskEntry ? "" : " is-single"}`} aria-label={text("对话和任务", "Conversations and tasks")}>
        {conversationEntry && (
          <button aria-current={entry?.kind === "conversation" ? "page" : undefined} onClick={() => onSelectEntry(conversationEntry.channel)} type="button">
            <MessageSquareText size={15} />{text("对话", "Conversations")}
          </button>
        )}
        {taskEntry && (
          <button aria-current={entry?.kind === "task_inbox" ? "page" : undefined} onClick={() => onSelectEntry(taskEntry.channel)} type="button">
            <ListTodo size={15} />{text("任务", "Tasks")}
          </button>
        )}
      </nav>
      {!portalSummary && <div className="tm-preview-directory-toolbar">
        {entry?.kind === "conversation" ? (
          <button className="tm-preview-new-conversation" onClick={onCreateConversation} type="button"><MessageSquarePlus size={15} />{text("新对话", "New conversation")}</button>
        ) : <span>{text("任务", "TASKS")}</span>}
        {session.mode === "preview" && (
          <button aria-label={text("清空 Preview 记录", "Clear Preview records")} className="tm-preview-clear-directory" disabled={clearingPreview || Boolean(switchingConversationId)} onClick={onClearPreview} title={text("清空当前 Owner 的 Preview 对话与任务", "Clear this owner's Preview conversations and tasks")} type="button">
            {clearingPreview ? <LoaderCircle className="is-spinning" size={13} /> : <Trash2 size={13} />}
          </button>
        )}
      </div>}
      <div className="tm-preview-directory-list">
        {portalSummary && entry?.kind === "conversation" ? (
          recentConversationItems.length ? <>
            {pinnedItems.length > 0 && <section className="tm-preview-directory-group" aria-label={text("置顶对话", "Pinned conversations")}>
              <div className="tm-preview-directory-group-label">{text("置顶", "Pinned")}</div>
              {pinnedItems.slice(0, 5).map(renderItem)}
            </section>}
            {activeItems.length > 0 && pinnedItems.length < 5 && <section className="tm-preview-directory-group" aria-label={text("最近对话", "Recent conversations")}>
              {pinnedItems.length > 0 && <div className="tm-preview-directory-group-label">{text("最近", "Recent")}</div>}
              {activeItems.slice(0, Math.max(0, 5 - pinnedItems.length)).map(renderItem)}
            </section>}
          </> : <p>{text("还没有对话。", "No conversations yet.")}</p>
        ) : entry?.kind === "conversation" ? (
          <>
            <div className="tm-preview-directory-tabs" role="tablist" aria-label={text("对话状态", "Conversation status")}>
              {(["active", "archived"] as const).map((status) => <button
                key={status} id={`conversation-tab-${status}`} role="tab" aria-selected={directoryTab === status}
                aria-controls="conversation-directory-panel" tabIndex={directoryTab === status ? 0 : -1}
                onClick={() => setDirectoryTab(status)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next = event.key === "Home" ? "active" : event.key === "End" ? "archived" : directoryTab === "active" ? "archived" : "active";
                  setDirectoryTab(next);
                  document.getElementById(`conversation-tab-${next}`)?.focus();
                }} type="button">{status === "active" ? text("活跃", "Active") : text("已存档", "Archived")}</button>)}
            </div>
            <div id="conversation-directory-panel" role="tabpanel" aria-labelledby={`conversation-tab-${directoryTab}`} aria-busy={loading} tabIndex={0}>
              {(directoryTab === "active" ? recentConversationItems : archivedItems).map(renderItem)}
              {!(directoryTab === "active" ? recentConversationItems : archivedItems).length && !loading && !pageError && <p>{directoryTab === "active" ? text("暂无活跃对话。", "No active conversations.") : text("暂无已存档对话。", "No archived conversations.")}</p>}
              {loading && !conversationItems.length && <p role="status">{text("加载中…", "Loading…")}</p>}
              {cursors[directoryTab] && <button className="tm-preview-directory-load-more" disabled={loading} onClick={() => void loadMore()} type="button">{text("加载更多", "Load more")}</button>}
            </div>
          </>

        ) : titledItems.length ? titledItems.map(renderItem) : <p>{session.mode === "preview" ? text("当前 Preview 空间暂无记录。", "No records in this Preview namespace.") : text("当前用户暂无记录。", "No records for this user.")}</p>}
        {pageError && <p className="tm-preview-directory-error" role="alert">{pageError} <button onClick={() => {
          if (cursors[directoryTab]) void loadMore();
          else setDirectoryRevisionRetry((value) => value + 1);
        }} type="button">{text("重试", "Retry")}</button></p>}
        {conversationActionError && <p className="tm-preview-directory-error" role="alert">{conversationActionError}</p>}
      </div>
      {menu && (
        <div className="tm-preview-conversation-menu" onClick={(event) => event.stopPropagation()} role="menu" style={{ left: menu.x, top: menu.y }}>
          <button onClick={() => {
            const title = window.prompt(text("修改对话标题", "Rename conversation"), menu.item.title)?.replace(/\s+/g, " ").trim();
            if (title && title !== menu.item.title) void act({ id: menu.item.id, title, type: "rename" });
          }} role="menuitem" type="button"><Pencil size={13} />{text("修改标题", "Rename")}</button>
          {menu.item.status !== "archived" && (
            <button onClick={() => void act({ id: menu.item.id, pinned: !menu.item.pinned, type: "pin" })} role="menuitem" type="button">
              {menu.item.pinned ? <PinOff size={13} /> : <Pin size={13} />}{menu.item.pinned ? text("取消置顶", "Unpin") : text("置顶", "Pin")}
            </button>
          )}
          <button onClick={() => void act({ id: menu.item.id, status: menu.item.status === "archived" ? "active" : "archived", type: "archive" })} role="menuitem" type="button">
            {menu.item.status === "archived" ? <ArchiveRestore size={13} /> : <Archive size={13} />}{menu.item.status === "archived" ? text("恢复", "Restore") : text("存档", "Archive")}
          </button>
          <button className="is-danger" onClick={() => {
            if (window.confirm(text(`删除“${menu.item.title}”？对话记录及对应 Agent DO 将被永久删除。`, `Delete “${menu.item.title}”? The conversation and its Agent DO will be permanently deleted.`))) void act({ id: menu.item.id, type: "delete" });
          }} role="menuitem" type="button"><Trash2 size={13} />{text("删除", "Delete")}</button>
        </div>
      )}
      <div className="tm-preview-rail-footer" ref={settingsRef}>
        {settingsOpen && (
          <div aria-label={text("显示设置", "Display settings")} className="tm-preview-user-settings-popover" role="dialog">
            <div className="tm-preview-preference-row">
              <span><Languages aria-hidden="true" size={14} /><strong>{text("语言", "Language")}</strong></span>
              <div aria-label={text("界面语言", "Interface language")} className="tm-preview-preference-options" role="group">
                <button aria-pressed={locale === "zh-CN"} onClick={() => setLocale("zh-CN")} type="button">中文</button>
                <button aria-pressed={locale === "en"} onClick={() => setLocale("en")} type="button">English</button>
              </div>
            </div>
            <div className="tm-preview-preference-row">
              <span><Type aria-hidden="true" size={14} /><strong>{text("布局", "Layout")}</strong></span>
              <div aria-label={text("回答布局", "Answer layout")} className="tm-preview-preference-options" role="group">
                <button aria-pressed={textSize === "compact"} data-testid="preview-text-size-compact" onClick={() => onTextSizeChange("compact")} type="button">{text("紧凑", "Compact")}</button>
                <button aria-pressed={textSize === "standard"} data-testid="preview-text-size-standard" onClick={() => onTextSizeChange("standard")} type="button">{text("标准", "Standard")}</button>
              </div>
            </div>
          </div>
        )}
        <button
          aria-expanded={settingsOpen}
          aria-label={text("打开当前用户设置", "Open current user settings")}
          className="tm-preview-user-settings-trigger"
          onClick={() => setSettingsOpen((value) => !value)}
          type="button"
        >
          <UserAvatar avatarUrl={session.user?.avatarUrl} className="tm-preview-rail-user-avatar" name={session.user?.name || text("当前用户", "Current user")} />
          <strong>{session.user?.name || text("当前用户", "Current user")}</strong>
          <Settings2 aria-hidden="true" size={14} />
        </button>
      </div>
    </aside>
  );
}
