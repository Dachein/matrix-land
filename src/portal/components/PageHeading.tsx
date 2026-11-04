import type { ReactNode } from "react";

/** Content and actions share one hierarchy across workspace and administration. */
export function PageHeading({ id, title, subtitle, eyebrow, children, actions, className = "", copyClassName = "" }: {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  copyClassName?: string;
}) {
  return <header data-ui="page-heading" className={`portal-page-heading ${className}`}>
    <div data-ui="page-heading-copy" className={`portal-page-heading-copy ${copyClassName}`}>
      {eyebrow && <div data-ui="page-eyebrow">{eyebrow}</div>}
      <h1 id={id}>{title}</h1>
      {subtitle && <p data-ui="page-subtitle">{subtitle}</p>}
      {children}
    </div>
    {actions}
  </header>;
}
