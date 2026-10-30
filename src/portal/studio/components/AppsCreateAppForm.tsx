import { useInstallationEndpoints } from "../../brand/PlatformBrandProvider";
import { Bot, CalendarClock, FileText, Globe2, PackagePlus, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useMemo } from "react";
import type { FormEvent, ReactNode, SetStateAction } from "react";
import { isAppsAppMcpRequiredType, isAppsAppMcpSupportedType, appsAppendableResourceTypes } from "../../../shared/appsResourceCatalog";
import type { PortalCatalog } from "../../../shared/types";
import { AccessTargetPicker, AccessTargetSelectedTags } from "../../components/AccessTargetPicker";
import { Button } from "../../components/Button";
import { WorkspaceListbox } from "../../components/WorkspaceListbox";
import { FormField, TextArea, TextInput } from "../../components/FormField";
import { useAccessTargetUsers } from "../../hooks/useAccessTargetUsers";
import { useI18n } from "../../i18n";
import { appTypeOptions, appsAccessTemplates, appsBooleanSelectOptions } from "../constants";
import {
  appsAccessModeDetail,
  appsAccessModeLabel,
  appsAppTypeDetail,
  appsAppTypeLabel,
  appsBooleanLabel
} from "../labels";
import type { CreateInput, AppsAccessMode } from "../types";
import {
  appCodeDomainPreview,
  createResourcePreviewItems,
  appsAccessTargetTree,
  nextAccessModeInput,
  nextAgentMcpInput,
  nextCreateName,
  nextCreateTypeInput,
  nextLoginRequiredInput,
  normalizeAppCode,
  resourceTypesForCreate,
  toggleCreateAccessTarget,
  toggleCustomResourceType
} from "../utils";
import { AppsCreateMailResource } from "./AppsCreateMailResource";
import {
  AppsCreateSelectPanel,
  AppsCustomResourceSelector,
  AppsResourcePreviewPanel
} from "./AppsCreateFormSections";

const appsAppTypeMarks: Partial<Record<CreateInput["type"], ReactNode>> = {
  agent_app: <Bot size={19} />,
  automation: <CalendarClock size={19} />,
  container: <SlidersHorizontal size={19} />,
  static_page: <FileText size={19} />,
  web: <Globe2 size={19} />
};

