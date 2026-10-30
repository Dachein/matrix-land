import { Fragment } from "react";
import { useI18n, type Locale } from "../i18n";
import { SelectInput } from "./FormField";
import { WorkspaceListbox } from "./WorkspaceListbox";

export function LanguageSwitcher({ compact = false, variant = "segmented" }: { compact?: boolean; variant?: "segmented" | "select" | "line" }) {
  const { locale, locales, setLocale, t } = useI18n();
  const activeLocale = locales.find((item) => item.code === locale);

  if (variant === "line") {
    return <div className="languageSwitcherLine"><SelectInput appearance="line" aria-label={t("language.switcherLabel")} value={locale} onChange={event => setLocale(event.target.value as Locale)}>
      {locales.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}
    </SelectInput></div>;
  }

  if (variant === "select") {
    return (
      <div
        className={compact ? "languageSwitcherSelect compact" : "languageSwitcherSelect"}
        title={t("language.current", { language: activeLocale?.label ?? locale })}
      >
        <span className="visuallyHidden">{t("language.switcherLabel")}</span>
        <WorkspaceListbox<Locale>
          ariaLabel={t("language.switcherLabel")}
          className="languageSwitcherListbox"
          noResultsLabel=""
          onChange={setLocale}
          options={locales.map((item) => ({
            label: item.shortLabel,
            searchText: item.label,
            value: item.code
          }))}
          popoverAlign="end"
          popoverClassName="languageSwitcherListboxPopover"
          placeholder={activeLocale?.shortLabel ?? locale}
          popoverMinWidth={compact ? 112 : 128}
          value={locale}
        />
      </div>
    );
  }

  return (
    <div
      aria-label={t("language.switcherLabel")}
      className={compact ? "languageSwitcher compact" : "languageSwitcher"}
      title={t("language.current", { language: activeLocale?.label ?? locale })}
    >
      <div className="languageSwitcherOptions">
        {locales.map((item, index) => (
          <Fragment key={item.code}>
            <button
              aria-label={item.label}
              aria-pressed={item.code === locale}
              className={item.code === locale ? "active" : ""}
              onClick={() => setLocale(item.code)}
              type="button"
            >
              {item.shortLabel}
            </button>
            {index < locales.length - 1 && <span className="languageSwitcherDivider" aria-hidden="true">/</span>}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
