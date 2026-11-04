import { OwnerClaim } from "./components/OwnerClaim";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlatformBrandProvider } from "../../../src/portal/brand/PlatformBrandProvider";
import { I18nProvider } from "../../../src/portal/i18n";
import { PortalApp } from "./PortalApp";
import { PortalAppErrorBoundary } from "./components/PortalRecovery";
import { preloadInitialPortalData } from "./data/portalDataLoader";
import { parsePortalRoute } from "./routing/portalRoutes";
import { portalRouteReadModels } from "./routing/portalReadModels";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/auth.css";
import "./styles/shell.css";
import "./styles/home.css";
import "../../../src/portal/design-system/styles";


const LocalLoginPreview = import.meta.env.DEV ? lazy(() => import("./brand/LoginPreview").then(module => ({ default: module.LoginPreview }))) : () => null;
const isLocalLoginPreview = import.meta.env.DEV && window.location.pathname === "/__local/workspace-login";

const LocalBrandStudio = import.meta.env.DEV ? lazy(() => import("./brand/BrandStudio").then(module => ({ default: module.BrandStudio }))) : () => null;
const isLocalBrandStudio = import.meta.env.DEV && window.location.pathname === "/__local/brand-studio";

const LocalOnboardingDemo = lazy(async () => {
  const module = await import("./components/PassLearningModal");
  return { default: module.PassLearningModal };
});

const LocalKnowledgeTour = lazy(async () => {
  const module = await import("./components/KnowledgeTour");
  return { default: module.KnowledgeTour };
});

const isLocalOnboardingPreview =
  import.meta.env.DEV &&
  (window.location.pathname === "/__local/portal-home-onboarding" ||
    window.location.hash === "#/__local/portal-home-onboarding");

const isLocalKnowledgeTourPreview =
  import.meta.env.DEV &&
  (window.location.pathname === "/__local/knowledge-tour" ||
    window.location.hash === "#/__local/knowledge-tour");

const isOwnerClaim = window.location.pathname === "/setup/claim";

if (!isOwnerClaim && !isLocalLoginPreview && !isLocalBrandStudio && !isLocalOnboardingPreview && !isLocalKnowledgeTourPreview) {
  const initialRoute = parsePortalRoute(`${window.location.pathname}${window.location.search}`);
  const authOnly = initialRoute.page === "mate-preview" || initialRoute.page === "mate-embed";
  preloadInitialPortalData(authOnly, []);
}

function LocalOnboardingPreview() {
  return (
    <I18nProvider>
      <main
        className="portal-home portal-local-onboarding-preview"
        style={{
          alignContent: "start",
          background: "var(--portal-paper-soft)",
          boxSizing: "border-box",
          display: "grid",
          gap: "12px",
          minHeight: "100vh",
          padding: "20px",
          width: "100%"
        }}
      >
        <div
          style={{
            alignItems: "center",
            color: "var(--portal-muted)",
            display: "flex",
            fontSize: "11px",
            fontWeight: 800,
            justifyContent: "space-between",
            letterSpacing: "0.04em"
          }}
        >
          <span>PortalHomeOnboardingDemo · 本地预览</span>
          <a href="/#/home" style={{ color: "inherit" }}>
            返回首页
          </a>
        </div>
        <Suspense
          fallback={
            <div style={{ color: "var(--portal-muted)", padding: "40px", textAlign: "center" }}>
              正在加载组件…
            </div>
          }
        >
          <LocalOnboardingDemo onClose={() => window.location.assign("/#/home")} onConnect={() => window.location.assign("/#/mcp-handbook")} />
        </Suspense>
      </main>
    </I18nProvider>
  );
}

function LocalKnowledgeTourPreview() {
  return (
    <I18nProvider>
      <main style={{ background: "var(--portal-paper-soft)", minHeight: "100vh" }}>
        <Suspense fallback={null}>
          <LocalKnowledgeTour onClose={() => window.location.assign("/__local/portal-home-onboarding")} />
        </Suspense>
      </main>
    </I18nProvider>
  );
}

const portalRoot = (import.meta.hot?.data.portalRoot as Root | undefined)
  ?? createRoot(document.getElementById("root") as HTMLElement);
if (import.meta.hot) import.meta.hot.data.portalRoot = portalRoot;
portalRoot.render(
  <StrictMode>
    <PlatformBrandProvider>
    {isOwnerClaim ? (<I18nProvider><OwnerClaim /></I18nProvider>) : isLocalLoginPreview ? (
      <I18nProvider><Suspense fallback={null}><LocalLoginPreview /></Suspense></I18nProvider>
    ) : isLocalBrandStudio ? (
      <I18nProvider><Suspense fallback={null}><LocalBrandStudio /></Suspense></I18nProvider>
    ) : isLocalKnowledgeTourPreview ? (
      <LocalKnowledgeTourPreview />
    ) : isLocalOnboardingPreview ? (
      <LocalOnboardingPreview />
    ) : (
      <I18nProvider>
        <PortalAppErrorBoundary>
          <PortalApp />
        </PortalAppErrorBoundary>
      </I18nProvider>
    )}
      </PlatformBrandProvider>
  </StrictMode>
);
