import { homeAppPresentation, isPublicHomeApp } from "../../../../src/shared/homeApplications";
import { timestampMs } from "../../../../src/portal/components/shared/time";
import { forumDiscussionCategorySlug } from "../../../../src/portal/forum/labels";
import type { ForumCategorySlug } from "../../../../src/portal/forum/config";
import { readEffectiveHomePins, resolveHomePins, type ResolvedHomePin } from "../../../../src/portal/lib/homePins";
import type { Discussion, DiscussionReply, HomeAppDisplay, PortalCatalog, PortalApp } from "../../../../src/shared/types";

export type PortalShortcut = {
  listingId?: string;
  homeDisplay?: HomeAppDisplay;
  updatedAt?: string;
  category: string;
  coverImageUrl?: string;
  id: string;
  kind: "app";
  label: string;
  launchTarget: Pick<PortalApp, "id" | "launchUrl">;
  name: string;
  status: "pending_review" | "listed";
};

export type PortalDiscussionPreview = {
  imageUrl?: string;
  kind: "app" | "file" | "image" | "link";
  label: string;
};

export function buildPortalHomeApplications(catalog: PortalCatalog) {
  const listings = catalog.hubListings.filter((listing) => listing.type === "app");
  const accessibleIds = listings.map((listing) => listing.targetId);
  const visibleIds = new Set(readEffectiveHomePins(accessibleIds, catalog.currentUser.id)
    .filter((pin) => pin.kind === "app").map((pin) => pin.id));
  const all = validApplicationShortcuts(resolveHomePins(catalog,
    Array.from(new Set(accessibleIds)).map((id) => ({ id, kind: "app" as const }))));
  const publicApps: PortalShortcut[] = [];
  const exclusiveApps: PortalShortcut[] = [];
  const hiddenApps: PortalShortcut[] = [];
  for (const shortcut of all) {
    const listing = listings.find((item) => item.targetId === shortcut.id)!;
    const presentation = homeAppPresentation(listing);
    const entry = {
      ...shortcut,
      listingId: listing.id,
      homeDisplay: presentation.display,
      updatedAt: listing.updatedAt
    };
    if (isPublicHomeApp(listing, catalog.apps.find((app) => app.id === shortcut.id))) {
      (presentation.display === "hidden" || !visibleIds.has(shortcut.id) ? hiddenApps : publicApps).push(entry);
    } else {
      exclusiveApps.push({ ...entry, homeDisplay: "normal" });
    }
  }
  const byUpdated = (a: PortalShortcut, b: PortalShortcut) =>
    timestampMs(b.updatedAt) - timestampMs(a.updatedAt) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  publicApps.sort((a, b) => {
    const recommendedA = a.homeDisplay === "recommended";
    const recommendedB = b.homeDisplay === "recommended";
    if (recommendedA !== recommendedB) return recommendedA ? -1 : 1;
    return byUpdated(a, b);
  });
  return { publicApps, exclusiveApps: exclusiveApps.sort(byUpdated), hiddenApps: hiddenApps.sort(byUpdated) };
}

export function buildPortalShortcuts(catalog: PortalCatalog): PortalShortcut[] {
  const { publicApps, exclusiveApps } = buildPortalHomeApplications(catalog);
  return [...publicApps, ...exclusiveApps];
}

function validApplicationShortcuts(pins: ResolvedHomePin[]): PortalShortcut[] {
  return pins.flatMap((pin) => {
    const launchUrl = pin.launchUrl?.trim();
    const status = pin.status === "listed" || pin.status === "pending_review" ? pin.status : undefined;

    if (pin.kind !== "app" || !status || !launchUrl) {
      return [];
    }

    return [{
      category: pin.category,
      coverImageUrl: pin.iconUrl,
      id: pin.id,
      kind: "app" as const,
      label: pin.description,
      launchTarget: {
        id: pin.launchAppId || pin.id,
        launchUrl
      },
      name: pin.name,
      status
    }];
  });
}

export function orderedDiscussions(discussions: Discussion[]) {
  return [...discussions].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
    return discussionTimestamp(right) - discussionTimestamp(left);
  });
}

export function groupPortalHomeDiscussions(discussions: Discussion[]) {
  const pinned = discussions.filter((discussion) => Boolean(discussion.pinned));
  const unpinned = discussions.filter((discussion) => !discussion.pinned);

  return {
    earlier: unpinned.slice(2),
    pinned,
    recent: unpinned.slice(0, 2)
  };
}

export type PortalDiscussionOwnerFilter = "all" | "mine";

