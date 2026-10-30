import type { zhCN } from "./resources.zh-CN";

export const supportedLocales = [
  { code: "zh-CN", label: "中文", shortLabel: "中文" },
  { code: "en", label: "English", shortLabel: "EN" }
] as const;

export type Locale = (typeof supportedLocales)[number]["code"];

export const defaultLocale: Locale = "zh-CN";

export type TranslationKey = keyof typeof zhCN;
export type TranslationResource = Record<TranslationKey, string>;
