import { Image, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import mateFallbackUrl from "../assets/mate-miniapp-icon.png";
import { API_BASE } from "../services/request";
import { state } from "../state";
const MATE_PET_IDS = ["workspace-bot", "codex", "dewey", "fireball", "hoots", "rocky", "seedy", "stacky", "claude-code", "null-signal"] as const;
type MatePetId = typeof MATE_PET_IDS[number];
type MatePetMotion = "idle" | "running" | "waiting";
import "./Avatar.scss";

/**
 * Avatar with a deterministic fallback.
 *
 * When a real image is configured it is preferred; `fallback` is used whenever there is no
 * avatar or the image fails to decode, so a person is never represented by an empty box or by
 * a spinner that looks like a broken image.
 *
 * Two fallback shapes are supported:
 * - a string renders as a monogram (used for the signed-in user, whose initial is a better
 *   stand-in than a generic glyph);
 * - an imported image URL renders as a placeholder tile (used for Mates, where the generic
 *   brand mark is correct).
 */
export function Avatar({ avatarUrl, className = "", fallback, fallbackClassName = "" }: {
  avatarUrl?: string;
  className?: string;
  /** Monogram text, or an image URL to show when there is no usable avatar.
      Root-relative paths ("/assets/...") are how weapp builds resolve imported
      images, so they count as image fallbacks too. */
  fallback: string;
  fallbackClassName?: string;
}) {
  const normalizedUrl = avatarUrl?.trim() || "";
  const [failedUrl, setFailedUrl] = useState("");
  const [loadedUrl, setLoadedUrl] = useState("");
  // Reset on URL change so an updated avatar gets another attempt instead of staying failed.
  useEffect(() => { setFailedUrl(""); setLoadedUrl(""); }, [normalizedUrl]);

  const configured = Boolean(normalizedUrl) && failedUrl !== normalizedUrl;
  // A monogram needs no image loading, so the dimming layer only applies to image fallbacks.
  const fallbackIsImage = /^(?:https?:|data:image\/|blob:|\/)/.test(fallback);
  const pending = configured && loadedUrl !== normalizedUrl && fallbackIsImage;
  return <View className={`avatar ${className}`.trim()}>
    {configured
      ? <Image
        className="avatar-image"
        mode="aspectFill"
        webp={/\.webp(?:$|\?)/i.test(normalizedUrl)}
        src={normalizedUrl}
        onLoad={() => setLoadedUrl(normalizedUrl)}
        onError={() => setFailedUrl(normalizedUrl)}
      />
      : fallbackIsImage
        ? <Image className="avatar-image" mode="aspectFill" src={fallback} />
        : <Text className={`avatar-monogram ${fallbackClassName}`.trim()}>{fallback}</Text>}
    {pending && <View className="avatar-pending" />}
  </View>;
}

/**
 * A Mate's avatar. The fallback is the Mate brand mark rather than the animated ping
 * GIF used previously, which read as a loading skeleton and made an unset avatar look broken.
 */
export function MateAvatar({ avatarUrl, className = "", motion }: { avatarUrl?: string; className?: string; motion?: MatePetMotion }) {
  const petId = builtInPetId(avatarUrl);
  const motionUrl = petId && motion ? `https://ai.example.invalid/assets/mate-pet-actions/${petId}/${motion}.webp` : avatarUrl;
  return <Avatar avatarUrl={motionUrl} className={className} fallback={mateFallbackUrl} />;
}

/** The Portal account avatar is private, so Image cannot fetch it without the miniapp session cookie. */
export function UserAvatar({ avatarUrl, className = "", fallback, fallbackClassName = "" }: {
  avatarUrl?: string;
  className?: string;
  fallback: string;
  fallbackClassName?: string;
}) {
  const [localUrl, setLocalUrl] = useState("");
  useEffect(() => {
    setLocalUrl("");
    if (!avatarUrl) return;
    if (!avatarUrl.startsWith("/api/users/")) { setLocalUrl(avatarUrl); return; }
    const cookie = state.getCookie();
    if (!cookie) return;
    let active = true;
    void Taro.downloadFile({ url: `${API_BASE}${avatarUrl}`, header: { cookie } }).then((result) => {
      if (active && result.statusCode === 200 && result.tempFilePath) setLocalUrl(result.tempFilePath);
    }).catch(() => {});
    return () => { active = false; };
  }, [avatarUrl]);
  return <Avatar avatarUrl={localUrl} className={className} fallback={fallback} fallbackClassName={fallbackClassName} />;
}

function builtInPetId(avatarUrl?: string): MatePetId | undefined {
  const id = avatarUrl?.match(/\/assets\/mate-pets\/([a-z-]+)\.webp(?:$|\?)/)?.[1];
  return id && MATE_PET_IDS.includes(id as MatePetId) ? id as MatePetId : undefined;
}
