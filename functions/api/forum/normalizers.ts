import type { Discussion } from "../../../src/shared/types.ts";
import type { ForumContentPluginRecord } from "./types.ts";

export const DEFAULT_FORUM_REACTION = "thumbsup";
export const ALLOWED_FORUM_REACTIONS = new Set(["thumbsup", "eyes", "tada", "heart", "bulb"]);

export function normalizeTopicType(value: unknown): Discussion["topicType"] {
  const type = readString(value).trim().toLowerCase();

  if (!type) {
    return undefined;
  }

  if (type === "announcement") {
    return "official";
  }

  if (type === "support") {
    return "help";
  }

  return type === "help" || type === "question" || type === "showcase" || type === "idea" || type === "official" || type === "release"
    ? type
    : undefined;
}

export function normalizeEmbedType(value: unknown): "link" | "video" | "social" {
  const type = readString(value);
  return type === "video" || type === "social" ? type : "link";
}

export function normalizePluginType(value: unknown): NonNullable<Discussion["contentPlugins"]>[number]["pluginType"] {
  const type = readString(value);
  return type === "app_card" || type === "app_launch" || type === "app_release" || type === "app_support" ? type : "app_card";
}

export function normalizePluginTarget(value: unknown): NonNullable<Discussion["contentPlugins"]>[number]["targetType"] {
  const target = readString(value);
  return target === "skill" ? "skill" : "app";
}

export function sanitizeForumContentPlugins(value: unknown): ForumContentPluginRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, 4)
    .map((item): ForumContentPluginRecord | undefined => {
      if (!item || typeof item !== "object") {
        return undefined;
      }

      const record = item as Record<string, unknown>;
      const targetId = readString(record.targetId).trim().slice(0, 160);

      if (!targetId) {
        return undefined;
      }

      const actionLabel = readString(record.actionLabel).trim().slice(0, 60);
      const category = readString(record.category).trim().slice(0, 80);
      const description = readString(record.description).trim().slice(0, 500);
      const iconUrl = normalizePluginIconUrl(record.iconUrl);
      const installs = Number(record.installs);
      const owner = readString(record.owner).trim().slice(0, 120);
      const title = readString(record.title).trim().slice(0, 160);

      return {
        actionLabel: actionLabel || undefined,
        category: category || undefined,
        description: description || undefined,
        iconUrl: iconUrl || undefined,
        installs: Number.isFinite(installs) && installs >= 0 ? Math.floor(installs) : undefined,
        owner: owner || undefined,
        pluginType: normalizePluginType(record.pluginType),
        targetId,
        targetType: normalizePluginTarget(record.targetType),
        title: title || undefined
      };
    })
    .filter((item): item is ForumContentPluginRecord => Boolean(item));
}

export function normalizeForumReaction(value: unknown) {
  const reaction = readString(value).trim();
  return ALLOWED_FORUM_REACTIONS.has(reaction) ? reaction : DEFAULT_FORUM_REACTION;
}

function normalizePluginIconUrl(value: unknown) {
  const iconUrl = readString(value).trim();

  if (iconUrl.toLowerCase().startsWith("data:")) {
    return "";
  }

  return iconUrl.slice(0, 1200);
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
