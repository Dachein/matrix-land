import type { CSSProperties } from "react";
import { useI18n } from "../../i18n";
import { hashText, personInitials, personPalette } from "./visualIdentity";

export function PersonAvatar({ imageUrl, name, size = "default" }: { imageUrl?: string; name: string; size?: "default" | "large" }) {
  const palette = personPalette(hashText(name));
  const style = {
    "--avatar-a": palette.a,
    "--avatar-b": palette.b,
    "--avatar-ink": palette.ink
  } as CSSProperties;

  return (
    <span className={`personAvatar ${size}`} style={style} title={name}>
      {imageUrl ? <img alt="" src={imageUrl} /> : personInitials(name)}
    </span>
  );
}

export function AvatarStack({ label, people }: { label?: string; people: Array<{ name: string; imageUrl?: string } | string> }) {
  const { t } = useI18n();
  const visiblePeople = people.slice(0, 4);

  return (
    <div className="avatarStack" aria-label={label ?? t("ui.people")}>
      {visiblePeople.map((person, index) => {
        const normalized = typeof person === "string" ? { name: person } : person;
        const palette = personPalette(hashText(normalized.name));
        const style = {
          "--avatar-a": palette.a,
          "--avatar-b": palette.b,
          "--avatar-ink": palette.ink
        } as CSSProperties;

        return (
          <span className="avatarStackItem" key={`${normalized.name}:${index}`} style={style} title={normalized.name}>
            {normalized.imageUrl ? <img alt="" src={normalized.imageUrl} /> : personInitials(normalized.name)}
          </span>
        );
      })}
      {label && <span className="avatarStackLabel">{label}</span>}
    </div>
  );
}

export function OwnerLine({
  avatarUrl,
  detail,
  owner
}: {
  avatarUrl?: string;
  detail?: string;
  owner: string;
}) {
  return (
    <div className="ownerLine">
      <PersonAvatar imageUrl={avatarUrl} name={owner} />
      <span className="ownerLineText">
        <strong>{owner}</strong>
        {detail && <span>{detail}</span>}
      </span>
    </div>
  );
}
