import { Ban, Clock3, Monitor, Radio, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { WorkspaceListbox, type WorkspaceListboxOption } from "../../../../src/portal/components/WorkspaceListbox";
import { TextInput } from "../../../../src/portal/components/FormField";
import { PersonAvatar } from "../../../../src/portal/components/shared/avatar";
import { formatExactTime, formatRelativeTime } from "../../../../src/portal/admin/users/userModels";
import type { Translate } from "../../../../src/portal/admin/types";
import { useI18n } from "../../../../src/portal/i18n";
import type { PortalCatalog } from "../../../../src/shared/types";
import { usePortalAdminMcpConnections } from "../admin/mcp/usePortalAdminMcpConnections";
import type { AdminMcpConnectionStatusFilter } from "../admin/mcp/types";
import { PortalAdminInlineError } from "../components/admin/PortalAdminInlineError";
import { PortalRouteLoading } from "../components/PortalRecovery";
import "../styles/admin.css";
import "../styles/admin-operations.css";

export function PortalAdminMcpConnections({ catalog }: { catalog: PortalCatalog }) {
  if (catalog.currentUser.role !== "admin") {
    return <AdminDenied />;
  }

  return <PortalAdminMcpConnectionsAuthenticated catalog={catalog} />;
}

function PortalAdminMcpConnectionsAuthenticated({ catalog }: { catalog: PortalCatalog }) {
  const { locale, t } = useI18n();
  const translate = t as Translate;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<AdminMcpConnectionStatusFilter>("active");
  const deferredQuery = useDeferredValue(query);
  const { busyId, data, disableConnection, error, load, loading } = usePortalAdminMcpConnections({
    currentUserId: catalog.currentUser.id,
    query: deferredQuery,
    status
  });
  const statusOptions: Array<WorkspaceListboxOption<AdminMcpConnectionStatusFilter>> = [
    { label: t("admin.mcp.filterActive"), value: "active" },
    { label: t("admin.mcp.filterInactive"), value: "inactive" },
    { label: t("admin.mcp.filterAll"), value: "all" }
  ];

  if (loading && data.connections.length === 0) {
    return <PortalRouteLoading variant="admin" />;
  }

  return (
    <div className="portal-workspace-inner portal-admin-workspace">
      <section className="portal-page portal-admin-operations-page portal-admin-mcp-page" aria-labelledby="portal-admin-mcp-title">
        <header className="portal-page-heading portal-admin-heading">
          <div className="portal-page-heading-copy">
            <h1 id="portal-admin-mcp-title">{t("portal.adminMcp.title")}</h1>
            <p>{t("portal.adminMcp.subtitle")}</p>
          </div>
          <div className="portal-admin-source"><span><ShieldCheck size={15} /> {t("portal.adminMcp.source")}</span></div>
        </header>

        <p className="portal-admin-scope">{t("portal.admin.scopeGlobal")}</p>
        <section className="portal-admin-metrics portal-admin-mcp-metrics" aria-label={t("admin.mcp.summaryAria")}>
          <AdminMetric label={t("admin.mcp.activeConnections")} value={loading || error ? "-" : String(data.summary.activeCount)} />
          <AdminMetric label={t("admin.mcp.inactiveConnections")} value={loading || error ? "-" : String(data.summary.inactiveCount)} />
          <AdminMetric label={t("admin.mcp.totalConnections")} value={loading || error ? "-" : String(data.summary.totalCount)} />
          <AdminMetric label={t("admin.mcp.connectedUsers")} value={loading || error ? "-" : String(data.summary.userCount)} />
        </section>

        <section className="portal-admin-panel">
          <header className="portal-admin-panel-heading">
            <div><p className="portal-kicker">{t("portal.adminMcp.registryKicker")}</p><h2>{t("admin.mcp.title")}</h2></div>
            <span>{t("portal.admin.filteredCount", { shown: loading || error ? "-" : data.connections.length, total: loading || error ? "-" : data.summary.totalCount })}</span>
          </header>
          <p className="portal-admin-help">{t("admin.mcp.statusHelp")}</p>
          <div className="portal-admin-toolbar">
            <label className="portal-admin-search">
              <Search size={15} />
              <TextInput
                aria-label={t("admin.mcp.searchAria")}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("admin.mcp.searchPlaceholder")}
                value={query}
              />
            </label>
            <WorkspaceListbox<AdminMcpConnectionStatusFilter>
              ariaLabel={t("admin.mcp.statusFilterAria")}
              className="portal-admin-mcp-status-filter"
              iconBefore={<Radio size={14} />}
              onChange={setStatus}
              options={statusOptions}
              popoverAlign="end"
              value={status}
              variant="filter"
            />
            <Button disabled={!query && status === "all"} onClick={() => { setQuery(""); setStatus("all"); }} size="compact">{t("portal.admin.clearFilters")}</Button>
          </div>
          {error ? (
            <PortalAdminInlineError isRetrying={loading} message={t("admin.mcp.loadFailed")} onRetry={() => void load()} />
          ) : (
            <div className="portal-admin-table-wrap">
              <table className="portal-admin-table portal-admin-mcp-table has-actions">
                <thead>
                  <tr>
                    <th>{t("admin.mcp.columnUser")}</th>
                    <th>{t("admin.mcp.columnTerminal")}</th>
                    <th>{t("admin.mcp.columnStatus")}</th>
                    <th>{t("admin.mcp.columnLastActive")}</th>
                    <th>{t("admin.mcp.columnCreated")}</th>
                    <th>{t("admin.mcp.columnAction")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.connections.map((connection) => {
                    const userName = connection.user.name || connection.user.email || connection.user.id;
                    const terminal = connection.displayName || agentLabel(connection.agentType);
                    return (
                      <tr key={connection.id}>
                        <td>
                          <div className="portal-admin-person">
                            <PersonAvatar name={userName} />
                            <span><strong>{userName}</strong><small>{connection.user.email || connection.user.id}</small></span>
                          </div>
                        </td>
                        <td>
                          <strong className="portal-admin-mcp-terminal"><Monitor size={14} /> {terminal}</strong>
                          <small>{agentLabel(connection.agentType)} · {connection.clientId}</small>
                        </td>
                        <td><span className={`portal-admin-status ${connection.status === "active" ? "active" : "neutral"}`}>{t(`admin.mcp.status.${connection.status}`)}</span></td>
                        <td><strong>{formatRelativeTime(connection.lastActiveAt, locale, translate)}</strong><small><Clock3 size={12} /> {formatExactTime(connection.lastActiveAt, locale, translate)}</small></td>
                        <td><strong>{formatRelativeTime(connection.createdAt, locale, translate)}</strong><small>{formatExactTime(connection.createdAt, locale, translate)}</small></td>
                        <td>
                          {connection.status === "active" ? (
                            <Button
                              iconBefore={<Ban size={14} />}
                              isLoading={busyId === connection.id}
                              onClick={() => {
                                if (window.confirm(t("admin.mcp.disableConfirm", { terminal, user: userName }))) {
                                  void disableConnection(connection.id);
                                }
                              }}
                              size="compact"
                              variant="secondary"
                            >
                              {t("admin.mcp.disable")}
                            </Button>
                          ) : <span className="portal-admin-status neutral">{t("admin.mcp.disabled")}</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {loading && data.connections.length === 0 && <tr><td className="portal-admin-empty-row" colSpan={6}>{t("admin.mcp.loading")}</td></tr>}
                  {!loading && data.connections.length === 0 && <tr><td className="portal-admin-empty-row" colSpan={6}>{t("admin.mcp.empty")}</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </section>
    </div>
  );
}

function AdminMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function agentLabel(agentType: string) {
  if (agentType === "claude-code") return "Claude";
  if (agentType === "workbuddy") return "WorkBuddy";
  if (agentType === "cursor") return "Cursor";
  return "ChatGPT";
}

function AdminDenied() {
  const { t } = useI18n();
  return <div className="portal-workspace-inner portal-admin-workspace"><section className="portal-admin-state error"><ShieldAlert size={22} /><div><h1>{t("portal.admin.accessDenied")}</h1><p>{t("portal.admin.accessDeniedBody")}</p></div></section></div>;
}
