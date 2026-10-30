import { FeedbackNotice } from "../../../../../src/portal/components/FeedbackNotice";
import { Download, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Button, ButtonLink } from "../../../../../src/portal/components/Button";
import { WorkspaceListbox } from "../../../../../src/portal/components/WorkspaceListbox";
import { FormField, SelectInput, TextInput } from "../../../../../src/portal/components/FormField";
import { useI18n } from "../../../../../src/portal/i18n";
import { buildAdminGatewayBreakdown, buildAdminGatewayDailySeries, tokenFingerprint, usageByToken } from "../../admin/gateway/models";
import type {
  AdminGatewayAllocationResponse,
  AdminGatewayGroupBy,
  AdminGatewayToken,
  AdminGatewayUsageResponse,
  AdminGatewayUserLimit
} from "../../admin/gateway/types";

export function PortalAdminGatewaySummary({
  allocations,
  usage
}: {
  allocations?: AdminGatewayAllocationResponse;
  usage?: AdminGatewayUsageResponse;
}) {
  const { t } = useI18n();
  const totals = (usage?.series ?? []).reduce((current, row) => ({
    requests: current.requests + row.requests,
    tokens: current.tokens + row.billableUnits,
    cost: current.cost + row.estimatedCostUsd
  }), { requests: 0, tokens: 0, cost: 0 });
  const tokens = allocations?.tokens ?? usage?.tokens;
  const activeKeys = tokens?.filter((token) => token.status === "active" && token.accessStatus !== "suspended").length;

  return (
    <><p className="portal-admin-scope">{usage?.source.range ? t("admin.usage.rangeScope", usage.source.range) : t("portal.admin.scopeGlobal")}</p><section className="portal-admin-metrics" aria-label={t("portal.admin.metricsAria")}>
      {usage && <><AdminMetric label={t("admin.metrics.requests")} value={formatNumber(totals.requests)} /><AdminMetric label={t("portal.admin.tokenUnits")} value={formatNumber(totals.tokens)} /><AdminMetric label={t("admin.metrics.cost")} value={formatUsd(totals.cost)} /></>}
      <AdminMetric label={t("portal.admin.activeKeys")} value={tokens && activeKeys !== undefined ? `${formatNumber(activeKeys)} / ${formatNumber(tokens.length)}` : "—"} />
    </section></>
  );
}

