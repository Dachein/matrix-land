import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";

export function RelativeTime({
  className,
  fallback,
  showClock = false,
  timeZone,
  value
}: {
  className?: string;
  fallback?: string;
  showClock?: boolean;
  timeZone?: string;
  value?: string;
}) {
  const { locale, t } = useI18n();
  const timestamp = timestampMs(value);
  const [, setTick] = useState(0);
  const normalizedClassName = className ? `relativeTime ${className}` : "relativeTime";
  const relativeLabel = timestamp
    ? formatRelativeTimeLabel(timestamp, locale)
    : value?.trim() || fallback || t("common.notRecorded");
  const label = timestamp && showClock
    ? `${relativeLabel} ${new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(timestamp))}`
    : relativeLabel;
  const exactLabel = timestamp
    ? formatExactTimestamp(timestamp, locale, timeZone)
    : label;

  useEffect(() => {
    if (!timestamp) {
      return undefined;
    }

    const timerId = window.setInterval(() => setTick((current) => current + 1), 60_000);
    return () => window.clearInterval(timerId);
  }, [timestamp]);

  return (
    <time className={normalizedClassName} dateTime={timestamp ? new Date(timestamp).toISOString() : undefined} title={exactLabel}>
      {label}
    </time>
  );
}

function formatExactTimestamp(timestamp: number, locale: string, timeZone?: string) {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {})
    }).format(new Date(timestamp));
  } catch {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
  }
}

export function timestampMs(value?: string) {
  const text = value?.trim();

  if (!text) {
    return 0;
  }

  const hasExplicitTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text);
  const normalized = text.includes("T") || hasExplicitTimezone ? text : `${text.replace(" ", "T")}Z`;
  const timestamp = new Date(normalized).getTime();

  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatRelativeTimeLabel(timestamp: number, locale: string) {
  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  if (absSeconds < 60) {
    return formatter.format(diffSeconds, "second");
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, "minute");
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, "hour");
  }

  const diffDays = Math.round(diffHours / 24);
  if (Math.abs(diffDays) < 30) {
    return formatter.format(diffDays, "day");
  }

  const diffMonths = Math.round(diffDays / 30);
  if (Math.abs(diffMonths) < 12) {
    return formatter.format(diffMonths, "month");
  }

  return formatter.format(Math.round(diffMonths / 12), "year");
}
