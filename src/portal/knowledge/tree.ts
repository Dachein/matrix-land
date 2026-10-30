import type { KnowledgeApiItem, KnowledgeItem, KnowledgeRole, KnowledgeSection, KnowledgeTreeResponse } from "./types";
import type { KnowledgeServicesResponse, KnowledgeServiceListEntry } from "./workspaceTypes";
import { knowledgeApiBase, knowledgeFetch } from "./utils";

const KNOWLEDGE_TREE_CACHE_MAX_AGE_MS = 30 * 1000;
const knowledgeTreeCacheByUser = new Map<string, Map<string, KnowledgeItem[]>>();
const knowledgeTreeCacheTimes = new WeakMap<Map<string, KnowledgeItem[]>, Map<string, number>>();

export function recentKnowledgeStorageKey(userId: string) {
  return `workspace:knowledge:recent:${userId}`;
}

export function readRecentKnowledgeItems(userId: string): KnowledgeItem[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(recentKnowledgeStorageKey(userId)) || "[]");
    return Array.isArray(value) ? value.filter((item): item is KnowledgeItem =>
      Boolean(item && typeof item.id === "string" && typeof item.name === "string" && typeof item.kind === "string" && item.kind !== "folder")
    ).slice(0, 20) : [];
  } catch {
    return [];
  }
}

export async function loadTree(section: KnowledgeSection, currentPath: string, currentFolderId: string, signal?: AbortSignal) {
  if (currentFolderId && isFolderBrowsingSection(section)) {
    return knowledgeFetch<KnowledgeTreeResponse>(`/api/tree?folderObjectId=${encodeURIComponent(currentFolderId)}`, { signal });
  }
  if (section === "my") {
    const [personal, collaborating, services] = await Promise.allSettled([
      knowledgeFetch<KnowledgeTreeResponse>(`/api/tree?prefix=${encodeURIComponent(currentPath)}`, { signal }),
      knowledgeFetch<KnowledgeTreeResponse>("/api/shared-with-me", { signal }),
      knowledgeFetch<KnowledgeServicesResponse>("/api/knowledge-services", { signal })
    ]);
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    if (personal.status === "rejected") {
      throw personal.reason;
    }
    return {
      ...personal.value,
      items: mergeKnowledgeRootItems([
        ...(personal.value.items ?? []),
        ...(collaborating.status === "fulfilled" ? collaborating.value.items ?? [] : []),
        ...(services.status === "fulfilled" ? (services.value.services ?? []).flatMap(knowledgeServiceListItem) : [])
      ])
    };
  }
  if (section === "services") {
    const response = await knowledgeFetch<KnowledgeServicesResponse>("/api/knowledge-services", { signal });
    return { items: (response.services ?? []).flatMap(knowledgeServiceListItem) };
  }
  return knowledgeFetch<KnowledgeTreeResponse>("/api/tree?prefix=", { signal });
}

function mergeKnowledgeRootItems(items: KnowledgeApiItem[]) {
  const byId = new Map<string, KnowledgeApiItem>();
  for (const item of items) {
    const previous = byId.get(item.id);
    byId.set(item.id, previous ? { ...previous, ...item,
      agentEnabled: Boolean(previous.agentEnabled || item.agentEnabled),
      accessKinds: [...new Set([...(previous.accessKinds ?? []), ...(item.accessKinds ?? [])])]
    } : item);
  }
  return [...byId.values()];
}

export function knowledgeTreeCacheKey(section: KnowledgeSection, currentPath: string, currentFolderId: string) {
  return `${section}:${currentFolderId || currentPath || "root"}`;
}

export function knowledgeTreeCacheForUser(userId: string) {
  const key = `${knowledgeApiBase()}:${userId}`;
  const existing = knowledgeTreeCacheByUser.get(key);
  if (existing) {
    return existing;
  }
  const cache = new Map<string, KnowledgeItem[]>();
  knowledgeTreeCacheByUser.set(key, cache);
  knowledgeTreeCacheTimes.set(cache, new Map());
  return cache;
}

export function knowledgeTreeCacheFresh(cache: Map<string, KnowledgeItem[]>, key: string, now = Date.now()) {
  const cachedAt = knowledgeTreeCacheTimes.get(cache)?.get(key) ?? 0;
  return now - cachedAt < KNOWLEDGE_TREE_CACHE_MAX_AGE_MS;
}

export function writeKnowledgeTreeCache(cache: Map<string, KnowledgeItem[]>, key: string, items: KnowledgeItem[]) {
  cache.set(key, items);
  const cacheTimes = knowledgeTreeCacheTimes.get(cache) ?? new Map<string, number>();
  cacheTimes.set(key, Date.now());
  knowledgeTreeCacheTimes.set(cache, cacheTimes);
}

