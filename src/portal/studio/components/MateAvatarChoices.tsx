import { useEffect, useState } from "react";
import { MATE_PET_MOTIONS, MATE_PET_OPTIONS, matePetIdFromAvatarUrl, randomMatePetAvatarUrl, type MatePetMotion, type MatePetOption } from "../../../shared/matePet";
import type { PortalCatalog } from "../../../shared/types";
import { useI18n } from "../../i18n";
import { appsApiFetch } from "../apiClient";
import { useRandomMateMotion } from "./useRandomMateMotion";
import "./MateAvatarChoices.css";

function toAvatarChoice(option: MatePetOption) {
  return {
    avatarUrl: new URL(option.avatarUrl).pathname,
    key: option.id,
    motions: Object.fromEntries(MATE_PET_MOTIONS.map((motion) => [motion, new URL(option.motions[motion]).pathname])) as Record<MatePetMotion, string>,
    nameEn: option.nameEn,
    nameZh: option.nameZh,
    savedUrl: option.avatarUrl
  };
}

export const MATE_AVATARS = MATE_PET_OPTIONS.map(toAvatarChoice);

export function defaultMateAvatarUrl() {
  return MATE_AVATARS[0].savedUrl;
}

export function randomMateAvatarUrl() {
  return randomMatePetAvatarUrl();
}

export function mateAvatarPreviewUrl(value: string) {
  return matePetIdFromAvatarUrl(value) ? "" : value;
}

function MateAvatarMotionImage({ avatar, failed, onError }: { avatar: (typeof MATE_AVATARS)[number]; failed: boolean; onError: () => void }) {
  const motionIndex = useRandomMateMotion();
  return <img alt="" className={failed ? "isAnimatedFallback" : ""} onError={onError} src={failed ? avatar.avatarUrl : avatar.motions[MATE_PET_MOTIONS[motionIndex]]} />;
}

export function MateAvatarChoices({ catalog, onChange, value }: { catalog: PortalCatalog; onChange: (avatarUrl: string) => void; value: string }) {
  const { locale, t } = useI18n();
  const [choices, setChoices] = useState(MATE_AVATARS);
  const [expanded, setExpanded] = useState(false);
  const [failedAnimations, setFailedAnimations] = useState<Record<string, boolean>>({});
  const selectedPetId = matePetIdFromAvatarUrl(value) ?? "workspace-bot";
  const selectedAvatar = choices.find((avatar) => avatar.key === selectedPetId);

  useEffect(() => {
    const controller = new AbortController();
    void appsApiFetch<{ avatars: MatePetOption[] }>("/mates/avatar-options", catalog, { signal: controller.signal })
      .then((payload) => {
        if (!controller.signal.aborted && Array.isArray(payload.avatars) && payload.avatars.length > 0) {
          setChoices(payload.avatars.map(toAvatarChoice));
        }
      })
      .catch(() => { /* The bundled catalog remains available while offline. */ });
    return () => controller.abort();
  }, [catalog]);

  return (
    <div className="mateAvatarChoices">
      <div className="mateAvatarChoicesCurrent">
        {selectedAvatar && <MateAvatarMotionImage avatar={selectedAvatar} failed={Boolean(failedAnimations[selectedAvatar.key])} key={selectedAvatar.key} onError={() => setFailedAnimations((current) => ({ ...current, [selectedAvatar.key]: true }))} />}
        <button aria-expanded={expanded} className="mateAvatarChoicesToggle" onClick={() => setExpanded((current) => !current)} type="button">
          {t("apps.mate.avatarChange")}
        </button>
      </div>
      {expanded && <div aria-label={t("apps.mate.avatarChoices")} className="mateAvatarChoicesViewport">
        <div className="mateAvatarChoicesRow">
          {choices.map((avatar) => (
            <button
              aria-label={t("apps.mate.chooseAvatar", { name: locale === "zh-CN" ? avatar.nameZh : avatar.nameEn })}
              aria-pressed={selectedPetId === avatar.key}
              className={`mateAvatarChoice${selectedPetId === avatar.key ? " selected" : ""}`}
              key={avatar.key}
              onClick={() => { onChange(avatar.savedUrl); setExpanded(false); }}
              title={locale === "zh-CN" ? avatar.nameZh : avatar.nameEn}
              type="button"
            >
              <MateAvatarMotionImage avatar={avatar} failed={Boolean(failedAnimations[avatar.key])} onError={() => setFailedAnimations((current) => ({ ...current, [avatar.key]: true }))} />
              <span>{locale === "zh-CN" ? avatar.nameZh : avatar.nameEn}</span>
            </button>
          ))}
        </div>
      </div>}
    </div>
  );
}
