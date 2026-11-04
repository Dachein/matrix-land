import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { WorkspaceListboxOption } from "./WorkspaceListbox";

export function WorkspaceMultiListbox({
  ariaLabel,
  className = "",
  disabled = false,
  noResultsLabel = "No matching options",
  onChange,
  options,
  placeholder = "Select",
  searchPlaceholder = "Search",
  selectedCountLabel,
  values
}: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  noResultsLabel?: ReactNode;
  onChange: (values: string[]) => void;
  options: Array<WorkspaceListboxOption>;
  placeholder?: ReactNode;
  searchPlaceholder?: string;
  selectedCountLabel: (count: number) => ReactNode;
  values: string[];
}) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition>();
  const selected = useMemo(() => new Set(values), [values]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = useMemo(() => options.filter((option) => optionMatchesQuery(option, normalizedQuery)), [normalizedQuery, options]);

  useEffect(() => {
    function handleDocumentPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    }
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    return () => document.removeEventListener("pointerdown", handleDocumentPointerDown);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const focusFrame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    let positionFrame = 0;
    const trackPosition = () => {
      updatePopoverPosition();
      positionFrame = window.requestAnimationFrame(trackPosition);
    };
    updatePopoverPosition();
    positionFrame = window.requestAnimationFrame(trackPosition);
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.cancelAnimationFrame(positionFrame);
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [open]);

  function updatePopoverPosition() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const padding = 12;
    const gap = 6;
    const width = Math.min(Math.max(rect.width, 280), window.innerWidth - padding * 2);
    const left = Math.max(padding, Math.min(rect.left, window.innerWidth - width - padding));
    const belowTop = rect.bottom + gap;
    const availableBelow = window.innerHeight - belowTop - padding;
    const availableAbove = rect.top - padding - gap;
    const openAbove = availableBelow < 180 && availableAbove > availableBelow;
    const maxHeight = Math.max(112, Math.min(360, openAbove ? availableAbove : availableBelow));
    const measuredHeight = popoverRef.current?.offsetHeight;
    const top = openAbove ? Math.max(padding, rect.top - Math.min(measuredHeight ?? maxHeight, maxHeight) - gap) : belowTop;
    const nextPosition = { left, maxHeight, top, width };
    setPopoverPosition((current) => positionsAreEqual(current, nextPosition) ? current : nextPosition);
  }

  function toggleValue(value: string) {
    const next = new Set(values);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange([...next]);
  }

  const popoverStyle: CSSProperties = popoverPosition
    ? { ...popoverPosition, position: "fixed", zIndex: "var(--fw-z-dropdown)" }
    : { left: 0, position: "fixed", top: 0, visibility: "hidden", width: 0, zIndex: "var(--fw-z-dropdown)" };
  const selectedOption = values.length === 1 ? options.find((option) => option.value === values[0]) : undefined;
  const selectedLabel = values.length === 0 ? placeholder : values.length === 1 ? selectedOption?.label ?? selectedCountLabel(1) : selectedCountLabel(values.length);

  const popover = open ? (
    <div
      aria-label={ariaLabel}
      aria-multiselectable="true"
      className="workspaceListboxPopover"
      id={`${id}-listbox`}
      ref={popoverRef}
      role="listbox"
      style={popoverStyle}
    >
      <div className="workspaceListboxSearch">
        <input aria-label={searchPlaceholder} onChange={(event) => setQuery(event.target.value)} placeholder={searchPlaceholder} ref={searchInputRef} value={query} />
      </div>
      {visibleOptions.length > 0 ? visibleOptions.map((option) => {
        const isSelected = selected.has(option.value);
        return (
          <button
            aria-selected={isSelected}
            className={isSelected ? "workspaceListboxOption selected" : "workspaceListboxOption"}
            disabled={option.disabled}
            key={option.value}
            onClick={() => toggleValue(option.value)}
            role="option"
            type="button"
          >
            <span className="workspaceListboxCheck">{isSelected ? <Check size={15} /> : null}</span>
            <span className="workspaceListboxOptionText"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
            {option.meta !== undefined && option.meta !== null && <span className="workspaceListboxMeta">{option.meta}</span>}
          </button>
        );
      }) : <div className="workspaceListboxEmpty">{noResultsLabel}</div>}
    </div>
  ) : null;

  return (
    <div className={["workspaceListbox", "workspaceMultiListbox", className, open ? "open" : ""].filter(Boolean).join(" ")} ref={rootRef}>
      <button
        aria-controls={`${id}-listbox`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="workspaceListboxTrigger noIcon"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        ref={buttonRef}
        type="button"
      >
        <span className="workspaceListboxValue"><strong>{selectedLabel}</strong></span>
        <ChevronDown aria-hidden="true" className="workspaceListboxChevron" size={17} />
      </button>
      {popover && typeof document !== "undefined" ? createPortal(popover, document.body) : popover}
    </div>
  );
}

type PopoverPosition = { left: number; maxHeight: number; top: number; width: number };

function positionsAreEqual(left: PopoverPosition | undefined, right: PopoverPosition) {
  return Boolean(left)
    && left?.left === right.left
    && left.maxHeight === right.maxHeight
    && left.top === right.top
    && left.width === right.width;
}

function optionMatchesQuery(option: WorkspaceListboxOption, query: string) {
  if (!query) return true;
  return [option.searchText, option.value, text(option.label), text(option.description), text(option.meta)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function text(value: ReactNode) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
