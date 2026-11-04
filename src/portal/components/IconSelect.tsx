import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type IconSelectOption = {
  value: string;
  label: string;
  description?: string;
  meta?: string;
  iconSrc?: string;
  icon?: ReactNode;
  disabled?: boolean;
};

export type IconSelectGroup = {
  label: string;
  options: IconSelectOption[];
};

export function IconSelect({
  className = "",
  disabled = false,
  groups,
  hideLabel = false,
  label,
  onChange,
  placeholder = "Select",
  showGroupLabels = true,
  showIcons = true,
  showOptionDescriptions = true,
  showValueDescription = true,
  value
}: {
  className?: string;
  disabled?: boolean;
  groups: IconSelectGroup[];
  hideLabel?: boolean;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  showGroupLabels?: boolean;
  showIcons?: boolean;
  showOptionDescriptions?: boolean;
  showValueDescription?: boolean;
  value: string;
}) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<IconSelectPopoverPosition>();
  const options = useMemo(() => groups.flatMap((group) => group.options), [groups]);
  const enabledOptions = useMemo(() => options.filter((option) => !option.disabled), [options]);
  const selectedOption = options.find((option) => option.value === value);
  const primaryClassName = className.split(/\s+/).filter(Boolean)[0];
  const popoverClassName = primaryClassName ? `${primaryClassName}Popover` : "";

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

  useEffect(() => {
    if (!open) {
      return;
    }

    updatePopoverPosition();

    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);

    return () => {
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [open]);

  function updatePopoverPosition() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const padding = 12;
    const gap = 6;
    const width = Math.min(rect.width, window.innerWidth - padding * 2);
    const left = Math.max(padding, Math.min(rect.left, window.innerWidth - width - padding));
    const belowTop = rect.bottom + gap;
    const availableBelow = window.innerHeight - belowTop - padding;
    const availableAbove = rect.top - padding - gap;
    const openAbove = availableBelow < 180 && availableAbove > availableBelow;
    const maxHeight = Math.max(96, Math.min(360, openAbove ? availableAbove : availableBelow));
    const top = openAbove ? Math.max(padding, rect.top - maxHeight - gap) : belowTop;

    setPopoverPosition({ left, maxHeight, top, width });
  }

  function selectOption(option: IconSelectOption) {
    if (option.disabled) {
      return;
    }

    onChange(option.value);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) {
      return;
    }

    if (event.key === "Escape") {
      setOpen(false);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen((current) => !current);
      return;
    }

    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || enabledOptions.length === 0) {
      return;
    }

    event.preventDefault();
    const currentIndex = Math.max(0, enabledOptions.findIndex((option) => option.value === value));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? enabledOptions.length - 1
        : event.key === "ArrowDown"
          ? Math.min(currentIndex + 1, enabledOptions.length - 1)
          : Math.max(currentIndex - 1, 0);

    onChange(enabledOptions[nextIndex].value);
    setOpen(true);
  }

  const popoverStyle: CSSProperties | undefined = popoverPosition
    ? {
        left: popoverPosition.left,
        maxHeight: popoverPosition.maxHeight,
        position: "fixed",
        right: "auto",
        top: popoverPosition.top,
        width: popoverPosition.width,
        zIndex: "var(--fw-z-dropdown)"
      }
    : undefined;

  const popover = open ? (
    <div
      aria-label={label}
      className={["iconSelectPopover", popoverClassName].filter(Boolean).join(" ")}
      id={`${id}-listbox`}
      ref={popoverRef}
      role="listbox"
      style={popoverStyle}
    >
      {groups.map((group) => (
        <div className="iconSelectGroup" key={group.label}>
          {showGroupLabels && <div className="iconSelectGroupLabel">{group.label}</div>}
          {group.options.map((option) => (
            <button
              aria-selected={option.value === value}
              className={`iconSelectOption${showIcons ? "" : " noIcon"}${option.value === value ? " selected" : ""}`}
              disabled={option.disabled}
              key={option.value}
              onClick={() => selectOption(option)}
              role="option"
              type="button"
            >
              {showIcons && <OptionIcon option={option} />}
              <span className="iconSelectOptionText">
                <strong>{option.label}</strong>
                {showOptionDescriptions && option.description && <small>{option.description}</small>}
              </span>
              {option.meta && <span className="iconSelectMeta">{option.meta}</span>}
              {option.value === value && <Check aria-hidden="true" className="iconSelectCheck" size={15} />}
            </button>
          ))}
        </div>
      ))}
    </div>
  ) : null;

  return (
    <div className={`iconSelect ${className}${open ? " open" : ""}`.trim()} ref={rootRef}>
      <span className={`iconSelectLabel${hideLabel ? " visuallyHidden" : ""}`}>{label}</span>
      <button
        aria-controls={`${id}-listbox`}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`iconSelectTrigger${showIcons ? "" : " noIcon"}`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
        ref={buttonRef}
        type="button"
      >
        {showIcons && <OptionIcon option={selectedOption} />}
        <span className="iconSelectValue">
          <strong>{selectedOption?.label ?? placeholder}</strong>
          {showValueDescription && selectedOption?.description && <small>{selectedOption.description}</small>}
        </span>
        <ChevronDown aria-hidden="true" size={16} />
      </button>

      {popover && typeof document !== "undefined" ? createPortal(popover, document.body) : popover}
    </div>
  );
}

type IconSelectPopoverPosition = {
  left: number;
  maxHeight: number;
  top: number;
  width: number;
};

function OptionIcon({ option }: { option?: IconSelectOption }) {
  if (!option) {
    return <span className="iconSelectIcon empty" aria-hidden="true" />;
  }

  if (option.icon) {
    return <span className="iconSelectIcon">{option.icon}</span>;
  }

  if (option.iconSrc) {
    return (
      <span className="iconSelectIcon">
        <img alt="" src={option.iconSrc} />
      </span>
    );
  }

  return <span className="iconSelectIcon fallback">{initials(option.label)}</span>;
}

function initials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "AI";
}
