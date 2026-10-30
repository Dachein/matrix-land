import { BookOpen, Boxes, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AppsApp, AppsSkill, PortalCatalog } from "../../../shared/types";
import { RelativeTime, SectionHeader } from "../../components/ui";
import { useAccessTargetUsers } from "../../hooks/useAccessTargetUsers";
import { useI18n } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import { appsAppStatusLabel, appsMarketStatusLabel, appsSkillStatusLabel, appsVisibilityLabel } from "../labels";
import {
  buildAppsProductItems,
  filterAppsProductItems,
  appsProductAuthors,
  appsPublicationByTarget,
  updateAppsProductWithApp,
  updateAppsProductWithSkill
} from "../productModels";
import type {
  AppsAppInfoInput,
  AppsKindFilter,
  AppsProductItem,
  AppsSkillInfoInput,
  AppsStatusFilter
} from "../types";
import { AppsAuthorAvatarGroup } from "./AppsAuthorAvatarGroup";

export type AppsProductDetailRenderProps = {
  onAppDelete: (app: AppsApp, listing: AppsProductItem["marketListing"] | undefined, confirmation: string) => Promise<void>;
  onAppRefresh: (app: AppsApp) => Promise<AppsApp | undefined>;
  onAppUpdate: (app: AppsApp, input: AppsAppInfoInput) => Promise<AppsApp | undefined>;
  onClose: () => void;
  onSkillDelete: (skill: AppsSkill, listing: AppsProductItem["marketListing"] | undefined, confirmation: string) => Promise<void>;
  onSkillUpdate: (skill: AppsSkill, input: AppsSkillInfoInput) => Promise<AppsSkill | undefined>;
  product: AppsProductItem;
};

