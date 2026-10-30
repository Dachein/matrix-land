import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "../../i18n";
import { hashText, personInitials, personPalette } from "../../components/shared/visualIdentity";
import type { AppsProductAuthor } from "../types";

const MAX_VISIBLE_AUTHORS = 4;

export function AppsAuthorAvatarGroup({ authors, compact = false }: { authors: AppsProductAuthor[]; compact?: boolean }) {
  const { t } = useI18n();
  const normalizedAuthors = authors.length > 0 ? authors : [{ id: "unknown", name: t("apps.authors.unknown") }];
  const visibleAuthors = normalizedAuthors.slice(0, MAX_VISIBLE_AUTHORS);
  const hiddenCount = Math.max(0, normalizedAuthors.length - visibleAuthors.length);
  const authorNames = normalizedAuthors.map((author) => author.name).join(", ");
  const visibleLabel = normalizedAuthors.length === 1
    ? normalizedAuthors[0].name
    : t("apps.authors.count", { count: normalizedAuthors.length });

  return (
    <div
      aria-label={t("apps.authors.aria", { names: authorNames })}
      className={`appsAuthorGroup${compact ? " compact" : ""}`}
      role="group"
      title={authorNames}
    >
      <span aria-hidden="true" className="appsAuthorAvatarStack">
        {visibleAuthors.map((author) => <AppsAuthorAvatar author={author} key={author.id} />)}
        {hiddenCount > 0 && <span className="appsAuthorAvatar more">+{hiddenCount}</span>}
      </span>
      <span className="appsAuthorLabel">{visibleLabel}</span>
    </div>
  );
}

function AppsAuthorAvatar({ author }: { author: AppsProductAuthor }) {
  const [imageFailed, setImageFailed] = useState(false);
  const palette = personPalette(hashText(author.id || author.name));
  const style = {
    "--avatar-a": palette.a,
    "--avatar-b": palette.b,
    "--avatar-ink": palette.ink
  } as CSSProperties;

  useEffect(() => {
    setImageFailed(false);
  }, [author.avatarUrl]);

  return (
    <span className="appsAuthorAvatar" style={style} title={author.name}>
      {author.avatarUrl && !imageFailed
        ? <img alt="" onError={() => setImageFailed(true)} src={author.avatarUrl} />
        : personInitials(author.name)}
    </span>
  );
}