export function AppsCreateAppForm({
  catalog,
  createInput,
  onClose,
  onSubmit,
  setCreateInput,
  submitting
}: {
  catalog: PortalCatalog;
  createInput: CreateInput;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  setCreateInput: (value: SetStateAction<CreateInput>) => void;
  submitting: boolean;
}) {
  const installationEndpoints = useInstallationEndpoints();
  const { t } = useI18n();
  const { departments, state: directoryState, users: accessTargetUsers } = useAccessTargetUsers(catalog);
  const isStaticPage = createInput.type === "static_page";
  const loginRequired = createInput.loginRequired;
  const showsAccessPicker = loginRequired && createInput.accessMode === "targeted";
  const accessTargetTree = useMemo(() => appsAccessTargetTree(catalog, {
    department: t("apps.access.department"),
    unassignedDepartment: t("apps.access.unassignedDepartment")
  }, accessTargetUsers, departments), [accessTargetUsers, catalog, departments, t]);
  const accessPickerCopy = {
    collapseNodeLabel: (label: string) => t("apps.create.collapseNode", { label }),
    expandNodeLabel: (label: string) => t("apps.create.expandNode", { label }),
    noResults: t("apps.create.noTargets"),
    loadingLabel: t("apps.config.directoryLoading"),
    unavailableLabel: t("apps.config.directoryError"),
    removeTargetLabel: (label: string) => t("apps.create.removeTarget", { label }),
    requiredLabel: t("apps.create.accessTargetsRequired"),
    searchPlaceholder: t("apps.create.searchTargets"),
    selectedCountLabel: t("apps.create.accessTargetsSelected", { count: createInput.accessTargets.length }),
    selectedObjectsLabel: t("apps.create.selectedObjectsAria"),
    title: t("apps.create.accessTargetTitle"),
    validationHint: t("apps.create.validationTargets")
  };
  const plannedResources = createResourcePreviewItems(createInput);
  const accessTemplates = appsAccessTemplates.filter((option) => option.value !== "public");
  const agentMcpEnabled = isAppsAppMcpRequiredType(createInput.type)
    || (isAppsAppMcpSupportedType(createInput.type) && createInput.agentMcpEnabled);
  const showsAgentMcpRegistration = isAppsAppMcpSupportedType(createInput.type);

  return (
    <form className={showsAccessPicker ? "appsCreateForm appsModalBody withAccessPicker" : "appsCreateForm appsModalBody"} onSubmit={(event) => {
      if (showsAccessPicker && directoryState !== "ready") { event.preventDefault(); return; }
      void onSubmit(event);
    }}>
      <div className="appsCreateFormMain">
        <div className="formGrid">
          <FormField label={t("apps.create.appName")}>
            <TextInput value={createInput.name} onChange={(event) => setCreateInput((current) => nextCreateName(current, event.target.value))} />
          </FormField>
          <FormField label={t("apps.field.appCode")}>
            <TextInput
              placeholder={t("apps.create.appCodePlaceholder")}
              value={createInput.appCode}
              onChange={(event) => setCreateInput((current) => ({ ...current, appCode: normalizeAppCode(event.target.value) }))}
            />
            <strong className="appsDomainHint">{appCodeDomainPreview(createInput.appCode, installationEndpoints)}</strong>
          </FormField>
          <FormField full label={t("apps.create.note")}>
            <TextArea rows={3} value={createInput.description} onChange={(event) => setCreateInput((current) => ({ ...current, description: event.target.value }))} />
          </FormField>
        </div>

        <section className="appsTypeSection" aria-labelledby="appsCreateAppTypeTitle">
          <div className="appsSectionHeader appsTypeHeader">
            <div>
              <h3 id="appsCreateAppTypeTitle">{t("apps.create.appTypeAria")}</h3>
              <p>{t("apps.create.appTypeDescription")}</p>
            </div>
          </div>
          <div className="appsTypeGrid" role="radiogroup" aria-label={t("apps.create.appTypeAria")}>
            {appTypeOptions.map((option) => {
              const isSelected = createInput.type === option.value;
              return (
                <button
                  aria-checked={isSelected}
                  className={isSelected ? "appsTypeOption active" : "appsTypeOption"}
                  key={option.value}
                  onClick={() => setCreateInput((current) => nextCreateTypeInput(current, option.value))}
                  role="radio"
                  type="button"
                >
                  <span className={`appsTypeMark ${option.value}`} aria-hidden="true">{appsAppTypeMarks[option.value]}</span>
                  <span className="appsTypeCopy">
                    <strong>{appsAppTypeLabel(option.value, t)}</strong>
                    <span>{appsAppTypeDetail(option.value, t)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {createInput.type === "container" ? (
          <AppsCustomResourceSelector
            selectedTypes={resourceTypesForCreate(createInput)}
            onToggle={(resourceType) => setCreateInput((current) => toggleCustomResourceType(current, resourceType))}
          />
        ) : (
          <>
            <AppsResourcePreviewPanel resources={plannedResources.filter((resource) => resource.type !== "media")} />
            {appsAppendableResourceTypes(createInput.type).includes("media") && (
              <AppsCustomResourceSelector
                availableTypes={["media"]}
                selectedTypes={createInput.resourceTypes}
                showRuntimeEntry={false}
                title={t("apps.create.mediaResourcesTitle")}
                body={t("apps.create.mediaResourcesBody")}
                onToggle={(resourceType) => setCreateInput((current) => toggleCustomResourceType(current, resourceType))}
              />
            )}
          </>
        )}

        <AppsCreateMailResource input={createInput} setInput={setCreateInput} />

        {showsAgentMcpRegistration && (
          <AppsCreateSelectPanel
            control={(
              <WorkspaceListbox
                ariaLabel={t("apps.create.agentMcpAria")}
                className="appsCreateInlineListbox"
                disabled={isAppsAppMcpRequiredType(createInput.type)}
                value={agentMcpEnabled ? "yes" : "no"}
                onChange={(value) => setCreateInput((current) => nextAgentMcpInput(current, value === "yes"))}
                options={appsBooleanSelectOptions.map((option) => ({
                  label: appsBooleanLabel(option.value, t),
                  value: option.value
                }))}
              />
            )}
            description={isAppsAppMcpRequiredType(createInput.type) ? t("apps.create.agentMcpAgentDescription") : t("apps.create.agentMcpDescription")}
            label={t("apps.create.agentMcpLabel")}
            title={t("apps.create.agentMcpTitle")}
          >
            {null}
          </AppsCreateSelectPanel>
        )}

        <AppsCreateSelectPanel
          control={(
            <WorkspaceListbox
              ariaLabel={t("apps.create.loginRequiredAria")}
              className="appsCreateInlineListbox"
              value={loginRequired ? "yes" : "no"}
              onChange={(value) => setCreateInput((current) => nextLoginRequiredInput(current, value === "yes"))}
              options={appsBooleanSelectOptions.map((option) => ({
                label: appsBooleanLabel(option.value, t),
                value: option.value
              }))}
            />
          )}
            description={t("apps.create.loginRequiredDescription")}
          label={t("apps.create.loginRequiredLabel")}
          title={t("apps.create.loginRequiredTitle")}
        >
          {null}
        </AppsCreateSelectPanel>

        {loginRequired && (
          <AppsCreateSelectPanel
            control={(
              <WorkspaceListbox<AppsAccessMode>
                ariaLabel={t("apps.create.accessAria")}
                className="appsCreateInlineListbox"
                value={createInput.accessMode}
                onChange={(value) => setCreateInput((current) => nextAccessModeInput(current, value, catalog))}
                options={accessTemplates.map((option) => ({
                  description: appsAccessModeDetail(option.value, t),
                  label: appsAccessModeLabel(option.value, t),
                  value: option.value
                }))}
              />
            )}
            description={t("apps.create.accessDescription")}
            label={t("apps.create.accessLabel")}
            title={t("apps.create.accessTitle")}
          >
            {createInput.accessMode === "targeted" && (
              <div className="appsAccessTargetSummaryPanel">
                <div>
                  <strong>{t("apps.create.accessTargetTitle")}</strong>
                  <small>{createInput.accessTargets.length > 0 ? t("apps.create.accessTargetsSelected", { count: createInput.accessTargets.length }) : t("apps.create.accessTargetsRequired")}</small>
                </div>
                <AccessTargetSelectedTags
                  copy={accessPickerCopy}
                  emptyLabel={t("apps.create.validationTargets")}
                  nodes={accessTargetTree}
                  onRemove={(value) => setCreateInput((current) => toggleCreateAccessTarget(current, value))}
                  selectedValues={createInput.accessTargets}
                />
              </div>
            )}

            {createInput.accessMode === "private" && (
              <div className="appsPrivateAccessNote">
                <ShieldCheck size={15} />
                {t("apps.create.collaboratorsOwnerNote")}
              </div>
            )}
          </AppsCreateSelectPanel>
        )}

        {!isStaticPage && (
          <AppsCreateSelectPanel
            control={(
              <WorkspaceListbox
                ariaLabel={t("apps.create.llmAria")}
                className="appsCreateInlineListbox"
                value={createInput.llmEnabled ? "yes" : "no"}
                onChange={(value) => setCreateInput((current) => ({ ...current, llmEnabled: value === "yes" }))}
                options={appsBooleanSelectOptions.map((option) => ({
                  label: appsBooleanLabel(option.value, t),
                  value: option.value
                }))}
              />
            )}
            description={t("apps.create.llmDescription")}
            label={t("apps.create.llmLabel")}
            title={t("apps.create.llmTitle")}
          >
            {null}
          </AppsCreateSelectPanel>
        )}

        <div className="formActions">
          <Button disabled={submitting} onClick={onClose} variant="secondary">
            {t("apps.create.cancel")}
          </Button>
          <Button disabled={showsAccessPicker && directoryState !== "ready"} iconBefore={<PackagePlus size={16} />} isLoading={submitting} type="submit" variant="primary">
            {submitting ? t("apps.create.creating") : t("apps.create.submit")}
          </Button>
        </div>
      </div>

      {showsAccessPicker && (
        <aside className="appsCreateAccessPickerPane">
          <AccessTargetPicker
            copy={accessPickerCopy}
            nodes={accessTargetTree}
            onSelectionChange={(values) => setCreateInput((current) => ({ ...current, accessTargets: values }))}
            selectedValues={createInput.accessTargets}
            state={directoryState}
          />
        </aside>
      )}
    </form>
  );
}
