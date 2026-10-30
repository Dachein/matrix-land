import {
  ArrowLeft,
  CheckCircle2,
  Download,
  ExternalLink,
  MessageCircle,
  Plus,
  ShieldCheck,
  ThumbsUp,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, ButtonLink } from "../../../../src/portal/components/Button";
import { PublicationAuthors } from "../../../../src/portal/components/PublicationAuthors";
import { renderForumMarkdown } from "../../../../src/portal/forum/markdown";
import { useI18n } from "../../../../src/portal/i18n";
import { addHomePin, isHomePinned, removeHomePin } from "../../../../src/portal/lib/homePins";
import { launchPortalApp } from "../../../../src/portal/lib/launchPortalApp";
import {
  copySkillInstallPrompt,
  marketListingVersion,
  recordPublicationInstall,
  recordPublicationInteraction
} from "../../../../src/portal/market/actions";
import {
  marketAppLaunchUrl,
  marketArtifactHref,
  marketOverviewMarkdown,
  marketSafetyMarkdown,
  marketVersionMetadataRows,
  relatedMarketDiscussions
} from "../../../../src/portal/market/detailModels";
import { formatCompactCount, formatMarketUpdatedAt } from "../../../../src/portal/market/formatters";
import { buildMarketItems, marketSummary, typeLabel } from "../../../../src/portal/market/models";
import type { MarketItem, MarketKind } from "../../../../src/portal/market/types";
import { marketCategoryLabel } from "../../../../src/shared/marketCategories";
import type { PortalCatalog } from "../../../../src/shared/types";
import { PortalDiscussionCard } from "../components/PortalDiscussionCard";
import { PortalMarketObjectMark } from "../components/PortalMarketObjectMark";
import { findPortalMarketItem } from "../lib/marketRouteModels";
import "../styles/skills-apps.css";

export function PortalCapabilityDetail({
  catalog,
  kind,
  onBack,
  onComposeItem,
  onOpenPost,
  onRefresh,
  routeId
}: {
  catalog: PortalCatalog;
  kind: MarketKind;
  onBack: () => void;
  onComposeItem: (item: MarketItem) => void;
  onOpenPost: (postId: string) => void;
  onRefresh: () => void;
  routeId: string;
}) {
  const { t } = useI18n();
  const items = useMemo(() => buildMarketItems(catalog), [catalog]);
  const item = findPortalMarketItem(items, kind, routeId);

  if (!item) {
    return (
      <div className="portal-workspace-inner">
        <section className="portal-object-empty">
          <p className="portal-kicker">{t("portal.skillsApps.canonical")}</p>
          <h1>{t("portal.skillsApps.notFound")}</h1>
          <p>{t("portal.skillsApps.notFoundHint")}</p>
          <Button iconBefore={<ArrowLeft size={16} />} onClick={onBack}>
            {t("portal.skillsApps.back")}
          </Button>
        </section>
      </div>
    );
  }

  return (
    <CapabilityHomepage
      catalog={catalog}
      item={item}
      onBack={onBack}
      onComposeItem={onComposeItem}
      onOpenPost={onOpenPost}
      onRefresh={onRefresh}
    />
  );
}

