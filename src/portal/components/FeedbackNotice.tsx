import { CircleAlert, CircleCheck, Info, Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import "./feedback.css";

export type FeedbackTone = "info" | "success" | "warning" | "error" | "loading" | "permission";
const icons = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert, loading: Loader2, permission: ShieldAlert };

/** Persistent, inline feedback. The caller owns recovery actions and dismissal. */
export function FeedbackNotice({ tone = "info", title, children, actions, className = "", announce = true }: {
  tone?: FeedbackTone;
  title?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Static guidance must not repeatedly interrupt assistive technology. */
  announce?: boolean;
}) {
  const Icon = icons[tone];
  return <div data-ui="feedback" data-tone={tone} className={`feedbackNotice ${className}`}
    role={announce ? tone === "error" ? "alert" : "status" : undefined} aria-atomic={announce || undefined}>
    <Icon aria-hidden="true" className={tone === "loading" ? "feedbackIcon spinIcon" : "feedbackIcon"} strokeWidth={1.5} />
    <div className="feedbackContent">{title && <strong className="feedbackTitle">{title}</strong>}<div className="feedbackMessage">{children}</div></div>
    {actions && <div className="feedbackActions">{actions}</div>}
  </div>;
}
