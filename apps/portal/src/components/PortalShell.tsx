import { useWorkspaceModules } from "../../../../src/portal/brand/PlatformBrandProvider";
import { portalPageModule } from "../../../../src/shared/workspaceModules";
import {
  ArrowLeft,
  Bell,
  Bot,
  Blocks,
  BookOpen,
  Box,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  DatabaseBackup,
  Gauge,
  House,
  KeyRound,
  Menu,
  MessageSquareText,
  Plus,
  Radio,
  ShieldCheck,
  UsersRound,
  X
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { LanguageSwitcher } from "../../../../src/portal/components/LanguageSwitcher";
import {
  type McpConnectionStatus,
  type McpConnectionStatusMode
} from "../../../../src/portal/components/McpConnectionModal";
import { PersonAvatar } from "../../../../src/portal/components/shared/avatar";
import { useI18n } from "../../../../src/portal/i18n";
import modelContextProtocolIcon from "../../../../src/assets/model-context-protocol.svg";
import { formatPortalJourneyLevelLabel } from "../../../../src/shared/journey";
import type { PortalCatalog } from "../../../../src/shared/types";
import type { LiveDataSource } from "../live/liveDataSource";
import type { PortalNavKey } from "../routing/portalRoutes";
import { PortalBrandMark } from "./PortalBrandMark";
import { PortalLiveRail, type PortalLiveActivityChannel } from "./PortalLiveRail";
import {
  enrichPortalNotification,
  notificationUnreadBadge,
  usePortalNotifications
} from "./PortalNotifications";
import {
  PortalUtilityRailProvider,
  type PortalUtilityRailContextValue,
  type PortalUtilityRailVariant
} from "./PortalUtilityRail";

const BrowserDiagnosticsModal = lazy(() => import("./BrowserDiagnosticsModal").then((module) => ({
  default: module.BrowserDiagnosticsModal
})));
const LIVE_RAIL_COLLAPSE_QUERY = "(max-width: 1260px)";

const mcpLogoStyle = {
  WebkitMaskImage: `url("${modelContextProtocolIcon}")`,
  maskImage: `url("${modelContextProtocolIcon}")`
} as CSSProperties;

type ActiveUtilityPanel = {
  dismissOnScrim: boolean;
  id: string;
  onClose: () => void;
  variant: PortalUtilityRailVariant;
};

export function PortalShell({
  activeNav,
  catalog,
  children,
  currentUserJourneyLevel,
  dataSource,
  loading,
  mcpConnectionStatus,
  mcpStatusMode,
  onNavigate,
  onNavigateIntent,
  onNewPost,
  onOpenMcp,
  onOpenProfile
}: {
  activeNav: PortalNavKey;
  catalog: PortalCatalog;
  children: ReactNode;
  currentUserJourneyLevel?: PortalCatalog["journey"]["level"];
  dataSource: LiveDataSource;
  loading: boolean;
  mcpConnectionStatus: McpConnectionStatus;
  mcpStatusMode: McpConnectionStatusMode;
  onNavigate: (target: PortalNavKey) => void;
  onNavigateIntent?: (target: PortalNavKey) => void;
  onNewPost: () => void;
  onOpenMcp: () => void;
  onOpenProfile: () => void;
}) {
  const { locale, t } = useI18n();
  const modules = useWorkspaceModules();
  const visible = (page: string) => { const module = portalPageModule(page); return !module || modules.includes(module); };
  const adminMode = activeNav === "admin" || activeNav === "admin-users" || activeNav === "admin-knowledge" || activeNav === "admin-mcp-connections" || activeNav === "admin-hub-review" || activeNav === "admin-backups" || activeNav === "admin-login-policy";
  const [menuOpen, setMenuOpen] = useState(false);
  const [liveCollapsed, setLiveCollapsed] = useState(() => (
    activeNav !== "mate" || window.matchMedia(LIVE_RAIL_COLLAPSE_QUERY).matches
  ));
  const [mobilePanelMode, setMobilePanelMode] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [compactRailViewport, setCompactRailViewport] = useState(() => window.matchMedia("(max-width: 1100px)").matches);
  const [railPreference, setRailPreference] = useState<"auto" | "collapsed" | "expanded">("auto");
  const [activeUtilityPanel, setActiveUtilityPanel] = useState<ActiveUtilityPanel>();
  const [utilityPanelHost, setUtilityPanelHost] = useState<HTMLDivElement | null>(null);
  const utilityPanelOpen = Boolean(activeUtilityPanel);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [liveActivityChannel, setLiveActivityChannel] = useState<PortalLiveActivityChannel>("community");
  const logoClickSequence = useRef({ count: 0, lastClickAt: 0 });
  const previousActiveNav = useRef(activeNav);
  const notificationState = usePortalNotifications(
    dataSource,
    !liveCollapsed && !utilityPanelOpen && liveActivityChannel === "notification"
  );
  const notifications = useMemo(() => notificationState.notifications.map((notification) => (
    enrichPortalNotification(notification, catalog)
  )), [catalog, notificationState.notifications]);
  const latestUnreadNotification = notifications.find((notification) => notification.status === "unread");

  const registerUtilityPanel = useCallback((id: string, onClose: () => void, dismissOnScrim: boolean, variant: PortalUtilityRailVariant) => {
    setActiveUtilityPanel((current) => current?.id === id && current.dismissOnScrim === dismissOnScrim && current.variant === variant
      ? current
      : { dismissOnScrim, id, onClose, variant });
  }, []);

  const unregisterUtilityPanel = useCallback((id: string) => {
    setActiveUtilityPanel((current) => current?.id === id ? undefined : current);
  }, []);

  const utilityRailContext = useMemo<PortalUtilityRailContextValue>(() => ({
    host: utilityPanelHost,
    collapsed: liveCollapsed,
    setCollapsed: setLiveCollapsed,
    registerPanel: registerUtilityPanel,
    unregisterPanel: unregisterUtilityPanel
  }), [registerUtilityPanel, unregisterUtilityPanel, utilityPanelHost, liveCollapsed]);

  useEffect(() => {
    const media = window.matchMedia(LIVE_RAIL_COLLAPSE_QUERY);
    const handleChange = (event: MediaQueryListEvent) => setLiveCollapsed(event.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const handleChange = (event: MediaQueryListEvent) => setMobilePanelMode(event.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1100px)");
    const handleChange = (event: MediaQueryListEvent) => setCompactRailViewport(event.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    const leftMate = previousActiveNav.current === "mate" && activeNav !== "mate";
    previousActiveNav.current = activeNav;
    if (activeNav === "mate") {
      setLiveCollapsed(window.matchMedia(LIVE_RAIL_COLLAPSE_QUERY).matches);
    } else if (adminMode || leftMate) {
      setLiveCollapsed(true);
    }
  }, [activeNav, adminMode]);

  function navigate(target: PortalNavKey) {
    setMenuOpen(false);
    onNavigate(target);
  }

  function clickBrand(event: MouseEvent<HTMLButtonElement>, target: PortalNavKey) {
    navigate(target);

    if (!(event.target instanceof Element) || !event.target.closest(".portal-brand-mark")) {
      logoClickSequence.current = { count: 0, lastClickAt: 0 };
      return;
    }

    const clickedAt = window.performance.now();
    const previous = logoClickSequence.current;
    const count = clickedAt - previous.lastClickAt <= 900 ? previous.count + 1 : 1;
    logoClickSequence.current = { count, lastClickAt: clickedAt };

    if (count >= 3) {
      logoClickSequence.current = { count: 0, lastClickAt: 0 };
      setDiagnosticsOpen(true);
    }
  }

  function requestNewPost() {
    setMenuOpen(false);
    onNewPost();
  }

  function toggleLivePanel() {
    if (activeUtilityPanel) {
      return;
    }
    setLiveCollapsed((current) => !current);
  }

  async function handleNotificationAction() {
    if (notificationState.unreadCount === 1 && latestUnreadNotification?.href) {
      await notificationState.openNotification(latestUnreadNotification);
      return;
    }

    activeUtilityPanel?.onClose();
    setLiveCollapsed(false);
    setLiveActivityChannel("notification");
  }

  const unreadBadge = notificationUnreadBadge(notificationState.unreadCount);
  const autoRailCollapsed = utilityPanelOpen || compactRailViewport;

  useEffect(() => {
    setRailPreference("auto");
    if (activeUtilityPanel) setMenuOpen(false);
  }, [activeUtilityPanel?.id, compactRailViewport]);

  const railCollapsed = !mobilePanelMode && (
    activeUtilityPanel?.variant === "inline"
    || railPreference === "collapsed"
    || (railPreference === "auto" && autoRailCollapsed)
  );

  const overlayOpen = menuOpen || !adminMode && (!liveCollapsed || utilityPanelOpen) && mobilePanelMode;
  return (
    <PortalUtilityRailProvider value={utilityRailContext}>
      <div
        aria-busy={loading || undefined}
        className={`portal-shell ${adminMode ? "admin-mode" : ""} ${railCollapsed ? "rail-collapsed" : ""} ${liveCollapsed ? "live-collapsed" : ""} ${utilityPanelOpen ? "utility-panel-open" : ""} ${activeUtilityPanel?.variant === "wide" ? "utility-panel-wide" : ""} ${activeUtilityPanel?.variant === "inline" ? "utility-panel-inline" : ""} ${menuOpen ? "menu-open" : ""}`}
      >
      {loading && <span className="portal-loading-line" aria-hidden="true" />}

      <header className="portal-mobile-header">
        <button
          aria-label={menuOpen ? t("portal.mobile.closeMenu") : t("portal.mobile.openMenu")}
          aria-expanded={menuOpen}
          className="portal-icon-button"
          onClick={() => setMenuOpen((current) => !current)}
          type="button"
        >
          {menuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
        {adminMode ? (
          <>
            <button className="portal-mobile-brand" onClick={(event) => clickBrand(event, "admin")} type="button">
              <PortalBrandMark />
              <span>{t("portal.admin.modeTitle")}</span>
            </button>
            <button className="portal-mobile-admin-exit" onClick={() => navigate("home")} type="button">
              <ArrowLeft size={16} />
              <span>{t("portal.admin.exitShort")}</span>
            </button>
          </>
        ) : (
          <>
            <button className="portal-mobile-brand" onClick={(event) => clickBrand(event, "home")} type="button">
              <PortalBrandMark />
              <span>{t("portal.brand.name")}</span>
            </button>
            <button className="portal-mobile-command" disabled={utilityPanelOpen} onClick={toggleLivePanel} type="button">
              <Radio size={15} />
              <span>{t("portal.live.title")}</span>
            </button>
            <button aria-label={t("portal.notifications.open")} className={`portal-mobile-notifications ${unreadBadge ? "has-unread" : ""}`} onClick={() => void handleNotificationAction()} type="button">
              <Bell size={16} />
              {unreadBadge && <strong>{unreadBadge}</strong>}
            </button>
          </>
        )}
      </header>

      {overlayOpen && (menuOpen || !activeUtilityPanel || activeUtilityPanel.dismissOnScrim ? (
        <button
          aria-label={t("portal.mobile.closePanel")}
          className="portal-mobile-scrim"
          onClick={() => {
            if (menuOpen) {
              setMenuOpen(false);
            } else if (activeUtilityPanel?.dismissOnScrim) {
              activeUtilityPanel.onClose();
            } else {
              setLiveCollapsed(true);
            }
          }}
          type="button"
        />
      ) : <div aria-hidden="true" className="portal-mobile-scrim" />)}

      <aside aria-label={t(adminMode ? "portal.admin.modeAria" : "portal.nav.aria")} className="portal-left-rail" id="portal-primary-navigation">
        <div className="portal-rail-brand-block">
          <button aria-label={t(adminMode ? "portal.admin.modeTitle" : "portal.brand.name")} className="portal-brand" onClick={(event) => clickBrand(event, adminMode ? activeNav : "home")} type="button">
            <PortalBrandMark className="portal-rail-brand-mark" />
            <span>
              <strong>{t(adminMode ? "portal.admin.modeTitle" : "portal.brand.name")}</strong>
              <small>{t(adminMode ? "portal.admin.modeSubtitle" : "portal.brand.workspace")}</small>
            </span>
          </button>
          <button
            aria-controls="portal-primary-navigation"
            aria-expanded={!railCollapsed}
            aria-label={t(railCollapsed ? "portal.rail.expand" : "portal.rail.collapse")}
            className="portal-rail-toggle"
            onClick={() => setRailPreference(railCollapsed ? "expanded" : "collapsed")}
            title={t(railCollapsed ? "portal.rail.expand" : "portal.rail.collapse")}
            type="button"
          >
            {railCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
        </div>

        {adminMode ? (
          <Button aria-label={t("portal.admin.exitMode")} className="portal-admin-exit" iconBefore={<ArrowLeft size={16} />} onClick={() => navigate("home")} title={t("portal.admin.exitMode")} variant="secondary">
            <span className="portal-rail-action-label">{t("portal.admin.exitMode")}</span>
          </Button>
        ) : (
          <Button aria-label={t("portal.actions.newPost")} className="portal-new-post" iconBefore={<Plus size={16} />} onClick={requestNewPost} title={t("portal.actions.newPost")} variant="primary">
            <span className="portal-rail-action-label">{t("portal.actions.newPost")}</span>
          </Button>
        )}

        <div className="portal-nav-stack">
          {adminMode ? (
            <nav aria-label={t("portal.nav.admin")} className="portal-nav-group portal-admin-nav-group">
              <p className="portal-rail-label">{t("portal.nav.admin")}</p>
              {visible("admin-users") && <RailButton active={activeNav === "admin-users"} icon={<UsersRound size={16} />} label={t("portal.nav.userManagement")} onClick={() => navigate("admin-users")} />}
              {visible("admin-knowledge") && <RailButton active={activeNav === "admin-knowledge"} icon={<BookOpen size={16} />} label={t("portal.nav.knowledgeManagement")} onClick={() => navigate("admin-knowledge")} />}
              {visible("admin-mcp-connections") && <RailButton active={activeNav === "admin-mcp-connections"} icon={<Radio size={16} />} label={t("portal.nav.mcpConnections")} onClick={() => navigate("admin-mcp-connections")} />}
              {visible("admin-hub-review") && <RailButton active={activeNav === "admin-hub-review"} icon={<ClipboardCheck size={16} />} label={t("portal.nav.hubReview")} onClick={() => navigate("admin-hub-review")} />}
              {visible("admin-backups") && <RailButton active={activeNav === "admin-backups"} icon={<DatabaseBackup size={16} />} label={t("portal.nav.dataBackups")} onClick={() => navigate("admin-backups")} />}
              {visible("admin-login-policy") && <RailButton active={activeNav === "admin-login-policy"} icon={<KeyRound size={16} />} label={t("portal.nav.loginEmailPolicy")} onClick={() => navigate("admin-login-policy")} />}
              {visible("admin") && <RailButton active={activeNav === "admin"} icon={<Gauge size={16} />} label={t("portal.nav.gatewayAdmin")} onClick={() => navigate("admin")} />}
            </nav>
          ) : (
            <>
              <nav aria-label={t("portal.nav.community")} className="portal-nav-group">
                <p className="portal-rail-label">{t("portal.nav.community")}</p>
                {visible("home") && <RailButton active={activeNav === "home"} icon={<House size={16} />} label={t("portal.nav.home")} onClick={() => navigate("home")} />}
                {visible("discussions") && <RailButton
                  active={activeNav === "discussions"}
                  icon={<MessageSquareText size={16} />}
                  label={t("portal.nav.discussions")}
                  onClick={() => navigate("discussions")}
                />}
                {visible("catalog") && <RailButton
                  active={activeNav === "catalog"}
                  icon={<Blocks size={16} />}
                  label={t("portal.nav.skillsApps")}
                  onClick={() => navigate("catalog")}
                  onIntent={() => onNavigateIntent?.("catalog")}
                />}
              </nav>

              <nav aria-label={t("portal.nav.resources")} className="portal-nav-group">
                <p className="portal-rail-label">{t("portal.nav.resources")}</p>
                {visible("models") && <RailButton active={activeNav === "models"} icon={<KeyRound size={16} />} label={t("portal.nav.token")} onClick={() => navigate("models")} onIntent={() => onNavigateIntent?.("models")} />}
                {visible("studio") && <RailButton active={activeNav === "studio"} icon={<Box size={16} />} label={t("portal.nav.apps")} onClick={() => navigate("studio")} onIntent={() => onNavigateIntent?.("studio")} />}
                {visible("mate") && <RailButton active={activeNav === "mate"} icon={<Bot size={16} />} label={t("portal.nav.mate")} onClick={() => navigate("mate")} />}
                {visible("knowledge") && <RailButton active={activeNav === "knowledge"} icon={<BookOpen size={16} />} label={t("portal.nav.knowledge")} onClick={() => navigate("knowledge")} onIntent={() => onNavigateIntent?.("knowledge")} />}
                {visible("connections") && <RailButton
                  active={activeNav === "connections"}
                  icon={<span aria-hidden="true" className="portal-nav-mcp-logo" style={mcpLogoStyle} />}
                  label={t("portal.nav.mcpHandbook")}
                  onClick={() => navigate("connections")}
                />}
              </nav>
            </>
          )}
        </div>

        <footer className="portal-left-footer">
          {!adminMode && !mobilePanelMode && catalog.currentUser.role === "admin" && (
            <Button aria-label={t("portal.admin.enterMode")} className="portal-admin-mode-entry" iconBefore={<ShieldCheck size={16} />} onClick={() => navigate("admin")} title={t("portal.admin.enterMode")} variant="secondary">
              <span className="portal-rail-action-label">{t("portal.admin.enterMode")}</span>
            </Button>
          )}
          <div className="portal-account-row">
            <button
              aria-label={t("profile.openProfile")}
              className="portal-account-profile"
              onClick={onOpenProfile}
              title={t("profile.openProfile")}
              type="button"
            >
              <PersonAvatar imageUrl={catalog.currentUser.avatarUrl} name={catalog.currentUser.name} />
              <span>
                <strong>{catalog.currentUser.name}</strong>
                {adminMode ? <small>{t("portal.admin.roleIdentity")}</small> : currentUserJourneyLevel && (
                  <small>{formatPortalJourneyLevelLabel(currentUserJourneyLevel, locale)}</small>
                )}
              </span>
            </button>
            <LanguageSwitcher compact variant="select" />
          </div>
        </footer>
      </aside>

      <main className="portal-workspace">{children}</main>

      {!adminMode && activeNav !== "mate" && (
        <PortalLiveRail
          activityChannel={liveActivityChannel}
          collapsed={liveCollapsed}
          currentUser={catalog.currentUser}
          currentUserHasMcpBadge={catalog.currentUser.status?.mcpConnected
            ?? catalog.journey.badges.some((badge) => badge.badgeKey === "mcp_connected")}
          currentUserJourneyLevel={currentUserJourneyLevel}
          dataSource={dataSource}
          hidden={utilityPanelOpen}
          mcpConnectionStatus={mcpConnectionStatus}
          mcpStatusMode={mcpStatusMode}
          notificationUnreadCount={notificationState.unreadCount}
          notifications={notifications}
          notificationsError={notificationState.error}
          notificationsLoading={notificationState.loading}
          onActivityChannelChange={setLiveActivityChannel}
          onMarkAllNotificationsRead={() => void notificationState.markAllRead()}
          onNotificationAction={() => void handleNotificationAction()}
          onNotificationOpen={(notification) => void notificationState.openNotification(notification)}
          onOpenMcp={onOpenMcp}
          onOpenProfile={onOpenProfile}
          onToggle={() => setLiveCollapsed((current) => !current)}
        />
      )}
      {!adminMode && (
        <div
          className="portal-utility-panel-host"
          hidden={!utilityPanelOpen}
          ref={setUtilityPanelHost}
        />
      )}
      </div>
      {diagnosticsOpen && (
        <Suspense fallback={null}>
          <BrowserDiagnosticsModal onClose={() => setDiagnosticsOpen(false)} />
        </Suspense>
      )}
    </PortalUtilityRailProvider>
  );
}

function RailButton({
  active = false,
  disabled = false,
  icon,
  label,
  onClick,
  onIntent
}: {
  active?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  onIntent?: () => void;
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      aria-label={label}
      className={`portal-nav-item ${active ? "active" : ""}`}
      disabled={disabled}
      onFocus={onIntent}
      onClick={onClick}
      onPointerDown={onIntent}
      onPointerEnter={onIntent}
      title={label}
      type="button"
    >
      <span aria-hidden="true" className="portal-nav-icon">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
