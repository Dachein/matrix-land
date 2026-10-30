import { X } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent
} from "react";
import { hashText, personInitials, personPalette } from "./shared/visualIdentity";

export type PeopleMentionCandidate = {
  avatarUrl?: string;
  email?: string;
  emailPrefix?: string;
  id: string;
  name: string;
};

export type PeopleMentionPickerProps = {
  ariaLabel: string;
  candidates: PeopleMentionCandidate[];
  className?: string;
  disabled?: boolean;
  emptySelectionText?: string;
  emptyText?: string;
  maxSuggestions?: number;
  onChange: (selectedIds: string[]) => void;
  placeholder?: string;
  readOnly?: boolean;
  removePersonLabel?: (person: PeopleMentionCandidate) => string;
  selectedIds: string[];
  showSuggestionsOnEmptyQuery?: boolean;
  singleSelect?: boolean;
  suggestionsPlacement?: "auto" | "below";
  suggestionsLabel?: string;
};

const DEFAULT_MAX_SUGGESTIONS = 8;

/**
 * A reusable, controlled people picker for co-authoring, sharing, and invite flows.
 * It accepts either a plain name/email query or an @-prefixed mention query.
 */
export function PeopleMentionPicker({
  ariaLabel,
  candidates,
  className = "",
  disabled = false,
  emptySelectionText,
  emptyText = "No people found",
  maxSuggestions = DEFAULT_MAX_SUGGESTIONS,
  onChange,
  placeholder = "@ Add people",
  readOnly = false,
  removePersonLabel = (person) => `Remove ${person.name}`,
  selectedIds,
  showSuggestionsOnEmptyQuery = true,
  singleSelect = false,
  suggestionsPlacement = "auto",
  suggestionsLabel = ariaLabel
}: PeopleMentionPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const listboxId = `${generatedId}-people`;
  const [activeIndex, setActiveIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [opensUpward, setOpensUpward] = useState(false);
  const [query, setQuery] = useState("");
  const candidateById = useMemo(() => new Map(uniquePeople(candidates).map((person) => [person.id, person])), [candidates]);
  const selectedPeople = useMemo(
    () => selectedIds.map((id) => candidateById.get(id) ?? unknownPerson(id)),
    [candidateById, selectedIds]
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const suggestions = useMemo(
    () => peopleMentionSuggestions(candidates, selectedSet, query, maxSuggestions),
    [candidates, maxSuggestions, query, selectedSet]
  );
  const safeActiveIndex = suggestions.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), suggestions.length - 1);
  const activePerson = safeActiveIndex >= 0 ? suggestions[safeActiveIndex] : undefined;
  const isInteractive = !readOnly && !disabled;
  const hasSearchQuery = normalizePeopleQuery(query).length > 0;
  const suggestionsOpen = isOpen && isInteractive && (showSuggestionsOnEmptyQuery || hasSearchQuery);

  useEffect(() => {
    if (suggestions.length === 0) {
      setActiveIndex(0);
      return;
    }

    setActiveIndex((current) => Math.min(Math.max(current, 0), suggestions.length - 1));
  }, [suggestions.length]);

  useEffect(() => {
    if (!suggestionsOpen || suggestionsPlacement === "below" || !rootRef.current) {
      setOpensUpward(false);
      return;
    }

    const updatePlacement = () => {
      const root = rootRef.current;
      if (!root) return;
      const rootBox = root.getBoundingClientRect();
      const boundary = nearestClippingBoundary(root);
      const estimatedListHeight = Math.min(264, Math.max(54, suggestions.length * 46 + 10));
      const availableBelow = boundary.bottom - rootBox.bottom - 6;
      const availableAbove = rootBox.top - boundary.top - 6;
      setOpensUpward(availableBelow < estimatedListHeight && availableAbove > availableBelow);
    };

    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [suggestions.length, suggestionsOpen, suggestionsPlacement]);

  function addPerson(person: PeopleMentionCandidate) {
    if (!isInteractive || selectedSet.has(person.id)) {
      return;
    }

    onChange(singleSelect ? [person.id] : [...selectedIds, person.id]);
    setQuery("");
    setActiveIndex(0);
    setIsOpen(false);
    inputRef.current?.focus();
  }

  function removePerson(id: string) {
    if (!isInteractive) {
      return;
    }

    onChange(selectedIds.filter((selectedId) => selectedId !== id));
    inputRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) {
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!showSuggestionsOnEmptyQuery && !hasSearchQuery) {
        return;
      }
      event.preventDefault();
      setIsOpen(true);

      if (suggestions.length > 0) {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((current) => (current + direction + suggestions.length) % suggestions.length);
      }
      return;
    }

    if (event.key === "Enter" && suggestionsOpen && activePerson) {
      event.preventDefault();
      addPerson(activePerson);
      return;
    }

    if (event.key === "Escape" && suggestionsOpen) {
      event.preventDefault();
      setIsOpen(false);
      return;
    }

    if (event.key === "Backspace" && query.length === 0 && selectedIds.length > 0) {
      event.preventDefault();
      removePerson(selectedIds[selectedIds.length - 1]);
    }
  }

  function focusInputFromSurface(event: MouseEvent<HTMLDivElement>) {
    if (isInteractive && !(event.target as HTMLElement).closest("button")) {
      inputRef.current?.focus();
    }
  }

  const rootClasses = [
    "peopleMentionPicker",
    suggestionsOpen ? "open" : "",
    opensUpward ? "opensUpward" : "",
    readOnly ? "readOnly" : "",
    disabled ? "disabled" : "",
    className
  ].filter(Boolean).join(" ");

  return (
    <div className={rootClasses} ref={rootRef}>
      <div
        aria-disabled={disabled || undefined}
        aria-label={!isInteractive ? ariaLabel : undefined}
        className="peopleMentionInputSurface"
        onClick={focusInputFromSurface}
        role={!isInteractive ? "group" : undefined}
      >
        {selectedPeople.map((person) => (
          <PeopleMentionChip
            key={person.id}
            onRemove={isInteractive ? () => removePerson(person.id) : undefined}
            person={person}
            removeLabel={removePersonLabel(person)}
          />
        ))}

        {!isInteractive && selectedPeople.length === 0 && emptySelectionText && (
          <span className="peopleMentionEmptySelection">{emptySelectionText}</span>
        )}

        {isInteractive && (
          <input
            aria-activedescendant={suggestionsOpen && activePerson ? optionId(generatedId, activePerson.id) : undefined}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={suggestionsOpen}
            aria-label={ariaLabel}
            autoComplete="off"
            className="peopleMentionInput"
            onBlur={() => setIsOpen(false)}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
              setIsOpen(showSuggestionsOnEmptyQuery || normalizePeopleQuery(event.target.value).length > 0);
            }}
            onFocus={() => setIsOpen(showSuggestionsOnEmptyQuery || hasSearchQuery)}
            onKeyDown={handleKeyDown}
            placeholder={selectedPeople.length === 0 ? placeholder : ""}
            ref={inputRef}
            role="combobox"
            value={query}
          />
        )}
      </div>

      {suggestionsOpen && (
        <div aria-label={suggestionsLabel} className="peopleMentionSuggestions" id={listboxId} role="listbox">
          {suggestions.length > 0 ? suggestions.map((person, index) => (
            <button
              aria-selected="false"
              className={index === safeActiveIndex ? "peopleMentionOption active" : "peopleMentionOption"}
              id={optionId(generatedId, person.id)}
              key={person.id}
              onClick={() => addPerson(person)}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              role="option"
              type="button"
            >
              <PeopleMentionIdentity person={person} />
            </button>
          )) : (
            <div className="peopleMentionEmpty">{emptyText}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function peopleMentionSuggestions(
  candidates: PeopleMentionCandidate[],
  selectedIds: ReadonlySet<string>,
  query: string,
  maxSuggestions = DEFAULT_MAX_SUGGESTIONS
) {
  const normalizedQuery = normalizePeopleQuery(query);
  const availablePeople = uniquePeople(candidates).filter((person) => !selectedIds.has(person.id));
  const matches = normalizedQuery
    ? availablePeople
      .map((person, index) => ({ index, person, score: personMatchScore(person, normalizedQuery) }))
      .filter((match) => match.score >= 0)
      .sort((left, right) => left.score - right.score || left.index - right.index)
      .map((match) => match.person)
    : availablePeople;

  return matches.slice(0, Math.max(0, Math.floor(maxSuggestions)));
}

export function PeopleMentionChip({
  className = "",
  onClick,
  onRemove,
  person,
  removeLabel = `Remove ${person.name}`
}: {
  className?: string;
  onClick?: () => void;
  onRemove?: () => void;
  person: PeopleMentionCandidate;
  removeLabel?: string;
}) {
  const content = (
    <>
      <PeopleMentionIdentity person={person} />
      {onRemove && <X aria-hidden="true" className="peopleMentionRemoveIcon" size={12} />}
    </>
  );

  const handleClick = onRemove ?? onClick;
  const classes = ["peopleMentionTag", !onRemove ? "readOnly" : "", className].filter(Boolean).join(" ");

  return handleClick ? (
    <button
      aria-label={onRemove ? removeLabel : person.name}
      className={classes}
      onClick={handleClick}
      title={onRemove ? removeLabel : person.name}
      type="button"
    >
      {content}
    </button>
  ) : (
    <span className={classes}>{content}</span>
  );
}

export function PeopleMentionIdentity({ person }: { person: PeopleMentionCandidate }) {
  return (
    <span className="peopleMentionIdentity">
      <PeopleMentionAvatar person={person} />
      <span className="peopleMentionName">{person.name || person.email || person.id}</span>
    </span>
  );
}

function PeopleMentionAvatar({ person }: { person: PeopleMentionCandidate }) {
  const [imageFailed, setImageFailed] = useState(false);
  const identity = person.name || person.email || person.id;
  const palette = personPalette(hashText(identity));
  const style = {
    "--avatar-a": palette.a,
    "--avatar-b": palette.b,
    "--avatar-ink": palette.ink
  } as CSSProperties;

  useEffect(() => setImageFailed(false), [person.avatarUrl]);

  return (
    <span aria-hidden="true" className="peopleMentionAvatar" style={style}>
      {person.avatarUrl && !imageFailed
        ? <img alt="" onError={() => setImageFailed(true)} src={person.avatarUrl} />
        : personInitials(identity)}
    </span>
  );
}

function normalizePeopleQuery(value: string) {
  return normalizeSearchText(value.trim().replace(/^@+\s*/, ""));
}

function normalizeSearchText(value: string) {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

function personMatchScore(person: PeopleMentionCandidate, query: string) {
  const name = normalizeSearchText(person.name);
  const email = normalizeSearchText(person.email ?? "");
  const nameWords = name.split(/\s+/).filter(Boolean);

  if (name === query || email === query) return 0;
  if (name.startsWith(query)) return 1;
  if (nameWords.some((word) => word.startsWith(query))) return 2;
  if (email.startsWith(query)) return 3;
  if (name.includes(query)) return 4;
  if (email.includes(query)) return 5;
  return -1;
}

function uniquePeople(candidates: PeopleMentionCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((person) => {
    if (!person.id || seen.has(person.id)) {
      return false;
    }
    seen.add(person.id);
    return true;
  });
}

function unknownPerson(id: string): PeopleMentionCandidate {
  return { id, name: id };
}

function optionId(rootId: string, personId: string) {
  return `${rootId}-person-${encodeURIComponent(personId).replace(/%/g, "-")}`;
}

function nearestClippingBoundary(element: HTMLElement) {
  let parent = element.parentElement;
  let top = 0;
  let bottom = window.innerHeight;

  while (parent) {
    const style = window.getComputedStyle(parent);
    if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowY}`)) {
      const parentBox = parent.getBoundingClientRect();
      top = Math.max(top, parentBox.top);
      bottom = Math.min(bottom, parentBox.bottom);
    }
    parent = parent.parentElement;
  }

  return { bottom, top };
}
