import { RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { Component, Fragment, Suspense, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { useI18n } from "../../../../src/portal/i18n";
import { PortalBrandMark } from "./PortalBrandMark";

export type PortalSkeletonVariant =
  | "admin"
  | "capability"
  | "discussions"
  | "handbook"
  | "home"
  | "knowledge"
  | "apps"
  | "market"
  | "playground"
  | "post"
  | "qa"
  | "token";

export function PortalRouteSuspense({
  children,
  fallback,
  variant = "home"
}: {
  children: ReactNode;
  fallback?: ReactNode;
  variant?: PortalSkeletonVariant;
}) {
  if (fallback) {
    return <Suspense fallback={fallback}>{children}</Suspense>;
  }
  return <Suspense fallback={<PortalRouteLoading variant={variant} />}>{children}</Suspense>;
}

export function PortalRouteLoading({ variant = "home" }: { variant?: PortalSkeletonVariant } = {}) {
  const { t } = useI18n();

  return (
    <section
      aria-busy="true"
      aria-live="polite"
      className={`portal-route-loading-state portal-skeleton-page is-${variant}`}
      role="status"
    >
      <span className="visuallyHidden">{t("portal.data.loadingTitle")}</span>
      <PortalSkeletonContent variant={variant} />
    </section>
  );
}

export function PortalRowsSkeleton({
  className = "",
  count = 5
}: {
  className?: string;
  count?: number;
}) {
  const { t } = useI18n();

  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={`portal-inline-skeleton${className ? ` ${className}` : ""}`}
      role="status"
    >
      <span className="visuallyHidden">{t("portal.data.loadingTitle")}</span>
      <SkeletonRows count={count} />
    </div>
  );
}

export function PortalBootSkeleton({
  adminMode = false,
  standalone = false,
  variant = "home"
}: {
  adminMode?: boolean;
  standalone?: boolean;
  variant?: PortalSkeletonVariant;
}) {
  const { t } = useI18n();

  if (standalone) {
    return (
      <main aria-busy="true" aria-live="polite" className="portal-boot-skeleton is-standalone" role="status">
        <span className="visuallyHidden">{t("portal.data.loadingTitle")}</span>
        <div aria-hidden="true" className="portal-boot-skeleton-standalone-bar">
          <span className="portal-boot-skeleton-brand"><PortalBrandMark /> <strong>{t("portal.brand.name")}</strong></span>
          <span className="portal-skeleton-block portal-skeleton-pill" />
        </div>
        <div aria-hidden="true" className="portal-boot-skeleton-workspace">
          <PortalSkeletonContent variant="qa" />
        </div>
      </main>
    );
  }

  return (
    <main
      aria-busy="true"
      aria-live="polite"
      className={`portal-boot-skeleton${adminMode ? " is-admin" : ""}`}
      role="status"
    >
      <span className="visuallyHidden">{t("portal.data.loadingTitle")}</span>
      <header aria-hidden="true" className="portal-boot-skeleton-mobile-bar">
        <span className="portal-skeleton-block portal-skeleton-square" />
        <span className="portal-boot-skeleton-brand"><PortalBrandMark /> <strong>{t("portal.brand.name")}</strong></span>
        <span className="portal-skeleton-block portal-skeleton-pill" />
      </header>
      <aside aria-hidden="true" className="portal-boot-skeleton-rail">
        <div className="portal-boot-skeleton-brand">
          <PortalBrandMark />
          <span>
            <strong>{t("portal.brand.name")}</strong>
            <span className="portal-skeleton-block portal-skeleton-brand-subtitle" />
          </span>
        </div>
        <span className="portal-skeleton-block portal-skeleton-rail-action" />
        <div className="portal-boot-skeleton-nav">
          <span className="portal-skeleton-block portal-skeleton-label" />
          {Array.from({ length: 3 }, (_, index) => (
            <span className="portal-skeleton-nav-row" key={`primary-${index}`}>
              <span className="portal-skeleton-block portal-skeleton-nav-icon" />
              <span className="portal-skeleton-block portal-skeleton-nav-copy" />
            </span>
          ))}
          <span className="portal-skeleton-block portal-skeleton-label" />
          {Array.from({ length: adminMode ? 3 : 4 }, (_, index) => (
            <span className="portal-skeleton-nav-row" key={`secondary-${index}`}>
              <span className="portal-skeleton-block portal-skeleton-nav-icon" />
              <span className="portal-skeleton-block portal-skeleton-nav-copy" />
            </span>
          ))}
        </div>
        <div className="portal-skeleton-account-row">
          <span className="portal-skeleton-block portal-skeleton-avatar" />
          <span className="portal-skeleton-account-copy">
            <span className="portal-skeleton-block" />
            <span className="portal-skeleton-block" />
          </span>
        </div>
      </aside>
      <div aria-hidden="true" className="portal-boot-skeleton-workspace">
        <PortalSkeletonContent variant={variant} />
      </div>
    </main>
  );
}

function PortalSkeletonContent({ variant }: { variant: PortalSkeletonVariant }) {
  const content = (() => {
    switch (variant) {
      case "home": return <PortalHomeSkeleton />;
      case "discussions": return <PortalDiscussionsSkeleton />;
      case "market": return <PortalMarketSkeleton />;
      case "capability": return <PortalCapabilitySkeleton />;
      case "post": return <PortalPostSkeleton />;
      case "token": return <PortalTokenSkeleton />;
      case "apps": return <PortalAppsSkeleton />;
      case "knowledge": return <PortalKnowledgeSkeleton />;
      case "handbook": return <PortalHandbookSkeleton />;
      case "playground": return <PortalPlaygroundSkeleton />;
      case "qa": return <PortalQaSkeleton />;
      case "admin": return <PortalAdminSkeleton />;
    }
  })();

  return (
    <div className={`portal-skeleton-content is-${variant}`}>
      {content}
    </div>
  );
}

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <span className={`portal-skeleton-block${className ? ` ${className}` : ""}`} />;
}

