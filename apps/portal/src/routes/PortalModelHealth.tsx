import { SearchField } from "../../../../src/portal/components/SearchField";
import { Activity, CalendarClock, Clock3, RefreshCw, Search, ShieldAlert, X } from "lucide-react";
import { useEffect, useState, type FocusEvent, type MouseEvent } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { TextInput } from "../../../../src/portal/components/FormField";
import { ModalShell } from "../../../../src/portal/components/ModalShell";
import { useI18n } from "../../../../src/portal/i18n";
import { useModelHealth } from "../admin/modelHealth/useModelHealth";
import { PortalRowsSkeleton } from "../components/PortalRecovery";
import type {
  ModelHealthResult,
  ModelHealthRunStatus,
  ModelHealthStatus
} from "../admin/modelHealth/types";
import "../styles/model-health.css";

const MAX_VISIBLE_RUNS = 28;

export function PortalModelHealth({ onClose }: { onClose: () => void }) {
  const { locale, t } = useI18n();
  const controller = useModelHealth();
  const [tooltip, setTooltip] = useState<{
    left: number;
    placement: "above" | "below";
    result: ModelHealthResult;
    top: number;
  }>();
  const data = controller.data;
  const visibleRuns = data?.runs.slice(-MAX_VISIBLE_RUNS) ?? [];
  const status = data?.summary.status ?? "unknown";
  const resultByModelRun = new Map<string, ModelHealthResult>();
  for (const model of controller.models) {
    for (const result of model.results) {
      resultByModelRun.set(`${model.id}:${result.runId}`, result);
    }
  }

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <ModalShell
      ariaLabel={t("portal.modelHealth.title")}
      header={(
        <div className="portal-model-health-modal-title">
          <h2>{t("portal.modelHealth.title")}</h2>
          <p>{t("portal.modelHealth.subtitle")}</p>
        </div>
      )}
      headerActions={(
        <Button aria-label={t("common.close")} iconBefore={<X size={18} />} onClick={onClose} variant="icon" />
      )}
      headerClassName="portal-model-health-modal-header"
      modalClassName="portal-model-health-modal"
      onClose={onClose}
      overlayClassName="portal-token-modal-overlay portal-model-health-modal-overlay"
    >
      <div className="portal-model-health-modal-body">
        <section className="portal-model-health-modal-schedule">
          <div>
            <span><CalendarClock size={16} /> {t("portal.modelHealth.schedule")}</span>
            <small>{t("portal.modelHealth.scheduleDetail")}</small>
          </div>
          <Button iconBefore={<RefreshCw size={15} />} isLoading={controller.loading} onClick={() => void controller.load({ forceRefresh: true })} size="compact">
            {t("common.refresh")}
          </Button>
        </section>

        {controller.loading && !data ? (
          <PortalRowsSkeleton className="portal-model-health-loading-skeleton" count={4} />
        ) : !data ? (
          <section className="portal-admin-state error" role="alert">
            <ShieldAlert size={22} />
            <div><h2>{t("portal.modelHealth.loadFailed")}</h2><p>{controller.error}</p></div>
            <Button iconBefore={<RefreshCw size={15} />} onClick={() => void controller.load({ forceRefresh: true })}>{t("portal.data.retry")}</Button>
          </section>
        ) : (
          <>
            <section className={`portal-model-health-banner is-${status}`} aria-live="polite">
              <Activity size={26} />
              <div>
                <h2>{runStatusLabel(status, t)}</h2>
                <p>{t("portal.modelHealth.bannerDetail", {
                  operational: data.summary.operationalCount,
                  total: data.summary.modelCount
                })}</p>
              </div>
              <span>{formatPercent(data.summary.uptimePercent)}</span>
            </section>

            <section className="portal-model-health-metrics" aria-label={t("portal.modelHealth.metricsAria")}>
              <Metric label={t("portal.modelHealth.lastCheck")} value={formatDateTime(data.summary.lastCheckedAt, locale)} />
              <Metric label={t("portal.modelHealth.nextCheck")} value={formatDateTime(data.schedule.nextScheduledAt, locale)} />
              <Metric label={t("portal.modelHealth.averageLatency")} value={data.summary.averageLatencyMs ? `${data.summary.averageLatencyMs.toLocaleString()} ms` : "—"} />
              <Metric label={t("portal.modelHealth.failedModels")} value={String(data.summary.failedCount)} />
            </section>

            <section className="portal-model-health-panel">
              <header className="portal-model-health-toolbar">
                <div>
                  <p className="portal-kicker">{t("portal.modelHealth.gridKicker")}</p>
                  <h2>{t("portal.modelHealth.gridTitle")}</h2>
                  <small>{t("portal.modelHealth.fixedRange")}</small>
                </div>
                <SearchField
              className="portal-model-health-search"
              label={t("portal.modelHealth.search")}
              onChange={(event) => controller.setQuery(event.target.value)}
              placeholder={t("portal.modelHealth.search")}
              value={controller.query}
            />
              </header>

              <div className="portal-model-health-legend">
                <Legend status="operational" text={t("portal.modelHealth.operational")} />
                <Legend status="degraded" text={t("portal.modelHealth.degraded")} />
                <Legend status="failed" text={t("portal.modelHealth.failed")} />
                <span className="is-unknown" /> <small>{t("portal.modelHealth.notTested")}</small>
              </div>

              {visibleRuns.length === 0 ? (
                <div className="portal-model-health-empty">
                  <Clock3 size={24} />
                  <h3>{t("portal.modelHealth.noRuns")}</h3>
                  <p>{t("portal.modelHealth.noRunsBody")}</p>
                </div>
              ) : (
                <div className="portal-model-health-grid-scroll">
                  <table className="portal-model-health-grid">
                    <thead>
                      <tr>
                        <th scope="col">{t("portal.modelHealth.model")}</th>
                        {visibleRuns.map((run) => (
                          <th key={run.id} scope="col" title={formatDateTime(run.scheduledAt, locale)}>
                            <span>{formatRunDate(run.slotLocal, locale)}</span>
                            <small>{run.slotLocal.slice(11)}</small>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {controller.models.map((model) => (
                        <tr key={model.id}>
                          <th scope="row">
                            <span>{model.displayName}</span>
                            <small>{model.vendorId} · {formatPercent(model.uptimePercent)}</small>
                          </th>
                          {visibleRuns.map((run) => {
                            const result = resultByModelRun.get(`${model.id}:${run.id}`);
                            return (
                              <td key={run.id}>
                                {result ? (
                                  <button
                                    aria-label={`${model.displayName}: ${resultStatusLabel(result.status, t)}, ${formatDateTime(result.testedAt, locale)}, ${result.latencyMs} ms, HTTP ${result.httpStatus || "—"}, ${result.errorCode || "no error"}, ${result.requestId || "no request id"}`}
                                    className={`is-${result.status}`}
                                    onBlur={() => setTooltip(undefined)}
                                    onFocus={(event) => setTooltip(tooltipForCell(result, event))}
                                    onMouseEnter={(event) => setTooltip(tooltipForCell(result, event))}
                                    onMouseLeave={() => setTooltip(undefined)}
                                    type="button"
                                  />
                                ) : <span className="is-unknown" title={t("portal.modelHealth.notTested")} />}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {tooltip && (
              <ResultTooltip
                left={tooltip.left}
                locale={locale}
                placement={tooltip.placement}
                result={tooltip.result}
                t={t}
                top={tooltip.top}
              />
            )}

          </>
        )}
      </div>
    </ModalShell>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function Legend({ status, text }: { status: ModelHealthStatus; text: string }) {
  return <><span className={`is-${status}`} /><small>{text}</small></>;
}

function ResultTooltip({ left, locale, placement, result, t, top }: {
  left: number;
  locale: string;
  placement: "above" | "below";
  result: ModelHealthResult;
  t: ReturnType<typeof useI18n>["t"];
  top: number;
}) {
  return (
    <span
      className={`portal-model-health-tooltip is-${placement}`}
      role="tooltip"
      style={{ left, top }}
    >
      <strong>{result.displayName}</strong>
      <span><b>{t("portal.modelHealth.result")}</b>{resultStatusLabel(result.status, t)}</span>
      <span><b>{t("portal.modelHealth.testedAt")}</b>{formatDateTime(result.testedAt, locale)}</span>
      <span><b>{t("portal.playground.latency")}</b>{result.latencyMs.toLocaleString()} ms</span>
      <span><b>{t("portal.playground.status")}</b>{result.httpStatus || "—"}</span>
      <span><b>{t("portal.modelHealth.errorCode")}</b><code>{result.errorCode || "—"}</code></span>
      <span><b>{t("portal.playground.requestId")}</b><code>{result.requestId || "—"}</code></span>
    </span>
  );
}

function tooltipForCell(
  result: ModelHealthResult,
  event: MouseEvent<HTMLButtonElement> | FocusEvent<HTMLButtonElement>
) {
  const rect = event.currentTarget.getBoundingClientRect();
  const placement = rect.top > 250 ? "above" : "below";
  return {
    left: Math.max(155, Math.min(window.innerWidth - 155, rect.left + rect.width / 2)),
    placement,
    result,
    top: placement === "above" ? rect.top - 10 : rect.bottom + 10
  } as const;
}

function runStatusLabel(status: ModelHealthRunStatus | "unknown", t: ReturnType<typeof useI18n>["t"]) {
  if (status === "operational") return t("portal.modelHealth.allOperational");
  if (status === "degraded") return t("portal.modelHealth.someDegraded");
  if (status === "outage") return t("portal.modelHealth.outage");
  if (status === "error") return t("portal.modelHealth.checkError");
  if (status === "running") return t("portal.modelHealth.checking");
  return t("portal.modelHealth.awaitingData");
}

function resultStatusLabel(status: ModelHealthStatus, t: ReturnType<typeof useI18n>["t"]) {
  if (status === "operational") return t("portal.modelHealth.operational");
  if (status === "degraded") return t("portal.modelHealth.degraded");
  return t("portal.modelHealth.failed");
}

function formatPercent(value: number) {
  return `${value.toFixed(2).replace(/\.00$/, "")} %`;
}

function formatDateTime(value: string, locale: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(timestamp)
    : "—";
}

function formatRunDate(slotLocal: string, locale: string) {
  const timestamp = Date.parse(`${slotLocal}:00+08:00`);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", timeZone: "Asia/Shanghai" }).format(timestamp)
    : slotLocal.slice(5, 10);
}
