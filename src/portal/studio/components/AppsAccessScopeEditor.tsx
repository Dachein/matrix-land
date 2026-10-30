import { Check, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { PortalCatalog } from "../../../shared/types";
import { AccessTargetPicker, AccessTargetSelectedTags } from "../../components/AccessTargetPicker";
import { Button } from "../../components/Button";
import { WorkspaceListbox } from "../../components/WorkspaceListbox";
import { useAccessTargetUsers } from "../../hooks/useAccessTargetUsers";
import { useI18n } from "../../i18n";
import { appsAccessTemplates, appsBooleanSelectOptions } from "../constants";
import { appsAccessModeDetail, appsAccessModeLabel, appsBooleanLabel } from "../labels";
import type { AppsAccessInput, AppsAccessMode } from "../types";
import { appsAccessTargetTree } from "../utils";

export function AppsAccessScopeEditor({
  access,
  catalog,
  children,
  entityType,
  error,
  onModeChange,
  onLoginRequiredChange,
  loginRequiredLocked = false,
  onSave,
  onTargetedModeChange,
  onTargetsChange,
  saving
}: {
  access: AppsAccessInput;
  catalog: PortalCatalog;
  children?: ReactNode;
  entityType: "app" | "skill";
  error: string;
  onModeChange: (mode: AppsAccessMode) => void;
  onLoginRequiredChange?: (required: boolean) => void;
  loginRequiredLocked?: boolean;
  onSave: () => Promise<boolean>;
  onTargetedModeChange?: (active: boolean) => void;
  onTargetsChange: (values: string[]) => void;
  saving: boolean;
}) {
  const { t } = useI18n();
  const [isTargetPickerOpen, setIsTargetPickerOpen] = useState(false);
  const { departments, state: directoryState, users } = useAccessTargetUsers(catalog);
  const accessTargetTree = useMemo(() => appsAccessTargetTree(catalog, {
    department: t("apps.access.department"),
    unassignedDepartment: t("apps.access.unassignedDepartment")
  }, users, departments), [catalog, departments, t, users]);
  const loginRequired = entityType === "skill" || access.loginRequired;
  const isTargeted = loginRequired && access.accessMode === "targeted";
  const showTargetPicker = isTargeted && isTargetPickerOpen;
  const options = appsAccessTemplates.filter((option) => option.value !== "public");
  const accessPickerCopy = {
    collapseNodeLabel: (label: string) => t("apps.create.collapseNode", { label }),
    expandNodeLabel: (label: string) => t("apps.create.expandNode", { label }),
    noResults: t("apps.create.noTargets"),
    loadingLabel: t("apps.config.directoryLoading"),
    unavailableLabel: t("apps.config.directoryError"),
    removeTargetLabel: (label: string) => t("apps.create.removeTarget", { label }),
    requiredLabel: t("apps.create.accessTargetsRequired"),
    searchPlaceholder: t("apps.create.searchTargets"),
    selectedCountLabel: t("apps.create.accessTargetsSelected", { count: access.accessTargets.length }),
    selectedObjectsLabel: t("apps.create.selectedObjectsAria"),
    title: t("apps.create.accessTargetTitle"),
    validationHint: t("apps.create.validationTargets")
  };
  const saveDisabled = saving || (isTargeted && directoryState !== "ready");

  async function saveAccess() {
    const saved = await onSave();
    if (saved) {
      setIsTargetPickerOpen(false);
    }
  }

  useEffect(() => {
    onTargetedModeChange?.(showTargetPicker);
  }, [onTargetedModeChange, showTargetPicker]);

  useEffect(() => {
    if (!isTargeted) {
      setIsTargetPickerOpen(false);
    }
  }, [isTargeted]);

  useEffect(() => {
    return () => onTargetedModeChange?.(false);
  }, [onTargetedModeChange]);

  return (
    <div className={`appsAccessSettingsWorkspace${showTargetPicker ? " withAccessPicker" : ""}`}>
      <div className="appsAccessSettingsFormColumn">
        <section className={`assetDetailSection appsAccessConfigSection${isTargeted ? " isTargeted" : ""}`}>
          <div className="appsAccessSettingsMain">
            <header className="appsAccessSettingsHeader">
              <div>
                <h3>{t("apps.config.accessTitle")}</h3>
                <p>{entityType === "skill" ? t("apps.config.skillAccessBody") : t("apps.config.accessBody")}</p>
              </div>
              <span>{entityType === "skill" ? t("apps.config.skillLabel") : t("apps.config.appLabel")}</span>
            </header>

            {entityType === "app" && (
              <div className="appsAccessLoginControl">
                <div>
                  <strong>{t("apps.config.loginRequiredTitle")}</strong>
                  <small>{t("apps.config.loginRequiredDescription")}</small>
                </div>
                <WorkspaceListbox
                  ariaLabel={t("apps.config.loginRequiredTitle")}
                  disabled={saving || loginRequiredLocked}
                  value={loginRequired ? "yes" : "no"}
                  onChange={(value) => onLoginRequiredChange?.(value === "yes")}
                  options={appsBooleanSelectOptions.map((option) => ({
                    label: appsBooleanLabel(option.value, t),
                    value: option.value
                  }))}
                />
              </div>
            )}

            {loginRequired && <div aria-label={t("apps.config.accessMode")} className="appsAccessModeGrid" role="radiogroup">
              {options.map((option) => {
                const selected = access.accessMode === option.value;

                return (
                  <button
                    aria-checked={selected}
                    className={`appsAccessTemplateOption appsAccessModeOption${selected ? " active" : ""}`}
                    disabled={saving}
                    key={option.value}
                    onClick={() => {
                      setIsTargetPickerOpen(option.value === "targeted");
                      onModeChange(option.value);
                    }}
                    role="radio"
                    type="button"
                  >
                    <span aria-hidden="true" className="appsAccessModeIndicator">{selected ? <Check size={13} /> : null}</span>
                    <span className="appsAccessModeCopy">
                      <strong>{appsAccessModeLabel(option.value, t)}</strong>
                      <span>{appsAccessModeDetail(option.value, t)}</span>
                    </span>
                  </button>
                );
              })}
            </div>}

            {isTargeted && (
              <div className="appsAccessTargetSummaryPanel">
                <div className="appsAccessTargetSummaryHeader">
                  <div>
                    <strong>{t("apps.create.accessTargetTitle")}</strong>
                    <small>{access.accessTargets.length > 0 ? t("apps.create.accessTargetsSelected", { count: access.accessTargets.length }) : t("apps.create.accessTargetsRequired")}</small>
                  </div>
                  {!showTargetPicker && (
                    <Button onClick={() => setIsTargetPickerOpen(true)} size="compact" variant="secondary">
                      {t("apps.config.editTargets")}
                    </Button>
                  )}
                </div>
                <AccessTargetSelectedTags
                  copy={accessPickerCopy}
                  emptyLabel={t("apps.create.validationTargets")}
                  nodes={accessTargetTree}
                  onRemove={(value) => onTargetsChange(access.accessTargets.filter((target) => target !== value))}
                  selectedValues={access.accessTargets}
                />
              </div>
            )}

            {loginRequired && access.accessMode === "private" && (
              <div className="appsPrivateAccessNote">
                <ShieldCheck aria-hidden="true" size={15} />
                {entityType === "app" ? t("apps.create.collaboratorsOwnerNote") : t("apps.create.collaboratorsNote")}
              </div>
            )}

            {isTargeted && directoryState === "loading" && <div className="appsAccessDirectoryState" role="status">{t("apps.config.directoryLoading")}</div>}
            {isTargeted && directoryState === "error" && <div className="formMessage error">{t("apps.config.directoryError")}</div>}
            {error && <div className="formMessage error">{error}</div>}

            <div className="formActions appsAccessSettingsActions">
              <Button disabled={saveDisabled} isLoading={saving} onClick={() => void saveAccess()} size="compact" variant="primary">
                {saving ? t("apps.editor.saving") : t("apps.config.saveAccess")}
              </Button>
            </div>
          </div>
        </section>

        {children}
      </div>

      {showTargetPicker && (
        <aside className="appsAccessPickerPane">
          <div className="appsAccessPickerPaneHeader">
            <Button onClick={() => setIsTargetPickerOpen(false)} size="compact" variant="secondary">
              {t("apps.config.finishTargets")}
            </Button>
          </div>
          {directoryState === "error" ? (
            <div className="appsAccessPickerUnavailable">
              <strong>{t("apps.config.directoryUnavailableTitle")}</strong>
              <p>{t("apps.config.directoryError")}</p>
            </div>
          ) : (
            <AccessTargetPicker
              copy={accessPickerCopy}
              nodes={accessTargetTree}
              onSelectionChange={onTargetsChange}
              selectedValues={access.accessTargets}
              state={directoryState}
            />
          )}
        </aside>
      )}
    </div>
  );
}
