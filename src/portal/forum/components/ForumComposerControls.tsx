import { ArrowLeft, Check, Loader2, Maximize2 } from "lucide-react";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { DiscussionMention } from "../../../shared/types";
import { Button } from "../../components/Button";
import { ModalShell } from "../../components/ModalShell";
import { useI18n } from "../../i18n";
import type { SubmitState, UploadedForumAttachment } from "../types";
import type { ForumMentionCandidate } from "./ForumMentionUtils";
import { ForumPlainTextEditor } from "./ForumPlainTextEditor";

const ForumBlockNoteEditor = lazy(() => import("../../components/ForumBlockNoteEditor"));

const BLOCKNOTE_DISMISSIBLE_UI_SELECTOR = [
  ".bn-suggestion-menu",
  ".bn-grid-suggestion-menu",
  ".bn-toolbar",
  ".bn-panel",
  ".bn-menu-dropdown",
  ".bn-popover-content"
].join(",");

export function MarkdownComposer({
  maxLength,
  inlineAttachments = [],
  maxInlineAttachments = 16,
  mentions = [],
  onChange,
  onInlineAttachmentsChange,
  onTitleChange,
  placeholder,
  rows,
  title,
  titlePlaceholder,
  value
}: {
  maxLength: number;
  inlineAttachments?: UploadedForumAttachment[];
  maxInlineAttachments?: number;
  mentions?: DiscussionMention[];
  onChange: (value: string) => void;
  onInlineAttachmentsChange?: (attachments: UploadedForumAttachment[]) => void;
  onTitleChange?: (title: string) => void;
  placeholder: string;
  rows: number;
  title: string;
  titlePlaceholder?: string;
  value: string;
}) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedMentions, setSelectedMentions] = useState<ForumMentionCandidate[]>([]);
  const knownMentions = useMemo(() => mergeMentionCandidates([
    ...mentions.map(candidateFromDiscussionMention),
    ...selectedMentions
  ]), [mentions, selectedMentions]);
  const commitValue = (nextValue: string) => onChange(nextValue.slice(0, maxLength));
  const expandedEditor = (
    <ModalShell
      ariaLabel={t("forum.markdownEditor")}
      header={
        <div className="markdownEditorHeaderMain">
          <Button
            aria-label={t("common.back")}
            className="markdownEditorBackButton"
            iconBefore={<ArrowLeft size={16} />}
            onClick={() => setIsExpanded(false)}
            size="compact"
          >
            {t("common.back")}
          </Button>
          <div className="markdownEditorHeaderIdentity">
            {onTitleChange ? (
              <input
                aria-label={t("forum.fieldTitle")}
                className="markdownEditorTitleInput"
                maxLength={140}
                onChange={(event) => onTitleChange(event.target.value)}
                placeholder={titlePlaceholder ?? t("forum.fieldTitle")}
                type="text"
                value={title}
              />
            ) : (
              <strong className="markdownEditorHeaderTitle" title={title}>{title}</strong>
            )}
          </div>
        </div>
      }
      headerActions={
        <Button iconBefore={<Check size={16} />} onClick={() => setIsExpanded(false)} size="compact" variant="primary">
          {t("forum.done")}
        </Button>
      }
      headerClassName="markdownEditorHeader"
      modalClassName="markdownEditorDialog"
      onClose={() => setIsExpanded(false)}
      overlayClassName="markdownEditorOverlay"
    >
      <div className="markdownEditorBody">
        <article className="markdownEditorPaper">
          <Suspense fallback={<div className="forumEditorLoading">{t("forum.loadingEditor")}</div>}>
            <ForumBlockNoteEditor
              autoFocus
              inlineAttachments={inlineAttachments}
              knownMentions={knownMentions}
              maxLength={maxLength}
              maxInlineAttachments={maxInlineAttachments}
              onChange={commitValue}
              onInlineAttachmentsChange={onInlineAttachmentsChange}
              onMentionSelected={rememberMention}
              placeholder={placeholder}
              value={value}
            />
          </Suspense>
          <span className="markdownEditorCharacterCount">
            {t("forum.editorCharacterCount", { count: value.length, max: maxLength })}
          </span>
        </article>
      </div>
    </ModalShell>
  );

  useEffect(() => {
    if (!isExpanded) {
      return undefined;
    }

    // Capture phase records whether BlockNote has transient UI to dismiss.
    // The editor then consumes Escape; a subsequent Escape closes the dialog.
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(BLOCKNOTE_DISMISSIBLE_UI_SELECTOR)) return;
      setIsExpanded(false);
    };

    document.addEventListener("keydown", closeFromKeyboard, true);
    return () => {
      document.removeEventListener("keydown", closeFromKeyboard, true);
    };
  }, [isExpanded]);

  useEffect(() => {
    if (!value) setSelectedMentions([]);
  }, [value]);

  function rememberMention(person: ForumMentionCandidate) {
    setSelectedMentions((current) => mergeMentionCandidates([...current, person]));
  }

  return (
    <div className="markdownComposer quick">
      <div className="markdownComposerToolbar">
        <button
          className="markdownExpandButton"
          onClick={() => {
            setIsExpanded(true);
          }}
          title={t("forum.openMarkdownEditor")}
          type="button"
        >
          <Maximize2 size={14} />
          <span>{t("forum.markdownEditor")}</span>
        </button>
      </div>
      {!isExpanded && (
        <ForumPlainTextEditor
          maxLength={maxLength}
          onChange={commitValue}
          onMentionSelected={rememberMention}
          placeholder={placeholder}
          rows={rows}
          value={value}
        />
      )}
      {isExpanded && createPortal(expandedEditor, document.body)}
    </div>
  );
}

function candidateFromDiscussionMention(mention: DiscussionMention): ForumMentionCandidate {
  return {
    avatarUrl: mention.avatarUrl,
    email: mention.email ?? mention.emailPrefix,
    emailPrefix: mention.emailPrefix,
    id: mention.userId,
    name: mention.name || mention.emailPrefix
  };
}

function mergeMentionCandidates(candidates: ForumMentionCandidate[]) {
  const byPrefix = new Map<string, ForumMentionCandidate>();
  candidates.forEach((candidate) => byPrefix.set(candidate.emailPrefix.toLowerCase(), candidate));
  return Array.from(byPrefix.values());
}

export function StatusText({ errorText, status, successText }: { errorText: string; status: SubmitState; successText: string }) {
  const { t } = useI18n();

  if (status === "idle") {
    return <span className="statusText" />;
  }

  return (
    <span className={`statusText ${status}`}>
      {status === "submitting" && <Loader2 className="spinIcon" size={14} />}
      {status === "success" && <Check size={14} />}
      {status === "error" ? errorText : status === "success" ? successText : t("forum.working")}
    </span>
  );
}
