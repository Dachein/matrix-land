import type { PortalCatalog } from "../../shared/types";
import { marketAppLaunchUrlFromSource } from "../market/appRuntime";
import { publicationOwnerLabel, portalAppOwnerName } from "../market/ownerDisplay";

export type HomePinKind = "app" | "skill";

export type HomePin = {
  id: string;
  kind: HomePinKind;
};

export type HomePinContext = {
  accessibleAppTargetIds?: string[];
  userId?: string;
};

export type ResolvedHomePin = HomePin & {
  category: string;
  description: string;
  iconUrl?: string;
  launchAppId?: string;
  launchUrl?: string;
  name: string;
  owner: string;
  status: string;
};

const storageKey = "workspace.homePins.v1";
const dismissalStorageKeyPrefix = "workspace.homePinDismissals.v1:";
const updatedEvent = "workspace:home-pins-updated";

export function homePinKey(pin: HomePin) {
  return `${pin.kind}:${pin.id}`;
}

export function readHomePins(): HomePin[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]") as HomePin[];

    return parsed.filter((pin) => isPinKind(pin.kind) && typeof pin.id === "string" && pin.id.length > 0);
  } catch {
    return [];
  }
}

export function readEffectiveHomePins(
  accessibleAppTargetIds: string[] | undefined,
  userId: string | undefined,
  pins: HomePin[] = readHomePins()
) {
  const dismissed = new Set(readHomePinDismissals(userId).map(homePinKey));
  const accessibleApps = appHomePins(accessibleAppTargetIds)
    .filter((pin) => !dismissed.has(homePinKey(pin)));

  return uniqueHomePins([...accessibleApps, ...pins]);
}

export function isHomePinned(pin: HomePin, context: HomePinContext = {}) {
  return readEffectiveHomePins(context.accessibleAppTargetIds, context.userId)
    .some((item) => homePinKey(item) === homePinKey(pin));
}

export function addHomePin(pin: HomePin, context: HomePinContext = {}) {
  removeHomePinDismissal(pin, context.userId);
  const current = readHomePins();

  if (current.some((item) => homePinKey(item) === homePinKey(pin))) {
    return current;
  }

  const next = [pin, ...current].slice(0, 12);
  writeHomePins(next);
  return next;
}

export function removeHomePin(pin: HomePin, context: HomePinContext = {}) {
  const current = readHomePins();
  const next = current.filter((item) => homePinKey(item) !== homePinKey(pin));

  if (next.length !== current.length) {
    writeHomePins(next);
  }

  if (pin.kind === "app" && appHomePins(context.accessibleAppTargetIds).some((item) => item.id === pin.id)) {
    addHomePinDismissal(pin, context.userId);
  }

  return next;
}

export function resolveHomePin(catalog: PortalCatalog, pin: HomePin): ResolvedHomePin | undefined {
  const hubListings = catalog.hubListings ?? catalog.publicationListings ?? [];

  if (pin.kind === "app") {
    const app = catalog.apps.find((item) => item.id === pin.id);
    const listing = hubListings.find((item) => item.type === "app" && item.targetId === pin.id);

    if (listing) {
      return {
        ...pin,
        category: listing.category || app?.category || "Workflow",
        description: listing.summary || app?.subtitle || listing.description || app?.description || "",
        iconUrl: listing.coverImageUrl || app?.coverImageUrl || app?.screenshots?.[0],
        launchAppId: listing.targetId,
        launchUrl: marketAppLaunchUrlFromSource({ app, listing }),
        name: listing.name,
        owner: publicationOwnerLabel(listing, app ? portalAppOwnerName(app) : "Frontier Workspace"),
        status: listing.status
      };
    }

    return undefined;
  }

  const skill = catalog.skills.find((item) => item.id === pin.id);
  const listing = hubListings.find((item) => item.type === "skill" && item.targetId === pin.id);

  if (!listing) {
    return undefined;
  }

  return {
    ...pin,
    category: listing.category || skill?.category || "Research",
    description: listing.summary || listing.description || skill?.description || "",
    iconUrl: listing.coverImageUrl || skill?.coverImageUrl,
    name: listing.name,
    owner: publicationOwnerLabel(listing, skill?.owner || "Frontier Workspace"),
    status: listing.status
  };
}

export function resolveHomePins(catalog: PortalCatalog, pins: HomePin[] = readHomePins()): ResolvedHomePin[] {
  return pins
    .map((pin) => resolveHomePin(catalog, pin))
    .filter((pin): pin is ResolvedHomePin => Boolean(pin));
}

export function readHomePinsSnapshot(userId?: string) {
  if (typeof window === "undefined") {
    return "[[],[]]";
  }

  try {
    return JSON.stringify([
      window.localStorage.getItem(storageKey) ?? "[]",
      window.localStorage.getItem(dismissalStorageKey(userId)) ?? "[]"
    ]);
  } catch {
    return "[[],[]]";
  }
}

export function subscribeHomePins(listener: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key?.startsWith(dismissalStorageKeyPrefix) || event.key === null) {
      listener();
    }
  };

  window.addEventListener(updatedEvent, listener);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(updatedEvent, listener);
    window.removeEventListener("storage", handleStorage);
  };
}

function writeHomePins(pins: HomePin[]) {
  window.localStorage.setItem(storageKey, JSON.stringify(pins));
  window.dispatchEvent(new Event(updatedEvent));
}

function readHomePinDismissals(userId: string | undefined): HomePin[] {
  if (typeof window === "undefined" || !userId) {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(dismissalStorageKey(userId)) ?? "[]") as HomePin[];
    return parsed.filter((pin) => isPinKind(pin.kind) && typeof pin.id === "string" && pin.id.length > 0);
  } catch {
    return [];
  }
}

function addHomePinDismissal(pin: HomePin, userId: string | undefined) {
  if (!userId) {
    return;
  }

  const current = readHomePinDismissals(userId);
  if (current.some((item) => homePinKey(item) === homePinKey(pin))) {
    return;
  }

  writeHomePinDismissals(userId, [pin, ...current]);
}

function removeHomePinDismissal(pin: HomePin, userId: string | undefined) {
  if (!userId) {
    return;
  }

  const current = readHomePinDismissals(userId);
  const next = current.filter((item) => homePinKey(item) !== homePinKey(pin));
  if (next.length !== current.length) {
    writeHomePinDismissals(userId, next);
  }
}

function writeHomePinDismissals(userId: string, pins: HomePin[]) {
  window.localStorage.setItem(dismissalStorageKey(userId), JSON.stringify(pins));
  window.dispatchEvent(new Event(updatedEvent));
}

function dismissalStorageKey(userId: string | undefined) {
  return `${dismissalStorageKeyPrefix}${userId || "anonymous"}`;
}

function appHomePins(targetIds: string[] | undefined): HomePin[] {
  return Array.from(new Set(targetIds?.map((id) => id.trim()).filter(Boolean) ?? []))
    .map((id) => ({ id, kind: "app" }));
}

function uniqueHomePins(pins: HomePin[]) {
  const seen = new Set<string>();
  return pins.filter((pin) => {
    const key = homePinKey(pin);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isPinKind(value: unknown): value is HomePinKind {
  return value === "app" || value === "skill";
}
