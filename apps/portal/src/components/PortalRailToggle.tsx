import type { ReactNode } from "react";

/** Shared avatar control for community and Mate right rails. */
export function PortalRailToggle({ label, expanded, onToggle, className = "", children }: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  className?: string;
  children: ReactNode;
}) {
  return <button aria-label={label} aria-expanded={expanded} title={label} className={`portal-live-ping-avatar ${className}`} onClick={onToggle} type="button">{children}</button>;
}
