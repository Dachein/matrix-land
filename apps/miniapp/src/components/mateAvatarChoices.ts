import workspaceBot from "../assets/mate-pets/workspace-bot.webp";
import codex from "../assets/mate-pets/codex.webp";
import dewey from "../assets/mate-pets/dewey.webp";
import fireball from "../assets/mate-pets/fireball.webp";
import hoots from "../assets/mate-pets/hoots.webp";
import rocky from "../assets/mate-pets/rocky.webp";
import seedy from "../assets/mate-pets/seedy.webp";
import stacky from "../assets/mate-pets/stacky.webp";
import claudeCode from "../assets/mate-pets/claude-code.webp";
import nullSignal from "../assets/mate-pets/null-signal.webp";
import { requestJson, USE_MOCKS } from "../services/request";

const ASSET_ORIGIN = "https://ai.example.invalid";

export const MATE_AVATAR_CHOICES = [
  { id: "workspace-bot", previewUrl: workspaceBot },
  { id: "codex", previewUrl: codex },
  { id: "dewey", previewUrl: dewey },
  { id: "fireball", previewUrl: fireball },
  { id: "hoots", previewUrl: hoots },
  { id: "rocky", previewUrl: rocky },
  { id: "seedy", previewUrl: seedy },
  { id: "stacky", previewUrl: stacky },
  { id: "claude-code", previewUrl: claudeCode },
  { id: "null-signal", previewUrl: nullSignal }
].map((choice) => ({
  ...choice,
  savedUrl: `${ASSET_ORIGIN}/assets/mate-pets/${choice.id}.webp`
}));

export async function loadMateAvatarChoices() {
  if (USE_MOCKS) return MATE_AVATAR_CHOICES;
  const payload = await requestJson<{ avatars: Array<{ avatarUrl: string; id: string }> }>({
    url: "/api/miniapp/v1/mates/avatar-options"
  });
  const previews = new Map(MATE_AVATAR_CHOICES.map((choice) => [choice.id, choice.previewUrl]));
  const choices = payload.avatars
    .filter((choice) => previews.has(choice.id) && /^https:\/\//.test(choice.avatarUrl))
    .map((choice) => ({ id: choice.id, previewUrl: previews.get(choice.id)!, savedUrl: choice.avatarUrl }));
  return choices.length > 0 ? choices : MATE_AVATAR_CHOICES;
}

export function mateAvatarChoiceForUrl(url: string, choices = MATE_AVATAR_CHOICES) {
  return choices.find((choice) => choice.savedUrl === url);
}

export function animatedMateAvatarUrl(avatarUrl?: string) {
  if (!avatarUrl) return "";
  const path = avatarUrl.trim().replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/, 1)[0];
  const match = path.match(/^\/assets\/mate-pets\/([a-z-]+)\.(?:webp|svg)$/);
  const id = match?.[1];
  return id && MATE_AVATAR_CHOICES.some((choice) => choice.id === id)
    ? `${ASSET_ORIGIN}/assets/mate-pet-actions/${id}/idle.webp`
    : "";
}

export function randomMateAvatarUrl() {
  return MATE_AVATAR_CHOICES[Math.floor(Math.random() * MATE_AVATAR_CHOICES.length)].savedUrl;
}
