import { Loader2 } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { PeopleMentionIdentity } from "../../components/PeopleMentionPicker";
import { useI18n } from "../../i18n";
import {
  searchForumMentionCandidates,
  type ForumMentionCandidate
} from "./ForumMentionUtils";

type ForumPlainTextEditorProps = {
  autoFocus?: boolean;
  maxLength: number;
  onChange: (value: string) => void;
  onMentionSelected?: (person: ForumMentionCandidate) => void;
  placeholder: string;
  rows: number;
  value: string;
};

type MentionQuery = {
  end: number;
  query: string;
  start: number;
};

const MENTION_QUERY_PATTERN = /(^|[\s([{"'，。！？、:：;；])@([a-zA-Z0-9._-]{0,64})$/;

/**
 * Lightweight plain-text composer used as the default writing surface.
 * Markdown formatting is intentionally not rendered here; typing `@` still
 * opens the people picker and inserts a plain `@prefix` mention.
 */
export function ForumPlainTextEditor({
  autoFocus = false,
  maxLength,
  onChange,
  onMentionSelected,
  placeholder,
  rows,
  value
}: ForumPlainTextEditorProps) {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const searchTokenRef = useRef(0);
  const onMentionSelectedRef = useRef(onMentionSelected);
  onMentionSelectedRef.current = onMentionSelected;

  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null);
  const [suggestions, setSuggestions] = useState<ForumMentionCandidate[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const queryText = mentionQuery?.query ?? null;
  const menuOpen = mentionQuery !== null;

  useEffect(() => {
    if (pendingCaretRef.current === null) return;
    const caret = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    }
  }, [value]);

  useEffect(() => {
    if (queryText === null) {
      setSuggestions([]);
      setIsSearching(false);
      return undefined;
    }

    const token = ++searchTokenRef.current;
    setIsSearching(true);
    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const people = await searchForumMentionCandidates(queryText);
          if (token !== searchTokenRef.current) return;
          setSuggestions(people);
          setActiveIndex(0);
          setIsSearching(false);
        } catch {
          if (token !== searchTokenRef.current) return;
          setSuggestions([]);
          setIsSearching(false);
        }
      })();
    }, 160);

    return () => window.clearTimeout(timeoutId);
  }, [queryText]);

  function syncMentionQuery() {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const caret = textarea.selectionStart ?? 0;
    if (caret !== textarea.selectionEnd) {
      setMentionQuery(null);
      return;
    }

    const match = textarea.value.slice(0, caret).match(MENTION_QUERY_PATTERN);
    if (!match) {
      setMentionQuery(null);
      return;
    }

    const start = (match.index ?? 0) + match[1].length;
    setMentionQuery({ start, end: caret, query: match[2] });
  }

  function selectMention(person: ForumMentionCandidate) {
    if (!mentionQuery) return;

    const insertText = `@${person.emailPrefix} `;
    const nextValue = value.slice(0, mentionQuery.start) + insertText + value.slice(mentionQuery.end);
    pendingCaretRef.current = mentionQuery.start + insertText.length;
    setMentionQuery(null);
    onMentionSelectedRef.current?.(person);
    onChange(nextValue.slice(0, maxLength));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!menuOpen || event.nativeEvent.isComposing) return;

    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, suggestions.length - 1));
      return;
    }

    if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }

    if ((event.key === "Enter" || event.key === "Tab") && suggestions[activeIndex]) {
      event.preventDefault();
      selectMention(suggestions[activeIndex]);
      return;
    }

    if (event.key === "Escape") {
      event.stopPropagation();
      setMentionQuery(null);
    }
  }

  return (
    <div className="forumPlainTextEditor">
      <textarea
        aria-label={t("forum.postBody")}
        autoFocus={autoFocus}
        className="forumPlainTextArea"
        maxLength={maxLength}
        onBlur={() => setMentionQuery(null)}
        onChange={(event) => {
          onChange(event.target.value);
          syncMentionQuery();
        }}
        onClick={syncMentionQuery}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) syncMentionQuery();
        }}
        placeholder={placeholder}
        ref={textareaRef}
        rows={rows}
        style={{ minHeight: `${Math.max(118, rows * 24 + 24)}px` }}
        value={value}
      />
      {menuOpen && (
        <div aria-label={t("forum.companyMembers")} className="peopleMentionSuggestions forumPlainTextMentions" role="listbox">
          {suggestions.map((person, index) => (
            <button
              aria-selected={activeIndex === index}
              className={activeIndex === index ? "peopleMentionOption active" : "peopleMentionOption"}
              key={person.id || person.emailPrefix}
              onClick={() => selectMention(person)}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              role="option"
              type="button"
            >
              <PeopleMentionIdentity person={person} />
            </button>
          ))}
          {suggestions.length === 0 && (
            <div className="peopleMentionEmpty">
              {isSearching
                ? <><Loader2 className="spinIcon" size={14} /> {t("forum.searchingMembers")}</>
                : t("forum.noMatchingMember")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
