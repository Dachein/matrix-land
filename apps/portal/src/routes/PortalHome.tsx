import { ArrowUpRight, LoaderCircle, RefreshCw, Search, Send, Tags } from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { PersonAvatar } from "../../../../src/portal/components/shared/avatar";
import { WorkspaceListbox } from "../../../../src/portal/components/WorkspaceListbox";
import { SegmentedControl } from "../../../../src/portal/components/SegmentedControl";
import { FORUM_CATEGORY_DEFINITIONS, type ForumCategorySlug } from "../../../../src/portal/forum/config";
import { useI18n } from "../../../../src/portal/i18n";
import {
  monthlyBudgetUsdForPortalJourneyLevel,
  portalJourneyLevels
} from "../../../../src/shared/journey";
import type { ForumDiscussionQuery, PortalCatalog } from "../../../../src/shared/types";
import { HomeApplications } from "../components/HomeApplications";
import { PortalDiscussionCard } from "../components/PortalDiscussionCard";
import type { PortalForumFeedState } from "../data/usePortalData";
import { useGroupUsage } from "../data/useGroupUsage";
import {
  groupPortalHomeDiscussions,
  orderedDiscussions,
  type PortalDiscussionOwnerFilter
} from "../lib/viewModels";
import type { PortalLandingSection } from "../routing/portalRoutes";

type HomeOnboardingView = "benefits" | "connect";

const PassLearningModal = lazy(async () => {
  const module = await import("../components/PassLearningModal");
  return { default: module.PassLearningModal };
});

