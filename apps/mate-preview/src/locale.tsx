import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export type MateLocale = "zh-CN" | "en";

const LOCALE_STORAGE_KEY = "workspace-mate-locale-v1";

type MateLocaleContextValue = {
  locale: MateLocale;
  setLocale: (locale: MateLocale) => void;
  text: (chinese: string, english: string) => string;
};

const MateLocaleContext = createContext<MateLocaleContextValue | undefined>(undefined);

export function MateLocaleProvider({ children, locale: hostLocale, onLocaleChange }: {
  children: ReactNode;
  locale?: MateLocale;
  onLocaleChange?: (locale: MateLocale) => void;
}) {
  const [preferredLocale, setPreferredLocale] = useState<MateLocale>(readMateLocale);
  const locale = hostLocale ?? preferredLocale;
  const setLocale = useCallback((next: MateLocale) => {
    if (hostLocale !== undefined) onLocaleChange?.(next);
    else setPreferredLocale(next);
  }, [hostLocale, onLocaleChange]);
  const text = useCallback((chinese: string, english: string) => locale === "en" ? english : chinese, [locale]);

  useEffect(() => {
    if (hostLocale === undefined) {
      storeMateLocale(locale);
      document.documentElement.lang = locale;
    }
  }, [hostLocale, locale]);

  const value = useMemo(() => ({ locale, setLocale, text }), [locale, setLocale, text]);
  return <MateLocaleContext.Provider value={value}>{children}</MateLocaleContext.Provider>;
}

export function useMateLocale() {
  const value = useContext(MateLocaleContext);
  if (value) return value;
  const locale = readMateLocale();
  return {
    locale,
    setLocale: storeMateLocale,
    text: (chinese: string, english: string) => locale === "en" ? english : chinese
  } satisfies MateLocaleContextValue;
}

export function readMateLocale(): MateLocale {
  if (typeof window === "undefined") return "zh-CN";
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
      ?? window.localStorage.getItem("workspace-ai:locale");
    return stored === "en" ? "en" : "zh-CN";
  } catch {
    return "zh-CN";
  }
}

export function storeMateLocale(locale: MateLocale) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Preference persistence is optional; the active view still updates.
  }
}
