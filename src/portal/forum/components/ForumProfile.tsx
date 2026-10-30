import type { MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import type { Discussion } from "../../../shared/types";
import type { ProfileModalUser } from "../../components/ProfileModal";
import { openUserProfile, ProfileHoverCardTarget } from "../../components/ProfileHoverCard";
import { RelativeTime } from "../../components/ui";
import { useI18n } from "../../i18n";
import { mentionMapForDiscussion, renderForumMarkdown } from "../markdown";
import type { ProfileHoverContext } from "../types";
import { initials } from "../composerUtils";
import {
  communityLevelLabel,
  profileFromMention,
  profileSignature
} from "../profileModels";

const codeCopyFeedbackTimers = new WeakMap<HTMLButtonElement, number>();

export function ForumMentionText({
  className = "",
  discussion,
  postId,
  value
}: {
  className?: string;
  discussion: Discussion;
  postId?: string;
  value: string;
}) {
  const { t } = useI18n();
  const mentionMap = useMemo(() => mentionMapForDiscussion(discussion, postId), [discussion, postId]);
  const codeCopyLabels = useMemo(() => ({
    copiedCodeLabel: t("forum.codeCopied"),
    copyCodeFailedLabel: t("forum.codeCopyFailed"),
    copyCodeLabel: t("forum.copyCode")
  }), [t]);
  const html = useMemo(
    () => renderForumMarkdown(value, mentionMap, codeCopyLabels),
    [codeCopyLabels, mentionMap, value]
  );

  function handleClick(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target;

    if (!(target instanceof Element)) return;

    const copyButton = target.closest<HTMLButtonElement>(".forumCodeCopyButton");
    if (copyButton) {
      void copyCodeBlockToClipboard(copyButton);
      return;
    }

    const mentionButton = target.closest<HTMLButtonElement>("button[data-mention-prefix]");
    const prefix = mentionButton?.dataset.mentionPrefix;
    const mention = prefix ? mentionMap.get(prefix) : undefined;
    if (mention) openUserProfile(profileFromMention(mention, discussion));
  }

  return <div className={`forumText forumMarkdownBody markdownBody ${className}`} dangerouslySetInnerHTML={{ __html: html }} onClick={handleClick} />;
}

export function ParticipantButton({ participant, profileHoverContext }: { participant: ProfileModalUser; profileHoverContext: ProfileHoverContext }) {
  const { locale, t } = useI18n();
  const fallback = initials(participant.name);
  const levelLabel = profileLevelLabel(participant, profileHoverContext, locale);

  return (
    <ProfileHoverCardTarget badgeLabel={levelLabel} className="participantHoverTarget" user={participant}>
      <button
        aria-label={t("forum.openProfileAria", { name: participant.name })}
        className="participantButton"
        onClick={() => openUserProfile(participant)}
        type="button"
      >
        <span className="participantAvatar" aria-hidden="true">
          <ProfileAvatarVisual fallback={fallback} user={participant} />
        </span>
        <span className="participantText">
          <strong>{participant.name}</strong>
          <small>{levelLabel}</small>
        </span>
      </button>
    </ProfileHoverCardTarget>
  );
}

export function ProfileAvatarButton({ fallback, profileHoverContext, user }: { fallback?: string; profileHoverContext: ProfileHoverContext; user: ProfileModalUser }) {
  const { locale, t } = useI18n();
  const levelLabel = profileLevelLabel(user, profileHoverContext, locale);

  return (
    <ProfileHoverCardTarget badgeLabel={levelLabel} user={user}>
      <button
        aria-label={t("forum.openProfileAria", { name: user.name })}
        className="profileInlineAvatar personAvatar"
        onClick={() => openUserProfile(user)}
        type="button"
      >
        <ProfileAvatarVisual fallback={fallback || initials(user.name)} user={user} />
      </button>
    </ProfileHoverCardTarget>
  );
}

export function ProfileNameButton({
  profileHoverContext,
  user
}: {
  profileHoverContext?: ProfileHoverContext;
  user: ProfileModalUser;
}) {
  if (profileHoverContext) {
    return <ProfileHoverNameButton profileHoverContext={profileHoverContext} user={user} />;
  }

  return (
    <button className="profileInlineName" onClick={() => openUserProfile(user)} title={user.name} type="button">
      {user.name}
    </button>
  );
}

export function ProfileHoverNameButton({
  className = "",
  profileHoverContext,
  user
}: {
  className?: string;
  profileHoverContext: ProfileHoverContext;
  user: ProfileModalUser;
}) {
  const { locale, t } = useI18n();
  const levelLabel = profileLevelLabel(user, profileHoverContext, locale);

  return (
    <ProfileHoverCardTarget badgeLabel={levelLabel} user={user}>
      <button
        aria-label={t("forum.openProfileAria", { name: user.name })}
        className={`profileInlineName ${className}`.trim()}
        onClick={() => openUserProfile(user)}
        type="button"
      >
        {user.name}
      </button>
    </ProfileHoverCardTarget>
  );
}

export function ForumAuthorSignature({ user }: { user: ProfileModalUser }) {
  const { locale } = useI18n();
  const signature = profileSignature(user, locale);

  return <small className="forumAuthorSignature" title={signature}>{signature}</small>;
}

export function ForumAuthorMeta({ anonymous = false, timestamp, user }: { anonymous?: boolean; timestamp: string; user: ProfileModalUser }) {
  const { locale, t } = useI18n();
  const signature = anonymous ? t("forum.anonymousMember") : profileSignature(user, locale);

  return (
    <small className="forumAuthorMeta">
      <span title={signature}>{signature}</span>
      <span aria-hidden="true">/</span>
      <RelativeTime value={timestamp} />
    </small>
  );
}

function profileLevelLabel(user: ProfileModalUser, context: ProfileHoverContext, locale: ReturnType<typeof useI18n>["locale"]) {
  const isCurrentUser = user.id === context.currentUserId
    || Boolean(user.email && user.email.toLowerCase() === context.currentUserEmail);
  return isCurrentUser ? context.currentUserLevelLabel : communityLevelLabel(user.journeyLevelKey, locale);
}

function ProfileAvatarVisual({ fallback, user }: { fallback: string; user: ProfileModalUser }) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [user.avatarUrl]);

  return user.avatarUrl && !imageFailed
    ? <img alt="" decoding="async" loading="lazy" onError={() => setImageFailed(true)} src={user.avatarUrl} />
    : <span>{fallback}</span>;
}

