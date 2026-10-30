import { Award, Check, Loader2, MoreHorizontal, Pencil, Pin, PinOff, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../i18n";

export function PostActionMenu({
  disabled = false,
  isDeleting = false,
  onDelete,
  onEdit
}: {
  disabled?: boolean;
  isDeleting?: boolean;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div
      className="postActionMenu"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsOpen(false);
        }
      }}
    >
      <button
        aria-expanded={isOpen}
        aria-label={t("forum.openPostActions")}
        className="postActionMenuButton"
        disabled={disabled}
        onClick={() => setIsOpen((current) => !current)}
        title={t("forum.moreActions")}
        type="button"
      >
        {isDeleting ? <Loader2 className="spinIcon" size={15} /> : <MoreHorizontal size={16} />}
      </button>
      {isOpen && (
        <div className="postActionMenuPopover">
          <button
            onClick={() => {
              setIsOpen(false);
              onEdit();
            }}
            type="button"
          >
            <Pencil size={14} />
            {t("forum.edit")}
          </button>
          <button
            className="danger"
            onClick={() => {
              setIsOpen(false);
              onDelete();
            }}
            type="button"
          >
            {isDeleting ? <Loader2 className="spinIcon" size={14} /> : <Trash2 size={14} />}
            {t("forum.delete")}
          </button>
        </div>
      )}
    </div>
  );
}

export function ModeratorActionMenu({
  disabled = false,
  isDeleting = false,
  isContributorAwarded = false,
  isPinned,
  isPinning = false,
  onAwardContributor,
  onDelete,
  onTogglePin
}: {
  disabled?: boolean;
  isDeleting?: boolean;
  isContributorAwarded?: boolean;
  isPinned: boolean;
  isPinning?: boolean;
  onAwardContributor?: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div
      className="postActionMenu moderator"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsOpen(false);
      }}
    >
      <button
        aria-expanded={isOpen}
        aria-label={t("forum.openAdminActions")}
        className="postActionMenuButton moderator"
        disabled={disabled}
        onClick={() => setIsOpen((current) => !current)}
        title={t("forum.adminActions")}
        type="button"
      >
        {isDeleting || isPinning ? <Loader2 className="spinIcon" size={15} /> : <ShieldCheck size={16} />}
      </button>
      {isOpen && (
        <div className="postActionMenuPopover">
          {onAwardContributor && (
            <button
              className="contributorAwardAction"
              disabled={isContributorAwarded}
              onClick={() => { setIsOpen(false); onAwardContributor(); }}
              type="button"
            >
              {isContributorAwarded ? <Check size={14} /> : <Award size={14} />}
              {t(isContributorAwarded ? "forum.contributorAwarded" : "forum.contributorAward")}
            </button>
          )}
          <button onClick={() => { setIsOpen(false); onTogglePin(); }} type="button">
            {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
            {isPinned ? t("forum.unpin") : t("forum.pin")}
          </button>
          <button className="danger" onClick={() => { setIsOpen(false); onDelete(); }} type="button">
            {isDeleting ? <Loader2 className="spinIcon" size={14} /> : <Trash2 size={14} />}
            {t("forum.delete")}
          </button>
        </div>
      )}
    </div>
  );
}

export function PinnedBadge() {
  const { t } = useI18n();
  return <span className="forumPinnedBadge"><Pin aria-hidden="true" size={11} />{t("forum.pinned")}</span>;
}

export function PostModifiedMeta({ actor, createdAt, updatedAt }: { actor: string; createdAt?: string; updatedAt?: string }) {
  const { t } = useI18n();
  const label = modifiedPostLabel(actor, createdAt, updatedAt, t);

  return label ? <div className="postModifiedMeta">{label}</div> : null;
}

function modifiedPostLabel(actor: string, createdAt: string | undefined, updatedAt: string | undefined, t: ReturnType<typeof useI18n>["t"]) {
  const updatedMs = timestampMs(updatedAt);

  if (!updatedMs) {
    return "";
  }

  const createdMs = timestampMs(createdAt);

  if (createdMs && Math.abs(updatedMs - createdMs) < 1000) {
    return "";
  }

  const diffMs = Math.max(0, Date.now() - updatedMs);

  if (diffMs < 60_000) {
    return t("forum.modifiedJustNow", { actor });
  }

  if (diffMs < 3_600_000) {
    const minutes = Math.max(1, Math.floor(diffMs / 60_000));
    return t("forum.modifiedMinutes", { actor, count: minutes });
  }

  if (diffMs < 86_400_000) {
    const hours = Math.max(1, Math.floor(diffMs / 3_600_000));
    return t("forum.modifiedHours", { actor, count: hours });
  }

  const updated = new Date(updatedMs);
  const dateLabel = `${String(updated.getMonth() + 1).padStart(2, "0")}/${String(updated.getDate()).padStart(2, "0")}`;
  return t("forum.modifiedDate", { actor, date: dateLabel });
}

function timestampMs(value?: string) {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed) ? `${trimmed.replace(" ", "T")}Z` : trimmed;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
