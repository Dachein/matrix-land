import { useState } from "react";
import { FormField, SelectInput } from "../../../../src/portal/components/FormField";
import { useI18n } from "../../../../src/portal/i18n";
import { renderLoginCodeEmail, renderAccountInvitationEmail } from "../../../../src/shared/systemEmailTemplates";
import { renderCollaborationNotificationEmail } from "../../../../src/shared/collaborationNotificationEmail";
import type { PlatformBrand } from "../../../../src/shared/platformBrand";
const kinds = ["otp", "invitation", "mention", "collaborator_added", "visibility_granted", "contribution_awarded", "app_created"] as const;
type EmailKind = typeof kinds[number];

export function EmailExamples({ brand }: { brand: PlatformBrand }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<EmailKind>("otp");
  const email = kind === "otp" ? renderLoginCodeEmail("284619", 600, 5, brand)
    : kind === "invitation" ? renderAccountInvitationEmail("Alex", "alex@example.com", "https://workspace.example.com", brand)
    : renderCollaborationNotificationEmail({ kind, actorName: "Alex", recipientStatus: "active", resourceType: "app", resourceName: "Research Assistant", resourceUrl: "https://workspace.example.com/apps/demo" }, brand);
  return <section className="studio-emails"><FormField label={t("design.emailType")}><SelectInput appearance="line" value={kind} onChange={e => setKind(e.target.value as EmailKind)}>{kinds.map(value => <option value={value} key={value}>{t(`design.${value}`)}</option>)}</SelectInput></FormField><iframe title={t("design.emailPreview")} srcDoc={email.html} sandbox="" /></section>;
}