export function PortalHome({
  applicationsLoading,
  catalog,
  forumFeed,
  onApplyPendingDiscussions,
  onDiscussionQueryChange,
  onLoadMoreDiscussions,
  onNewPost,
  onOpenJourney,
  onOpenMcp,
  onOpenPost,
  onOpenWorkBuddy,
  onSectionVisible
}: {
  applicationsLoading: boolean;
  catalog: PortalCatalog;
  forumFeed: PortalForumFeedState;
  onApplyPendingDiscussions: () => void;
  onDiscussionQueryChange: (query: ForumDiscussionQuery) => void;
  onLoadMoreDiscussions: () => void;
  onNewPost: () => void;
  onOpenJourney: () => void;
  onOpenMcp: () => void;
  onOpenPost: (postId: string) => void;
  onOpenWorkBuddy: () => void;
  onSectionVisible: (section: PortalLandingSection) => void;
}) {
  const { locale, t } = useI18n();
  const groupUsage = useGroupUsage(catalog.currentUser.id);
  const discussionsRef = useRef<HTMLElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const [discussionCategory, setDiscussionCategory] = useState<ForumCategorySlug | "">("");
  const [discussionOwner, setDiscussionOwner] = useState<PortalDiscussionOwnerFilter>("all");
  const [discussionQuery, setDiscussionQuery] = useState("");
  const [homeOnboardingView, setHomeOnboardingView] = useState<HomeOnboardingView | null>(null);
  const discussions = useMemo(() => orderedDiscussions(catalog.discussions), [catalog.discussions]);
  const { earlier, pinned, recent } = useMemo(
    () => groupPortalHomeDiscussions(discussions),
    [discussions]
  );
  const currentLevel = catalog.journey.level;
  const currentLevelName = locale === "zh-CN" ? currentLevel.nameZh : currentLevel.nameEn;
  const nextLevel = portalJourneyLevels.find((level) => level.rank > currentLevel.rank);
  const nextLevelName = nextLevel
    ? locale === "zh-CN" ? nextLevel.nameZh : nextLevel.nameEn
    : undefined;
  const monthlyTokenBudget = monthlyBudgetUsdForPortalJourneyLevel(currentLevel.key);
  const nextMonthlyTokenBudget = nextLevel
    ? monthlyBudgetUsdForPortalJourneyLevel(nextLevel.key)
    : undefined;
  const displayedTokenBudget = nextMonthlyTokenBudget ?? monthlyTokenBudget;
  useEffect(() => {
    const handleScroll = () => {
      const top = discussionsRef.current?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
      onSectionVisible(top <= 132 ? "discussions" : "home");
    };

    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [onSectionVisible]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      onDiscussionQueryChange({
        category: discussionCategory || undefined,
        owner: discussionOwner,
        query: discussionQuery.trim() || undefined
      });
    }, discussionQuery.trim() ? 280 : 0);

    return () => window.clearTimeout(timer);
  }, [discussionCategory, discussionOwner, discussionQuery, onDiscussionQueryChange]);

  useEffect(() => {
    if (!forumFeed.hasPendingUpdate) {
      return;
    }

    const feedTop = feedRef.current?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    if (feedTop >= -120) {
      onApplyPendingDiscussions();
    }
  }, [forumFeed.hasPendingUpdate, onApplyPendingDiscussions]);

  useEffect(() => {
    if (!homeOnboardingView) {
      return;
    }

    const handleOnboardingKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHomeOnboardingView(null);
      }
    };

    window.addEventListener("keydown", handleOnboardingKeyDown);
    return () => window.removeEventListener("keydown", handleOnboardingKeyDown);
  }, [homeOnboardingView]);

  return (
    <div className="portal-workspace-inner">
      <section className="portal-page portal-home" id="home">
        <div className={`portal-hero-mast${homeOnboardingView === "connect" ? " onboarding-open" : ""}`}>
          <div className="portal-hero-copy">
            <div>
              <div className="portal-hero-kicker-row">
                <p className="portal-kicker">{t("portal.home.kicker")}</p>
                <span className="portal-group-usage-refresh">
                  <span aria-hidden="true" />
                  {t("portal.home.groupUsageRefresh")}
                </span>
              </div>
              <h1
                aria-atomic="true"
                aria-live="polite"
                className="portal-group-usage-metric"
              >
                <span className={`portal-group-usage-number${groupUsage.loading && !groupUsage.usage ? " loading" : ""}`}>
                  {groupUsage.usage ? formatGroupUsageNumber(groupUsage.usage.totalTokens, locale) : "—"}
                </span>
                <span className="portal-group-usage-unit">TOKEN</span>
              </h1>
              <p className={`portal-group-usage-meta${groupUsage.error ? " error" : ""}`}>
                {groupUsage.usage
                  ? t("portal.home.groupUsageSince", {
                      count: formatGroupUsageNumber(groupUsage.usage.requestCount, locale),
                      date: formatGroupUsageDate(groupUsage.usage.startDate, locale)
                    })
                  : groupUsage.error
                    ? t("portal.home.groupUsageUnavailable")
                    : t("portal.home.groupUsageLoading")}
              </p>
            </div>
            <div aria-label={t("portal.home.currentUserAria")} className="portal-hero-achievement">
              <div className="portal-hero-current-user">
                <PersonAvatar imageUrl={catalog.currentUser.avatarUrl} name={catalog.currentUser.name} />
                <span className="portal-hero-user-copy">
                  <small className="portal-hero-level-caption">
                    <span>{t("portal.home.currentLevel")}</span>
                    <span aria-hidden="true">｜</span>
                    <strong>{t("portal.home.currentLevelBudget", { amount: `$${monthlyTokenBudget}` })}</strong>
                  </small>
                  <span className="portal-hero-user-level">
                    <strong>{catalog.currentUser.name}</strong>
                    <span>/ {t("portal.home.levelTitle", { name: currentLevelName, rank: currentLevel.rank })}</span>
                  </span>
                </span>
                <span className="portal-hero-next-level">
                  <small>{t("portal.home.nextLevel")}</small>
                  <strong>
                    {nextLevel && nextLevelName
                      ? t("portal.home.levelTitle", { name: nextLevelName, rank: nextLevel.rank })
                      : t("portal.home.topLevel")}
                  </strong>
                </span>
              </div>
              <div className="portal-level-token-benefit">
                <strong>${displayedTokenBudget}</strong>
                <span>{t(nextLevel ? "portal.home.nextLevelBudget" : "portal.home.maxLevelBudget")}</span>
                <button onClick={onOpenJourney} type="button">
                  {t("portal.home.levelHowTo")} <span aria-hidden="true">→</span>
                </button>
              </div>
            </div>
          </div>

          <aside aria-label={t("portal.home.passAria")} className="portal-hero-panel portal-hero-pass-panel">
            <p className="portal-panel-kicker">{t("portal.home.passKicker")}</p>
            <h2>{t("portal.home.passTitle")}</h2>
            <p className="portal-hero-pass-body">{t("portal.home.passBody")}</p>
            <div className="portal-hero-pass-actions">
              <button
                className="portal-hero-pass-primary"
                onClick={() => {
                  setHomeOnboardingView("benefits");
                }}
                type="button"
              >
                {t("portal.home.passBenefits")}
              </button>
              <button
                className="portal-hero-pass-secondary"
                onClick={() => setHomeOnboardingView("connect")}
                type="button"
              >
                {t("portal.home.passConnect")}
              </button>
            </div>
          </aside>

          {homeOnboardingView === "benefits" && (
            <Suspense fallback={<span role="status">{t("portal.home.demo.loading")}</span>}>
              <PassLearningModal onClose={() => setHomeOnboardingView(null)} onConnect={() => setHomeOnboardingView("connect")} />
            </Suspense>
          )}
          {homeOnboardingView === "connect" && (
            <div
              aria-label={t("portal.home.onboardingAria")}
              aria-modal="true"
              className={`portal-home-onboarding ${homeOnboardingView}`}
              role="dialog"
            >
              <div className="portal-home-onboarding-shell">
                {homeOnboardingView === "connect" && (
                  <>
                    <header className="portal-home-onboarding-header">
                      <p className="portal-panel-kicker">{t("portal.home.connectKicker")}</p>
                      <h2>{t("portal.home.connectTitle")}</h2>
                      <p>{t("portal.home.connectBody")}</p>
                    </header>
                    <div className="portal-home-onboarding-paths">
                      <button
                        className="portal-home-onboarding-path featured"
                        onClick={() => {
                          setHomeOnboardingView(null);
                          onOpenMcp();
                        }}
                        type="button"
                      >
                        <span>01</span>
                        <strong>{t("portal.home.connectExistingTitle")}</strong>
                        <small>{t("portal.home.connectExistingBody")}</small>
                        <b>{t("portal.home.connectExistingAction")} <ArrowUpRight aria-hidden="true" size={15} /></b>
                      </button>
                      <button
                        className="portal-home-onboarding-path"
                        onClick={() => {
                          setHomeOnboardingView(null);
                          onOpenWorkBuddy();
                        }}
                        type="button"
                      >
                        <span>02</span>
                        <strong>{t("portal.home.connectNeedTitle")}</strong>
                        <small>{t("portal.home.connectNeedBody")}</small>
                        <b>{t("portal.home.connectNeedAction")} <ArrowUpRight aria-hidden="true" size={15} /></b>
                      </button>
                    </div>
                    <button
                      className="portal-home-onboarding-back"
                      onClick={() => setHomeOnboardingView("benefits")}
                      type="button"
                    >
                      ← {t("portal.home.connectBack")}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <HomeApplications applicationsLoading={applicationsLoading} catalog={catalog} />
      </section>

      <section className="portal-page portal-discussions" id="discussions" ref={discussionsRef}>
        <header className="portal-section-header">
          <div>
            <h2>{t("portal.discussions.title")}</h2>
            <p>{t("portal.discussions.description")}</p>
          </div>
          {forumFeed.loading && discussions.length === 0
            ? <span aria-hidden="true" className="portal-discussions-count-skeleton" />
            : <span>{t("portal.discussions.count", { count: discussions.length })}</span>}
        </header>

        <div className="portal-composer-row">
          <PersonAvatar imageUrl={catalog.currentUser.avatarUrl} name={catalog.currentUser.name} />
          <button className="portal-composer-prompt" id="portal-composer-prompt" onClick={onNewPost} type="button">
            {t("portal.discussions.composerPlaceholder")}
          </button>
          <button className="portal-post-button" onClick={onNewPost} type="button">
            <Send size={15} />
            <span>{t("portal.discussions.post")}</span>
          </button>
        </div>

        <div aria-label={t("portal.discussions.filtersAria")} className="portal-community-filters" role="search">
          <label className="portal-community-search">
            <Search aria-hidden="true" size={16} />
            <span className="visuallyHidden">{t("portal.discussions.searchLabel")}</span>
            <input
              onChange={(event) => setDiscussionQuery(event.target.value)}
              placeholder={t("portal.discussions.searchPlaceholder")}
              type="search"
              value={discussionQuery}
            />
          </label>

          <WorkspaceListbox<ForumCategorySlug | "">
            ariaLabel={t("portal.discussions.categoryLabel")}
            className="portal-community-category"
            iconBefore={<Tags size={14} />}
            noResultsLabel={t("common.noResults")}
            onChange={setDiscussionCategory}
            options={[
              {
                label: t("portal.discussions.allCategories"),
                value: ""
              },
              ...FORUM_CATEGORY_DEFINITIONS.map((category) => ({
                label: t(category.labelKey),
                value: category.slug
              }))
            ]}
            value={discussionCategory}
            variant="filter"
          />

          <SegmentedControl<PortalDiscussionOwnerFilter>
            ariaLabel={t("portal.discussions.ownerLabel")}
            className="portal-community-owner"
            onChange={setDiscussionOwner}
            options={[
              { label: t("portal.discussions.ownerAll"), value: "all" },
              { label: t("portal.discussions.ownerMine"), value: "mine" }
            ]}
            value={discussionOwner}
          />
        </div>

        {forumFeed.hasPendingUpdate && (
          <button
            className="portal-feed-refresh-notice"
            onClick={onApplyPendingDiscussions}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={15} />
            <span>
              {forumFeed.pendingCount > 0
                ? t("portal.discussions.newTopics", { count: forumFeed.pendingCount })
                : t("portal.discussions.updatedTopics")}
            </span>
          </button>
        )}

        <div className="portal-feed-list" ref={feedRef}>
          {forumFeed.loading && discussions.length === 0 && (
            <DiscussionFeedSkeleton label={t("portal.data.loadingTitle")} />
          )}
          {recent.length > 0 && <p className="portal-section-line">{t("portal.discussions.recent")}</p>}
          {recent.map((discussion) => (
            <PortalDiscussionCard catalog={catalog} discussion={discussion} key={discussion.id} onOpen={() => onOpenPost(discussion.id)} />
          ))}
          {pinned.map((discussion) => (
            <PortalDiscussionCard catalog={catalog} discussion={discussion} key={discussion.id} onOpen={() => onOpenPost(discussion.id)} />
          ))}
          {earlier.length > 0 && <p className="portal-section-line">{t("portal.discussions.earlier")}</p>}
          {earlier.map((discussion) => (
            <PortalDiscussionCard catalog={catalog} discussion={discussion} key={discussion.id} onOpen={() => onOpenPost(discussion.id)} />
          ))}
          {!forumFeed.loading && discussions.length === 0 && (
            <div className="portal-feed-empty">
              {discussionQuery.trim() || discussionCategory || discussionOwner === "mine"
                ? t("portal.discussions.emptyFiltered")
                : t("portal.discussions.empty")}
            </div>
          )}
          {forumFeed.nextCursor && discussions.length > 0 && (
            <button
              className="portal-feed-load-more"
              disabled={forumFeed.loadingMore}
              onClick={onLoadMoreDiscussions}
              type="button"
            >
              {forumFeed.loadingMore && <LoaderCircle aria-hidden="true" className="portal-feed-load-spinner" size={15} />}
              <span>{t(forumFeed.loadingMore ? "portal.discussions.loadingMore" : "portal.discussions.loadMore")}</span>
            </button>
          )}
        </div>
      </section>


    </div>
  );
}

function formatGroupUsageNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale).format(value);
}

function formatGroupUsageDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Shanghai"
  }).format(new Date(`${value}T12:00:00+08:00`));
}

function DiscussionFeedSkeleton({ label }: { label: string }) {
  return (
    <div aria-label={label} aria-live="polite" className="portal-discussion-skeleton" role="status">
      {[0, 1, 2].map((item) => (
        <div aria-hidden="true" className="portal-discussion-skeleton-row" key={item}>
          <span className="portal-skeleton-block portal-discussion-skeleton-avatar" />
          <span className="portal-discussion-skeleton-copy">
            <span className="portal-skeleton-block" />
            <span className="portal-skeleton-block" />
          </span>
          <span className="portal-skeleton-block portal-discussion-skeleton-meta" />
        </div>
      ))}
    </div>
  );
}
