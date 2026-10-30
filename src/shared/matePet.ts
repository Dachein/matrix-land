export const MATE_PET_IDS = [
  "workspace-bot",
  "codex",
  "dewey",
  "fireball",
  "hoots",
  "rocky",
  "seedy",
  "stacky",
  "claude-code",
  "null-signal"
] as const;

export type MatePetId = typeof MATE_PET_IDS[number];

export const MATE_PET_MOTIONS = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review"
] as const;

export type MatePetMotion = typeof MATE_PET_MOTIONS[number];

const ASSET_PARSE_ORIGIN = "https://assets.invalid";

const PET_NAMES: Record<MatePetId, { en: string; zh: string }> = {
  "workspace-bot": { en: "Workspace Bot", zh: "Workspace Bot" },
  codex: { en: "Codex", zh: "Codex" },
  dewey: { en: "Dewey", zh: "Dewey" },
  fireball: { en: "Fireball", zh: "Fireball" },
  hoots: { en: "Hoots", zh: "Hoots" },
  rocky: { en: "Rocky", zh: "Rocky" },
  seedy: { en: "Seedy", zh: "Seedy" },
  stacky: { en: "Stacky", zh: "Stacky" },
  "claude-code": { en: "Claude Code", zh: "Claude Code" },
  "null-signal": { en: "Null Signal", zh: "Null Signal" }
};

export function matePetAvatarUrl(id: MatePetId) {
  return `/assets/mate-pets/${id}.webp`;
}

export function matePetMotionUrl(id: MatePetId, motion: MatePetMotion) {
  return `/assets/mate-pet-actions/${id}/${motion}.webp`;
}

export const MATE_PET_OPTIONS = MATE_PET_IDS.map((id) => ({
  avatarUrl: matePetAvatarUrl(id),
  id,
  motions: Object.fromEntries(MATE_PET_MOTIONS.map((motion) => [motion, matePetMotionUrl(id, motion)])) as Record<MatePetMotion, string>,
  nameEn: PET_NAMES[id].en,
  nameZh: PET_NAMES[id].zh
}));

export type MatePetOption = typeof MATE_PET_OPTIONS[number];

export function randomMatePetAvatarUrl() {
  const random = typeof crypto !== "undefined" && "getRandomValues" in crypto
    ? crypto.getRandomValues(new Uint32Array(1))[0]
    : Math.floor(Math.random() * 0x100000000);
  return MATE_PET_OPTIONS[random % MATE_PET_OPTIONS.length].avatarUrl;
}

const PET_IDS = new Set<string>(MATE_PET_IDS);

export function matePetIdFromAvatarUrl(avatarUrl?: string): MatePetId | undefined {
  if (!avatarUrl) return undefined;
  try {
    const url = new URL(avatarUrl, ASSET_PARSE_ORIGIN);
    const match = url.pathname.match(/^\/assets\/mate-pets\/([a-z-]+)\.(?:webp|svg)$/);
    return match && PET_IDS.has(match[1]) ? match[1] as MatePetId : undefined;
  } catch {
    return undefined;
  }
}
