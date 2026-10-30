import { FeedbackNotice } from "../../../../src/portal/components/FeedbackNotice";
import { AppWindow, ArrowLeft, Check, Clock3, Eye, ImagePlus, Link2, MessageCircle, Paperclip, RefreshCw, Tags, X as XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { CopyForAgentButton } from "../../../../src/portal/components/WorkspaceAgentHandoff";
import { FormField, TextInput } from "../../../../src/portal/components/FormField";
import { ModalShell } from "../../../../src/portal/components/ModalShell";
import { RelativeTime } from "../../../../src/portal/components/shared/time";
import { MAX_FORUM_ATTACHMENTS, MAX_FORUM_BODY_LENGTH, type ForumReactionValue } from "../../../../src/portal/forum/config";
import { MarkdownComposer, StatusText } from "../../../../src/portal/forum/components/ForumComposerControls";
import {
  ForumMentionText,
  ParticipantButton,
  ProfileAvatarButton,
  ProfileNameButton
} from "../../../../src/portal/forum/components/ForumProfile";
import { ForumReactionBar } from "../../../../src/portal/forum/components/ForumReactionBar";
import { ContributorAwardBadge, ContributorAwardModal } from "../../../../src/portal/forum/components/ForumContributorAward";
import { ForumAnonymousAvatar, ForumAnonymousName } from "../../../../src/portal/forum/components/ForumAnonymousIdentity";
import type { ForumDiscussion } from "../../../../src/portal/forum/forumAnonymousIdentity";
import { ForumReplies } from "../../../../src/portal/forum/components/ForumReplies";
import { ModeratorActionMenu, PinnedBadge, PostActionMenu, PostModifiedMeta } from "../../../../src/portal/forum/components/ForumPostActions";
import { ForumTopicRequestError, readForumTopic } from "../../../../src/portal/forum/apiClient";
import { fileLabel, normalizeBrowserImageAttachmentMime, uploadForumAttachments } from "../../../../src/portal/forum/attachments";
import { formatBytes } from "../../../../src/portal/forum/formatters";
import { forumInlineMediaUrls, forumStandaloneAttachments } from "../../../../src/portal/forum/markdown";
import { canModerateForum, isOwnDiscussion } from "../../../../src/portal/forum/permissions";
import { nextOptimisticReactionState, reactionStateFromResponse } from "../../../../src/portal/forum/reactions";
import { readViewedForumTopicIds, rememberViewedForumTopicId } from "../../../../src/portal/forum/routeState";
import {
  buildParticipants,
  communityLevelLabel,
  profileFromDiscussionAuthor,
  profileSignature
} from "../../../../src/portal/forum/profileModels";
import type { PendingForumAttachment, SubmitState, UploadedForumAttachment } from "../../../../src/portal/forum/types";
import { useForumInlineAttachments } from "../../../../src/portal/forum/useForumInlineAttachments";
import { useI18n } from "../../../../src/portal/i18n";
import type { Discussion, DiscussionAttachment, PortalCatalog } from "../../../../src/shared/types";
import { PortalForumAttachmentBlocks, PortalForumRichBlocks } from "../components/PortalForumImages";
import { PortalRouteLoading } from "../components/PortalRecovery";
import { usePortalLinkedApps } from "../data/usePortalLinkedApps";
import { linkedObjects } from "../lib/viewModels";
import "../styles/post.css";

export function PortalPostDetail({
  catalog,
  onBack,
  onDeleted,
  onRefresh,
  onTopicLoaded,
  postId
}: {
  catalog: PortalCatalog;
  onBack: () => void;
  onDeleted: () => void | Promise<void>;
  onRefresh: () => void;
  onTopicLoaded: (discussion: Discussion) => void;
  postId: string;
}) {
  const { locale, t } = useI18n();
  const catalogTopic = catalog.discussions.find((discussion) => discussion.id === postId);
  const [topic, setTopic] = useState<ForumDiscussion | undefined>(catalogTopic);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "not_found" | "error">("loading");
  const [pinError, setPinError] = useState("");
  useEffect(() => setPinError(""), [postId]);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(catalogTopic?.title ?? "");
  const [editBody, setEditBody] = useState(catalogTopic?.body ?? catalogTopic?.excerpt ?? "");
  const [editAttachments, setEditAttachments] = useState<DiscussionAttachment[]>(catalogTopic?.attachments ?? []);
  const [editPendingAttachments, setEditPendingAttachments] = useState<PendingForumAttachment[]>([]);
  const [editMediaMessage, setEditMediaMessage] = useState("");
  const [editStatus, setEditStatus] = useState<SubmitState>("idle");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState<SubmitState>("idle");
  const [reacting, setReacting] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [contributorAwardOpen, setContributorAwardOpen] = useState(false);
  const editInline = useForumInlineAttachments();
  const editPreviewUrls = useRef<string[]>([]);
  const appsById = usePortalLinkedApps(catalog.apps, topic?.contentPlugins);
  const skillsById = useMemo(() => new Map(catalog.skills.map((skill) => [skill.id, skill])), [catalog.skills]);
  const objects = topic ? linkedObjects(topic) : [];
  const participants = useMemo(() => topic ? buildParticipants(topic) : [], [topic]);
  const canManage = Boolean(topic && isOwnDiscussion(topic, catalog.currentUser));
  const canModerate = canModerateForum(catalog.currentUser);
  const editAttachmentCount = editAttachments.length + editPendingAttachments.length + editInline.inlineAttachments.length;
  const visibleEditAttachments = forumStandaloneAttachments(editBody, editAttachments);
  const canSave = editTitle.trim().length > 0
    && (editBody.trim().length > 0 || editAttachmentCount > 0)
    && editStatus !== "submitting";
  const profileHoverContext = useMemo(() => ({
    currentUserEmail: catalog.currentUser.email.toLowerCase(),
    currentUserId: catalog.currentUser.id,
    currentUserLevelLabel: communityLevelLabel(catalog.journey.level.key, locale)
  }), [catalog.currentUser.email, catalog.currentUser.id, catalog.journey.level.key, locale]);

  useEffect(() => {
    const cachedTopic = catalog.discussions.find((discussion) => discussion.id === postId);
    const controller = new AbortController();

    setTopic(cachedTopic);
    setLoadState("loading");
    setEditTitle(cachedTopic?.title ?? "");
    setEditBody(cachedTopic?.body ?? cachedTopic?.excerpt ?? "");
    setEditAttachments(cachedTopic?.attachments ?? []);
    setEditPendingAttachments([]);
    setEditMediaMessage("");
    clearEditAttachmentPreviews();
    setIsEditing(false);
    setEditStatus("idle");
    setDeleteOpen(false);
    setDeleteStatus("idle");
    setPinning(false);
    setContributorAwardOpen(false);
    editInline.discardInlineAttachments();

    void readForumTopic(postId, controller.signal).then((discussion) => {
      setTopic(discussion);
      setEditTitle(discussion.title);
      setEditBody(discussion.body ?? discussion.excerpt);
      setEditAttachments(discussion.attachments ?? []);
      setLoadState("ready");
      onTopicLoaded(discussion);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) {
        return;
      }

      if (error instanceof ForumTopicRequestError && error.status === 404) {
        setTopic(undefined);
        setLoadState("not_found");
        return;
      }

      setLoadState(cachedTopic ? "ready" : "error");
    });

    return () => controller.abort();
  }, [loadAttempt, onTopicLoaded, postId]);

  useEffect(() => {
    return () => clearEditAttachmentPreviews();
  }, []);

  useEffect(() => {
    if (catalogTopic) {
      setTopic(catalogTopic);
    }
  }, [catalogTopic]);

  useEffect(() => {
    if (loadState !== "ready" || !topic || readViewedForumTopicIds().includes(topic.id)) {
      return;
    }

    const controller = new AbortController();
    void fetch(`/api/forum/topics/${encodeURIComponent(topic.id)}/view`, {
      method: "POST",
      signal: controller.signal
    }).then((response) => {
      if (!response.ok) {
        return;
      }

      rememberViewedForumTopicId(topic.id);
      setTopic((current) => current ? { ...current, views: current.views + 1 } : current);
    }).catch(() => undefined);

    return () => controller.abort();
  }, [loadState, topic?.id]);

  if (!topic) {
    const isLoading = loadState === "loading";
    const isError = loadState === "error";

    if (isLoading) {
      return <PortalRouteLoading variant="post" />;
    }

    return (
      <div className="portal-workspace-inner portal-post-page">
        <Button iconBefore={<ArrowLeft size={16} />} onClick={onBack} size="compact" variant="secondary">
          {t("portal.post.back")}
        </Button>
        <section aria-live="polite" className="portal-post-empty">
          <h1>{t(isError
            ? "portal.post.loadFailed"
            : "portal.post.notFound")}</h1>
          <p>{t(isError ? "portal.post.loadFailedHint" : "portal.post.notFoundHint")}</p>
          {isError && (
            <Button
              iconBefore={<RefreshCw size={15} />}
              onClick={() => setLoadAttempt((current) => current + 1)}
              size="compact"
              variant="primary"
            >
              {t("portal.data.retry")}
            </Button>
          )}
        </section>
      </div>
    );
  }

  const topicAuthorProfile = profileFromDiscussionAuthor(topic);

  function startTopicEdit() {
    if (!topic) {
      return;
    }

    clearEditAttachmentPreviews();
    editInline.discardInlineAttachments();
    setEditTitle(topic.title);
    setEditBody(topic.body ?? topic.excerpt);
    setEditAttachments(topic.attachments ?? []);
    setEditPendingAttachments([]);
    setEditMediaMessage("");
    setEditStatus("idle");
    setIsEditing(true);
  }

  function cancelTopicEdit() {
    if (!topic) {
      return;
    }

    clearEditAttachmentPreviews();
    editInline.discardInlineAttachments();
    setEditAttachments(topic.attachments ?? []);
    setEditPendingAttachments([]);
    setEditMediaMessage("");
    setEditStatus("idle");
    setIsEditing(false);
  }

  function selectEditImages(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";

    if (selectedFiles.length === 0) {
      return;
    }

    const availableSlots = Math.max(MAX_FORUM_ATTACHMENTS - editAttachmentCount, 0);
    const accepted: PendingForumAttachment[] = [];
    let rejected = Math.max(selectedFiles.length - availableSlots, 0);

    selectedFiles.slice(0, availableSlots).forEach((file) => {
      const mimeType = normalizeBrowserImageAttachmentMime(file);

      if (!mimeType) {
        rejected += 1;
        return;
      }

      const previewUrl = URL.createObjectURL(file);
      editPreviewUrls.current.push(previewUrl);
      accepted.push({
        id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
        file,
        previewUrl,
        kind: "image",
        mimeType
      });
    });

    if (accepted.length > 0) {
      setEditPendingAttachments((current) => [...current, ...accepted]);
    }

    setEditMediaMessage(rejected > 0 ? t("forum.imagesSkipped", { count: rejected }) : "");
  }

  function removeEditAttachment(id: string) {
    setEditAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function changeEditBody(nextBody: string) {
    const previousInlineUrls = forumInlineMediaUrls(editBody);
    const nextInlineUrls = forumInlineMediaUrls(nextBody);
    setEditAttachments((current) => current.filter((attachment) => (
      !previousInlineUrls.has(attachment.url) || nextInlineUrls.has(attachment.url)
    )));
    setEditBody(nextBody);
  }

  function removePendingEditAttachment(id: string) {
    setEditPendingAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);

      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
        editPreviewUrls.current = editPreviewUrls.current.filter((previewUrl) => previewUrl !== removed.previewUrl);
      }

      return current.filter((attachment) => attachment.id !== id);
    });
  }

  function clearEditAttachmentPreviews() {
    editPreviewUrls.current.forEach((previewUrl) => URL.revokeObjectURL(previewUrl));
    editPreviewUrls.current = [];
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSave || !topic) {
      return;
    }

    setEditStatus("submitting");

    try {
      const uploadedAttachments = editPendingAttachments.length > 0
        ? await uploadForumAttachments(editPendingAttachments)
        : [];
      const allUploadedAttachments = [...uploadedAttachments, ...editInline.inlineAttachments];
      const response = await fetch(`/api/forum/topics/${encodeURIComponent(topic.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: editTitle,
          body: editBody,
          attachments: allUploadedAttachments,
          retainedAttachmentIds: editAttachments.map((attachment) => attachment.id)
        })
      });

      if (!response.ok) {
        throw new Error("update_topic_failed");
      }

      const nextAttachments = [
        ...editAttachments,
        ...allUploadedAttachments.map(uploadedAttachmentToDiscussionAttachment)
      ];
      setTopic((current) => current ? {
        ...current,
        attachments: nextAttachments,
        body: editBody,
        excerpt: editBody,
        title: editTitle,
        updatedAt: new Date().toISOString()
      } : current);
      clearEditAttachmentPreviews();
      setEditAttachments(nextAttachments);
      setEditPendingAttachments([]);
      setEditMediaMessage("");
      editInline.commitInlineAttachments();
      setEditStatus("success");
      setIsEditing(false);
      onRefresh();
      window.setTimeout(() => setEditStatus("idle"), 1200);
    } catch {
      setEditStatus("error");
    }
  }

  async function deleteTopic() {
    if (!topic || deleteStatus === "submitting") {
      return;
    }

    setDeleteStatus("submitting");

    try {
      const response = await fetch(`/api/forum/topics/${encodeURIComponent(topic.id)}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error("delete_topic_failed");
      }
      setDeleteStatus("success");
      await onDeleted();
    } catch {
      setDeleteStatus("error");
    }
  }

  async function toggleTopicReaction(reaction: ForumReactionValue) {
    if (reacting || !topic) {
      return;
    }

    const rollback = topic;
    const nextReaction = topic.currentUserReaction === reaction ? undefined : reaction;
    const optimistic = nextOptimisticReactionState(topic, reaction);
    setReacting(true);
    setTopic({ ...topic, ...optimistic });

    try {
      const response = await fetch(`/api/forum/topics/${encodeURIComponent(topic.id)}/like`, {
        method: nextReaction ? "POST" : "DELETE",
        headers: nextReaction ? { "content-type": "application/json" } : undefined,
        body: nextReaction ? JSON.stringify({ reaction: nextReaction }) : undefined
      });

      if (!response.ok) {
        throw new Error("topic_reaction_failed");
      }

      const payload = await response.json() as {
        liked?: boolean;
        likes?: number;
        reaction?: string;
        reactions?: NonNullable<ForumDiscussion["reactions"]>;
      };
      setTopic((current) => current ? { ...current, ...reactionStateFromResponse(payload, optimistic) } : current);
      onRefresh();
    } catch {
      setTopic(rollback);
    } finally {
      setReacting(false);
    }
  }

  async function toggleTopicPin() {
    if (!topic || pinning) return;
    const nextPinned = !topic.pinned;
    setPinning(true);
    setPinError("");

    try {
      const response = await fetch(`/api/forum/topics/${encodeURIComponent(topic.id)}/pin`, {
        method: nextPinned ? "POST" : "DELETE"
      });
      if (!response.ok) throw new Error("pin_topic_failed");
      setTopic((current) => current ? { ...current, pinned: nextPinned } : current);
      onRefresh();
    } catch {
      setPinError(t("forum.pinFailed"));
    } finally {
      setPinning(false);
    }
  }

  return (
    <div className="portal-workspace-inner portal-post-page">
      <div className="portal-post-toolbar">
        <Button iconBefore={<ArrowLeft size={16} />} onClick={onBack} size="compact" variant="secondary">
          {t("portal.post.back")}
        </Button>
      </div>

      {pinError && <FeedbackNotice tone="error" actions={<Button isLoading={pinning} onClick={() => void toggleTopicPin()}>{t("portal.data.retry")}</Button>}>{pinError}</FeedbackNotice>}
      <div className="portal-post-layout">
        <article className="portal-post-paper">
          {!isEditing && <h1>{topic.title}</h1>}
          <div className="portal-post-meta">
            {topic.pinned && <PinnedBadge />}
            <span>{topic.category || topic.tag}</span>
            {topic.source === "mcp" && <span>MCP</span>}
          </div>
          <header className="portal-post-author-line">
            <div className="portal-post-author">
              {topic.anonymous ? (
                <ForumAnonymousAvatar name={topic.author} persona={topic.anonymousPersona} />
              ) : (
                <ProfileAvatarButton profileHoverContext={profileHoverContext} user={topicAuthorProfile} />
              )}
              <span className="portal-post-author-copy">
                <span className="portal-post-author-name-line">
                  {topic.anonymous ? <ForumAnonymousName name={topic.author} /> : <ProfileNameButton user={topicAuthorProfile} />}
                  <span aria-hidden="true">·</span>
                  <RelativeTime className="portal-post-published-at" showClock value={topic.createdAt ?? topic.lastActive} />
                </span>
                <small>{topic.anonymous ? t("forum.anonymousMember") : profileSignature(topicAuthorProfile, locale)}</small>
              </span>
            </div>
            <div className="portal-post-actions">
              <CopyForAgentButton title={topic.title} topicId={topic.id} />
              <ForumReactionBar
                disabled={reacting}
                onReact={(reaction) => void toggleTopicReaction(reaction)}
                reactions={topic.reactions}
                selectedReaction={topic.currentUserReaction}
                total={topic.likes}
              />
              {canManage && (
                <PostActionMenu
                  disabled={editStatus === "submitting" || deleteStatus === "submitting"}
                  isDeleting={deleteStatus === "submitting"}
                  onDelete={() => setDeleteOpen(true)}
                  onEdit={startTopicEdit}
                />
              )}
              {canModerate && (
                <ModeratorActionMenu
                  disabled={pinning || deleteStatus === "submitting"}
                  isDeleting={deleteStatus === "submitting"}
                  isContributorAwarded={Boolean(topic.contributorAward)}
                  isPinned={Boolean(topic.pinned)}
                  isPinning={pinning}
                  onAwardContributor={!canManage
                    ? () => setContributorAwardOpen(true)
                    : undefined}
                  onDelete={() => setDeleteOpen(true)}
                  onTogglePin={() => void toggleTopicPin()}
                />
              )}
            </div>
          </header>

          {isEditing ? (
            <form className="portal-post-edit" onSubmit={saveEdit}>
              <FormField label={t("forum.fieldTitle")}>
                <TextInput maxLength={140} onChange={(event) => setEditTitle(event.target.value)} value={editTitle} />
              </FormField>
              <FormField label={t("forum.fieldPost")}>
                <MarkdownComposer
                  inlineAttachments={editInline.inlineAttachments}
                  maxLength={MAX_FORUM_BODY_LENGTH}
                  maxInlineAttachments={MAX_FORUM_ATTACHMENTS - editAttachments.length - editPendingAttachments.length}
                  mentions={(topic.mentions ?? []).filter((mention) => !mention.postId || mention.postId === topic.rootPostId)}
                  onChange={changeEditBody}
                  onInlineAttachmentsChange={editInline.replaceInlineAttachments}
                  onTitleChange={setEditTitle}
                  placeholder={t("forum.writeUpdatePlaceholder")}
                  rows={7}
                  title={editTitle}
                  value={editBody}
                />
              </FormField>
              {(visibleEditAttachments.length + editPendingAttachments.length > 0 || editMediaMessage) && (
                <div className="composerMediaPanel">
                  <div className="composerMediaHeader">
                    <div>
                      <strong>{t("forum.mediaFiles")}</strong>
                      <span>{editAttachmentCount} / {MAX_FORUM_ATTACHMENTS}</span>
                    </div>
                    <label aria-label={t("forum.addImages")} className="attachmentPicker attachmentIconPicker" title={t("forum.addImages")}>
                      <ImagePlus size={16} />
                      <input
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        disabled={editAttachmentCount >= MAX_FORUM_ATTACHMENTS}
                        multiple
                        onChange={selectEditImages}
                        type="file"
                      />
                    </label>
                  </div>
                  {visibleEditAttachments.length + editPendingAttachments.length > 0 && (
                    <div className="composerAttachmentGrid">
                      {visibleEditAttachments.map((attachment) => (
                        <div className="composerAttachment" key={attachment.id}>
                          {attachment.type === "image" ? (
                            <img alt={attachment.alt ?? attachment.fileName} src={attachment.url} />
                          ) : (
                            <span>
                              <Paperclip size={18} />
                              {fileLabel(attachment.mimeType)}
                            </span>
                          )}
                          <div>
                            <strong>{attachment.fileName}</strong>
                            <small>{formatBytes(attachment.fileSize)}</small>
                          </div>
                          <button
                            aria-label={t("forum.removeAttachmentAria", { name: attachment.fileName })}
                            disabled={editStatus === "submitting"}
                            onClick={() => removeEditAttachment(attachment.id)}
                            type="button"
                          >
                            <XIcon size={14} />
                          </button>
                        </div>
                      ))}
                      {editPendingAttachments.map((attachment) => (
                        <div className="composerAttachment" key={attachment.id}>
                          {attachment.previewUrl && <img alt={attachment.file.name} src={attachment.previewUrl} />}
                          <div>
                            <strong>{attachment.file.name}</strong>
                            <small>{formatBytes(attachment.file.size)}</small>
                          </div>
                          <button
                            aria-label={t("forum.removeAttachmentAria", { name: attachment.file.name })}
                            disabled={editStatus === "submitting"}
                            onClick={() => removePendingEditAttachment(attachment.id)}
                            type="button"
                          >
                            <XIcon size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {editMediaMessage && <p className="mediaMessage">{editMediaMessage}</p>}
                </div>
              )}
              <div className="portal-post-edit-actions">
                <StatusText errorText={t("forum.couldNotSave")} status={editStatus} successText={t("forum.saved")} />
                {editAttachmentCount === 0 && !editMediaMessage && (
                  <label aria-label={t("forum.addImages")} className="attachmentPicker attachmentIconPicker" title={t("forum.addImages")}>
                    <ImagePlus size={16} />
                    <input
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      multiple
                      onChange={selectEditImages}
                      type="file"
                    />
                  </label>
                )}
                <Button onClick={cancelTopicEdit} size="compact" variant="secondary">{t("forum.cancel")}</Button>
                <Button disabled={!canSave} iconBefore={<Check size={15} />} isLoading={editStatus === "submitting"} size="compact" type="submit" variant="primary">
                  {t("forum.save")}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <hr className="portal-post-divider" />
              <ForumMentionText className="portal-post-body" discussion={topic} value={topic.body || topic.excerpt} />
              <PortalForumRichBlocks appsById={appsById} discussion={topic} skillsById={skillsById} />
              {topic.contributorAward && <ContributorAwardBadge award={topic.contributorAward} />}
              <PostModifiedMeta actor={topic.author} createdAt={topic.createdAt} updatedAt={topic.updatedAt} />
            </>
          )}

          {!isEditing && (
            <ForumReplies
              currentUser={catalog.currentUser}
              discussion={topic}
              onReplied={async () => onRefresh()}
              profileHoverContext={profileHoverContext}
              renderAttachments={(attachments, compact, replyBody) => (
                <PortalForumAttachmentBlocks attachments={forumStandaloneAttachments(replyBody, attachments)} compact={compact} />
              )}
            />
          )}
        </article>

        <aside className="portal-post-context">
          <section>
            <strong>{t("portal.post.thread")}</strong>
            {topic.replies > 0 && (
              <span><MessageCircle size={14} /> {t("portal.discussions.replyCount", { count: topic.replies })}</span>
            )}
            <span><Eye size={14} /> {t("portal.discussions.viewCount", { count: topic.views })}</span>
            <span><Clock3 size={14} /> <RelativeTime value={topic.lastActive} /></span>
          </section>
          <section>
            <strong>{t("portal.post.participants")}</strong>
            {participants.map((participant) => (
              <ParticipantButton key={participant.id} participant={participant} profileHoverContext={profileHoverContext} />
            ))}
          </section>
          <section>
            <strong>{t("portal.post.objects")}</strong>
            {topic.linkedApp && <span><AppWindow size={14} /> {topic.linkedApp}</span>}
            {topic.linkedSkill && <span><Tags size={14} /> {topic.linkedSkill}</span>}
            {topic.linkedMcp && <span><Link2 size={14} /> {topic.linkedMcp}</span>}
            {objects.length === 0 && <small>{t("portal.post.noObjects")}</small>}
          </section>
        </aside>
      </div>

      {deleteOpen && (
        <ModalShell
          ariaLabel={t("portal.post.deleteTitle")}
          header={<div><p className="portal-kicker">{t("forum.delete")}</p><h2>{t("portal.post.deleteTitle")}</h2></div>}
          modalClassName="portal-confirm-dialog"
          onClose={() => deleteStatus !== "submitting" && setDeleteOpen(false)}
          overlayClassName="portal-dialog-layer"
        >
          <p>{t("portal.post.deleteBody")}</p>
          <StatusText errorText={t("forum.couldNotDelete")} status={deleteStatus} successText={t("forum.deleted")} />
          <div className="portal-confirm-actions">
            <Button disabled={deleteStatus === "submitting"} onClick={() => setDeleteOpen(false)} variant="secondary">{t("forum.cancel")}</Button>
            <Button isLoading={deleteStatus === "submitting"} onClick={() => void deleteTopic()} variant="primary">{t("portal.post.deleteConfirm")}</Button>
          </div>
        </ModalShell>
      )}
      {contributorAwardOpen && (
        <ContributorAwardModal
          endpoint={`/api/forum/topics/${encodeURIComponent(topic.id)}/contributor-award`}
          onAwarded={(result) => {
            setTopic((current) => current ? {
              ...current,
              contributorAward: result.award,
              journeyCommunityContributionPoints: result.journeyCommunityContributionPoints,
              journeyLevelKey: result.journeyLevelKey,
              journeyTotalPoints: result.journeyTotalPoints
            } : current);
            onRefresh();
          }}
          onClose={() => setContributorAwardOpen(false)}
          recipientName={topic.author}
        />
      )}
    </div>
  );
}

function uploadedAttachmentToDiscussionAttachment(attachment: UploadedForumAttachment): DiscussionAttachment {
  return {
    id: attachment.storageKey,
    type: attachment.mimeType.startsWith("image/") ? "image" : "file",
    url: attachment.publicUrl,
    fileName: attachment.fileName,
    fileSize: attachment.fileSize,
    mimeType: attachment.mimeType,
    alt: attachment.fileName
  };
}
