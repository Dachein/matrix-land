import { AppWindow, Eye, FileText, Link2, MessageCircle } from "lucide-react";
import { RelativeTime } from "../../../../src/portal/components/shared/time";
import { PinnedBadge } from "../../../../src/portal/forum/components/ForumPostActions";
import { ContributorAwardBadge } from "../../../../src/portal/forum/components/ForumContributorAward";
import { ProfileAvatarButton } from "../../../../src/portal/forum/components/ForumProfile";
import { ForumAnonymousAvatar, ForumAnonymousName } from "../../../../src/portal/forum/components/ForumAnonymousIdentity";
import type { ForumDiscussion } from "../../../../src/portal/forum/forumAnonymousIdentity";
import { communityLevelLabel, profileFromDiscussionAuthor } from "../../../../src/portal/forum/profileModels";
import { useI18n } from "../../../../src/portal/i18n";
import type { PortalCatalog } from "../../../../src/shared/types";
import {
  discussionPreview,
  latestDiscussionReply,
  linkedObjects,
  markdownToPlainText,
  type PortalDiscussionPreview
} from "../lib/viewModels";

export type PortalDiscussionCardVariant = "compact" | "standard";

export function PortalDiscussionCard({
  catalog,
  discussion,
  onOpen,
  variant = "standard"
}: {
  catalog: PortalCatalog;
  discussion: ForumDiscussion;
  onOpen: () => void;
  variant?: PortalDiscussionCardVariant;
}) {
  const { locale, t } = useI18n();
  const objects = linkedObjects(discussion);
  const preview = discussionPreview(discussion, catalog);
  const excerpt = markdownToPlainText(discussion.body || discussion.excerpt);
  const hasObjectStrip = objects.length > 0;
  const isCompact = variant === "compact";
  const latestReply = isCompact ? undefined : latestDiscussionReply(discussion);
  const latestReplyBody = latestReply ? markdownToPlainText(latestReply.body) : "";
  const hasLatestReply = Boolean(latestReply && latestReplyBody);
  const authorProfile = profileFromDiscussionAuthor(discussion);
  const profileHoverContext = {
    currentUserEmail: catalog.currentUser.email.toLowerCase(),
    currentUserId: catalog.currentUser.id,
    currentUserLevelLabel: communityLevelLabel(catalog.journey.level.key, locale)
  };

  return (
    <article
      className={`portal-feed-row ${variant} ${preview ? "has-preview" : ""} ${hasLatestReply ? "has-latest-reply" : ""}`}
      id={`discussion-${discussion.id}`}
    >
      <span className="portal-feed-avatar">
        {discussion.anonymous ? (
          <ForumAnonymousAvatar name={discussion.author} persona={discussion.anonymousPersona} />
        ) : (
          <ProfileAvatarButton fallback={discussion.authorAvatar} profileHoverContext={profileHoverContext} user={authorProfile} />
        )}
      </span>
      <span className="portal-feed-content">
        <span className="portal-feed-meta">
          {discussion.pinned && <PinnedBadge />}
          {discussion.contributorAward && <ContributorAwardBadge award={discussion.contributorAward} compact />}
          {!isCompact && <strong>{discussion.category || discussion.tag}</strong>}
          {discussion.anonymous ? (
            <span>{!isCompact && "/ "}<ForumAnonymousName name={discussion.author} /></span>
          ) : (
            <span>{isCompact ? discussion.author : `/ ${discussion.author}`}</span>
          )}
          <span>/ <RelativeTime value={isCompact ? discussion.createdAt ?? discussion.lastActive : discussion.lastActive} /></span>
        </span>
        <strong className="portal-feed-title">{discussion.title}</strong>
        {!isCompact && excerpt && <span className="portal-feed-excerpt">{excerpt}</span>}
        {!isCompact && hasObjectStrip && (
          <span className="portal-object-strip">
            {objects.map((item) => <span className="portal-object-chip linked" key={item}>{item}</span>)}
          </span>
        )}
      </span>
      <span className="portal-feed-stats">
        <span><MessageCircle size={13} /> {discussion.replies}</span>
        {!isCompact && <span><Eye size={13} /> {discussion.views}</span>}
      </span>
      {preview && <DiscussionThumbnail preview={preview} />}
      {latestReply && latestReplyBody && (
        <span className="portal-latest-reply-shell">
          <span className="portal-latest-reply-clip">
            <span className="portal-latest-reply">
              <span className="portal-latest-reply-meta">
                <MessageCircle aria-hidden="true" size={11} />
                <span>{t("portal.discussions.latestReply")}</span>
                <span aria-hidden="true">·</span>
                <RelativeTime value={latestReply.createdAt} />
              </span>
              <span className="portal-latest-reply-body">
                <strong>{latestReply.author}</strong>
                <span aria-hidden="true">:</span>
                <span>{latestReplyBody}</span>
              </span>
            </span>
          </span>
        </span>
      )}
      <button
        aria-label={t("portal.discussions.open", { title: discussion.title })}
        className="portal-feed-open"
        onClick={onOpen}
        type="button"
      />
    </article>
  );
}

function DiscussionThumbnail({ preview }: { preview: PortalDiscussionPreview }) {
  return (
    <span className={`portal-feed-thumbnail ${preview.kind}`}>
      {preview.imageUrl ? (
        <img alt="" src={preview.imageUrl} />
      ) : (
        <span>
          {preview.kind === "app" ? <AppWindow size={20} /> : preview.kind === "file" ? <FileText size={20} /> : <Link2 size={20} />}
          <small>{preview.label}</small>
        </span>
      )}
    </span>
  );
}
