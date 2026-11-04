import { SearchField } from "../../../../src/portal/components/SearchField";
import { PageHeading } from "../../../../src/portal/components/PageHeading";
import { FeedbackNotice } from "../../../../src/portal/components/FeedbackNotice";
import { AppsOwnershipAdmin } from '../../../../src/portal/studio/components/AppsOwnership';
import { Boxes, CheckCircle2, Clock3, Download, ExternalLink, Search, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { appReviewDraftFromAsset, assetSummary, buildManagedAssets } from "../../../../src/portal/admin/assets/assetReviewModels";
import type { AssetRiskLevel, ManagedAsset, ManagedAssetType } from "../../../../src/portal/admin/assets/types";
import type { Translate } from "../../../../src/portal/admin/types";
import { Button } from "../../../../src/portal/components/Button";
import { WorkspaceListbox } from "../../../../src/portal/components/WorkspaceListbox";
import { FormField, TextArea, TextInput } from "../../../../src/portal/components/FormField";
import { PublicationAuthors } from "../../../../src/portal/components/PublicationAuthors";
import { ModalShell } from "../../../../src/portal/components/ModalShell";
import { SquareCoverImageField } from "../../../../src/portal/components/SquareCoverImageField";
import { useI18n } from "../../../../src/portal/i18n";
import { publicationOwnerNames } from "../../../../src/portal/market/ownerDisplay";
import { MARKET_CATEGORIES, marketCategoryOptionLabel, normalizeMarketCategoryName } from "../../../../src/shared/marketCategories";
import { homeAppPresentation, isPublicHomeApp } from "../../../../src/shared/homeApplications";
import type { AssetLifecycleStatus, HomeAppDisplay, PublicationVisibility, PortalCatalog } from "../../../../src/shared/types";
import { publicationReviewPublicationState } from "../lib/marketRouteModels";
import "../styles/admin.css";
import "../styles/admin-operations.css";

export function PortalHubReview({ catalog, onRefresh, unavailable = false }: { catalog: PortalCatalog; onRefresh: () => Promise<void> | void; unavailable?: boolean }) {
  const { t } = useI18n();
  const translate = t as Translate;
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | ManagedAssetType>("all");
  const [status, setStatus] = useState<"all" | AssetLifecycleStatus>("all");
  const [selected, setSelected] = useState<ManagedAsset>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const assets = useMemo(() => buildManagedAssets(catalog, translate).filter((asset) => asset.type === "app" || asset.type === "skill"), [catalog, translate]);
  const summary = useMemo(() => assetSummary(assets), [assets]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return assets.filter((asset) => (type === "all" || asset.type === type) && (status === "all" || asset.status === status) && (!needle || [
      asset.name,
      asset.owner,
      ...(asset.listing ? publicationOwnerNames(asset.listing) : []),
      asset.category,
      asset.description,
      asset.status,
      asset.risk
    ].join(" ").toLowerCase().includes(needle)));
  }, [assets, query, status, type]);

  if (catalog.currentUser.role !== "admin") return <HubDenied />;
  if (unavailable) return <div className="portal-workspace-inner portal-admin-workspace"><AppsOwnershipAdmin catalog={catalog} /><section className="portal-admin-state error" role="alert"><ShieldAlert size={22} /><div><h1>{t("portal.hubReview.loadErrorTitle")}</h1><p>{t("portal.hubReview.loadErrorBody")}</p><Button onClick={onRefresh}>{t("portal.data.retry")}</Button></div></section></div>;

  async function saveReview(asset: ManagedAsset, draft: ReviewDraft) {
    setError("");
    setNotice("");
    const url = asset.listing ? `/api/listings/${encodeURIComponent(asset.listing.id)}/status` : `/api/assets/${asset.type}/${encodeURIComponent(asset.id)}/status`;
    const appReview = asset.type === "app" ? appReviewDraftFromAsset(asset) : undefined;
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...draft,
        tags: parseReviewTags(draft.tags),
        app: appReview ? {
          ...appReview,
          category: draft.category,
          coverImageUrl: draft.coverImageUrl,
          description: draft.description,
          descriptionZh: draft.description,
          nameZh: draft.name,
          screenshots: draft.coverImageUrl ? [draft.coverImageUrl] : [],
          subtitle: draft.summary
        } : undefined
      })
    }).catch(() => { throw new Error(t("admin.assets.reviewNetworkError")); });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const errorCode = typeof payload.error === "string" ? payload.error : "";
      throw new Error(errorCode === "missing_valid_cover_image" ? t("admin.assets.coverRequiredError") : errorCode || t("admin.assets.statusUpdateFailed"));
    }

    const publication = publicationReviewPublicationState(payload);
    if (publication?.status === "pending" || publication?.status === "failed") {
      try {
        await onRefresh();
      } catch {
        // Keep the actionable Auth synchronization result visible even if catalog refresh also fails.
      }
      throw new Error(publication.status === "pending"
        ? t("admin.assets.authPublicationPending")
        : t("admin.assets.authPublicationFailed", { requestId: publication.requestId || "-" }));
    }
    setSelected(undefined);
    setNotice(t("admin.assets.statusUpdated"));
    try {
      await onRefresh();
    } catch {
      setError(t("admin.assets.reviewRefreshFailed"));
    }
  }

  return (
    <div className="portal-workspace-inner portal-admin-workspace">
      <section className="portal-page portal-admin-operations-page" aria-labelledby="portal-hub-review-title">
        <PageHeading
          id="portal-hub-review-title"
          className="portal-admin-heading"
          title={t("portal.hubReview.title")}
          actions={<><div className="portal-admin-source"><span><ShieldCheck size={15} /> {t("portal.hubReview.source")}</span></div></>}
        ><p>{t("portal.hubReview.subtitle")}</p></PageHeading>
        <p className="portal-admin-scope">{t("portal.admin.scopeGlobal")}</p>
        <AppsOwnershipAdmin catalog={catalog} />
        <section className="portal-admin-metrics">
          <AdminMetric icon={<Boxes size={16} />} label={t("admin.assets.totalLabel")} value={String(summary.total)} />
          <AdminMetric icon={<Clock3 size={16} />} label={t("admin.assets.pendingLabel")} value={String(summary.pending)} />
          <AdminMetric icon={<CheckCircle2 size={16} />} label={t("admin.assets.listedLabel")} value={String(summary.listed)} />
          <AdminMetric icon={<ShieldCheck size={16} />} label={t("admin.assets.highRiskLabel")} value={String(summary.highRisk)} />
        </section>
        {(notice || error) && <div className={`portal-admin-notice ${error ? "error" : ""}`} role={error ? "alert" : "status"}>{error || notice}</div>}
        <section className="portal-admin-panel">
          <header className="portal-admin-panel-heading"><div><p className="portal-kicker">{t("portal.hubReview.queueKicker")}</p><h2>{t("portal.hubReview.queue")}</h2></div><span>{t("portal.admin.filteredCount", { shown: filtered.length, total: assets.length })}</span></header>
          <div className="portal-admin-toolbar">
            <SearchField
              className="portal-admin-search"
              label={t("admin.assets.searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("admin.assets.searchPlaceholder")}
              value={query}
            />
            <WorkspaceListbox<"all" | ManagedAssetType>
              ariaLabel={t("admin.assets.allTypes")}
              className="portal-hub-review-filter"
              iconBefore={<Boxes size={14} />}
              onChange={setType}
              options={[
                { label: t("admin.assets.allTypes"), value: "all" },
                { label: t("admin.assets.typeApps"), value: "app" },
                { label: t("admin.assets.typeSkills"), value: "skill" }
              ]}
              popoverAlign="end"
              value={type}
              variant="filter"
            />
            <WorkspaceListbox<"all" | AssetLifecycleStatus>
              ariaLabel={t("admin.assets.allStatuses")}
              className="portal-hub-review-filter"
              iconBefore={<ShieldCheck size={14} />}
              onChange={setStatus}
              options={[
                { label: t("admin.assets.allStatuses"), value: "all" },
                { label: t("ui.status.pendingReview"), value: "pending_review" },
                { label: t("ui.status.listed"), value: "listed" },
                { label: t("ui.status.delisted"), value: "delisted" }
              ]}
              popoverAlign="end"
              value={status}
              variant="filter"
            />
            <Button disabled={!query && type === "all" && status === "all"} onClick={() => { setQuery(""); setType("all"); setStatus("all"); }} size="compact">{t("portal.admin.clearFilters")}</Button>
          </div>
          <div className="portal-admin-table-wrap"><table className="portal-admin-table portal-hub-review-table has-actions"><thead><tr><th>{t("admin.assets.columnAsset")}</th><th>{t("admin.assets.columnOwner")}</th><th>{t("admin.assets.columnStatusRisk")}</th><th>{t("admin.assets.category")}</th><th><span className="visuallyHidden">{t("admin.assets.columnActions")}</span></th></tr></thead><tbody>
            {filtered.map((asset) => <tr key={`${asset.type}:${asset.id}`}><td><strong>{asset.name}</strong><small>{asset.type === "app" ? t("admin.assets.typeApp") : t("admin.assets.typeSkill")} · {asset.description}</small></td><td><PublicationAuthors compact fallback={asset.owner} listing={asset.listing} /><small>{asset.updatedAt || t("admin.assets.noUpdateTime")}</small></td><td><span className={`portal-admin-status ${asset.status === "listed" ? "active" : asset.status === "pending_review" ? "pending" : "neutral"}`}>{statusLabel(asset.status, t)}</span><small>{t(`ui.risk.${asset.risk}`)}</small></td><td>{asset.category}</td><td><Button aria-label={`${t("admin.assets.detailAction")}: ${asset.name}`} onClick={() => setSelected(asset)} size="compact">{t("admin.assets.detailAction")}</Button></td></tr>)}
            {filtered.length === 0 && <tr><td className="portal-admin-empty-row" colSpan={5}>{t("admin.assets.empty")}</td></tr>}
          </tbody></table></div>
        </section>
      </section>
      {selected && <ReviewDialog asset={selected} onClose={() => setSelected(undefined)} onSave={(draft) => saveReview(selected, draft)} />}
    </div>
  );
}

type ReviewDraft = {
  category: string;
  coverImageUrl: string;
  description: string;
  homeDisplay?: HomeAppDisplay;
  name: string;
  ownerAliasName: string;
  reviewNote: string;
  riskLevel: AssetRiskLevel;
  status: Exclude<AssetLifecycleStatus, "deleted">;
  summary: string;
  tags: string;
  visibility: PublicationVisibility;
};

function ReviewDialog({ asset, onClose, onSave }: { asset: ManagedAsset; onClose: () => void; onSave: (draft: ReviewDraft) => Promise<void> | void }) {
  const { locale, t } = useI18n();
  const [draft, setDraft] = useState<ReviewDraft>({
    category: normalizeMarketCategoryName(asset.marketCategory || asset.category, asset.type === "app" ? "workflow" : "research"),
    coverImageUrl: asset.coverImageUrl?.trim() || "",
    description: asset.listing?.description || asset.description,
    homeDisplay: asset.type === "app" && asset.listing ? asset.listing.visibility === "org" ? homeAppPresentation(asset.listing).display : "normal" : undefined,
    name: asset.listing?.name || asset.name,
    ownerAliasName: asset.listing?.ownerAliasName || "",
    reviewNote: asset.reviewNotes || "",
    riskLevel: asset.risk,
    status: asset.status === "deleted" ? "delisted" : asset.status,
    summary: asset.listing?.summary || asset.description,
    tags: (asset.listing?.tags || []).join(", "),
    visibility: asset.listing?.visibility || "org"
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [coverStatus, setCoverStatus] = useState<"checking" | "invalid" | "missing" | "valid">(draft.coverImageUrl ? "checking" : "missing");
  const contentInvalid = !draft.name.trim() || !draft.description.trim();
  const saveBlocked = contentInvalid || (draft.status === "listed" && coverStatus !== "valid");
  const blockedReason = contentInvalid ? t("admin.assets.requiredContentError") : saveBlocked ? t("admin.assets.coverRequiredError") : undefined;
  const publicApp = asset.type === "app" && asset.listing && isPublicHomeApp({ ...asset.listing, visibility: draft.visibility }, asset.app);
  return <ModalShell ariaLabel={t("admin.assets.modalTitle", { name: asset.name })} header={<div><p className="portal-kicker">{t("admin.assets.modalEyebrow")}</p><h2>{asset.name}</h2><small>{t(asset.type === "app" ? "admin.assets.typeApp" : "admin.assets.typeSkill")}</small></div>} headerActions={<Button aria-label={t("common.close")} onClick={onClose} variant="icon"><X size={18} /></Button>} headerClassName="portal-admin-dialog-header" modalClassName="portal-admin-dialog portal-review-dialog" onClose={onClose} overlayClassName="portal-admin-dialog-overlay"><div className="portal-admin-dialog-body">
    <p className="portal-admin-help">{t("admin.assets.visibilityHelp")}</p>
    {asset.type === "app" && <section className="portal-admin-notice"><strong>{t("admin.assets.actualAccess")}</strong><p>{asset.metaRows.find((row) => row.label === t("apps.publish.accessMode"))?.value || t("admin.assets.accessUnknown")}</p></section>}
    <details className="portal-admin-disclosure"><summary>{t("admin.assets.extraInfo")}</summary><div className="portal-review-details"><DetailGroup author={{ fallback: asset.owner, label: t("admin.assets.columnOwner"), listing: asset.listing }} title={t("admin.assets.metaTitle")} rows={asset.metaRows} /><DetailGroup title={t("admin.assets.securityTitle")} rows={asset.securityRows} /></div></details>
    <div className="portal-admin-form-grid portal-review-form">
      <div className="portal-review-form-section"><h3>{t("admin.assets.reviewDecisionTitle")}</h3></div>
      <FormField label={t("admin.assets.statusLabel")}>
        <WorkspaceListbox<ReviewDraft["status"]>
          ariaLabel={t("admin.assets.statusLabel")}
          className="portal-review-listbox"
          onChange={(status) => setDraft({ ...draft, status })}
          options={[
            { label: t("ui.status.pendingReview"), value: "pending_review" },
            { label: t("ui.status.listed"), value: "listed" },
            { label: t("ui.status.delisted"), value: "delisted" }
          ]}
          value={draft.status}
        />
      </FormField>
      <FormField label={t("admin.assets.riskLabel")}>
        <WorkspaceListbox<AssetRiskLevel>
          ariaLabel={t("admin.assets.riskLabel")}
          className="portal-review-listbox"
          onChange={(riskLevel) => setDraft({ ...draft, riskLevel })}
          options={[
            { label: t("ui.risk.low"), value: "low" },
            { label: t("ui.risk.medium"), value: "medium" },
            { label: t("ui.risk.high"), value: "high" }
          ]}
          value={draft.riskLevel}
        />
      </FormField>
      <FormField full label={t("admin.assets.category")}>
        <WorkspaceListbox
          ariaLabel={t("admin.assets.category")}
          className="portal-review-listbox"
          noResultsLabel={t("common.noResults")}
          onChange={(category) => setDraft({ ...draft, category })}
          options={MARKET_CATEGORIES.map((category) => ({
            label: marketCategoryOptionLabel(category, locale),
            searchText: `${category.key} ${category.en} ${category.zh}`,
            value: category.en
          }))}
          searchable
          searchPlaceholder={t("common.search")}
          value={draft.category}
        />
      </FormField>
      <FormField full label={t("admin.assets.noteLabel")}><TextArea onChange={(event) => setDraft({ ...draft, reviewNote: event.target.value })} placeholder={t("admin.assets.notePlaceholder")} value={draft.reviewNote} /></FormField>
      <div className="portal-review-form-section"><h3>{t("admin.assets.listingContentTitle")}</h3><p>{t("admin.assets.listingContentHelp")}</p></div>
      <div className={`portal-review-cover-editor ${coverStatus}`}>
        <SquareCoverImageField
          copy={{
            collapse: t("common.collapse"),
            empty: t("apps.publish.coverEmpty"),
            help: t("apps.publish.coverHelp"),
            invalidType: t("apps.publish.coverInvalidType"),
            manage: t("apps.publish.manageCover"),
            processing: t("apps.publish.coverProcessing"),
            readFailed: t("apps.publish.coverReadFailed"),
            remove: t("common.remove"),
            replace: t("apps.publish.replaceCover"),
            required: t("apps.publish.required"),
            tooLarge: t("apps.publish.coverTooLarge"),
            upload: t("apps.publish.uploadCover")
          }}
          label={t("apps.publish.coverImage")}
          onChange={(coverImageUrl) => {
            setDraft({ ...draft, coverImageUrl });
            setCoverStatus(coverImageUrl ? "checking" : "missing");
          }}
          onValidityChange={(valid) => setCoverStatus(valid ? "valid" : "invalid")}
          required={coverStatus !== "valid"}
          value={draft.coverImageUrl}
        />
        <CoverValidationStatus status={coverStatus} />
      </div>
      <FormField full label={t("admin.assets.listingName")}><TextInput maxLength={160} onChange={(event) => setDraft({ ...draft, name: event.target.value })} value={draft.name} /></FormField>
      {asset.listing && <FormField full label={t("admin.assets.ownerAliasName")}><TextInput maxLength={120} onChange={(event) => setDraft({ ...draft, ownerAliasName: event.target.value })} placeholder={t("admin.assets.ownerAliasPlaceholder")} value={draft.ownerAliasName} /><small className="portal-review-field-help">{t("admin.assets.ownerAliasHelp")}</small></FormField>}
      <FormField full label={t("admin.assets.listingSummary")}><TextInput maxLength={500} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} value={draft.summary} /></FormField>
      <FormField full label={t("admin.assets.listingDescription")}><TextArea maxLength={3000} onChange={(event) => setDraft({ ...draft, description: event.target.value })} value={draft.description} /></FormField>
      <FormField full label={t("admin.assets.listingTags")}><TextInput maxLength={320} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} placeholder={t("admin.assets.listingTagsPlaceholder")} value={draft.tags} /></FormField>
      <FormField full label={t("admin.assets.visibility")}>
        <WorkspaceListbox<PublicationVisibility>
          ariaLabel={t("admin.assets.visibility")}
          className="portal-review-listbox"
          onChange={(visibility) => setDraft({ ...draft, visibility, homeDisplay: asset.type === "app" ? visibility === "org" ? draft.homeDisplay : "normal" : undefined })}
          options={[
            { label: t("apps.visibility.org"), value: "org" },
            { label: t("apps.visibility.team"), value: "team" },
            { label: t("apps.visibility.private"), value: "private" }
          ]}
          value={draft.visibility}
        />
      </FormField>
      {publicApp && draft.status === "listed" && <FormField full label={t("admin.assets.homeRecommendation")} description={t("admin.assets.homeRecommendationHelp")}>
        <WorkspaceListbox
          ariaLabel={t("admin.assets.homeRecommendation")}
          className="portal-review-listbox"
          onChange={(value) => setDraft({ ...draft, homeDisplay: value })}
          options={[
            { label: t("admin.assets.recommendYes"), value: "recommended" },
            { label: t("admin.assets.recommendNo"), value: "normal" }
          ]}
          value={draft.homeDisplay === "recommended" ? "recommended" : "normal"}
        />
      </FormField>}
    </div>
    <p className="portal-admin-notice">{t("admin.assets.decisionPreview", { status: statusLabel(draft.status, t), visibility: t(`apps.visibility.${draft.visibility}`) })}</p>
    {error && <FeedbackNotice tone="error">{error}</FeedbackNotice>}
    <div className="portal-admin-dialog-actions end"><Button onClick={onClose}>{t("common.cancel")}</Button><Button disabled={saveBlocked} isLoading={busy} onClick={async () => { setBusy(true); setError(""); try { await onSave(draft); } catch (caught) { setError(caught instanceof Error ? caught.message : t("admin.assets.statusUpdateFailed")); setBusy(false); } }} title={blockedReason} variant="primary">{t(draft.status === "listed" ? "admin.assets.saveListed" : draft.status === "delisted" ? "admin.assets.saveUnlisted" : "admin.assets.savePending")}</Button></div>
  </div></ModalShell>;
}

function CoverValidationStatus({ status }: { status: "checking" | "invalid" | "missing" | "valid" }) {
  const { t } = useI18n();
  const statusCopy = {
    checking: t("admin.assets.coverChecking"),
    invalid: t("admin.assets.coverInvalid"),
    missing: t("admin.assets.coverMissing"),
    valid: t("admin.assets.coverValid")
  }[status];
  const StatusIcon = status === "valid" ? CheckCircle2 : status === "checking" ? Clock3 : ShieldAlert;

  return <span aria-live="polite" className="portal-review-cover-status" role={status === "invalid" || status === "missing" ? "alert" : "status"}><StatusIcon aria-hidden="true" size={15} /> {statusCopy}</span>;
}

function parseReviewTags(value: string) {
  return value.split(/[,，\n]+/).map((tag) => tag.trim()).filter(Boolean);
}

function DetailGroup({ author, rows, title }: { author?: { fallback: string; label: string; listing?: ManagedAsset["listing"] }; rows: ManagedAsset["metaRows"]; title: string }) {
  return <section><h3>{title}</h3><dl>{author && <div className="wide"><dt>{author.label}</dt><dd><PublicationAuthors fallback={author.fallback} listing={author.listing} /></dd></div>}{rows.map((row, index) => <div className={row.wide ? "wide" : ""} key={`${row.label}:${index}`}><dt>{row.label}</dt><dd>{row.href ? <a className="portal-review-detail-link" download={row.download} href={row.href} rel={row.download ? undefined : "noreferrer"} target={row.download ? undefined : "_blank"}>{row.value}{row.download ? <Download aria-hidden="true" size={14} /> : <ExternalLink aria-hidden="true" size={14} />}</a> : row.value}</dd></div>)}</dl></section>;
}
function AdminMetric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) { return <div><span>{icon} {label}</span><strong>{value}</strong></div>; }
function statusLabel(status: AssetLifecycleStatus, t: ReturnType<typeof useI18n>["t"]) { return status === "listed" ? t("ui.status.listed") : status === "delisted" ? t("ui.status.delisted") : status === "deleted" ? t("ui.status.deleted") : t("ui.status.pendingReview"); }
function HubDenied() { const { t } = useI18n(); return <div className="portal-workspace-inner portal-admin-workspace"><section className="portal-admin-state error"><ShieldAlert size={22} /><div><h1>{t("portal.admin.accessDenied")}</h1><p>{t("portal.admin.accessDeniedBody")}</p></div></section></div>; }
