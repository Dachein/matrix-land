import { AppWindow, ImagePlus, Loader2, Paperclip, Send, ServerCog, X as XIcon } from "lucide-react";
import type { CSSProperties } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { Discussion, DiscussionLinkEmbed } from "../../../shared/types";
import { Button } from "../../components/Button";
import { WorkspaceListbox } from "../../components/WorkspaceListbox";
import { FormField, TextInput } from "../../components/FormField";
import { useI18n } from "../../i18n";
import { forumDiscussionFromPayload } from "../apiClient";
import { FORUM_CATEGORY_DEFINITIONS, MAX_FORUM_ATTACHMENTS, MAX_FORUM_BODY_LENGTH, type ForumCategorySlug, type ForumTopicTypeValue } from "../config";
import { fileLabel, normalizeBrowserAttachmentMime, uploadForumAttachments } from "../attachments";
import { normalizeSingleLink } from "../composerUtils";
import { formatBytes } from "../formatters";
import { localizedForumLabel } from "../labels";
import { useForumInlineAttachments } from "../useForumInlineAttachments";
import { MarkdownComposer, StatusText } from "./ForumComposerControls";
import { ForumLinkEmbed } from "./ForumRichBlocks";
import { ForumAnonymousIdentityControls } from "./ForumAnonymousIdentity";
import type { ForumListedItemAttachment, LinkPreviewState, PendingForumAttachment, SubmitState } from "../types";
import { randomForumAnonymousPersona, type ForumAnonymousPersona } from "../forumAnonymousIdentity";

