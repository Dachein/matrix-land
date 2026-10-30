import type { ReactNode } from "react";
import {
  WorkspaceListbox,
  type WorkspaceListboxOption
} from "../../../../../src/portal/components/WorkspaceListbox";

export function PortalTokenListboxField<TValue extends string>({
  ariaLabel,
  autoFocus = false,
  description,
  disabled = false,
  label,
  noResultsLabel,
  onChange,
  options,
  placeholder,
  required = false,
  searchable = false,
  searchPlaceholder,
  value
}: {
  ariaLabel: string;
  autoFocus?: boolean;
  description?: ReactNode;
  disabled?: boolean;
  label: ReactNode;
  noResultsLabel?: ReactNode;
  onChange: (value: TValue) => void;
  options: Array<WorkspaceListboxOption<TValue>>;
  placeholder?: ReactNode;
  required?: boolean;
  searchable?: boolean | "auto";
  searchPlaceholder?: string;
  value: TValue;
}) {
  return (
    <div className="formField">
      <span className="formFieldLabel">
        {label}
        {required && <span className="formFieldRequired" aria-hidden="true">*</span>}
      </span>
      <WorkspaceListbox<TValue>
        ariaLabel={ariaLabel}
        autoFocus={autoFocus}
        disabled={disabled}
        noResultsLabel={noResultsLabel}
        onChange={onChange}
        options={options}
        placeholder={placeholder}
        searchable={searchable}
        searchPlaceholder={searchPlaceholder}
        value={value}
      />
      {description && <small className="formFieldDescription">{description}</small>}
    </div>
  );
}
