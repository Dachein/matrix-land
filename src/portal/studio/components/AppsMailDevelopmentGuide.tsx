import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppsApp } from "../../../shared/types";
import { Button } from "../../components/Button";
import { useI18n } from "../../i18n";
import {
  appHasMailResource,
  appMailDevelopmentPrompt,
} from "../mailDevelopmentPrompt";
import { copyText } from "../utils";

export function AppsMailDevelopmentGuide({
  app,
  embedded = false,
}: {
  app: AppsApp;
  embedded?: boolean;
}) {
  const { locale, t } = useI18n();
  const enabled = appHasMailResource(app);
  const prompt = appMailDevelopmentPrompt(app, locale);
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => setStatus("idle"), [enabled, prompt]);
  if (!enabled) return null;

  async function copyPrompt() {
    try {
      await copyText(prompt);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  }

  return (
    <section
      className={`appsMailDevelopmentGuide${embedded ? " isEmbedded" : " assetDetailSection"}`}
    >
      <div className="appsSectionHeader">
        <div>
          <h3>{t("apps.mail.guideTitle")}</h3>
          <p>{t("apps.mail.developmentHelp")}</p>
        </div>
      </div>
      <div className="formActions">
        <Button
          iconBefore={
            status === "copied" ? <Check size={15} /> : <Copy size={15} />
          }
          onClick={() => void copyPrompt()}
          size="compact"
          variant="secondary"
        >
          {status === "copied"
            ? t("apps.copy.copied")
            : t("apps.mail.copyPrompt")}
        </Button>
        <span aria-live="polite" className="visuallyHidden">
          {status === "copied" ? t("apps.copy.copied") : ""}
        </span>
      </div>
      <details>
        <summary>{t("apps.mail.previewPrompt")}</summary>
        <pre>{prompt}</pre>
      </details>
      {status === "error" && (
        <div className="formMessage error" role="alert">
          {t("apps.message.copyFailed")}
        </div>
      )}
    </section>
  );
}
