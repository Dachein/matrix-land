import { Check, ImagePlus, Send, X as XIcon } from "lucide-react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { DiscussionAttachment, PortalCatalog } from "../../../shared/types";
import { Button } from "../../components/Button";
import { useI18n } from "../../i18n";
import { MAX_FORUM_ATTACHMENTS, MAX_FORUM_BODY_LENGTH, type ForumReactionValue } from "../config";
import type { PendingForumAttachment, ProfileHoverContext, SubmitState } from "../types";
import { normalizeBrowserImageAttachmentMime, uploadForumAttachments } from "../attachments";
import { formatBytes } from "../formatters";
import { forumInlineMediaUrls, forumStandaloneAttachments } from "../markdown";
import { canModerateForum, isOwnReply } from "../permissions";
import { profileFromReply } from "../profileModels";
import { nextOptimisticReactionState, reactionStateFromResponse } from "../reactions";
import { MarkdownComposer, StatusText } from "./ForumComposerControls";
import { ForumAuthorMeta, ForumMentionText, ProfileAvatarButton, ProfileNameButton } from "./ForumProfile";
import { ForumAnonymousAvatar, ForumAnonymousIdentityControls, ForumAnonymousName } from "./ForumAnonymousIdentity";
import { ForumReactionBar } from "./ForumReactionBar";
import { ContributorAwardBadge, ContributorAwardModal } from "./ForumContributorAward";
import { ForumAttachmentBlocks } from "./ForumRichBlocks";
import { ModeratorActionMenu, PinnedBadge, PostActionMenu, PostModifiedMeta } from "./ForumPostActions";
import { useForumInlineAttachments } from "../useForumInlineAttachments";
import {
  forumAnonymousPersona,
  randomForumAnonymousPersona,
  type ForumAnonymousPersona,
  type ForumDiscussion,
  type ForumDiscussionReply
} from "../forumAnonymousIdentity";