export function ForumTopicComposer({
  linkedItem,
  onCancel,
  onCreated
}: {
  linkedItem?: ForumListedItemAttachment;
  onCancel: () => void;
  onCreated: (discussion: Discussion) => Promise<void>;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [link, setLink] = useState("");
  const [linkPreview, setLinkPreview] = useState<DiscussionLinkEmbed | undefined>();
  const [linkPreviewStatus, setLinkPreviewStatus] = useState<LinkPreviewState>("idle");
  const [attachments, setAttachments] = useState<PendingForumAttachment[]>([]);
  const [activeLinkedItem, setActiveLinkedItem] = useState<ForumListedItemAttachment | undefined>(linkedItem);
  const [mediaMessage, setMediaMessage] = useState("");
  const [categorySlug, setCategorySlug] = useState<ForumCategorySlug>(linkedItem ? "platform-help" : "ai-exploration");
  const [topicType, setTopicType] = useState<ForumTopicTypeValue>(linkedItem ? "question" : "");
  const [status, setStatus] = useState<SubmitState>("idle");
  const [anonymous, setAnonymous] = useState(false);
  const [anonymousPersona, setAnonymousPersona] = useState<ForumAnonymousPersona>(() => randomForumAnonymousPersona());
  const {
    commitInlineAttachments,
    discardInlineAttachments,
    inlineAttachments,
    replaceInlineAttachments
  } = useForumInlineAttachments();
  const previewUrls = useRef<string[]>([]);
  const parsedLink = normalizeSingleLink(link);
  const totalAttachmentCount = attachments.length + inlineAttachments.length;
  const hasContent = body.trim().length > 0 || totalAttachmentCount > 0 || Boolean(parsedLink) || Boolean(activeLinkedItem);
  const canSubmit = title.trim().length > 0 && hasContent && status !== "submitting";
  const titlePlaceholder = activeLinkedItem
    ? t("forum.linkedQuestionTitle", { name: activeLinkedItem.label })
    : t("forum.titlePlaceholder");

  useEffect(() => {
    setActiveLinkedItem(linkedItem);

    if (!linkedItem) {
      return;
    }

    setCategorySlug("platform-help");
    setTopicType("question");
  }, [linkedItem, t]);

  useEffect(() => {
    return () => {
      previewUrls.current.forEach((previewUrl) => URL.revokeObjectURL(previewUrl));
      previewUrls.current = [];
    };
  }, []);

  useEffect(() => {
    const url = normalizeSingleLink(link);

    if (!url) {
      setLinkPreview(undefined);
      setLinkPreviewStatus("idle");
      return undefined;
    }

    const controller = new AbortController();
    setLinkPreviewStatus("loading");

    const timeoutId = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/forum/link-preview?url=${encodeURIComponent(url)}`, {
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error("link_preview_failed");
        }

        const payload = await response.json() as { preview?: Omit<DiscussionLinkEmbed, "id"> };

        if (!payload.preview) {
          throw new Error("missing_link_preview");
        }

        setLinkPreview({ id: "composer-link-preview", ...payload.preview });
        setLinkPreviewStatus("ready");
      } catch (error) {
        if (!controller.signal.aborted) {
          setLinkPreview(undefined);
          setLinkPreviewStatus("error");
        }
      }
    }, 450);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [link]);

  function selectAttachments(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";

    if (selectedFiles.length === 0) {
      return;
    }

    const availableSlots = MAX_FORUM_ATTACHMENTS - totalAttachmentCount;
    const accepted: PendingForumAttachment[] = [];
    let rejected = 0;

    selectedFiles.slice(0, Math.max(availableSlots, 0)).forEach((file) => {
      const mimeType = normalizeBrowserAttachmentMime(file);

      if (!mimeType) {
        rejected += 1;
        return;
      }

      const previewUrl = mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined;

      if (previewUrl) {
        previewUrls.current.push(previewUrl);
      }

      accepted.push({
        id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
        file,
        previewUrl,
        kind: mimeType.startsWith("image/") ? "image" : "file",
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
        ? t("forum.filesSkipped", { count: rejected })
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

  async function submitTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) {
      return;
    }

    setStatus("submitting");

    try {
      const uploadedAttachments = attachments.length > 0 ? await uploadForumAttachments(attachments) : [];
      const linkedPayload = activeLinkedItem ? linkedItemPayload(activeLinkedItem, t) : {};
      const response = await fetch("/api/forum/topics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          body,
          categorySlug,
          topicType: topicType || undefined,
          tags: [],
          links: parsedLink ? [parsedLink] : [],
          attachments: [...uploadedAttachments, ...inlineAttachments],
          anonymous,
          anonymousPersona: anonymous ? anonymousPersona : undefined,
          ...linkedPayload
        })
      });

      if (!response.ok) {
        throw new Error("create_topic_failed");
      }

      const discussion = forumDiscussionFromPayload(await response.json());
      setStatus("success");
      clearAttachmentPreviews();
      commitInlineAttachments();
      await onCreated(discussion);
    } catch {
      setStatus("error");
    }
  }

  return (
    <form className="forumComposer" onSubmit={submitTopic}>
      <div className="forumComposerGrid">
        <FormField className="titleField" label={t("forum.fieldTitle")}>
          <TextInput
            maxLength={140}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={titlePlaceholder}
            value={title}
          />
        </FormField>
        <FormField label={t("forum.category")}>
          <WorkspaceListbox<ForumCategorySlug>
            ariaLabel={t("forum.category")}
            value={categorySlug}
            onChange={setCategorySlug}
            options={FORUM_CATEGORY_DEFINITIONS.map((category) => ({
              label: localizedForumLabel(category, t),
              searchText: category.slug,
              value: category.slug
            }))}
          />
        </FormField>
      </div>
      <div className="forumEditorField">
        <span>{t("forum.fieldPost")}</span>
        <MarkdownComposer
          inlineAttachments={inlineAttachments}
          maxLength={MAX_FORUM_BODY_LENGTH}
          maxInlineAttachments={MAX_FORUM_ATTACHMENTS - attachments.length}
          onChange={setBody}
          onInlineAttachmentsChange={replaceInlineAttachments}
          onTitleChange={setTitle}
          placeholder={t("forum.writeUpdatePlaceholder")}
          rows={6}
          title={title}
          titlePlaceholder={titlePlaceholder}
          value={body}
        />
      </div>
      {activeLinkedItem && (
        <div className="composerLinkedItemPanel">
          <LinkedItemLogo item={activeLinkedItem} />
          <div>
            <small>{t("forum.linkedItemAttachment")} / {linkedTypeLabel(activeLinkedItem.type, t)}</small>
            <strong>{activeLinkedItem.label}</strong>
            <p>{activeLinkedItem.description || activeLinkedItem.category || activeLinkedItem.owner}</p>
          </div>
          <button aria-label={t("forum.removeLinkedItem")} onClick={() => setActiveLinkedItem(undefined)} type="button">
            <XIcon size={14} />
          </button>
        </div>
      )}
      <FormField label={t("forum.link")}>
        <TextInput
          maxLength={1200}
          onChange={(event) => setLink(event.target.value.replace(/[\r\n]+/g, " "))}
          placeholder={t("forum.linkPlaceholder")}
          value={link}
        />
      </FormField>
      {(linkPreviewStatus !== "idle" || linkPreview) && (
        <div className="composerLinkPreview">
          {linkPreviewStatus === "loading" && (
            <span className="linkPreviewStatus">
              <Loader2 className="spinIcon" size={14} />
              {t("forum.readingLinkPreview")}
            </span>
          )}
          {linkPreviewStatus === "error" && (
            <span className="linkPreviewStatus error">{t("forum.linkPreviewError")}</span>
          )}
          {linkPreview && linkPreviewStatus !== "loading" && <ForumLinkEmbed embed={linkPreview} />}
        </div>
      )}
      {(attachments.length > 0 || mediaMessage) && (
        <div className="composerMediaPanel">
          <div className="composerMediaHeader">
            <div>
              <strong>{t("forum.mediaFiles")}</strong>
              <span>{totalAttachmentCount} / {MAX_FORUM_ATTACHMENTS}</span>
            </div>
            <label aria-label={t("forum.addMediaFiles")} className="attachmentPicker attachmentIconPicker" title={t("forum.addMediaFiles")}>
              <ImagePlus size={16} />
              <input
                accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/markdown,text/x-markdown,text/html,.md,.markdown,.html,.htm,.pdf"
                multiple
                onChange={selectAttachments}
                type="file"
              />
            </label>
          </div>
          {attachments.length > 0 && (
            <div className="composerAttachmentGrid">
              {attachments.map((attachment) => (
                <div className="composerAttachment" key={attachment.id}>
                  {attachment.kind === "image" && attachment.previewUrl ? (
                    <img alt={attachment.file.name} src={attachment.previewUrl} />
                  ) : (
                    <span>
                      <Paperclip size={18} />
                      {fileLabel(attachment.mimeType)}
                    </span>
                  )}
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
          onAnonymousChange={setAnonymous}
          onPersonaChange={setAnonymousPersona}
          persona={anonymousPersona}
          variant="publish"
        />
        <StatusText status={status} successText={t("forum.posted")} errorText={t("forum.couldNotPost")} />
        {attachments.length === 0 && !mediaMessage && (
          <label aria-label={t("forum.addMediaFiles")} className="attachmentPicker attachmentIconPicker" title={t("forum.addMediaFiles")}>
            <ImagePlus size={16} />
            <input
              accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/markdown,text/x-markdown,text/html,.md,.markdown,.html,.htm,.pdf"
              multiple
              onChange={selectAttachments}
              type="file"
            />
          </label>
        )}
        <Button onClick={() => {
          discardInlineAttachments();
          onCancel();
        }} size="compact" variant="secondary">{t("forum.cancel")}</Button>
        <Button disabled={!canSubmit} iconBefore={<Send size={16} />} isLoading={status === "submitting"} size="compact" type="submit" variant="primary">
          {t("forum.publish")}
        </Button>
      </div>
    </form>
  );
}

function linkedItemPayload(item: ForumListedItemAttachment, t: ReturnType<typeof useI18n>["t"]) {
  const contentPlugins = [{
    actionLabel: item.type === "app" ? t("forum.openLinkedApp") : t("forum.viewLinkedItem"),
    category: item.category,
    description: item.description,
    iconUrl: item.iconUrl?.trim().toLowerCase().startsWith("data:") ? undefined : item.iconUrl,
    installs: item.installs,
    owner: item.owner,
    pluginType: "app_card",
    targetId: item.id,
    targetType: item.type,
    title: item.label
  }];

  return {
    contentPlugins
  };
}

function linkedTypeLabel(type: ForumListedItemAttachment["type"], t: ReturnType<typeof useI18n>["t"]) {
  if (type === "app") {
    return t("market.apps");
  }

  return type === "skill" ? t("market.skills") : t("market.apps");
}

function LinkedItemLogo({ item }: { item: ForumListedItemAttachment }) {
  const iconUrl = item.iconUrl?.trim();
  const [imageFailed, setImageFailed] = useState(false);
  const palette = linkedItemPalette(hashText(`${item.type}:${item.id}:${item.label}:${item.category ?? ""}`));
  const style = {
    "--linked-item-icon-a": palette.a,
    "--linked-item-icon-b": palette.b,
    "--linked-item-icon-ink": palette.ink
  } as CSSProperties;

  useEffect(() => {
    setImageFailed(false);
  }, [iconUrl]);

  return (
    <span className={`composerLinkedItemIcon ${item.type}`} style={style}>
      {iconUrl && !imageFailed ? (
        <img alt="" onError={() => setImageFailed(true)} src={iconUrl} />
      ) : item.type === "mcp" ? (
        <ServerCog size={19} />
      ) : item.type === "app" ? (
        <AppWindow size={19} />
      ) : (
        <strong>{linkedItemInitials(item.label)}</strong>
      )}
    </span>
  );
}

function linkedItemInitials(name: string) {
  const words = name
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }

  if (words[0]) {
    return words[0].slice(0, 2).toUpperCase();
  }

  return Array.from(name.trim()).filter((char) => char.trim()).slice(0, 2).join("") || "SH";
}

function linkedItemPalette(hash: number) {
  const palettes = [
    { a: "#eff97f", b: "#b5d657", ink: "#0f1710" },
    { a: "#ff7a3d", b: "#ef4d2f", ink: "#ffffff" },
    { a: "#8fd0ff", b: "#6baee6", ink: "#10233a" },
    { a: "#7447ff", b: "#5c2ee8", ink: "#ffffff" },
    { a: "#111513", b: "#030605", ink: "#ffffff" },
    { a: "#e8f5ff", b: "#d6ecff", ink: "#1686c7" },
    { a: "#ffdf8a", b: "#ffc95c", ink: "#402800" },
    { a: "#34d7a8", b: "#12a982", ink: "#06261e" }
  ];

  return palettes[hash % palettes.length];
}

function hashText(value: string) {
  let hash = 0;

  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return hash;
}