function SkeletonHeading({ editorial = false }: { editorial?: boolean }) {
  return (
    <header className={`portal-skeleton-heading${editorial ? " is-editorial" : ""}`}>
      <SkeletonBlock className="portal-skeleton-kicker" />
      <SkeletonBlock className="portal-skeleton-title" />
      <SkeletonBlock className="portal-skeleton-subtitle" />
      {editorial && <SkeletonBlock className="portal-skeleton-quote" />}
      <SkeletonBlock className="portal-skeleton-heading-action" />
    </header>
  );
}

function SkeletonToolbar({ controls = 3 }: { controls?: number }) {
  return (
    <div className="portal-skeleton-toolbar">
      <SkeletonBlock className="portal-skeleton-control is-wide" />
      {Array.from({ length: controls - 1 }, (_, index) => (
        <SkeletonBlock className="portal-skeleton-control" key={index} />
      ))}
    </div>
  );
}

function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div className="portal-skeleton-list">
      {Array.from({ length: count }, (_, index) => (
        <div className="portal-skeleton-list-row" key={index}>
          <SkeletonBlock className="portal-skeleton-list-icon" />
          <span className="portal-skeleton-list-copy">
            <SkeletonBlock />
            <SkeletonBlock />
          </span>
          <SkeletonBlock className="portal-skeleton-list-meta" />
        </div>
      ))}
    </div>
  );
}

function PortalHomeSkeleton() {
  return (
    <>
      <div className="portal-skeleton-home-hero">
        <section className="portal-skeleton-home-metric">
          <SkeletonBlock className="portal-skeleton-kicker" />
          <SkeletonBlock className="portal-skeleton-home-number" />
          <SkeletonBlock className="portal-skeleton-card-copy is-short" />
          <div className="portal-skeleton-home-achievement">
            <SkeletonBlock className="portal-skeleton-avatar" />
            <span><SkeletonBlock /><SkeletonBlock /></span>
            <SkeletonBlock className="portal-skeleton-card-action" />
          </div>
        </section>
        <aside className="portal-skeleton-home-pass">
          <SkeletonBlock className="portal-skeleton-kicker" />
          <SkeletonBlock className="portal-skeleton-card-title" />
          <SkeletonBlock className="portal-skeleton-card-copy" />
          <SkeletonBlock className="portal-skeleton-card-copy is-short" />
          <SkeletonBlock className="portal-skeleton-card-action" />
        </aside>
      </div>
      <div className="portal-skeleton-home-shortcuts">
        {Array.from({ length: 3 }, (_, index) => (
          <article key={index}><SkeletonBlock className="portal-skeleton-list-icon" /><SkeletonBlock /><SkeletonBlock /></article>
        ))}
      </div>
    </>
  );
}

