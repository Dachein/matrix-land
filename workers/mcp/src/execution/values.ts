import { readNumber, readString } from "../http.ts";
import { HttpError } from "../types.ts";

export function mcpToolPayload(value: unknown) {
  const result = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const content = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = content && typeof content === "object" && !Array.isArray(content)
    ? readString((content as Record<string, unknown>).text)
    : "";

  if (!text) {
    return result;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : result;
  } catch {
    return result;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function boundedLimit(value: unknown) {
  const limit = Math.round(readNumber(value, 10));
  return Math.max(1, Math.min(20, limit));
}

export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function requireArg(value: unknown, code: string) {
  const text = readString(value).trim();
  if (!text) {
    throw new HttpError(400, code);
  }
  return text.slice(0, 160);
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

export function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

export function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readRecordArray(value: unknown) {
  return Array.isArray(value) ? value.map(readRecord) : [];
}

export function readStringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => readString(item).trim()).filter(Boolean);
}

export function base64ToBytes(value: string) {
  const commaIndex = value.startsWith("data:") ? value.indexOf(",") : -1;
  const normalized = (commaIndex >= 0 ? value.slice(commaIndex + 1) : value).replace(/\s+/g, "");
  try {
    const binary = atob(normalized);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new HttpError(400, "invalid_knowledge_file_base64");
  }
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function assertHttpUrl(value: string, errorCode: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported_protocol");
    }
    return url;
  } catch {
    throw new HttpError(400, errorCode);
  }
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function shortId() {
  return crypto.randomUUID().split("-")[0];
}

export function safeJsonArray(value: unknown) {
  if (Array.isArray(value)) {
    return value;
  }
  try {
    const parsed = JSON.parse(readString(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function safeJsonRecord(value: unknown) {
  if (isRecord(value)) {
    return value;
  }

  try {
    return readRecord(JSON.parse(readString(value)));
  } catch {
    return {};
  }
}

export function splitList(value: unknown) {
  return readString(value).split(",").map((item) => item.trim()).filter(Boolean);
}
