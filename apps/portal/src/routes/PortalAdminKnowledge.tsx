import {
  BookOpen,
  Building2,
  Clock3,
  FileText,
  Globe2,
  LockKeyhole,
  MessageSquareText,
  MoreHorizontal,
  Search,
  ShieldAlert,
  ShieldCheck,
  Tags,
  UsersRound,
  X
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { WorkspaceListbox, type WorkspaceListboxOption } from "../../../../src/portal/components/WorkspaceListbox";
import { TextInput } from "../../../../src/portal/components/FormField";
import { ModalShell } from "../../../../src/portal/components/ModalShell";
import { formatExactTime, formatRelativeTime } from "../../../../src/portal/admin/users/userModels";
import type { Translate } from "../../../../src/portal/admin/types";
import { useAdminUsers } from "../../../../src/portal/hooks/useAdminUsers";
import { useI18n } from "../../../../src/portal/i18n";
import type { AdminUserProfile, PortalCatalog } from "../../../../src/shared/types";
import { usePortalAdminKnowledgeServices } from "../admin/knowledge/usePortalAdminKnowledgeServices";
import { PortalAdminInlineError } from "../components/admin/PortalAdminInlineError";
import { PortalRouteLoading } from "../components/PortalRecovery";
import type {
  AdminKnowledgePermissionType,
  AdminKnowledgeService
} from "../admin/knowledge/types";
import "../styles/admin.css";
import "../styles/admin-operations.css";
import "../styles/admin-knowledge.css";

type PermissionFilter = Exclude<AdminKnowledgePermissionType, "private"> | "all";

export function PortalAdminKnowledge({ catalog }: { catalog: PortalCatalog }) {
  if (catalog.currentUser.role !== "admin") {
    return <AdminDenied />;
  }

  return <PortalAdminKnowledgeAuthenticated catalog={catalog} />;
}

function PortalAdminKnowledgeAuthenticated({ catalog }: { catalog: PortalCatalog }) {
  const { locale, t } = useI18n();
  const translate = t as Translate;
  const { data, error, load, loading } = usePortalAdminKnowledgeServices(catalog.currentUser.id);
  const { users } = useAdminUsers(catalog.currentUser.id);
  const [permission, setPermission] = useState<PermissionFilter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<AdminKnowledgeService>();
  const [departments, setDepartments] = useState<Array<{ id: string; name: string }>>([]);
  const [departmentError, setDepartmentError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/users/departments", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("departments_unavailable");
      const payload = await response.json() as { departments?: Array<{ id: string; name: string }> };
      if (!controller.signal.aborted) setDepartments(payload.departments ?? []);
    }).catch(() => { if (!controller.signal.aborted) setDepartmentError(true); });
    return () => controller.abort();
  }, []);
  const departmentNames = useMemo(() => new Map(departments.map((department) => [department.id, department.name])), [departments]);
  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.services.filter((service) => {
      const people = [service.ownerUserId, ...service.collaboratorUserIds, ...service.access.users]
        .map((userId) => displayUser(usersById.get(userId), userId))
        .join(" ");
      return (permission === "all" || service.permissionType === permission)
        && (!needle || [
          service.name,
          service.description,
          service.category,
          service.folderPath,
          service.slug,
          ...service.tags,
          ...service.access.departments,
          ...service.access.departments.map((id) => departmentNames.get(id) ?? ""),
          people
        ].join(" ").toLowerCase().includes(needle));
    });
  }, [data.services, departmentNames, permission, query, usersById]);
  const permissionOptions: Array<WorkspaceListboxOption<PermissionFilter>> = [
    { label: t("admin.knowledge.allPermissions"), value: "all" },
    { label: t("admin.knowledge.permission.company"), value: "company" },
    { label: t("admin.knowledge.permission.targeted"), value: "targeted" }
  ];

  if (loading && data.services.length === 0) {
    return <PortalRouteLoading variant="admin" />;
  }

  return (
    <div className="portal-workspace-inner portal-admin-workspace">
      <section className="portal-page portal-admin-operations-page portal-admin-knowledge-page" aria-labelledby="portal-admin-knowledge-title">
        <header className="portal-page-heading portal-admin-heading">
          <div className="portal-page-heading-copy">
            <h1 id="portal-admin-knowledge-title">{t("portal.adminKnowledge.title")}</h1>
            <p>{t("portal.adminKnowledge.subtitle")}</p>
          </div>
          <div className="portal-admin-source"><span><ShieldCheck size={15} /> {t("portal.adminKnowledge.source")}</span></div>
        </header>

        <p className="portal-admin-scope">{t("portal.admin.scopeGlobal")}</p>
        <section className="portal-admin-metrics portal-admin-knowledge-metrics" aria-label={t("admin.knowledge.summaryAria")}>
          <AdminMetric label={t("admin.knowledge.serviceCount")} value={loading || error ? "-" : String(data.summary.serviceCount)} />
          <AdminMetric label={t("admin.knowledge.fileCount")} value={loading || error ? "-" : String(data.summary.fileCount)} />
          <AdminMetric label={t("admin.knowledge.requestCount")} value={loading || error ? "-" : String(data.summary.requestCount)} />
          <AdminMetric label={t("admin.knowledge.companyVisibleCount")} value={loading || error ? "-" : String(data.summary.companyVisibleCount)} />
        </section>

        <section className="portal-admin-panel">
          <header className="portal-admin-panel-heading">
            <div><p className="portal-kicker">{t("portal.adminKnowledge.registryKicker")}</p><h2>{t("admin.knowledge.title")}</h2></div>
            <span>{t("portal.admin.filteredCount", { shown: loading || error ? "-" : filtered.length, total: loading || error ? "-" : data.services.length })}</span>
          </header>
          <div className="portal-admin-toolbar">
            <label className="portal-admin-search">
              <Search size={15} />
              <TextInput
                aria-label={t("admin.knowledge.searchAria")}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("admin.knowledge.searchPlaceholder")}
                value={query}
              />
            </label>
            <WorkspaceListbox<PermissionFilter>
              ariaLabel={t("admin.knowledge.permissionFilterAria")}
              className="portal-admin-knowledge-filter"
              iconBefore={<ShieldCheck size={14} />}
              onChange={setPermission}
              options={permissionOptions}
              popoverAlign="end"
              value={permission}
              variant="filter"
            />
            <Button disabled={!query && permission === "all"} onClick={() => { setQuery(""); setPermission("all"); }} size="compact">{t("portal.admin.clearFilters")}</Button>
          </div>

          {error ? (
            <PortalAdminInlineError isRetrying={loading} message={t("admin.knowledge.loadFailed")} onRetry={() => void load()} />
          ) : (
            <div className="portal-admin-table-wrap">
              <table className="portal-admin-table portal-admin-knowledge-table">
                <thead>
                  <tr>
                    <th>{t("admin.knowledge.columnService")}</th>
                    <th>{t("admin.knowledge.columnOwner")}</th>
                    <th>{t("admin.knowledge.columnCollaborators")}</th>
                    <th>{t("admin.knowledge.columnLastActive")}</th>
                    <th>{t("admin.knowledge.columnFiles")}</th>
                    <th>{t("admin.knowledge.columnRequests")}</th>
                    <th>{t("admin.knowledge.columnPermission")}</th>
                    <th><span className="visuallyHidden">{t("admin.knowledge.details")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((service) => {
                    const owner = usersById.get(service.ownerUserId);
                    const collaborators = service.collaboratorUserIds.map((id) => personSummary(usersById.get(id), id));
                    return (
                      <tr key={service.id}>
                        <td>
                          <button className="portal-admin-knowledge-service-link" onClick={() => setSelected(service)} type="button">
                            <span className="portal-admin-knowledge-mark"><BookOpen size={17} /></span>
                            <span><strong>{service.name}</strong><small>{service.category} · {service.folderPath}</small></span>
                          </button>
                        </td>
                        <td>
                          <div className="portal-admin-person compact">
                            <span><strong>{displayUser(owner, service.ownerUserId)}</strong><small>{owner?.email || service.ownerUserId}</small></span>
                          </div>
                        </td>
                        <td>
                          {collaborators.length > 0 ? (
                            <div className="portal-admin-knowledge-collaborators">
                              <strong>{collaborators.map((person) => person.name).join(", ")}</strong>
                              <small>{t("admin.knowledge.collaboratorCount", { count: collaborators.length })}</small>
                            </div>
                          ) : <span className="portal-admin-muted-value">{t("admin.knowledge.noCollaborators")}</span>}
                        </td>
                        <td>
                          <strong>{service.lastActiveAt ? formatRelativeTime(service.lastActiveAt, locale, translate) : t("admin.knowledge.noRequests")}</strong>
                          <small><Clock3 size={12} /> {formatExactTime(service.lastActiveAt, locale, translate)}</small>
                        </td>
                        <td><strong className="portal-admin-number">{service.fileCount}</strong></td>
                        <td><strong className="portal-admin-number">{service.requestCount}</strong></td>
                        <td><PermissionBadge type={service.permissionType} /></td>
                        <td>
                          <Button aria-label={t("admin.knowledge.openDetails", { name: service.name })} className="portal-admin-manage-button" onClick={() => setSelected(service)} variant="icon">
                            <MoreHorizontal aria-hidden="true" size={18} />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                  {loading && filtered.length === 0 && <tr><td className="portal-admin-empty-row" colSpan={8}>{t("admin.knowledge.loading")}</td></tr>}
                  {!loading && filtered.length === 0 && <tr><td className="portal-admin-empty-row" colSpan={8}>{t("admin.knowledge.empty")}</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </section>
      {selected && (
        <KnowledgeServiceDetail
          onClose={() => setSelected(undefined)}
          service={selected}
          usersById={usersById}
          departmentNames={departmentNames}
          departmentError={departmentError}
        />
      )}
    </div>
  );
}

function KnowledgeServiceDetail({
  onClose,
  service,
  usersById,
  departmentNames,
  departmentError
}: {
  onClose: () => void;
  service: AdminKnowledgeService;
  usersById: Map<string, AdminUserProfile>;
  departmentNames: Map<string, string>;
  departmentError: boolean;
}) {
  const { locale, t } = useI18n();
  const translate = t as Translate;
  const owner = usersById.get(service.ownerUserId);
  const viewerUsers = service.access.users.map((id) => personSummary(usersById.get(id), id));
  const collaborators = service.collaboratorUserIds.map((id) => personSummary(usersById.get(id), id));

  return (
    <ModalShell
      ariaLabel={t("admin.knowledge.detailAria", { name: service.name })}
      header={(
        <div className="portal-admin-knowledge-dialog-title">
          <span className="portal-admin-knowledge-mark large"><BookOpen size={21} /></span>
          <div><p className="portal-kicker">{t("admin.knowledge.detailKicker")}</p><h2>{service.name}</h2></div>
        </div>
      )}
      headerActions={<Button aria-label={t("common.close")} onClick={onClose} variant="icon"><X size={18} /></Button>}
      headerClassName="portal-admin-dialog-header"
      modalClassName="portal-admin-dialog portal-admin-knowledge-dialog"
      onClose={onClose}
      overlayClassName="portal-admin-dialog-overlay"
    >
      <div className="portal-admin-dialog-body portal-admin-knowledge-dialog-body">
        <div className="portal-admin-knowledge-policy-note">
          <ShieldCheck size={18} />
          <span><strong>{t("admin.knowledge.aclNoticeTitle")}</strong><small>{t("admin.knowledge.aclNoticeBody")}</small></span>
        </div>

        <section className="portal-admin-knowledge-detail-section">
          <header><p className="portal-kicker">{t("admin.knowledge.permissionKicker")}</p><h3>{t("admin.knowledge.permissionInfo")}</h3></header>
          <div className="portal-admin-knowledge-permission-summary">
            <PermissionBadge type={service.permissionType} />
            <p>{permissionDescription(service.permissionType, translate)}</p>
          </div>
          <div className="portal-admin-knowledge-principal-grid">
            <PrincipalGroup icon={<ShieldCheck size={17} />} title={t("admin.knowledge.owner")}>
              <PrincipalPerson name={displayUser(owner, service.ownerUserId)} secondary={owner?.email || service.ownerUserId} />
            </PrincipalGroup>
            <PrincipalGroup icon={<UsersRound size={17} />} title={t("admin.knowledge.collaborators")}>
              {collaborators.length > 0
                ? collaborators.map((person) => <PrincipalPerson key={person.id} name={person.name} secondary={person.secondary} />)
                : <EmptyPrincipal label={t("admin.knowledge.noCollaborators")} />}
            </PrincipalGroup>
            <PrincipalGroup
              className="viewer"
              icon={permissionIcon(service.permissionType, 17)}
              title={t("admin.knowledge.viewerVisibility")}
            >
              {service.permissionType === "company" && (
                <PrincipalLabel icon={<Building2 size={15} />} label={t("admin.knowledge.companyAccess")} />
              )}
              {service.access.departments.map((department) => (
                <PrincipalLabel icon={<Building2 size={15} />} key={department} label={departmentNames.get(department) || t("admin.knowledge.unknownDepartment")} secondary={departmentNames.has(department) ? t("admin.knowledge.department") : department} />
              ))}
              {viewerUsers.map((person) => (
                <PrincipalPerson key={person.id} name={person.name} secondary={person.secondary} />
              ))}
              {service.permissionType === "private" && <EmptyPrincipal label={t("admin.knowledge.noViewerAccess")} />}
            </PrincipalGroup>
          </div>
          {departmentError && service.access.departments.length > 0 && <p className="portal-admin-help" role="status">{t("admin.knowledge.departmentLoadHelp")}</p>}
        </section>

        <details className="portal-admin-knowledge-detail-section portal-admin-disclosure">
          <summary>{t("admin.knowledge.basicInfo")}</summary>
          <dl className="portal-admin-knowledge-detail-grid"><DetailItem label={t("portal.admin.technicalDetails")} value={`${service.slug} · ${service.id}`} />
            <DetailItem label={t("admin.knowledge.serviceName")} value={service.name} />
            <DetailItem label={t("admin.knowledge.category")} value={service.category || t("portal.admin.notSet")} />
            <DetailItem full label={t("admin.knowledge.description")} value={service.description || t("portal.admin.notSet")} />
            <DetailItem label={t("admin.knowledge.folderPath")} value={service.folderPath || service.folderName} />
            <DetailItem label={t("admin.knowledge.indexStatus")} value={indexStatusLabel(service.indexStatus, translate)} />
            <DetailItem label={t("admin.knowledge.tags")} value={service.tags.length > 0 ? service.tags.join(", ") : t("portal.admin.notSet")} />
            <DetailItem label={t("admin.knowledge.languages")} value={service.languages.length > 0 ? service.languages.join(", ") : t("portal.admin.notSet")} />
            <DetailItem label={t("admin.knowledge.feedback")} value={t(service.feedbackEnabled ? "admin.knowledge.enabled" : "admin.knowledge.disabled")} />
            <DetailItem label={t("admin.knowledge.updatedAt")} value={formatExactTime(service.updatedAt, locale, translate)} />
          </dl>
          <div className="portal-admin-knowledge-activity-strip">
            <ActivityValue icon={<FileText size={16} />} label={t("admin.knowledge.files")} value={String(service.fileCount)} />
            <ActivityValue icon={<MessageSquareText size={16} />} label={t("admin.knowledge.requests")} value={String(service.requestCount)} />
            <ActivityValue icon={<Clock3 size={16} />} label={t("admin.knowledge.lastActive")} value={service.lastActiveAt ? formatExactTime(service.lastActiveAt, locale, translate) : t("admin.knowledge.noRequests")} />
          </div>
        </details>

        <div className="portal-admin-dialog-actions end">
          <Button onClick={onClose} variant="primary">{t("common.close")}</Button>
        </div>
      </div>
    </ModalShell>
  );
}

function PermissionBadge({ type }: { type: AdminKnowledgePermissionType }) {
  const { t } = useI18n();
  return (
    <span className={`portal-admin-knowledge-permission ${type}`}>
      {permissionIcon(type, 13)}
      {t(`admin.knowledge.permission.${type}`)}
    </span>
  );
}

function permissionIcon(type: AdminKnowledgePermissionType, size: number) {
  if (type === "company") return <Globe2 size={size} />;
  if (type === "targeted") return <UsersRound size={size} />;
  return <LockKeyhole size={size} />;
}

function permissionDescription(type: AdminKnowledgePermissionType, t: Translate) {
  return t(`admin.knowledge.permissionDescription.${type}`);
}

function indexStatusLabel(status: string, t: Translate) {
  const normalized = ["disabled", "queued", "indexing", "ready", "stale", "error"].includes(status)
    ? status
    : "unknown";
  return t(`admin.knowledge.index.${normalized}`);
}

function PrincipalGroup({
  children,
  className = "",
  icon,
  title
}: {
  children: ReactNode;
  className?: string;
  icon: ReactNode;
  title: string;
}) {
  return <section className={`portal-admin-knowledge-principal-group ${className}`}><header>{icon}<h4>{title}</h4></header><div>{children}</div></section>;
}

function PrincipalPerson({ name, secondary }: { name: string; secondary: string }) {
  return <div className="portal-admin-knowledge-principal"><span><strong>{name}</strong><small>{secondary}</small></span></div>;
}

function PrincipalLabel({ icon, label, secondary }: { icon: ReactNode; label: string; secondary?: string }) {
  return <div className="portal-admin-knowledge-principal label"><span className="portal-admin-knowledge-principal-icon">{icon}</span><span><strong>{label}</strong>{secondary && <small>{secondary}</small>}</span></div>;
}

function EmptyPrincipal({ label }: { label: string }) {
  return <p className="portal-admin-knowledge-empty-principal">{label}</p>;
}

function DetailItem({ full = false, label, value }: { full?: boolean; label: string; value: string }) {
  return <div className={full ? "full" : ""}><dt>{label}</dt><dd>{value}</dd></div>;
}

function ActivityValue({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div>{icon}<span><small>{label}</small><strong>{value}</strong></span></div>;
}

function AdminMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function personSummary(user: AdminUserProfile | undefined, id: string) {
  return {
    id,
    name: displayUser(user, id),
    secondary: user?.email || id
  };
}

function displayUser(user: AdminUserProfile | undefined, fallback: string) {
  return user?.name || user?.email || fallback;
}

function AdminDenied() {
  const { t } = useI18n();
  return <div className="portal-workspace-inner portal-admin-workspace"><section className="portal-admin-state error"><ShieldAlert size={22} /><div><h1>{t("portal.admin.accessDenied")}</h1><p>{t("portal.admin.accessDeniedBody")}</p></div></section></div>;
}
