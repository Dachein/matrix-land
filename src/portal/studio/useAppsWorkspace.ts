import { useEffect, useState, type FormEvent } from "react";
import { isAppsAppMcpRequiredType, isAppsAppMcpSupportedType } from "../../shared/appsResourceCatalog";
import type { AppsApp, AppsAppSecret, AppsSkill, PublicationListing, PortalCatalog } from "../../shared/types";
import type { Mate } from "../../shared/mate";
import { useI18n } from "../i18n";
import { appsAccessUpdateErrorMessage } from "./accessErrorMessages";
import { AppsApiError, appsApiBase, appsApiFetch, appsApiRequest } from "./apiClient";
import { initialCreateInput } from "./constants";
import { useAppsInventory, useAppsMcpStatus } from "./hooks";
import { buildAppsAppMarketSubmission, buildAppsSkillMarketSubmission } from "./marketSubmissionModels";
import { appHasMailResource, appMailDevelopmentPrompt } from "./mailDevelopmentPrompt";
import type {
  ApiAppPayload,
  ApiHandoffLinkPayload,
  ApiMatePayload,
  ApiMateReleasePayload,
  CreateInput,
  AppsAppAccessInput,
  AppsAppConfigInput,
  AppsAppHandoffMode,
  AppsAppInfoInput,
  AppsAppPublishDraft,
  AppsCopyNotice,
  AppsKindFilter,
  AppsSecretInput,
  AppsSkillAccessInput,
  AppsSkillInfoInput,
  AppsSkillPublishDraft,
  AppsStatusFilter
} from "./types";
import {
  appAgentHandoffClipboardText,
  appAgentHandoffCopyNotice,
  appAgentSourceCollaborationClipboardText,
  appAgentSourceCollaborationCopyNotice,
  copyText,
  createAccessTargets,
  customRuntimeResourceTypesForCreate,
  isReservedAppCode,
  isValidAppCode,
  appsAppInfoUpdatePayload,
  appsAccessTemplate,
  normalizeAppCode,
  parseCommaList,
  resourceTypesForCreate
} from "./utils";

