import { useInstallationEndpoints } from "../../brand/PlatformBrandProvider";
import { ensureMateMailDocument, setMateMailContent, mateMailContent } from "../../../shared/mateMail";
import { ArrowUpRight, Bot, Check, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { DEFAULT_MATE_MCP_CAPACITY, MATE_MCP_CAPACITY_CHILDREN, mateMcpCapacityConfigurableChildren, migrateLegacyMateMcpCapacity, selectMateCapacityChildren, type MateMcpCapacity, type MateMcpCapacityGroup } from "../../../shared/mateMcpCapacity";
import {
  WORKSPACE_DEFAULT_BUILT_IN_TOOL_IDS,
  normalizeMateCodeDraft,
  mateCodeFromWorkEmail,
  mateWorkEmail,
  withWorkspaceIntrinsicBuiltInToolIds,
  type WorkspaceAgentRuntimeManifest,
  type Mate,
  type MateDocument,
  type MateVisibility
} from "../../../shared/mate";
import type { PortalCatalog } from "../../../shared/types";
import { AccessTargetPicker, AccessTargetSelectedTags } from "../../components/AccessTargetPicker";
import { Button, ButtonLink } from "../../components/Button";
import { WorkspaceListbox } from "../../components/WorkspaceListbox";
import { WorkspaceMultiListbox } from "../../components/WorkspaceMultiListbox";
import { FormField, TextArea, TextInput } from "../../components/FormField";
import { ModalShell } from "../../components/ModalShell";
import { useAccessTargetUsers } from "../../hooks/useAccessTargetUsers";
import { useI18n } from "../../i18n";
import { knowledgeFetch } from "../../knowledge/utils";
import { fetchGatewayAccess } from "../../token/apiClient";
import type { GatewayModelOption } from "../../token/types";
import { AppsApiError, appsApiFetch } from "../apiClient";
import { AppsCreateSelectPanel } from "../components/AppsCreateFormSections";
import { MateAvatarChoices, defaultMateAvatarUrl } from "../components/MateAvatarChoices";
import type { MateCreateInput } from "../types";
import { MatePlugins } from '../components/MatePlugins';
import { isCurrentAppsOwner } from '../productDetailModels';
import { appsAccessTargetTree, nextMateIdentityName } from "../utils";

const ALL_RESOURCES_VALUE = "__all__";

const initialInput: MateCreateInput = {
  mcpCapacity: structuredClone(DEFAULT_MATE_MCP_CAPACITY),
  allAppMcp: false,
  allFolderEdit: false,
  allKnowledgeServices: false,
  allowedModels: ["cf-openai-gpt-6-luna"],
  appMcpBindings: [],
  avatarUrl: "",
  builtInToolIds: [...WORKSPACE_DEFAULT_BUILT_IN_TOOL_IDS, "ocr", "document_read", "artifact_create"],
  defaultTimezone: "UTC",
  description: "",
  displayName: "",
  emailEnabled: false,
  embeddedEnabled: true,
  workspacePassMcpEnabled: false,
  jobRole: "",
  knowledgeServiceIds: [],
  folderEditIds: [],
  standaloneEnabled: true,
  taskModeEnabled: false,
  targetIds: [],
  mateCallEnabled: false,
  visibility: "private",
  workEmail: ""
};

type AppMcpOption = {
  appId: string;
  description?: string;
  manifestVersion?: string;
  name: string;
};

type KnowledgeServiceOption = {
  description?: string;
  effectiveRole?: string;
  id?: string;
  name?: string;
  serviceId?: string;
};

type EditableFolderOption = {
  id: string;
  name: string;
  path: string;
  parentPath: string;
  objectKind: string;
  capabilities?: { canEdit?: boolean };
};

export function MateBuilderModal({
  catalog,
  onClose,
  onCreate,
  onDeployPreview,
  onPublish,
  onSaveDraft,
  onUpdateIdentity,
  submitting,
  mate
}: {
  catalog: PortalCatalog;
  onClose: () => void;
  onCreate: (input: Record<string, unknown>) => Promise<Mate | undefined>;
  onDeployPreview: (mate: Mate) => Promise<Mate | undefined>;
  onPublish: (mate: Mate, releaseId: string) => Promise<Mate | undefined>;
  onSaveDraft: (mate: Mate, manifest: unknown, documents: unknown) => Promise<Mate | undefined>;
  onUpdateIdentity: (mate: Mate, input: MateCreateInput) => Promise<Mate | undefined>;
  submitting: boolean;
  mate?: Mate;
}) {
  const { t, locale } = useI18n();
  const {mateEmailDomain} = useInstallationEndpoints();
  const [pluginsChanged, setPluginsChanged] = useState(false);
  const manifest = mate?.draftManifest;
  const [input, setInput] = useState<MateCreateInput>(() => mateInput(mate));
  const [soul, setSoul] = useState(() => documentContent(mate?.draftDocuments, "soul"));
  const [inboxPrompt, setInboxPrompt] = useState(() => manifest ? mateMailContent(manifest, mate?.draftDocuments ?? [], mate?.isDefault) : "");
  const [handbook, setHandbook] = useState(() => documentContent(mate?.draftDocuments, "handbook"));
  const [appOptions, setAppOptions] = useState<AppMcpOption[]>([]);
  const [knowledgeOptions, setKnowledgeOptions] = useState<KnowledgeServiceOption[]>([]);
  const [folderOptions, setFolderOptions] = useState<EditableFolderOption[]>([]);
  const [modelOptions, setModelOptions] = useState<GatewayModelOption[]>([]);
  const [resourceErrors, setResourceErrors] = useState<string[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(true);
  const [emailError, setEmailError] = useState("");
  const [validationError, setValidationError] = useState("");
  const [busy, setBusy] = useState(false);
  const { departments, state: directoryState, users: accessTargetUsers } = useAccessTargetUsers(catalog);
  const accessTargetTree = useMemo(() => appsAccessTargetTree(catalog, {
    department: t("apps.access.department"),
    unassignedDepartment: t("apps.access.unassignedDepartment")
  }, accessTargetUsers, departments), [accessTargetUsers, catalog, departments, t]);
  const selectedAppIds = input.appMcpBindings.map((binding) => binding.appId);
  const appMcpEnabled = input.allAppMcp || selectedAppIds.length > 0;
  const knowledgeQueryEnabled = input.allKnowledgeServices || input.knowledgeServiceIds.length > 0;
  const knowledgeEditEnabled = input.allFolderEdit || Boolean(input.folderEditIds?.length);
  const editing = Boolean(mate);
  const definitionReady = Boolean(mate && manifest);
  const currentLinkPath = mate ? mateStandaloneHostPath(mate.id) : "";
  const currentLinkUrl = currentLinkPath ? absolutePortalUrl(currentLinkPath) : "";
  const showsAccessPicker = input.visibility === "targets";
  const accessPickerCopy = {
    collapseNodeLabel: (label: string) => t("apps.create.collapseNode", { label }),
    expandNodeLabel: (label: string) => t("apps.create.expandNode", { label }),
    noResults: t("apps.create.noTargets"),
    loadingLabel: t("apps.config.directoryLoading"),
    unavailableLabel: t("apps.config.directoryError"),
    removeTargetLabel: (label: string) => t("apps.create.removeTarget", { label }),
    requiredLabel: t("apps.create.accessTargetsRequired"),
    searchPlaceholder: t("apps.create.searchTargets"),
    selectedCountLabel: t("apps.create.accessTargetsSelected", { count: input.targetIds.length }),
    selectedObjectsLabel: t("apps.create.selectedObjectsAria"),
    title: t("apps.create.accessTargetTitle"),
    validationHint: t("apps.create.validationTargets")
  };

  useEffect(() => {
    let cancelled = false;
    setResourcesLoading(true);
    setResourceErrors([]);
    void Promise.allSettled([
      appsApiFetch<{ apps?: AppMcpOption[] }>("/mcp-apps", catalog),
      knowledgeFetch<{ services?: KnowledgeServiceOption[] }>("/api/knowledge-services?view=card"),
      fetchGatewayAccess(),
      knowledgeFetch<{ items?: EditableFolderOption[] }>("/api/editable-folders")
    ]).then(([appsResult, knowledgeResult, modelsResult, foldersResult]) => {
      if (cancelled) return;
      const errors: string[] = [];
      if (appsResult.status === "fulfilled") {
        const apps = normalizeAppOptions(appsResult.value.apps);
        setAppOptions(apps);
        setInput((current) => current.workspacePassMcpEnabled ? {
          ...current, allAppMcp: true, appMcpBindings: [], workspacePassMcpEnabled: false
        } : current);
      }
      else errors.push(t("apps.mate.appResourcesLoadFailed"));
      if (knowledgeResult.status === "fulfilled") setKnowledgeOptions(normalizeKnowledgeOptions(knowledgeResult.value.services));
      else errors.push(t("apps.mate.knowledgeResourcesLoadFailed"));
      if (modelsResult.status === "fulfilled") setModelOptions(normalizeModelOptions(modelsResult.value.modelOptions));
      else errors.push(t("apps.mate.modelsLoadFailed"));
      if (foldersResult.status === "fulfilled") {
        const items = foldersResult.value.items;
        setFolderOptions((Array.isArray(items) ? items : []).filter((item) => item
          && typeof item.id === "string" && item.id.length > 0
          && typeof item.name === "string" && typeof item.path === "string"
          && item.parentPath === ""
          && item.objectKind === "folder" && item.capabilities?.canEdit === true));
      } else errors.push(t("apps.mate.folderResourcesLoadFailed"));
      setResourceErrors(errors);
      setResourcesLoading(false);
    });
    return () => { cancelled = true; };
  }, [catalog, t]);

  async function saveAndPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (input.visibility === "targets" && directoryState !== "ready") {
      setValidationError(t("apps.config.directoryError"));
      return;
    }
    if (pluginsChanged) { setValidationError(locale === 'zh-CN' ? '插件已发布更新，请关闭并重新打开设置后再保存其它修改。' : 'Plugins changed. Reopen settings before saving other changes.'); return; }
    if (input.visibility === "targets" && input.targetIds.length === 0) {
      setValidationError(t("apps.mate.targetsRequired"));
      return;
    }
    if (input.taskModeEnabled && !input.emailEnabled && !input.mateCallEnabled) {
      setValidationError(t("apps.mate.taskEntryRequired"));
      return;
    }
    setValidationError("");
    setEmailError("");
    if (mate && !manifest) {
      setValidationError(t("apps.mate.loadFailed"));
      return;
    }
    setBusy(true);
    try {
      if (!mate) {
        const created = await onCreate(input);
        if (!created) return;
        await onDeployPreview(created);
        // Creation is already durable at this point. Close even when Preview
        // deployment fails so a retry never attempts to create the same Code
        // a second time; the newly created Mate remains available in My APPS.
        onClose();
        return;
      }
      if (!manifest) return;

      const identity = await onUpdateIdentity(mate, input);
      if (!identity?.draftManifest) return;
      const definition = await nextDefinition(identity, identity.draftManifest, input, soul, handbook, inboxPrompt);
      const saved = await onSaveDraft(identity, definition.manifest, definition.documents);
      if (!saved) return;
      const deployed = await onDeployPreview(saved);
      if (deployed) onClose();
    } catch (error) {
      if (error instanceof AppsApiError && error.code === "mate_email_conflict") {
        setEmailError(t("apps.mate.emailConflict"));
      } else if (error instanceof AppsApiError && error.code === "mate_work_email_invalid") {
        setEmailError(t("apps.mate.emailInvalid"));
      } else {
        setValidationError(t("apps.mate.deployFailed"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!mate?.previewReleaseId) return;
    setBusy(true);
    try {
      const published = await onPublish(mate, mate.previewReleaseId);
      if (published) onClose();
    } finally {
      setBusy(false);
    }
  }

  function setSelectedApps(appIds: string[]) {
    setInput((current) => {
      const selection = resourceSelection(appIds, current.allAppMcp);
      if (!selection) return current;
      return {
        ...current,
        allAppMcp: selection.all,
        appMcpBindings: selection.ids.map((appId) => ({
          appId,
          manifestVersion: appOptions.find((option) => option.appId === appId)?.manifestVersion
            ?? current.appMcpBindings.find((binding) => binding.appId === appId)?.manifestVersion
            ?? "workspace.app-mcp/v1"
        })),
        workspacePassMcpEnabled: false
      };
    });
  }

  function setResourceToolEnabled(group: "knowledgeQuery" | "knowledgeEdit" | "appMcp", enabled: boolean) {
    setInput((current) => {
      if (group === "knowledgeQuery") return {
        ...current,
        allKnowledgeServices: enabled,
        knowledgeServiceIds: [],
        workspacePassMcpEnabled: false
      };
      if (group === "knowledgeEdit") return {
        ...current,
        allFolderEdit: enabled,
        folderEditIds: [],
        builtInToolIds: [
          ...current.builtInToolIds.filter((id) => id !== "workspace_knowledge_maintain"),
          ...(enabled ? ["workspace_knowledge_maintain"] : [])
        ]
      };
      return {
        ...current,
        allAppMcp: enabled,
        appMcpBindings: [],
        workspacePassMcpEnabled: false
      };
    });
  }

  function toggleTaskMode() {
    setInput((current) => current.taskModeEnabled
      ? {
          ...current,
          emailEnabled: false,
          taskModeEnabled: false,
          mateCallEnabled: false
        }
      : {
          ...current,
          emailEnabled: true,
          taskModeEnabled: true,
          mateCallEnabled: true
        });
    setValidationError("");
  }

  function toggleTaskEntry(channel: "email" | "call") {
    if (channel === "email" && input.emailEnabled && !input.mateCallEnabled) {
      setValidationError(t("apps.mate.taskEntryRequired"));
      return;
    }
    if (channel === "call" && input.mateCallEnabled && !input.emailEnabled) {
      setValidationError(t("apps.mate.taskEntryRequired"));
      return;
    }
    setValidationError("");
    setInput((current) => {
      if (channel === "email") return { ...current, emailEnabled: !current.emailEnabled };
      return { ...current, mateCallEnabled: !current.mateCallEnabled };
    });
  }

  const appListOptions = appOptions.map((app) => ({
    description: app.description || t("apps.mate.appDelegation"),
    label: app.name,
    meta: "MCP",
    searchText: `${app.name} ${app.appId}`,
    value: app.appId
  }));
  const allResourceOption = {
    description: t("apps.mate.allResourcesDescription"),
    label: t("apps.mate.allResources"),
    meta: "ALL",
    searchText: t("apps.mate.allResources"),
    value: ALL_RESOURCES_VALUE
  };
  const allAppOption = {
    description: t("apps.mate.allResourcesDescription"),
    label: t("apps.mate.allResources"),
    meta: "ALL",
    searchText: t("apps.mate.allResources"),
    value: ALL_RESOURCES_VALUE
  };
  const knowledgeListOptions = knowledgeOptions.flatMap((service) => {
    const serviceId = service.serviceId ?? service.id;
    if (!serviceId) return [];
    return [{
      description: service.description || t("apps.mate.knowledgeReadOnly"),
      label: service.name || serviceId,
      meta: service.effectiveRole,
      searchText: `${service.name || ""} ${serviceId}`,
      value: serviceId
    }];
  });
  const modelOptionById = new Map([
    ...input.allowedModels.map((modelId) => [modelId, {
      description: modelId,
      label: modelId,
      searchText: modelId,
      value: modelId
    }] as const),
    ...modelOptions.map((model) => [model.id, {
      description: model.id,
      label: model.displayName || model.id,
      searchText: `${model.displayName || ""} ${model.id}`,
      value: model.id
    }] as const)
  ]);
  const modelListOptions = [
    ...input.allowedModels.map((modelId, index) => ({
      ...modelOptionById.get(modelId)!,
      meta: index === 0 ? t("apps.mate.modelDefaultBadge") : t("apps.mate.modelSwitchBadge")
    })),
    ...Array.from(modelOptionById.values()).filter((option) => !input.allowedModels.includes(option.value))
  ];
  const defaultModelLabel = modelOptionById.get(input.allowedModels[0])?.label ?? input.allowedModels[0];
  const visibilityOptions: Array<{ description: string; label: string; value: MateVisibility }> = [
    { description: t("apps.mate.visibility.privateDetail"), label: t("apps.mate.visibility.private"), value: "private" },
    { description: t("apps.mate.visibility.targetsDetail"), label: t("apps.mate.visibility.targets"), value: "targets" },
    { description: t("apps.mate.visibility.organizationDetail"), label: t("apps.mate.visibility.organization"), value: "organization" }
  ];
  return (
    <ModalShell
      ariaLabel={t("apps.mate.builderAria")}
      className={showsAccessPicker ? "appsCreateModal withAccessPicker" : "appsCreateModal"}
      header={(
        <div>
          <p className="eyebrow">{t("apps.mate.eyebrow")}</p>
          <h2>{editing ? t("apps.mate.editTitle") : t("apps.mate.createTitle")}</h2>
        </div>
      )}
      headerActions={<Button aria-label={t("apps.detail.close")} disabled={busy || submitting} onClick={onClose} variant="icon"><X size={18} /></Button>}
      onClose={onClose}
    >
      <form className={showsAccessPicker ? "appsCreateForm appsModalBody withAccessPicker" : "appsCreateForm appsModalBody"} onSubmit={(event) => void saveAndPreview(event)}>
        <div className="appsCreateFormMain">
          {mate && currentLinkUrl && (
            <div className="appsMateCurrentLink">
              <div>
                <span>{t("apps.mate.currentLink")}</span>
                <strong>{currentLinkUrl}</strong>
                <small>{t("apps.mate.currentLinkDescription")}</small>
              </div>
              <ButtonLink href={currentLinkPath} iconAfter={<ArrowUpRight size={14} />} rel="noreferrer" target="_blank" variant="secondary">
                {t("apps.mate.openCurrentLink")}
              </ButtonLink>
            </div>
          )}
          <div className="formGrid">
            <FormField label={t("apps.mate.name")} required>
              <TextInput placeholder={t("apps.mate.namePlaceholder")} required value={input.displayName} onChange={(event) => setInput((current) => nextMateIdentityName(current, event.target.value, editing, mateEmailDomain))} />
            </FormField>
            <FormField description={editing ? t("apps.mate.codeImmutableDescription") : t("apps.mate.codeDescription")} error={emailError} label={t("apps.mate.code")} required>
              <div className="appsEmailAddressInput appsMateCodeInput">
                <TextInput
                  aria-label={t("apps.mate.code")}
                  autoComplete="off"
                  disabled={editing}
                  maxLength={63}
                  pattern="[a-z0-9](?:[a-z0-9\x2d]{0,61}[a-z0-9])?"
                  placeholder={t("apps.mate.codePlaceholder")}
                  required
                  value={mateCodeFromWorkEmail(input.workEmail)}
                  onChange={(event) => {
                    setEmailError("");
                    const code = normalizeMateCodeDraft(event.target.value);
                    setInput((current) => ({
                      ...current,
                      workEmail: code ? `${code}@${mateEmailDomain ?? ""}` : ""
                    }));
                  }}
                />
                <span aria-hidden="true">@{mateEmailDomain ?? ""}</span>
              </div>
            </FormField>
            <FormField full label={t("apps.mate.role")} required>
              <TextInput placeholder={t("apps.mate.rolePlaceholder")} required value={input.jobRole} onChange={(event) => setInput((current) => ({ ...current, jobRole: event.target.value }))} />
            </FormField>
            <FormField full label={t("apps.mate.description")}>
              <TextArea placeholder={t("apps.mate.descriptionPlaceholder")} rows={3} value={input.description} onChange={(event) => setInput((current) => ({ ...current, description: event.target.value }))} />
            </FormField>
            <FormField full label={t("apps.mate.avatar")}>
              <MateAvatarChoices catalog={catalog} onChange={(avatarUrl) => setInput((current) => ({ ...current, avatarUrl }))} value={input.avatarUrl} />
            </FormField>
          </div>
          <p className="appsValidationHint">{t("apps.mate.identityDescription")}</p>

          {definitionReady && (
            <AppsCreateSelectPanel
              control={<span className="appsCreatePanelMeta">{t("apps.mate.draftRevision", { revision: mate?.draftRevision ?? 1 })}</span>}
              description={t("apps.mate.coreDescription")}
              label={t("apps.mate.coreTitle")}
              title={t("apps.mate.coreTitle")}
            >
              <div className="formGrid">
                <FormField full label={t("apps.mate.soul")}><TextArea rows={7} value={soul} onChange={(event) => setSoul(event.target.value)} /></FormField>
                <FormField full label={t("apps.mate.handbook")}><TextArea rows={9} value={handbook} onChange={(event) => setHandbook(event.target.value)} /></FormField>
                <FormField full label={t("apps.mate.inboxPrompt")}><TextArea rows={8} value={inboxPrompt} maxLength={24000} onChange={(event) => setInboxPrompt(event.target.value)} placeholder={t("apps.mate.inboxPromptPlaceholder")} /><small>{t("apps.mate.inboxPromptDescription")}</small></FormField>
              </div>
            </AppsCreateSelectPanel>
          )}

          <div className="appsSectionHeader">
            <div><h3>{t("apps.mate.resourcesTitle")}</h3><p>{t("apps.mate.resourcesDescription")}</p></div>
          </div>

          <AppsCreateSelectPanel
            control={(
              <ResourceToolToggle
                enabled={knowledgeQueryEnabled}
                onChange={(enabled) => setResourceToolEnabled("knowledgeQuery", enabled)}
              />
            )}
            description={t("apps.mate.knowledgeResourcesDescription")}
            label={t("apps.mate.knowledgeResourcesTitle")}
            title={t("apps.mate.knowledgeResourcesTitle")}
          >
            {knowledgeQueryEnabled && <WorkspaceMultiListbox
              ariaLabel={t("apps.mate.knowledgeResourcesSelect")}
              className="appsCreateInlineListbox"
              disabled={resourcesLoading}
              noResultsLabel={t("apps.mate.noKnowledge")}
              onChange={(values) => {
                setInput((current) => {
                  const selection = resourceSelection(values, current.allKnowledgeServices);
                  return selection ? {
                    ...current,
                    allKnowledgeServices: selection.all,
                    knowledgeServiceIds: selection.ids
                  } : current;
                });
              }}
              options={[allResourceOption, ...knowledgeListOptions]}
              placeholder={resourcesLoading ? t("apps.mate.resourcesLoading") : t("apps.mate.knowledgeResourcesPlaceholder")}
              searchPlaceholder={t("apps.mate.searchKnowledge")}
              selectedCountLabel={(count) => t("apps.mate.selectedKnowledge", { count })}
              values={input.allKnowledgeServices ? [ALL_RESOURCES_VALUE] : input.knowledgeServiceIds}
            />}
            <p>{t("apps.mate.knowledgeReadOnly")}</p>
          </AppsCreateSelectPanel>

          <AppsCreateSelectPanel
            control={(
              <ResourceToolToggle
                enabled={knowledgeEditEnabled}
                onChange={(enabled) => setResourceToolEnabled("knowledgeEdit", enabled)}
              />
            )}
            description={t("apps.mate.folderResourcesDescription")}
            label={t("apps.mate.folderResourcesTitle")}
            title={t("apps.mate.folderResourcesTitle")}
          >
            {knowledgeEditEnabled && <WorkspaceMultiListbox
              ariaLabel={t("apps.mate.folderResourcesSelect")}
              className="appsCreateInlineListbox"
              disabled={resourcesLoading}
              noResultsLabel={t("apps.mate.noEditableFolders")}
              onChange={(values) => {
                setInput((current) => {
                  const selection = resourceSelection(values, current.allFolderEdit);
                  return selection ? {
                    ...current,
                    allFolderEdit: selection.all,
                    folderEditIds: selection.ids,
                    builtInToolIds: [
                      ...current.builtInToolIds.filter((id) => id !== "workspace_knowledge_maintain"),
                      "workspace_knowledge_maintain"
                    ]
                  } : current;
                });
              }}
              options={[allResourceOption, ...folderOptions.map((folder) => ({
                value: folder.id,
                label: folder.name,
                description: folder.path
              }))]}
              placeholder={t("apps.mate.folderResourcesSelect")}
              searchPlaceholder={t("apps.mate.searchFolders")}
              selectedCountLabel={(count) => t("apps.mate.selectedFolders", { count })}
              values={input.allFolderEdit ? [ALL_RESOURCES_VALUE] : (input.folderEditIds ?? [])}
            />}
            <p>{t("apps.mate.folderEditScope")}</p>
          </AppsCreateSelectPanel>

          <AppsCreateSelectPanel
            control={(
              <ResourceToolToggle
                enabled={appMcpEnabled}
                onChange={(enabled) => setResourceToolEnabled("appMcp", enabled)}
              />
            )}
            description={t("apps.mate.appResourcesDescription")}
            label={t("apps.mate.appResourcesTitle")}
            title={t("apps.mate.appResourcesTitle")}
          >
            {appMcpEnabled && <WorkspaceMultiListbox
              ariaLabel={t("apps.mate.appResourcesSelect")}
              className="appsCreateInlineListbox"
              disabled={resourcesLoading}
              noResultsLabel={t("apps.mate.noApps")}
              onChange={setSelectedApps}
              options={[allAppOption, ...appListOptions]}
              placeholder={resourcesLoading ? t("apps.mate.resourcesLoading") : t("apps.mate.appResourcesPlaceholder")}
              searchPlaceholder={t("apps.mate.searchApps")}
              selectedCountLabel={(count) => t("apps.mate.selectedApps", { count })}
              values={input.allAppMcp ? [ALL_RESOURCES_VALUE] : selectedAppIds}
            />}
            <p>{t("apps.mate.appDelegation")}</p>
          </AppsCreateSelectPanel>

          <AppsCreateSelectPanel
            control={(
              <WorkspaceMultiListbox
                ariaLabel={t("apps.mate.modelsSelect")}
                className="appsCreateInlineListbox"
                noResultsLabel={t("apps.mate.noModels")}
                onChange={(allowedModels) => setInput((current) => allowedModels.length
                  ? { ...current, allowedModels }
                  : current)}
                options={modelListOptions}
                placeholder={t("apps.mate.modelsPlaceholder")}
                searchPlaceholder={t("apps.mate.searchModels")}
                selectedCountLabel={(count) => t("apps.mate.selectedModels", { count, model: defaultModelLabel })}
                values={input.allowedModels}
              />
            )}
            description={t("apps.mate.modelsDescription")}
            label={t("apps.mate.modelsTitle")}
            title={t("apps.mate.modelsTitle")}
          >
            <p>{t("apps.mate.modelsTargetHint", { model: defaultModelLabel })}</p>
            {input.allowedModels[0] === "cf-openai-gpt-6-luna" && <p>{t("apps.mate.lunaSearchHint")}</p>}
          </AppsCreateSelectPanel>

          {resourceErrors.map((message) => <div className="formMessage error" key={message}>{message}</div>)}

          <McpCapacityPicker
            onChange={(mcpCapacity) => setInput((current) => ({ ...current, mcpCapacity }))}
            value={input.mcpCapacity}
          />
          <p className="appsValidationHint">{t("apps.mate.intrinsicTaskTools")}</p>
          <p className="appsValidationHint">{t("apps.mate.skillDiscovery")}</p>
          {mate?.activeReleaseId && isCurrentAppsOwner(mate.ownerUserId, catalog.currentUser) && <MatePlugins catalog={catalog} mateId={mate.id} zh={locale === 'zh-CN'} onChanged={() => setPluginsChanged(true)} />}

          <SelectableGrid
            count={input.taskModeEnabled ? 2 : 1}
            description={t("apps.mate.publishModesDescription")}
            title={t("apps.mate.publishModesTitle")}
          >
            <ModeButton
              active
              description={t("apps.mate.conversationModeDescription")}
              label={t("apps.mate.conversationMode")}
              lockedLabel={t("apps.mate.alwaysEnabled")}
            />
            <ModeButton
              active={input.taskModeEnabled}
              description={t("apps.mate.taskModeDescription")}
              label={t("apps.mate.taskMode")}
              onClick={toggleTaskMode}
            />
          </SelectableGrid>
          <p className="appsValidationHint">{t("apps.mate.sdkEmbedHelp")}</p>
          {input.taskModeEnabled && (
            <SelectableGrid
              count={[input.mateCallEnabled, input.emailEnabled].filter(Boolean).length}
              description={t("apps.mate.taskEntriesDescription")}
              title={t("apps.mate.taskEntriesTitle")}
            >
              <SelectableButton active={input.mateCallEnabled} label={t("apps.mate.channel.call")} onClick={() => toggleTaskEntry("call")} />
              <SelectableButton active={input.emailEnabled} label={t("apps.mate.channel.email")} onClick={() => toggleTaskEntry("email")} />
            </SelectableGrid>
          )}

          <FormField full label={t("apps.mate.defaultTimezone")}>
            <TextInput placeholder="Asia/Shanghai" value={input.defaultTimezone} onChange={(event) => setInput((current) => ({ ...current, defaultTimezone: event.target.value }))} />
          </FormField>

          <AppsCreateSelectPanel
            control={(
              <WorkspaceListbox<MateVisibility>
                ariaLabel={t("apps.mate.permissionsTitle")}
                className="appsCreateInlineListbox"
                onChange={(visibility) => setInput((current) => ({ ...current, targetIds: visibility === "targets" ? current.targetIds : [], visibility }))}
                options={visibilityOptions}
                value={input.visibility}
              />
            )}
            description={t("apps.mate.permissionsDescription")}
            label={t("apps.mate.permissionsTitle")}
            title={t("apps.mate.permissionsTitle")}
          >
            {input.visibility === "targets" && (
              <div className="appsAccessTargetSummaryPanel">
                <div><strong>{t("apps.create.accessTargetTitle")}</strong><small>{input.targetIds.length > 0 ? t("apps.create.accessTargetsSelected", { count: input.targetIds.length }) : t("apps.create.accessTargetsRequired")}</small></div>
                <AccessTargetSelectedTags
                  copy={accessPickerCopy}
                  emptyLabel={t("apps.create.validationTargets")}
                  nodes={accessTargetTree}
                  onRemove={(value) => setInput((current) => ({ ...current, targetIds: current.targetIds.filter((target) => target !== value) }))}
                  selectedValues={input.targetIds}
                />
              </div>
            )}
            {input.visibility === "private" && <div className="appsPrivateAccessNote"><ShieldCheck size={15} />{t("apps.mate.privateNote", { name: catalog.currentUser.name })}</div>}
            <p>{t("apps.mate.userDelegation")}</p>
          </AppsCreateSelectPanel>

          {validationError && <div className="formMessage error" role="alert">{validationError}</div>}
          <div className="formActions">
            <Button disabled={busy || submitting} onClick={onClose} variant="secondary">{t("apps.create.cancel")}</Button>
            <Button disabled={busy || submitting || (editing && !definitionReady) || (showsAccessPicker && directoryState !== "ready")} type="submit" variant="primary"><Bot size={16} />{t("apps.mate.saveAndPreview")}</Button>
            {definitionReady && mate?.previewReleaseId && <Button disabled={busy || submitting} onClick={() => void publish()} type="button" variant="primary"><Check size={16} />{t("apps.mate.publish")}</Button>}
          </div>
        </div>

        {showsAccessPicker && (
          <aside className="appsCreateAccessPickerPane">
            <AccessTargetPicker copy={accessPickerCopy} nodes={accessTargetTree} onSelectionChange={(targetIds) => setInput((current) => ({ ...current, targetIds }))} selectedValues={input.targetIds} state={directoryState} />
          </aside>
        )}
      </form>
    </ModalShell>
  );
}

function normalizeAppOptions(value: unknown): AppMcpOption[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    const appId = text(source.appId);
    if (!appId) return [];
    return [{
      appId,
      description: text(source.description) || undefined,
      manifestVersion: text(source.manifestVersion) || undefined,
      name: text(source.name) || appId
    }];
  }) : [];
}

function normalizeKnowledgeOptions(value: unknown): KnowledgeServiceOption[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    const serviceId = text(source.serviceId ?? source.id);
    if (!serviceId) return [];
    return [{
      description: text(source.description) || undefined,
      effectiveRole: text(source.effectiveRole) || undefined,
      name: text(source.name) || serviceId,
      serviceId
    }];
  }) : [];
}