export function AppsProductList({
  apps,
  catalog,
  kindFilter,
  mcpAction,
  onAppDelete,
  onAppUpdate,
  onAppRefresh,
  onSkillDelete,
  onSkillUpdate,
  query,
  renderDetailModal,
  skills,
  statusFilter
}: {
  apps: AppsApp[];
  catalog: PortalCatalog;
  kindFilter: AppsKindFilter;
  mcpAction: ReactNode;
  onAppDelete: (app: AppsApp, listing: AppsProductItem["marketListing"] | undefined, confirmation: string) => Promise<void>;
  onAppUpdate: (app: AppsApp, input: AppsAppInfoInput) => Promise<AppsApp | undefined>;
  onAppRefresh: (app: AppsApp) => Promise<AppsApp | undefined>;
  onSkillDelete: (skill: AppsSkill, listing: AppsProductItem["marketListing"] | undefined, confirmation: string) => Promise<void>;
  onSkillUpdate: (skill: AppsSkill, input: AppsSkillInfoInput) => Promise<AppsSkill | undefined>;
  query: string;
  renderDetailModal: (props: AppsProductDetailRenderProps) => ReactNode;
  skills: AppsSkill[];
  statusFilter: AppsStatusFilter;
}) {
  const { t } = useI18n();
  const { users: authorDirectoryUsers } = useAccessTargetUsers(catalog, apps.length + skills.length > 0);
  const [selectedProduct, setSelectedProduct] = useState<AppsProductItem | undefined>();
  const accessibleTargetIds = useMemo(() => new Set([
    ...apps.map((app) => app.id),
    ...skills.map((skill) => skill.id)
  ]), [apps, skills]);
  const marketByTarget = useMemo(
    () => appsPublicationByTarget(catalog.publicationListings, accessibleTargetIds),
    [accessibleTargetIds, catalog.publicationListings]
  );
  const products = useMemo(() => buildAppsProductItems({
    apps,
    marketByTarget,
    skills
  }).map((product) => ({
    ...product,
    authors: appsProductAuthors(product, catalog.currentUser, authorDirectoryUsers)
  })), [apps, authorDirectoryUsers, catalog.currentUser, marketByTarget, skills]);
  const visibleProducts = useMemo(
    () => filterAppsProductItems(products, { kindFilter, query, statusFilter }),
    [kindFilter, products, query, statusFilter]
  );

  useEffect(() => {
    setSelectedProduct((current) => current ? products.find((product) => product.id === current.id) : current);
  }, [products]);

  async function deleteSelectedApp(app: AppsApp, listing: AppsProductItem["marketListing"] | undefined, confirmation: string) {
    await onAppDelete(app, listing, confirmation);
    setSelectedProduct(undefined);
  }

  async function updateSelectedApp(app: AppsApp, input: AppsAppInfoInput) {
    const updated = await onAppUpdate(app, input);
    if (!updated) {
      return undefined;
    }

    setSelectedProduct((current) => {
      if (!current) {
        return current;
      }
      const nextProduct = updateAppsProductWithApp(current, updated, marketByTarget);
      return { ...nextProduct, authors: appsProductAuthors(nextProduct, catalog.currentUser, authorDirectoryUsers) };
    });
    return updated;
  }

  async function refreshSelectedApp(app: AppsApp) {
    const updated = await onAppRefresh(app);
    if (!updated) {
      return undefined;
    }

    setSelectedProduct((current) => {
      if (!current) {
        return current;
      }
      const nextProduct = updateAppsProductWithApp(current, updated, marketByTarget);
      return { ...nextProduct, authors: appsProductAuthors(nextProduct, catalog.currentUser, authorDirectoryUsers) };
    });
    return updated;
  }

  async function updateSelectedSkill(skill: AppsSkill, input: AppsSkillInfoInput) {
    const updated = await onSkillUpdate(skill, input);
    if (!updated) {
      return undefined;
    }

    setSelectedProduct((current) => {
      if (!current) {
        return current;
      }
      const nextProduct = updateAppsProductWithSkill(current, updated, marketByTarget);
      return { ...nextProduct, authors: appsProductAuthors(nextProduct, catalog.currentUser, authorDirectoryUsers) };
    });
    return updated;
  }

  async function deleteSelectedSkill(skill: AppsSkill, listing: AppsProductItem["marketListing"] | undefined, confirmation: string) {
    await onSkillDelete(skill, listing, confirmation);
    setSelectedProduct(undefined);
  }

  return (
    <section className="panel appsProductPanel">
      <SectionHeader action={mcpAction} eyebrow={t("apps.list.eyebrow")} title={t("apps.list.title")} />
      <div className="appsProductList">
        {visibleProducts.map((product) => (
          <article
            className="appsProductRow clickable"
            key={product.id}
            onClick={() => setSelectedProduct(product)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setSelectedProduct(product);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <AppsProductCoverIcon product={product} />
            <div className="appsProductMain">
              <div>
                <strong>{product.name}</strong>
                <span className="appsProductKind">{product.kind}</span>
                <AppsAuthorAvatarGroup authors={product.authors ?? []} compact />
              </div>
              <p>{product.subtitle}</p>
            </div>
            <div className="appsProductStatus">
              <span className={`statusBadge ${product.status}`}>{appsProductStatusLabel(product, t)}</span>
              {product.marketListing && <span className="appsMarketMini">{product.marketListing.status === "listed" ? t("apps.marketMini.listed") : t("apps.marketMini.review")}</span>}
              <small><RelativeTime value={product.updatedAt} fallback={product.updatedAt} /></small>
            </div>
            <ChevronRight className="appsProductChevron" size={18} />
          </article>
        ))}
        {visibleProducts.length === 0 && <div className="emptyState">{t("apps.list.empty")}</div>}
      </div>

      {selectedProduct && renderDetailModal({
        onAppDelete: deleteSelectedApp,
        onAppRefresh: refreshSelectedApp,
        onAppUpdate: updateSelectedApp,
        onClose: () => setSelectedProduct(undefined),
        onSkillDelete: deleteSelectedSkill,
        onSkillUpdate: updateSelectedSkill,
        product: selectedProduct
      })}
    </section>
  );
}

function appsProductIcon(type: AppsProductItem["type"]) {
  return type === "app" ? <Boxes size={16} /> : <BookOpen size={16} />;
}

function AppsProductCoverIcon({ product }: { product: AppsProductItem }) {
  const coverImageUrl = product.coverImageUrl?.trim();
  const [imageFailed, setImageFailed] = useState(false);
  const hasImage = Boolean(coverImageUrl && !imageFailed);

  useEffect(() => {
    setImageFailed(false);
  }, [coverImageUrl]);

  return (
    <span className={`appsProductIcon ${product.type}${hasImage ? " uploaded" : ""}`}>
      {hasImage ? <img alt="" onError={() => setImageFailed(true)} src={coverImageUrl} /> : appsProductIcon(product.type)}
    </span>
  );
}

type AppsProductStatusTranslator = (key: TranslationKey, values?: Record<string, number | string | undefined>) => string;

function appsProductStatusLabel(product: AppsProductItem, t: AppsProductStatusTranslator) {
  if (product.app) {
    return appsAppStatusLabel(product.app.status, t);
  }

  if (product.appsSkill) {
    return product.appsSkill.status === "archived"
      ? appsSkillStatusLabel(product.appsSkill.status, t)
      : appsVisibilityLabel(product.appsSkill.visibility, t);
  }

  return appsMarketStatusLabel(product.marketListing?.status ?? product.status, t);
}
