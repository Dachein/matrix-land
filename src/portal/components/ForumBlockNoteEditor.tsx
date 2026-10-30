import { BlockNoteSchema, createHeadingBlockSpec, defaultBlockSpecs, defaultInlineContentSpecs, filterSuggestionItems } from "@blocknote/core";
import { en, zh, type Dictionary } from "@blocknote/core/locales";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { FileText, Image as ImageIcon, Loader2, RefreshCw, X } from "lucide-react";
import {
  BasicTextStyleButton,
  BlockTypeSelect,
  CreateLinkButton,
  FormattingToolbar,
  FormattingToolbarController,
  getDefaultReactSlashMenuItems,
  NestBlockButton,
  SuggestionMenuController,
  UnnestBlockButton,
  useCreateBlockNote,
  type DefaultReactSuggestionItem
} from "@blocknote/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeBrowserAttachmentMime, uploadForumAttachments } from "../forum/attachments";
import { MAX_FORUM_ATTACHMENT_BYTES } from "../forum/config";
import { forumInlineMediaUrls } from "../forum/markdown";
import type { UploadedForumAttachment } from "../forum/types";
import {
  forumMentionInlineContentSpec,
  ForumMentionAvatar
} from "../forum/components/ForumMentionInlineContent";
import {
  mentionPropsForCandidate,
  resolveMentionsInBlocks,
  searchForumMentionCandidates,
  type ForumMentionCandidate
} from "../forum/components/ForumMentionUtils";
import { useI18n, type Locale } from "../i18n";

type ForumBlockNoteEditorProps = {
  autoFocus?: boolean;
  knownMentions?: ForumMentionCandidate[];
  maxLength: number;
  onChange: (value: string) => void;
  inlineAttachments?: UploadedForumAttachment[];
  maxInlineAttachments?: number;
  onInlineAttachmentsChange?: (attachments: UploadedForumAttachment[]) => void;
  onMentionSelected?: (person: ForumMentionCandidate) => void;
  placeholder: string;
  value: string;
};

const forumEditorSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    // Notion-style constraint: only H1-H3 are offered, keeping posts visually
    // consistent. Toggleable headings are disabled: they only collapse content
    // inside the editor and export as plain headings anyway.
    heading: createHeadingBlockSpec({ allowToggleHeadings: false, levels: [1, 2, 3] })
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    mention: forumMentionInlineContentSpec
  }
});

