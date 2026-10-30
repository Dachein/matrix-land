import { EyeOff, RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  DEFAULT_FORUM_ANONYMOUS_PERSONA,
  forumAnonymousPersona,
  randomForumAnonymousPersona,
  type ForumAnonymousPersona
} from "../forumAnonymousIdentity";

export function ForumAnonymousIdentityControls({
  anonymous,
  lockedPersona,
  onAnonymousChange,
  onPersonaChange,
  persona,
  variant
}: {
  anonymous: boolean;
  lockedPersona?: ForumAnonymousPersona;
  onAnonymousChange: (anonymous: boolean) => void;
  onPersonaChange: (persona: ForumAnonymousPersona) => void;
  persona: ForumAnonymousPersona;
  variant: "publish" | "reply";
}) {
  const { t } = useI18n();
  const selectedPersona = lockedPersona ?? persona ?? DEFAULT_FORUM_ANONYMOUS_PERSONA;

  function handleAnonymousChange(nextAnonymous: boolean) {
    if (nextAnonymous && !lockedPersona) {
      onPersonaChange(randomForumAnonymousPersona());
    }
    onAnonymousChange(nextAnonymous);
  }

  return (
    <div className={`forumAnonymousControls ${anonymous ? "active" : ""}`}>
      <label className="forumAnonymousToggle">
        <input
          checked={anonymous}
          onChange={(event) => handleAnonymousChange(event.target.checked)}
          type="checkbox"
        />
        {variant === "publish" && <EyeOff aria-hidden="true" size={15} />}
        <span>{t(variant === "publish" ? "forum.anonymousPublish" : "forum.anonymousReply")}</span>
      </label>
      {anonymous && (
        <div className="forumAnonymousPersonaPicker">
          <ForumAnonymousPersonaLabel persona={selectedPersona} />
          {!lockedPersona && (
            <button
              aria-label={t("forum.refreshAnonymousPersona")}
              className="forumAnonymousPersonaRefresh"
              onClick={() => onPersonaChange(randomForumAnonymousPersona(selectedPersona))}
              title={t("forum.refreshAnonymousPersona")}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={16} />
              <span>{t("forum.changeAnonymousPersona")}</span>
            </button>
          )}
        </div>
      )}
      {anonymous && lockedPersona && (
        <small className="forumAnonymousLockedHint">{t("forum.anonymousPersonaLocked")}</small>
      )}
    </div>
  );
}

export function ForumAnonymousAvatar({ name, persona }: { name: string; persona?: ForumAnonymousPersona }) {
  const identity = forumAnonymousPersona(persona);

  return (
    <span aria-label={name} className="profileInlineAvatar personAvatar forumAnonymousAvatar" title={name}>
      {identity ? <img alt="" src={identity.avatarUrl} /> : <EyeOff aria-hidden="true" size={15} />}
    </span>
  );
}

export function ForumAnonymousName({ name, showBadge = true }: { name: string; showBadge?: boolean }) {
  const { t } = useI18n();

  return (
    <span className="forumAnonymousName">
      <strong>{name}</strong>
      {showBadge && <small>{t("forum.anonymousBadge")}</small>}
    </span>
  );
}

function ForumAnonymousPersonaLabel({ persona }: { persona: ForumAnonymousPersona }) {
  const identity = forumAnonymousPersona(persona);

  if (!identity) {
    return null;
  }

  return (
    <span className="forumAnonymousPersonaLabel">
      <img alt="" src={identity.avatarUrl} />
      <span>{identity.name}</span>
    </span>
  );
}
