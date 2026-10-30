const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function timestampMs(value?: string) {
  const text = value?.trim();
  if (!text) return 0;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function formatCompactRelativeTime(value: string | undefined, now = Date.now(), locale = "zh-CN") {
  const timestamp = timestampMs(value);
  if (!timestamp) return "";

  const elapsed = Math.max(0, now - timestamp);
  const english = locale.toLowerCase().startsWith("en");
  if (elapsed < MINUTE_MS) return english ? "now" : "刚刚";
  if (elapsed < HOUR_MS) return english ? `${Math.floor(elapsed / MINUTE_MS)}m` : `${Math.floor(elapsed / MINUTE_MS)}分钟`;
  if (elapsed < DAY_MS) return english ? `${Math.floor(elapsed / HOUR_MS)}h` : `${Math.floor(elapsed / HOUR_MS)}小时`;
  if (elapsed < 7 * DAY_MS) return english ? `${Math.floor(elapsed / DAY_MS)}d` : `${Math.floor(elapsed / DAY_MS)}天`;

  const date = new Date(timestamp);
  const current = new Date(now);
  const sameYear = date.getFullYear() === current.getFullYear();
  return new Intl.DateTimeFormat(locale, sameYear
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" }).format(date);
}

export function formatExactTimestamp(value: string | undefined, locale = "zh-CN") {
  const timestamp = timestampMs(value);
  if (!timestamp) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestamp));
}
