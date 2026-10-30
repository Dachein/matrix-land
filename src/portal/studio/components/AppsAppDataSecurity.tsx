import { FeedbackNotice } from "../../components/FeedbackNotice";
import { DatabaseBackup, FileArchive, LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppsApp, AppsBackupFrequency, AppsBackupJob, AppsBackupPolicy, PortalCatalog } from "../../../shared/types";
import { Button } from "../../components/Button";
import { WorkspaceListbox } from "../../components/WorkspaceListbox";
import { useI18n } from "../../i18n";
import { backupJobDownloadUrl, getAppBackup, runAppBackupNow, saveAppBackup, type AppBackupPayload } from "../backupApi";

const ACTIVE_BACKUP_STATUSES = new Set(["queued", "exporting_d1", "copying_r2", "packaging", "uploading_sftp", "verifying"]);
const BACKUP_PROGRESS: Record<AppsBackupJob["status"], number> = {
  queued: 8,
  exporting_d1: 30,
  copying_r2: 55,
  packaging: 75,
  waiting_for_node: 100,
  uploading_sftp: 85,
  verifying: 95,
  succeeded: 100,
  failed: 100,
  cancelled: 100
};

export function AppsAppDataSecurity({ app, currentUser }: { app: AppsApp; currentUser: PortalCatalog["currentUser"] }) {
  const { t } = useI18n();
  const [data, setData] = useState<AppBackupPayload>();
  const [draft, setDraft] = useState<AppsBackupPolicy>();
  const [retentionChoice, setRetentionChoice] = useState<"3" | "7" | "custom">("7");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [manualBackupBusy, setManualBackupBusy] = useState(false);
  const [logError, setLogError] = useState("");
  const [error, setError] = useState("");
  const canConfigure = currentUser.role === "admin" || app.ownerUserId === currentUser.id || app.ownerUserId === currentUser.email;

  useEffect(() => {
    let active = true; setLoading(true); setError("");
    void getAppBackup(app.id).then((payload) => {
      if (active) {
        const policy = normalizePolicyDraft(payload.policy);
        setData({ ...payload, policy });
        setDraft(policy);
        setRetentionChoice(retentionChoiceFromYears(policy.complianceRetentionYears));
      }
    }, (caught) => { if (active) setError(caught instanceof Error ? caught.message : "backup_load_failed"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [app.id]);

  const hasActiveBackup = data?.jobs.some((job) => ACTIVE_BACKUP_STATUSES.has(job.status)) ?? false;

  useEffect(() => {
    if (!hasActiveBackup) return;
    let active = true;
    const timer = window.setInterval(() => {
      void getAppBackup(app.id).then((payload) => {
        if (active) setData((current) => current ? { ...current, jobs: payload.jobs, resourceTypes: payload.resourceTypes } : payload);
      }).catch(() => undefined);
    }, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [app.id, hasActiveBackup]);

  async function save() {
    if (!draft) return;
    setSaving(true); setError("");
    try {
      const payload = await saveAppBackup(app.id, { ...draft, scheduleTime: "00:00", scheduleTimezone: "Asia/Hong_Kong" });
      const policy = normalizePolicyDraft(payload.policy);
      setData({ ...payload, policy });
      setDraft(policy);
      setRetentionChoice(retentionChoiceFromYears(policy.complianceRetentionYears));
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : "backup_save_failed"); }
    finally { setSaving(false); }
  }

  async function runManualBackup() {
    setManualBackupBusy(true); setLogError("");
    try {
      await runAppBackupNow(app.id);
      const payload = await getAppBackup(app.id);
      setData((current) => current ? { ...current, jobs: payload.jobs, resourceTypes: payload.resourceTypes } : payload);
    }
    catch { setLogError(t("backup.manual.failed")); }
    finally { setManualBackupBusy(false); }
  }

  if (loading || !draft || !data) return <div className="appsBackupLoading"><LoaderCircle className="spin" size={18} /> {t("backup.loading")}</div>;
  const frequencyOptions = [
    { label: t("backup.frequency.daily"), value: "daily" as const },
    { label: t("backup.frequency.weekly"), value: "weekly" as const },
    { label: t("backup.frequency.monthly"), value: "monthly" as const }
  ];
  const weekdayOptions = [
    { label: t("backup.weekday.monday"), value: "1" as const },
    { label: t("backup.weekday.tuesday"), value: "2" as const },
    { label: t("backup.weekday.wednesday"), value: "3" as const },
    { label: t("backup.weekday.thursday"), value: "4" as const },
    { label: t("backup.weekday.friday"), value: "5" as const },
    { label: t("backup.weekday.saturday"), value: "6" as const },
    { label: t("backup.weekday.sunday"), value: "0" as const }
  ];
  const monthdayOptions = Array.from({ length: 31 }, (_, index) => {
    const day = index + 1;
    return { label: t("backup.monthday.option", { day }), value: String(day) };
  });
  const retentionOptions = [
    { label: t("backup.retention.threeYears"), value: "3" as const },
    { label: t("backup.retention.sevenYears"), value: "7" as const },
    { label: t("backup.retention.custom"), value: "custom" as const }
  ];
  const activeJob = data.jobs.find((job) => ACTIVE_BACKUP_STATUSES.has(job.status));
  const progressValue = manualBackupBusy ? 4 : activeJob ? BACKUP_PROGRESS[activeJob.status] : 0;
  const progressLabel = manualBackupBusy
    ? t("backup.manual.creating")
    : activeJob
      ? t(`backup.status.${activeJob.status}` as Parameters<typeof t>[0])
      : "";
  return (
    <div className="appsBackupSecurity">
      <section className="appsBackupPanel">
        <header><span><ShieldCheck size={18} /></span><div><h3>{t("backup.settings.title")}</h3><p>{t("backup.settings.description")}</p></div></header>
        <label className="appsBackupSwitch"><span><strong>{t("backup.enabled")}</strong><small>{t("backup.enabledHelp")}</small></span><input checked={draft.enabled} disabled={!canConfigure} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} type="checkbox" /></label>
        {draft.enabled && <>
          <div className="appsBackupFields">
            <div className="appsBackupField">
              <span>{t("backup.frequency")}</span>
              <WorkspaceListbox
                ariaLabel={t("backup.frequency")}
                className="appsBackupListbox"
                disabled={!canConfigure}
                onChange={(frequency: AppsBackupFrequency) => setDraft({ ...draft, frequency })}
                options={frequencyOptions}
                value={draft.frequency}
              />
            </div>
            {draft.frequency === "weekly" && <div className="appsBackupField">
              <span>{t("backup.weekday")}</span>
              <WorkspaceListbox
                ariaLabel={t("backup.weekday")}
                className="appsBackupListbox"
                disabled={!canConfigure}
                onChange={(value: string) => setDraft({ ...draft, scheduleWeekday: Number(value) })}
                options={weekdayOptions}
                value={String(draft.scheduleWeekday)}
              />
            </div>}
            {draft.frequency === "monthly" && <div className="appsBackupField">
              <span>{t("backup.monthday")}</span>
              <WorkspaceListbox
                ariaLabel={t("backup.monthday")}
                className="appsBackupListbox"
                disabled={!canConfigure}
                onChange={(value: string) => setDraft({ ...draft, scheduleMonthday: Number(value) })}
                options={monthdayOptions}
                searchable="auto"
                value={String(draft.scheduleMonthday)}
              />
              <small className="appsBackupFieldHelp">{t("backup.monthday.help")}</small>
            </div>}
            <p className="appsBackupScheduleNote">{t("backup.platformTimeNote")}</p>
          </div>
          <div className="appsBackupRetention">
            <label className="appsBackupRetentionToggle">
              <input
                checked={draft.complianceRetentionEnabled}
                disabled={!canConfigure}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setDraft({ ...draft, complianceRetentionEnabled: checked, complianceRetentionYears: checked ? 7 : draft.complianceRetentionYears });
                  if (checked) setRetentionChoice("7");
                }}
                type="checkbox"
              />
              <span><strong>{t("backup.retention.enabled")}</strong><small>{t("backup.retention.help")}</small></span>
            </label>
            {draft.complianceRetentionEnabled && <div className="appsBackupRetentionControls">
              <div className="appsBackupField">
                <span>{t("backup.retention.period")}</span>
                <WorkspaceListbox
                  ariaLabel={t("backup.retention.period")}
                  className="appsBackupListbox"
                  disabled={!canConfigure}
                  onChange={(value: "3" | "7" | "custom") => {
                    setRetentionChoice(value);
                    if (value === "3" || value === "7") setDraft({ ...draft, complianceRetentionYears: Number(value) });
                  }}
                  options={retentionOptions}
                  value={retentionChoice}
                />
              </div>
              {retentionChoice === "custom" && <label className="appsBackupField"><span>{t("backup.retention.customYears")}</span><input disabled={!canConfigure} max={99} min={1} onChange={(event) => setDraft({ ...draft, complianceRetentionYears: Number(event.target.value) })} type="number" value={draft.complianceRetentionYears} /></label>}
            </div>}
          </div>
        </>}
        <div className="appsBackupSummary">
          <DatabaseBackup size={16} />
          <span>{t(
            draft.backupNodeName ? "backup.summary.assignedNode" : "backup.summary.cloudflareOnly",
            { node: draft.backupNodeName, sources: data.resourceTypes.map((value) => value.toUpperCase()).join(" + ") }
          )}</span>
          {draft.complianceRetentionEnabled && <span>{t("backup.retention.summary", { years: draft.complianceRetentionYears })}</span>}
        </div>
        {canConfigure && <Button disabled={saving} onClick={() => void save()} size="compact" variant="primary">{saving ? t("backup.saving") : t("backup.save")}</Button>}
        {error && <FeedbackNotice tone="error">{error}</FeedbackNotice>}
      </section>

      <section className="appsBackupPanel">
        <header><span><FileArchive size={18} /></span><div><h3>{t("backup.logs.title")}</h3><p>{t("backup.logs.description")}</p></div>{canConfigure && <Button className="appsBackupManualAction" disabled={hasActiveBackup} iconBefore={<DatabaseBackup size={15} />} isLoading={manualBackupBusy} onClick={() => void runManualBackup()} size="compact" variant="secondary">{t("backup.manual.run")}</Button>}</header>
        {(manualBackupBusy || activeJob) && <div aria-live="polite" className="appsBackupProgress" role="status">
          <div className="appsBackupProgressHeading"><strong>{t("backup.progress.title")}</strong><span>{progressLabel} · {progressValue}%</span></div>
          <progress aria-label={progressLabel} max={100} value={progressValue} />
        </div>}
        {logError && <FeedbackNotice tone="error">{logError}</FeedbackNotice>}
        {!data.jobs.length ? <p className="appsBackupEmpty">{t("backup.logs.empty")}</p> : <div className="appsBackupJobs">{data.jobs.map((job) => {
          const displayStatus = job.status === "waiting_for_node" ? "succeeded" : job.status;
          return <article key={job.id}>
            <div><strong>{new Date(job.createdAt).toLocaleString()}</strong><small>{job.sourceTypes.map((value) => value.toUpperCase()).join(" + ")} · {formatBytes(job.totalBytes)}</small></div>
            {job.retained && job.archiveAvailable && displayStatus === "succeeded" && <a className="appsBackupDownload" href={backupJobDownloadUrl(app.id, job.id)}>{t("backup.download")}</a>}
            <span className={`backupStatus status-${displayStatus}`}>{t(`backup.status.${displayStatus}` as Parameters<typeof t>[0])}</span>
          </article>;
        })}</div>}
      </section>
    </div>
  );
}

function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`; return `${(value / 1024 ** 3).toFixed(1)} GB`; }
function retentionChoiceFromYears(value: number): "3" | "7" | "custom" { return value === 3 ? "3" : value === 7 ? "7" : "custom"; }
function normalizePolicyDraft(policy: AppsBackupPolicy): AppsBackupPolicy {
  const frequency = String(policy.frequency);
  return {
    ...policy,
    frequency: frequency === "daily" || frequency === "monthly" ? frequency : "weekly",
    scheduleTime: "00:00",
    scheduleTimezone: "Asia/Hong_Kong",
    scheduleWeekday: Number.isInteger(policy.scheduleWeekday) && policy.scheduleWeekday >= 0 && policy.scheduleWeekday <= 6 ? policy.scheduleWeekday : 1,
    scheduleMonthday: Number.isInteger(policy.scheduleMonthday) && policy.scheduleMonthday >= 1 && policy.scheduleMonthday <= 31 ? policy.scheduleMonthday : 1,
    complianceRetentionEnabled: policy.complianceRetentionEnabled === true,
    complianceRetentionYears: Number.isInteger(policy.complianceRetentionYears) && policy.complianceRetentionYears >= 1 && policy.complianceRetentionYears <= 99 ? policy.complianceRetentionYears : 7
  };
}
