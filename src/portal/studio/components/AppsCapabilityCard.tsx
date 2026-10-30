import type { ReactNode } from "react";

export type AppsCapabilityStatusTone = "enabled" | "neutral" | "warning";

export function AppsCapabilityCard({
  action,
  children,
  className = "",
  description,
  icon,
  statusLabel,
  statusTone = "neutral",
  title
}: {
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  description: ReactNode;
  icon: ReactNode;
  statusLabel: ReactNode;
  statusTone?: AppsCapabilityStatusTone;
  title: ReactNode;
}) {
  return (
    <section className={["assetDetailSection", "appsCapabilityCard", `is-${statusTone}`, className].filter(Boolean).join(" ")}>
      <header className="appsCapabilityHeader">
        <div className="appsCapabilityIdentity">
          <span aria-hidden="true" className="appsCapabilityMark">{icon}</span>
          <div className="appsCapabilityCopy">
            <div className="appsCapabilityTitleRow">
              <h3>{title}</h3>
              <span className={`capabilityStatusText ${statusTone}`}>{statusLabel}</span>
            </div>
            <p>{description}</p>
          </div>
        </div>
        {action ? <div className="appsCapabilityControls">{action}</div> : null}
      </header>
      {children ? <div className="appsCapabilityBody">{children}</div> : null}
    </section>
  );
}
