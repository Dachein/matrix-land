import { AppWindow, BookOpen } from "lucide-react";
import { ResourceMark } from "../../../../src/portal/components/ResourceMark";
import type { MarketItem } from "../../../../src/portal/market/types";

export function PortalMarketObjectMark({
  item,
  size = "default"
}: {
  item: MarketItem;
  size?: "card" | "default" | "large";
}) {
  const imageUrl = item.coverImageUrl?.trim();
  const Icon = item.kind === "app" ? AppWindow : BookOpen;

  return (
    <ResourceMark className={`portal-market-mark ${item.kind} ${size}`} aria-hidden="true" imageUrl={imageUrl}
      fallback={<Icon size={size === "large" ? 30 : size === "card" ? 34 : 20} strokeWidth={1.8} />} />
  );
}
