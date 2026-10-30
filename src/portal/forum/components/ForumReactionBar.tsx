import { SmilePlus } from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";
import type { DiscussionReaction } from "../../../shared/types";
import { useI18n } from "../../i18n";
import {
  FORUM_REACTION_DEFINITIONS,
  type ForumReactionValue
} from "../config";
import { formatCompactCount } from "../formatters";

export function ForumReactionBar({
  disabled = false,
  onReact,
  reactions,
  selectedReaction,
  total = 0,
  variant = "default"
}: {
  disabled?: boolean;
  onReact: (reaction: ForumReactionValue) => void;
  reactions?: DiscussionReaction[];
  selectedReaction?: string;
  total?: number;
  variant?: "card" | "default";
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const reactionActionLabel = selectedReaction ? t("forum.changeReaction") : t("forum.addReaction");
  const counts = reactionCountMap(reactions, total);
  const visibleReactions = FORUM_REACTION_DEFINITIONS
    .map((reaction) => ({ ...reaction, count: counts.get(reaction.value) ?? 0, label: t(reaction.labelKey) }))
    .filter((reaction) => reaction.count > 0);

  function chooseReaction(reaction: ForumReactionValue) {
    onReact(reaction);
    setMenuOpen(false);
  }

  return (
    <div
      className={`forumReactionBar ${variant === "card" ? "compact" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setMenuOpen(false);
        }
      }}
      role="group"
      aria-label={t("forum.reactionsAria")}
    >
      {visibleReactions.length > 0 && (
        <div className="forumReactionChips" aria-label={t("forum.reactionSummaryAria")}>
          {visibleReactions.map((reaction) => {
            return (
              <span
                className={selectedReaction === reaction.value ? "forumReactionChip active" : "forumReactionChip"}
                key={reaction.value}
                style={reactionStyle(reaction)}
                title={reaction.label}
              >
                <img alt="" aria-hidden="true" src={reaction.iconSrc} />
                <strong>{formatCompactCount(reaction.count)}</strong>
              </span>
            );
          })}
        </div>
      )}

      <div className="forumReactionPicker">
        <button
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label={reactionActionLabel}
          className={selectedReaction ? "forumReactionAction active" : "forumReactionAction"}
          disabled={disabled}
          onClick={() => setMenuOpen((open) => !open)}
          title={reactionActionLabel}
          type="button"
        >
          <SmilePlus aria-hidden="true" size={variant === "card" ? 13 : 15} strokeWidth={2.4} />
        </button>

        {menuOpen && (
          <div className="forumReactionMenu" role="menu">
            {FORUM_REACTION_DEFINITIONS.map((reaction) => {
              const count = counts.get(reaction.value) ?? 0;
              const active = selectedReaction === reaction.value;
              const label = t(reaction.labelKey);

              return (
                <button
                  aria-pressed={active}
                  className={active ? "forumReactionOption active" : "forumReactionOption"}
                  disabled={disabled}
                  key={reaction.value}
                  onClick={() => chooseReaction(reaction.value)}
                  role="menuitemradio"
                  style={reactionStyle(reaction)}
                  title={label}
                  type="button"
                >
                  <img alt="" aria-hidden="true" src={reaction.iconSrc} />
                  <span>{label}</span>
                  {count > 0 && <strong>{formatCompactCount(count)}</strong>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function reactionCountMap(reactions: DiscussionReaction[] | undefined, total = 0) {
  const counts = new Map<string, number>();

  reactions?.forEach((reaction) => {
    counts.set(reaction.reaction, reaction.count);
  });

  if (counts.size === 0 && total > 0) {
    counts.set("thumbsup", total);
  }

  return counts;
}

function reactionStyle(reaction: Pick<(typeof FORUM_REACTION_DEFINITIONS)[number], "background" | "color">) {
  return {
    "--reaction-bg": reaction.background,
    "--reaction-color": reaction.color
  } as CSSProperties;
}
