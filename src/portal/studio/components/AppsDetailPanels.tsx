import { Archive, CloudUpload, Download, Package, Rocket, Store } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import type { AppsApp, AppsSkill, AppsSourceSnapshot, PublicationListing, PortalCatalog } from "../../../shared/types";
import { Button } from "../../components/Button";
import { RelativeTime } from "../../components/ui";
import { useUserProfiles } from "../../hooks/useUserProfiles";
import { useI18n } from "../../i18n";
import { downloadAppsSourceSnapshot, appsApiFetch } from "../apiClient";
import type { ApiSourceSnapshotsPayload, AppsAppInfoInput, AppsDetailRow, AppsProductProgressStep, AppsSkillInfoInput } from "../types";
import { normalizeAppCode } from "../utils";

export function AppsDetailSection({
  renderRowAction,
  rows,
  title,
  variant = "default"
}: {
  renderRowAction?: (row: AppsDetailRow) => ReactNode;
  rows: AppsDetailRow[];
  title: string;
  variant?: "basic" | "default";
}) {
  return (
    <section className={`assetDetailSection${variant === "basic" ? " appsBasicInfoSection" : ""}`}>
      <h3>{title}</h3>
      <div className={`assetDetailGrid${variant === "basic" ? " appsBasicInfoGrid" : ""}`}>
        {rows.map((row) => {
          const action = renderRowAction?.(row);
          return (
            <div className={appsDetailItemClassName(row)} key={`${row.label}:${row.value}`}>
              <span>{row.label}</span>
              {action ? (
                <div className="appsDetailValueWithAction">
                  <AppsDetailValue row={row} />
                  {action}
                </div>
              ) : <AppsDetailValue row={row} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function AppsMarketSubmitSection({
  busy,
  disabled = false,
  disabledReason,
  listing,
  onSubmit
}: {
  busy: boolean;
  disabled?: boolean;
  disabledReason?: string;
  listing?: PublicationListing;
  onSubmit: () => void;
}) {
  const { t } = useI18n();

  return (
    <section className="assetDetailSection appsMarketSubmitSection">
      <div>
        <h3>{t("apps.marketSubmit.title")}</h3>
        <p>{t("apps.marketSubmit.body")}</p>
        {disabledReason && <p className="appsMarketSubmitWarning">{disabledReason}</p>}
      </div>
      <Button disabled={busy || disabled} iconBefore={<Rocket size={15} />} onClick={onSubmit} size="compact" variant="primary">
        {busy ? t("apps.marketSubmit.submitting") : listing?.status === "listed" ? t("apps.marketSubmit.updateListed") : listing?.status === "pending_review" ? t("apps.marketSubmit.updateReview") : t("apps.marketSubmit.apply")}
      </Button>
    </section>
  );
}

export function AppsAppInfoEditor({
  formId,
  input,
  isSaving,
  onChange,
  onSubmit
}: {
  formId: string;
  input: AppsAppInfoInput;
  isSaving: boolean;
  onChange: (input: AppsAppInfoInput) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { t } = useI18n();

  return (
    <form className="assetDetailSection appReviewSection" id={formId} onSubmit={onSubmit}>
      <h3>{t("apps.editor.title")}</h3>
      <div className="appReviewGrid">
        <label>
          {t("apps.editor.appName")}
          <input disabled={isSaving} onChange={(event) => onChange({ ...input, name: event.target.value })} value={input.name} />
        </label>
        <label>
          {t("apps.field.appCode")}
          <input
            aria-describedby={`${formId}-app-code-hint`}
            disabled
            value={input.appCode}
          />
          <small className="appsFieldHint" id={`${formId}-app-code-hint`}>{t("apps.editor.appCodeImmutable")}</small>
        </label>
        <label className="wide">
          {t("apps.field.note")}
          <textarea disabled={isSaving} onChange={(event) => onChange({ ...input, note: event.target.value })} rows={3} value={input.note} />
        </label>
      </div>
    </form>
  );
}

export function AppsSkillInfoEditor({
  formId,
  input,
  isSaving,
  onChange,
  onSubmit
}: {
  formId: string;
  input: AppsSkillInfoInput;
  isSaving: boolean;
  onChange: (input: AppsSkillInfoInput) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { t } = useI18n();

  return (
    <form className="assetDetailSection appReviewSection" id={formId} onSubmit={onSubmit}>
      <h3>{t("apps.editor.skillTitle")}</h3>
      <div className="appReviewGrid">
        <label>
          {t("apps.editor.skillName")}
          <input disabled={isSaving} onChange={(event) => onChange({ ...input, name: event.target.value })} value={input.name} />
        </label>
        <label>
          {t("apps.field.skillSlug")}
          <input disabled={isSaving} onChange={(event) => onChange({ ...input, slug: normalizeAppCode(event.target.value) })} value={input.slug} />
        </label>
        <label className="wide">
          {t("apps.field.capabilityTags")}
          <input disabled={isSaving} onChange={(event) => onChange({ ...input, capabilities: event.target.value })} placeholder={t("apps.editor.capabilitiesPlaceholder")} value={input.capabilities} />
        </label>
        <label className="wide">
          {t("apps.publish.description")}
          <textarea disabled={isSaving} onChange={(event) => onChange({ ...input, description: event.target.value })} rows={3} value={input.description} />
        </label>
      </div>
    </form>
  );
}

export function AppsProductProgressRail({
  layout = "vertical",
  steps
}: {
  layout?: "horizontal" | "vertical";
  steps: AppsProductProgressStep[];
}) {
  return (
    <div
      className={`appsProgressRail ${layout}`}
      style={{ "--apps-progress-count": steps.length } as CSSProperties}
    >
      <ol className="appsProgressSteps">
        {steps.map((step, index) => (
          <li
            aria-current={step.state === "pending" ? "step" : undefined}
            className={`appsProgressRailItem ${step.state}`}
            key={step.label}
          >
            <span aria-hidden="true" className="appsProgressStepNumber">{index + 1}</span>
            <div>
              <div className="appsProgressStepLabel">
                <strong>{step.label}</strong>
              </div>
              <small>{step.detail}</small>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function appsDetailItemClassName(row: AppsDetailRow) {
  return [
    "assetDetailItem",
    row.wide ? "wide" : "",
    row.span ? `span-${row.span}` : "",
    row.format ? `is-${row.format}` : ""
  ].filter(Boolean).join(" ");
}

function AppsDetailValue({ row }: { row: AppsDetailRow }) {
  if (row.href) {
    return <a href={row.href} rel="noreferrer" target="_blank">{row.value}</a>;
  }

  if (row.format === "code") {
    return <code>{row.value}</code>;
  }

  if (row.format === "prose") {
    return <p>{row.value}</p>;
  }

  if (row.format === "tags" && row.value !== "-") {
    return (
      <div className="appsBasicInfoTags">
        {row.value.split(",").map((tag) => tag.trim()).filter(Boolean).map((tag) => <b key={tag}>{tag}</b>)}
      </div>
    );
  }

  return <strong>{row.value}</strong>;
}

export function AppsHistoryPanel({ app, catalog, listing, skill }: { app?: AppsApp; catalog: PortalCatalog; listing?: PublicationListing; skill?: AppsSkill }) {
  const { locale, t } = useI18n();
  const [sourceSnapshots, setSourceSnapshots] = useState<AppsSourceSnapshot[]>([]);
  const [sourceState, setSourceState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [historyFilter, setHistoryFilter] = useState<"all" | "backup" | "deployment">("all");
  const [downloadingSnapshotId, setDownloadingSnapshotId] = useState("");
  const [downloadError, setDownloadError] = useState(false);

  useEffect(() => {
    if (!app) {
      setSourceSnapshots([]);
      setSourceState("idle");
      return;
    }
    const controller = new AbortController();
    setSourceState("loading");
    void appsApiFetch<ApiSourceSnapshotsPayload>(`/apps/${encodeURIComponent(app.id)}/source-snapshots`, catalog, { signal: controller.signal })
      .then((payload) => {
        if (!controller.signal.aborted) {
          setSourceSnapshots(payload.sourceSnapshots ?? []);
          setSourceState("ready");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setSourceState("error");
      });
    return () => controller.abort();
  }, [app?.id, catalog.currentUser.email, catalog.currentUser.id]);

  const linkedSnapshotIds = new Set((app?.deployments ?? []).map((deployment) => deployment.sourceSnapshotId).filter(Boolean));
  const standaloneSnapshots = sourceSnapshots.filter((snapshot) => (
    snapshot.purpose === "backup"
    || snapshot.purpose === "both"
    || !linkedSnapshotIds.has(snapshot.id)
  ));
  const actorIds = useMemo(() => Array.from(new Set([
    ...(app?.deployments ?? []).map((deployment) => deployment.createdBy),
    ...sourceSnapshots.map((snapshot) => snapshot.createdBy)
  ].filter(Boolean))), [app?.deployments, sourceSnapshots]);
  const actorProfiles = useUserProfiles(actorIds, catalog.currentUser);

  const deploymentEvents: AppsHistoryEvent[] = (app?.deployments ?? []).map((deployment) => ({
    actorId: deployment.createdBy,
    actorName: deployment.createdByName,
    at: deployment.createdAt,
    kind: "deployment" as const,
    label: deployment.versionName?.trim() || t("apps.history.production"),
    notes: deployment.releaseNotes,
    snapshotId: deployment.sourceSnapshotId,
    version: deployment.version,
    versionName: deployment.versionName
  }));
  const backupEvents: AppsHistoryEvent[] = standaloneSnapshots.map((snapshot) => ({
    actorId: snapshot.createdBy,
    actorName: snapshot.createdByName,
    at: snapshot.createdAt,
    kind: "backup" as const,
    label: t("apps.history.sourceBackup"),
    notes: snapshot.notes,
    snapshotId: snapshot.id,
    version: snapshot.version,
    versionName: snapshot.versionName
  }));
  const events: AppsHistoryEvent[] = [
    ...deploymentEvents,
    ...backupEvents,
    ...(skill?.versions ?? []).map((version) => ({
      at: version.createdAt,
      kind: "version" as const,
      label: t("apps.history.skillVersion"),
      version: version.version
    })),
    ...(listing ? [{
      at: listing.updatedAt,
      kind: "community" as const,
      label: listing.status === "listed" ? t("apps.history.marketListed") : listing.status === "pending_review" ? t("apps.history.marketReviewing") : t("apps.history.marketUpdated"),
      recordId: listing.reviewVersionId || listing.listedVersionId || listing.id
    }] : [])
  ].sort((left, right) => right.at.localeCompare(left.at));
  const visibleEvents = events.filter((event) => historyFilter === "all" || event.kind === historyFilter);

  async function downloadSnapshot(snapshotId: string) {
    if (!app) return;
    setDownloadError(false);
    setDownloadingSnapshotId(snapshotId);
    try {
      await downloadAppsSourceSnapshot(app.id, snapshotId, catalog);
    } catch {
      setDownloadError(true);
    } finally {
      setDownloadingSnapshotId("");
    }
  }

  return (
    <section className="assetDetailSection appsHistorySection">
      <div className="appsSectionHeader appsHistoryHeader">
        <div>
          <h3>{t("apps.history.title")}</h3>
          <p>{t("apps.history.body")}</p>
        </div>
        <span className="appsHistoryCount">{t("apps.history.count", { count: visibleEvents.length })}</span>
      </div>
      <div className={`appsHistoryFilters${app ? "" : " is-empty"}`} role={app ? "group" : undefined} aria-label={app ? t("apps.history.filterAria") : undefined}>
        {app && (
          <>
          {(["all", "deployment", "backup"] as const).map((filter) => (
            <button aria-pressed={historyFilter === filter} key={filter} onClick={() => setHistoryFilter(filter)} type="button">
              {t(`apps.history.filter.${filter}`)}
              <span>{filter === "all" ? events.length : filter === "deployment" ? deploymentEvents.length : backupEvents.length}</span>
            </button>
          ))}
          </>
        )}
      </div>
      <div className="appsHistoryMessages">
        {sourceState === "error" && <p className="appsHistoryMessage error">{t("apps.history.sourceLoadError")}</p>}
        {downloadError && <p className="appsHistoryMessage error">{t("apps.history.downloadError")}</p>}
      </div>
      <ol className="appsHistoryList">
        {visibleEvents.map((event) => {
          const actorName = event.actorName || actorProfiles.get(event.actorId ?? "")?.name || event.actorId;
          return (
          <li className={`appsHistoryItem ${event.kind}`} key={`${event.kind}:${event.at}:${event.snapshotId || event.recordId || event.version}`}>
            <span aria-hidden="true" className="appsHistoryIcon">
              <AppsHistoryEventIcon kind={event.kind} />
            </span>
            <div className="appsHistoryEventCopy">
              <strong className="appsHistoryEventLabel">{event.label}</strong>
              <div className="appsHistoryEventMeta">
                <span>{event.recordId ? t("apps.history.record") : t("apps.history.versionNumber")}</span>
                <code>{event.recordId || event.version || "-"}</code>
                {event.versionName && event.kind !== "deployment" && <><span>{t("apps.history.versionName")}</span><strong>{event.versionName}</strong></>}
              </div>
              {actorName && <div className="appsHistoryActor"><span>{event.kind === "backup" ? t("apps.history.backupBy") : t("apps.history.deployedBy")}</span><strong>{actorName}</strong></div>}
              {event.notes && <details className="appsHistoryNotes"><summary>{event.kind === "backup" ? t("apps.history.backupNotes") : t("apps.history.releaseNotes")}</summary><p>{event.notes}</p></details>}
              {(event.kind === "deployment" || event.kind === "backup") && (
                <div className="appsHistoryActions">
                  {event.snapshotId ? (
                    <button disabled={downloadingSnapshotId === event.snapshotId} onClick={() => void downloadSnapshot(event.snapshotId!)} type="button">
                      <Download size={14} />
                      {downloadingSnapshotId === event.snapshotId ? t("apps.history.downloading") : t("apps.history.downloadSource")}
                    </button>
                  ) : <span>{t("apps.history.sourceSkipped")}</span>}
                </div>
              )}
            </div>
            <div className="appsHistoryEventTime">
              <strong><RelativeTime value={event.at} fallback={event.at} /></strong>
              <time dateTime={event.at}>{formatHistoryTimestamp(event.at, locale)}</time>
            </div>
          </li>
          );
        })}
        {sourceState === "loading" && app && visibleEvents.length === 0 && <li className="emptyState">{t("apps.history.sourceLoading")}</li>}
        {visibleEvents.length === 0 && sourceState !== "loading" && <li className="emptyState">{t("apps.history.empty")}</li>}
      </ol>
    </section>
  );
}

type AppsHistoryEventKind = "backup" | "community" | "deployment" | "version";

type AppsHistoryEvent = {
  actorId?: string;
  actorName?: string;
  at: string;
  kind: AppsHistoryEventKind;
  label: string;
  notes?: string;
  recordId?: string;
  snapshotId?: string;
  version?: string;
  versionName?: string;
};

function AppsHistoryEventIcon({ kind }: { kind: AppsHistoryEventKind }) {
  if (kind === "deployment") {
    return <CloudUpload size={17} strokeWidth={1.8} />;
  }

  if (kind === "backup") {
    return <Archive size={17} strokeWidth={1.8} />;
  }

  if (kind === "version") {
    return <Package size={17} strokeWidth={1.8} />;
  }

  return <Store size={17} strokeWidth={1.8} />;
}

function formatHistoryTimestamp(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date);
}
