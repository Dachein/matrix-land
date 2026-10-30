import { UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { matePetIdFromAvatarUrl, type MatePetId, type MatePetMotion } from "../../../../src/shared/matePet";
import { useMateLocale } from "../locale";

function petAnimationUrl(id: MatePetId, motion: MatePetMotion) {
  return `/assets/mate-pet-actions/${id}/${motion}.webp`;
}

export function MateAvatar({ active = false, ambientWalk = false, avatarUrl, className = "", motion, name }: {
  active?: boolean;
  ambientWalk?: boolean;
  avatarUrl?: string;
  className?: string;
  motion?: MatePetMotion;
  name: string;
}) {
  const { text } = useMateLocale();
  const [failed, setFailed] = useState(false);
  const requestedMotion = motion ?? (active ? "running" : "idle");
  const [displayMotion, setDisplayMotion] = useState<MatePetMotion>(requestedMotion);
  useEffect(() => setFailed(false), [avatarUrl]);
  useEffect(() => {
    setDisplayMotion(requestedMotion);
    if (!["failed", "jumping", "review", "running-left", "running-right", "waving"].includes(requestedMotion)) return undefined;
    const timer = window.setTimeout(() => setDisplayMotion("idle"), 2700);
    return () => window.clearTimeout(timer);
  }, [requestedMotion]);
  const petId = failed || !avatarUrl ? "workspace-bot" : matePetIdFromAvatarUrl(avatarUrl);
  useEffect(() => {
    if (!ambientWalk || requestedMotion !== "idle" || !petId) return undefined;
    let startLeft = true;
    let returnTimer: number | undefined;
    let settleTimer: number | undefined;
    const interval = window.setInterval(() => {
      const firstMotion = startLeft ? "running-left" : "running-right";
      const secondMotion = startLeft ? "running-right" : "running-left";
      setDisplayMotion(firstMotion);
      returnTimer = window.setTimeout(() => setDisplayMotion(secondMotion), 1300);
      settleTimer = window.setTimeout(() => setDisplayMotion("idle"), 2700);
      startLeft = !startLeft;
    }, 45_000);
    return () => {
      window.clearInterval(interval);
      if (returnTimer !== undefined) window.clearTimeout(returnTimer);
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
    };
  }, [ambientWalk, petId, requestedMotion]);
  const petUrl = petId ? petAnimationUrl(petId, displayMotion) : undefined;
  return (
    <span
      aria-label={text(`${name} 头像`, `${name} avatar`)}
      className={`tm-avatar tm-mate-avatar ${className}`.trim()}
      data-avatar-motion={displayMotion}
      data-avatar-source={petId ? "workspace-pet" : "configured"}
      role="img"
    >
      <img alt="" key={`${petId || "custom"}:${displayMotion}`} onError={() => setFailed(true)} src={petUrl || avatarUrl} />
    </span>
  );
}

export function UserAvatar({ avatarUrl, className = "", name = "You" }: {
  avatarUrl?: string;
  className?: string;
  name?: string;
}) {
  const { text } = useMateLocale();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatarUrl]);
  const initials = name.trim().slice(0, 2).toUpperCase();
  return (
    <span aria-label={text(`${name} 头像`, `${name} avatar`)} className={`tm-avatar tm-user-avatar ${className}`.trim()} role="img">
      {avatarUrl && !failed
        ? <img alt="" onError={() => setFailed(true)} src={avatarUrl} />
        : initials || <UserRound aria-hidden="true" size={18} />}
    </span>
  );
}