async function copyCodeBlockToClipboard(button: HTMLButtonElement) {
  const code = button.parentElement?.querySelector("pre")?.textContent ?? "";
  if (!code) return;

  let copied = false;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
    await navigator.clipboard.writeText(code);
    copied = true;
  } catch {
    const scratchpad = document.createElement("textarea");
    scratchpad.value = code;
    scratchpad.style.position = "fixed";
    scratchpad.style.opacity = "0";
    document.body.appendChild(scratchpad);
    scratchpad.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    scratchpad.remove();
    button.focus({ preventScroll: true });
  }

  const copyLabel = button.dataset.copyLabel || button.getAttribute("aria-label") || "";
  const feedbackLabel = copied
    ? button.dataset.copiedLabel || copyLabel
    : button.dataset.copyFailedLabel || copyLabel;
  button.classList.toggle("copied", copied);
  button.classList.toggle("copyFailed", !copied);
  button.setAttribute("aria-label", feedbackLabel);
  button.title = feedbackLabel;

  const previousTimer = codeCopyFeedbackTimers.get(button);
  if (previousTimer !== undefined) window.clearTimeout(previousTimer);
  const timer = window.setTimeout(() => {
    button.classList.remove("copied", "copyFailed");
    button.setAttribute("aria-label", copyLabel);
    button.title = copyLabel;
    codeCopyFeedbackTimers.delete(button);
  }, 1200);
  codeCopyFeedbackTimers.set(button, timer);
}