function normalizeModelOptions(value: unknown): GatewayModelOption[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    const id = text(source.id);
    if (!id) return [];
    return [{ displayName: text(source.displayName) || id, id }];
  }) : [];
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function resourceSelection(values: string[], wasAll: boolean) {
  // The switch controls NO. Clearing the final listbox option must never
  // silently turn YES/selected into ALL (or vice versa).
  if (!values.length) return undefined;
  if (values.includes(ALL_RESOURCES_VALUE)) {
    if (wasAll && values.length > 1) return { all: false, ids: values.filter((value) => value !== ALL_RESOURCES_VALUE) };
    return { all: true, ids: [] as string[] };
  }
  return { all: false, ids: values };
}

function mateStandaloneHostPath(mateId: string) {
  return `/mates/${encodeURIComponent(mateId)}`;
}

function absolutePortalUrl(path: string) {
  return new URL(path, window.location.origin).toString();
}

function SelectableGrid({ children, count, description, title }: { children: React.ReactNode; count: number; description: string; title: string }) {
  const { t } = useI18n();
  return (
    <section className="appsCreateResourcePreviewPanel">
      <div className="appsSectionHeader"><div><h3>{title}</h3><p>{description}</p></div><span>{t("apps.create.itemCount", { count })}</span></div>
      <div className="appsCreateResourcePreviewGrid">{children}</div>
    </section>
  );
}

