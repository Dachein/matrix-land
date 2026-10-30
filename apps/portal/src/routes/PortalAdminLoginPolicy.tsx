import { FeedbackNotice } from "../../../../src/portal/components/FeedbackNotice";
import { KeyRound, Plus, Save, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { FormField, TextInput } from "../../../../src/portal/components/FormField";
import { ModalShell } from "../../../../src/portal/components/ModalShell";
import { isValidEmailDomain, normalizeEmailDomains } from "../../../../src/shared/authEmailPolicy";
import { useI18n } from "../../../../src/portal/i18n";
import type { PortalCatalog } from "../../../../src/shared/types";
import { PortalRouteLoading } from "../components/PortalRecovery";
import "../styles/admin.css";
import "../styles/admin-operations.css";

type PolicyMode = "open" | "company_email_only";
type LoginEmailPolicy = {
  allowedDomains: string[];
  mode: PolicyMode;
  updatedAt: string;
};

export function PortalAdminLoginPolicy({ catalog }: { catalog: PortalCatalog }) {
  const { t } = useI18n();
  const [policy, setPolicy] = useState<LoginEmailPolicy>();
  const [mode, setMode] = useState<PolicyMode>("company_email_only");
  const [domains, setDomains] = useState<string[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [domainError, setDomainError] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/login-email-policy", { signal });
      const payload = await response.json().catch(() => ({})) as { error?: string; policy?: LoginEmailPolicy };
      if (!response.ok || !payload.policy) throw new Error(payload.error || "login_email_policy_load_failed");
      setPolicy(payload.policy);
      setMode(payload.policy.mode);
      setDomains(normalizeEmailDomains(payload.policy.allowedDomains));
    } catch (caught) {
      if (!signal?.aborted) setError(caught instanceof Error ? caught.message : "login_email_policy_load_failed");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    const allowedDomains = normalizeEmailDomains(domains);
    try {
      const response = await fetch("/api/admin/login-email-policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowedDomains, mode })
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; policy?: LoginEmailPolicy };
      if (!response.ok || !payload.policy) throw new Error(payload.error || "login_email_policy_save_failed");
      setPolicy(payload.policy);
      setMode(payload.policy.mode);
      setDomains(normalizeEmailDomains(payload.policy.allowedDomains));
      setReviewOpen(false);
      setNotice(t("admin.loginEmailPolicy.saved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "login_email_policy_save_failed");
    } finally {
      setSaving(false);
    }
  }

  const added = domains.filter((domain) => !policy?.allowedDomains.includes(domain));
  const removed = (policy?.allowedDomains ?? []).filter((domain) => !domains.includes(domain));
  const changed = !!policy && (mode !== policy.mode || added.length > 0 || removed.length > 0);
  const invalid = mode === "company_email_only" && domains.length === 0;
  function addDomain() {
    const domain = domainInput.trim().toLowerCase();
    if (!isValidEmailDomain(domain)) { setDomainError(t("admin.loginEmailPolicy.invalidDomain")); return; }
    if (domains.includes(domain)) { setDomainError(t("admin.loginEmailPolicy.duplicateDomain")); return; }
    setDomains(normalizeEmailDomains([...domains, domain]));
    setDomainInput("");
    setDomainError("");
  }

  if (catalog.currentUser.role !== "admin") {
    return <div className="portal-workspace-inner portal-admin-workspace"><section className="portal-admin-state error"><ShieldAlert size={22} /><div><h1>{t("portal.admin.accessDenied")}</h1><p>{t("admin.loginEmailPolicy.accessDenied")}</p></div></section></div>;
  }
  if (loading && !policy) return <PortalRouteLoading variant="admin" />;

  return (
    <div className="portal-workspace-inner portal-admin-workspace">
      <section className="portal-page portal-admin-operations-page" aria-labelledby="login-email-policy-title">
        <header className="portal-page-heading portal-admin-heading">
          <div className="portal-page-heading-copy">
            <h1 id="login-email-policy-title">{t("admin.loginEmailPolicy.title")}</h1>
            <p>{t("admin.loginEmailPolicy.subtitle")}</p>
          </div>
          <div className="portal-admin-source"><span><ShieldCheck size={15} /> {t("admin.loginEmailPolicy.source")}</span></div>
        </header>

        {error && <div className="portal-admin-notice error" role="alert">{error}</div>}
        {notice && <div className="portal-admin-notice" role="status">{notice}</div>}

        <section className="portal-admin-panel">
          <header className="portal-admin-panel-heading"><div><p className="portal-kicker">{t("admin.loginEmailPolicy.kicker")}</p><h2>{t("admin.loginEmailPolicy.modeTitle")}</h2></div><KeyRound size={18} /></header>
          <div className="portal-admin-policy-options">
            <label className="portal-admin-policy-option">
              <input checked={mode === "open"} name="login-email-policy-mode" onChange={() => setMode("open")} type="radio" />
              <span><strong>{t("admin.loginEmailPolicy.open")}</strong><small>{t("admin.loginEmailPolicy.openHelp")}</small></span>
            </label>
            <label className="portal-admin-policy-option">
              <input checked={mode === "company_email_only"} name="login-email-policy-mode" onChange={() => setMode("company_email_only")} type="radio" />
              <span><strong>{t("admin.loginEmailPolicy.companyOnly")}</strong><small>{t("admin.loginEmailPolicy.companyOnlyHelp")}</small></span>
            </label>
          </div>

          {mode === "company_email_only" && (
            <div className="portal-admin-policy-domains">
              <strong>{t("admin.loginEmailPolicy.domainCount", { count: domains.length })}</strong>
              <small>{t("admin.loginEmailPolicy.domainsHelp")}</small>
              <ul className="portal-admin-domain-list">{domains.map((domain) => <li key={domain}><span>{domain}</span><Button aria-label={t("admin.loginEmailPolicy.removeDomain", { domain })} onClick={() => setDomains(domains.filter((item) => item !== domain))} variant="icon"><X size={14} /></Button></li>)}</ul>
              <div className="portal-admin-domain-add portal-admin-form-grid"><FormField label={t("admin.loginEmailPolicy.domainInput")}><TextInput autoCapitalize="none" autoComplete="off" onChange={(event) => { setDomainInput(event.target.value); setDomainError(""); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addDomain(); } }} placeholder="example.com" value={domainInput} /></FormField><Button disabled={!domainInput.trim()} iconBefore={<Plus size={14} />} onClick={addDomain}>{t("admin.loginEmailPolicy.addDomain")}</Button></div>
              {domainError && <FeedbackNotice tone="error">{domainError}</FeedbackNotice>}
              {invalid && <FeedbackNotice tone="error">{t("admin.loginEmailPolicy.emptyDomains")}</FeedbackNotice>}
            </div>
          )}

          <div className="portal-admin-dialog-actions end"><Button disabled={!changed || invalid || !!domainInput.trim() || saving || loading} iconBefore={<Save size={15} />} onClick={() => setReviewOpen(true)} variant="primary">{t("admin.loginEmailPolicy.save")}</Button></div>
          {policy?.updatedAt && <small className="portal-admin-policy-updated">{t("admin.loginEmailPolicy.updatedAt", { time: policy.updatedAt })}</small>}
        </section>
      </section>
      {reviewOpen && <ModalShell ariaLabel={t("admin.loginEmailPolicy.reviewTitle")} header={<h2>{t("admin.loginEmailPolicy.reviewTitle")}</h2>} headerActions={<Button aria-label={t("common.close")} disabled={saving} onClick={() => setReviewOpen(false)} variant="icon"><X size={18} /></Button>} headerClassName="portal-admin-dialog-header" modalClassName="portal-admin-dialog compact" onClose={() => { if (!saving) setReviewOpen(false); }} overlayClassName="portal-admin-dialog-overlay"><div className="portal-admin-dialog-body"><p>{t("admin.loginEmailPolicy.impact")}</p><dl className="portal-admin-change-list"><div><dt>{t("admin.loginEmailPolicy.modeTitle")}</dt><dd>{t(policy?.mode === "open" ? "admin.loginEmailPolicy.open" : "admin.loginEmailPolicy.companyOnly")} → {t(mode === "open" ? "admin.loginEmailPolicy.open" : "admin.loginEmailPolicy.companyOnly")}</dd></div><div><dt>{t("admin.loginEmailPolicy.added")}</dt><dd>{added.join(", ") || t("common.none")}</dd></div><div><dt>{t("admin.loginEmailPolicy.removed")}</dt><dd>{removed.join(", ") || t("common.none")}</dd></div></dl>{error && <FeedbackNotice tone="error">{error}</FeedbackNotice>}<div className="portal-admin-dialog-actions end"><Button disabled={saving} onClick={() => setReviewOpen(false)}>{t("common.cancel")}</Button><Button isLoading={saving} onClick={() => void save()} variant="primary">{t("admin.loginEmailPolicy.confirmSave")}</Button></div></div></ModalShell>}
    </div>
  );
}