export function useAppsWorkspace({
  catalog,
  onCatalogRefresh
}: {
  catalog: PortalCatalog;
  onCatalogRefresh: () => Promise<void> | void;
}) {
  const { locale, t } = useI18n();
  const [kindFilter, setKindFilter] = useState<AppsKindFilter>("all");
  const [statusFilter, setStatusFilter] = useState<AppsStatusFilter>("all");
  const [query, setQuery] = useState("");
  const { apiMode, apps, replaceApp, replaceSkill, replaceMate, setApiMode, setApps, setSkills, skills, mates } = useAppsInventory(catalog);
  const { mcpConnectionStatus, mcpStatusMode, refreshMcpConnectionStatus } = useAppsMcpStatus(catalog.currentUser.id);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isMcpOpen, setIsMcpOpen] = useState(false);
  const [createInput, setCreateInput] = useState<CreateInput>(initialCreateInput);
  const [createdAppId, setCreatedAppId] = useState<string>();
  const [copyNotice, setCopyNotice] = useState<AppsCopyNotice>();
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const [matePreviewUrl, setMatePreviewUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [marketSubmittingId, setMarketSubmittingId] = useState("");

  const accessibleAppsTargetIds = new Set([...apps.map((app) => app.id), ...skills.map((skill) => skill.id)]);
  const marketListedCount = catalog.publicationListings.filter((listing) => (
    listing.targetPlane === "apps"
    && listing.status === "listed"
    && accessibleAppsTargetIds.has(listing.targetId)
  )).length;

  useEffect(() => {
    const openIntent = (event: Event) => {
      const intent = (event as CustomEvent<"app" | "skill">).detail;
      if (intent === "app") {
        setKindFilter("apps");
        setIsCreateOpen(true);
      } else if (intent === "skill") {
        setKindFilter("skills");
        setIsCreateOpen(false);
      }
    };

    window.addEventListener("workspace:open-apps-intent", openIntent);
    return () => window.removeEventListener("workspace:open-apps-intent", openIntent);
  }, []);

  async function createApp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = createInput.name.trim();
    const appCode = normalizeAppCode(createInput.appCode);
    const isStaticPage = createInput.type === "static_page";
    const agentMcpEnabled = isAppsAppMcpRequiredType(createInput.type)
      || (isAppsAppMcpSupportedType(createInput.type) && createInput.agentMcpEnabled);
    const loginRequired = createInput.loginRequired;
    const accessMode = loginRequired ? createInput.accessMode : "public";
    const accessTemplate = appsAccessTemplate(accessMode);
    const accessTargets = loginRequired ? createAccessTargets(createInput, catalog) : [];
    const selectedRuntimeTypes = customRuntimeResourceTypesForCreate(createInput);

    if (!name) {
      setMessage({ tone: "error", text: t("apps.message.nameRequired") });
      return;
    }
    if (!isValidAppCode(appCode)) {
      setMessage({ tone: "error", text: t(isReservedAppCode(appCode) ? "apps.message.reservedAppCode" : "apps.message.invalidAppCode") });
      return;
    }
    if (createInput.type === "container" && selectedRuntimeTypes.length !== 1) {
      setMessage({ tone: "error", text: t("apps.message.customRuntimeRequired") });
      return;
    }
    if (createInput.type === "container" && agentMcpEnabled && !resourceTypesForCreate(createInput).includes("worker")) {
      setMessage({ tone: "error", text: t("apps.message.customAgentMcpWorkerRequired") });
      return;
    }
    if (accessTemplate.requiresTargets && accessTargets.length === 0) {
      setMessage({ tone: "error", text: t("apps.message.accessTargetsRequired") });
      return;
    }

    setSubmitting(true);
    setMessage(undefined);
    try {
      const payload = await appsApiFetch<ApiAppPayload>("/apps", catalog, {
        body: JSON.stringify({
          accessMode,
          accessTargets,
          agentMcpEnabled,
          emailEnabled: createInput.emailEnabled===true,
          emailPrefix: createInput.emailPrefix ?? appCode,
          emailTriggerEnabled: createInput.emailEnabled===true && createInput.emailTriggerEnabled===true,
          code: appCode,
          description: createInput.description,
          llmEnabled: !isStaticPage && createInput.llmEnabled,
          loginRequired,
          name,
          resourceTypes: resourceTypesForCreate(createInput),
          type: createInput.type,
          visibility: accessTemplate.visibility
        }),
        method: "POST"
      });
      if (!payload.app) {
        throw new Error("missing_apps_app");
      }
      setApps((current) => [payload.app as AppsApp, ...current]);
      setCreatedAppId(payload.app.id);
      setKindFilter("apps");
      setIsCreateOpen(false);
      setCreateInput(initialCreateInput);
      setMessage({ tone: "success", text: t("apps.message.created") });
    } catch {
      setApiMode("offline");
      setMessage({ tone: "error", text: t("apps.message.workerUnavailable") });
    } finally {
      setSubmitting(false);
    }
  }

  async function createMate(input: Record<string, unknown>) {
    setSubmitting(true);
    setMessage(undefined);
    try {
      const payload = await appsApiFetch<ApiMatePayload>("/mates", catalog, {
        body: JSON.stringify(input),
        method: "POST"
      });
      if (!payload.mate) throw new Error("missing_mate");
      replaceMate(payload.mate);
      setKindFilter("mates");
      setMessage({ tone: "success", text: t("apps.mate.created") });
      return payload.mate;
    } catch (error) {
      if (!(error instanceof AppsApiError) || ![
        "mate_email_conflict",
        "mate_identity_conflict",
        "mate_work_email_invalid"
      ].includes(error.code)) {
        setApiMode("offline");
        setMessage({ tone: "error", text: t("apps.mate.createFailed") });
      }
      throw error;
    } finally {
      setSubmitting(false);
    }
  }

  async function refreshMate(mateId: string) {
    try {
      const payload = await appsApiFetch<ApiMatePayload>(`/mates/${encodeURIComponent(mateId)}`, catalog);
      if (payload.mate) replaceMate(payload.mate);
      return payload.mate;
    } catch {
      setMessage({ tone: "error", text: t("apps.mate.loadFailed") });
      return undefined;
    }
  }

  async function saveMateDraft(mate: Mate, manifest: unknown, documents: unknown) {
    try {
      const payload = await appsApiFetch<ApiMatePayload>(`/mates/${encodeURIComponent(mate.id)}/draft`, catalog, {
        body: JSON.stringify({ documents, expectedRevision: mate.draftRevision, manifest }),
        method: "PUT"
      });
      if (!payload.mate) throw new Error("missing_mate");
      replaceMate(payload.mate);
      setMessage({ tone: "success", text: t("apps.mate.draftSaved") });
      return payload.mate;
    } catch {
      setMessage({ tone: "error", text: t("apps.mate.draftSaveFailed") });
      return undefined;
    }
  }

  async function updateMateIdentity(mate: Mate, input: {
    avatarUrl: string;
    description: string;
    displayName: string;
    jobRole: string;
    targetIds: string[];
    visibility: "private" | "targets" | "organization";
    workEmail: string;
  }) {
    const currentTargets = mate.draftManifest?.invocationPolicy.targetIds ?? [];
    const unchanged = mate.description === input.description
      && (mate.avatarUrl ?? "") === input.avatarUrl
      && mate.displayName === input.displayName
      && mate.jobRole === input.jobRole
      && mate.visibility === input.visibility
      && JSON.stringify([...currentTargets].sort()) === JSON.stringify([...input.targetIds].sort());
    if (unchanged) return mate;
    const payload = await appsApiFetch<ApiMatePayload>(`/mates/${encodeURIComponent(mate.id)}`, catalog, {
      body: JSON.stringify({
        avatarUrl: input.avatarUrl,
        description: input.description,
        displayName: input.displayName,
        jobRole: input.jobRole,
        targetIds: input.targetIds,
        visibility: input.visibility
      }),
      method: "PATCH"
    });
    if (!payload.mate) throw new Error("missing_mate");
    replaceMate(payload.mate);
    return payload.mate;
  }

  async function deployMatePreview(mate: Mate) {
    try {
      const payload = await appsApiFetch<ApiMateReleasePayload>(`/mates/${encodeURIComponent(mate.id)}/deploy`, catalog, { method: "POST" });
      const updated = await refreshMate(mate.id);
      setMatePreviewUrl(payload.release?.id
        ? matePreviewHostPath(mate.id, payload.release.id)
        : payload.adoptionPreview?.testUrl ?? "");
      setMessage({ tone: "success", text: t("apps.mate.previewDeployed") });
      return updated;
    } catch {
      setMessage({ tone: "error", text: t("apps.mate.deployFailed") });
      return undefined;
    }
  }

  async function publishMate(mate: Mate, releaseId: string) {
    try {
      await appsApiFetch<ApiMateReleasePayload>(`/mates/${encodeURIComponent(mate.id)}/releases/${encodeURIComponent(releaseId)}/publish`, catalog, { method: "POST" });
      const updated = await refreshMate(mate.id);
      setMatePreviewUrl("");
      setMessage({ tone: "success", text: t("apps.mate.published") });
      return updated;
    } catch {
      setMessage({ tone: "error", text: t("apps.mate.publishFailed") });
      return undefined;
    }
  }

  async function publishApp(app: AppsApp) {
    try {
      const payload = await appsApiFetch<ApiAppPayload>(`/apps/${encodeURIComponent(app.id)}/publish`, catalog, {
        body: JSON.stringify({ visibility: app.visibility }),
        method: "POST"
      });
      if (payload.app) replaceApp(payload.app);
      setMessage({ tone: "success", text: t("apps.message.productionPublished") });
    } catch {
      setApiMode("offline");
      setMessage({ tone: "error", text: t("apps.message.productionPublishFailed") });
    }
  }

  async function submitAppToMarket(app: AppsApp, draft: AppsAppPublishDraft) {
    if (!draft.coverImageUrl.trim()) {
      setMessage({ tone: "error", text: t("apps.message.coverImageRequired") });
      return false;
    }
    const submission = buildAppsAppMarketSubmission(app, draft);
    return submitToMarket(submission.submitId, submission.body);
  }

  async function submitSkillToMarket(skill: AppsSkill, draft: AppsSkillPublishDraft) {
    if (!draft.coverImageUrl.trim()) {
      setMessage({ tone: "error", text: t("apps.message.coverImageRequired") });
      return false;
    }
    const submission = buildAppsSkillMarketSubmission(skill, draft, { apiBase: appsApiBase() });
    return submitToMarket(submission.submitId, submission.body);
  }

  async function downloadSkillPackage(skill: AppsSkill) {
    const version = skill.currentVersion ?? skill.versions[0]?.version ?? "1.0.0";
    try {
      const response = await appsApiRequest(`/skills/${encodeURIComponent(skill.id)}/versions/${encodeURIComponent(version)}/download.zip`, catalog);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${skill.slug}-${version}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage({ tone: "success", text: t("apps.message.skillDownloadStarted") });
    } catch {
      setApiMode("offline");
      setMessage({ tone: "error", text: t("apps.message.skillDownloadFailed") });
    }
  }

  async function copySkillInstallPrompt(skill: AppsSkill) {
    const version = skill.currentVersion ?? skill.versions[0]?.version ?? "1.0.0";
    try {
      const payload = await appsApiFetch<{ prompt?: string }>(`/skills/${encodeURIComponent(skill.id)}/versions/${encodeURIComponent(version)}/install-prompt`, catalog);
      await copyText(payload.prompt ?? "");
      setMessage({ tone: "success", text: t("apps.message.installPromptCopied") });
    } catch {
      setApiMode("offline");
      setMessage({ tone: "error", text: t("apps.message.installPromptFailed") });
    }
  }

  async function submitToMarket(submitId: string, body: Record<string, unknown>) {
    setMarketSubmittingId(submitId);
    setMessage(undefined);
    try {
      const response = await fetch("/api/market/submissions", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || "market_submission_failed");
      }
      setMessage({ tone: "success", text: t("apps.message.marketSubmitted") });
      await onCatalogRefresh();
      return true;
    } catch (error) {
      const code = error instanceof Error ? error.message : "market_submission_failed";
      const text = code === "invalid_harness_report_url"
        ? t("apps.message.harnessReportRequired")
        : code === "harness_self_check_required"
          ? t("apps.message.harnessSelfCheckRequired")
          : t("apps.message.marketSubmitFailed");
      setMessage({ tone: "error", text });
      return false;
    } finally {
      setMarketSubmittingId("");
    }
  }

  async function updateAppInfo(app: AppsApp, input: AppsAppInfoInput): Promise<AppsApp | undefined> {
    const name = input.name.trim();
    if (!name) {
      setMessage({ tone: "error", text: t("apps.message.nameRequired") });
      return undefined;
    }
    try {
      const payload = await appsApiFetch<ApiAppPayload>(`/apps/${encodeURIComponent(app.id)}`, catalog, {
        body: JSON.stringify(appsAppInfoUpdatePayload(input)),
        method: "PATCH"
      });
      if (payload.app) replaceApp(payload.app);
      setMessage({ tone: "success", text: t("apps.message.basicUpdated") });
      return payload.app;
    } catch (error) {
      if (!(error instanceof AppsApiError) || error.status === 0 || error.status >= 500) {
        setApiMode("offline");
      }
      setMessage({
        tone: "error",
        text: error instanceof AppsApiError && [
          "apps_app_code_immutable",
          "apps_app_type_immutable",
        ].includes(error.code)
          ? t("apps.message.appCodeImmutable")
          : t("apps.message.basicUpdateFailed")
      });
      return undefined;
    }
  }

  async function refreshApp(app: AppsApp): Promise<AppsApp | undefined> {
    try {
      const payload = await appsApiFetch<ApiAppPayload>(`/apps/${encodeURIComponent(app.id)}`, catalog);
      if (payload.app) replaceApp(payload.app);
      return payload.app;
    } catch {
      setApiMode("offline");
      return undefined;
    }
  }

  async function updateAppConfig(app: AppsApp, input: AppsAppConfigInput): Promise<AppsApp | undefined> {
    try {
      const payload = await appsApiFetch<ApiAppPayload>(`/apps/${encodeURIComponent(app.id)}`, catalog, {
        body: JSON.stringify(input),
        method: "PATCH"
      });
      if (payload.app) replaceApp(payload.app);
      setMessage({ tone: "success", text: input.addResourceTypes?.length ? t("apps.message.resourcesUpdated") : t("apps.message.basicUpdated") });
      return payload.app;
    } catch {
      setApiMode("offline");
      setMessage({ tone: "error", text: t("apps.config.capabilityUpdateFailed") });
      throw new Error("apps_app_config_update_failed");
    }
  }

  async function updateSkillInfo(skill: AppsSkill, input: AppsSkillInfoInput): Promise<AppsSkill | undefined> {
    const name = input.name.trim();
    if (!name) {
      setMessage({ tone: "error", text: t("apps.message.skillNameRequired") });
      return undefined;
    }
    try {
      const payload = await appsApiFetch<{ skill?: AppsSkill }>(`/skills/${encodeURIComponent(skill.id)}`, catalog, {
        body: JSON.stringify({
          capabilities: parseCommaList(input.capabilities),
          description: input.description,
          kind: input.kind,
          name,
          slug: input.slug
        }),
        method: "PATCH"
      });
      if (payload.skill) replaceSkill(payload.skill);
      setMessage({ tone: "success", text: t("apps.message.skillMetaUpdated") });
      return payload.skill;
    } catch {
      setApiMode("offline");
      setMessage({ tone: "error", text: t("apps.message.skillMetaUpdateFailed") });
      throw new Error("apps_skill_update_failed");
    }
  }

  async function updateAppAccess(app: AppsApp, input: AppsAppAccessInput): Promise<AppsApp | undefined> {
    if (input.accessMode === "targeted" && input.accessTargets.length === 0) {
      setMessage({ tone: "error", text: t("apps.message.accessTargetsRequired") });
      return undefined;
    }
    try {
      const payload = await appsApiFetch<ApiAppPayload>(`/apps/${encodeURIComponent(app.id)}/visibility`, catalog, {
        body: JSON.stringify({
          accessTargets: input.accessTargets,
          loginRequired: input.loginRequired,
          visibility: input.visibility
        }),
        method: "PATCH"
      });
      if (payload.app) replaceApp(payload.app);
      setMessage({ tone: "success", text: t("apps.message.accessUpdated") });
      return payload.app;
    } catch (error) {
      setMessage({ tone: "error", text: appsAccessUpdateErrorMessage(error, t) });
      throw error;
    }
  }

  async function updateSkillAccess(skill: AppsSkill, input: AppsSkillAccessInput): Promise<AppsSkill | undefined> {
    if (input.accessMode === "targeted" && input.accessTargets.length === 0) {
      setMessage({ tone: "error", text: t("apps.message.accessTargetsRequired") });
      return undefined;
    }
    try {
      const payload = await appsApiFetch<{ skill?: AppsSkill }>(`/skills/${encodeURIComponent(skill.id)}/visibility`, catalog, {
        body: JSON.stringify({
          accessTargets: input.accessTargets,
          loginRequired: true,
          visibility: input.visibility
        }),
        method: "PATCH"
      });
      if (payload.skill) replaceSkill(payload.skill);
      setMessage({ tone: "success", text: t("apps.message.accessUpdated") });
      return payload.skill;
    } catch {
      setApiMode("offline");
      setMessage({ tone: "error", text: t("apps.message.accessUpdateFailed") });
      throw new Error("apps_skill_access_update_failed");
    }
  }

  async function updateAppCollaborators(app: AppsApp, collaboratorUserIds: string[]): Promise<AppsApp | undefined> {
    try {
      const payload = await appsApiFetch<ApiAppPayload>(`/apps/${encodeURIComponent(app.id)}/collaborators`, catalog, {
        body: JSON.stringify({ collaboratorUserIds }),
        method: "PATCH"
      });
      if (payload.app) replaceApp(payload.app);
      setMessage({ tone: "success", text: t("apps.message.collaboratorsUpdated") });
      return payload.app;
    } catch {
      setApiMode("offline");
      setMessage({ tone: "error", text: t("apps.message.collaboratorsUpdateFailed") });
      throw new Error("apps_app_collaborators_update_failed");
    }
  }

  async function updateSkillCollaborators(skill: AppsSkill, collaboratorUserIds: string[]): Promise<AppsSkill | undefined> {
    try {
      const payload = await appsApiFetch<{ skill?: AppsSkill }>(`/skills/${encodeURIComponent(skill.id)}/collaborators`, catalog, {
        body: JSON.stringify({ collaboratorUserIds }),
        method: "PATCH"
      });
      if (payload.skill) replaceSkill(payload.skill);
      setMessage({ tone: "success", text: t("apps.message.collaboratorsUpdated") });
      return payload.skill;
    } catch {
      setApiMode("offline");
      setMessage({ tone: "error", text: t("apps.message.collaboratorsUpdateFailed") });
      throw new Error("apps_skill_collaborators_update_failed");
    }
  }

  async function configureAppSecret(app: AppsApp, input: AppsSecretInput) {
    try {
      const payload = await appsApiFetch<ApiAppPayload>(`/apps/${encodeURIComponent(app.id)}/secrets/value`, catalog, {
        body: JSON.stringify(input),
        method: "POST"
      });
      if (payload.app) replaceApp(payload.app);
      setMessage({ tone: "success", text: t("apps.message.secretSaved") });
    } catch {
      setApiMode("offline");
      setMessage({ tone: "error", text: t("apps.message.secretSaveFailed") });
      throw new Error("apps_secret_update_failed");
    }
  }

  async function deleteAppSecret(app: AppsApp, secret: AppsAppSecret) {
    try {
      const payload = await appsApiFetch<ApiAppPayload>(`/apps/${encodeURIComponent(app.id)}/secrets/value`, catalog, {
        body: JSON.stringify({ environment: secret.environment, name: secret.name }),
        method: "DELETE"
      });
      if (payload.app) replaceApp(payload.app);
      setMessage({ tone: "success", text: t("apps.message.secretDeleted") });
    } catch {
      setApiMode("offline");
      setMessage({ tone: "error", text: t("apps.message.secretDeleteFailed") });
      throw new Error("apps_secret_delete_failed");
    }
  }

  async function deletePublicationListing(listing: PublicationListing | undefined) {
    if (!listing?.id) return;
    const response = await fetch(`/api/listings/${encodeURIComponent(listing.id)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error("publication_listing_delete_failed");
  }

  async function delistPublicationListing(listing: PublicationListing) {
    setMarketSubmittingId(listing.targetId);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/listings/${encodeURIComponent(listing.id)}/status`, {
        body: JSON.stringify({ status: "delisted" }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      });
      if (!response.ok) {
        throw new Error("publication_listing_delist_failed");
      }
      setMessage({ tone: "success", text: t("apps.message.marketDelisted") });
      await onCatalogRefresh();
      return true;
    } catch {
      setMessage({ tone: "error", text: t("apps.message.marketDelistFailed") });
      return false;
    } finally {
      setMarketSubmittingId("");
    }
  }

  async function deleteAppProduct(app: AppsApp, listing: PublicationListing | undefined, confirmation: string) {
    setMessage(undefined);
    try {
      await deletePublicationListing(listing);
      await appsApiFetch(`/apps/${encodeURIComponent(app.id)}`, catalog, {
        body: JSON.stringify({ appCode: confirmation }),
        method: "DELETE"
      });
      setApps((current) => current.filter((item) => item.id !== app.id));
      setMessage({ tone: "success", text: t("apps.message.appDeleted") });
      await onCatalogRefresh();
    } catch {
      setMessage({ tone: "error", text: t("apps.message.deleteFailed") });
      throw new Error("apps_app_delete_failed");
    }
  }

  async function deleteSkillProduct(skill: AppsSkill, listing: PublicationListing | undefined, confirmation: string) {
    setMessage(undefined);
    try {
      await deletePublicationListing(listing);
      await appsApiFetch(`/skills/${encodeURIComponent(skill.id)}`, catalog, {
        body: JSON.stringify({ slug: confirmation }),
        method: "DELETE"
      });
      setSkills((current) => current.filter((item) => item.id !== skill.id));
      setMessage({ tone: "success", text: t("apps.message.skillDeleted") });
      await onCatalogRefresh();
    } catch {
      setMessage({ tone: "error", text: t("apps.message.deleteFailed") });
      throw new Error("apps_skill_delete_failed");
    }
  }

  async function copyAppResourcesToAgent(app: AppsApp, mode: AppsAppHandoffMode = "environment") {
    try {
      const payload = await appsApiFetch<ApiHandoffLinkPayload>(`/apps/${encodeURIComponent(app.id)}/handoff-link`, catalog, { method: "POST" });
      if (!payload.url) throw new Error("missing_handoff_url");
      await copyText(mode === "source-collaboration"
        ? appAgentSourceCollaborationClipboardText(app, payload.url, payload.expiresAt, t)
        : appAgentHandoffClipboardText(app, payload.url, payload.expiresAt, t,
          appHasMailResource(app) ? appMailDevelopmentPrompt(app, locale) : undefined));
      setCopyNotice({
        detail: mode === "source-collaboration"
          ? appAgentSourceCollaborationCopyNotice(payload.expiresAt, t)
          : appAgentHandoffCopyNotice(payload.expiresAt, t),
        title: t("apps.copy.copied")
      });
    } catch {
      setMessage({ tone: "error", text: t("apps.message.copyFailed") });
    }
  }

  function openMcpModal() {
    setIsMcpOpen(true);
    void refreshMcpConnectionStatus();
  }

  return {
    apiMode,
    apps,
    configureAppSecret,
    copyAppResourcesToAgent,
    copyNotice,
    copySkillInstallPrompt,
    createApp,
    createdApp: apps.find((app) => app.id === createdAppId),
    createMate,
    createInput,
    delistPublicationListing,
    deleteAppProduct,
    deleteAppSecret,
    deleteSkillProduct,
    deployMatePreview,
    downloadSkillPackage,
    isCreateOpen,
    isMcpOpen,
    kindFilter,
    marketListedCount,
    marketSubmittingId,
    mcpConnectionStatus,
    mcpStatusMode,
    message,
    matePreviewUrl,
    openMcpModal,
    publishApp,
    publishMate,
    query,
    refreshApp,
    refreshMate,
    refreshMcpConnectionStatus,
    setCopyNotice,
    setCreateInput,
    setIsCreateOpen,
    setIsMcpOpen,
    setKindFilter,
    setQuery,
    setStatusFilter,
    skills,
    mates,
    statusFilter,
    submitAppToMarket,
    submitSkillToMarket,
    submitting,
    saveMateDraft,
    updateAppAccess,
    updateAppCollaborators,
    updateAppConfig,
    updateAppInfo,
    updateSkillAccess,
    updateSkillCollaborators,
    updateSkillInfo,
    updateMateIdentity
  };
}

function matePreviewHostPath(mateId: string, releaseId: string) {
  return `/mates/${encodeURIComponent(mateId)}/preview?${new URLSearchParams({ release: releaseId })}`;
}

export type AppsWorkspaceController = ReturnType<typeof useAppsWorkspace>;