function ResourceToolToggle({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const { t } = useI18n();
  return <label className="mateCapacityGroupLabel mateResourceToolToggle">
    <input aria-checked={enabled} checked={enabled} onChange={(event) => onChange(event.target.checked)} role="switch" type="checkbox" />
    <strong>{enabled ? t("apps.mate.resourceToolYes") : t("apps.mate.resourceToolNo")}</strong>
  </label>;
}

function McpCapacityPicker({ value, onChange }: { value: MateMcpCapacity; onChange: (value: MateMcpCapacity) => void }) {
  const { t } = useI18n();
  const groups = Object.keys(MATE_MCP_CAPACITY_CHILDREN) as MateMcpCapacityGroup[];
  const allResourceOption = {
    description: t("apps.mate.allResourcesDescription"),
    label: t("apps.mate.allResources"),
    meta: "ALL",
    searchText: t("apps.mate.allResources"),
    value: ALL_RESOURCES_VALUE
  };
  return (
    <section className="appsCreateResourcePreviewPanel mateCapacityPicker">
      <div className="appsSectionHeader"><div><h3>{t("apps.mate.mcpCapacityTitle")}</h3><p>{t("apps.mate.mcpCapacityDescription")}</p></div></div>
      {groups.map((group) => {
        const children = mateMcpCapacityConfigurableChildren(group);
        const selection = value[group];
        const enabled = selection.mode !== "none";
        const selectedValues = selection.mode === "all"
          ? [ALL_RESOURCES_VALUE]
          : selection.mode === "selected"
            ? selection.children.filter((child) => children.includes(child))
            : [];
        const options = [allResourceOption, ...children.map((child) => ({
          description: t("apps.mate.mcpCapacityDescription"),
          label: t(`apps.mate.mcpCapacity.${group}.${child}` as Parameters<typeof t>[0]),
          searchText: `${t(`apps.mate.mcpCapacity.${group}.${child}` as Parameters<typeof t>[0])} ${child}`,
          value: child
        }))];
        return <div className="mateCapacityGroup" key={group}>
          <div className="mateCapacityGroupHeader">
            <div>
              <h4>{t(`apps.mate.mcpCapacity.${group}`)}</h4>
              <p>{t(`apps.mate.mcpCapacity.${group}Description` as Parameters<typeof t>[0])}</p>
            </div>
            <ResourceToolToggle
              enabled={enabled}
              onChange={(nextEnabled) => onChange({
                ...value,
                [group]: nextEnabled ? { mode: "all" } : { mode: "none" }
              })}
            />
          </div>
          {enabled && <WorkspaceMultiListbox
            ariaLabel={t(`apps.mate.mcpCapacity.${group}`)}
            className="appsCreateInlineListbox"
            onChange={(values) => {
              const next = resourceSelection(values, selection.mode === "all");
              if (!next) return;
              onChange({
                ...value,
                [group]: next.all ? { mode: "all" } : selectMateCapacityChildren(group, next.ids)
              });
            }}
            options={options}
            placeholder={t("apps.mate.allResources")}
            searchPlaceholder={t("common.search")}
            selectedCountLabel={(count) => t("apps.create.itemCount", { count })}
            values={selectedValues}
          />}
        </div>;
      })}
    </section>
  );
}

function SelectableButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button aria-pressed={active} className={active ? "appsCreateResourceSelectItem active" : "appsCreateResourceSelectItem"} onClick={onClick} type="button">
      <span className="appsCreateResourceSelectIndicator">{active ? <Check size={14} /> : null}</span>
      <div><strong>{label}</strong></div>
    </button>
  );
}