export function PortalAdminTokenRegistry({
  allocations,
  usage,
  onOpen
}: {
  allocations: AdminGatewayAllocationResponse;
  usage?: AdminGatewayUsageResponse;
  onOpen: (token: AdminGatewayToken) => void;
}) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const tokenUsage = useMemo(() => usageByToken(usage?.usage ?? allocations.usage), [allocations.usage, usage]);
  const rows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return allocations.tokens.filter((token) => {
      const suspended = token.accessStatus === "suspended";
      const matchesStatus = status === "all" || status === "suspended" && suspended || status === "active" && !suspended && token.status === "active";
      const matchesQuery = !normalizedQuery || [token.name, token.externalUserId, tokenFingerprint(token)]
        .some((value) => value?.toLowerCase().includes(normalizedQuery));
      return matchesStatus && matchesQuery;
    });
  }, [allocations.tokens, query, status]);

  return (
    <section className="portal-admin-panel" aria-labelledby="portal-admin-token-heading">
      <header className="portal-admin-panel-heading">
        <div><p className="portal-kicker">{t("portal.admin.tokenRegistryKicker")}</p><h2 id="portal-admin-token-heading">{t("portal.admin.tokenRegistry")}</h2></div>
        <span>{t("portal.admin.filteredCount", { shown: rows.length, total: allocations.tokens.length })}</span>
      </header>
      <div className="portal-admin-toolbar">
        <label className="portal-admin-search">
          <Search size={16} />
          <input aria-label={t("portal.admin.searchTokens")} onChange={(event) => setQuery(event.target.value)} placeholder={t("portal.admin.searchTokens")} value={query} />
        </label>
        <WorkspaceListbox ariaLabel={t("portal.admin.filterStatus")} onChange={setStatus} options={[{ label: t("portal.admin.allStatuses"), value: "all" }, { label: t("portal.admin.active"), value: "active" }, { label: t("portal.admin.suspended"), value: "suspended" }]} value={status} variant="filter" />
        <Button disabled={!query && status === "all"} onClick={() => { setQuery(""); setStatus("all"); }} size="compact">{t("portal.admin.clearFilters")}</Button>
      </div>

      <p className="portal-admin-table-note">{t("portal.admin.inventoryScope")} <ButtonLink href="#/admin/gateway/usage" size="compact">{t("admin.usage.goMonitor")}</ButtonLink></p>
      <div className="portal-admin-table-wrap">
        <table className="portal-admin-table portal-admin-token-table has-actions">
          <thead><tr>
            <th>{t("admin.metrics.token")}</th>
            <th>{t("portal.admin.owner")}</th>
            <th>{t("admin.users.columnStatus")}</th>
            <th>{t("portal.admin.monthUsage")}</th>
            <th>{t("admin.metrics.monthlyUsd")}</th>
            <th>{t("admin.metrics.lastUsed")}</th>
            <th><span className="visuallyHidden">{t("portal.admin.manage")}</span></th>
          </tr></thead>
          <tbody>
            {rows.map((token) => {
              const tokenUsageRow = tokenUsage.get(token.id);
              const suspended = token.accessStatus === "suspended";
              return (
                <tr key={token.id}>
                  <td><strong>{token.name}</strong><small>{tokenFingerprint(token)}</small></td>
                  <td>{token.externalUserId || t("portal.admin.unassigned")}</td>
                  <td><span className={`portal-admin-status ${suspended ? "suspended" : token.status === "active" ? "active" : "neutral"}`}>{t(suspended ? "portal.admin.suspended" : token.status === "active" ? "portal.admin.active" : "portal.admin.unknown")}</span></td>
                  <td><strong>{usage ? formatNumber(tokenUsageRow?.billableUnits ?? 0) : t("admin.usage.unloaded")}</strong><small>{t("admin.metrics.tokenUnits")}</small></td>
                  <td><strong>{token.monthlyBudgetUsd > 0 ? formatUsd(token.monthlyBudgetUsd) : t("admin.allocations.noUsdCap")}</strong>{usage && <small>{t("admin.metrics.cost")}: {formatUsd(tokenUsageRow?.estimatedCostUsd ?? 0)}</small>}</td>
                  <td>{formatDate(token.lastUsedAt, locale)}</td>
                  <td><Button aria-label={t("portal.admin.manageTokenAria", { name: token.name })} onClick={() => onOpen(token)} size="compact">{t("portal.admin.manage")}</Button></td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td className="portal-admin-empty-row" colSpan={7}>{t("portal.admin.noTokens")}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PortalAdminAllocations({
  allocations,
  usage,
  onOpen
}: {
  allocations: AdminGatewayAllocationResponse;
  usage?: AdminGatewayUsageResponse;
  onOpen: (limit: AdminGatewayUserLimit) => void;
}) {
  const { t } = useI18n();
  const usageByUser = useMemo(() => new Map((usage?.usage ?? allocations.usage)
    .filter((row) => row.scopeType === "user")
    .map((row) => [row.scopeId, row])), [allocations.usage, usage]);

  return (
    <section className="portal-admin-panel" aria-labelledby="portal-admin-allocation-heading">
      <header className="portal-admin-panel-heading">
        <div><p className="portal-kicker">{t("portal.admin.allocationsKicker")}</p><h2 id="portal-admin-allocation-heading">{t("portal.admin.allocations")}</h2></div>
        <span>{t("portal.admin.liteLlmUsers", { count: allocations.userLimits.length })}</span>
      </header>
      <div className="portal-admin-table-wrap">
        <table className="portal-admin-table allocations has-actions">
          <thead><tr>
            <th>{t("admin.allocations.user")}</th>
            <th>{t("admin.metrics.monthlyUsd")}</th>
            <th>{t("admin.metrics.requestsPerMinute")}</th>
            <th>{t("admin.metrics.tokensPerMinute")}</th>
            <th>{t("admin.allocations.allowedModels")}</th>
            <th>{t("portal.admin.monthUsage")}</th>
            <th><span className="visuallyHidden">{t("portal.admin.manage")}</span></th>
          </tr></thead>
          <tbody>
            {allocations.userLimits.map((limit) => {
              const userUsageRow = usageByUser.get(limit.userId);
              return (
                <tr key={limit.id}>
                  <td><strong>{limit.userId}</strong><small>{limit.status}</small></td>
                  <td>{limit.monthlyBudgetUsd > 0 ? formatUsd(limit.monthlyBudgetUsd) : t("admin.allocations.noUsdCap")}</td>
                  <td>{limit.requestLimitPerMinute > 0 ? formatNumber(limit.requestLimitPerMinute) : t("admin.allocations.noCap")}</td>
                  <td>{limit.tokensPerMinute > 0 ? formatNumber(limit.tokensPerMinute) : t("admin.allocations.noCap")}</td>
                  <td><span className="portal-admin-model-list">{limit.allowedModels?.length ? limit.allowedModels.join(", ") : t("portal.admin.defaultModels")}</span></td>
                  <td><strong>{usage ? formatUsd(userUsageRow?.estimatedCostUsd ?? 0) : t("admin.usage.unloaded")}</strong><small>{usage ? `${formatNumber(userUsageRow?.billableUnits ?? 0)} ${t("admin.metrics.tokenUnits")}` : "—"}</small></td>
                  <td><Button aria-label={t("portal.admin.manageUserAria", { user: limit.userId })} onClick={() => onOpen(limit)} size="compact">{t("portal.admin.manage")}</Button></td>
                </tr>
              );
            })}
            {allocations.userLimits.length === 0 && <tr><td className="portal-admin-empty-row" colSpan={7}>{t("portal.admin.noUsers")}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PortalAdminUsage({
  busy,
  usage,
  groupBy,
  onExport,
  onGroupByChange,
  onRangeChange,
  range
}: {
  busy: boolean;
  usage: AdminGatewayUsageResponse;
  groupBy: AdminGatewayGroupBy;
  onExport: () => void;
  onGroupByChange: (value: AdminGatewayGroupBy) => void;
  onRangeChange: (range: { from: string; to: string }) => void;
  range: { from: string; to: string };
}) {
  const { locale, t } = useI18n();
  const daily = useMemo(() => buildAdminGatewayDailySeries(usage.series), [usage.series]);
  const maxRequests = Math.max(1, ...daily.map((row) => row.requests));
  const breakdown = useMemo(() => buildAdminGatewayBreakdown(usage.series, groupBy), [groupBy, usage.series]);
  const groupKeys = { model: "admin.usage.model", provider: "admin.usage.provider", user: "admin.allocations.user", token: "admin.metrics.token" } as const;
  const groupLabel = t(groupKeys[groupBy]);

  return (
    <section className="portal-admin-panel" aria-labelledby="portal-admin-usage-heading">
      <header className="portal-admin-panel-heading">
        <div><p className="portal-kicker">{t("portal.admin.usageKicker")}</p><h2 id="portal-admin-usage-heading">{t("portal.admin.usage")}</h2></div>
        <Button iconBefore={<Download size={15} />} isLoading={busy} onClick={onExport} size="compact">{t("portal.admin.exportCsv")}</Button>
      </header>
      <div className="portal-admin-usage-filters">
        <FormField label={t("admin.usage.breakdown")}>
          <SelectInput onChange={(event) => onGroupByChange(event.target.value as AdminGatewayGroupBy)} value={groupBy}>
            <option value="model">{t("admin.usage.byModel")}</option>
            <option value="provider">{t("admin.usage.byProvider")}</option>
            <option value="user">{t("admin.usage.byUser")}</option>
            <option value="token">{t("admin.usage.byToken")}</option>
          </SelectInput>
        </FormField>
        <FormField label={t("admin.usage.from")}><TextInput max={range.to} onChange={(event) => onRangeChange({ ...range, from: event.target.value })} type="date" value={range.from} /></FormField>
        <FormField label={t("admin.usage.to")}><TextInput min={range.from} onChange={(event) => onRangeChange({ ...range, to: event.target.value })} type="date" value={range.to} /></FormField>
      </div>

      {usage.series.reduce((sum, row) => sum + row.requests, 0) < usage.requests.length && <FeedbackNotice tone="error">{t("admin.usage.mismatch")}</FeedbackNotice>}
      <h3 className="portal-admin-trend-title">{t("admin.usage.trendTitle")}</h3>
      <p className="portal-admin-help">{t("admin.usage.sourcesHelp")}</p>
      <div className="portal-admin-trend" aria-label={t("portal.admin.requestTrendAria")}>
        {daily.map((row) => (
          <div className="portal-admin-trend-column" key={row.date} title={`${row.date}: ${formatNumber(row.requests)}`}>
            <span aria-label={`${row.date}: ${formatNumber(row.requests)}`} style={{ height: `${Math.max(3, row.requests / maxRequests * 100)}%` }} />
            <small>{row.date.slice(5)}</small>
          </div>
        ))}
        {daily.length === 0 && <p>{t("admin.usage.noTrendData")}</p>}
      </div>

      <p className="portal-admin-table-note">{t("admin.usage.utcHelp")}</p>
      <div className="portal-admin-table-wrap">
        <table aria-label={t("admin.usage.groupSummary")} className="portal-admin-table compact portal-admin-usage-breakdown">
          <thead><tr><th>{groupLabel}</th><th>{t("admin.metrics.requests")}</th><th>{t("admin.metrics.tokenUnits")}</th><th>{t("admin.metrics.cost")}</th></tr></thead>
          <tbody>
            {breakdown.map((row) => <tr key={row.groupId}><td>{groupBy === "token" ? tokenFingerprint({ id: row.groupId }) : row.groupId}</td><td>{formatNumber(row.requests)}</td><td>{formatNumber(row.billableUnits)}</td><td>{formatUsd(row.estimatedCostUsd)}</td></tr>)}
            {breakdown.length === 0 && <tr><td className="portal-admin-empty-row" colSpan={4}>{t("admin.usage.emptyUsage")}</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="portal-admin-table-note">{t("admin.usage.requestSample", { count: usage.requests.length })}</p>
      <div className="portal-admin-table-wrap">
        <table aria-label={t("admin.usage.recentRequests")} className="portal-admin-table compact">
          <thead><tr>
            <th>{t("admin.metrics.request")}</th>
            <th>{t("admin.usage.model")}</th>
            <th>{t("admin.usage.provider")}</th>
            <th>{t("admin.users.columnStatus")}</th>
            <th>{t("admin.metrics.tokenUnits")}</th>
            <th>{t("admin.metrics.cost")}</th>
            <th>{t("admin.usage.timeUtc")}</th>
          </tr></thead>
          <tbody>
            {usage.requests.map((request, index) => (
              <tr key={request.id || request.request_id || index}>
                <td><strong>{request.external_user_id || request.token_id || t("portal.admin.unknownRequest")}</strong><small>{request.request_id}</small></td>
                <td>{request.model || "-"}</td>
                <td>{request.provider || "-"}</td>
                <td><span className={`portal-admin-status ${["completed", "success"].includes(request.status || "completed") ? "active" : "neutral"}`}>{request.status || "completed"}</span></td>
                <td>{formatNumber(request.billable_units ?? 0)}</td>
                <td>{formatUsd(request.estimated_cost_usd ?? 0)}</td>
                <td>{formatDate(request.created_at, locale, "UTC")}</td>
              </tr>
            ))}
            {usage.requests.length === 0 && <tr><td className="portal-admin-empty-row" colSpan={7}>{t("admin.usage.emptyUsage")}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AdminMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatUsd(value: number) {
  return new Intl.NumberFormat(undefined, { currency: "USD", maximumFractionDigits: value < 1 ? 4 : 2, style: "currency" }).format(value);
}

function formatDate(value: string | undefined, locale: string, timeZone?: string) {
  if (!value) {
    return "-";
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(timestamp) : value;
}

export function PortalAdminSourceLine({ children }: { children: ReactNode }) {
  return <span className="portal-admin-source-line">{children}</span>;
}
