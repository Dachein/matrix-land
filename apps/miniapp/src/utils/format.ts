/** Shared display formatting for conversations and messages. */
import { translate, type Language } from "../services/i18n";

export function conversationTimestamp(value?: string) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function newestFirst<T extends { updatedAt?: string }>(items: T[]) {
  return [...items].sort((left, right) => conversationTimestamp(right.updatedAt) - conversationTimestamp(left.updatedAt));
}

export function relativeTime(value?: string, language?: Language) {
  if (!value) return "";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return translate("common.justNow", {}, language);
  if (minutes < 60) return translate("common.minutesAgo", { count: minutes }, language);
  const hours = Math.round(minutes / 60);
  return hours < 24 ? translate("common.hoursAgo", { count: hours }, language) : translate("common.daysAgo", { count: Math.round(hours / 24) }, language);
}

export function shortModel(value?: string) {
  if (!value) return translate("common.defaultModel");
  return value.split(/[-/]/).slice(-3).join(" ");
}

export function summarize(value: unknown) {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    return text.length > 180 ? `${text.slice(0, 180)}…` : text;
  } catch { return translate("common.structuredResult"); }
}
