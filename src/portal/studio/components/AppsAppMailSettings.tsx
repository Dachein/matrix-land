import { Mail } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppsApp } from "../../../shared/types";
import { Button } from "../../components/Button";
import { useI18n } from "../../i18n";
import type { AppsAppConfigInput } from "../types";
import { AppsCapabilityCard } from "./AppsCapabilityCard";
import { AppsMailDevelopmentGuide } from "./AppsMailDevelopmentGuide";

export function AppsAppMailSettings({
  app,
  onConfigUpdate,
}: {
  app: AppsApp;
  onConfigUpdate: (input: AppsAppConfigInput) => Promise<AppsApp | undefined>;
}) {
  const { t } = useI18n();
  const enabled = app.resources.some(
    (r) => r.type === "email_sending" || r.type === "email_routing",
  );
  const address =
    app.manifest.email?.routing.address ||
    app.manifest.email?.sending.senderMailbox ||
    "";
  const [editing, setEditing] = useState(false),
    [prefix, setPrefix] = useState(""),
    [trigger, setTrigger] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setPrefix(address.split("@")[0] || app.appCode);
    setTrigger(app.manifest.email?.routing.triggerEnabled === true);
    setEditing(false);
    setError("");
  }, [
    app.id,
    address,
    app.appCode,
    app.manifest.email?.routing.triggerEnabled,
  ]);
  async function save(nextEnabled: boolean) {
    setSaving(true);
    setError("");
    try {
      const result = await onConfigUpdate({
        emailEnabled: nextEnabled,
        emailPrefix: prefix.trim().toLowerCase(),
        emailTriggerEnabled: nextEnabled && trigger,
      });
      if (!result) throw Error();
      setEditing(false);
    } catch {
      setError(t("apps.mail.saveFailed"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <AppsCapabilityCard
      icon={<Mail size={17} />}
      title={t("apps.mail.title")}
      description={t("apps.mail.body")}
      statusLabel={
        enabled ? t("apps.config.enabled") : t("apps.config.disabled")
      }
      statusTone={enabled ? "enabled" : "neutral"}
      action={
        <Button
          size="compact"
          disabled={saving}
          onClick={() => setEditing((v) => !v)}
          variant={enabled ? "secondary" : "primary"}
        >
          {editing
            ? t("apps.editor.cancel")
            : enabled
              ? t("apps.mail.configure")
              : t("apps.mail.enable")}
        </Button>
      }
    >
      {enabled && (
        <div className="assetDetailGrid appsCapabilityDetails">
          <div className="assetDetailItem wide">
            <span>{t("apps.mail.address")}</span>
            <strong>{address}</strong>
            <small>
              {app.manifest.email?.routing.triggerEnabled
                ? t("apps.mail.triggerOn")
                : t("apps.mail.triggerOff")}
            </small>
          </div>
        </div>
      )}
      {editing && (
        <form
          className="appsCapabilitySetupForm"
          onSubmit={(event) => {
            event.preventDefault();
            void save(true);
          }}
        >
          <label>
            <span>{t("apps.mail.prefix")}</span>
            <div className="appsEmailAddressInput">
              <input
                required
                maxLength={64}
                pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*"
                disabled={saving}
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
              />
              <span>@mail.example.invalid</span>
            </div>
          </label>
          <label className="appsMailTriggerOption">
            <input
              type="checkbox"
              checked={trigger}
              disabled={saving}
              onChange={(event) => setTrigger(event.target.checked)}
            />
            <span>{t("apps.mail.trigger")}</span>
            <small>{t("apps.mail.triggerHelp")}</small>
          </label>
          <div className="formActions">
            <Button
              type="submit"
              size="compact"
              variant="primary"
              isLoading={saving}
            >
              {t("apps.mail.save")}
            </Button>
            {enabled && (
              <Button
                size="compact"
                disabled={saving}
                onClick={() => void save(false)}
              >
                {t("apps.mail.disable")}
              </Button>
            )}
          </div>
        </form>
      )}
      {enabled && <AppsMailDevelopmentGuide app={app} embedded />}
      {error && (
        <div role="alert" className="formMessage error">
          {error}
        </div>
      )}
    </AppsCapabilityCard>
  );
}