function PortalDiscussionsSkeleton() {
  return (
    <>
      <SkeletonHeading />
      <SkeletonToolbar controls={4} />
      <SkeletonRows count={5} />
    </>
  );
}

function PortalMarketSkeleton() {
  return (
    <>
      <SkeletonHeading editorial />
      <SkeletonToolbar controls={4} />
      <SkeletonBlock className="portal-skeleton-result-line" />
      <div className="portal-skeleton-market-grid">
        {Array.from({ length: 3 }, (_, index) => (
          <article className="portal-skeleton-market-card" key={index}>
            <SkeletonBlock className="portal-skeleton-card-media" />
            <SkeletonBlock className="portal-skeleton-card-title" />
            <SkeletonBlock className="portal-skeleton-card-copy" />
            <SkeletonBlock className="portal-skeleton-card-copy is-short" />
          </article>
        ))}
      </div>
    </>
  );
}

function PortalCapabilitySkeleton() {
  return (
    <>
      <div className="portal-skeleton-compact-toolbar"><SkeletonBlock /><SkeletonBlock /></div>
      <div className="portal-skeleton-object-mast">
        <section>
          <SkeletonBlock className="portal-skeleton-list-icon" />
          <div><SkeletonBlock className="portal-skeleton-kicker" /><SkeletonBlock className="portal-skeleton-title" /><SkeletonBlock className="portal-skeleton-card-copy" /><SkeletonBlock className="portal-skeleton-card-copy is-short" /></div>
        </section>
        <aside><SkeletonBlock className="portal-skeleton-kicker" /><SkeletonBlock className="portal-skeleton-card-title" /><SkeletonBlock className="portal-skeleton-control" /><SkeletonBlock className="portal-skeleton-control" /></aside>
      </div>
      <article className="portal-skeleton-publication">
        <SkeletonBlock className="portal-skeleton-kicker" /><SkeletonBlock className="portal-skeleton-card-title" />
        {Array.from({ length: 5 }, (_, index) => <SkeletonBlock className={index === 4 ? "is-short" : ""} key={index} />)}
      </article>
    </>
  );
}

function PortalPostSkeleton() {
  return (
    <>
      <div className="portal-skeleton-compact-toolbar"><SkeletonBlock /><SkeletonBlock /></div>
      <article className="portal-skeleton-post-paper">
        <SkeletonBlock className="portal-skeleton-kicker" />
        <SkeletonBlock className="portal-skeleton-title" />
        <div className="portal-skeleton-post-author"><SkeletonBlock className="portal-skeleton-avatar" /><span><SkeletonBlock /><SkeletonBlock /></span></div>
        {Array.from({ length: 7 }, (_, index) => <SkeletonBlock className={index === 6 ? "is-short" : ""} key={index} />)}
      </article>
      <div className="portal-skeleton-post-context">{Array.from({ length: 3 }, (_, index) => <SkeletonBlock key={index} />)}</div>
    </>
  );
}

function PortalTokenSkeleton() {
  return (
    <>
      <SkeletonHeading editorial />
      <div className="portal-skeleton-token-health"><SkeletonBlock className="portal-skeleton-list-icon" /><span><SkeletonBlock /><SkeletonBlock /></span><SkeletonBlock /></div>
      <div className="portal-skeleton-metrics">{Array.from({ length: 4 }, (_, index) => <div key={index}><SkeletonBlock /><SkeletonBlock /></div>)}</div>
      <SkeletonRows count={3} />
    </>
  );
}

function PortalAppsSkeleton() {
  return (
    <>
      <SkeletonHeading editorial />
      <section className="portal-skeleton-apps-surface">
        <SkeletonToolbar controls={3} />
        <div className="portal-skeleton-apps-summary">{Array.from({ length: 3 }, (_, index) => <SkeletonBlock key={index} />)}</div>
        <SkeletonRows count={4} />
      </section>
    </>
  );
}

function PortalKnowledgeSkeleton() {
  return (
    <>
      <SkeletonHeading editorial />
      <section className="portal-skeleton-knowledge-surface">
        <SkeletonToolbar controls={3} />
        <SkeletonRows count={5} />
      </section>
    </>
  );
}

