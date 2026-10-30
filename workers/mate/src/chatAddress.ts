import { RuntimeHttpError } from "./types.ts";

export const MATE_CHAT_INSTANCE_PREFIX = "mate-chat-";

export type MateChatMode = "live" | "preview";

export type MateChatAddress = {
  conversationId: string;
  mode: MateChatMode;
  mateId: string;
  userId: string;
};

export type MateChatRouteAddress = Pick<MateChatAddress, "conversationId" | "mode" | "mateId">;

const ADDRESS_LIMITS = {
  conversationId: 128,
  releaseId: 180,
  mateId: 180,
  userId: 180
} as const;

export function normalizeMateChatAddress(value: unknown): MateChatAddress {
  const source = record(value);
  const route = normalizeMateChatRouteAddress(source);
  return {
    ...route,
    userId: boundedIdentifier(source.userId, "userId", ADDRESS_LIMITS.userId)
  };
}

export function normalizeMateChatRouteAddress(value: unknown): MateChatRouteAddress {
  const source = record(value);
  if (source.mode !== "live" && source.mode !== "preview") {
    throw new RuntimeHttpError(422, "mate_chat_mode_invalid");
  }
  return {
    conversationId: boundedIdentifier(source.conversationId, "conversationId", ADDRESS_LIMITS.conversationId),
    mode: source.mode,
    mateId: boundedIdentifier(source.mateId, "mateId", ADDRESS_LIMITS.mateId)
  };
}

export async function mateChatInstanceName(value: unknown) {
  const source = record(value);
  const address = normalizeMateChatAddress(source);
  const coordinate = [
    address.mateId,
    address.userId,
    address.mode,
    address.conversationId,
    ...(address.mode === "preview"
      ? [boundedIdentifier(source.releaseId, "releaseId", ADDRESS_LIMITS.releaseId)]
      : [])
  ].join("\u0000");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(coordinate)));
  return `${MATE_CHAT_INSTANCE_PREFIX}${base64Url(digest)}`;
}

function boundedIdentifier(value: unknown, field: keyof typeof ADDRESS_LIMITS, maximum: number) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new RuntimeHttpError(422, "mate_chat_address_invalid", { field });
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function base64Url(value: Uint8Array) {
  let binary = "";
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
