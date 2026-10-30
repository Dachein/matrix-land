import type { MouseEvent as ReactMouseEvent } from "react";

export function formatCompactCount(count: number, locale?: string) {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    notation: "compact"
  }).format(count);
}

export function formatMarketUpdatedAt(value: string, locale?: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date);
}

export function openFromItem(event: ReactMouseEvent<HTMLElement>, onOpen: () => void) {
  if (event.target instanceof Element && event.target.closest("a, button, input, select, textarea")) {
    return;
  }

  onOpen();
}
