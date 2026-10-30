import { X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { launchPortalApp } from "../../../../src/portal/lib/launchPortalApp";
import type { PortalShortcut } from "../lib/viewModels";

type RailDrag = {
  longPressed: boolean;
  moved: boolean;
  pointerId: number;
  scrollLeft: number;
  startX: number;
};

const APPLICATION_EDIT_LONG_PRESS_MS = 500;

export function ApplicationRailSkeleton({ label }: { label: string }) {
  return (
    <div aria-label={label} aria-live="polite" className="portal-quick-grid portal-quick-skeleton" role="status">
      {[0, 1, 2].map((item) => (
        <span aria-hidden="true" className="portal-quick-skeleton-item" key={item} />
      ))}
    </div>
  );
}

export function ApplicationRail({
  ariaLabel,
  onRemove,
  removeLabel,
  shortcuts
}: {
  ariaLabel: string;
  onRemove?: (shortcut: PortalShortcut) => void;
  removeLabel?: (name: string) => string;
  shortcuts: PortalShortcut[];
}) {
  const drag = useRef<RailDrag | undefined>(undefined);
  const longPressTimer = useRef<number | undefined>(undefined);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);

  function clearLongPressTimer() {
    if (longPressTimer.current !== undefined) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = undefined;
    }
  }

  useEffect(() => clearLongPressTimer, []);

  useEffect(() => {
    if (!editing) {
      return;
    }

    const finishEditingOutsideApp = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".portal-quick-item")) {
        setEditing(false);
      }
    };

    document.addEventListener("pointerdown", finishEditingOutsideApp);
    return () => document.removeEventListener("pointerdown", finishEditingOutsideApp);
  }, [editing]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) {
      return;
    }

    const target = event.target instanceof Element ? event.target : undefined;
    if (target?.closest(".portal-quick-remove")) {
      return;
    }

    drag.current = {
      longPressed: false,
      moved: false,
      pointerId: event.pointerId,
      scrollLeft: event.currentTarget.scrollLeft,
      startX: event.clientX
    };

    if (onRemove && !editing && target?.closest(".portal-quick-item")) {
      clearLongPressTimer();
      longPressTimer.current = window.setTimeout(() => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId || current.moved) {
          return;
        }

        current.longPressed = true;
        suppressClick.current = true;
        setEditing(true);
      }, APPLICATION_EDIT_LONG_PRESS_MS);
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }

    const delta = current.startX - event.clientX;
    if (!current.moved && Math.abs(delta) < 6) {
      return;
    }

    clearLongPressTimer();
    current.moved = true;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.currentTarget.scrollLeft = current.scrollLeft + delta;
    setDragging(true);
  }

  function finishPointerDrag(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }

    clearLongPressTimer();
    suppressClick.current = !cancelled && (current.moved || current.longPressed);
    if (suppressClick.current) {
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    }
    drag.current = undefined;
    setDragging(false);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleClickCapture(event: ReactMouseEvent<HTMLDivElement>) {
    if (!suppressClick.current) {
      return;
    }

    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && editing) {
      event.preventDefault();
      setEditing(false);
      return;
    }

    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    event.currentTarget.scrollBy({
      behavior: "smooth",
      left: event.key === "ArrowRight" ? 170 : -170
    });
  }

  return (
    <div
      aria-label={ariaLabel}
      className={`portal-quick-grid${dragging ? " dragging" : ""}${editing ? " editing" : ""}`}
      onClickCapture={handleClickCapture}
      onContextMenu={(event) => {
        if (event.target instanceof Element && event.target.closest(".portal-quick-item")) {
          event.preventDefault();
        }
      }}
      onKeyDown={handleKeyDown}
      onPointerCancel={(event) => finishPointerDrag(event, true)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerDrag}
      role="region"
      tabIndex={0}
    >
      {shortcuts.map((shortcut) => (
        <ShortcutItem
          key={`${shortcut.kind}:${shortcut.id}`}
          editing={editing}
          onRemove={() => onRemove?.(shortcut)}
          removeLabel={removeLabel?.(shortcut.name) ?? ""}
          shortcut={shortcut}
        />
      ))}
    </div>
  );
}

function ShortcutItem({
  editing,
  onRemove,
  removeLabel,
  shortcut
}: {
  editing: boolean;
  onRemove: () => void;
  removeLabel: string;
  shortcut: PortalShortcut;
}) {
  return (
    <article className="portal-quick-item" data-status={shortcut.status}>
      <button
        aria-disabled={editing || undefined}
        aria-label={shortcut.name}
        className="portal-quick-open"
        onClick={(event) => {
          if (editing) {
            event.preventDefault();
            return;
          }
          void launchPortalApp({ ...shortcut.launchTarget, trackingSource: "home_shortcut" });
        }}
        title={shortcut.name}
        type="button"
      >
        <ShortcutMark shortcut={shortcut} />
        <span className="portal-quick-copy">
          <strong>{shortcut.name}</strong>
        </span>
      </button>
      {editing && (
        <button
          aria-label={removeLabel}
          className="portal-quick-remove"
          onClick={onRemove}
          title={removeLabel}
          type="button"
        >
          <X aria-hidden="true" size={14} />
        </button>
      )}
    </article>
  );
}

function ShortcutMark({ shortcut }: { shortcut: PortalShortcut }) {
  const initials = shortcut.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <span className={`portal-object-mark ${shortcut.kind}`}>
      {shortcut.coverImageUrl ? <img alt="" draggable={false} src={shortcut.coverImageUrl} /> : initials}
    </span>
  );
}
