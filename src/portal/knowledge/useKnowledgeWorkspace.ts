import { useKnowledgeFileEditing } from "./useKnowledgeFileEditing";
import { useKnowledgeRequestSession } from "./useKnowledgeRequestSession";
import { useKnowledgeHistory } from "./useKnowledgeHistory";
import { useKnowledgeInteractions } from "./useKnowledgeInteractions";
import { useKnowledgePublicShare } from "./useKnowledgePublicShare";
import { useKnowledgePublishing } from "./useKnowledgePublishing";
import { useKnowledgeTree } from "./useKnowledgeTree";
import {
  dedupeKnowledgeItems,
  deleteKnowledgeTreeCache,
  isFolderBrowsingSection,
  knowledgeTreeCacheKey,
  writeKnowledgeTreeCache
} from "./tree";
import type {
  KnowledgeFolderCreationMode,
  KnowledgeZipUploadMode,
  KnowledgeAccessGrant,
  KnowledgeAccessResponse,
  KnowledgeCollaboratorsResponse
} from "./workspaceTypes";
export type {
  KnowledgeContextMenu,
  KnowledgePublicShareExpiry,
  KnowledgeFolderCreationMode,
  KnowledgeServiceHandbookStatus,
  KnowledgeZipUploadMode,
  KnowledgeAccessGrant,
  KnowledgeServiceSettingsResponse,
  KnowledgeChangeSummary,
  KnowledgeChangeItem,
  KnowledgeAuditCategory,
  KnowledgeAuditScope
} from "./workspaceTypes";
import { useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { PortalCatalog } from "../../shared/types";
import { useAccessTargetUsers } from "../hooks/useAccessTargetUsers";
import { usePeopleDirectory } from "../hooks/usePeopleDirectory";
import { useUserProfiles } from "../hooks/useUserProfiles";
import { useI18n } from "../i18n";
import type {
  KnowledgeApiItem,
  KnowledgeItem,
  KnowledgeNamespace,
  KnowledgeRole,
  KnowledgeSection,
  KnowledgeViewMode
} from "./types";
import {
  canManageKnowledgeAccess,
  errorMessage,
  filteredItems,
  folderNameError,
  knowledgeFetch,
  knowledgeItemNameError,
  knowledgeVersionUploadFormData,
  normalizeApiItem,
  portalMutationHeaders
} from "./utils";
export type { KnowledgeServiceAccessMode } from "./types";

export function useKnowledgeWorkspace({
  catalog,
  onSectionChange,
  section
}: {
  catalog: PortalCatalog;
  onSectionChange: (section: KnowledgeSection) => void;
  section: KnowledgeSection;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [rootRelation, setRootRelation] = useState<"all" | "mine" | "viewer">("all");
  const [viewMode, setViewMode] = useState<KnowledgeViewMode>("list");
  const [createFolderMode, setCreateFolderMode] = useState<KnowledgeFolderCreationMode>();
  const [folderName, setFolderName] = useState("");
  const [publishOnCreate, setPublishOnCreate] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [versionTarget, setVersionTarget] = useState<KnowledgeItem>();
  const [renameTarget, setRenameTarget] = useState<KnowledgeItem>();
  const [renameName, setRenameName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeItem>();
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[]>([]);
  const [zipUploadMode, setZipUploadMode] = useState<KnowledgeZipUploadMode>("extract");
  const [ownerTransferTarget, setOwnerTransferTarget] = useState<KnowledgeItem>();
  const [ownerTransferUserId, setOwnerTransferUserId] = useState("");
  const [retainPreviousOwner, setRetainPreviousOwner] = useState(true);
  const [accessTarget, setAccessTarget] = useState<KnowledgeItem>();
  const [accessGrants, setAccessGrants] = useState<KnowledgeAccessGrant[]>([]);
  const [collaboratorUserIds, setCollaboratorUserIds] = useState<string[]>([]);
  const [savedCollaboratorUserIds, setSavedCollaboratorUserIds] = useState<string[]>([]);
  const [collaboratorSettingsReady, setCollaboratorSettingsReady] = useState(false);
  const [isAccessLoading, setIsAccessLoading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const versionInputRef = useRef<HTMLInputElement>(null);
  const userId = catalog.currentUser.id;
  const accessSession = useKnowledgeRequestSession(userId, closeAccessSettings);
  const ownerTransferSession = useKnowledgeRequestSession(userId, closeOwnerTransfer);
  const tree = useKnowledgeTree({ userId: catalog.currentUser.id, section, onSectionChange, setMessage, t });
  const {
    items, setItems, rootItems, recentItems, currentPath, setCurrentPath, currentFolderId,
    setCurrentFolderId, folderTrail, setFolderTrail, selectedId, setSelectedId, isLoading,
    treeCache, openBreadcrumb,
    refreshCurrentFolder, updateKnownKnowledgeItem
  } = tree;
  const history = useKnowledgeHistory({ userId: catalog.currentUser.id, t, setMessage });
  const { historyChanges } = history;
  const { people: collaboratorUsers, state: collaboratorDirectoryState } = usePeopleDirectory(
    catalog,
    Boolean(accessTarget || ownerTransferTarget)
  );
  const ownerUserIds = useMemo(
    () => [...new Set([
      ...[...items, ...folderTrail].flatMap((item) => [item.ownerUserId, ...item.collaboratorUserIds]),
      ...historyChanges.map((change) => change.actor?.userId)
    ].filter((value): value is string => Boolean(value)))],
    [folderTrail, historyChanges, items]
  );
  const ownerProfiles = useUserProfiles(ownerUserIds, catalog.currentUser);
  const collaboratorCandidates = useMemo(() => collaboratorUsers.filter((user) => user.id !== catalog.currentUser.id), [catalog.currentUser.id, collaboratorUsers]);
  const collaboratorsChanged = useMemo(
    () => [...collaboratorUserIds].sort().join("\u0000") !== [...savedCollaboratorUserIds].sort().join("\u0000"),
    [collaboratorUserIds, savedCollaboratorUserIds]
  );

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? rootItems.find((item) => item.id === selectedId)
      ?? recentItems.find((item) => item.id === selectedId) ?? folderTrail.find((item) => item.id === selectedId),
    [folderTrail, items, recentItems, rootItems, selectedId]
  );
  const visibleRootItems = useMemo(() => filteredItems(currentFolderId ? rootItems : items, "my", query)
    .filter((item) => item.kind === "folder" && !item.parentPath
      && (rootRelation === "all"
        || rootRelation === "mine" && (item.access === "owner" || item.access === "collaborator")
        || rootRelation === "viewer" && item.access === "viewer")),
  [currentFolderId, items, query, rootItems, rootRelation]);
  const visibleRecentItems = useMemo(() => filteredItems(recentItems, "recent", query), [query, recentItems]);
  const visibleItems = useMemo(() => {
    const filtered = filteredItems(items, section, query);
    if (currentFolderId) {
      return filtered;
    }
    if (section === "my") {
      return visibleRootItems;
    }
    if (section === "services") {
      return filtered.filter((item) => item.agentEnabled || item.accessKinds.includes("knowledge_service"));
    }
    return filtered;
  }, [currentFolderId, items, query, section, visibleRootItems]);
  const editing = useKnowledgeFileEditing({ userId, tree, t, setMessage, onSaved: handleFileSaved });
  const interactions = useKnowledgeInteractions({
    tree, selectedItem, viewMode, editOpen: Boolean(editing.editTarget),
    navigableItems: section === "my" && !currentFolderId ? [...visibleRootItems, ...visibleRecentItems] : visibleItems
  });
  const { setContextMenu, setDetailsOpen, setViewerItem } = interactions;
  function handleFileSaved(objectId: string, versionId: string) {
    const update = (item: KnowledgeItem) => ({ ...item, currentVersionId: versionId });
    updateKnownKnowledgeItem(objectId, update);
    setViewerItem((current) => current?.id === objectId ? update(current) : current);
  }
  const publishing = useKnowledgePublishing({ userId, tree, section, t, setMessage, setContextMenu });
  const { openKnowledgeServiceSettings } = publishing;
  const publicShare = useKnowledgePublicShare({ userId, tree, t, setMessage, setContextMenu });
  const { departments: accessTargetDepartments, state: accessTargetDirectoryState, users: accessTargetUsers } = useAccessTargetUsers(catalog, Boolean(publishing.knowledgeServiceTarget));
  const breadcrumbs = useMemo(
    () => folderTrail.map((item) => ({ label: item.name, path: item.id })),
    [folderTrail]
  );
  const activeFolderRoot = folderTrail[0];
  const currentFolder = folderTrail[folderTrail.length - 1];
  const canEditCurrentFolder = section === "my" && !currentFolderId
    ? true
    : isFolderBrowsingSection(section) && Boolean(activeFolderRoot?.capabilities.canEdit);
  const createFolderOpen = Boolean(createFolderMode);

  function openEditDialog(item: KnowledgeItem) {
    setContextMenu(undefined);
    if (section !== "my") setViewerItem(undefined);
    return editing.openEditDialog(item);
  }

  function openRenameDialog(item: KnowledgeItem) {
    setContextMenu(undefined);
    setSelectedId(item.id);
    setRenameTarget(item);
    setRenameName(item.name);
  }

  function closeRenameDialog() {
    setRenameTarget(undefined);
    setRenameName("");
  }

  function openDeleteDialog(item: KnowledgeItem) {
    setContextMenu(undefined);
    setSelectedId(item.id);
    setDeleteTarget(item);
  }

  function closeDeleteDialog() {
    setDeleteTarget(undefined);
  }

  async function createFolder() {
    const normalizedName = folderName.trim();
    const creationMode = createFolderMode;
    const shouldPublish = creationMode === "knowledgeBase" && publishOnCreate;
    const validationError = folderNameError(normalizedName);
    if (validationError) {
      setMessage(t(validationError));
      return;
    }

    setIsBusy(true);
    try {
      const response = await knowledgeFetch<{ item?: KnowledgeApiItem; namespace?: KnowledgeNamespace }>("/api/folders", {
        body: JSON.stringify({
          name: normalizedName,
          ...(currentFolderId ? { parentObjectId: currentFolderId } : { parentPath: currentPath })
        }),
        headers: portalMutationHeaders(true),
        method: "POST"
      });
      const createdItem = response.item ? normalizeApiItem(response.item) : undefined;
      if (!createdItem) {
        throw new Error("knowledge_folder_response_missing");
      }

      const myRootCacheKey = knowledgeTreeCacheKey("my", "", "");
      const cachedMyRoot = treeCache.get(myRootCacheKey);
      if (!createdItem.parentPath && cachedMyRoot) {
        writeKnowledgeTreeCache(treeCache, myRootCacheKey, dedupeKnowledgeItems([...cachedMyRoot, createdItem]));
      }
      if (!createdItem.parentPath && section === "my" && !currentFolderId) {
        setItems((current) => dedupeKnowledgeItems([...current, createdItem]));
      }

      setSelectedId(createdItem.id);
      closeCreateFolderDialog();
      if (shouldPublish) {
        openKnowledgeServiceSettings(createdItem);
      } else {
        await refreshCurrentFolder();
        setMessage(t("knowledge.folderCreated"));
      }
    } catch (error) {
      setMessage(errorMessage(error, t("knowledge.folderCreateFailed")));
    } finally {
      setIsBusy(false);
    }
  }

  function openCreateFolderDialog() {
    setFolderName("");
    setPublishOnCreate(false);
    setCreateFolderMode("folder");
  }

  function openCreateKnowledgeBaseDialog() {
    setFolderName("");
    setPublishOnCreate(false);
    setCreateFolderMode("knowledgeBase");
  }

  function closeCreateFolderDialog() {
    setCreateFolderMode(undefined);
    setFolderName("");
    setPublishOnCreate(false);
  }

  async function renameItem() {
    const target = renameTarget;
    const normalizedName = renameName.trim();
    const validationError = knowledgeItemNameError(normalizedName);
    if (validationError) {
      setMessage(t(validationError));
      return;
    }
    if (!target) {
      return;
    }
    if (normalizedName === target.name) {
      closeRenameDialog();
      return;
    }

    setIsBusy(true);
    try {
      const response = await knowledgeFetch<{ item?: KnowledgeApiItem }>(`/api/objects/${encodeURIComponent(target.id)}/rename`, {
        body: JSON.stringify({
          expectedCurrentVersionId: target.currentVersionId,
          name: normalizedName
        }),
        headers: portalMutationHeaders(true),
        method: "POST"
      });
      if (response.item) {
        const renamedItem = normalizeApiItem(response.item);
        updateKnownKnowledgeItem(target.id, () => renamedItem);
        if (target.id === currentFolderId) {
          setCurrentPath(renamedItem.path);
        }
      }
      await refreshCurrentFolder();
      setSelectedId(response.item?.id ?? target.id);
      closeRenameDialog();
      setMessage(t("knowledge.renamed"));
    } catch (error) {
      setMessage(errorMessage(error, t("knowledge.renameFailed")));
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteItem() {
    const target = deleteTarget;
    if (!target) {
      return;
    }

    setIsBusy(true);
    try {
      const deletingCurrentFolder = target.id === currentFolderId;
      const expected = target.currentVersionId
        ? `?expectedCurrentVersionId=${encodeURIComponent(target.currentVersionId)}`
        : "";
      await knowledgeFetch(`/api/objects/${encodeURIComponent(target.id)}${expected}`, {
        headers: portalMutationHeaders(),
        method: "DELETE"
      });
      if (deletingCurrentFolder) {
        const nextTrail = folderTrail.slice(0, -1);
        const nextFolder = nextTrail[nextTrail.length - 1];
        const nextFolderId = nextFolder?.id ?? "";
        const nextPath = nextFolder?.path ?? "";
        const nextCacheKey = knowledgeTreeCacheKey(section, nextPath, nextFolderId);
        const nextItems = (treeCache.get(nextCacheKey) ?? []).filter((item) => item.id !== target.id);
        deleteKnowledgeTreeCache(treeCache, knowledgeTreeCacheKey(section, currentPath, currentFolderId));
        writeKnowledgeTreeCache(treeCache, nextCacheKey, nextItems);
        setFolderTrail(nextTrail);
        setCurrentFolderId(nextFolderId);
        setCurrentPath(nextPath);
        setItems(nextItems);
      } else {
        await refreshCurrentFolder();
      }
      setSelectedId((current) => current === target.id ? "" : current);
      setDetailsOpen(false);
      setViewerItem((current) => current && (current.id === target.id || (target.kind === "folder" && current.path.startsWith(`${target.path}/`)))
        ? undefined
        : current);
      closeDeleteDialog();
      setMessage(t("knowledge.deleted"));
    } catch (error) {
      setMessage(errorMessage(error, t("knowledge.deleteFailed")));
    } finally {
      setIsBusy(false);
    }
  }

  async function uploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) {
      return;
    }
    if (files.some(isZipFile)) {
      setPendingUploadFiles(files);
      setZipUploadMode("extract");
      return;
    }
    await uploadSelectedFiles(files);
  }

  async function uploadSelectedFiles(files: File[], selectedZipMode?: KnowledgeZipUploadMode) {
    setIsBusy(true);
    try {
      const uploaded: KnowledgeItem[] = [];
      for (const file of files) {
        const formData = new FormData();
        if (currentFolderId) {
          formData.set("parentObjectId", currentFolderId);
        } else {
          formData.set("parentPath", currentPath);
        }
        formData.set("file", file);
        if (isZipFile(file) && selectedZipMode) {
          formData.set("extractZip", selectedZipMode === "extract" ? "true" : "false");
        }
        const response = await knowledgeFetch<{ item?: KnowledgeApiItem }>("/api/files/upload", {
          body: formData,
          headers: portalMutationHeaders(),
          method: "POST"
        });
        if (response.item) {
          uploaded.push(normalizeApiItem(response.item));
        }
      }
      if (await refreshCurrentFolder()) {
        setSelectedId(uploaded[0]?.id ?? selectedId);
      }
      setMessage(t("knowledge.filesUploaded", { count: uploaded.length }));
    } catch (error) {
      setMessage(errorMessage(error, t("knowledge.uploadFailed")));
    } finally {
      setIsBusy(false);
    }
  }

  async function confirmPendingUpload() {
    const files = pendingUploadFiles;
    if (files.length === 0) return;
    setPendingUploadFiles([]);
    await uploadSelectedFiles(files, zipUploadMode);
  }

  function cancelPendingUpload() {
    setPendingUploadFiles([]);
    setZipUploadMode("extract");
  }

  function requestVersionUpload(item: KnowledgeItem) {
    setVersionTarget(item);
    window.setTimeout(() => versionInputRef.current?.click(), 0);
  }

  async function uploadNewVersion(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const target = versionTarget;
    if (!file || !target) {
      event.target.value = "";
      return;
    }

    setIsBusy(true);
    try {
      const formData = knowledgeVersionUploadFormData(file, target.currentVersionId ?? "");
      const response = await knowledgeFetch<{ item?: KnowledgeApiItem }>(`/api/files/${encodeURIComponent(target.id)}/versions`, {
        body: formData,
        headers: portalMutationHeaders(),
        method: "POST"
      });
      await refreshCurrentFolder();
      setSelectedId(response.item?.id ?? target.id);
      setMessage(t("knowledge.versionUploaded"));
    } catch (error) {
      setMessage(errorMessage(error, t("knowledge.versionUploadFailed")));
    } finally {
      setIsBusy(false);
      setVersionTarget(undefined);
      event.target.value = "";
    }
  }

  function openAccessSettings(item: KnowledgeItem) {
    if (!canManageKnowledgeAccess(item)) {
      return;
    }
    setContextMenu(undefined);
    setSelectedId(item.id);
    setAccessTarget(item);
    setAccessGrants([]);
    setCollaboratorUserIds([]);
    setSavedCollaboratorUserIds([]);
    setCollaboratorSettingsReady(false);
    setIsAccessLoading(true);
    const ticket = accessSession.begin();
    void knowledgeFetch<KnowledgeAccessResponse>(`/api/access?objectId=${encodeURIComponent(item.id)}`)
      .then((response) => {
        if (accessSession.isCurrent(ticket)) {
          const grants = (response.access?.grants ?? []).map(normalizeAccessGrant);
          const collaboratorIds = directCollaboratorUserIds(grants, item.id);
          setAccessGrants(grants);
          setCollaboratorUserIds(collaboratorIds);
          setSavedCollaboratorUserIds(collaboratorIds);
          setCollaboratorSettingsReady(true);
        }
      })
      .catch((error) => {
        if (accessSession.isCurrent(ticket)) setMessage(errorMessage(error, t("knowledge.accessLoadFailed")));
      })
      .then(() => {
        if (accessSession.isCurrent(ticket)) setIsAccessLoading(false);
      });
  }

  function closeAccessSettings() {
    accessSession.invalidate();
    setAccessTarget(undefined);
    setAccessGrants([]);
    setCollaboratorUserIds([]);
    setSavedCollaboratorUserIds([]);
    setCollaboratorSettingsReady(false);
    setIsAccessLoading(false);
  }

  async function saveCollaborators() {
    const target = accessTarget;
    const ticket = accessSession.capture();
    if (!target || !accessSession.isCurrent(ticket) || isAccessLoading || collaboratorDirectoryState !== "ready" || !collaboratorSettingsReady) {
      return;
    }
    setIsAccessLoading(true);
    try {
      const response = await knowledgeFetch<KnowledgeCollaboratorsResponse>(
        `/api/objects/${encodeURIComponent(target.id)}/collaborators`,
        {
          body: JSON.stringify({ userIds: collaboratorUserIds }),
          headers: portalMutationHeaders(true),
          method: "PUT"
        }
      );
      const collaborators = (response.collaborators ?? []).map(normalizeAccessGrant);
      const savedUserIds = response.userIds ?? directCollaboratorUserIds(collaborators, target.id);
      if (accessSession.isCurrent(ticket)) {
        setAccessGrants((current) => [
          ...current.filter((grant) => !(grant.objectId === target.id
            && grant.subjectType === "user"
            && grant.role === "collaborator")),
          ...collaborators
        ]);
        setCollaboratorUserIds(savedUserIds);
        setSavedCollaboratorUserIds(savedUserIds);
        updateKnownKnowledgeItem(target.id, (item) => ({
          ...item,
          collaboratorCount: savedUserIds.length,
          collaboratorUserIds: savedUserIds
        }));
        setMessage(t("knowledge.collaboratorsSaved"));
        closeAccessSettings();
      }
    } catch (error) {
      if (accessSession.isCurrent(ticket)) setMessage(errorMessage(error, t("knowledge.collaboratorsSaveFailed")));
    } finally {
      if (accessSession.isCurrent(ticket)) setIsAccessLoading(false);
    }
  }

  function openOwnerTransfer(item: KnowledgeItem) {
    if (!item.capabilities.canTransferOwnership || item.kind !== "folder" || item.parentPath) return;
    setContextMenu(undefined);
    ownerTransferSession.begin();
    setIsAccessLoading(false);
    setOwnerTransferTarget(item);
    setOwnerTransferUserId("");
    setRetainPreviousOwner(true);
  }

  function closeOwnerTransfer() {
    ownerTransferSession.invalidate();
    setIsAccessLoading(false);
    setOwnerTransferTarget(undefined);
    setOwnerTransferUserId("");
    setRetainPreviousOwner(true);
  }

  async function initiateOwnerTransfer() {
    const target = ownerTransferTarget;
    const ticket = ownerTransferSession.capture();
    if (!target || !ownerTransferUserId || isAccessLoading || !ownerTransferSession.isCurrent(ticket)) return;
    setIsAccessLoading(true);
    try {
      await knowledgeFetch(`/api/objects/${encodeURIComponent(target.id)}/owner-transfer`, {
        body: JSON.stringify({
          retainPreviousOwner,
          toUserId: ownerTransferUserId
        }),
        headers: portalMutationHeaders(true),
        method: "POST"
      });
      if (!ownerTransferSession.isCurrent(ticket)) return;
      closeOwnerTransfer();
      setMessage(t("knowledge.ownerTransferStarted"));
    } catch (error) {
      if (ownerTransferSession.isCurrent(ticket)) setMessage(errorMessage(error, t("knowledge.ownerTransferFailed")));
    } finally {
      if (ownerTransferSession.isCurrent(ticket)) setIsAccessLoading(false);
    }
  }

  return {
    ...interactions,
    ...publishing,
    ...publicShare,
    ...history,
    ...editing,
    accessGrants,
    accessTarget,
    accessTargetDepartments,
    accessTargetDirectoryState,
    accessTargetUsers,
    async saveKnowledgeService() {
      if (publishing.knowledgeServiceAccessMode === "targeted" && accessTargetDirectoryState !== "ready") {
        setMessage(t("knowledge.serviceAccessDirectoryError"));
        return;
      }
      return publishing.saveKnowledgeService();
    },
    breadcrumbs,
    canEditCurrentFolder,
    closeAccessSettings,
    closeCreateFolderDialog,
    closeDeleteDialog,
    closeOwnerTransfer,
    closeRenameDialog,
    collaboratorCandidates,
    collaboratorDirectoryState,
    collaboratorSettingsReady,
    collaboratorUserIds,
    collaboratorsChanged,
    cancelPendingUpload,
    confirmPendingUpload,
    createFolder,
    createFolderMode,
    createFolderOpen,
    publishOnCreate,
    currentFolder,
    currentFolderId,
    currentPath,
    deleteItem,
    deleteTarget,
    folderName,
    isBusy,
    isAccessLoading,
    isLoading,
    items,
    message,
    openCreateFolderDialog,
    openCreateKnowledgeBaseDialog,
    openDeleteDialog,
    openAccessSettings,
    openEditDialog,
    openBreadcrumb,
    openOwnerTransfer,
    openRenameDialog,
    ownerProfiles,
    ownerTransferTarget,
    ownerTransferUserId,
    pendingUploadFiles,
    query,
    rootRelation,
    visibleRootItems,
    visibleRecentItems,
    renameItem,
    renameName,
    renameTarget,
    requestVersionUpload,
    retainPreviousOwner,
    saveCollaborators,
    section,
    selectedId,
    selectedItem,
    setDeleteTarget,
    setFolderName,
    setPublishOnCreate,
    setCollaboratorUserIds,
    setMessage,
    setQuery,
    setRootRelation,
    setRenameName,
    setOwnerTransferUserId,
    setRetainPreviousOwner,
    setViewMode,
    setZipUploadMode,
    uploadFiles,
    uploadInputRef,
    uploadNewVersion,
    initiateOwnerTransfer,
    versionInputRef,
    viewMode,
    visibleItems,
    zipUploadMode
  };
}

export type KnowledgeWorkspaceController = ReturnType<typeof useKnowledgeWorkspace>;

function directCollaboratorUserIds(grants: KnowledgeAccessGrant[], objectId: string) {
  return [...new Set(grants
    .filter((grant) => grant.objectId === objectId && grant.subjectType === "user" && grant.role === "collaborator")
    .map((grant) => grant.subjectId))];
}

function normalizeAccessGrant(grant: Omit<KnowledgeAccessGrant, "role"> & { role: KnowledgeRole | "editor" }): KnowledgeAccessGrant {
  return {
    ...grant,
    role: grant.role === "editor" ? "collaborator" : grant.role
  };
}

function isZipFile(file: File) {
  const mimeType = file.type.toLowerCase();
  return file.name.toLowerCase().endsWith(".zip")
    || mimeType === "application/zip"
    || mimeType === "application/x-zip-compressed";
}
