import type { PortalCatalog } from "../../shared/types";
import { marketPrimaryMetricCount, marketPublisher, marketSummary } from "../market/models";
import { portalAppOwnerName } from "../market/ownerDisplay";
import type { MarketItem } from "../market/types";
import type { ForumListedItemAttachment } from "./types";

export function resolveForumListedItemAttachment(
  intent: ForumListedItemAttachment | undefined,
  catalog: PortalCatalog
): ForumListedItemAttachment | undefined {
  if (!intent) {
    return undefined;
  }

  if (intent.type === "app") {
    const app = catalog.apps.find((item) => item.id === intent.id);
    if (!app) {
      return undefined;
    }

    return {
      category: app.category || intent.category,
      description: app.description || intent.description,
      iconUrl: app.coverImageUrl || intent.iconUrl,
      id: app.id,
      installs: app.viewCount,
      label: app.name,
      owner: portalAppOwnerName(app),
      type: "app"
    };
  }

  if (intent.type !== "skill") {
    return undefined;
  }

  const skill = catalog.skills.find((item) => item.id === intent.id);
  if (!skill) {
    return undefined;
  }

  return {
    category: skill.category || intent.category,
    description: skill.description || intent.description,
    iconUrl: skill.coverImageUrl || intent.iconUrl,
    id: skill.id,
    installs: skill.installs,
    label: skill.name,
    owner: skill.owner,
    type: "skill"
  };
}

export function marketItemToForumAttachment(item: MarketItem): ForumListedItemAttachment {
  return {
    category: item.category,
    description: marketSummary(item),
    iconUrl: item.coverImageUrl,
    id: item.targetId,
    installs: marketPrimaryMetricCount(item),
    label: item.name,
    owner: marketPublisher(item).name,
    type: item.kind
  };
}
