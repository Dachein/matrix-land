import { FeedbackNotice } from "../../../../src/portal/components/FeedbackNotice";
import { Award, Building2, Clock3, Search, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { WorkspaceListbox, type WorkspaceListboxOption } from "../../../../src/portal/components/WorkspaceListbox";
import { FormField, TextInput } from "../../../../src/portal/components/FormField";
import { ModalShell } from "../../../../src/portal/components/ModalShell";
import { PersonAvatar } from "../../../../src/portal/components/shared/avatar";
import { useAdminUsers } from "../../../../src/portal/hooks/useAdminUsers";
import { useI18n } from "../../../../src/portal/i18n";
import { profileOrgDisplay } from "../../../../src/portal/lib/profileOrg";
import { adminJourneyLevelLabel, adminUserJourneyLevel, assignedRoleLabel, assignedUserRoles, formatExactTime, formatRelativeTime, userStatusLabel, userSummary } from "../../../../src/portal/admin/users/userModels";
import type { Translate } from "../../../../src/portal/admin/types";
import type { AdminUserProfile, AssignedUserRole, PortalCatalog, PortalJourneyLevelKey } from "../../../../src/shared/types";
import { PortalAdminInlineError } from "../components/admin/PortalAdminInlineError";
import { PortalRouteLoading } from "../components/PortalRecovery";
import "../styles/admin.css";
import "../styles/admin-operations.css";

type CommunityLevelFilter = "all" | PortalJourneyLevelKey;

export function PortalAdminUsers({ catalog }: { catalog: PortalCatalog }) {
  if (catalog.currentUser.role !== "admin") {
    return <AdminDenied />;
  }

  return <PortalAdminUsersAuthenticated catalog={catalog} />;
}

function PortalAdminUsersAuthenticated({ catalog }: { catalog: PortalCatalog }) {
  const { locale, t } = useI18n();
  const translate = t as Translate;
  const { reload, setUsers, state, users } = useAdminUsers(catalog.currentUser.id);
  const [query, setQuery] = useState("");
  const [team, setTeam] = useState("all");
  const [status, setStatus] = useState("all");
  const [communityLevel, setCommunityLevel] = useState<CommunityLevelFilter>("all");
  const [selected, setSelected] = useState<AdminUserProfile>();
  const teams = useMemo(() => [...new Set(users.map((user) => profileOrgDisplay(user).department).filter(Boolean))].sort(), [users]);
  const statuses = useMemo(() => [...new Set(users.map((user) => normalizedUserStatus(user.status)))].sort(statusOrder), [users]);
  const communityLevels = useMemo(() => [...catalog.journey.levels].sort((left, right) => left.rank - right.rank), [catalog.journey.levels]);
  const summary = useMemo(() => userSummary(users), [users]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return users.filter((user) => {
      const org = profileOrgDisplay(user);
      const level = adminUserJourneyLevel(user, catalog);
      return (team === "all" || org.department === team)
        && (status === "all" || normalizedUserStatus(user.status) === status)
        && (communityLevel === "all" || level.key === communityLevel)
        && (!needle || [user.name, user.email, user.department, user.jobTitle, user.role, ...(user.roles ?? []), user.status, level.key, adminJourneyLevelLabel(level, locale)]
        .filter(Boolean).join(" ").toLowerCase().includes(needle));
    });
  }, [catalog, communityLevel, locale, query, status, team, users]);

  const teamOptions: Array<WorkspaceListboxOption<string>> = [
    { label: t("admin.users.allTeams"), value: "all" },
    ...teams.map((value) => ({ label: value, value }))
  ];
  const statusOptions: Array<WorkspaceListboxOption<string>> = [
    { label: t("admin.users.allStatuses"), value: "all" },
    ...statuses.map((value) => ({ label: userStatusLabel(value, translate), value }))
  ];
  const communityLevelOptions: Array<WorkspaceListboxOption<CommunityLevelFilter>> = [
    { label: t("admin.users.allCommunityLevels"), value: "all" },
    ...communityLevels.map((level) => ({ label: adminJourneyLevelLabel(level, locale), value: level.key }))
  ];

  async function saveRoles(user: AdminUserProfile, roles: AssignedUserRole[]) {
    const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/roles`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roles })
    });
    const payload = await response.json().catch(() => ({})) as { error?: string; user?: AdminUserProfile };
    if (!response.ok) throw new Error(payload.error || "role_update_failed");
    const next = payload.user ?? { ...user, role: roles.includes("admin") ? "admin" : "member", roles };
    setUsers((current) => current.map((item) => item.id === user.id ? { ...item, ...next, roles } : item));
    setSelected(undefined);
  }

  if (state === "loading" && users.length === 0) {
    return <PortalRouteLoading variant="admin" />;
  }

  return (
    <div className="portal-workspace-inner portal-admin-workspace">
      <section className="portal-page portal-admin-operations-page portal-admin-users-page" aria-labelledby="portal-admin-users-title">
        <header className="portal-page-heading portal-admin-heading">
          <div className="portal-page-heading-copy">
            <h1 id="portal-admin-users-title">{t("portal.adminUsers.title")}</h1>
            <p>{t("portal.adminUsers.subtitle")}</p>
          </div>
          <div className="portal-admin-source"><span><ShieldCheck size={15} /> {t("portal.adminUsers.source")}</span></div>
        </header>

        <p className="portal-admin-scope">{t("portal.admin.scopeGlobal")}</p>
        <section className="portal-admin-metrics portal-admin-user-metrics" aria-label={t("admin.users.summaryAria")}>
          <AdminMetric label={t("admin.users.activatedLabel")} value={state !== "ready" ? "-" : String(summary.activated)} />
          <AdminMetric label={t("admin.users.recentLabel")} value={state !== "ready" ? "-" : String(summary.recent)} />
        </section>

        <section className="portal-admin-panel">
          <header className="portal-admin-panel-heading">
            <div><p className="portal-kicker">{t("portal.adminUsers.registryKicker")}</p><h2>{t("admin.users.title")}</h2></div>
            <span>{t("portal.admin.filteredCount", { shown: state === "ready" ? filtered.length : "-", total: state === "ready" ? users.length : "-" })}</span>
          </header>
          <div className="portal-admin-toolbar">
            <label className="portal-admin-search">
              <Search size={15} />
              <TextInput aria-label={t("admin.users.searchAria")} onChange={(event) => setQuery(event.target.value)} placeholder={t("admin.users.searchPlaceholder")} value={query} />
            </label>
            <div className="portal-admin-user-filters">
              <WorkspaceListbox
                ariaLabel={t("admin.users.teamFilterAria")}
                className="portal-admin-user-filter team"
                iconBefore={<Building2 size={14} />}
                noResultsLabel={t("common.noResults")}
                onChange={setTeam}
                options={teamOptions}
                popoverAlign="end"
                popoverMinWidth={220}
                searchable="auto"
                searchPlaceholder={t("common.search")}
                value={team}
                variant="filter"
              />
              <WorkspaceListbox
                ariaLabel={t("admin.users.statusFilterAria")}
                className="portal-admin-user-filter"
                iconBefore={<ShieldCheck size={14} />}
                noResultsLabel={t("common.noResults")}
                onChange={setStatus}
                options={statusOptions}
                popoverAlign="end"
                value={status}
                variant="filter"
              />
              <WorkspaceListbox<CommunityLevelFilter>
                ariaLabel={t("admin.users.communityLevelFilterAria")}
                className="portal-admin-user-filter level"
                iconBefore={<Award size={14} />}
                noResultsLabel={t("common.noResults")}
                onChange={setCommunityLevel}
                options={communityLevelOptions}
                popoverAlign="end"
                popoverMinWidth={220}
                value={communityLevel}
                variant="filter"
              />
            </div>
            <Button disabled={!query && team === "all" && status === "all" && communityLevel === "all"} onClick={() => { setQuery(""); setTeam("all"); setStatus("all"); setCommunityLevel("all"); }} size="compact">{t("portal.admin.clearFilters")}</Button>
          </div>
          {state === "error" ? (
            <PortalAdminInlineError message={t("admin.users.loadFailed")} onRetry={reload} />
          ) : (
            <div className="portal-admin-table-wrap">
              <table className="portal-admin-table portal-users-table">
                <thead><tr><th>{t("admin.users.columnUser")}</th><th>{t("admin.users.columnProfile")}</th><th>{t("admin.users.columnLastLogin")}</th><th>{t("admin.users.columnPermission")}</th><th>{t("admin.users.columnStatus")}</th><th><span className="visuallyHidden">{t("portal.adminUsers.manage")}</span></th></tr></thead>
                <tbody>
                  {filtered.map((user) => {
                    const org = profileOrgDisplay(user);
                    return (
                      <tr key={user.id}>
                        <td><div className="portal-admin-person"><PersonAvatar imageUrl={user.avatarUrl} name={user.name || user.email} /><span><strong>{user.name || user.email}</strong><small>{user.email}</small></span></div></td>
                        <td><strong>{user.jobTitle || t("portal.admin.notSet")}</strong><small><Building2 size={12} /> {org.department || t("common.notAvailable")}</small><small>{t("admin.users.communityLevel")}: {adminJourneyLevelLabel(adminUserJourneyLevel(user, catalog), locale)}</small></td>
                        <td><strong>{formatRelativeTime(user.lastSeenAt, locale, translate)}</strong><small><Clock3 size={12} /> {formatExactTime(user.lastSeenAt, locale, translate)}</small></td>
                        <td><div className="portal-admin-role-chips">{assignedUserRoles(user).length > 0 ? assignedUserRoles(user).map((role) => <span className="portal-admin-role-chip" key={role}>{assignedRoleLabel(role, translate)}</span>) : <span className="portal-admin-status neutral">{t("admin.users.roleMember")}</span>}</div></td>
                        <td><span className="portal-admin-status neutral">{userStatusLabel(user.status, translate)}</span></td>
                        <td><Button aria-label={t("admin.users.manageUserRole", { name: user.name || user.email })} disabled={user.id === catalog.currentUser.id} onClick={() => setSelected(user)} size="compact">{t("portal.adminUsers.manage")}</Button>{user.id === catalog.currentUser.id && <small>{t("portal.admin.selfRoleHelp")}</small>}</td>
                      </tr>
                    );
                  })}
                  {state === "ready" && filtered.length === 0 && <tr><td className="portal-admin-empty-row" colSpan={6}>{t("admin.users.empty")}</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </section>
      {selected && <RoleDialog onClose={() => setSelected(undefined)} onSave={(roles) => saveRoles(selected, roles)} user={selected} />}
    </div>
  );
}

function RoleDialog({ onClose, onSave, user }: { onClose: () => void; onSave: (roles: AssignedUserRole[]) => Promise<void>; user: AdminUserProfile }) {
  const { t } = useI18n();
  const initialRoles = assignedUserRoles(user);
  const [roles, setRoles] = useState<AssignedUserRole[]>(initialRoles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <ModalShell ariaLabel={t("admin.users.profileModalLabel", { name: user.name || user.email })} header={<div><p className="portal-kicker">{t("admin.users.roleGroup")}</p><h2>{user.name || user.email}</h2><small>{user.email}</small></div>} headerActions={<Button aria-label={t("common.close")} onClick={onClose} variant="icon"><X size={18} /></Button>} headerClassName="portal-admin-dialog-header" modalClassName="portal-admin-dialog compact" onClose={onClose} overlayClassName="portal-admin-dialog-overlay">
      <div className="portal-admin-dialog-body">
        <FormField full label={t("admin.users.columnPermission")}>
          <div className="portal-admin-role-options">
            <RoleOption checked={roles.includes("admin")} description={t("admin.users.roleAdminDescription")} label={t("admin.users.roleAdmin")} onChange={(checked) => setRoles(toggleRole(roles, "admin", checked))} />
            <RoleOption checked={roles.includes("community_admin")} description={t("admin.users.roleCommunityAdminDescription")} label={t("admin.users.roleCommunityAdmin")} onChange={(checked) => setRoles(toggleRole(roles, "community_admin", checked))} />
          </div>
        </FormField>
        {error && <FeedbackNotice tone="error">{error}</FeedbackNotice>}
        <div className="portal-admin-dialog-actions end"><Button onClick={onClose}>{t("common.cancel")}</Button><Button disabled={sameRoles(roles, initialRoles)} isLoading={busy} onClick={async () => { setBusy(true); setError(""); try { await onSave(roles); } catch (caught) { setError(caught instanceof Error ? caught.message : t("admin.users.roleSaveFailed")); setBusy(false); } }} variant="primary">{t("admin.users.saveRole")}</Button></div>
      </div>
    </ModalShell>
  );
}

function RoleOption({ checked, description, label, onChange }: { checked: boolean; description: string; label: string; onChange: (checked: boolean) => void }) {
  return <label className="portal-admin-role-option"><input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" /><span><strong>{label}</strong><small>{description}</small></span></label>;
}

function toggleRole(roles: AssignedUserRole[], role: AssignedUserRole, enabled: boolean) {
  return enabled ? [...new Set([...roles, role])] : roles.filter((item) => item !== role);
}

function sameRoles(left: AssignedUserRole[], right: AssignedUserRole[]) {
  return left.length === right.length && left.every((role) => right.includes(role));
}

function AdminMetric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }

function normalizedUserStatus(status: string | undefined) {
  return status?.trim().toLowerCase() || "limited";
}

function statusOrder(left: string, right: string) {
  const preferred = ["active", "invited"];
  const leftIndex = preferred.indexOf(left);
  const rightIndex = preferred.indexOf(right);

  if (leftIndex >= 0 || rightIndex >= 0) {
    return (leftIndex >= 0 ? leftIndex : preferred.length) - (rightIndex >= 0 ? rightIndex : preferred.length);
  }

  return left.localeCompare(right);
}

function AdminDenied() {
  const { t } = useI18n();
  return <div className="portal-workspace-inner portal-admin-workspace"><section className="portal-admin-state error"><ShieldAlert size={22} /><div><h1>{t("portal.admin.accessDenied")}</h1><p>{t("portal.admin.accessDeniedBody")}</p></div></section></div>;
}