function CapabilityHomepage({
  catalog,
  item,
  onBack,
  onComposeItem,
  onOpenPost,
  onRefresh
}: {
  catalog: PortalCatalog;
  item: MarketItem;
  onBack: () => void;
  onComposeItem: (item: MarketItem) => void;
  onOpenPost: (postId: string) => void;
  onRefresh: () => void;
}) {
  const { locale, t } = useI18n();
  const category = marketCategoryLabel(item.category, locale);
  const relatedDiscussions = useMemo(
    () => relatedMarketDiscussions(item, catalog.discussions).slice(0, 5),
    [catalog.discussions, item]
  );
  const versionRows = useMemo(() => marketVersionMetadataRows(item, t), [item, t]);
  const overviewHtml = useMemo(
    () => renderForumMarkdown(stripLeadingHeading(marketOverviewMarkdown(item, t, locale))),
    [item, locale, t]
  );
  const safetyHtml = useMemo(
    () => renderForumMarkdown(stripLeadingHeading(marketSafetyMarkdown(item, t))),
    [item, t]
  );
  const artifactHref = marketArtifactHref(item);
  const launchUrl = marketAppLaunchUrl(item);
  const accessibleAppTargetIds = useMemo(
    () => catalog.hubListings
      .filter((listing) => listing.type === "app")
      .map((listing) => listing.targetId),
    [catalog.hubListings]
  );
  const homePinContext = useMemo(
    () => ({ accessibleAppTargetIds, userId: catalog.currentUser.id }),
    [accessibleAppTargetIds, catalog.currentUser.id]
  );
  const [pinned, setPinned] = useState(() => isHomePinned(
    { id: item.targetId, kind: item.kind },
    homePinContext
  ));
  const [copied, setCopied] = useState(false);
  const [liking, setLiking] = useState(false);
  const [liked, setLiked] = useState(item.likedByCurrentUser);
  const [likeCount, setLikeCount] = useState(item.likeCount);

  useEffect(() => {
    setPinned(isHomePinned({ id: item.targetId, kind: item.kind }, homePinContext));
    setCopied(false);
    setLiked(item.likedByCurrentUser);
    setLikeCount(item.likeCount);
  }, [homePinContext, item.id, item.kind, item.likeCount, item.likedByCurrentUser, item.targetId]);

  async function handlePrimaryAction() {
    if (item.kind === "skill") {
      await Promise.all([
        copySkillInstallPrompt(item, t),
        recordPublicationInteraction({
          action: "skill.add_to_agent",
          listingId: item.listing?.id,
          source: "publication_detail",
          targetId: item.targetId,
          version: marketListingVersion(item) || undefined
        }).catch(() => undefined)
      ]);
      onRefresh();
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      return;
    }

    if (pinned) {
      removeHomePin({ id: item.targetId, kind: item.kind }, homePinContext);
      setPinned(false);
    } else {
      addHomePin({ id: item.targetId, kind: item.kind }, homePinContext);
      setPinned(true);
    }
  }

  async function handleLike() {
    if (liked || liking) {
      return;
    }

    setLiked(true);
    setLikeCount((current) => current + 1);
    setLiking(true);

    try {
      await recordPublicationInstall(item, "bookmark");
      onRefresh();
    } catch {
      setLiked(false);
      setLikeCount((current) => Math.max(item.likeCount, current - 1));
    } finally {
      setLiking(false);
    }
  }

  const primaryLabel = item.kind === "skill"
    ? copied ? t("market.agentPromptCopied") : t("market.addToAgent")
    : pinned ? t("market.removeFromHome") : t("market.addToHome");
  const PrimaryIcon = copied ? CheckCircle2 : item.kind === "skill" ? ShieldCheck : pinned ? X : Plus;

  return (
    <div className="portal-workspace-inner portal-object-workspace">
      <div className="portal-object-toolbar">
        <Button iconBefore={<ArrowLeft size={16} />} onClick={onBack} size="compact">
          {t("portal.skillsApps.back")}
        </Button>
        <span>{t(item.kind === "app" ? "portal.skillsApps.appCanonical" : "portal.skillsApps.skillCanonical")}</span>
      </div>

      <section className="portal-object-mast" aria-labelledby="portal-object-title">
        <header className="portal-object-identity">
          <PortalMarketObjectMark item={item} size="large" />
          <div className="portal-object-title-block">
            <p className="portal-kicker">{typeLabel(item.kind, t)} / {category}</p>
            <h1 id="portal-object-title">{item.name}</h1>
            <p className="portal-object-summary">{marketSummary(item)}</p>
          </div>
          <div className="portal-object-byline" aria-label={t("market.listingInfo")}>
            <PublicationAuthors className="portal-object-contributors" fallback={item.owner} listing={item.listing} />
            <span className="portal-object-updated">{t("common.updated")} {formatMarketUpdatedAt(item.updatedAt, locale)}</span>
          </div>
          {item.tags.length > 0 && (
            <div className="portal-object-tags" aria-label={t("portal.skillsApps.tags")}>
              {item.tags.slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}
            </div>
          )}
        </header>

        <aside className="portal-object-actions" aria-label={t("market.actions")}>
          <div>
            <p className="portal-panel-kicker">{t("portal.skillsApps.actionKicker")}</p>
            <h2>{t("portal.skillsApps.actionTitle")}</h2>
          </div>
          <div className="portal-object-action-stack">
            {item.kind === "app" && launchUrl && (
              <Button
                iconBefore={<ExternalLink size={16} />}
                onClick={() => void launchPortalApp({
                  id: item.app?.id ?? item.targetId,
                  launchUrl,
                  trackingSource: "publication_detail"
                })}
                variant="primary"
              >
                {t("market.openApp")}
              </Button>
            )}
            <Button
              iconBefore={<PrimaryIcon size={16} />}
              onClick={() => void handlePrimaryAction()}
              variant={item.kind === "skill" ? "primary" : "secondary"}
            >
              {primaryLabel}
            </Button>
            {item.kind === "skill" && (
              <ButtonLink
                disabled={!artifactHref}
                download
                href={artifactHref || "#"}
                iconBefore={<Download size={16} />}
                onClick={() => window.setTimeout(onRefresh, 500)}
              >
                {t("market.downloadZip")}
              </ButtonLink>
            )}
            <Button
              disabled={liked}
              iconBefore={<ThumbsUp size={16} />}
              isLoading={liking}
              onClick={() => void handleLike()}
            >
              {liked ? t("market.liked") : t("market.like")}
            </Button>
            <Button iconBefore={<MessageCircle size={16} />} onClick={() => onComposeItem(item)}>
              {t("market.quickQuestion")}
            </Button>
          </div>
          <div className="portal-object-metrics">
            {item.kind === "skill" ? (
              <>
                <span>
                  <ShieldCheck size={14} />
                  <strong>{formatCompactCount(item.agentAddCount, locale)}</strong>
                  {t("market.agentAdds")}
                </span>
                <span>
                  <Download size={14} />
                  <strong>{formatCompactCount(item.downloadCount, locale)}</strong>
                  {t("market.zipDownloads")}
                </span>
              </>
            ) : (
              <span>
                <ExternalLink size={14} />
                <strong>{formatCompactCount(item.visitCount, locale)}</strong>
                {t("common.visits")}
              </span>
            )}
            <span><ThumbsUp size={14} /> <strong>{formatCompactCount(likeCount, locale)}</strong> {t("market.praiseCountLabel")}</span>
          </div>
        </aside>
      </section>

      <div className="portal-object-layout">
        <main className="portal-object-publication">
          <section aria-labelledby="portal-object-overview">
            <header>
              <p className="portal-kicker">{t("portal.skillsApps.overviewKicker")}</p>
              <h2 id="portal-object-overview">{t("market.section.overview")}</h2>
            </header>
            <div className="portal-object-markdown" dangerouslySetInnerHTML={{ __html: overviewHtml }} />
          </section>
          <section aria-labelledby="portal-object-safety">
            <header>
              <p className="portal-kicker">{t("portal.skillsApps.safetyKicker")}</p>
              <h2 id="portal-object-safety">{t("market.safety.title")}</h2>
            </header>
            <div className="portal-object-markdown" dangerouslySetInnerHTML={{ __html: safetyHtml }} />
          </section>
          <section aria-labelledby="portal-object-discussions">
            <header className="portal-object-section-heading">
              <div>
                <p className="portal-kicker">{t("portal.skillsApps.discussionKicker")}</p>
                <h2 id="portal-object-discussions">{t("market.relatedDiscussions")}</h2>
              </div>
              <span>{t("portal.skillsApps.discussionCount", { count: relatedDiscussions.length })}</span>
            </header>
            {relatedDiscussions.length > 0 ? (
              <div className="portal-object-discussion-list">
                {relatedDiscussions.map((discussion) => (
                  <PortalDiscussionCard
                    catalog={catalog}
                    discussion={discussion}
                    key={discussion.id}
                    onOpen={() => onOpenPost(discussion.id)}
                    variant="compact"
                  />
                ))}
              </div>
            ) : (
              <div className="portal-object-discussion-empty">
                <MessageCircle aria-hidden="true" size={22} />
                <div>
                  <strong>{t("market.noRelatedDiscussions")}</strong>
                  <p>{t("market.noRelatedDiscussionsBody")}</p>
                </div>
              </div>
            )}
          </section>
        </main>

        <aside className="portal-object-metadata" aria-label={t("portal.skillsApps.metadata")}>
          <section>
            <strong>{t("portal.skillsApps.objectRecord")}</strong>
            <dl>
              <div><dt>{t("market.type")}</dt><dd>{typeLabel(item.kind, t)}</dd></div>
              <div><dt>{t("market.categoryFilter")}</dt><dd>{category}</dd></div>
              <div><dt>{t("portal.skillsApps.owner")}</dt><dd><PublicationAuthors fallback={item.owner} listing={item.listing} /></dd></div>
              <div><dt>{t("portal.skillsApps.status")}</dt><dd>{t("ui.status.listed")}</dd></div>
            </dl>
          </section>
          {(versionRows.length > 0 || item.app) && (
            <section>
              <strong>{t("market.versionHistory")}</strong>
              <dl>
                {versionRows.map((row) => (
                  <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>
                ))}
                {item.app && (
                  <div>
                    <dt>{t("apps.deployment")}</dt>
                    <dd>{item.app.deploymentProvider} / {item.app.deploymentMethod}</dd>
                  </div>
                )}
              </dl>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function stripLeadingHeading(markdown: string) {
  return markdown.replace(/^#\s+[^\n]+\n+/, "").trim();
}
