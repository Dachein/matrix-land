import { useState } from "react";
import { useKnowledgeRequestSession } from "./useKnowledgeRequestSession";
import type { KnowledgeItem, KnowledgeSection, KnowledgeServiceAccessMode, KnowledgeTranslate } from "./types";
import type {
  KnowledgeContextMenu,
  KnowledgeServiceHandbookStatus,
  KnowledgeServiceSettingsResponse,
  KnowledgeServicePreflightResponse
} from "./workspaceTypes";
import type { useKnowledgeTree } from "./useKnowledgeTree";
import { dedupeKnowledgeItems, knowledgeTreeCacheKey, writeKnowledgeTreeCache } from "./tree";
import {
  canManageKnowledgeService,
  canUpdateKnowledgeServiceInfo,
  errorMessage,
  knowledgeFetch,
  knowledgeServiceAccessPayload,
  normalizeKnowledgeServiceAccess,
  portalMutationHeaders
} from "./utils";

// Own publication settings, handbook preflight and service lifecycle.
export function useKnowledgePublishing({ userId, tree, section, t, setMessage, setContextMenu }: {
  userId: string;
  tree: Pick<ReturnType<typeof useKnowledgeTree>, "items" | "setItems" | "currentFolderId" | "treeCache" | "updateKnownKnowledgeItem" | "setSelectedId">;
  section: KnowledgeSection;
  t: KnowledgeTranslate;
  setMessage: (message: string) => void;
  setContextMenu: (menu: KnowledgeContextMenu | undefined) => void;
}) {
  const { items, setItems, currentFolderId, treeCache, updateKnownKnowledgeItem, setSelectedId } = tree;
  const [knowledgeServiceTarget, setKnowledgeServiceTarget] = useState<KnowledgeItem>();
  const [disableKnowledgeServiceTarget, setDisableKnowledgeServiceTarget] = useState<KnowledgeItem>();
  const [knowledgeServiceName, setKnowledgeServiceName] = useState("");
  const [knowledgeServiceDescription, setKnowledgeServiceDescription] = useState("");
  const [knowledgeServiceCategory, setKnowledgeServiceCategory] = useState("general");
  const [knowledgeServiceTags, setKnowledgeServiceTags] = useState("");
  const [knowledgeServiceLanguages, setKnowledgeServiceLanguages] = useState("");
  const [knowledgeServiceMaintenanceTeam, setKnowledgeServiceMaintenanceTeam] = useState("");
  const [knowledgeServiceAdvancedOpen, setKnowledgeServiceAdvancedOpen] = useState(false);
  const [knowledgeServiceRole, setKnowledgeServiceRole] = useState("");
  const [knowledgeServiceBestFor, setKnowledgeServiceBestFor] = useState("");
  const [knowledgeServiceNotFor, setKnowledgeServiceNotFor] = useState("");
  const [knowledgeServiceKeywords, setKnowledgeServiceKeywords] = useState("");
  const [knowledgeServiceSearchHints, setKnowledgeServiceSearchHints] = useState("");
  const [knowledgeServiceResult, setKnowledgeServiceResult] = useState<KnowledgeServiceSettingsResponse>();
  const [knowledgeServiceAccessMode, setKnowledgeServiceAccessMode] = useState<KnowledgeServiceAccessMode>("private");
  const [knowledgeServiceAccessTargets, setKnowledgeServiceAccessTargets] = useState<string[]>([]);
  const [knowledgeServiceHandbookStatus, setKnowledgeServiceHandbookStatus] = useState<KnowledgeServiceHandbookStatus>("checking");
  const [knowledgeServiceCreateHandbookTemplate, setKnowledgeServiceCreateHandbookTemplate] = useState(true);
  const [knowledgeServiceSettingsReady, setKnowledgeServiceSettingsReady] = useState(false);
  const [disableKnowledgeServiceConfirmed, setDisableKnowledgeServiceConfirmed] = useState(false);
  const [isKnowledgeServiceLoading, setIsKnowledgeServiceLoading] = useState(false);
  const [isSavingKnowledgeService, setIsSavingKnowledgeService] = useState(false);
  const session = useKnowledgeRequestSession(userId, closeKnowledgeServiceSettings);
  const disableSession = useKnowledgeRequestSession(userId, closeDisableKnowledgeService);
  function openKnowledgeServiceSettings(item: KnowledgeItem) {
    if (!canManageKnowledgeService(item) && !canUpdateKnowledgeServiceInfo(item)) {
      return;
    }
    setContextMenu(undefined);
    setSelectedId(item.id);
    setKnowledgeServiceTarget(item);
    setKnowledgeServiceName(item.name);
    setKnowledgeServiceDescription(item.description);
    setKnowledgeServiceCategory("general");
    setKnowledgeServiceTags("");
    setKnowledgeServiceLanguages("");
    setKnowledgeServiceMaintenanceTeam(item.maintenanceTeam);
    setKnowledgeServiceAdvancedOpen(false);
    setKnowledgeServiceRole(item.knowledgeServiceCard?.role ?? "");
    setKnowledgeServiceBestFor((item.knowledgeServiceCard?.bestFor ?? []).join("\n"));
    setKnowledgeServiceNotFor((item.knowledgeServiceCard?.notFor ?? []).join("\n"));
    setKnowledgeServiceKeywords((item.knowledgeServiceCard?.keywords ?? []).join(", "));
    setKnowledgeServiceSearchHints((item.knowledgeServiceCard?.searchHints ?? []).join("\n"));
    setKnowledgeServiceResult(undefined);
    setKnowledgeServiceAccessMode("private");
    setKnowledgeServiceAccessTargets([]);
    setKnowledgeServiceHandbookStatus("checking");
    setKnowledgeServiceCreateHandbookTemplate(true);
    setKnowledgeServiceSettingsReady(!item.agentEnabled);
    setDisableKnowledgeServiceConfirmed(false);
    setIsSavingKnowledgeService(false);
    setIsKnowledgeServiceLoading(Boolean(item.agentEnabled && item.knowledgeServiceId));
    const ticket = session.begin();
    if (canManageKnowledgeService(item)) {
      void checkKnowledgeServiceHandbook(item, ticket);
    } else {
      setKnowledgeServiceHandbookStatus("present");
    }
    // A descendant can report the enclosing service id for read access. It is
    // not the service owned by this folder unless Agent access is enabled on
    // the folder itself.
    if (!item.agentEnabled || !item.knowledgeServiceId) {
      return;
    }
    void knowledgeFetch<KnowledgeServiceSettingsResponse>(`/api/knowledge-services/${encodeURIComponent(item.knowledgeServiceId)}`)
      .then((response) => {
        if (session.isCurrent(ticket)) {
          setKnowledgeServiceResult(response);
          setKnowledgeServiceName(response.service?.name ?? item.name);
          setKnowledgeServiceDescription(response.service?.description ?? item.description);
          setKnowledgeServiceCategory(response.service?.category ?? "general");
          setKnowledgeServiceTags((response.service?.tags ?? []).join(", "));
          setKnowledgeServiceLanguages((response.service?.languages ?? []).join(", "));
          setKnowledgeServiceMaintenanceTeam(response.service?.maintenanceTeam ?? item.maintenanceTeam);
          const card = response.service?.card;
          setKnowledgeServiceRole(card?.role ?? response.service?.role ?? "");
          setKnowledgeServiceBestFor((card?.bestFor ?? response.service?.coverage ?? []).join("\n"));
          setKnowledgeServiceNotFor((card?.notFor ?? response.service?.notFor ?? []).join("\n"));
          setKnowledgeServiceKeywords((card?.keywords ?? response.service?.tags ?? []).join(", "));
          setKnowledgeServiceSearchHints((card?.searchHints ?? response.service?.searchHints ?? []).join("\n"));
          if (!canManageKnowledgeService(item)) {
            setKnowledgeServiceSettingsReady(true);
          } else if (applyKnowledgeServiceAccess(response)) {
            setKnowledgeServiceSettingsReady(true);
          } else {
            setKnowledgeServiceSettingsReady(false);
            setMessage(t("knowledge.serviceSettingsUnavailable"));
          }
        }
      })
      .catch((error) => {
        if (session.isCurrent(ticket)) setMessage(errorMessage(error, t("knowledge.serviceLoadFailed")));
      })
      .then(() => {
        if (session.isCurrent(ticket)) setIsKnowledgeServiceLoading(false);
      });
  }

  function openDisableKnowledgeService(item: KnowledgeItem) {
    if (!item.agentEnabled || !item.knowledgeServiceId || !canManageKnowledgeService(item)) {
      return;
    }
    setContextMenu(undefined);
    setSelectedId(item.id);
    disableSession.begin();
    setIsSavingKnowledgeService(false);
    setDisableKnowledgeServiceTarget(item);
    setDisableKnowledgeServiceConfirmed(false);
  }

  function closeDisableKnowledgeService() {
    disableSession.invalidate();
    setIsSavingKnowledgeService(false);
    setDisableKnowledgeServiceTarget(undefined);
    setDisableKnowledgeServiceConfirmed(false);
  }

  async function checkKnowledgeServiceHandbook(target = knowledgeServiceTarget, ticket = session.capture()) {
    if (!target) return;
    setKnowledgeServiceHandbookStatus("checking");
    try {
      const response = await knowledgeFetch<KnowledgeServicePreflightResponse>(`/api/knowledge-services/preflight?folderObjectId=${encodeURIComponent(target.id)}`);
      if (!session.isCurrent(ticket)) return;
      setKnowledgeServiceHandbookStatus(response.ready || response.status === "ready" ? "present" : "missing");
    } catch {
      if (session.isCurrent(ticket)) setKnowledgeServiceHandbookStatus("error");
    }
  }

  async function ensureStarterKnowledgeHandbook(target: KnowledgeItem, ticket: symbol | null) {
    const preflight = await knowledgeFetch<KnowledgeServicePreflightResponse>(`/api/knowledge-services/preflight?folderObjectId=${encodeURIComponent(target.id)}`);
    if (preflight.ready || preflight.status === "ready") {
      if (session.isCurrent(ticket)) setKnowledgeServiceHandbookStatus("present");
      return;
    }

    const formData = new FormData();
    formData.set("parentObjectId", target.id);
    formData.set("file", new File(
      [t("knowledge.handbookTemplateContent", { folderName: target.name.replace(/\s+/g, " ").trim() })],
      "handbook.md",
      { type: "text/markdown" }
    ));
    await knowledgeFetch("/api/files/upload", {
      body: formData,
      headers: portalMutationHeaders(),
      method: "POST"
    });
    if (session.isCurrent(ticket)) setKnowledgeServiceHandbookStatus("present");
  }

  function applyKnowledgeServiceAccess(response: KnowledgeServiceSettingsResponse) {
    const access = response.service?.access ?? response.access;
    const selection = normalizeKnowledgeServiceAccess(access);
    if (!selection) {
      return false;
    }
    setKnowledgeServiceAccessMode(selection.mode);
    setKnowledgeServiceAccessTargets(selection.targets);
    return true;
  }

  function closeKnowledgeServiceSettings() {
    session.invalidate();
    setKnowledgeServiceTarget(undefined);
    setKnowledgeServiceName("");
    setKnowledgeServiceDescription("");
    setKnowledgeServiceCategory("general");
    setKnowledgeServiceTags("");
    setKnowledgeServiceLanguages("");
    setKnowledgeServiceMaintenanceTeam("");
    setKnowledgeServiceAdvancedOpen(false);
    setKnowledgeServiceRole("");
    setKnowledgeServiceBestFor("");
    setKnowledgeServiceNotFor("");
    setKnowledgeServiceKeywords("");
    setKnowledgeServiceSearchHints("");
    setKnowledgeServiceResult(undefined);
    setKnowledgeServiceAccessMode("private");
    setKnowledgeServiceAccessTargets([]);
    setKnowledgeServiceHandbookStatus("checking");
    setKnowledgeServiceCreateHandbookTemplate(true);
    setKnowledgeServiceSettingsReady(false);
    setDisableKnowledgeServiceConfirmed(false);
    setIsKnowledgeServiceLoading(false);
    setIsSavingKnowledgeService(false);
  }

  async function saveKnowledgeService() {
    const target = knowledgeServiceTarget;
    const ticket = session.capture();
    const infoOnlyTarget = Boolean(target?.agentEnabled && target.knowledgeServiceId && !canManageKnowledgeService(target));
    if (!target
      || !session.isCurrent(ticket)
      || isSavingKnowledgeService
      || !knowledgeServiceSettingsReady
      || isKnowledgeServiceLoading
      || (!target.agentEnabled && knowledgeServiceHandbookStatus !== "present" && !knowledgeServiceCreateHandbookTemplate)
      || (!infoOnlyTarget && knowledgeServiceAccessMode === "targeted" && knowledgeServiceAccessTargets.length === 0)) {
      return;
    }
    const serviceId = target.agentEnabled ? target.knowledgeServiceId ?? knowledgeServiceResult?.service?.id : undefined;
    const infoOnly = Boolean(serviceId && !canManageKnowledgeService(target));
    setIsSavingKnowledgeService(true);
    try {
      if (!target.agentEnabled && knowledgeServiceHandbookStatus !== "present") {
        await ensureStarterKnowledgeHandbook(target, ticket);
      }
      const response = await knowledgeFetch<KnowledgeServiceSettingsResponse>(serviceId
        ? `/api/knowledge-services/${encodeURIComponent(serviceId)}${infoOnly ? "/info" : ""}`
        : "/api/knowledge-services", {
        body: JSON.stringify({
          ...(infoOnly ? {} : {
            agentEnabled: true,
            access: knowledgeServiceAccessPayload(
              knowledgeServiceAccessMode,
              knowledgeServiceAccessTargets
            ),
            folderObjectId: target.id,
            languages: commaSeparatedValues(knowledgeServiceLanguages),
            maintenanceTeam: knowledgeServiceMaintenanceTeam.trim(),
            name: knowledgeServiceName.trim() || target.name
          }),
          description: knowledgeServiceDescription.trim(),
          ...(infoOnly ? {} : {
            category: knowledgeServiceCategory.trim().toLowerCase() || "general",
            feedbackEnabled: true
          }),
          bestFor: lineSeparatedValues(knowledgeServiceBestFor),
          keywords: commaSeparatedValues(knowledgeServiceKeywords),
          notFor: lineSeparatedValues(knowledgeServiceNotFor),
          role: knowledgeServiceRole.trim(),
          searchHints: lineSeparatedValues(knowledgeServiceSearchHints)
        }),
        headers: portalMutationHeaders(true),
        method: serviceId ? "PATCH" : "POST"
      });
      const nextServiceId = response.service?.id ?? serviceId;
      const enableKnowledgeService = (item: KnowledgeItem): KnowledgeItem => ({
        ...item,
        accessKinds: item.accessKinds.includes("knowledge_service") ? item.accessKinds : [...item.accessKinds, "knowledge_service"],
        agentEnabled: true,
        capabilities: { ...item.capabilities, canUseKnowledgeService: true },
        description: knowledgeServiceDescription.trim(),
        feedbackEnabled: response.service?.feedbackEnabled !== false,
        handbookObjectId: response.service?.handbookObjectId ?? item.handbookObjectId,
        indexStatus: response.service?.indexStatus ?? item.indexStatus ?? "pending",
        knowledgeServiceId: nextServiceId,
        knowledgeServiceCard: {
          bestFor: lineSeparatedValues(knowledgeServiceBestFor),
          keywords: commaSeparatedValues(knowledgeServiceKeywords),
          notFor: lineSeparatedValues(knowledgeServiceNotFor),
          role: knowledgeServiceRole.trim(),
          searchHints: lineSeparatedValues(knowledgeServiceSearchHints)
        },
        maintenanceTeam: response.service?.maintenanceTeam ?? knowledgeServiceMaintenanceTeam.trim(),
        skillReady: undefined,
        withinKnowledgeService: true
      });
      const enabledTarget = enableKnowledgeService(target);
      updateKnownKnowledgeItem(target.id, enableKnowledgeService);
      if (section === "services" && !currentFolderId && !items.some((item) => item.id === target.id)) {
        setItems((current) => dedupeKnowledgeItems([...current, enabledTarget]));
        const servicesRootCacheKey = knowledgeTreeCacheKey("services", "", "");
        const cachedServicesRoot = treeCache.get(servicesRootCacheKey) ?? [];
        writeKnowledgeTreeCache(treeCache, servicesRootCacheKey, dedupeKnowledgeItems([...cachedServicesRoot, enabledTarget]));
      }
      if (session.isCurrent(ticket)) {
        setKnowledgeServiceResult(response);
        if (!infoOnly) applyKnowledgeServiceAccess(response);
        setKnowledgeServiceTarget((current) => current ? {
          ...current,
          agentEnabled: true,
          capabilities: { ...current.capabilities, canUseKnowledgeService: true },
          description: knowledgeServiceDescription.trim(),
          feedbackEnabled: response.service?.feedbackEnabled !== false,
          knowledgeServiceId: nextServiceId,
          knowledgeServiceCard: {
            bestFor: lineSeparatedValues(knowledgeServiceBestFor),
            keywords: commaSeparatedValues(knowledgeServiceKeywords),
            notFor: lineSeparatedValues(knowledgeServiceNotFor),
            role: knowledgeServiceRole.trim(),
            searchHints: lineSeparatedValues(knowledgeServiceSearchHints)
          },
          maintenanceTeam: response.service?.maintenanceTeam ?? knowledgeServiceMaintenanceTeam.trim(),
          indexStatus: response.service?.indexStatus ?? current.indexStatus ?? "pending",
          withinKnowledgeService: true
        } : current);
        setMessage(t(target.agentEnabled ? "knowledge.serviceUpdated" : "knowledge.serviceEnabled"));
      }
    } catch (error) {
      if (session.isCurrent(ticket)) {
        if (error instanceof Error && error.message.includes("knowledge_service_handbook_missing")) {
          setKnowledgeServiceHandbookStatus("missing");
          setMessage(t("knowledge.handbookRequired"));
        } else if (error instanceof Error && error.message.includes("knowledge_service_inherited_viewer_conflict")) {
          setMessage(t("knowledge.serviceInheritedViewerConflict"));
        } else {
          setMessage(errorMessage(error, t("knowledge.serviceSaveFailed")));
        }
      }
    } finally {
      if (session.isCurrent(ticket)) setIsSavingKnowledgeService(false);
    }
  }

  async function disableKnowledgeService() {
    const dedicatedTarget = disableKnowledgeServiceTarget;
    const ticket = session.capture();
    const disableTicket = disableSession.capture();
    const target = dedicatedTarget ?? knowledgeServiceTarget;
    const serviceId = target?.knowledgeServiceId
      ?? (target?.id === knowledgeServiceTarget?.id ? knowledgeServiceResult?.service?.id : undefined);
    const isDedicatedDialog = dedicatedTarget?.id === target?.id;
    const isCurrent = () => dedicatedTarget ? disableSession.isCurrent(disableTicket) : session.isCurrent(ticket);
    if (!target || !serviceId || isSavingKnowledgeService || !isCurrent() || !disableKnowledgeServiceConfirmed) {
      return;
    }
    setIsSavingKnowledgeService(true);
    try {
      await knowledgeFetch<KnowledgeServiceSettingsResponse>(`/api/knowledge-services/${encodeURIComponent(serviceId)}`, {
        body: JSON.stringify({ agentEnabled: false }),
        headers: portalMutationHeaders(true),
        method: "PATCH"
      });
      updateKnownKnowledgeItem(target.id, (item) => ({
        ...item,
        accessKinds: item.accessKinds.filter((kind) => kind !== "knowledge_service"),
        agentEnabled: false,
        capabilities: { ...item.capabilities, canUseKnowledgeService: false },
        indexStatus: "disabled",
        skillReady: undefined,
        withinKnowledgeService: false
      }));
      if (isDedicatedDialog && isCurrent()) {
        closeDisableKnowledgeService();
        setMessage(t("knowledge.serviceDisabled"));
      } else if (!isDedicatedDialog && session.isCurrent(ticket)) {
        closeKnowledgeServiceSettings();
        setMessage(t("knowledge.serviceDisabled"));
      }
    } catch (error) {
      if (isCurrent()) {
        setMessage(errorMessage(error, t("knowledge.serviceDisableFailed")));
      }
    } finally {
      if (isCurrent()) setIsSavingKnowledgeService(false);
    }
  }

  return {
    knowledgeServiceTarget,
    disableKnowledgeServiceTarget,
    knowledgeServiceName,
    setKnowledgeServiceName,
    knowledgeServiceDescription,
    setKnowledgeServiceDescription,
    knowledgeServiceCategory,
    setKnowledgeServiceCategory,
    knowledgeServiceTags,
    setKnowledgeServiceTags,
    knowledgeServiceLanguages,
    setKnowledgeServiceLanguages,
    knowledgeServiceMaintenanceTeam,
    setKnowledgeServiceMaintenanceTeam,
    knowledgeServiceAdvancedOpen,
    setKnowledgeServiceAdvancedOpen,
    knowledgeServiceRole,
    setKnowledgeServiceRole,
    knowledgeServiceBestFor,
    setKnowledgeServiceBestFor,
    knowledgeServiceNotFor,
    setKnowledgeServiceNotFor,
    knowledgeServiceKeywords,
    setKnowledgeServiceKeywords,
    knowledgeServiceSearchHints,
    setKnowledgeServiceSearchHints,
    knowledgeServiceResult,
    knowledgeServiceAccessMode,
    setKnowledgeServiceAccessMode,
    knowledgeServiceAccessTargets,
    setKnowledgeServiceAccessTargets,
    knowledgeServiceHandbookStatus,
    knowledgeServiceCreateHandbookTemplate,
    setKnowledgeServiceCreateHandbookTemplate,
    knowledgeServiceSettingsReady,
    disableKnowledgeServiceConfirmed,
    setDisableKnowledgeServiceConfirmed,
    isKnowledgeServiceLoading,
    isSavingKnowledgeService,
    openKnowledgeServiceSettings,
    openDisableKnowledgeService,
    closeDisableKnowledgeService,
    closeKnowledgeServiceSettings,
    saveKnowledgeService,
    disableKnowledgeService,
    recheckKnowledgeServiceHandbook: checkKnowledgeServiceHandbook,
  };
}

function commaSeparatedValues(value: string) {
  return [...new Set(value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean))];
}

function lineSeparatedValues(value: string) {
  return [...new Set(value
    .split(/\n|;/)
    .map((entry) => entry.trim())
    .filter(Boolean))];
}
