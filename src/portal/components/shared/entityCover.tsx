import { AppWindow, BookOpen } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { coverInitials, coverPalette, deriveCoverMarkers, hashText } from "./visualIdentity";

export type EntityCoverKind = "skill" | "app";

export function EntityCover({
  category,
  description = "",
  imageUrl,
  kind,
  markers,
  owner,
  size = "compact",
  title
}: {
  category: string;
  description?: string;
  imageUrl?: string;
  kind: EntityCoverKind;
  markers: string[];
  owner: string;
  size?: "compact" | "large";
  title: string;
}) {
  const { t } = useI18n();
  const Icon = kind === "app" ? AppWindow : BookOpen;
  const contentSeed = `${kind}|${title}|${owner}|${category}|${description}|${markers.join("|")}`;
  const hash = hashText(contentSeed);
  const palette = coverPalette(hash);
  const normalizedImageUrl = imageUrl?.trim();
  const [imageFailed, setImageFailed] = useState(false);
  const hasImage = Boolean(normalizedImageUrl && !imageFailed);
  const visibleMarkers = (markers.length > 0 ? markers : deriveCoverMarkers(title, description, category)).slice(0, size === "large" ? 3 : 2);
  const style = {
    "--cover-a": palette.a,
    "--cover-b": palette.b,
    "--cover-c": palette.c,
    "--cover-ink": palette.ink
  } as CSSProperties;

  useEffect(() => {
    setImageFailed(false);
  }, [normalizedImageUrl]);

  return (
    <div className={`entityCover ${size} ${kind} pattern${hash % 4}${hasImage ? " uploaded" : ""}`} aria-label={`${title} cover`} style={style}>
      {hasImage && <img alt="" className="entityCoverImage" onError={() => setImageFailed(true)} src={normalizedImageUrl} />}
      <div className="entityCoverTop">
        <span className="entityCoverMark">
          <Icon size={size === "large" ? 24 : 18} />
        </span>
        <span className="entityCoverLabel">{coverLabel(kind, t)}</span>
      </div>
      <div className="entityCoverSignal" aria-hidden="true">
        <b>{coverInitials(title)}</b>
        <i>{category}</i>
      </div>
      <div className="entityCoverBody">
        <strong>{title}</strong>
        <span>{owner} / {category}</span>
      </div>
      <div className="entityCoverMarkers">
        {(visibleMarkers.length > 0 ? visibleMarkers : ["profile:read"]).map((marker) => (
          <span key={marker}>{marker}</span>
        ))}
      </div>
    </div>
  );
}

function coverLabel(kind: EntityCoverKind, t: ReturnType<typeof useI18n>["t"]) {
  if (kind === "app") {
    return t("ui.coverLabel.app");
  }

  return t("ui.coverLabel.skill");
}
