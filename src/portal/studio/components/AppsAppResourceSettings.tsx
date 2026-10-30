import { Check, Layers3, Plus } from "lucide-react";
import { useState } from "react";
import {
  appsAppendableResourceTypes,
  appsResourceDefinitions,
  type AppsProvisionedResourceType
} from "../../../shared/appsResourceCatalog";
import type { AppsApp } from "../../../shared/types";
import { Button } from "../../components/Button";
import { useI18n } from "../../i18n";
import { appsResourceDetail, appsResourceLabel, appsResourceStatusLabel } from "../labels";
import type { AppsAppConfigInput } from "../types";
import { AppsCapabilityCard } from "./AppsCapabilityCard";

export function AppsAppResourceSettings({
  app,
  onConfigUpdate
}: {
  app: AppsApp;
  onConfigUpdate: (input: AppsAppConfigInput) => Promise<AppsApp | undefined>;
}) {
  const { t } = useI18n();
  const [savingType, setSavingType] = useState<AppsProvisionedResourceType>();
  const [error, setError] = useState("");
  const definitions = appsResourceDefinitions([...appsAppendableResourceTypes(app.type)]);
  const existingByType = new Map(app.resources.map((resource) => [resource.type, resource]));
  const addedCount = definitions.filter((definition) => existingByType.has(definition.type)).length;

  if (definitions.length === 0) {
    return null;
  }

  async function addResource(resourceType: AppsProvisionedResourceType) {
    if (existingByType.has(resourceType) || savingType) {
      return;
    }
    setError("");
    setSavingType(resourceType);
    try {
      const updated = await onConfigUpdate({ addResourceTypes: [resourceType] });
      if (!updated) {
        throw new Error("apps_resource_append_failed");
      }
    } catch {
      setError(t("apps.config.resourceAddFailed"));
    } finally {
      setSavingType(undefined);
    }
  }

  return (
    <AppsCapabilityCard
      className="appsAppResourceSettings"
      description={t("apps.config.resourcesBody")}
      icon={<Layers3 size={17} />}
      statusLabel={t("apps.config.resourcesCount", { added: addedCount, total: definitions.length })}
      statusTone={addedCount > 0 ? "enabled" : "neutral"}
      title={t("apps.config.resourcesTitle")}
    >
      <div className="appsAppResourceGrid">
        {definitions.map((definition) => {
          const existing = existingByType.get(definition.type);
          const saving = savingType === definition.type;
          return (
            <article className={existing ? "appsAppResourceItem is-added" : "appsAppResourceItem"} key={definition.type}>
              <span aria-hidden="true" className="appsAppResourceMark">
                {existing ? <Check size={14} /> : <Plus size={14} />}
              </span>
              <div className="appsAppResourceCopy">
                <strong>{appsResourceLabel(definition.type, t)}</strong>
                <small>{appsResourceDetail(definition.type, definition.detail, t)}</small>
                {existing && (
                  <span>{appsResourceStatusLabel(existing.status, existing.environment, t)}</span>
                )}
              </div>
              {existing ? (
                <span className="appsAppResourceLocked">{t("apps.config.resourceAdded")}</span>
              ) : (
                <Button
                  disabled={Boolean(savingType)}
                  isLoading={saving}
                  onClick={() => void addResource(definition.type)}
                  size="compact"
                  variant="primary"
                >
                  {t("apps.config.resourceAdd")}
                </Button>
              )}
            </article>
          );
        })}
      </div>
      <p className="appsCapabilityHelp">{t("apps.config.resourcesBindingHelp")}</p>
      {error && <div aria-live="polite" className="formMessage error">{error}</div>}
    </AppsCapabilityCard>
  );
}
