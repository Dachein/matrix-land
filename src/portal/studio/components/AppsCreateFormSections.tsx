import { Check } from "lucide-react";
import type { ReactNode } from "react";
import {
  APPS_CUSTOM_OPTIONAL_RESOURCE_TYPES,
  appsResourceDefinitions,
  type AppsProvisionedResourceDefinition,
  type AppsProvisionedResourceType
} from "../../../shared/appsResourceCatalog";
import { AccessTargetPicker, type AccessTargetPickerNode } from "../../components/AccessTargetPicker";
import { useI18n } from "../../i18n";
import { appsResourceDetail, appsResourceLabel } from "../labels";

export function AppsCreateSelectPanel({
  children,
  control,
  description,
  label,
  title
}: {
  children: ReactNode;
  control?: ReactNode;
  description: string;
  label: string;
  title: string;
}) {
  return (
    <section aria-label={label} className="appsCreateSelectPanel">
      <div className="appsCreateSelectPanelHeader">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {control}
      </div>
      {children && (
        <div className="appsCreateSelectPanelChildren">
          {children}
        </div>
      )}
    </section>
  );
}

export function AppsResourcePreviewPanel({ resources }: { resources: AppsProvisionedResourceDefinition[] }) {
  const { t } = useI18n();

  return (
    <section className="appsCreateResourcePreviewPanel">
      <div className="appsSectionHeader">
        <div>
          <h3>{t("apps.create.resourcesTitle")}</h3>
          <p>{t("apps.create.resourcesBody")}</p>
        </div>
        <span>{t("apps.create.itemCount", { count: resources.length })}</span>
      </div>
      <div className="appsCreateResourcePreviewGrid">
        {resources.map((resource) => (
          <article className="appsCreateResourcePreviewItem" key={resource.type}>
            <span className="appsCreateResourcePreviewCheck"><Check size={14} /></span>
            <div>
              <strong>{appsResourceLabel(resource.type, t)}</strong>
              <small>{appsResourceDetail(resource.type, resource.detail, t)}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function AppsCustomResourceSelector({
  availableTypes,
  lockedTypes = [],
  onToggle,
  selectedTypes,
  showRuntimeEntry = true,
  body,
  title
}: {
  availableTypes?: readonly AppsProvisionedResourceType[];
  lockedTypes?: readonly AppsProvisionedResourceType[];
  onToggle: (resourceType: AppsProvisionedResourceType) => void;
  selectedTypes: AppsProvisionedResourceType[];
  showRuntimeEntry?: boolean;
  body?: string;
  title?: string;
}) {
  const { t } = useI18n();
  const selected = new Set(selectedTypes);
  const locked = new Set(lockedTypes);
  const runtimeResources = appsResourceDefinitions(["worker"]);
  const optionalResourceTypes = availableTypes ?? APPS_CUSTOM_OPTIONAL_RESOURCE_TYPES;
  const optionalResources = appsResourceDefinitions([...optionalResourceTypes]);
  const selectedOptionalCount = optionalResources.filter((resource) => selected.has(resource.type)).length;

  return (
    <section className="appsCreateResourcePreviewPanel">
      <div className="appsSectionHeader">
        <div>
          <h3>{title ?? t("apps.create.customResourcesTitle")}</h3>
          <p>{body ?? t("apps.create.customResourcesBody")}</p>
        </div>
        <span>{t("apps.create.itemCount", { count: showRuntimeEntry ? selectedTypes.length : selectedOptionalCount })}</span>
      </div>

      {showRuntimeEntry && (
        <div className="appsCreateResourceSelectGroup">
          <h4>{t("apps.create.runtimeEntry")}</h4>
          <div className="appsCreateResourcePreviewGrid">
            {runtimeResources.map((resource) => (
              <article className="appsCreateResourcePreviewItem" key={resource.type}>
                <span className="appsCreateResourcePreviewCheck"><Check size={14} /></span>
                <div>
                  <strong>{appsResourceLabel(resource.type, t)}</strong>
                  <small>{appsResourceDetail(resource.type, resource.detail, t)}</small>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {showRuntimeEntry && (
        <div className="appsCreateComingSoonOption" aria-disabled="true">
          <label>
            <input checked={false} disabled type="checkbox" />
            <span>{t("apps.create.previewChannel")}</span>
          </label>
          <small>{t("apps.create.previewComingSoon")}</small>
        </div>
      )}

      <div className="appsCreateResourceSelectGroup">
        <h4>{t("apps.create.optionalResources")}</h4>
        <div className="appsCreateResourcePreviewGrid">
          {optionalResources.map((resource) => {
            const isSelected = selected.has(resource.type);
            const isLocked = locked.has(resource.type);
            return (
              <button
                aria-pressed={isSelected}
                className={`appsCreateResourceSelectItem${isSelected ? " active" : ""}${isLocked ? " locked" : ""}`}
                disabled={isLocked}
                key={resource.type}
                onClick={() => onToggle(resource.type)}
                type="button"
              >
                <span className="appsCreateResourceSelectIndicator">{isSelected ? <Check size={14} /> : null}</span>
                <div>
                  <strong>{appsResourceLabel(resource.type, t)}</strong>
                  <small>{appsResourceDetail(resource.type, resource.detail, t)}</small>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function AppsAccessTargetTreePicker({
  nodes,
  onToggle,
  selectedValues
}: {
  nodes: AccessTargetPickerNode[];
  onToggle: (value: string) => void;
  selectedValues: string[];
}) {
  const { t } = useI18n();

  return (
    <AccessTargetPicker
      className="appsAccessTargetsPanel"
      copy={{
        collapseNodeLabel: (label) => t("apps.create.collapseNode", { label }),
        expandNodeLabel: (label) => t("apps.create.expandNode", { label }),
        noResults: t("apps.create.noTargets"),
        removeTargetLabel: (label) => t("apps.create.removeTarget", { label }),
        requiredLabel: t("apps.create.accessTargetsRequired"),
        searchPlaceholder: t("apps.create.searchTargets"),
        selectedCountLabel: t("apps.create.accessTargetsSelected", { count: selectedValues.length }),
        selectedObjectsLabel: t("apps.create.selectedObjectsAria"),
        title: t("apps.create.accessTargetTitle"),
        validationHint: t("apps.create.validationTargets")
      }}
      nodes={nodes}
      onSelectionChange={(values) => syncToggleSelection(selectedValues, values, onToggle)}
      selectedValues={selectedValues}
    />
  );
}

function syncToggleSelection(currentValues: string[], nextValues: string[], onToggle: (value: string) => void) {
  const current = new Set(currentValues);
  const next = new Set(nextValues);

  nextValues.forEach((value) => {
    if (!current.has(value)) {
      onToggle(value);
    }
  });

  currentValues.forEach((value) => {
    if (!next.has(value)) {
      onToggle(value);
    }
  });
}