export function ForumReplies({
  currentUser,
  discussion,
  onReplied,
  profileHoverContext,
  renderAttachments
}: {
  currentUser: PortalCatalog["currentUser"];
  discussion: ForumDiscussion;
  onReplied: () => Promise<void>;
  profileHoverContext: ProfileHoverContext;
  renderAttachments?: (attachments: DiscussionAttachment[], compact: boolean, body: string) => ReactNode;
}) {
  const { t } = useI18n();
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<PendingForumAttachment[]>([]);
  const [mediaMessage, setMediaMessage] = useState("");
  const [status, setStatus] = useState<SubmitState>("idle");
  const [anonymous, setAnonymous] = useState(false);
  const [anonymousPersona, setAnonymousPersona] = useState<ForumAnonymousPersona>(
    () => discussion.currentUserAnonymousPersona ?? randomForumAnonymousPersona()
  );
  const [lockedAnonymousPersona, setLockedAnonymousPersona] = useState<ForumAnonymousPersona | undefined>(
    discussion.currentUserAnonymousPersona
  );
  const [editingReplyId, setEditingReplyId] = useState<string | undefined>();
  const [editingReplyBody, setEditingReplyBody] = useState("");
  const [editingReplyAttachments, setEditingReplyAttachments] = useState<DiscussionAttachment[]>([]);
  const [replyEditStatus, setReplyEditStatus] = useState<SubmitState>("idle");
  const [deletingReplyId, setDeletingReplyId] = useState<string | undefined>();
  const [deleteStatus, setDeleteStatus] = useState<SubmitState>("idle");
  const [likingReplyId, setLikingReplyId] = useState<string | undefined>();
  const [pinningReplyId, setPinningReplyId] = useState<string | undefined>();
  const [contributorAwardReplyId, setContributorAwardReplyId] = useState<string | undefined>();
  const [localReplies, setLocalReplies] = useState<ForumDiscussionReply[]>(() => discussion.replyPosts ?? []);
  const replyInline = useForumInlineAttachments();
  const editInline = useForumInlineAttachments();
  const optimisticReplyIds = useRef<Set<string>>(new Set());
  const lastDiscussionId = useRef(discussion.id);
  const previewUrls = useRef<string[]>([]);
  const replies = localReplies;
  const replyAttachmentCount = attachments.length + replyInline.inlineAttachments.length;
  const canSubmit = (body.trim().length > 0 || replyAttachmentCount > 0) && status !== "submitting";

  useEffect(() => {
    return () => {
      clearAttachmentPreviews();
    };
  }, []);

  useEffect(() => {
    if (lastDiscussionId.current !== discussion.id) {
      optimisticReplyIds.current.clear();
      lastDiscussionId.current = discussion.id;
    }

    const serverReplies = discussion.replyPosts ?? [];
    const serverReplyIds = new Set(serverReplies.map((reply) => reply.id));
    optimisticReplyIds.current.forEach((replyId) => {
      if (serverReplyIds.has(replyId)) {
        optimisticReplyIds.current.delete(replyId);
      }
    });
    setLocalReplies((current) => [
      ...serverReplies,
      ...current.filter((reply) => optimisticReplyIds.current.has(reply.id) && !serverReplyIds.has(reply.id))
    ]);
  }, [discussion.id, discussion.replyPosts]);

  useEffect(() => {
    setBody("");
    setAttachments([]);
    setMediaMessage("");
    setStatus("idle");
    setAnonymous(false);
    setAnonymousPersona(discussion.currentUserAnonymousPersona ?? randomForumAnonymousPersona());
    setLockedAnonymousPersona(discussion.currentUserAnonymousPersona);
    setEditingReplyId(undefined);
    setEditingReplyBody("");
    setEditingReplyAttachments([]);
    setReplyEditStatus("idle");
    setDeleteStatus("idle");
    setDeletingReplyId(undefined);
    setLikingReplyId(undefined);
    setPinningReplyId(undefined);
    setContributorAwardReplyId(undefined);
    replyInline.discardInlineAttachments();
    editInline.discardInlineAttachments();
    clearAttachmentPreviews();
  }, [discussion.id]);

  function selectReplyImages(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";

    if (selectedFiles.length === 0) {
      return;
    }

    const availableSlots = MAX_FORUM_ATTACHMENTS - replyAttachmentCount;
    const accepted: PendingForumAttachment[] = [];
    let rejected = 0;

    selectedFiles.slice(0, Math.max(availableSlots, 0)).forEach((file) => {
      const mimeType = normalizeBrowserImageAttachmentMime(file);

      if (!mimeType) {
        rejected += 1;
        return;
      }

      const previewUrl = URL.createObjectURL(file);
      previewUrls.current.push(previewUrl);
      accepted.push({
        id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
        file,
        previewUrl,
        kind: "image",
        mimeType
      });
    });

    if (selectedFiles.length > availableSlots) {
      rejected += selectedFiles.length - availableSlots;
    }

    if (accepted.length > 0) {
      setAttachments((current) => [...current, ...accepted]);
    }

    setMediaMessage(
      rejected > 0
        ? t("forum.imagesSkipped", { count: rejected })
        : ""
    );
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);

      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
        previewUrls.current = previewUrls.current.filter((previewUrl) => previewUrl !== removed.previewUrl);
      }

      return current.filter((attachment) => attachment.id !== id);
    });
  }

  function clearAttachmentPreviews() {
    previewUrls.current.forEach((previewUrl) => URL.revokeObjectURL(previewUrl));
    previewUrls.current = [];
  }

  async function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) {
      return;
    }

    setStatus("submitting");

    try {
      const uploadedAttachments = attachments.length > 0 ? await uploadForumAttachments(attachments) : [];
      const allUploadedAttachments = [...uploadedAttachments, ...replyInline.inlineAttachments];
      const response = await fetch(`/api/forum/topics/${discussion.id}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          anonymous,
          anonymousPersona: anonymous ? anonymousPersona : undefined,
          body,
          attachments: allUploadedAttachments
        })
      });

      if (!response.ok) {
        throw new Error("reply_failed");
      }

      const created = await response.json() as { anonymous?: boolean; anonymousPersona?: ForumAnonymousPersona; id?: string };
      const replyId = created.id ?? crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const confirmedAnonymous = created.anonymous === true;
      const confirmedPersona = confirmedAnonymous
        ? created.anonymousPersona ?? lockedAnonymousPersona ?? anonymousPersona
        : undefined;
      const anonymousIdentity = forumAnonymousPersona(confirmedPersona);
      const nextReply: ForumDiscussionReply = {
        id: replyId,
        authorId: confirmedAnonymous ? undefined : currentUser.id,
        author: anonymousIdentity?.name ?? currentUser.name,
        authorEmail: confirmedAnonymous ? undefined : currentUser.email,
        authorAvatarUrl: anonymousIdentity?.avatarUrl ?? currentUser.avatarUrl,
        anonymous: confirmedAnonymous,
        anonymousPersona: confirmedPersona,
        ownedByCurrentUser: true,
        body,
        createdAt,
        updatedAt: createdAt,
        attachments: allUploadedAttachments.map(uploadedAttachmentToDiscussionAttachment),
        likes: 0,
        likedByCurrentUser: false,
        reactions: [],
        currentUserReaction: undefined,
        department: confirmedAnonymous ? undefined : currentUser.department,
        team: confirmedAnonymous ? undefined : currentUser.team,
        jobTitle: confirmedAnonymous ? undefined : currentUser.jobTitle,
        bio: confirmedAnonymous ? undefined : currentUser.bio,
        location: confirmedAnonymous ? undefined : currentUser.location
      };

      if (confirmedPersona) {
        setAnonymousPersona(confirmedPersona);
        setLockedAnonymousPersona(confirmedPersona);
      }

      optimisticReplyIds.current.add(replyId);
      setLocalReplies((current) => (
        current.some((reply) => reply.id === replyId)
          ? current
          : [...current, nextReply]
      ));
      setBody("");
      setAttachments([]);
      setMediaMessage("");
      replyInline.commitInlineAttachments();
      clearAttachmentPreviews();
      setStatus("success");
      void onReplied().catch(() => undefined);
      window.setTimeout(() => setStatus("idle"), 1200);
    } catch {
      setStatus("error");
    }
  }

  function startReplyEdit(reply: ForumDiscussionReply) {
    editInline.discardInlineAttachments();
    setEditingReplyId(reply.id);
    setEditingReplyBody(reply.body ?? "");
    setEditingReplyAttachments(reply.attachments ?? []);
    setReplyEditStatus("idle");
  }

  function cancelReplyEdit() {
    editInline.discardInlineAttachments();
    setEditingReplyId(undefined);
    setEditingReplyBody("");
    setEditingReplyAttachments([]);
    setReplyEditStatus("idle");
  }

  function removeEditingReplyAttachment(id: string) {
    setEditingReplyAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function changeEditingReplyBody(nextBody: string) {
    const previousInlineUrls = forumInlineMediaUrls(editingReplyBody);
    const nextInlineUrls = forumInlineMediaUrls(nextBody);
    setEditingReplyAttachments((current) => current.filter((attachment) => (
      !previousInlineUrls.has(attachment.url) || nextInlineUrls.has(attachment.url)
    )));
    setEditingReplyBody(nextBody);
  }

  async function saveReplyEdit(event: FormEvent<HTMLFormElement>, reply: ForumDiscussionReply) {
    event.preventDefault();

    if (replyEditStatus === "submitting") {
      return;
    }

    setReplyEditStatus("submitting");

    try {
      const response = await fetch(`/api/forum/topics/${encodeURIComponent(discussion.id)}/replies/${encodeURIComponent(reply.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attachments: editInline.inlineAttachments,
          body: editingReplyBody,
          retainedAttachmentIds: editingReplyAttachments.map((attachment) => attachment.id)
        })
      });

      if (!response.ok) {
        throw new Error("update_reply_failed");
      }

      const nextAttachments = [
        ...editingReplyAttachments,
        ...editInline.inlineAttachments.map(uploadedAttachmentToDiscussionAttachment)
      ];
      setReplyEditStatus("success");
      setLocalReplies((current) => current.map((currentReply) => (
        currentReply.id === reply.id
          ? {
              ...currentReply,
              attachments: nextAttachments,
              body: editingReplyBody,
              updatedAt: new Date().toISOString()
            }
          : currentReply
      )));
      setEditingReplyId(undefined);
      setEditingReplyBody("");
      setEditingReplyAttachments([]);
      editInline.commitInlineAttachments();
      void onReplied().catch(() => undefined);
      window.setTimeout(() => setReplyEditStatus("idle"), 1200);
    } catch {
      setReplyEditStatus("error");
    }
  }

  async function deleteReply(reply: ForumDiscussionReply) {
    if (deletingReplyId) {
      return;
    }

    if (!window.confirm(t("forum.deleteReplyConfirm"))) {
      return;
    }

    setDeletingReplyId(reply.id);
    setDeleteStatus("submitting");

    try {
      const response = await fetch(`/api/forum/topics/${discussion.id}/replies/${reply.id}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error("delete_reply_failed");
      }

      setDeleteStatus("success");
      setLocalReplies((current) => current.filter((currentReply) => currentReply.id !== reply.id));
      void onReplied().catch(() => undefined);
      window.setTimeout(() => setDeleteStatus("idle"), 1200);
    } catch {
      setDeleteStatus("error");
    } finally {
      setDeletingReplyId(undefined);
    }
  }

  async function toggleReplyReaction(reply: ForumDiscussionReply, reaction: ForumReactionValue) {
    if (likingReplyId) {
      return;
    }

    const nextReaction = reply.currentUserReaction === reaction ? undefined : reaction;
    const nextOptimisticReaction = nextOptimisticReactionState(reply, reaction);
    setLikingReplyId(reply.id);
    setLocalReplies((current) => current.map((currentReply) => (
      currentReply.id === reply.id
        ? { ...currentReply, ...nextOptimisticReaction }
        : currentReply
    )));

    try {
      const response = await fetch(`/api/forum/topics/${encodeURIComponent(discussion.id)}/replies/${encodeURIComponent(reply.id)}/like`, {
        method: nextReaction ? "POST" : "DELETE",
        headers: nextReaction ? { "content-type": "application/json" } : undefined,
        body: nextReaction ? JSON.stringify({ reaction: nextReaction }) : undefined
      });

      if (!response.ok) {
        throw new Error("reply_like_failed");
      }

      const payload = await response.json() as { liked?: boolean; likes?: number; reaction?: string; reactions?: NonNullable<ForumDiscussionReply["reactions"]> };
      const confirmedReaction = reactionStateFromResponse(payload, nextOptimisticReaction);
      setLocalReplies((current) => current.map((currentReply) => (
        currentReply.id === reply.id
          ? { ...currentReply, ...confirmedReaction }
          : currentReply
      )));
      void onReplied().catch(() => undefined);
    } catch {
      setLocalReplies((current) => current.map((currentReply) => (
        currentReply.id === reply.id ? reply : currentReply
      )));
    } finally {
      setLikingReplyId(undefined);
    }
  }

  async function toggleReplyPin(reply: ForumDiscussionReply) {
    if (pinningReplyId) return;
    const nextPinned = !reply.pinned;
    setPinningReplyId(reply.id);

    try {
      const response = await fetch(`/api/forum/topics/${encodeURIComponent(discussion.id)}/replies/${encodeURIComponent(reply.id)}/pin`, {
        method: nextPinned ? "POST" : "DELETE"
      });
      if (!response.ok) throw new Error("pin_reply_failed");
      setLocalReplies((current) => orderedForumReplies(current.map((item) => item.id === reply.id ? { ...item, pinned: nextPinned } : item)));
      void onReplied().catch(() => undefined);
    } catch {
      window.alert(t("forum.pinFailed"));
    } finally {
      setPinningReplyId(undefined);
    }
  }

  return (
    <section className="forumReplies" id="forum-replies">
      {replies.length > 0 && (
        <div className="replyHeader">
          <strong>{t("forum.repliesCount", { count: replies.length })}</strong>
          <StatusText status={deleteStatus} successText={t("forum.replyDeleted")} errorText={t("forum.couldNotDeleteReply")} />
        </div>
      )}
      {replies.length > 0 ? (
        <div className="replyList">
          {replies.map((reply) => {
            const replyProfile = profileFromReply(reply, discussion);
            const canManageReply = isOwnReply(reply, currentUser);
            const canModerateReply = canModerateForum(currentUser);
            const isEditingReply = editingReplyId === reply.id;
            const editingAttachmentCount = editingReplyAttachments.length + editInline.inlineAttachments.length;
            const visibleEditingAttachments = forumStandaloneAttachments(editingReplyBody, editingReplyAttachments);
            const canSaveReply = (editingReplyBody.trim().length > 0 || editingAttachmentCount > 0) && replyEditStatus !== "submitting";

            return (
              <div className="forumReply" key={reply.id}>
                <div className="replyAuthorLine">
                  <div className="forumAuthor">
                    {reply.anonymous ? (
                      <ForumAnonymousAvatar name={reply.author} persona={reply.anonymousPersona} />
                    ) : (
                      <ProfileAvatarButton fallback={reply.authorAvatar} profileHoverContext={profileHoverContext} user={replyProfile} />
                    )}
                    <div>
                      <div className="forumAuthorNameLine">
                        {reply.anonymous ? <ForumAnonymousName name={reply.author} /> : <ProfileNameButton user={replyProfile} />}
                        {reply.source === "mcp" && <span className="forumAgentTag">{t("forum.agentTag")}</span>}
                        {reply.pinned && <PinnedBadge />}
                      </div>
                      <ForumAuthorMeta anonymous={reply.anonymous} timestamp={reply.createdAt} user={replyProfile} />
                    </div>
                  </div>
                  {reply.contributorAward && <ContributorAwardBadge award={reply.contributorAward} compact />}
                </div>
                {isEditingReply ? (
                  <form className="postEditForm replyEditForm" onSubmit={(event) => void saveReplyEdit(event, reply)}>
                    <MarkdownComposer
                      inlineAttachments={editInline.inlineAttachments}
                      maxLength={MAX_FORUM_BODY_LENGTH}
                      maxInlineAttachments={MAX_FORUM_ATTACHMENTS - editingReplyAttachments.length}
                      mentions={(discussion.mentions ?? []).filter((mention) => !mention.postId || mention.postId === reply.id)}
                      onChange={changeEditingReplyBody}
                      onInlineAttachmentsChange={editInline.replaceInlineAttachments}
                      placeholder={t("forum.replyPlaceholder")}
                      rows={4}
                      title={t("forum.replyEditorTitle", { title: discussion.title })}
                      value={editingReplyBody}
                    />
                    {visibleEditingAttachments.length > 0 && (
                      <div className="composerMediaPanel replyImagesPanel">
                        <div className="composerMediaHeader">
                          <div>
                            <strong>{t("forum.replyImages")}</strong>
                            <span>{editingAttachmentCount}</span>
                          </div>
                        </div>
                        <div className="composerAttachmentGrid">
                          {visibleEditingAttachments.map((attachment) => (
                            <div className="composerAttachment" key={attachment.id}>
                              <img alt={attachment.alt ?? attachment.fileName} src={attachment.url} />
                              <div>
                                <strong>{attachment.fileName}</strong>
                                <small>{formatBytes(attachment.fileSize)}</small>
                              </div>
                              <button
                                aria-label={t("forum.removeAttachmentAria", { name: attachment.fileName })}
                                disabled={replyEditStatus === "submitting"}
                                onClick={() => removeEditingReplyAttachment(attachment.id)}
                                type="button"
                              >
                                <XIcon size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="postEditActions">
                      <StatusText status={replyEditStatus} successText={t("forum.saved")} errorText={t("forum.couldNotSave")} />
                      <Button onClick={cancelReplyEdit} size="compact" variant="secondary">
                        {t("forum.cancel")}
                      </Button>
                      <Button disabled={!canSaveReply} iconBefore={<Check size={15} />} isLoading={replyEditStatus === "submitting"} size="compact" type="submit" variant="primary">
                        {t("forum.save")}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <>
                    {reply.body && <ForumMentionText className="forumReplyBody" discussion={discussion} postId={reply.id} value={reply.body} />}
                    {renderAttachments
                      ? renderAttachments(reply.attachments ?? [], true, reply.body)
                      : <ForumAttachmentBlocks attachments={forumStandaloneAttachments(reply.body, reply.attachments ?? [])} compact />}
                    <PostModifiedMeta actor={reply.author} createdAt={reply.createdAt} updatedAt={reply.updatedAt} />
                  </>
                )}
                <div className="replyActionRow">
                  <div className="replyPrimaryActions">
                    <ForumReactionBar
                      disabled={Boolean(likingReplyId)}
                      onReact={(reaction) => void toggleReplyReaction(reply, reaction)}
                      reactions={reply.reactions}
                      selectedReaction={reply.currentUserReaction}
                      total={reply.likes}
                      variant="card"
                    />
                  </div>
                  <div className="replyActionMenus">
                    {canManageReply && (
                      <PostActionMenu
                        disabled={Boolean(deletingReplyId) || replyEditStatus === "submitting"}
                        isDeleting={deletingReplyId === reply.id}
                        onDelete={() => void deleteReply(reply)}
                        onEdit={() => startReplyEdit(reply)}
                      />
                    )}
                    {canModerateReply && (
                      <ModeratorActionMenu
                        disabled={Boolean(deletingReplyId) || Boolean(pinningReplyId) || replyEditStatus === "submitting"}
                        isDeleting={deletingReplyId === reply.id}
                        isContributorAwarded={Boolean(reply.contributorAward)}
                        isPinned={Boolean(reply.pinned)}
                        isPinning={pinningReplyId === reply.id}
                        onAwardContributor={!canManageReply
                          ? () => setContributorAwardReplyId(reply.id)
                          : undefined}
                        onDelete={() => void deleteReply(reply)}
                        onTogglePin={() => void toggleReplyPin(reply)}
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="replyEmpty">{t("forum.noReplies")}</div>
      )}
      {!editingReplyId && (
        <form className="replyComposer" id="forum-reply-composer" onSubmit={submitReply}>
          <MarkdownComposer
            inlineAttachments={replyInline.inlineAttachments}
            maxLength={MAX_FORUM_BODY_LENGTH}
            maxInlineAttachments={MAX_FORUM_ATTACHMENTS - attachments.length}
            onChange={setBody}
            onInlineAttachmentsChange={replyInline.replaceInlineAttachments}
            placeholder={t("forum.replyPlaceholder")}
            rows={4}
            title={t("forum.replyEditorTitle", { title: discussion.title })}
            value={body}
          />
          {(attachments.length > 0 || mediaMessage) && (
            <div className="composerMediaPanel replyImagesPanel">
              <div className="composerMediaHeader">
                <div>
                  <strong>{t("forum.replyImages")}</strong>
                  <span>{replyAttachmentCount} / {MAX_FORUM_ATTACHMENTS}</span>
                </div>
                <label aria-label={t("forum.addImages")} className="attachmentPicker attachmentIconPicker" title={t("forum.addImages")}>
                  <ImagePlus size={16} />
                  <input
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    multiple
                    onChange={selectReplyImages}
                    type="file"
                  />
                </label>
              </div>
              {attachments.length > 0 && (
                <div className="composerAttachmentGrid">
                  {attachments.map((attachment) => (
                    <div className="composerAttachment" key={attachment.id}>
                      {attachment.previewUrl && <img alt={attachment.file.name} src={attachment.previewUrl} />}
                      <div>
                        <strong>{attachment.file.name}</strong>
                        <small>{formatBytes(attachment.file.size)}</small>
                      </div>
                      <button aria-label={t("forum.removeAttachmentAria", { name: attachment.file.name })} onClick={() => removeAttachment(attachment.id)} type="button">
                        <XIcon size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {mediaMessage && <p className="mediaMessage">{mediaMessage}</p>}
            </div>
          )}
          <div className="composerActions">
            <ForumAnonymousIdentityControls
              anonymous={anonymous}
              lockedPersona={lockedAnonymousPersona}
              onAnonymousChange={setAnonymous}
              onPersonaChange={setAnonymousPersona}
              persona={anonymousPersona}
              variant="reply"
            />
            <StatusText status={status} successText={t("forum.replied")} errorText={t("forum.couldNotReply")} />
            {attachments.length === 0 && !mediaMessage && (
              <label aria-label={t("forum.addImages")} className="attachmentPicker attachmentIconPicker" title={t("forum.addImages")}>
                <ImagePlus size={16} />
                <input
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  multiple
                  onChange={selectReplyImages}
                  type="file"
                />
              </label>
            )}
            <Button disabled={!canSubmit} iconBefore={<Send size={16} />} isLoading={status === "submitting"} size="compact" type="submit" variant="primary">
              {t("forum.send")}
            </Button>
          </div>
        </form>
      )}
      {contributorAwardReplyId && (() => {
        const reply = replies.find((item) => item.id === contributorAwardReplyId);
        return reply ? (
          <ContributorAwardModal
            endpoint={`/api/forum/topics/${encodeURIComponent(discussion.id)}/replies/${encodeURIComponent(reply.id)}/contributor-award`}
            onAwarded={(result) => {
              setLocalReplies((current) => current.map((item) => item.id === reply.id
                ? {
                    ...item,
                    contributorAward: result.award,
                    journeyCommunityContributionPoints: result.journeyCommunityContributionPoints,
                    journeyLevelKey: result.journeyLevelKey,
                    journeyTotalPoints: result.journeyTotalPoints
                  }
                : item));
              setContributorAwardReplyId(undefined);
              void onReplied().catch(() => undefined);
            }}
            onClose={() => setContributorAwardReplyId(undefined)}
            recipientName={reply.author}
          />
        ) : null;
      })()}
    </section>
  );
}

function orderedForumReplies(replies: ForumDiscussionReply[]) {
  return [...replies].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
    return Date.parse(left.createdAt) - Date.parse(right.createdAt);
  });
}

function uploadedAttachmentToDiscussionAttachment(attachment: {
  fileName: string;
  fileSize: number;
  mimeType: string;
  publicUrl: string;
  storageKey: string;
}): DiscussionAttachment {
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
