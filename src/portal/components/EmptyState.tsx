import type { ReactNode } from "react";

export function EmptyState({ title, description, icon, actions, className = "" }: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return <section data-ui="empty-state" className={className} aria-live="polite">
    {icon && <span aria-hidden="true">{icon}</span>}
    <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
    {actions}
  </section>;
}