export default function ForumBlockNoteEditor({
  autoFocus = false,
  knownMentions = [],
  inlineAttachments = [],
  maxLength,
  maxInlineAttachments = 16,
  onChange,
  onInlineAttachmentsChange,
  onMentionSelected,
  placeholder,
  value
}: ForumBlockNoteEditorProps) {
  const { locale, t } = useI18n();
  const initialValueRef = useRef(value);
  const lastEmittedValueRef = useRef(value);
  const suppressChangeRef = useRef(false);
  const inlineAttachmentsRef = useRef(inlineAttachments);
  const maxInlineAttachmentsRef = useRef(maxInlineAttachments);
  const pendingInlineAttachmentsRef = useRef<UploadedForumAttachment[]>([]);
  const mentionSearchTokenRef = useRef(0);
  const candidatesByPrefixRef = useRef<ReadonlyMap<string, ForumMentionCandidate>>(new Map());
  const onMentionSelectedRef = useRef(onMentionSelected);
  const onInlineAttachmentsChangeRef = useRef(onInlineAttachmentsChange);
  const uploadNoticeTimerRef = useRef<number | undefined>(undefined);
  const [uploadNotice, setUploadNotice] = useState<InlineUploadNotice>();
  candidatesByPrefixRef.current = useMemo(
    () => new Map(knownMentions.map((person) => [person.emailPrefix.toLowerCase(), person])),
    [knownMentions]
  );
  onMentionSelectedRef.current = onMentionSelected;
  inlineAttachmentsRef.current = inlineAttachments;
  maxInlineAttachmentsRef.current = maxInlineAttachments;
  onInlineAttachmentsChangeRef.current = onInlineAttachmentsChange;

  const clearUploadNotice = useCallback(() => {
    if (uploadNoticeTimerRef.current) window.clearTimeout(uploadNoticeTimerRef.current);
    uploadNoticeTimerRef.current = undefined;
    setUploadNotice((current) => {
      if (current?.previewUrl) URL.revokeObjectURL(current.previewUrl);
      return undefined;
    });
  }, []);

  const uploadFile = useCallback(async (file: File, blockId?: string) => {
    if (uploadNoticeTimerRef.current) window.clearTimeout(uploadNoticeTimerRef.current);
    const controller = new AbortController();
    const mimeType = normalizeBrowserAttachmentMime(file);
    const previewUrl = mimeType?.startsWith("image/") ? URL.createObjectURL(file) : undefined;
    const uploadCount = deduplicateUploads([
      ...inlineAttachmentsRef.current,
      ...pendingInlineAttachmentsRef.current
    ]).length;

    setUploadNotice((current) => {
      if (current?.previewUrl) URL.revokeObjectURL(current.previewUrl);
      return {
        blockId,
        controller,
        file,
        mimeType,
        previewUrl,
        status: "uploading"
      };
    });

    if (!mimeType || file.size <= 0 || file.size > MAX_FORUM_ATTACHMENT_BYTES || uploadCount >= maxInlineAttachmentsRef.current) {
      setUploadNotice((current) => current ? { ...current, status: "error" } : current);
      return { props: { name: file.name, url: "" } };
    }

    try {
      const [uploaded] = await uploadForumAttachments([{
        file,
        id: crypto.randomUUID(),
        kind: mimeType.startsWith("image/") ? "image" : "file",
        mimeType,
        previewUrl
      }], controller.signal);

      if (!uploaded) throw new Error("missing_uploaded_forum_file");

      pendingInlineAttachmentsRef.current = deduplicateUploads([
        ...pendingInlineAttachmentsRef.current,
        uploaded
      ]);
      onInlineAttachmentsChangeRef.current?.(deduplicateUploads([
        ...inlineAttachmentsRef.current,
        ...pendingInlineAttachmentsRef.current
      ]));
      setUploadNotice((current) => current ? { ...current, status: "success" } : current);
      uploadNoticeTimerRef.current = window.setTimeout(clearUploadNotice, 900);
      return { props: { name: uploaded.fileName, url: uploaded.publicUrl } };
    } catch {
      if (controller.signal.aborted) {
        clearUploadNotice();
      } else {
        setUploadNotice((current) => current ? { ...current, status: "error" } : current);
      }
      return { props: { name: file.name, url: "" } };
    }
  }, [clearUploadNotice]);

  const editor = useCreateBlockNote({
    schema: forumEditorSchema,
    dictionary: forumEditorDictionary(locale, placeholder),
    uploadFile
  });

  useEffect(() => clearUploadNotice, [clearUploadNotice]);

  useEffect(() => {
    const initialValue = initialValueRef.current;
    if (initialValue) {
      replaceEditorMarkdown(initialValue);
    }
    if (autoFocus) {
      editor.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useEffect(() => {
    if (value === lastEmittedValueRef.current) return;
    replaceEditorMarkdown(value);
  }, [editor, value]);

  const syncInlineAttachments = useCallback((markdown: string) => {
    const inlineUrls = forumInlineMediaUrls(markdown);
    const next = deduplicateUploads([
      ...inlineAttachmentsRef.current,
      ...pendingInlineAttachmentsRef.current
    ]).filter((attachment) => inlineUrls.has(attachment.publicUrl));

    if (!sameUploads(next, inlineAttachmentsRef.current)) {
      onInlineAttachmentsChangeRef.current?.(next);
    }
  }, []);

  const handleChange = useCallback(() => {
    if (suppressChangeRef.current) return;

    const markdown = normalizeForumEditorMarkdown(editor.blocksToMarkdownLossy());
    if (markdown.length > maxLength) {
      suppressChangeRef.current = true;
      editor.undo();
      suppressChangeRef.current = false;
      syncInlineAttachments(normalizeForumEditorMarkdown(editor.blocksToMarkdownLossy()));
      return;
    }

    lastEmittedValueRef.current = markdown;
    onChange(markdown);
    syncInlineAttachments(markdown);
  }, [editor, maxLength, onChange, syncInlineAttachments]);

  const getSlashMenuItems = useCallback(
    async (query: string) => filterSuggestionItems(getDefaultReactSlashMenuItems(editor), query),
    [editor]
  );

  const getMentionItems = useCallback(async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const token = ++mentionSearchTokenRef.current;
    await new Promise((resolve) => window.setTimeout(resolve, 160));
    if (token !== mentionSearchTokenRef.current) return [];

    let people: ForumMentionCandidate[] = [];
    try {
      people = await searchForumMentionCandidates(query);
    } catch {
      people = [];
    }
    if (token !== mentionSearchTokenRef.current) return [];

    return people.map((person) => ({
      title: person.name || person.emailPrefix,
      subtext: person.email,
      icon: <ForumMentionAvatar person={person} />,
      onItemClick: () => {
        editor.insertInlineContent([
          { type: "mention", props: mentionPropsForCandidate(person) },
          " "
        ], { updateSelection: true });
        onMentionSelectedRef.current?.(person);
      }
    }));
  }, [editor]);

  function replaceEditorMarkdown(markdown: string) {
    suppressChangeRef.current = true;
    const blocks = resolveMentionsInBlocks(
      editor.tryParseMarkdownToBlocks(markdown),
      candidatesByPrefixRef.current
    );
    editor.replaceBlocks(editor.document, blocks);
    suppressChangeRef.current = false;
    lastEmittedValueRef.current = markdown;
  }

  async function retryUpload() {
    if (!uploadNotice || uploadNotice.status !== "error") return;
    const result = await uploadFile(uploadNotice.file, uploadNotice.blockId);
    const url = typeof result === "string" ? result : String(result.props?.url ?? "");
    if (url && uploadNotice.blockId && editor.getBlock(uploadNotice.blockId)) {
      editor.updateBlock(uploadNotice.blockId, result);
    }
  }

  function cancelUpload() {
    const blockId = uploadNotice?.blockId;
    uploadNotice?.controller.abort();
    clearUploadNotice();
    // Let BlockNote finish its aborted upload callback before removing the
    // placeholder; otherwise its final update would target a missing block.
    window.setTimeout(() => {
      if (blockId && editor.getBlock(blockId)) editor.removeBlocks([blockId]);
    }, 0);
  }

  return (
    <>
      <BlockNoteView
      aria-label={t("forum.postBody")}
      className="forumBlockNoteEditor"
      editor={editor}
      emojiPicker={false}
      formattingToolbar={false}
      onChange={handleChange}
      sideMenu
      slashMenu={false}
      theme="light"
      >
      {/* Underline and text color are intentionally omitted: neither can be
          represented in Markdown, so they would silently vanish on publish. */}
      <FormattingToolbarController
        formattingToolbar={() => (
          <FormattingToolbar>
            <BlockTypeSelect key="blockTypeSelect" />
            <BasicTextStyleButton basicTextStyle="bold" key="boldStyleButton" />
            <BasicTextStyleButton basicTextStyle="italic" key="italicStyleButton" />
            <BasicTextStyleButton basicTextStyle="strike" key="strikeStyleButton" />
            <BasicTextStyleButton basicTextStyle="code" key="codeStyleButton" />
            <CreateLinkButton key="createLinkButton" />
            <NestBlockButton key="nestBlockButton" />
            <UnnestBlockButton key="unnestBlockButton" />
          </FormattingToolbar>
        )}
      />
      <SuggestionMenuController triggerCharacter="/" getItems={getSlashMenuItems} />
      <SuggestionMenuController triggerCharacter="@" getItems={getMentionItems} minQueryLength={0} />
      </BlockNoteView>
      {uploadNotice && (
        <div aria-live="polite" className={`forumInlineUploadNotice ${uploadNotice.status}`}>
          {uploadNotice.previewUrl
            ? <img alt="" src={uploadNotice.previewUrl} />
            : <span className="forumInlineUploadFile"><FileText size={20} /></span>}
          <span className="forumInlineUploadIcon">
            {uploadNotice.status === "uploading"
              ? <Loader2 className="spinIcon" size={16} />
              : uploadNotice.mimeType?.startsWith("image/") ? <ImageIcon size={16} /> : <FileText size={16} />}
          </span>
          <span className="forumInlineUploadCopy">
            <strong>{uploadNotice.status === "uploading"
              ? t(uploadNotice.mimeType?.startsWith("image/") ? "forum.imageUploading" : "forum.fileUploading")
              : uploadNotice.status === "success"
                ? t(uploadNotice.mimeType?.startsWith("image/") ? "forum.imageUploaded" : "forum.fileUploaded")
                : t(uploadNotice.mimeType?.startsWith("image/") ? "forum.imageUploadFailed" : "forum.fileUploadFailed")}</strong>
            <small>{uploadNotice.file.name}</small>
          </span>
          {uploadNotice.status === "error" && (
            <button
              aria-label={t(uploadNotice.mimeType?.startsWith("image/") ? "forum.retryImageUpload" : "forum.retryFileUpload")}
              onClick={() => void retryUpload()}
              title={t(uploadNotice.mimeType?.startsWith("image/") ? "forum.retryImageUpload" : "forum.retryFileUpload")}
              type="button"
            >
              <RefreshCw size={15} />
            </button>
          )}
          {uploadNotice.status !== "success" && (
            <button
              aria-label={t(uploadNotice.mimeType?.startsWith("image/") ? "forum.cancelImageUpload" : "forum.cancelFileUpload")}
              onClick={cancelUpload}
              title={t(uploadNotice.mimeType?.startsWith("image/") ? "forum.cancelImageUpload" : "forum.cancelFileUpload")}
              type="button"
            >
              <X size={15} />
            </button>
          )}
        </div>
      )}
    </>
  );
}

type InlineUploadNotice = {
  blockId?: string;
  controller: AbortController;
  file: File;
  mimeType?: string;
  previewUrl?: string;
  status: "uploading" | "success" | "error";
};

function deduplicateUploads(attachments: UploadedForumAttachment[]) {
  return Array.from(new Map(attachments.map((attachment) => [attachment.storageKey, attachment])).values());
}

function sameUploads(left: UploadedForumAttachment[], right: UploadedForumAttachment[]) {
  return left.length === right.length && left.every((attachment, index) => attachment.storageKey === right[index]?.storageKey);
}

function normalizeForumEditorMarkdown(value: string) {
  return value.replace(/\n+$/g, "");
}

function forumEditorDictionary(locale: Locale, placeholder: string): Dictionary {
  const base = locale === "en" ? en : zh;
  if (!placeholder) return base;

  return {
    ...base,
    placeholders: {
      ...base.placeholders,
      default: placeholder
    }
  };
}
