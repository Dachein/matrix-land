import { usePlatformBrand, usePlatformBrandReady } from "../brand/PlatformBrandProvider";
import { initialInstallationLocale } from "../../shared/installationLocale";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { loadLocaleResource, readLoadedLocaleResource } from "./localeLoader";
import {
  defaultLocale,
  supportedLocales,
  type Locale,
  type TranslationKey,
  type TranslationResource
} from "./resources";

type TranslationValues = Record<string, number | string | undefined>;

type I18nContextValue = {
  locale: Locale;
  locales: typeof supportedLocales;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, values?: TranslationValues) => string;
};

type LoadedLocale = {
  locale: Locale;
  resource: TranslationResource;
};

const storageKey = "workspace-ai:locale";
const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const ready = usePlatformBrandReady();
  return ready ? <ReadyI18nProvider>{children}</ReadyI18nProvider> : <I18nBootstrap failed={false} />;
}

function ReadyI18nProvider({ children }: { children: ReactNode }) {
  const brand = usePlatformBrand();
  const [initialLocale] = useState<Locale>(() => detectInitialLocale(brand.defaultLocale));
  const [loadedLocale, setLoadedLocale] = useState<LoadedLocale | undefined>(() => {
    const resource = readLoadedLocaleResource(initialLocale);
    return resource ? { locale: initialLocale, resource } : undefined;
  });
  const [initialLoadFailed, setInitialLoadFailed] = useState(false);
  const localeRequestVersion = useRef(0);

  useEffect(() => {
    if (loadedLocale) {
      return undefined;
    }
    let active = true;

    async function loadInitialLocale() {
      try {
        const resource = await loadLocaleResource(initialLocale);
        if (active) {
          setLoadedLocale({ locale: initialLocale, resource });
        }
      } catch {
        if (initialLocale !== defaultLocale) {
          try {
            const resource = await loadLocaleResource(defaultLocale);
            if (active) {
              setLoadedLocale({ locale: defaultLocale, resource });
            }
            return;
          } catch {
            // Fall through to the static recovery state below.
          }
        }
        if (active) {
          setInitialLoadFailed(true);
        }
      }
    }

    void loadInitialLocale();
    return () => { active = false; };
  }, [initialLocale, loadedLocale]);

  useEffect(() => {
    if (!loadedLocale) {
      return;
    }
    document.documentElement.lang = loadedLocale.locale;
    try {
      window.localStorage.setItem(storageKey, loadedLocale.locale);
    } catch {
      // Language selection still works when browser storage is unavailable.
    }
  }, [loadedLocale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    if (nextLocale === loadedLocale?.locale) {
      return;
    }
    const requestVersion = localeRequestVersion.current + 1;
    localeRequestVersion.current = requestVersion;
    void loadLocaleResource(nextLocale)
      .then((resource) => {
        if (localeRequestVersion.current === requestVersion) {
          setLoadedLocale({ locale: nextLocale, resource });
        }
      })
      .catch(() => {
        // Preserve the current, complete language instead of showing partial keys.
      });
  }, [loadedLocale?.locale]);

  const value = useMemo<I18nContextValue | undefined>(() => loadedLocale ? ({
    locale: loadedLocale.locale,
    locales: supportedLocales,
    setLocale,
    t: (key, values) => translate(loadedLocale.resource, key, { platformName: brand.name, ...values })
  }) : undefined, [loadedLocale, setLocale, brand.name]);

  if (!value) {
    return <I18nBootstrap failed={initialLoadFailed} />;
  }

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);

  if (!value) {
    throw new Error("useI18n must be used within I18nProvider");
  }

  return value;
}

export function normalizeLocale(value?: string | null): Locale {
  const normalized = (value ?? "").toLowerCase();

  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en";
  }

  if (normalized === "zh" || normalized.startsWith("zh-")) {
    return "zh-CN";
  }

  return defaultLocale;
}

export function detectInitialLocale(installationDefault?: Locale): Locale {
  let savedLocale: string | null = null;
  try {
    savedLocale = window.localStorage.getItem(storageKey);
  } catch {
    // Fall back to browser preferences when storage is unavailable.
  }

  const browserLocale = window.navigator.languages?.[0] ?? window.navigator.language;
  return initialInstallationLocale(savedLocale, installationDefault, browserLocale);
}

function translate(resource: TranslationResource, key: TranslationKey, values: TranslationValues = {}) {
  const template = resource[key] ?? key;

  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

function I18nBootstrap({ failed }: { failed: boolean }) {
  const brand = usePlatformBrand();
  return (
    <main
      aria-busy={failed ? undefined : true}
      aria-live="polite"
      className={`portal-i18n-bootstrap ${failed ? "is-error" : ""}`}
      role={failed ? "alert" : "status"}
    >
      <strong>{brand.name}</strong>
      {failed ? (
        <p>语言资源加载失败。Language resources could not be loaded. Please refresh to retry.</p>
      ) : (
        <span aria-hidden="true" className="portal-i18n-bootstrap-progress" />
      )}
    </main>
  );
}

export type { Locale, TranslationKey };
