import type { SetStateAction } from "react";
import { useI18n } from "../../i18n";
import type { CreateInput } from "../types";
import { AppsCreateSelectPanel } from "./AppsCreateFormSections";

export function AppsCreateMailResource({
  input,
  setInput,
}: {
  input: CreateInput;
  setInput: (value: SetStateAction<CreateInput>) => void;
}) {
  const { t } = useI18n();
  return (
    <AppsCreateSelectPanel
      label={t("apps.mail.title")}
      title={t("apps.mail.title")}
      description={t("apps.mail.body")}
      control={
        <label>
          <input
            type="checkbox"
            checked={input.emailEnabled === true}
            onChange={(event) =>
              setInput((current) => ({
                ...current,
                emailEnabled: event.target.checked,
                emailTriggerEnabled:
                  event.target.checked && current.emailTriggerEnabled,
              }))
            }
          />
          <span>{t("apps.mail.enable")}</span>
        </label>
      }
    >
      {input.emailEnabled && (
        <div className="appsCapabilitySetupForm">
          <label>
            <span>{t("apps.mail.prefix")}</span>
            <div className="appsEmailAddressInput">
              <input
                required
                maxLength={64}
                pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*"
                placeholder={input.appCode}
                value={input.emailPrefix ?? input.appCode}
                onChange={(event) =>
                  setInput((current) => ({
                    ...current,
                    emailPrefix: event.target.value,
                  }))
                }
              />
              <span>@mail.example.invalid</span>
            </div>
            <small>{t("apps.mail.createHelp")}</small>
          </label>
          <label className="appsMailTriggerOption">
            <input
              type="checkbox"
              checked={input.emailTriggerEnabled === true}
              onChange={(event) =>
                setInput((current) => ({
                  ...current,
                  emailTriggerEnabled: event.target.checked,
                }))
              }
            />
            <span>{t("apps.mail.trigger")}</span>
            <small>{t("apps.mail.triggerHelp")}</small>
          </label>
        </div>
      )}
    </AppsCreateSelectPanel>
  );
}
