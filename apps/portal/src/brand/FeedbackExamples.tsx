import { useState } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { FeedbackNotice, type FeedbackTone } from "../../../../src/portal/components/FeedbackNotice";
import { SelectInput, FormField } from "../../../../src/portal/components/FormField";
import { useI18n } from "../../../../src/portal/i18n";
const tones: FeedbackTone[] = ["info", "success", "warning", "error", "loading", "permission"];
export function FeedbackExamples() {
  const { t } = useI18n();
  const [tone, setTone] = useState<FeedbackTone>("warning");
  return <section className="studio-section"><span className="studio-number">04</span><div>
    <h2>{t("design.feedbackTitle")}</h2><p>{t("design.feedbackBody")}</p>
    <FormField label={t("design.feedbackKind")}><SelectInput appearance="line" value={tone} onChange={event => setTone(event.target.value as FeedbackTone)}>
      {tones.map(value => <option key={value} value={value}>{t(`design.feedback.${value}`)}</option>)}
    </SelectInput></FormField>
    <FeedbackNotice tone={tone} title={t(`design.feedback.${tone}`)} actions={tone === "error" ? <Button size="compact" onClick={() => setTone("success")}>{t("portal.data.retry")}</Button> : undefined}>
      {t(`design.feedback.${tone}Body`)}
    </FeedbackNotice>
  </div></section>;
}
