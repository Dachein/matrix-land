import { ArrowUpRight, LockKeyhole, SquareCheckBig } from "lucide-react";
import { useMemo, useState } from "react";
import {
  monthlyBudgetUsdForPortalJourneyLevel,
  portalJourneyBadgeImageUrl,
  portalJourneyLevelGlyphUrl,
  portalJourneyLevelImageUrl
} from "../../shared/journey";
import type { PortalCatalog, PortalJourney, PortalJourneyBadgeCategory, PortalJourneyBadgeDefinition } from "../../shared/types";
import { useI18n, type Locale, type TranslationKey } from "../i18n";

type Translate = ReturnType<typeof useI18n>["t"];

type JourneyShowcaseProps = {
  journey: PortalJourney;
  locale: Locale;
  currentUser?: PortalCatalog["currentUser"];
  variant?: "page" | "modal";
};

type JourneyActionTarget = {
  href: string;
  kind: "route" | "profile";
  labelKey: TranslationKey;
};

type BadgeFilter = "all" | PortalJourneyBadgeCategory;

const categoryOrder: PortalJourneyBadgeCategory[] = ["foundation", "community", "usage", "builder", "impact"];

const categoryLabelKeys: Record<PortalJourneyBadgeCategory, TranslationKey> = {
  foundation: "journey.category.foundation",
  community: "journey.category.community",
  usage: "journey.category.usage",
  builder: "journey.category.builder",
  impact: "journey.category.impact"
};

