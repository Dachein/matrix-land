import { useWorkspaceModules } from "../../../src/portal/brand/PlatformBrandProvider";
import { portalPageModule } from "../../../src/shared/workspaceModules";
import { RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "../../../src/portal/components/Button";
import { clearAllWorkspaceMatePersistentConversationCaches } from "../../../packages/mate-sdk/dist/conversationCache.js";
import { browserDirectoryStorage, clearAllMateDirectoryCaches } from "../../mate-preview/src/directoryCache";
import {
  McpConnectionModal,
  defaultMcpConnectionStatus,
  type McpConnectionStatus,
  type McpConnectionStatusMode
} from "../../../src/portal/components/McpConnectionModal";
import type { ProfileModalUser, ProfileUpdateInput } from "../../../src/portal/components/ProfileModal";
import { upsertForumDiscussion } from "../../../src/portal/forum/apiClient";
import { marketItemToForumAttachment } from "../../../src/portal/forum/linkedItems";
import type { ForumListedItemAttachment } from "../../../src/portal/forum/types";
import { useI18n } from "../../../src/portal/i18n";
import {
  configureMcpConnectionStatusCache,
  getCachedMcpConnectionStatus,
  readCachedMcpConnectionStatus
} from "../../../src/portal/mcp/connectionStatusCache";
import type { MarketItem } from "../../../src/portal/market/types";
import type { Discussion, PortalCatalog } from "../../../src/shared/types";
import { PortalBrandMark } from "./components/PortalBrandMark";
import { WorkspaceLogin } from "./components/WorkspaceLogin";
import { MateLaunchGate } from "../../mate-preview/src/MateLaunchGate";
import { createPreloadableRoute } from "./components/preloadableRoute";
import {
  PortalBootSkeleton,
  PortalRouteLoading,
  PortalRouteSuspense,
  type PortalSkeletonVariant
} from "./components/PortalRecovery";
import { PortalShell } from "./components/PortalShell";
import { saveCurrentUserProfile } from "./data/currentUserProfile";
import { recordPortalRouteDataReady } from "./data/portalLoadMetrics";
import { usePortalData } from "./data/usePortalData";
import { usePortalForumSync } from "./data/usePortalForumSync";
import { createCatalogLiveDataSource } from "./live/liveDataSource";
import { createPortalWebSocketLiveDataSource, resolvePortalLiveWebSocketUrl } from "./live/webSocketLiveDataSource";
import { navKeyForRoute, type PortalLandingSection, type PortalNavKey } from "./routing/portalRoutes";
import { portalRouteCriticalReadModels, portalRouteReadModels } from "./routing/portalReadModels";
import { portalAuthReturnTo, portalLoginUrl, portalRedirectRoute } from "./routing/authRoute";
import { usePortalRoute } from "./routing/usePortalRoute";
import { PortalHome } from "./routes/PortalHome";

const ProfileModal = lazy(() => import("../../../src/portal/components/ProfileModal").then((module) => ({ default: module.ProfileModal })));
const ForumComposerModal = lazy(() => import("../../../src/portal/forum/components/ForumComposerModal").then((module) => ({ default: module.ForumComposerModal })));
const portalCapabilityDetailRoute = createPreloadableRoute(
  () => import("./routes/PortalCapabilityDetail"),
  (module) => module.PortalCapabilityDetail
);
const portalPostDetailRoute = createPreloadableRoute(
  () => import("./routes/PortalPostDetail"),
  (module) => module.PortalPostDetail
);
const portalSkillsAppsRoute = createPreloadableRoute(
  () => import("./routes/PortalSkillsApps"),
  (module) => module.PortalSkillsApps
);
const portalAppsRoute = createPreloadableRoute(
  () => import("./routes/PortalApps"),
  (module) => module.PortalApps
);
const loadPortalMate = () => import("./routes/PortalMate");
const PortalMate = lazy(() => loadPortalMate().then((module) => ({ default: module.PortalMate })));
const portalKnowledgeRoute = createPreloadableRoute(
  () => import("./routes/PortalKnowledge"),
  (module) => module.PortalKnowledge
);
const portalTokenRoute = createPreloadableRoute(
  () => import("./routes/PortalToken"),
  (module) => module.PortalToken
);
const loadPortalCapabilityDetail = portalCapabilityDetailRoute.preload;
const loadPortalPostDetail = portalPostDetailRoute.preload;
const loadPortalSkillsApps = portalSkillsAppsRoute.preload;
const loadPortalApps = portalAppsRoute.preload;
const loadPortalKnowledge = portalKnowledgeRoute.preload;
const loadPortalToken = portalTokenRoute.preload;
const PortalCapabilityDetail = portalCapabilityDetailRoute.Component;
const PortalPostDetail = portalPostDetailRoute.Component;
const PortalSkillsApps = portalSkillsAppsRoute.Component;
const PortalApps = portalAppsRoute.Component;
const PortalKnowledge = portalKnowledgeRoute.Component;
const PortalMcpHandbook = lazy(() => import("./routes/PortalMcpHandbook").then((module) => ({ default: module.PortalMcpHandbook })));
const PortalToken = portalTokenRoute.Component;
const PortalAdminGateway = lazy(() => import("./routes/PortalAdminGateway").then((module) => ({ default: module.PortalAdminGateway })));
const PortalAdminUsers = lazy(() => import("./routes/PortalAdminUsers").then((module) => ({ default: module.PortalAdminUsers })));
const PortalAdminKnowledge = lazy(() => import("./routes/PortalAdminKnowledge").then((module) => ({ default: module.PortalAdminKnowledge })));
const PortalAdminMcpConnections = lazy(() => import("./routes/PortalAdminMcpConnections").then((module) => ({ default: module.PortalAdminMcpConnections })));
const PortalInstallation = lazy(() => import("./routes/PortalInstallation").then((module) => ({ default: module.PortalInstallation })));
const PortalAdminLoginPolicy = lazy(() => import("./routes/PortalAdminLoginPolicy").then((module) => ({ default: module.PortalAdminLoginPolicy })));
const PortalHubReview = lazy(() => import("./routes/PortalHubReview").then((module) => ({ default: module.PortalHubReview })));
const PortalMatePreview = lazy(() => import("../../mate-preview/src/App").then((module) => ({ default: module.MatePreviewApp })));
export function PortalApp() {
  const { locale, setLocale, t } = useI18n();
  const { navigate, route } = usePortalRoute();
  const modules = useWorkspaceModules();
  const requiredModule = portalPageModule(route.page === "landing" ? route.section : route.page);
  const moduleEnabled = !requiredModule || modules.includes(requiredModule);
  const deferredResources = moduleEnabled ? portalRouteReadModels(route.page) : [];
  const {
    applyPendingDiscussions,
    auth,
    catalog,
    degradedResources,
    error,
    forumFeed,
    homeApplicationsLoading,
    loadMoreDiscussions,
    loading,
    routeDataLoading,
    refresh,
    refreshDiscussions,
    updateCatalog
  } = usePortalData({
    authOnly: route.page === "mate-preview" || route.page === "mate-embed",
    backgroundResourcesEnabled: route.page === "landing" && modules.includes("discussions"),
    criticalResources: moduleEnabled ? portalRouteCriticalReadModels(route.page) : [],
    deferredResources,
    homeApplicationsEnabled: route.page === "landing" && modules.includes("studio")
  });
  useEffect(() => {
    if (!loading && !routeDataLoading && catalog) {
      recordPortalRouteDataReady(route.page);
    }
  }, [catalog, loading, route.page, routeDataLoading]);
  const [visibleLandingSection, setVisibleLandingSection] = useState<PortalLandingSection>(() => (
    route.page === "landing" ? route.section : "home"
  ));
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerLinkedItem, setComposerLinkedItem] = useState<ForumListedItemAttachment | undefined>();
  const [isMcpModalOpen, setIsMcpModalOpen] = useState(false);
  const [mcpConnectionStatus, setMcpConnectionStatus] = useState<McpConnectionStatus>(defaultMcpConnectionStatus);
  const [mcpStatusMode, setMcpStatusMode] = useState<McpConnectionStatusMode>("loading");
  const [profileUser, setProfileUser] = useState<ProfileModalUser | undefined>();
  const [profileInitialTab, setProfileInitialTab] = useState<"basic" | "journey">("basic");
  const [profileDetailsLoading, setProfileDetailsLoading] = useState(false);
  const profileLoadRequestRef = useRef(0);
  const [authMethod, setAuthMethod] = useState<"entra" | "email">("email");
  const authReturnTo = portalAuthReturnTo(window.location.search, window.location.origin);

  useEffect(() => {
    if (auth?.authenticated && authReturnTo) {
      window.location.replace(authReturnTo);
    }
  }, [auth?.authenticated, authReturnTo]);

  useEffect(() => {
    void preloadPortalRoute(route.page).catch(() => undefined);
  }, [route.page]);
  const liveDataSource = useMemo(() => {
    if (!catalog) {
      return undefined;
    }

    const snapshotSource = createCatalogLiveDataSource(catalog, loading ? "connecting" : error ? "offline" : "connected");
    const webSocketUrl = resolvePortalLiveWebSocketUrl(import.meta.env.VITE_PORTAL_LIVE_WSS_URL, window.location);

    return webSocketUrl
      ? createPortalWebSocketLiveDataSource({
          initialSnapshot: snapshotSource.getSnapshot(),
          url: webSocketUrl,
          workspaceId: import.meta.env.VITE_PORTAL_LIVE_WORKSPACE_ID?.trim() || "workspace-ai-playground"
        })
      : snapshotSource;
  }, [
    catalog?.activityEvents,
    catalog?.currentUser,
    catalog?.discussions,
    error,
    loading
  ]);
  const { changeForumQuery, loadMoreForumDiscussions } = usePortalForumSync({
    currentUserId: catalog?.currentUser.id,
    landing: route.page === "landing",
    liveDataSource,
    loadMoreDiscussions,
    refreshDiscussions
  });

  const loadUserProfile = useCallback(async (user: ProfileModalUser): Promise<ProfileModalUser> => {
    if (!user.id || user.id.includes(":")) {
      return user;
    }

    try {
      const response = await fetch(`/api/users/${encodeURIComponent(user.id)}/profile`);
      if (!response.ok) {
        return user;
      }

      const payload = await response.json() as { user?: ProfileModalUser };
      return payload.user ? { ...user, ...payload.user } : user;
    } catch {
      return user;
    }
  }, []);

  const refreshMcpConnectionStatus = useCallback(async (forceRefresh = true, showLoading = true) => {
    if (showLoading) {
      setMcpStatusMode("loading");
    }
    try {
      setMcpConnectionStatus(await getCachedMcpConnectionStatus({ forceRefresh }));
      setMcpStatusMode("ready");
    } catch {
      setMcpConnectionStatus(readCachedMcpConnectionStatus()?.status ?? defaultMcpConnectionStatus);
      setMcpStatusMode("error");
    }
  }, []);

  const updateCurrentUserProfile = useCallback(async (updates: ProfileUpdateInput): Promise<ProfileModalUser> => {
    if (!catalog) {
      throw new Error("profile_update_failed");
    }

    const nextUser = await saveCurrentUserProfile(catalog.currentUser, updates);

    updateCatalog((current) => ({
      ...current,
      currentUser: {
        ...current.currentUser,
        ...nextUser,
        identity: current.currentUser.identity
      }
    }));

    return nextUser;
  }, [catalog, updateCatalog]);

  const navigateLanding = useCallback((section: PortalLandingSection) => {
    setVisibleLandingSection(section);
    navigate({ page: "landing", section });
    window.requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [navigate]);

  const navigateFromRail = useCallback((target: PortalNavKey) => {
    if (target === "home" || target === "discussions") {
      navigateLanding(target);
      return;
    }

    if (target === "catalog") {
      navigate({ page: "catalog" });
      return;
    }

    if (target === "models") {
      navigate({ page: "models" });
      return;
    }

    if (target === "studio") {
      navigate({ page: "studio" });
      return;
    }

    if (target === "mate") {
      navigate({ page: "mate" });
      return;
    }

    if (target === "knowledge") {
      navigate({ page: "knowledge", section: "my" });
      return;
    }

    if (target === "connections") {
      navigate({ page: "connections" });
      return;
    }

    if (target === "admin") {
      navigate(modules.includes("models") ? { page: "admin", section: "tokens" } : { page: "admin-backups" });
      return;
    }

    if (target === "admin-users") {
      navigate({ page: "admin-users" });
      return;
    }

    if (target === "admin-knowledge") {
      navigate({ page: "admin-knowledge" });
      return;
    }

    if (target === "admin-mcp-connections") {
      navigate({ page: "admin-mcp-connections" });
      return;
    }

    if (target === "admin-hub-review") {
      navigate({ page: "admin-hub-review" });
      return;
    }

    if (target === "admin-backups") {
      navigate({ page: "admin-backups" });
      return;
    }

    if (target === "admin-login-policy") {
      navigate({ page: "admin-login-policy" });
    }
  }, [modules, navigate, navigateLanding]);

  const requestNewPost = useCallback(() => {
    setComposerLinkedItem(undefined);
    setComposerOpen(true);
  }, []);

  const requestLinkedPost = useCallback((item: MarketItem) => {
    setComposerLinkedItem(marketItemToForumAttachment(item));
    setComposerOpen(true);
  }, []);

  const closeComposer = useCallback(() => {
    setComposerOpen(false);
    setComposerLinkedItem(undefined);
  }, []);

  const cacheDiscussion = useCallback((discussion: Discussion, options: { prepend?: boolean } = {}) => {
    updateCatalog((current) => ({
      ...current,
      discussions: upsertForumDiscussion(current.discussions, discussion, options)
    }));
  }, [updateCatalog]);

  const openMcpModal = useCallback(() => {
    setIsMcpModalOpen(true);
    void refreshMcpConnectionStatus(true);
  }, [refreshMcpConnectionStatus]);

  const openProfile = useCallback((user: ProfileModalUser, initialTab: "basic" | "journey" = "basic") => {
    const requestId = profileLoadRequestRef.current + 1;
    profileLoadRequestRef.current = requestId;
    setProfileInitialTab(initialTab);
    setProfileUser(user);
    setProfileDetailsLoading(Boolean(user.id && !user.id.includes(":")));
    void loadUserProfile(user).then((loadedUser) => {
      if (profileLoadRequestRef.current !== requestId) {
        return;
      }
      setProfileUser((current) => current?.id === user.id ? loadedUser : current);
      setProfileDetailsLoading(false);
    });
  }, [loadUserProfile]);

  const openCurrentUserProfile = useCallback(() => {
    if (!catalog) {
      return;
    }

    openProfile(profileFromCurrentUser(catalog.currentUser), "basic");
  }, [catalog, openProfile]);

  const openCurrentUserJourney = useCallback(() => {
    if (!catalog) {
      return;
    }

    openProfile(profileFromCurrentUser(catalog.currentUser), "journey");
  }, [catalog, openProfile]);

  useEffect(() => {
    if (!catalog?.currentUser.id) {
      return;
    }

    configureMcpConnectionStatusCache(catalog.currentUser.id);
    const cached = readCachedMcpConnectionStatus();
    const summary = catalog.currentUser.status;
    if (cached) {
      setMcpConnectionStatus(cached.status);
      setMcpStatusMode("ready");
    } else if (summary) {
      setMcpConnectionStatus(mcpConnectionStatusFromSummary(summary.mcpConnected));
      setMcpStatusMode("ready");
    } else {
      setMcpConnectionStatus(defaultMcpConnectionStatus);
      setMcpStatusMode("loading");
    }
  }, [
    catalog?.currentUser.id,
    catalog?.currentUser.status?.mcpConnected,
    catalog?.currentUser.status?.updatedAt
  ]);

  useEffect(() => {
    if (route.page !== "knowledge" || !catalog?.currentUser.id) return;
    void refreshMcpConnectionStatus(true, false);
  }, [catalog?.currentUser.id, refreshMcpConnectionStatus, route.page]);

  useEffect(() => {
    if (!catalog?.currentUser.id) {
      return undefined;
    }

    const refreshIfStale = () => void refreshMcpConnectionStatus(false, false);
    window.addEventListener("focus", refreshIfStale);
    window.addEventListener("online", refreshIfStale);
    window.addEventListener("workspace:mcp-connections-changed", refreshIfStale);
    return () => {
      window.removeEventListener("focus", refreshIfStale);
      window.removeEventListener("online", refreshIfStale);
      window.removeEventListener("workspace:mcp-connections-changed", refreshIfStale);
    };
  }, [catalog?.currentUser.id, refreshMcpConnectionStatus]);

  useEffect(() => {
    if (!catalog) {
      return undefined;
    }

    const openProfileFromEvent = (event: Event) => {
      const detail = (event as CustomEvent<ProfileOpenDetail>).detail;
      if (!detail) {
        return;
      }

      openProfile(
        detail.id === catalog.currentUser.id ? profileFromCurrentUser(catalog.currentUser) : detail,
        detail.initialTab === "journey" ? "journey" : "basic"
      );
    };

    window.addEventListener("workspace:open-profile", openProfileFromEvent);
    return () => window.removeEventListener("workspace:open-profile", openProfileFromEvent);
  }, [catalog, openProfile]);

  useLayoutEffect(() => {
    if (route.page !== "landing") {
      window.scrollTo({ top: 0, behavior: "auto" });
      return;
    }

    setVisibleLandingSection(route.section);
    window.requestAnimationFrame(() => document.getElementById(route.section)?.scrollIntoView({ block: "start" }));
  }, [route]);

  if ((route.page === "mate-preview" || route.page === "mate-embed") && loading) {
    return (
      <MateLaunchGate locale={locale} mode={route.page === "mate-preview" ? "preview" : "live"} />
    );
  }

  if (loading && !catalog) {
    if (route.page === "mate") {
      return <MateLaunchGate locale={locale} minimal />;
    }
    return (
      <PortalBootSkeleton
        adminMode={isPortalAdminPage(route.page)}
        variant={portalSkeletonVariant(route)}
      />
    );
  }

  if (auth?.configured && !auth.authenticated) {
    const isEmailAuth = auth.emailLoginConfigured && (authMethod === "email" || auth.entraLoginConfigured === false);
    const authRedirect = authReturnTo
      ? "/home"
      : window.location.hash || `${window.location.pathname}${window.location.search}`;

    return (
      <WorkspaceLogin
        entraLoginConfigured={auth.entraLoginConfigured !== false}
        emailLoginConfigured={auth.emailLoginConfigured}
        emailLoginUrl={auth.emailLoginUrl}
        isEmailAuth={isEmailAuth}
        onMicrosoftSignIn={() => window.location.assign(portalLoginUrl(
          auth.loginUrl,
          authRedirect,
          window.location.origin,
          authReturnTo
        ))}
        onSwitchAuthMethod={() => setAuthMethod(isEmailAuth ? "entra" : "email")}
        redirect={portalRedirectRoute(authRedirect)}
        returnTo={authReturnTo}
      />
    );
  }

  if (route.page === "mate-preview") {
    if (!auth) {
      return (
        <PortalStatusGate
          description={t("portal.data.authErrorDescription")}
          icon={<TriangleAlert size={20} />}
          title={t("portal.data.errorTitle")}
        />
      );
    }

    return (
      <PortalRouteSuspense fallback={<MateLaunchGate locale={locale} mode="preview" />}>
        <PortalMatePreview
          locale={locale}
          onLocaleChange={setLocale}
          debug={route.debug}
          onExit={() => navigate({ page: "mate" })}
          presentation={route.presentation}
          releaseId={route.releaseId}
          mateId={route.mateId}
        />
      </PortalRouteSuspense>
    );
  }

  if (route.page === "mate-embed") {
    if (!auth) {
      return (
        <PortalStatusGate
          description={t("portal.data.authErrorDescription")}
          icon={<TriangleAlert size={20} />}
          title={t("portal.data.errorTitle")}
        />
      );
    }

    return (
      <PortalRouteSuspense fallback={<MateLaunchGate locale={locale} mode="live" />}>
        <PortalMatePreview
          locale={locale}
          onLocaleChange={setLocale}
          conversationId={route.conversationId}
          embedInstanceId={route.embedInstanceId}
          mode="live"
          onExit={() => navigate({ page: "mate" })}
          presentation={route.presentation}
          mateId={route.mateId}
        />
      </PortalRouteSuspense>
    );
  }

  if (!catalog || !liveDataSource) {
    return (
      <PortalStatusGate
        action={(
          <Button iconBefore={<RefreshCw size={17} />} onClick={refresh} variant="primary">
            {t("portal.data.retry")}
          </Button>
        )}
        description={t(error?.scope === "auth" ? "portal.data.authErrorDescription" : "portal.data.catalogErrorDescription")}
        icon={<TriangleAlert size={20} />}
        title={t("portal.data.errorTitle")}
      />
    );
  }

  const activeNav = route.page === "landing"
    ? visibleLandingSection
    : navKeyForRoute(route);
  const routeDegradedResources = degradedResources.filter((resource) => deferredResources.includes(resource)
    || (route.page === "landing" && ["apps", "hub", "discussions", "journey"].includes(resource)));
  const content = (() => {
    if (!moduleEnabled) return <PortalStatusGate title={locale === "zh-CN" ? "此模块尚未启用" : "This module is not enabled"} description={locale === "zh-CN" ? "管理员可以通过安装器启用此功能。" : "An administrator can enable this feature in Setup."} icon={<TriangleAlert size={20} />} />;
    if (route.page === "not-found") return <PortalStatusGate title={locale === "zh-CN" ? "页面不存在" : "Page not found"} description={locale === "zh-CN" ? "请从导航中选择一个页面。" : "Choose a page from the navigation."} icon={<TriangleAlert size={20} />} />;
    if (routeDataLoading) {
      if (route.page === "mate") return <MateLaunchGate locale={locale} minimal />;
      return <PortalRouteLoading variant={portalSkeletonVariant(route)} />;
    }

    if (route.page === "post") {
      return (
        <PortalRouteSuspense variant="post">
          <PortalPostDetail
            catalog={catalog}
            key={route.postId}
            onBack={() => navigateLanding("discussions")}
            onDeleted={async () => {
              await refreshDiscussions();
              navigateLanding("discussions");
            }}
            onRefresh={refresh}
            onTopicLoaded={cacheDiscussion}
            postId={route.postId}
          />
        </PortalRouteSuspense>
      );
    }

    if (route.page === "catalog") {
      return (
        <PortalRouteSuspense variant="market">
          <PortalSkillsApps
            catalog={catalog}
            onCreateAndShare={() => navigate({ page: "studio" })}
            onOpenItem={(item) => navigate(item.kind === "app"
              ? { page: "app", appId: item.targetId }
              : { page: "skill", skillId: item.targetId })}
          />
        </PortalRouteSuspense>
      );
    }

    if (route.page === "app" || route.page === "skill") {
      return (
        <PortalRouteSuspense variant="capability">
          <PortalCapabilityDetail
            catalog={catalog}
            kind={route.page}
            onBack={() => navigate({ page: "catalog" })}
            onComposeItem={requestLinkedPost}
            onOpenPost={(postId) => navigate({ page: "post", postId })}
            onRefresh={refresh}
            routeId={route.page === "app" ? route.appId : route.skillId}
          />
        </PortalRouteSuspense>
      );
    }

    if (route.page === "models" || route.page === "model-status") {
      return (
        <PortalRouteSuspense variant="token">
          <PortalToken
            catalog={catalog}
            initialModelStatusOpen={route.page === "model-status"}
            onModelStatusClosed={route.page === "model-status" ? () => navigate({ page: "models" }) : undefined}
          />
        </PortalRouteSuspense>
      );
    }

    if (route.page === "studio") {
      return (
        <PortalRouteSuspense variant="apps">
          <PortalApps catalog={catalog} onRefresh={refresh} />
        </PortalRouteSuspense>
      );
    }

    if (route.page === "mate") {
      return <PortalRouteSuspense fallback={<MateLaunchGate locale={locale} minimal />}><PortalMate
        catalog={catalog}
        initialConversationId={route.conversationId}
        initialArtifactId={route.artifactId}
        initialMateId={route.mateId}
        onMateChange={(mate) => navigate({ page: "mate", mateId: mate.id })}
        onRefresh={refresh}
      /></PortalRouteSuspense>;
    }

    if (route.page === "knowledge") {
      return (
        <PortalRouteSuspense variant="knowledge">
          <PortalKnowledge
            catalog={catalog}
            onSectionChange={(section) => navigate({ page: "knowledge", section })}
            section={route.section}
          />
        </PortalRouteSuspense>
      );
    }

    if (route.page === "connections") {
      return (
        <PortalRouteSuspense variant="handbook">
          <PortalMcpHandbook />
        </PortalRouteSuspense>
      );
    }

    if (route.page === "admin") {
      return (
        <PortalRouteSuspense variant="admin">
          <PortalAdminGateway
            catalog={catalog}
            onSectionChange={(section) => navigate({ page: "admin", section })}
            section={route.section}
          />
        </PortalRouteSuspense>
      );
    }

    if (route.page === "admin-users") {
      return (
        <PortalRouteSuspense variant="admin">
          <PortalAdminUsers catalog={catalog} />
        </PortalRouteSuspense>
      );
    }

    if (route.page === "admin-knowledge") {
      return (
        <PortalRouteSuspense variant="admin">
          <PortalAdminKnowledge catalog={catalog} />
        </PortalRouteSuspense>
      );
    }

    if (route.page === "admin-mcp-connections") {
      return (
        <PortalRouteSuspense variant="admin">
          <PortalAdminMcpConnections catalog={catalog} />
        </PortalRouteSuspense>
      );
    }

    if (route.page === "admin-hub-review") {
      return (
        <PortalRouteSuspense variant="admin">
          <PortalHubReview catalog={catalog} onRefresh={refresh} unavailable={degradedResources.some((resource) => resource === "apps" || resource === "skills" || resource === "reviewPublication")} />
        </PortalRouteSuspense>
      );
    }

    if (route.page === "admin-backups") {
      return (
        <PortalRouteSuspense variant="admin">
          <PortalInstallation catalog={catalog} />
        </PortalRouteSuspense>
      );
    }

    if (route.page === "admin-login-policy") {
      return (
        <PortalRouteSuspense variant="admin">
          <PortalAdminLoginPolicy catalog={catalog} />
        </PortalRouteSuspense>
      );
    }

    return (
      <PortalHome
        applicationsLoading={homeApplicationsLoading}
        catalog={catalog}
        forumFeed={forumFeed}
        onApplyPendingDiscussions={applyPendingDiscussions}
        onDiscussionQueryChange={changeForumQuery}
        onLoadMoreDiscussions={loadMoreForumDiscussions}
        onNewPost={requestNewPost}
        onOpenJourney={openCurrentUserJourney}
        onOpenMcp={openMcpModal}
        onOpenPost={(postId) => navigate({ page: "post", postId })}
        onOpenWorkBuddy={() => navigate({ page: "app", appId: "app_3d97b132793c" })}
        onSectionVisible={setVisibleLandingSection}
      />
    );
  })();

  return (
    <>
      <PortalShell
        activeNav={activeNav}
        catalog={catalog}
        currentUserJourneyLevel={degradedResources.includes("journey") ? undefined : catalog.journey.level}
        dataSource={liveDataSource}
        loading={loading}
        mcpConnectionStatus={mcpConnectionStatus}
        mcpStatusMode={mcpStatusMode}
        onNavigate={navigateFromRail}
        onNavigateIntent={(target) => void preloadPortalNavTarget(target).catch(() => undefined)}
        onNewPost={requestNewPost}
        onOpenMcp={openMcpModal}
        onOpenProfile={openCurrentUserProfile}
      >
        {routeDegradedResources.length > 0 && route.page !== "admin-hub-review" && (
          <div className="portal-data-warning" role="status">
            <TriangleAlert size={16} />
            <span>{t("portal.data.degradedDescription")}</span>
            <Button iconBefore={<RefreshCw size={14} />} onClick={refresh} size="compact" variant="secondary">
              {t("portal.data.retry")}
            </Button>
          </div>
        )}
        {content}
      </PortalShell>
      {composerOpen && (
        <PortalRouteSuspense>
          <ForumComposerModal
            linkedItem={composerLinkedItem}
            onCancel={closeComposer}
            onCreated={async (discussion) => {
              closeComposer();
              cacheDiscussion(discussion, { prepend: true });
              navigate({ page: "post", postId: discussion.id });
            }}
            onDismiss={closeComposer}
          />
        </PortalRouteSuspense>
      )}
      {profileUser && (
        <PortalRouteSuspense>
          <ProfileModal
            currentUserId={catalog.currentUser.id}
            detailsLoading={profileDetailsLoading}
            initialTab={profileInitialTab}
            journey={profileUser.id === catalog.currentUser.id ? catalog.journey : undefined}
            onClose={() => {
              profileLoadRequestRef.current += 1;
              setProfileUser(undefined);
              setProfileInitialTab("basic");
              setProfileDetailsLoading(false);
            }}
            onLinkMicrosoft={auth?.entraLoginConfigured ? () => window.location.assign("/auth/entra/start?link=1") : undefined}
            onLogout={auth?.configured ? () => {
              clearAllMateDirectoryCaches(browserDirectoryStorage());
              clearAllWorkspaceMatePersistentConversationCaches();
              window.location.assign(auth.logoutUrl);
            } : undefined}
            onSave={async (updates) => {
              const nextUser = await updateCurrentUserProfile(updates);
              setProfileUser(profileFromCurrentUser(nextUser));
              return nextUser;
            }}
            user={profileUser}
          />
        </PortalRouteSuspense>
      )}
      {isMcpModalOpen && (
        <McpConnectionModal
          connectionStatus={mcpConnectionStatus}
          onClose={() => setIsMcpModalOpen(false)}
          onRefresh={() => refreshMcpConnectionStatus(true)}
          statusMode={mcpStatusMode}
        />
      )}
    </>
  );
}

function portalSkeletonVariant(
  route: ReturnType<typeof usePortalRoute>["route"]
): PortalSkeletonVariant {
  if (route.page === "landing") return route.section === "discussions" ? "discussions" : "home";
  if (route.page === "catalog") return "market";
  if (route.page === "app" || route.page === "skill") return "capability";
  if (route.page === "post") return "post";
  if (route.page === "models" || route.page === "model-status") return "token";
  if (route.page === "studio") return "apps";
  if (route.page === "knowledge") return "knowledge";
  if (route.page === "connections") return "handbook";
  if (route.page === "mate-preview" || route.page === "mate-embed") return "qa";
  return "admin";
}

function isPortalAdminPage(page: ReturnType<typeof usePortalRoute>["route"]["page"]): boolean {
  return page === "admin"
    || page === "admin-users"
    || page === "admin-knowledge"
    || page === "admin-mcp-connections"
    || page === "admin-hub-review"
    || page === "admin-backups"
    || page === "admin-login-policy";
}

function preloadPortalRoute(page: ReturnType<typeof usePortalRoute>["route"]["page"]): Promise<unknown> {
  if (page === "catalog") return loadPortalSkillsApps();
  if (page === "app" || page === "skill") return loadPortalCapabilityDetail();
  if (page === "post") return loadPortalPostDetail();
  if (page === "studio") return loadPortalApps();
  if (page === "mate") return loadPortalMate();
  if (page === "knowledge") return loadPortalKnowledge();
  if (page === "models" || page === "model-status") return loadPortalToken();
  return Promise.resolve();
}

function preloadPortalNavTarget(target: PortalNavKey): Promise<unknown> {
  if (target === "catalog") return loadPortalSkillsApps();
  if (target === "studio") return loadPortalApps();
  if (target === "mate") return loadPortalMate();
  if (target === "knowledge") return loadPortalKnowledge();
  if (target === "models") return loadPortalToken();
  return Promise.resolve();
}

type ProfileOpenDetail = ProfileModalUser & {
  initialTab?: "basic" | "journey";
};

function profileFromCurrentUser(user: ProfileModalUser): ProfileModalUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
    team: "",
    department: user.department,
    ...(user.departmentId ? { departmentId: user.departmentId } : {}),
    ...(user.departmentPath?.length ? { departmentPath: user.departmentPath } : {}),
    ...(user.departmentDisplayPath ? { departmentDisplayPath: user.departmentDisplayPath } : {}),
    jobTitle: user.jobTitle,
    bio: user.bio,
    location: user.location,
    role: user.role
  };
}

function mcpConnectionStatusFromSummary(connected: boolean): McpConnectionStatus {
  return connected
    ? {
        ...defaultMcpConnectionStatus,
        activeCount: 1,
        connected: true,
        credentialState: "active",
        currentTaskAvailability: "reload_may_be_required"
      }
    : defaultMcpConnectionStatus;
}

function PortalStatusGate({
  action,
  description,
  icon,
  title
}: {
  action?: ReactNode;
  description?: string;
  icon?: ReactNode;
  title: string;
}) {
  const { t } = useI18n();

  return (
    <main
      className="portal-auth-gate portal-status-gate"
    >
      <div className="portal-auth-brand">
        <PortalBrandMark /> <strong>{t("portal.brand.name")}</strong>
      </div>
      {icon && <span className="portal-status-gate-icon" aria-hidden="true">{icon}</span>}
      <h1>{title}</h1>
      {description && <p>{description}</p>}
      {action}
    </main>
  );
}
