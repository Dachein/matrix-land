import { HttpError } from "./types";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function requireText(value: unknown, code: string, maxLength: number) {
  const text = readString(value).trim();
  if (!text) {
    throw new HttpError(400, code);
  }
  return text.slice(0, maxLength);
}

export function optionalText(value: unknown, maxLength: number) {
  return readString(value).trim().slice(0, maxLength);
}

export function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text || undefined;
}

export function parseStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => readString(item)).filter(Boolean);
  }

  const text = readString(value).trim();
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => readString(item)).filter(Boolean) : [];
  } catch {
    return text.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  try {
    const parsed = JSON.parse(readString(value)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function slugify(value: unknown) {
  return readString(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function normalizeAppCode(value: unknown) {
  return slugify(value)
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function randomToken(length: number) {
  return crypto.randomUUID().replaceAll("-", "").slice(0, length);
}

export function bytesToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function hostnameFromUrl(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return value.replace(/^https?:\/\//, "").split("/")[0] ?? value;
  }
}