function PortalHandbookSkeleton() {
  return (
    <>
      <section className="portal-skeleton-handbook-hero">
        <div><SkeletonBlock className="portal-skeleton-kicker" /><SkeletonBlock className="portal-skeleton-title" /><SkeletonBlock /><SkeletonBlock className="is-short" /><SkeletonBlock className="portal-skeleton-control" /></div>
        <aside>{Array.from({ length: 4 }, (_, index) => <div key={index}><SkeletonBlock /><SkeletonBlock /></div>)}</aside>
      </section>
      <section className="portal-skeleton-handbook-section"><SkeletonBlock className="portal-skeleton-card-title" /><SkeletonBlock /><SkeletonBlock /><SkeletonBlock className="is-short" /></section>
    </>
  );
}

function PortalAdminSkeleton() {
  return (
    <>
      <SkeletonHeading />
      <div className="portal-skeleton-metrics">{Array.from({ length: 4 }, (_, index) => <div key={index}><SkeletonBlock /><SkeletonBlock /></div>)}</div>
      <section className="portal-skeleton-admin-panel"><SkeletonBlock className="portal-skeleton-card-title" /><SkeletonToolbar controls={3} /><SkeletonRows count={4} /></section>
    </>
  );
}

function PortalPlaygroundSkeleton() {
  return (
    <>
      <SkeletonHeading />
      <div className="portal-skeleton-playground-layout">
        <aside><SkeletonBlock className="portal-skeleton-card-title" /><SkeletonBlock className="portal-skeleton-control" /><SkeletonRows count={5} /></aside>
        <main><SkeletonBlock className="portal-skeleton-card-title" /><SkeletonBlock className="portal-skeleton-playground-input" /><SkeletonBlock className="portal-skeleton-playground-input is-tall" /></main>
        <aside><SkeletonBlock className="portal-skeleton-card-title" />{Array.from({ length: 5 }, (_, index) => <SkeletonBlock className="portal-skeleton-control" key={index} />)}</aside>
      </div>
    </>
  );
}

function PortalQaSkeleton() {
  return (
    <>
      <SkeletonHeading />
      <div className="portal-skeleton-qa-layout">
        <aside>{Array.from({ length: 2 }, (_, index) => <section key={index}><SkeletonBlock className="portal-skeleton-list-icon" /><SkeletonBlock className="portal-skeleton-card-title" /><SkeletonBlock /><SkeletonBlock className="is-short" /></section>)}</aside>
        <main><SkeletonBlock className="portal-skeleton-qa-chat-header" /><div><SkeletonBlock className="portal-skeleton-list-icon" /><SkeletonBlock className="portal-skeleton-card-title" /><SkeletonBlock /><SkeletonBlock className="is-short" /></div><SkeletonBlock className="portal-skeleton-qa-composer" /></main>
      </div>
    </>
  );
}

type PortalAppErrorBoundaryProps = {
  children: ReactNode;
};

type PortalAppErrorBoundaryState = {
  failed: boolean;
  resetKey: number;
};

export class PortalAppErrorBoundary extends Component<PortalAppErrorBoundaryProps, PortalAppErrorBoundaryState> {
  state: PortalAppErrorBoundaryState = { failed: false, resetKey: 0 };

  static getDerivedStateFromError(): Partial<PortalAppErrorBoundaryState> {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("portal_render_failed", error, info.componentStack);
  }

  private retry = () => {
    this.setState((current) => ({ failed: false, resetKey: current.resetKey + 1 }));
  };

  private reload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.failed) {
      return <PortalAppErrorState onReload={this.reload} onRetry={this.retry} />;
    }

    return <Fragment key={this.state.resetKey}>{this.props.children}</Fragment>;
  }
}

function PortalAppErrorState({ onReload, onRetry }: { onReload: () => void; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <main aria-live="assertive" className="portal-auth-gate portal-status-gate portal-recovery-state" role="alert">
      <div className="portal-auth-brand"><PortalBrandMark /> <strong>{t("portal.brand.name")}</strong></div>
      <span aria-hidden="true" className="portal-status-gate-icon"><TriangleAlert size={20} /></span>
      <h1>{t("portal.data.errorTitle")}</h1>
      <p>{t("portal.data.catalogErrorDescription")}</p>
      <div className="portal-recovery-actions">
        <Button iconBefore={<RotateCcw size={16} />} onClick={onRetry} variant="primary">
          {t("portal.data.retry")}
        </Button>
        <Button iconBefore={<RefreshCw size={16} />} onClick={onReload}>
          {t("common.refresh")}
        </Button>
      </div>
    </main>
  );
}