export function filterPortalDiscussions(
  discussions: Discussion[],
  filters: {
    category: ForumCategorySlug | "";
    currentUser: Pick<PortalCatalog["currentUser"], "email" | "id" | "name">;
    owner: PortalDiscussionOwnerFilter;
    query: string;
  }
) {
  const query = normalizeSearchValue(filters.query);

  return discussions.filter((discussion) => (
    (!filters.category || forumDiscussionCategorySlug(discussion) === filters.category)
    && (filters.owner === "all" || isDiscussionByCurrentUser(discussion, filters.currentUser))
    && (!query || discussionSearchText(discussion).includes(query))
  ));
}

function isDiscussionByCurrentUser(
  discussion: Discussion,
  currentUser: Pick<PortalCatalog["currentUser"], "email" | "id" | "name">
) {
  if (discussion.authorId && currentUser.id && discussion.authorId === currentUser.id) {
    return true;
  }

  const authorEmail = normalizeSearchValue(discussion.authorEmail ?? "");
  const currentUserEmail = normalizeSearchValue(currentUser.email);
  if (authorEmail && currentUserEmail && authorEmail === currentUserEmail) {
    return true;
  }

  return !discussion.authorId
    && !authorEmail
    && normalizeSearchValue(discussion.author) === normalizeSearchValue(currentUser.name);
}

function discussionSearchText(discussion: Discussion) {
  return normalizeSearchValue([
    discussion.title,
    discussion.body,
    discussion.excerpt,
    discussion.author,
    discussion.authorEmail,
    discussion.category,
    discussion.tag,
    ...(discussion.tags ?? []),
    discussion.linkedApp,
    discussion.linkedSkill,
    discussion.linkedMcp
  ].filter(Boolean).join(" "));
}

function normalizeSearchValue(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function discussionTimestamp(discussion: Discussion) {
  return timestampMs(discussion.lastActive)
    || timestampMs(discussion.updatedAt)
    || timestampMs(discussion.createdAt);
}

export function latestDiscussionReply(discussion: Discussion) {
  let latest: DiscussionReply | undefined;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const reply of discussion.replyPosts ?? []) {
    const replyTimestamp = timestampMs(reply.createdAt);
    if (!latest || replyTimestamp >= latestTimestamp) {
      latest = reply;
      latestTimestamp = replyTimestamp;
    }
  }

  return latest;
}

export function discussionMarker(discussion: Discussion) {
  if (discussion.linkedApp) {
    return { label: "APP", tone: "blue" } as const;
  }

  if (discussion.linkedMcp) {
    return { label: "MCP", tone: "green" } as const;
  }

  if (discussion.linkedSkill) {
    return { label: "SKL", tone: "signal" } as const;
  }

  if (discussion.topicType === "official" || discussion.topicType === "release") {
    return { label: "NEWS", tone: "rose" } as const;
  }

  return { label: "POST", tone: "ink" } as const;
}

export function linkedObjects(discussion: Discussion) {
  return [discussion.linkedApp, discussion.linkedSkill, discussion.linkedMcp]
    .filter((value): value is string => Boolean(value));
}

export function discussionPreview(discussion: Discussion, catalog: PortalCatalog): PortalDiscussionPreview | undefined {
  const image = discussion.attachments?.find((attachment) => attachment.type === "image");
  if (image) {
    return { imageUrl: image.url, kind: "image", label: image.alt || image.fileName };
  }

  const embed = discussion.linkEmbeds?.find((item) => item.previewImageUrl) ?? discussion.linkEmbeds?.[0];
  if (embed) {
    return { imageUrl: embed.previewImageUrl, kind: "link", label: embed.provider || embed.title };
  }

  const plugin = discussion.contentPlugins?.[0];
  if (plugin) {
    const app = plugin.targetType === "app" ? catalog.apps.find((item) => item.id === plugin.targetId) : undefined;
    const skill = plugin.targetType === "skill" ? catalog.skills.find((item) => item.id === plugin.targetId) : undefined;
    return {
      imageUrl: plugin.iconUrl || app?.coverImageUrl || app?.screenshots?.[0] || skill?.coverImageUrl,
      kind: "app",
      label: plugin.title
    };
  }

  if (discussion.linkedApp) {
    const linkedApp = catalog.apps.find((app) => (
      app.id === discussion.linkedApp
      || app.name === discussion.linkedApp
      || app.nameEn === discussion.linkedApp
      || app.nameZh === discussion.linkedApp
    ));
    return {
      imageUrl: linkedApp?.coverImageUrl || linkedApp?.screenshots?.[0],
      kind: "app",
      label: linkedApp ? localizedAppName(linkedApp) : discussion.linkedApp
    };
  }

  const file = discussion.attachments?.[0];
  if (file) {
    return { kind: "file", label: file.fileName };
  }

  return undefined;
}

export function markdownToPlainText(value: string) {
  return value
    .replace(/```(?:[^\n]*)\n?([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function localizedAppName(app: PortalApp) {
  const locale = typeof document === "undefined" ? "en" : document.documentElement.lang;
  return locale.startsWith("zh") ? app.nameZh || app.name : app.nameEn || app.name;
}
