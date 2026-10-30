import { Activity, ArrowRight } from "lucide-react";
import { useI18n } from "../../../../../src/portal/i18n";
import { useModelHealth } from "../../admin/modelHealth/useModelHealth";
import type { ModelHealthRunStatus } from "../../admin/modelHealth/types";

export function PortalTokenModelHealthEntry({ onOpen }: { onOpen: () => void }) {
  const { locale, t } = useI18n();
  const { data, error, loading } = useModelHealth();
  const status = data?.summary.status ?? "unknown";
  const title = error
    ? t("portal.modelHealth.loadFailed")
    : loading && !data
      ? t("portal.modelHealth.loading")
      : statusLabel(status, t);

  return (
    <button
      aria-busy={loading}
      aria-label={t("portal.token.modelHealthEntryAria")}
      className={`portal-token-model-health-entry is-${status}`}
      onClick={onOpen}
      type="button"
    >
      <span className="portal-token-model-health-icon"><Activity size={21} /></span>
      <span className="portal-token-model-health-copy">
        <span className="portal-kicker">{t("portal.token.modelHealthEntryKicker")}</span>
        <strong>{title}</strong>
      </span>
      <span className="portal-token-model-health-meta">
        <small>{t("portal.modelHealth.lastCheck")}</small>
        <span>{formatDateTime(data?.summary.lastCheckedAt, locale)}</span>
      </span>
      <span className="portal-token-model-health-open">
        <strong>{data ? formatPercent(data.summary.uptimePercent) : "—"}</strong>
        <ArrowRight size={16} />
      </span>
    </button>
  );
}

function statusLabel(status: ModelHealthRunStatus | "unknown", t: ReturnType<typeof useI18n>["t"]) {
  if (status === "operational") return t("portal.modelHealth.allOperational");
  if (status === "degraded") return t("portal.modelHealth.someDegraded");
  if (status === "outage") return t("portal.modelHealth.outage");
  if (status === "error") return t("portal.modelHealth.checkError");
  if (status === "running") return t("portal.modelHealth.checking");
  return t("portal.modelHealth.awaitingData");
}

function formatPercent(value: number) {
  return `${value.toFixed(2).replace(/\.00$/, "")} %`;
}

function formatDateTime(value: string | undefined, locale: string) {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Shanghai"
      }).format(timestamp)
    : "—";
}
