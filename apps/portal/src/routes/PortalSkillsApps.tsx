import { EmptyState } from "../../../../src/portal/components/EmptyState";
import { SearchField } from "../../../../src/portal/components/SearchField";
import { PageHeading } from "../../../../src/portal/components/PageHeading";
import {
  ChevronRight,
  Download,
  ExternalLink,
  Grid2X2,
  List,
  MessageCircle,
  Plus,
  RotateCcw,
  Search,
  Tags,
  ThumbsUp
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { WorkspaceListbox } from "../../../../src/portal/components/WorkspaceListbox";
import { PublicationAuthors } from "../../../../src/portal/components/PublicationAuthors";
import { SegmentedControl } from "../../../../src/portal/components/SegmentedControl";
import { useI18n } from "../../../../src/portal/i18n";
import { formatCompactCount, formatMarketUpdatedAt } from "../../../../src/portal/market/formatters";
import {
  buildMarketItems,
  countMarketItems,
  marketPrimaryMetricCount,
  marketSummary,
  typeLabel,
  visibleMarketItems
} from "../../../../src/portal/market/models";
import type { MarketCategoryFilter, MarketFilter, MarketItem, MarketView } from "../../../../src/portal/market/types";
import {
  MARKET_CATEGORIES,
  marketCategoryLabel,
  normalizeMarketCategoryKey
} from "../../../../src/shared/marketCategories";
import type { PortalCatalog } from "../../../../src/shared/types";
import { PortalMarketObjectMark } from "../components/PortalMarketObjectMark";
import "../styles/skills-apps.css";

export function PortalSkillsApps({
  catalog,
  onCreateAndShare,
  onOpenItem
}: {
  catalog: PortalCatalog;
  onCreateAndShare: () => void;
  onOpenItem: (item: MarketItem) => void;
}) {
  const { locale, t } = useI18n();
  const [filter, setFilter] = useState<MarketFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<MarketCategoryFilter>("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<MarketView>("card");
  const items = useMemo(() => buildMarketItems(catalog), [catalog]);
  const counts = useMemo(() => countMarketItems(items), [items]);
  const visibleItems = useMemo(
    () => visibleMarketItems(items, filter, categoryFilter, query),
    [categoryFilter, filter, items, query]
  );
  const categoryCounts = useMemo(() => {
    const nextCounts = new Map(MARKET_CATEGORIES.map((category) => [category.key, 0]));

    items.forEach((item) => {
      if (item.status !== "listed" || (filter !== "all" && item.kind !== filter)) {
        return;
      }

      const category = normalizeMarketCategoryKey(item.category);
      nextCounts.set(category, (nextCounts.get(category) ?? 0) + 1);
    });

    return nextCounts;
  }, [filter, items]);
  const categoryOptions = useMemo(
    () => [
      {
        label: t("portal.skillsApps.allCategories"),
        meta: counts[filter],
        value: "all" as MarketCategoryFilter
      },
      ...MARKET_CATEGORIES.map((category) => {
        const count = categoryCounts.get(category.key) ?? 0;

        return {
          disabled: count === 0,
          label: marketCategoryLabel(category.key, locale),
          meta: count,
          searchText: `${category.key} ${marketCategoryLabel(category.key, "zh")} ${marketCategoryLabel(category.key, "en")}`,
          value: category.key as MarketCategoryFilter
        };
      })
    ],
    [categoryCounts, counts, filter, locale, t]
  );
  const hasFilters = filter !== "all" || categoryFilter !== "all" || query.trim().length > 0;

  function resetFilters() {
    setFilter("all");
    setCategoryFilter("all");
    setQuery("");
  }

  function updateTypeFilter(nextFilter: MarketFilter) {
    setFilter(nextFilter);

    if (categoryFilter === "all") {
      return;
    }

    const categoryStillAvailable = items.some((item) => (
      item.status === "listed" &&
      (nextFilter === "all" || item.kind === nextFilter) &&
      normalizeMarketCategoryKey(item.category) === categoryFilter
    ));

    if (!categoryStillAvailable) {
      setCategoryFilter("all");
    }
  }

  return (
    <div className="portal-workspace-inner portal-market-workspace">
      <section className="portal-page portal-market-page" aria-labelledby="portal-market-title">
        <PageHeading
          id="portal-market-title"
          className="portal-editorial-heading portal-market-heading"
          title={t("portal.skillsApps.title")}
          eyebrow={<><div className="portal-editorial-kicker">
              <span aria-hidden="true" className="portal-editorial-mark"><i /></span>
              <span>{t("portal.skillsApps.kicker")}</span>
            </div></>}
          actions={<><dl className="portal-market-counts" aria-label={t("portal.skillsApps.inventoryAria")}>
            <div>
              <dt>{t("market.apps")}</dt>
              <dd>{String(counts.app).padStart(2, "0")}</dd>
            </div>
            <div>
              <dt>{t("market.skills")}</dt>
              <dd>{String(counts.skill).padStart(2, "0")}</dd>
            </div>
          </dl></>}
        ><blockquote className="portal-editorial-quote">
              <p>{t("portal.skillsApps.editorialQuote")}</p>
              <cite>{t("portal.skillsApps.editorialSource")}</cite>
            </blockquote></PageHeading>

        <div className="portal-market-toolbar">
          <SegmentedControl
            ariaLabel={t("market.typeFilter")}
            className="portal-market-segments"
            onChange={updateTypeFilter}
            options={[
              { label: t("market.all"), value: "all" },
              { label: t("market.apps"), value: "app" },
              { label: t("market.skills"), value: "skill" }
            ]}
            value={filter}
          />
          <div className="portal-market-query-controls">
            <SearchField
              className="portal-market-search"
              label={t("portal.skillsApps.searchLabel")}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("portal.skillsApps.searchPlaceholder")}
              value={query}
            />
            <WorkspaceListbox<MarketCategoryFilter>
              ariaLabel={t("market.categoryFilter")}
              className="portal-market-category"
              iconBefore={<Tags size={14} />}
              noResultsLabel={t("common.noResults")}
              onChange={setCategoryFilter}
              options={categoryOptions}
              value={categoryFilter}
              variant="filter"
            />
            <SegmentedControl<MarketView>
              ariaLabel={t("portal.skillsApps.viewModeAria")}
              className="portal-market-view-toggle"
              compact
              onChange={setView}
              options={[
                {
                  ariaLabel: t("portal.skillsApps.cardView"),
                  icon: <Grid2X2 size={15} />,
                  label: t("portal.skillsApps.cards"),
                  value: "card"
                },
                {
                  ariaLabel: t("portal.skillsApps.listView"),
                  icon: <List size={15} />,
                  label: t("portal.skillsApps.list"),
                  value: "list"
                }
              ]}
              value={view}
            />
          </div>
        </div>

        <div className="portal-market-result-line">
          <strong>{t("portal.skillsApps.available")}</strong>
          <span>{t("portal.skillsApps.resultCount", { count: visibleItems.length })}</span>
        </div>

        {view === "card" ? (
          <section className="portal-market-grid" aria-label={t("market.results")}>
            <MarketCreateCard onCreate={onCreateAndShare} />
            {visibleItems.map((item) => (
              <MarketCard item={item} key={item.id} onOpen={() => onOpenItem(item)} />
            ))}
            {visibleItems.length === 0 && (
              <MarketEmptyState hasFilters={hasFilters} onReset={resetFilters} />
            )}
          </section>
        ) : visibleItems.length > 0 ? (
          <section className="portal-market-ledger" aria-label={t("market.results")}>
            <div className="portal-market-ledger-header" aria-hidden="true">
              <span>{t("portal.skillsApps.object")}</span>
              <span>{t("portal.skillsApps.activity")}</span>
              <span>{t("portal.skillsApps.open")}</span>
            </div>
            {visibleItems.map((item) => (
              <MarketLedgerRow item={item} key={item.id} onOpen={() => onOpenItem(item)} />
            ))}
          </section>
        ) : (
          <MarketEmptyState hasFilters={hasFilters} onReset={resetFilters} />
        )}
      </section>
    </div>
  );
}

function MarketCreateCard({ onCreate }: { onCreate: () => void }) {
  const { t } = useI18n();

  return (
    <button
      aria-label={t("portal.skillsApps.createShareAria")}
      className="portal-market-create-card"
      onClick={onCreate}
      type="button"
    >
      <span className="portal-market-create-icon" aria-hidden="true"><Plus size={25} /></span>
      <span className="portal-market-create-copy">
        <span>{t("portal.skillsApps.createShare")}</span>
        <strong>{t("portal.skillsApps.createShareObject")}</strong>
      </span>
      <ChevronRight aria-hidden="true" className="portal-market-create-arrow" size={20} />
    </button>
  );
}

function MarketCard({ item, onOpen }: { item: MarketItem; onOpen: () => void }) {
  const { locale, t } = useI18n();
  const category = marketCategoryLabel(item.category, locale);

  return (
    <article className="portal-market-card">
      <button
        aria-label={t("portal.skillsApps.openItem", { name: item.name, type: typeLabel(item.kind, t) })}
        className="portal-market-card-hit-area"
        onClick={onOpen}
        type="button"
      />
      <PortalMarketObjectMark item={item} size="card" />
      <span className="portal-market-card-panel">
        <span className="portal-market-card-copy">
          <span className="portal-market-row-meta">
            <strong>{typeLabel(item.kind, t)}</strong>
            <span aria-hidden="true">/</span>
            <span>{category}</span>
            <span aria-hidden="true">/</span>
            <span>{formatMarketUpdatedAt(item.updatedAt, locale)}</span>
          </span>
          <strong className="portal-market-card-title">{item.name}</strong>
          <span className="portal-market-card-details">
            <span className="portal-market-card-summary">{marketSummary(item)}</span>
            <span className="portal-market-card-owner">
              <span className="portal-market-author-prefix">{t("portal.skillsApps.publishedBy")}</span>
              <PublicationAuthors compact fallback={item.owner} listing={item.listing} />
            </span>
          </span>
        </span>
        <span className="portal-market-card-footer">
          <span className="portal-market-card-stats" aria-label={t("portal.skillsApps.activity")}>
            <span title={t(item.kind === "app" ? "common.visits" : "common.uses")}>
              {item.kind === "app" ? <ExternalLink size={14} /> : <Download size={14} />}
              {formatCompactCount(marketPrimaryMetricCount(item), locale)}
            </span>
            <span title={t("market.praiseCountLabel")}><ThumbsUp size={14} /> {formatCompactCount(item.likeCount, locale)}</span>
            <span title={t("market.relatedDiscussions")}><MessageCircle size={14} /> {formatCompactCount(item.comments, locale)}</span>
          </span>
          <ChevronRight aria-hidden="true" size={18} />
        </span>
      </span>
    </article>
  );
}

function MarketEmptyState({ hasFilters, onReset }: { hasFilters: boolean; onReset: () => void }) {
  const { t } = useI18n();

  return (
    <EmptyState
      className="portal-market-empty"
      icon={<Search aria-hidden="true" size={26} />}
      title={t(hasFilters ? "market.emptyFilteredTitle" : "market.emptyAllTitle")}
      description={t(hasFilters ? "market.emptyFilteredBody" : "market.emptyAllBody")}
      actions={hasFilters && <Button iconBefore={<RotateCcw size={15} />} onClick={onReset}>{t("market.emptyReset")}</Button>}
    />
  );
}

function MarketLedgerRow({ item, onOpen }: { item: MarketItem; onOpen: () => void }) {
  const { locale, t } = useI18n();
  const category = marketCategoryLabel(item.category, locale);

  return (
    <article className="portal-market-row">
      <button
        aria-label={t("portal.skillsApps.openItem", { name: item.name, type: typeLabel(item.kind, t) })}
        className="portal-market-row-hit-area"
        onClick={onOpen}
        type="button"
      />
      <PortalMarketObjectMark item={item} />
      <span className="portal-market-row-copy">
        <span className="portal-market-row-meta">
          <strong>{typeLabel(item.kind, t)}</strong>
          <span aria-hidden="true">/</span>
          <span>{category}</span>
          <span aria-hidden="true">/</span>
          <span>{formatMarketUpdatedAt(item.updatedAt, locale)}</span>
        </span>
        <strong className="portal-market-row-title">{item.name}</strong>
        <span className="portal-market-row-summary">{marketSummary(item)}</span>
        <span className="portal-market-row-owner">
          <span className="portal-market-author-prefix">{t("portal.skillsApps.publishedBy")}</span>
          <PublicationAuthors compact fallback={item.owner} listing={item.listing} />
        </span>
      </span>
      <span className="portal-market-row-stats" aria-label={t("portal.skillsApps.activity")}>
        <span title={t(item.kind === "app" ? "common.visits" : "common.uses")}>
          {item.kind === "app" ? <ExternalLink size={14} /> : <Download size={14} />}
          {formatCompactCount(marketPrimaryMetricCount(item), locale)}
        </span>
        <span title={t("market.praiseCountLabel")}><ThumbsUp size={14} /> {formatCompactCount(item.likeCount, locale)}</span>
        <span title={t("market.relatedDiscussions")}><MessageCircle size={14} /> {formatCompactCount(item.comments, locale)}</span>
      </span>
      <span className="portal-market-row-open" aria-hidden="true"><ChevronRight size={18} /></span>
    </article>
  );
}