function ModeButton({
  active,
  description,
  label,
  lockedLabel,
  onClick
}: {
  active: boolean;
  description: string;
  label: string;
  lockedLabel?: string;
  onClick?: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`${active ? "appsCreateResourceSelectItem active" : "appsCreateResourceSelectItem"}${onClick ? "" : " locked"}`}
      disabled={!onClick}
      onClick={onClick}
      type="button"
    >
      <span className="appsCreateResourceSelectIndicator">{active ? <Check size={14} /> : null}</span>
      <div><strong>{label}</strong><small>{description}</small>{lockedLabel && <em>{lockedLabel}</em>}</div>
    </button>
  );
}

function mateInput(mate?: Mate): MateCreateInput {
  const manifest = mate?.draftManifest;
  if (!mate) return { ...initialInput, avatarUrl: defaultMateAvatarUrl() };
  if (!manifest) return {
    ...initialInput,
    avatarUrl: mate.avatarUrl ?? "",
    description: mate.description,
    displayName: mate.displayName,
    jobRole: mate.jobRole,
    visibility: mate.visibility,
    workEmail: mateWorkEmail(mate.workEmail)
  };
  const resources = manifest.resources;
  const channels = manifest.channels as {
    embedded?: { enabled?: boolean };
    inbox?: { email?: { enabled?: boolean }; schedule?: { enabled?: boolean }; mateCall?: { enabled?: boolean } };
    standalone?: { enabled?: boolean };
  };
  const taskModeEnabled = manifest.experiencePolicy.taskInbox.enabled;
  return {
    mcpCapacity: normalizeMateCapacityForBuilder(migrateLegacyMateMcpCapacity(resources)),
    allAppMcp: resources.appMcpScope?.mode === "all_visible_to_invoking_user"
      || resources.workspacePassMcpScope?.mode === "all_authorized_for_invoking_user",
    allFolderEdit: resources.folderEditScope?.mode === "all_visible_to_invoking_user",
    allKnowledgeServices: resources.knowledgeServiceScope?.mode === "all_visible_to_invoking_user"
      || resources.workspacePassMcpScope?.mode === "all_authorized_for_invoking_user",
    allowedModels: defaultFirstModels(manifest.modelPolicy.allowedModels, manifest.modelPolicy.defaultModel),
    appMcpBindings: resources.appMcpBindings.map(({ appId, manifestVersion }) => ({ appId, manifestVersion })),
    avatarUrl: manifest.mate.avatarRef ?? mate.avatarUrl ?? "",
    builtInToolIds: withWorkspaceIntrinsicBuiltInToolIds([
      ...resources.builtInToolBindings.map((binding) => binding.toolId)
        .filter((id) => id !== "workspace_knowledge_maintain" || Boolean(resources.folderEditBindings?.length || resources.folderEditScope))
        .filter((id) => id !== "workspace_forum_read" && id !== "workspace_forum_post"),
      "ocr", "document_read", "artifact_create"
    ]),
    defaultTimezone: manifest.taskPolicy.defaultTimezone,
    description: mate.description,
    displayName: mate.displayName,
    emailEnabled: channels.inbox?.email?.enabled !== false,
    embeddedEnabled: channels.embedded?.enabled === true,
    workspacePassMcpEnabled: resources.workspacePassMcpScope?.mode === "all_authorized_for_invoking_user",
    jobRole: mate.jobRole,
    knowledgeServiceIds: resources.knowledgeServiceBindings.map((binding) => binding.serviceId),
    folderEditIds: (resources.folderEditBindings ?? []).map((binding) => binding.folderObjectId),
    standaloneEnabled: channels.standalone?.enabled !== false,
    taskModeEnabled,
    targetIds: manifest.invocationPolicy.targetIds ?? [],
    mateCallEnabled: channels.inbox?.mateCall?.enabled !== false,
    visibility: manifest.invocationPolicy.visibility,
    workEmail: mateWorkEmail(mate.workEmail)
  };
}

