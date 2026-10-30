import { AppWindow, BookOpen } from "lucide-react";
import { useEffect, useState } from "react";
import type { MarketItem } from "../../../../src/portal/market/types";

export function PortalMarketObjectMark({
  item,
  size = "default"
}: {
  item: MarketItem;
  size?: "card" | "default" | "large";
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = item.coverImageUrl?.trim();
  const Icon = item.kind === "app" ? AppWindow : BookOpen;

  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);

  return (
    <span className={`portal-market-mark ${item.kind} ${size}`} aria-hidden="true">
      {imageUrl && !imageFailed ? (
        <img alt="" onError={() => setImageFailed(true)} src={imageUrl} />
      ) : (
        <Icon size={size === "large" ? 30 : size === "card" ? 34 : 20} strokeWidth={1.8} />
      )}
    </span>
  );
}
