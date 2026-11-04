import { useEffect, useRef, type ReactNode } from "react";

const activeDialogs: HTMLElement[] = [];
let activeModalLocks = 0;
let previousDocumentOverflow = "";
let previousBodyOverflow = "";
let previousBodyPaddingRight = "";

export function ModalShell({
  ariaLabel,
  children,
  className,
  header,
  headerActions,
  headerClassName = "appsModalHeader",
  modalClassName = "appsModal",
  manageFocus,
  onClose,
  overlayClassName = "appsModalOverlay"
}: {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  header?: ReactNode;
  headerActions?: ReactNode;
  headerClassName?: string;
  modalClassName?: string;
  /** Defaults on in DesignSystemScope; legacy portaled controls migrate explicitly. */
  manageFocus?: boolean;
  onClose: () => void;
  overlayClassName?: string;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !(manageFocus ?? Boolean(dialog.closest(".fw-scope")))) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    activeDialogs.push(dialog);
    const isTop = () => activeDialogs.at(-1) === dialog;
    const ownedPopover = (target: EventTarget | null) => target instanceof Node
      && Array.from(dialog.querySelectorAll<HTMLElement>("[aria-controls]")).some(trigger =>
        trigger.getAttribute("aria-controls")?.split(/\s+/).some(id => document.getElementById(id)?.contains(target)));
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )).filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest('[inert], [aria-hidden="true"]'));
    const focusFirst = () => (focusable()[0] ?? dialog).focus();
    focusFirst();
    const onKey = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === "Escape") {
        if (ownedPopover(event.target)) return;
        event.preventDefault(); event.stopImmediatePropagation(); closeRef.current();
      }
      if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0];
        const last = elements.at(-1);
        if (!first) { event.preventDefault(); dialog.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    const onFocus = (event: FocusEvent) => { if (isTop() && !dialog.contains(event.target as Node) && !ownedPopover(event.target)) focusFirst(); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus);
    return () => {
      const wasTop = isTop();
      const index = activeDialogs.lastIndexOf(dialog);
      if (index >= 0) activeDialogs.splice(index, 1);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
      if (wasTop && previous?.isConnected) previous.focus();
    };
  }, [manageFocus]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return undefined;
    }

    const { body, documentElement } = document;

    if (activeModalLocks === 0) {
      previousDocumentOverflow = documentElement.style.overflow;
      previousBodyOverflow = body.style.overflow;
      previousBodyPaddingRight = body.style.paddingRight;

      const scrollbarWidth = window.innerWidth - documentElement.clientWidth;
      documentElement.style.overflow = "hidden";
      body.style.overflow = "hidden";

      if (scrollbarWidth > 0) {
        const bodyPaddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;
        body.style.paddingRight = `${bodyPaddingRight + scrollbarWidth}px`;
      }
    }

    activeModalLocks += 1;

    return () => {
      activeModalLocks = Math.max(0, activeModalLocks - 1);

      if (activeModalLocks === 0) {
        documentElement.style.overflow = previousDocumentOverflow;
        body.style.overflow = previousBodyOverflow;
        body.style.paddingRight = previousBodyPaddingRight;
      }
    };
  }, []);

  return (
    <div data-ui="modal-overlay" className={overlayClassName} onMouseDown={onClose} role="presentation">
      <section
        ref={dialogRef}
        tabIndex={-1}
        data-ui="modal"
        aria-label={ariaLabel}
        aria-modal="true"
        className={[modalClassName, className].filter(Boolean).join(" ")}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        {(header || headerActions) && (
          <header className={headerClassName}>
            {header}
            {headerActions}
          </header>
        )}
        {children}
      </section>
    </div>
  );
}
