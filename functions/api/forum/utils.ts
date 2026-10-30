export const MAX_FORUM_BODY_CHARS = 8000;

export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function readNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}
