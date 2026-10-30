import { ArrowRight, Bot, Check, ChevronRight, Mail, MessageCircleMore, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MATE_PET_MOTIONS, matePetIdFromAvatarUrl, matePetMotionUrl, type MatePetId } from "../../../shared/matePet";
import type { Mate } from "../../../shared/mate";
import { RelativeTime, SectionHeader } from "../../components/ui";
import { useI18n } from "../../i18n";
import { useRandomMateMotion } from "./useRandomMateMotion";

export function AppsMateList({
  kindFilter,
  onQuickCreate,
  onSelect,
  query,
  mates
}: {
  kindFilter: "all" | "apps" | "skills" | "mates";
  onQuickCreate: () => void;
  onSelect: (mate: Mate) => void;
  query: string;
  mates: Mate[];
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const visible = useMemo(() => {
    if (kindFilter !== "all" && kindFilter !== "mates") return [];
    const normalized = query.trim().toLowerCase();
    return mates.filter((mate) => !normalized || `${mate.displayName} ${mate.jobRole} ${mate.description} ${mate.workEmail ?? ""}`.toLowerCase().includes(normalized));
  }, [kindFilter, query, mates]);
  if (kindFilter !== "all" && kindFilter !== "mates") return null;
  return (
    <section className="panel appsProductPanel appsMatePanel">
      <SectionHeader
        action={<button className="appsMateCollapse" onClick={() => setExpanded((value) => !value)} type="button">{expanded ? t("apps.mate.hide") : t("apps.mate.show")}</button>}
        eyebrow={t("apps.mate.listEyebrow")}
        title={t("apps.mate.listTitle")}
      />
      {expanded && <div className="appsProductList">
        {visible.map((mate) => (
          <article className="appsProductRow clickable" key={mate.id} onClick={() => onSelect(mate)} role="button" tabIndex={0}>
            <MateAvatar mate={mate} />
            <div className="appsProductMain"><div><strong>{mate.displayName}</strong><span className="appsProductKind">{t("apps.mate.kind")}</span></div><p>{mate.jobRole}</p><small>{mate.workEmail}</small></div>
            <div className="appsProductStatus"><span className={`statusBadge ${mate.status}`}>{t(`apps.mate.status.${mate.status}`)}</span><small><RelativeTime value={mate.updatedAt} fallback={mate.updatedAt} /></small></div>
            <ChevronRight className="appsProductChevron" size={18} />
          </article>
        ))}
        {visible.length === 0 && (mates.length === 0 && !query.trim() ? (
          <div className="appsMateEmptyGuide">
            <div className="appsMateEmptyIcon"><Bot size={24} /><Sparkles size={13} /></div>
            <div className="appsMateEmptyCopy">
              <p className="eyebrow">Workspace Bot</p>
              <h3>{t("apps.mate.emptyGuideTitle")}</h3>
              <p>{t("apps.mate.emptyGuideDescription")}</p>
              <ul>
                <li><Check size={13} />{t("apps.mate.emptyGuidePermissions")}</li>
                <li><MessageCircleMore size={13} />{t("apps.mate.emptyGuideWeixin")}</li>
                <li><Mail size={13} />{t("apps.mate.emptyGuideEmail")}</li>
              </ul>
            </div>
            <button className="appsMateEmptyCta" onClick={onQuickCreate} type="button">
              <span>{t("apps.mate.emptyGuideAction")}</span><ArrowRight size={16} />
            </button>
          </div>
        ) : <div className="emptyState">{t("apps.mate.empty")}</div>)}
      </div>}
    </section>
  );
}

function MateAvatar({ mate }: { mate: Mate }) {
  const motionIndex = useRandomMateMotion();
  const [imageFailed, setImageFailed] = useState(false);
  const avatarUrl = mate.avatarUrl?.trim();
  const petId = matePetIdFromAvatarUrl(avatarUrl);
  const fallbackId: MatePetId = "workspace-bot";
  const displayId = petId ?? (avatarUrl ? undefined : fallbackId);
  const motion = MATE_PET_MOTIONS[motionIndex];
  const animationUrl = displayId ? new URL(matePetMotionUrl(imageFailed ? fallbackId : displayId, motion)).pathname : "";
  useEffect(() => {
    setImageFailed(false);
  }, [avatarUrl]);
  return (
    <span className="appsProductIcon mate">
      {displayId
        ? <img alt="" onError={() => setImageFailed(true)} src={animationUrl} />
        : avatarUrl && !imageFailed
          ? <img alt="" onError={() => setImageFailed(true)} src={avatarUrl} />
          : <img alt="" onError={() => setImageFailed(true)} src={new URL(matePetMotionUrl(fallbackId, motion)).pathname} />}
    </span>
  );
}
