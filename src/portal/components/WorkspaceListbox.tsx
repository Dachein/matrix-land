import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type WorkspaceListboxOption<TValue extends string = string> = {
  description?: ReactNode;
  disabled?: boolean;
  label: ReactNode;
  meta?: ReactNode;
  searchText?: string;
  value: TValue;
};

export type WorkspaceListboxVariant = "select" | "filter";

export function WorkspaceListbox<TValue extends string>({
  ariaLabel,
  autoFocus = false,
  className = "",
  disabled = false,
  iconBefore,
  noResultsLabel = "No matching options",
  onChange,
  options,
  popoverAlign = "start",
  popoverClassName = "",
  placeholder = "Select",
  popoverMinWidth = 180,
  searchable = false,
  searchPlaceholder = "Search",
  searchThreshold = 8,
  variant = "select",
  value
}: {
  ariaLabel: string;
  autoFocus?: boolean;
  className?: string;
  disabled?: boolean;
  iconBefore?: ReactNode;
  noResultsLabel?: ReactNode;
  onChange: (value: TValue) => void;
  options: Array<WorkspaceListboxOption<TValue>>;
  popoverAlign?: "start" | "end";
  popoverClassName?: string;
  placeholder?: ReactNode;
  popoverMinWidth?: number;
  searchable?: boolean | "auto";
  searchPlaceholder?: string;
  searchThreshold?: number;
  variant?: WorkspaceListboxVariant;
  value: TValue;
}) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [popoverPosition, setPopoverPosition] = useState<WorkspaceListboxPopoverPosition>();
  const selectedOption = options.find((option) => option.value === value);
  const isSearchable = searchable === true || (searchable === "auto" && options.length >= searchThreshold);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = useMemo(() => {
    if (!isSearchable || !normalizedQuery) {
      return options;
    }

    return options.filter((option) => optionMatchesQuery(option, normalizedQuery));
  }, [isSearchable, normalizedQuery, options]);
  const enabledOptions = useMemo(() => visibleOptions.filter((option) => !option.disabled), [visibleOptions]);

  useEffect(() => {
    function handleDocumentPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown);

    return () => document.removeEventListener("pointerdown", handleDocumentPointerDown);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    let focusFrame = 0;
    let positionFrame = 0;
    const trackPopoverPosition = () => {
      updatePopoverPosition();
      positionFrame = window.requestAnimationFrame(trackPopoverPosition);
    };

    updatePopoverPosition();
    if (isSearchable) {
      focusFrame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    }
    positionFrame = window.requestAnimationFrame(trackPopoverPosition);

    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.cancelAnimationFrame(positionFrame);
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [isSearchable, open]);

  function updatePopoverPosition() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const padding = 12;
    const gap = 6;
    const width = Math.min(Math.max(rect.width, popoverMinWidth), window.innerWidth - padding * 2);
    const preferredLeft = popoverAlign === "end" ? rect.right - width : rect.left;
    const left = Math.max(padding, Math.min(preferredLeft, window.innerWidth - width - padding));
    const belowTop = rect.bottom + gap;
    const availableBelow = window.innerHeight - belowTop - padding;
    const availableAbove = rect.top - padding - gap;
    const openAbove = availableBelow < 180 && availableAbove > availableBelow;
    const maxHeight = Math.max(112, Math.min(360, openAbove ? availableAbove : availableBelow));
    const measuredHeight = popoverRef.current?.offsetHeight;
    const placementHeight = measuredHeight ? Math.min(measuredHeight, maxHeight) : maxHeight;
    const top = openAbove ? Math.max(padding, rect.top - placementHeight - gap) : belowTop;

    const nextPosition = { left, maxHeight, top, width };
    setPopoverPosition((current) => positionsAreEqual(current, nextPosition) ? current : nextPosition);
  }

  function openListbox() {
    updatePopoverPosition();
    setOpen(true);
  }

  function toggleListbox() {
    if (open) {
      setOpen(false);
      return;
    }

    openListbox();
  }

  function selectOption(option: WorkspaceListboxOption<TValue>) {
    if (option.disabled) {
      return;
    }

    onChange(option.value);
    setQuery("");
    setOpen(false);
  }

  function moveSelection(event: KeyboardEvent, direction: "first" | "last" | "next" | "previous") {
    if (enabledOptions.length === 0) {
      return;
    }

    event.preventDefault();
    const selectedIndex = enabledOptions.findIndex((option) => option.value === value);
    const nextIndex = nextOptionIndex(selectedIndex, enabledOptions.length, direction);

    onChange(enabledOptions[nextIndex].value);
    openListbox();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement | HTMLDivElement>) {
    if (disabled) {
      return;
    }

    if (event.key === "Escape") {
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }

    if (event.currentTarget === buttonRef.current && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      toggleListbox();
      return;
    }

    if (event.key === "ArrowDown") {
      moveSelection(event, "next");
      return;
    }

    if (event.key === "ArrowUp") {
      moveSelection(event, "previous");
      return;
    }

    if (event.key === "Home") {
      moveSelection(event, "first");
      return;
    }

    if (event.key === "End") {
      moveSelection(event, "last");
    }
  }

  const popoverStyle: CSSProperties = popoverPosition
    ? {
        left: popoverPosition.left,
        maxHeight: popoverPosition.maxHeight,
        position: "fixed",
        top: popoverPosition.top,
        width: popoverPosition.width,
        zIndex: "var(--fw-z-dropdown)"
      }
    : {
        left: 0,
        position: "fixed",
        top: 0,
        visibility: "hidden",
        width: 0,
        zIndex: "var(--fw-z-dropdown)"
      };

  const popover = open ? (
    <div
      aria-label={ariaLabel}
      className={["workspaceListboxPopover", popoverClassName].filter(Boolean).join(" ")}
      id={`${id}-listbox`}
      onKeyDown={handleKeyDown}
      ref={popoverRef}
      role="listbox"
      style={popoverStyle}
      tabIndex={-1}
    >
      {isSearchable && (
        <div className="workspaceListboxSearch">
          <input
            aria-label={searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            ref={searchInputRef}
            value={query}
          />
        </div>
      )}
      {visibleOptions.length > 0 ? (
        visibleOptions.map((option) => (
          <button
            aria-selected={option.value === value}
            className={option.value === value ? "workspaceListboxOption selected" : "workspaceListboxOption"}
            disabled={option.disabled}
            key={option.value}
            onClick={() => selectOption(option)}
            role="option"
            type="button"
          >
            <span className="workspaceListboxCheck">{option.value === value ? <Check size={15} /> : null}</span>
            <span className="workspaceListboxOptionText">
              <strong>{option.label}</strong>
              {option.description && <small>{option.description}</small>}
            </span>
            {option.meta !== undefined && option.meta !== null && (
              <span className="workspaceListboxMeta">{option.meta}</span>
            )}
          </button>
        ))
      ) : (
        <div className="workspaceListboxEmpty">{noResultsLabel}</div>
      )}
    </div>
  ) : null;

  return (
    <div className={["workspaceListbox", `variant-${variant}`, className, open ? "open" : ""].filter(Boolean).join(" ")} ref={rootRef}>
      <button
        autoFocus={autoFocus}
        aria-controls={`${id}-listbox`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={iconBefore ? "workspaceListboxTrigger" : "workspaceListboxTrigger noIcon"}
        disabled={disabled}
        onClick={toggleListbox}
        onKeyDown={handleKeyDown}
        ref={buttonRef}
        type="button"
      >
        {iconBefore && <span className="workspaceListboxTriggerIcon">{iconBefore}</span>}
        <span className="workspaceListboxValue">
          <strong>{selectedOption?.label ?? placeholder}</strong>
          {selectedOption?.description && <small>{selectedOption.description}</small>}
        </span>
        <ChevronDown aria-hidden="true" className="workspaceListboxChevron" size={17} />
      </button>
      {popover && typeof document !== "undefined" ? createPortal(popover, document.body) : popover}
    </div>
  );
}

type WorkspaceListboxPopoverPosition = {
  left: number;
  maxHeight: number;
  top: number;
  width: number;
};

function positionsAreEqual(current: WorkspaceListboxPopoverPosition | undefined, next: WorkspaceListboxPopoverPosition) {
  return Boolean(
    current &&
    Math.abs(current.left - next.left) < 0.5 &&
    Math.abs(current.maxHeight - next.maxHeight) < 0.5 &&
    Math.abs(current.top - next.top) < 0.5 &&
    Math.abs(current.width - next.width) < 0.5
  );
}

function nextOptionIndex(
  selectedIndex: number,
  optionCount: number,
  direction: "first" | "last" | "next" | "previous"
) {
  if (direction === "first") {
    return 0;
  }

  if (direction === "last") {
    return optionCount - 1;
  }

  if (direction === "next") {
    return selectedIndex >= 0 ? Math.min(selectedIndex + 1, optionCount - 1) : 0;
  }

  return selectedIndex >= 0 ? Math.max(selectedIndex - 1, 0) : optionCount - 1;
}

function optionMatchesQuery(option: WorkspaceListboxOption, query: string) {
  return [
    option.searchText,
    option.value,
    textFromReactNode(option.label),
    textFromReactNode(option.description),
    textFromReactNode(option.meta)
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function textFromReactNode(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  return "";
}
