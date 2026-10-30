import { BarChart3, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../../../../src/portal/components/Button";
import { ModalShell } from "../../../../../src/portal/components/ModalShell";
import { SegmentedControl } from "../../../../../src/portal/components/SegmentedControl";
import { useI18n } from "../../../../../src/portal/i18n";
import { fetchUsageBreakdown } from "../../../../../src/portal/token/apiClient";
import { formatNumber, formatUsd } from "../../../../../src/portal/token/models";
import type {
  GatewayAccessToken,
  GatewayModelOption,
  UsageBreakdownModelRow,
  UsageBreakdownResponse,
  UsageBreakdownScope
} from "../../../../../src/portal/token/types";
import { PortalTokenListboxField } from "./PortalTokenListboxField";

export type BreakdownModalOpenState = {
  scope: UsageBreakdownScope;
  date?: string;
};

export function PortalTokenBreakdownModal({
  initialScope,
  initialDate,
  keys,
  modelOptions,
  onClose
}: {
  initialScope: UsageBreakdownScope;
  initialDate?: string;
  keys: GatewayAccessToken[];
  modelOptions: GatewayModelOption[];
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const [scope, setScope] = useState<UsageBreakdownScope>(initialScope);
  const [date, setDate] = useState(() => initialScope === "date" && initialDate ? initialDate : todayShanghaiDate());
  const [selectedKey, setSelectedKey] = useState("");
  const [data, setData] = useState<UsageBreakdownResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const today = todayShanghaiDate();
  const showTotal = Boolean(data && data.models.length > 1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    void fetchUsageBreakdown({
      scope,
      date: scope === "date" ? date : undefined,
      key: selectedKey
    })
      .then((payload) => {
        if (!cancelled) {
          setData(payload);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setData(undefined);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attempt, date, scope, selectedKey]);

  const keyOptions = useMemo(() => [
    { label: t("my.breakdownKeyAll"), value: "" },
    ...keys.map((key) => ({
      label: `${key.name} (${key.tokenPrefix}...${key.tokenLast4})`,
      value: key.id
    }))
  ], [keys, t]);
  const displayNames = useMemo(
    () => new Map(modelOptions.map((model) => [model.id, model.displayName])),
    [modelOptions]
  );

  return (
    <ModalShell
      ariaLabel={t("my.breakdownTitle")}
      header={(
        <div>
          <p className="portal-kicker">{t("my.breakdownKicker")}</p>
          <h2>{t("my.breakdownTitle")}</h2>
        </div>
      )}
      headerActions={<Button aria-label={t("my.breakdownCloseAria")} iconBefore={<X size={18} />} onClick={onClose} variant="icon" />}
      headerClassName="portal-token-modal-header portal-token-breakdown-header"
      modalClassName="portal-token-modal portal-token-breakdown-modal"
      onClose={onClose}
      overlayClassName="portal-token-modal-overlay portal-token-breakdown-overlay"
    >
      <div className="portal-token-breakdown">
        <div className="portal-token-breakdown-filters">
          <SegmentedControl<UsageBreakdownScope>
            ariaLabel={t("my.breakdownScopeLabel")}
            className="portal-token-breakdown-scope"
            onChange={setScope}
            options={[
              { label: t("my.breakdownScopeToday"), value: "today" },
              { label: t("my.breakdownScopeWeek"), value: "week" },
              { label: t("my.breakdownScopeMonth"), value: "month" },
              { label: t("my.breakdownScopeAll"), value: "all" },
              { label: t("my.breakdownScopeDate"), value: "date" }
            ]}
            value={scope}
          />
          {scope === "date" && (
            <label className="portal-token-breakdown-date">
              <span>{t("my.breakdownDateLabel")}</span>
              <input
                max={today}
                onChange={(event) => {
                  if (event.target.value) {
                    setDate(event.target.value);
                  }
                }}
                type="date"
                value={date}
              />
            </label>
          )}
          <PortalTokenListboxField<string>
            ariaLabel={t("my.breakdownKeyLabel")}
            label={t("my.breakdownKeyLabel")}
            onChange={setSelectedKey}
            options={keyOptions}
            value={selectedKey}
          />
        </div>

        {data && (
          <p className="portal-token-breakdown-range">
            {t("my.breakdownRangeLabel", {
              from: formatDateOnly(data.scope.from, locale),
              to: formatDateOnly(data.scope.to, locale)
            })}
          </p>
        )}

        {loading ? (
          <div className="portal-token-breakdown-state" role="status">
            <RefreshCw className="spinIcon" size={20} />
            <span>{t("my.breakdownLoading")}</span>
          </div>
        ) : error ? (
          <div className="portal-token-breakdown-state error" role="alert">
            <span className="portal-token-breakdown-state-icon"><BarChart3 size={20} /></span>
            <span>{t("my.breakdownError")}</span>
            <Button iconBefore={<RefreshCw size={14} />} onClick={() => setAttempt((current) => current + 1)} variant="secondary">
              {t("my.breakdownRetry")}
            </Button>
          </div>
        ) : data && data.models.length > 0 ? (
          <div className="portal-token-breakdown-table-wrap">
            <table className="portal-token-breakdown-table">
              <thead>
                <tr>
                  <th scope="col">{t("my.breakdownModel")}</th>
                  <th scope="col">{t("my.breakdownTotalTokens")}</th>
                  <th scope="col">{t("my.breakdownInput")}</th>
                  <th scope="col">{t("my.breakdownOutput")}</th>
                  <th scope="col">{t("my.breakdownCache")}</th>
                  <th scope="col">{t("my.breakdownCacheRate")}</th>
                  <th scope="col">{t("my.breakdownCost")}</th>
                </tr>
              </thead>
              <tbody>
                {data.models.map((row) => (
                  <BreakdownRow
                    displayNames={displayNames}
                    key={row.model}
                    row={row}
                  />
                ))}
                {showTotal && (
                  <BreakdownRow
                    displayNames={displayNames}
                    isTotal
                    key="__total__"
                    row={data.total}
                  />
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="portal-token-breakdown-state" role="status">
            <span className="portal-token-breakdown-state-icon"><BarChart3 size={20} /></span>
            <span>{t("my.breakdownEmpty")}</span>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

function BreakdownRow({
  displayNames,
  isTotal = false,
  row
}: {
  displayNames: Map<string, string>;
  isTotal?: boolean;
  row: Pick<
    UsageBreakdownModelRow,
    "cacheRate" | "cacheReadTokens" | "estimatedCostUsd" | "inputTokens" | "outputTokens" | "requests" | "totalTokens"
  > & { displayName?: string; model?: string };
}) {
  const { locale, t } = useI18n();
  const resolvedModel = row.model ?? "";
  const modelName = isTotal
    ? t("my.breakdownTotal")
    : (row.displayName || displayNames.get(resolvedModel) || resolvedModel);

  return (
    <tr className={isTotal ? "total" : undefined}>
      <th scope="row">
        <span>{modelName}</span>
        {!isTotal && <small>{t("my.breakdownRequests", { count: formatNumber(row.requests) })}</small>}
      </th>
      <td data-numeric>{formatNumber(row.totalTokens)}</td>
      <td data-numeric>{formatNumber(row.inputTokens)}</td>
      <td data-numeric>{formatNumber(row.outputTokens)}</td>
      <td data-numeric>{formatNumber(row.cacheReadTokens)}</td>
      <td data-numeric>{row.cacheRate === null ? "—" : formatPercent(row.cacheRate, locale)}</td>
      <td data-numeric>{formatUsd(row.estimatedCostUsd)}</td>
    </tr>
  );
}

function formatPercent(rate: number, locale: string) {
  const percent = new Intl.NumberFormat(locale, {
    maximumFractionDigits: rate > 0 && rate < 0.01 ? 2 : 1
  }).format(rate * 100);
  return `${percent}%`;
}

function formatDateOnly(value: string, locale: string) {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(timestamp)
    : value;
}

function todayShanghaiDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric"
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
