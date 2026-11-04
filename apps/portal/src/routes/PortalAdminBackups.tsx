import { PageHeading } from "../../../../src/portal/components/PageHeading";
import { FeedbackNotice } from "../../../../src/portal/components/FeedbackNotice";
import { Activity, DatabaseBackup, Plus, RefreshCw, Server, ShieldAlert, Wifi } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { WorkspaceListbox } from "../../../../src/portal/components/WorkspaceListbox";
import { useI18n } from "../../../../src/portal/i18n";
import { assignBackupNode, createBackupNode, getAdminBackups, retryBackup, runBackupNow, testBackupNode, type AdminBackupPayload } from "../../../../src/portal/studio/backupApi";
import type { AppsBackupNode, PortalCatalog } from "../../../../src/shared/types";
import { PortalRouteLoading } from "../components/PortalRecovery";
import "../styles/admin.css";
import "../styles/backups.css";
import "../styles/admin-operations.css";

const emptyData: AdminBackupPayload = { apps: [], jobs: [], nodes: [] };

export function PortalAdminBackups({ catalog }: { catalog: PortalCatalog }) {
  const { locale, t } = useI18n();
  const [tab, setTab] = useState<"apps" | "tasks">("apps");
  const [data, setData] = useState(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [nodeFormOpen, setNodeFormOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => { setLoading(true); setError(""); try { setData(await getAdminBackups()); } catch (caught) { setError(caught instanceof Error ? caught.message : "backup_load_failed"); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const summary = useMemo(() => ({ enabled: data.apps.length, unassigned: data.apps.filter((app) => !app.policy.backupNodeId).length, running: data.jobs.filter((job) => ["queued", "exporting_d1", "copying_r2", "packaging", "uploading_sftp", "verifying"].includes(job.status)).length, failed: data.jobs.filter((job) => job.status === "failed").length }), [data]);
  if (catalog.currentUser.role !== "admin") return <div className="portal-workspace-inner"><section className="portal-page"><h1>{t("backup.admin.denied")}</h1></section></div>;
  if (loading && data.apps.length === 0 && data.jobs.length === 0) return <PortalRouteLoading variant="admin" />;

  async function action(key: string, task: () => Promise<unknown>) { setBusy(key); setError(""); try { await task(); await load(); return true; } catch (caught) { setError(caught instanceof Error ? caught.message : "backup_action_failed"); return false; } finally { setBusy(""); } }
  return <div className="portal-workspace-inner portal-admin-workspace"><section className="portal-page portal-backup-admin-page">
    <PageHeading
          id="portal-admin-backups-title"
          className="portal-admin-heading"
          title={t("backup.admin.title")}
          actions={<><Button iconBefore={<Plus size={15} />} onClick={() => setNodeFormOpen(true)} size="compact" variant="primary">{t("backup.admin.addNode")}</Button></>}
        ><p>{t("backup.admin.subtitle")}</p></PageHeading>
    <p className="portal-admin-scope">{t("portal.admin.scopeGlobal")}</p><div className="backupAdminMetrics"><Metric label={t("backup.admin.enabledApps")} value={loading || error ? "-" : summary.enabled} /><Metric label={t("backup.admin.unassigned")} value={loading || error ? "-" : summary.unassigned} /><Metric label={t("backup.admin.running")} value={loading || error ? "-" : summary.running} /><Metric label={t("backup.admin.failed")} value={loading || error ? "-" : summary.failed} /></div>
    {summary.unassigned > 0 && <div className="portal-admin-notice"><strong>{t("backup.admin.setupTitle")}</strong><p>{t("backup.admin.setupHelp")}</p><small>{t("backup.admin.archiveOnly")}</small></div>}
    <div className="backupAdminTabs" role="tablist"><button aria-selected={tab === "apps"} className={tab === "apps" ? "active" : ""} onClick={() => setTab("apps")} role="tab" type="button"><DatabaseBackup size={16} />{t("backup.admin.appsTab")}</button><button aria-selected={tab === "tasks"} className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")} role="tab" type="button"><Activity size={16} />{t("backup.admin.tasksTab")}</button><Button iconBefore={<RefreshCw size={14} />} onClick={() => void load()} size="compact" variant="secondary">{t("backup.admin.refresh")}</Button></div>
    {error && <div className="backupAdminError" role="alert"><ShieldAlert size={16} />{error}</div>}
    {tab === "apps" ? <section className="backupAdminPanel"><header><div><h2>{t("backup.admin.appsTitle")}</h2><p>{t("backup.admin.appsHelp")}</p></div><span>{data.nodes.length} {t("backup.admin.nodes")}</span></header><div className="backupAdminTableWrap"><table><thead><tr><th>{t("backup.admin.app")}</th><th>{t("backup.admin.sources")}</th><th>{t("backup.admin.schedule")}</th><th>{t("backup.admin.node")}</th><th>{t("backup.admin.lastRun")}</th><th>{t("backup.admin.action")}</th></tr></thead><tbody>{data.apps.map((app) => <tr key={app.appId}><td><strong>{app.appName}</strong><small>{app.appCode}</small></td><td>{app.resourceTypes.map((value) => value.toUpperCase()).join(" + ")}</td><td>{t(`backup.frequency.${app.policy.frequency}`)} · {app.policy.scheduleTime}</td><td><WorkspaceListbox
      ariaLabel={t("backup.admin.node")}
      className="backupAdminNodeListbox"
      disabled={busy === `assign-${app.appId}` || !data.nodes.some((node) => node.status === "active")}
      onChange={(nodeId) => void action(`assign-${app.appId}`, () => assignBackupNode(app.appId, nodeId || undefined))}
      options={[
        { label: t("backup.admin.selectNode"), value: "" },
        ...data.nodes.filter((node) => node.status === "active").map((node) => ({
          description: `${node.host}:${node.port}`,
          label: node.name,
          meta: node.isDefault ? t("backup.admin.default") : undefined,
          value: node.id
        }))
      ]}
      popoverMinWidth={220}
      value={app.policy.backupNodeId || ""}
    /></td><td>{app.lastJob ? <><span className={`backupStatus status-${app.lastJob.status}`}>{t("backup.admin.status")}: {t(`backup.status.${app.lastJob.status}` as Parameters<typeof t>[0])}</span><small>{t("backup.admin.delivery")}: {app.lastJob.deliveryStatus ? t(`backup.delivery.${app.lastJob.deliveryStatus}`) : t("portal.admin.unknown")}</small><small>{new Date(app.lastJob.createdAt).toLocaleString(locale)}</small></> : "-"}</td><td><Button disabled={busy === `run-${app.appId}`} onClick={() => void action(`run-${app.appId}`, () => runBackupNow(app.appId))} size="compact" variant="secondary">{t("backup.admin.runNow")}</Button></td></tr>)}{!loading && !data.apps.length && <tr><td colSpan={6}>{t("backup.admin.noApps")}</td></tr>}</tbody></table></div></section> :
      <section className="backupAdminPanel"><header><div><h2>{t("backup.admin.tasksTitle")}</h2><p>{t("backup.admin.tasksHelp")}</p></div></header><div className="backupAdminTableWrap"><table><thead><tr><th>{t("backup.admin.created")}</th><th>{t("backup.admin.app")}</th><th>{t("backup.admin.trigger")}</th><th>{t("backup.admin.status")}</th><th>{t("backup.admin.delivery")}</th><th>{t("backup.admin.size")}</th><th>{t("backup.admin.action")}</th></tr></thead><tbody>{data.jobs.map((job) => <tr key={job.id}><td>{new Date(job.createdAt).toLocaleString(locale)}</td><td><strong>{job.appName}</strong><small>{job.id}</small></td><td>{t(`backup.trigger.${job.triggerType}`)}</td><td><span className={`backupStatus status-${job.status}`}>{t(`backup.status.${job.status}` as Parameters<typeof t>[0])}</span><details className="portal-admin-disclosure"><summary>{t("portal.admin.technicalDetails")}</summary><small>{job.currentStep}</small></details></td><td>{job.deliveryStatus ? t(`backup.delivery.${job.deliveryStatus}`) : "-"}</td><td>{formatBytes(job.totalBytes)}</td><td>{job.status === "failed" && <Button disabled={busy === `retry-${job.id}`} onClick={() => void action(`retry-${job.id}`, () => retryBackup(job.id))} size="compact" variant="secondary">{t("backup.admin.retry")}</Button>}</td></tr>)}{!loading && !data.jobs.length && <tr><td colSpan={7}>{t("backup.admin.noTasks")}</td></tr>}</tbody></table></div></section>}
    <section className="backupNodeRegistry"><header><div><Server size={17} /><span><strong>{t("backup.admin.nodeRegistry")}</strong><small>{t("backup.admin.nodeRegistryHelp")}</small></span></div></header>{data.nodes.map((node) => <NodeCard busy={busy} key={node.id} node={node} onTest={async () => { await action(`test-${node.id}`, () => testBackupNode(node.id)); }} t={t} />)}{!data.nodes.length && <p>{t("backup.admin.noNodes")}</p>}</section>
    {nodeFormOpen && <NodeForm error={error} onClose={() => setNodeFormOpen(false)} onSubmit={(input) => action("create-node", () => createBackupNode(input)).then((success) => { if (success) setNodeFormOpen(false); })} t={t} />}
  </section></div>;
}

function Metric({ label, value }: { label: string; value: number | string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function NodeCard({ busy, node, onTest, t }: { busy: string; node: AppsBackupNode; onTest: () => Promise<void>; t: ReturnType<typeof useI18n>["t"] }) { return <article><span className="backupNodeIcon"><Server size={17} /></span><div><strong>{node.name}{node.isDefault && <em>{t("backup.admin.default")}</em>}</strong><small>sftp://{node.username}@{node.host}:{node.port}{node.remotePath}</small></div><span className={node.lastTestStatus === "reachable" ? "reachable" : ""}>{node.lastTestStatus ? t(`backup.nodeTest.${node.lastTestStatus}`) : t("backup.nodeTest.untested")}{node.lastTestLatencyMs !== undefined ? ` · ${node.lastTestLatencyMs} ms` : ""}</span><Button disabled={busy === `test-${node.id}`} iconBefore={<Wifi size={14} />} onClick={() => void onTest()} size="compact" variant="secondary">{t("backup.admin.ping")}</Button></article>; }
function NodeForm({ error, onClose, onSubmit, t }: { error: string; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; t: ReturnType<typeof useI18n>["t"] }) { const [form, setForm] = useState({ name: "", host: "", port: 22, username: "", password: "", hostKeyFingerprint: "", remotePath: "/backups", isDefault: false }); const [saving, setSaving] = useState(false); async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); try { await onSubmit(form); } finally { setSaving(false); } } return <div className="backupNodeModal" role="presentation"><form aria-label={t("backup.nodeForm.title")} aria-modal="true" onSubmit={submit} role="dialog"><header><div><h2>{t("backup.nodeForm.title")}</h2><p>{t("backup.nodeForm.help")}</p></div><button aria-label={t("common.close")} onClick={onClose} type="button">×</button></header><div className="backupNodeFormGrid"><Field label={t("backup.nodeForm.name")} onChange={(value) => setForm({ ...form, name: value })} value={form.name} /><Field label={t("backup.nodeForm.host")} onChange={(value) => setForm({ ...form, host: value })} value={form.host} /><Field label={t("backup.nodeForm.port")} onChange={(value) => setForm({ ...form, port: Number(value) })} type="number" value={String(form.port)} /><Field label={t("backup.nodeForm.username")} onChange={(value) => setForm({ ...form, username: value })} value={form.username} /><Field label={t("backup.nodeForm.password")} onChange={(value) => setForm({ ...form, password: value })} type="password" value={form.password} /><Field label={t("backup.nodeForm.fingerprint")} onChange={(value) => setForm({ ...form, hostKeyFingerprint: value })} value={form.hostKeyFingerprint} /><Field label={t("backup.nodeForm.path")} onChange={(value) => setForm({ ...form, remotePath: value })} value={form.remotePath} /></div><label className="backupNodeDefault"><input checked={form.isDefault} onChange={(event) => setForm({ ...form, isDefault: event.target.checked })} type="checkbox" />{t("backup.nodeForm.default")}</label><p className="portal-admin-help">{t("backup.admin.defaultHelp")}</p><p className="portal-admin-help">{t("backup.nodeForm.fingerprintHelp")}</p>{error && <FeedbackNotice tone="error">{error}</FeedbackNotice>}<footer><Button onClick={onClose} variant="secondary">{t("backup.nodeForm.cancel")}</Button><Button disabled={saving} type="submit" variant="primary">{saving ? t("backup.nodeForm.saving") : t("backup.nodeForm.create")}</Button></footer></form></div>; }
function Field({ label, onChange, type = "text", value }: { label: string; onChange: (value: string) => void; type?: string; value: string }) { return <label><span>{label}</span><input onChange={(event) => onChange(event.target.value)} required type={type} value={value} /></label>; }
function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`; return `${(value / 1024 ** 3).toFixed(1)} GB`; }
