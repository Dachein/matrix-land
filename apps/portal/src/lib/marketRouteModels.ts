import type { MarketItem, MarketKind } from "../../../../src/portal/market/types";

export type PublicationAuthPublicationStatus = "failed" | "not_required" | "pending" | "synced";

export type PublicationReviewPublicationState = {
  requestId?: string;
  status: PublicationAuthPublicationStatus;
};

export function findPortalMarketItem(items: MarketItem[], kind: MarketKind, routeId: string) {
  return items.find((item) => (
    item.kind === kind &&
    item.status === "listed" &&
    (
      item.targetId === routeId ||
      item.listing?.id === routeId ||
      item.id === routeId ||
      item.id === `${kind}:${routeId}`
    )
  ));
}

export function publicationReviewPublicationState(payload: unknown): PublicationReviewPublicationState | undefined {
  const root = objectValue(payload);
  const authSync = objectValue(root.authSync);
  const resourceSync = objectValue(root.resourceSync);
  const explicitStatus = publicationStatus(root.authPublicationStatus);
  const authStatus = publicationStatusFromSync(authSync, true);
  const resourceStatus = publicationStatusFromSync(resourceSync, false);
  const status = explicitStatus ?? authStatus ?? resourceStatus;

  if (!status) {
    return undefined;
  }

  const publicationSync = authStatus ? authSync : resourceStatus ? resourceSync : authSync;
  const requestId = safeRequestId(publicationSync.requestId);
  return {
    status,
    ...(requestId ? { requestId } : {})
  };
}

function publicationStatus(value: unknown): PublicationAuthPublicationStatus | undefined {
  return value === "failed" || value === "not_required" || value === "pending" || value === "synced"
    ? value
    : undefined;
}

function publicationStatusFromSync(sync: Record<string, unknown>, supportsNotRequired: boolean): PublicationAuthPublicationStatus | undefined {
  if (sync.synced === true) {
    return "synced";
  }
  if (sync.synced === false) {
    return "failed";
  }
  if (sync.skipped !== true) {
    return undefined;
  }
  if (sync.reason === "auth_worker_not_configured") {
    return "pending";
  }
  if (supportsNotRequired && sync.reason === "workspace_auth_disabled") {
    return "not_required";
  }
  return "failed";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeRequestId(value: unknown) {
  const requestId = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:/-]{1,128}$/.test(requestId) ? requestId : undefined;
}