export function deleteKnowledgeTreeCache(cache: Map<string, KnowledgeItem[]>, key: string) {
  cache.delete(key);
  knowledgeTreeCacheTimes.get(cache)?.delete(key);
}

function knowledgeServiceListItem(service: KnowledgeServiceListEntry): KnowledgeApiItem[] {
  if (service.folder) {
    const card = normalizedKnowledgeServiceCard(service);
    return [{
      ...service.folder,
      accessKind: "knowledge_service",
      agentEnabled: true,
      collaboratorCount: service.collaboratorCount
        ?? service.collaboratorUserIds?.length
        ?? service.folder.collaboratorCount,
      collaboratorUserIds: service.collaboratorUserIds ?? service.folder.collaboratorUserIds,
      description: service.description ?? service.folder.description,
      feedbackEnabled: service.feedbackEnabled,
      handbookObjectId: service.handbookObjectId ?? service.folder.handbookObjectId,
      indexStatus: service.indexStatus ?? service.folder.indexStatus,
      knowledgeServiceId: service.id ?? service.folder.knowledgeServiceId,
      knowledgeServiceCard: card,
      maintenanceTeam: service.maintenanceTeam ?? service.folder.maintenanceTeam
    }];
  }
  const id = service.folderObjectId?.trim();
  if (!id) return [];
  const card = normalizedKnowledgeServiceCard(service);
  return [{
    accessKind: "knowledge_service",
    agentEnabled: service.agentEnabled ?? true,
    capabilities: service.capabilities,
    collaboratorCount: service.collaboratorCount ?? service.collaboratorUserIds?.length,
    collaboratorUserIds: service.collaboratorUserIds,
    description: service.description,
    effectiveRole: service.effectiveRole,
    feedbackEnabled: service.feedbackEnabled,
    handbookObjectId: service.handbookObjectId,
    id,
    indexStatus: service.indexStatus,
    kind: "folder",
    knowledgeServiceId: service.id,
    knowledgeServiceCard: card,
    maintenanceTeam: service.maintenanceTeam,
    modifiedAt: service.updatedAt,
    mimeType: "application/x-directory",
    name: service.folderName || service.name || id,
    parentPath: "",
    path: service.folderPath || service.folderName || service.name || id,
    sizeBytes: 0
  }];
}

function normalizedKnowledgeServiceCard(service: KnowledgeServiceListEntry) {
  const card = service.card;
  return {
    bestFor: card?.bestFor ?? service.coverage ?? [],
    keywords: card?.keywords ?? service.tags ?? [],
    notFor: card?.notFor ?? service.notFor ?? [],
    role: card?.role ?? service.role ?? "",
    searchHints: card?.searchHints ?? service.searchHints ?? []
  };
}

export function isFolderBrowsingSection(section: KnowledgeSection) {
  return section === "my" || section === "services";
}

export function dedupeKnowledgeItems(items: KnowledgeItem[]) {
  const byId = new Map<string, KnowledgeItem>();
  items.forEach((item) => {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      return;
    }
    const access = roleRank(item.access) > roleRank(existing.access) ? item.access : existing.access;
    const accessKinds = [...new Set([...existing.accessKinds, ...item.accessKinds])];
    byId.set(item.id, {
      ...existing,
      ...item,
      access,
      accessKind: accessKinds.length === 1 ? accessKinds[0] : undefined,
      accessKinds,
      agentEnabled: existing.agentEnabled || item.agentEnabled,
      withinKnowledgeService: existing.withinKnowledgeService || item.withinKnowledgeService,
      capabilities: {
        canCreatePublicShare: existing.capabilities.canCreatePublicShare || item.capabilities.canCreatePublicShare,
        canEdit: existing.capabilities.canEdit || item.capabilities.canEdit,
        canManageAccess: existing.capabilities.canManageAccess || item.capabilities.canManageAccess,
        canManageKnowledgeService: existing.capabilities.canManageKnowledgeService || item.capabilities.canManageKnowledgeService,
        canUpdateKnowledgeServiceInfo: existing.capabilities.canUpdateKnowledgeServiceInfo || item.capabilities.canUpdateKnowledgeServiceInfo,
        canManageProtectedStructure: existing.capabilities.canManageProtectedStructure || item.capabilities.canManageProtectedStructure,
        canReadChangeAudit: existing.capabilities.canReadChangeAudit || item.capabilities.canReadChangeAudit,
        canTransferOwnership: existing.capabilities.canTransferOwnership || item.capabilities.canTransferOwnership,
        canUseKnowledgeService: existing.capabilities.canUseKnowledgeService || item.capabilities.canUseKnowledgeService
      }
    });
  });
  return [...byId.values()];
}

function roleRank(role: KnowledgeRole) {
  return { collaborator: 2, owner: 3, viewer: 1 }[role];
}
