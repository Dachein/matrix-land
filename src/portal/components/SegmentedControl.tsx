import type { ReactNode } from "react";

export type SegmentedControlOption<TValue extends string> = {
  ariaLabel?: string;
  count?: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
  label?: ReactNode;
  title?: string;
  value: TValue;
};

export function SegmentedControl<TValue extends string>({
  ariaLabel,
  appearance = "underline",
  className,
  compact = false,
  onChange,
  options,
  value
}: {
  ariaLabel: string;
  appearance?: "underline" | "quiet" | "tiles";
  className?: string;
  compact?: boolean;
  onChange: (value: TValue) => void;
  options: Array<SegmentedControlOption<TValue>>;
  value: TValue;
}) {
  return (
    <div data-ui="segmented-control" data-appearance={appearance} role="group" aria-label={ariaLabel} className={joinClassNames("segmentedControl", compact ? "compact" : "", className)}>
      {options.map((option) => {
        const isActive = option.value === value;

        return (
          <button
            aria-label={option.ariaLabel}
            aria-pressed={isActive}
            className={isActive ? "active" : ""}
            disabled={option.disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            title={option.title}
            type="button"
          >
            {option.icon}
            {option.label}
            {option.count !== undefined && <span>{option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

function joinClassNames(...values: Array<string | undefined>) {
  return values
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(" ");
}
