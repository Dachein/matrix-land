import type { MateRuntimeDirectoryItem } from "./api";
import { timestampMs } from "./relativeTime.ts";

export function groupConversationDirectoryItems(items: MateRuntimeDirectoryItem[]) {
  const byRecency = (a: MateRuntimeDirectoryItem, b: MateRuntimeDirectoryItem) =>
    timestampMs(b.updatedAt) - timestampMs(a.updatedAt) || a.id.localeCompare(b.id);
  const pinned = items.filter((item) => item.status !== "archived" && item.pinned).sort(byRecency);
  const recent = items.filter((item) => item.status !== "archived" && !item.pinned).sort(byRecency);
  const archived = items.filter((item) => item.status === "archived").sort(byRecency);
  return { pinned, recent, archived, active: [...pinned, ...recent] };
}