function normalizeMateCapacityForBuilder(value: MateMcpCapacity): MateMcpCapacity {
  const aiCapacity = value.ai_capacity;
  return {
    ...value,
    ai_capacity: aiCapacity.mode === "selected"
      ? selectMateCapacityChildren("ai_capacity", aiCapacity.children.filter((child) => child !== "models"))
      : aiCapacity
  };
}

async function nextDefinition(mate: Mate, source: WorkspaceAgentRuntimeManifest, input: MateCreateInput, soul: string, handbook: string, inboxPrompt: string) {
  const manifest = structuredClone(source);
  manifest.resources.mcpCapacity = structuredClone(input.mcpCapacity);
  const documents = structuredClone(mate.draftDocuments ?? []);
  const soulDocument = documents.find((document) => document.kind === "soul");
  const handbookDocument = documents.find((document) => document.kind === "handbook");
  if (!soulDocument || !handbookDocument) throw new Error("mate_documents_missing");
  soulDocument.content = soul;
  soulDocument.digest = await sha256Digest(soul);
  handbookDocument.content = handbook;
  handbookDocument.digest = await sha256Digest(handbook);
  await ensureMateMailDocument(manifest, documents, mate.isDefault);
  await setMateMailContent(manifest, documents, inboxPrompt);
  manifest.release.soul.digest = soulDocument.digest;
  manifest.release.handbooks[0].digest = handbookDocument.digest;
  manifest.resources.appMcpBindings = (input.allAppMcp ? [] : input.appMcpBindings).map((binding) => ({
    ...binding,
    authority: { mode: "invoking_user" },
    requiresCurrentUserDelegation: true
  }));
  if (input.allAppMcp) manifest.resources.appMcpScope = {
    authority: { mode: "invoking_user" }, mode: "all_visible_to_invoking_user", requiresCurrentUserAuthorization: true
  };
  else delete manifest.resources.appMcpScope;
  manifest.resources.knowledgeServiceBindings = (input.allKnowledgeServices ? [] : input.knowledgeServiceIds).map((serviceId) => ({
    serviceId,
    allowedOperations: ["search", "read"],
    authority: { mode: "invoking_user" },
    requiresCurrentUserAuthorization: true
  }));
  delete manifest.resources.workspacePassMcpScope;
  {
    if (input.allKnowledgeServices) {
      manifest.resources.knowledgeServiceScope = {
        allowedOperations: ["search", "read"],
        authority: { mode: "invoking_user" },
        mode: "all_visible_to_invoking_user",
        requiresCurrentUserAuthorization: true
      };
    } else {
      delete manifest.resources.knowledgeServiceScope;
    }
  }
  manifest.resources.folderEditBindings = (input.allFolderEdit ? [] : input.folderEditIds ?? []).map((folderObjectId) => ({
    folderObjectId,
    authority: { mode: "invoking_user" },
    requiresCurrentUserAuthorization: true
  }));
  if (input.allFolderEdit) manifest.resources.folderEditScope = {
    authority: { mode: "invoking_user" }, mode: "all_visible_to_invoking_user", requiresCurrentUserAuthorization: true
  };
  else delete manifest.resources.folderEditScope;
  manifest.modelPolicy.defaultModel = input.allowedModels[0];
  manifest.modelPolicy.allowedModels = [...input.allowedModels];
  manifest.modelPolicy.allowUserSelection = input.allowedModels.length > 1;
  manifest.resources.builtInToolBindings = withWorkspaceIntrinsicBuiltInToolIds(input.builtInToolIds).map((toolId) => ({
    toolId: toolId as WorkspaceAgentRuntimeManifest["resources"]["builtInToolBindings"][number]["toolId"],
    requiresCurrentUserContext: true
  }));
  const channels = manifest.channels as Record<string, any>;
  const taskModeEnabled = input.taskModeEnabled && (input.mateCallEnabled || input.emailEnabled);
  const legacyScheduleEnabled = taskModeEnabled
    && channels.inbox.schedule.enabled === true
    && manifest.taskPolicy.scheduledJobs.length > 0;
  channels.standalone.enabled = true;
  channels.embedded.enabled = true;
  channels.inbox.email.enabled = taskModeEnabled && input.emailEnabled;
  // Release-authored schedules are retained for compatibility, but Builder no
  // longer creates or edits them. New reminders are owned by Runtime instead.
  channels.inbox.schedule.enabled = legacyScheduleEnabled;
  channels.inbox.mateCall.enabled = taskModeEnabled && input.mateCallEnabled;
  manifest.experiencePolicy.conversation = {
    enabled: true,
    channels: ["web", "sdk"]
  };
  manifest.experiencePolicy.taskInbox = {
    enabled: taskModeEnabled,
    channels: [
      ...(taskModeEnabled && input.mateCallEnabled ? ["mate_call" as const] : []),
      ...(taskModeEnabled && input.emailEnabled ? ["email" as const] : []),
      ...(legacyScheduleEnabled ? ["schedule" as const] : [])
    ]
  };
  if (manifest.memoryPolicy) {
    manifest.memoryPolicy.conversationHistory.enabled = true;
    manifest.memoryPolicy.conversationHistory.compaction.enabled = true;
  }
  delete manifest.taskPolicy.defaultExecutor;
  manifest.taskPolicy.defaultTimezone = input.defaultTimezone;
  manifest.taskPolicy.scheduledJobs = legacyScheduleEnabled ? manifest.taskPolicy.scheduledJobs : [];
  manifest.invocationPolicy.allowedCallerKinds = [
    "user",
    ...(taskModeEnabled && input.mateCallEnabled ? ["app" as const, "mate" as const] : []),
    ...(taskModeEnabled && input.emailEnabled ? ["email_binding" as const] : [])
  ];
  manifest.invocationPolicy.visibility = input.visibility;
  if (input.visibility === "targets") manifest.invocationPolicy.targetIds = input.targetIds;
  else delete manifest.invocationPolicy.targetIds;
  return { documents, manifest };
}

function defaultFirstModels(allowedModels: string[], defaultModel: string) {
  const unique = Array.from(new Set(allowedModels));
  if (unique.length === 0) return [defaultModel || initialInput.allowedModels[0]];
  if (!unique.includes(defaultModel)) return unique;
  return [defaultModel, ...unique.filter((modelId) => modelId !== defaultModel)];
}

function documentContent(documents: MateDocument[] | undefined, kind: MateDocument["kind"]) {
  return documents?.find((document) => document.kind === kind)?.content ?? "";
}

async function sha256Digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
