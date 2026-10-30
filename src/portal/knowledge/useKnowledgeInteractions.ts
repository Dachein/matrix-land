import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent } from "react";
import type { KnowledgeItem, KnowledgeViewMode } from "./types";
import type { KnowledgeContextMenu } from "./workspaceTypes";
import type { useKnowledgeTree } from "./useKnowledgeTree";

// Own selection gestures, keyboard navigation, menus, properties and viewer state.
export function useKnowledgeInteractions({ tree, selectedItem, navigableItems, viewMode, editOpen }: {
  tree: Pick<ReturnType<typeof useKnowledgeTree>, "folderTrail" | "selectedId" | "setSelectedId" | "browseFolder" | "browseRoot" | "rememberRecentItem">;
  selectedItem: KnowledgeItem | undefined;
  navigableItems: KnowledgeItem[];
  viewMode: KnowledgeViewMode;
  editOpen: boolean;
}) {
  const { folderTrail, selectedId, setSelectedId, browseFolder, browseRoot, rememberRecentItem } = tree;
  const [viewerItem, setViewerItem] = useState<KnowledgeItem>();
  const [viewerFullscreen, setViewerFullscreen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<KnowledgeContextMenu>();
  const explorerRef = useRef<HTMLElement>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const suppressNextOpenRef = useRef(false);
  useEffect(() => {
    if (detailsOpen && !selectedItem) setDetailsOpen(false);
  }, [detailsOpen, selectedItem]);
  useEffect(() => {
    const closeViewer = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !viewerItem || editOpen) {
        return;
      }
      if (viewerFullscreen) {
        setViewerFullscreen(false);
        return;
      }
      setViewerItem(undefined);
    };

    window.addEventListener("keydown", closeViewer);
    return () => window.removeEventListener("keydown", closeViewer);
  }, [editOpen, viewerFullscreen, viewerItem]);

  useEffect(() => () => clearLongPressTimer(), []);

  useLayoutEffect(() => {
    if (!contextMenu) {
      return undefined;
    }

    // Read after selection has rendered: both focus scrolling and changes to
    // the properties panel can queue a scroll notification before opening.
    const viewportScroll = { x: window.scrollX, y: window.scrollY };
    const closeMenu = () => setContextMenu(undefined);
    const closeOnScroll = (event: Event) => {
      // Selecting another item can scroll the separate properties pane. That
      // does not move the explorer trigger and must not dismiss its menu.
      if (event.target instanceof Element
        && !event.target.contains(explorerRef.current)
        && !explorerRef.current?.contains(event.target)) return;
      if ((event.target === document || event.target === window)
        && window.scrollX === viewportScroll.x
        && window.scrollY === viewportScroll.y) return;
      closeMenu();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeOnScroll, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeOnScroll, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  function openFolder(item: KnowledgeItem) {
    setContextMenu(undefined);
    browseFolder(item);
  }

  function openRoot() {
    const rootFolder = folderTrail[0];
    browseRoot(detailsOpen ? rootFolder?.id ?? "" : "");
    if (detailsOpen && !rootFolder) setDetailsOpen(false);
  }

  function openItem(item: KnowledgeItem) {
    setContextMenu(undefined);
    if (item.kind === "folder") {
      openFolder(item);
      return;
    }
    rememberRecentItem(item);
    setViewerItem(item);
    setViewerFullscreen(false);
  }

  function openItemFromPrimaryAction(item: KnowledgeItem) {
    if (suppressNextOpenRef.current) {
      suppressNextOpenRef.current = false;
      return;
    }
    openItem(item);
  }

  function activateItem(item: KnowledgeItem) {
    if (detailsOpen) {
      selectItem(item);
      return;
    }
    openItemFromPrimaryAction(item);
  }

  function openItemProperties(item: KnowledgeItem) {
    setContextMenu(undefined);
    setSelectedId(item.id);
    setDetailsOpen(true);
  }

  function selectItem(item: KnowledgeItem, focus = false) {
    setSelectedId(item.id);
    if (focus) {
      focusKnowledgeItem(item.id);
    }
  }

  function openItemMenu(item: KnowledgeItem, x: number, y: number, propertiesOnly = false) {
    const menuWidth = 188;
    const menuHeight = 220;
    setSelectedId(item.id);
    setContextMenu({
      item,
      propertiesOnly,
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8))
    });
  }

  function showItemMenu(item: KnowledgeItem, event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    openItemMenu(item, event.clientX, event.clientY);
  }

  function showCurrentFolderMenu(item: KnowledgeItem, event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    openItemMenu(item, event.clientX, event.clientY, true);
  }

  function focusKnowledgeItem(itemId: string) {
    window.requestAnimationFrame(() => {
      const target = Array.from(explorerRef.current?.querySelectorAll<HTMLElement>("[data-knowledge-item-id]") ?? [])
        .find((element) => element.dataset.knowledgeItemId === itemId);
      (target?.querySelector<HTMLElement>(".portal-knowledge-unified-hit, .portal-knowledge-row-hit, .portal-knowledge-tile-hit") ?? target)
        ?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function handleExplorerKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (isTextEntryTarget(event.target)) {
      return;
    }

    if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key) || navigableItems.length === 0) {
      return;
    }

    event.preventDefault();
    const selectedIndex = navigableItems.findIndex((item) => item.id === selectedId);
    if (selectedIndex < 0) {
      selectItem(navigableItems[event.key === "ArrowLeft" || event.key === "ArrowUp" ? navigableItems.length - 1 : 0], true);
      return;
    }

    const columns = viewMode === "grid" ? gridColumnCount() : 1;
    const delta = {
      ArrowDown: columns,
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -columns
    }[event.key] ?? 0;
    const nextIndex = Math.max(0, Math.min(navigableItems.length - 1, selectedIndex + delta));
    selectItem(navigableItems[nextIndex], true);
  }

  function gridColumnCount() {
    const grid = explorerRef.current?.querySelector<HTMLElement>("[data-knowledge-grid]");
    const firstTile = grid?.querySelector<HTMLElement>("[data-knowledge-item-id]");
    if (!grid || !firstTile) {
      return 1;
    }
    const styles = window.getComputedStyle(grid);
    const gap = Number.parseFloat(styles.columnGap || styles.gap || "12") || 12;
    const tileWidth = firstTile.getBoundingClientRect().width;
    return Math.max(1, Math.floor((grid.clientWidth + gap) / Math.max(1, tileWidth + gap)));
  }

  function beginItemLongPress(item: KnowledgeItem, event: PointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse") {
      return;
    }
    clearLongPressTimer();
    const { clientX, clientY } = event;
    longPressTimerRef.current = window.setTimeout(() => {
      suppressNextOpenRef.current = true;
      openItemMenu(item, clientX, clientY);
    }, 520);
  }

  function clearLongPressTimer() {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  return {
    viewerItem,
    setViewerItem,
    viewerFullscreen,
    setViewerFullscreen,
    detailsOpen,
    setDetailsOpen,
    contextMenu,
    setContextMenu,
    openRoot,
    openItemFromPrimaryAction,
    activateItem,
    openItemProperties,
    selectItem,
    showItemMenu,
    showCurrentFolderMenu,
    handleExplorerKeyDown,
    beginItemLongPress,
    clearLongPressTimer,
    explorerRef,
  };
}

function isTextEntryTarget(target: EventTarget) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || target.isContentEditable;
}
