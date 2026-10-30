import { useCallback } from 'react';
import { useI18n } from './index';
import type { TranslationKey } from './resources';
import { ownershipZhCN } from './resources.ownership.zh-CN';
import { ownershipEn } from './resources.ownership.en';

type OwnershipKey = keyof typeof ownershipZhCN;
const catalogs = { 'zh-CN': ownershipZhCN, en: ownershipEn };

/** Ownership copy ships with the deferred APPS/admin routes, not the initial locale bundle. */
export function useOwnershipI18n() {
  const { locale, t } = useI18n();
  const translate = useCallback((key: TranslationKey | OwnershipKey, values?: Record<string, string | number | undefined>) => {
    const catalog = catalogs[locale];
    if (Object.prototype.hasOwnProperty.call(catalog, key)) {
      return catalog[key as OwnershipKey].replace(/\{(\w+)\}/g, (token, name: string) => values?.[name] === undefined ? token : String(values[name]));
    }
    return t(key as TranslationKey, values);
  }, [locale, t]);
  return { locale, t: translate };
}
