import { useState } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { Button, ButtonLink } from "../../../../src/portal/components/Button";
import { FormField, SelectInput, TextInput } from "../../../../src/portal/components/FormField";
import { ModalShell } from "../../../../src/portal/components/ModalShell";
import { Presence } from "../../../../src/portal/components/Presence";
import { FeedbackNotice } from "../../../../src/portal/components/FeedbackNotice";
import { useI18n } from "../../../../src/portal/i18n";

export function PrimitiveExamples() {
  const { t } = useI18n();
  const [dialog, setDialog] = useState(false);
  const [notice, setNotice] = useState(false);
  return <div className="studio-examples">
    <section className="studio-section"><span className="studio-number">01</span><div><h2>{t("design.actionsTitle")}</h2><p>{t("design.actionsBody")}</p><div className="studio-actions">
      <Button variant="primary" iconAfter={<ArrowUpRight />} onClick={() => setNotice(true)}>{t("design.primaryAction")}</Button>
      <Button onClick={() => setNotice(true)}>{t("design.secondaryAction")}</Button>
      <Button variant="danger" onClick={() => setNotice(true)}>{t("design.dangerAction")}</Button>
      <Button isLoading>{t("design.loading")}</Button>
      <ButtonLink disabled href="https://example.com">{t("design.disabled")}</ButtonLink>
    </div>{notice && <FeedbackNotice tone="success">{t("design.notice")}</FeedbackNotice>}</div></section>
    <section className="studio-section"><span className="studio-number">02</span><div><h2>{t("design.fieldTitle")}</h2><p>{t("design.fieldBody")}</p><div className="studio-form-grid">
      <FormField label={t("design.email")} description={t("design.emailHint")} required><TextInput placeholder="you@example.com" type="email" /></FormField>
      <FormField label={t("design.role")}><SelectInput appearance="line" defaultValue="member"><option value="member">{t("design.member")}</option><option value="admin">{t("design.admin")}</option></SelectInput></FormField>
      <FormField label={t("design.email")} error={t("design.emailError")}><TextInput defaultValue="alex@" type="email" /></FormField>
    </div></div></section>
    <section className="studio-section"><span className="studio-number">03</span><div><h2>{t("design.dialogTitle")}</h2><p>{t("design.dialogBody")}</p><Button onClick={() => setDialog(true)}>{t("design.openDialog")}</Button></div></section>
    <Presence visible={dialog}><ModalShell ariaLabel={t("design.modalTitle")} header={<h2>{t("design.modalTitle")}</h2>} headerActions={<Button variant="icon" aria-label={t("design.close")} onClick={() => setDialog(false)}><X aria-hidden="true" /></Button>} onClose={() => setDialog(false)}>
      <FormField label={t("design.email")} description={t("design.emailHint")}><TextInput type="email" autoComplete="off" /></FormField>
      <div className="studio-actions"><Button onClick={() => setDialog(false)}>{t("design.cancel")}</Button><Button variant="primary" onClick={() => { setDialog(false); setNotice(true); }}>{t("design.confirm")}</Button></div>
    </ModalShell></Presence>
  </div>;
}