export function JourneyShowcase({ journey, locale, currentUser, variant = "modal" }: JourneyShowcaseProps) {
  const { t } = useI18n();
  const [activeCategory, setActiveCategory] = useState<BadgeFilter>("all");
  const earnedKeys = new Set(journey.badges.map((badge) => badge.badgeKey));
  const nextBadgeKeys = new Set(journey.nextBadges.map((badge) => badge.key));
  const nextLevel = journey.levels.find((level) => level.rank > journey.level.rank);
  const badgeFilters: BadgeFilter[] = ["all", ...categoryOrder];
  const filteredBadges = useMemo(() => {
    return journey.badgeDefinitions
      .filter((badge) => activeCategory === "all" || badge.category === activeCategory)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [activeCategory, journey.badgeDefinitions]);
  const recommendedActions = useMemo(() => {
    const earned = new Set(journey.badges.map((badge) => badge.badgeKey));
    const candidates = (journey.nextBadges.length > 0 ? journey.nextBadges : journey.badgeDefinitions.filter((badge) => !earned.has(badge.key)))
      .filter((badge) => !earned.has(badge.key));

    return shuffleBadges(candidates).slice(0, 3);
  }, [journey.badgeDefinitions, journey.badges, journey.nextBadges]);

  if (variant === "page") {
    return (
      <div className="journeyShowcase page compact">
        <section className="journeyCompactStatus" aria-label={t("journey.currentStatusAria")}>
          <div className="journeyHeroImage">
            <img alt="" src={portalJourneyLevelImageUrl(journey.level.key)} />
            <span className="journeyLevelGlyph"><img alt="" src={portalJourneyLevelGlyphUrl(journey.level.key)} /></span>
          </div>
          <div className="journeyHeroCopy">
            <span>{t("journey.currentLevel")}</span>
            <h2>{t("journey.levelTitle", { rank: journey.level.rank, name: localizedLevelName(journey.level, locale) })}</h2>
            <p>{localizedLevelDescription(journey.level, locale)}</p>
            <div className="journeyHeroStats">
              <strong>{journey.totalPoints}<small>{t("journey.points")}</small></strong>
              <strong title={communityContributionBreakdownTitle(journey, t)}>{journey.communityContributionPoints}<small>{t("journey.communityContribution")}</small></strong>
              <strong>{journey.badgeCount}<small>{t("journey.earned")}</small></strong>
            </div>
          </div>
        </section>

        <section className="journeyActionPanel" aria-label={t("journey.recommendedActionsAria")}>
          <div className="journeyActionHeader">
            <h3>{t("journey.nextActions")}</h3>
          </div>
          <div className="journeyActionList">
            {recommendedActions.length > 0 ? recommendedActions.map((badge) => {
              const target = badgeActionTarget(badge);
              const targetLabel = localizedActionTargetLabel(target, t);

              return (
                <a
                  aria-label={`${localizedBadgeName(badge, locale)} · ${targetLabel}`}
                  className="journeyActionItem"
                  href={target.href}
                  key={badge.key}
                  onClick={(event) => {
                    if (target.kind !== "profile") {
                      return;
                    }

                    event.preventDefault();
                    if (currentUser) {
                      window.dispatchEvent(new CustomEvent("workspace:open-profile", { detail: { ...currentUser, initialTab: "basic" } }));
                    }
                  }}
                  title={targetLabel}
                >
                  <img alt="" src={portalJourneyBadgeImageUrl(badge.key, "unearned")} />
                  <div>
                    <span>{localizedCategory(badge.category, t)}</span>
                    <strong>{localizedBadgeName(badge, locale)}</strong>
                    <p>{localizedBadgeDescription(badge, locale)}</p>
                  </div>
                  <span className="journeyActionCue" aria-hidden="true"><ArrowUpRight size={14} /></span>
                  <small>+{badge.points} {t("journey.points")}</small>
                </a>
              );
            }) : (
              <p className="journeyActionEmpty">{t("journey.allEarned")}</p>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="journeyShowcase modal v2">
      <section className="journeyHero journeyHeroV2">
        <article className="journeyCurrentLevel">
          <div className="journeyHeroImage journeyLevelArtwork">
            <img alt={localizedLevelName(journey.level, locale)} src={portalJourneyLevelImageUrl(journey.level.key)} />
            <span className="journeyLevelGlyph">
              <img alt="" src={portalJourneyLevelGlyphUrl(journey.level.key)} />
            </span>
          </div>
          <div className="journeyHeroCopy">
            <span>{t("journey.currentLevel")}</span>
            <h2>{t("journey.levelTitle", { rank: journey.level.rank, name: localizedLevelName(journey.level, locale) })}</h2>
            <p>{localizedLevelDescription(journey.level, locale)}</p>
            <div className="journeyHeroStats">
              <strong><b>{journey.totalPoints}</b><small>{t("journey.points")}</small></strong>
              <strong title={communityContributionBreakdownTitle(journey, t)}><b>{journey.communityContributionPoints}</b><small>{t("journey.communityContribution")}</small></strong>
              <strong><b>{journey.badgeCount}</b><small>{t("journey.earned")}</small></strong>
              <strong><b>{Math.max(0, journey.badgeDefinitions.length - journey.badgeCount)}</b><small>{t("journey.toEarn")}</small></strong>
            </div>
          </div>
        </article>
        <article className={`journeyNextLevel ${nextLevel ? "" : "complete"}`}>
          <span className="journeyNextLevelGlyph">
            <img alt="" src={portalJourneyLevelGlyphUrl(nextLevel?.key ?? journey.level.key)} />
          </span>
          <small>{nextLevel ? t("journey.nextStage") : t("journey.currentLevel")}</small>
          <strong>{nextLevel ? t("journey.levelTitle", { rank: nextLevel.rank, name: localizedLevelName(nextLevel, locale) }) : t("journey.topLevelReached")}</strong>
          <p>{nextLevel ? localizedLevelDescription(nextLevel, locale) : t("journey.topLevelDescription")}</p>
        </article>
      </section>

      <section className="journeyLevelRail" aria-label={t("journey.currentStatusAria")}>
        {journey.levels.map((level) => {
          const levelState = level.rank < journey.level.rank ? "complete" : level.rank === journey.level.rank ? "current" : "upcoming";

          return (
            <article aria-current={levelState === "current" ? "step" : undefined} className={`journeyLevelStep ${levelState}`} key={level.key}>
              <div className="journeyLevelStepHead">
                <span className="journeyLevelStepGlyph"><img alt="" src={portalJourneyLevelGlyphUrl(level.key)} /></span>
                <small>L{level.rank}</small>
              </div>
              <div className="journeyLevelStepCopy">
                <strong lang={isZhLocale(locale) ? "zh-CN" : "en"}>{localizedLevelName(level, locale)}</strong>
                <span className="journeyLevelTokenBudget">
                  {t("journey.usdTokenLevel", { amount: `$${monthlyBudgetUsdForPortalJourneyLevel(level.key)}` })}
                </span>
                <p lang={isZhLocale(locale) ? "zh-CN" : "en"}>{localizedLevelDescription(level, locale)}</p>
              </div>
            </article>
          );
        })}
      </section>

      <section className="journeyBadgeCatalog">
        <div className="journeyBadgeCatalogHeader">
          <div className="journeySectionHeader">
            <span>{t("journey.badgesEyebrow")}</span>
            <h3>{t("journey.badgesTitle")}</h3>
          </div>
          <div className="journeyBadgeSummary">
            <strong>{journey.badgeCount}<small>{t("journey.earned")}</small></strong>
            <strong>{Math.max(0, journey.badgeDefinitions.length - journey.badgeCount)}<small>{t("journey.toEarn")}</small></strong>
          </div>
        </div>

        <div className="journeyBadgeFilters" aria-label={t("journey.badgeFilterAria")}>
          {badgeFilters.map((filter) => (
            <button className={activeCategory === filter ? "active" : ""} key={filter} onClick={() => setActiveCategory(filter)} type="button">
              <span>{localizedFilter(filter, t)}</span>
              <em>{badgeFilterCount(filter, journey)}</em>
            </button>
          ))}
        </div>

        <div className="journeyBadgeList journeyBadgeGrid" aria-label={t("journey.badgeListAria")}>
          {filteredBadges.map((badge) => {
            const isEarned = earnedKeys.has(badge.key);
            const isNext = nextBadgeKeys.has(badge.key);
            const state = isEarned ? "earned" : isNext ? "next" : "locked";
            const visualState = isEarned ? "earned" : "unearned";

            return (
              <article className={`journeyBadgeRow journeyBadgeCard ${state}`} key={badge.key}>
                <span
                  aria-label={badgeStatusLabel(isEarned, isNext, t)}
                  className="journeyBadgeVisualState"
                  role="img"
                  title={badgeStatusLabel(isEarned, isNext, t)}
                >
                  {isEarned ? <SquareCheckBig size={17} /> : isNext ? <ArrowUpRight size={17} /> : <LockKeyhole size={16} />}
                </span>
                <div className="journeyBadgeThumb">
                  <img alt={localizedBadgeName(badge, locale)} src={portalJourneyBadgeImageUrl(badge.key, visualState)} />
                </div>
                <div className="journeyBadgeRowText">
                  <span className="journeyBadgeCategory">{localizedCategory(badge.category, t)}</span>
                  <strong>{localizedBadgeName(badge, locale)}</strong>
                  <p>{localizedBadgeDescription(badge, locale)}</p>
                </div>
                <div className="journeyBadgeRowMeta">
                  <span className="journeyBadgePoints">+{badge.points} {t("journey.points")}</span>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function communityContributionBreakdownTitle(journey: PortalJourney, t: Translate) {
  return t("journey.communityContributionBreakdown", {
    replies: journey.communityContributionBreakdown.replyPoints,
    tags: journey.communityContributionBreakdown.contributionTagPoints,
    topics: journey.communityContributionBreakdown.topicPoints
  });
}

function localizedFilter(filter: BadgeFilter, t: Translate) {
  if (filter === "all") {
    return t("journey.filter.all");
  }

  return localizedCategory(filter, t);
}

function badgeFilterCount(filter: BadgeFilter, journey: PortalJourney) {
  if (filter === "all") {
    return journey.badgeDefinitions.length;
  }

  return journey.badgeDefinitions.filter((badge) => badge.category === filter).length;
}

function localizedCategory(category: PortalJourneyBadgeCategory, t: Translate) {
  return t(categoryLabelKeys[category]);
}

function localizedLevelName(level: PortalJourney["levels"][number], locale: Locale) {
  return isZhLocale(locale) ? level.nameZh : level.nameEn;
}

function localizedLevelDescription(level: PortalJourney["levels"][number], locale: Locale) {
  return isZhLocale(locale) ? level.descriptionZh : level.descriptionEn;
}

function localizedBadgeName(badge: Pick<PortalJourneyBadgeDefinition, "nameEn" | "nameZh">, locale: Locale) {
  return isZhLocale(locale) ? badge.nameZh : badge.nameEn;
}

function localizedBadgeDescription(badge: Pick<PortalJourneyBadgeDefinition, "descriptionEn" | "descriptionZh">, locale: Locale) {
  return isZhLocale(locale) ? badge.descriptionZh : badge.descriptionEn;
}

function badgeStatusLabel(isEarned: boolean, isNext: boolean, t: Translate) {
  if (isEarned) {
    return t("journey.status.earned");
  }

  if (isNext) {
    return t("journey.status.available");
  }

  return t("journey.status.locked");
}

function badgeActionTarget(badge: PortalJourneyBadgeDefinition): JourneyActionTarget {
  if (badge.triggerType === "profile") {
    return { href: "#/home", kind: "profile", labelKey: "journey.action.editProfile" };
  }

  if (badge.triggerType === "gateway") {
    return { href: "#/studio", kind: "route", labelKey: "journey.action.openMyToken" };
  }

  if (badge.triggerType === "forum") {
    return { href: "#/community", kind: "route", labelKey: "journey.action.openCommunity" };
  }

  if (badge.triggerType === "market") {
    return { href: "#/market", kind: "route", labelKey: "journey.action.openSkillHub" };
  }

  if (badge.triggerType === "apps") {
    return { href: "#/apps", kind: "route", labelKey: "journey.action.openMyApps" };
  }

  if (badge.key === "mcp_connected") {
    return { href: "#/apps", kind: "route", labelKey: "journey.action.openMyApps" };
  }

  if (badge.key === "first_app_launch" || badge.key === "workflow_explorer") {
    return { href: "#/market", kind: "route", labelKey: "journey.action.openSkillHub" };
  }

  return { href: "#/community", kind: "route", labelKey: "journey.action.openCommunity" };
}

function localizedActionTargetLabel(target: JourneyActionTarget, t: Translate) {
  return t(target.labelKey);
}

function isZhLocale(locale: Locale) {
  return locale === "zh-CN";
}

function shuffleBadges(badges: PortalJourneyBadgeDefinition[]) {
  return [...badges].sort(() => Math.random() - 0.5);
}
