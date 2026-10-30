export const MARKET_CATEGORIES = [
  { key: "coding", zh: "开发工具", en: "Coding" },
  { key: "design", zh: "设计创作", en: "Design" },
  { key: "media", zh: "媒体处理", en: "Media" },
  { key: "research", zh: "知识研究", en: "Research" },
  { key: "finance", zh: "金融投研", en: "Finance" },
  { key: "workflow", zh: "内部流程", en: "Workflow" },
  { key: "office", zh: "文件办公", en: "Office" }
] as const;

export type MarketCategoryKey = (typeof MARKET_CATEGORIES)[number]["key"];
export type MarketCategoryName = (typeof MARKET_CATEGORIES)[number]["en"];

const DEFAULT_CATEGORY_KEY: MarketCategoryKey = "research";
const CATEGORY_BY_KEY = new Map(MARKET_CATEGORIES.map((category) => [category.key, category]));
const CATEGORY_BY_EN = new Map(MARKET_CATEGORIES.map((category) => [normalizeCategoryText(category.en), category]));
const CATEGORY_ALIASES: Record<string, MarketCategoryKey> = {
  app: "workflow",
  apps: "workflow",
  code: "coding",
  coding: "coding",
  data: "research",
  design: "design",
  dev: "coding",
  development: "coding",
  "developer tool": "coding",
  "developer tools": "coding",
  file: "office",
  files: "office",
  finance: "finance",
  financial: "finance",
  "financial research": "finance",
  investment: "finance",
  knowledge: "research",
  legal: "office",
  mcp: "coding",
  "mcp service": "coding",
  media: "media",
  office: "office",
  operations: "workflow",
  platform: "coding",
  process: "workflow",
  research: "research",
  revenue: "finance",
  search: "research",
  workflow: "workflow",
  "办公协同": "office",
  "办公文件": "office",
  "多媒体": "media",
  "开发工具": "coding",
  "投资": "finance",
  "文件办公": "office",
  "文件处理": "office",
  "流程处理": "workflow",
  "知识": "research",
  "知识管理": "research",
  "知识研究": "research",
  "内部流程": "workflow",
  "设计": "design",
  "设计创作": "design",
  "搜索研究": "research",
  "媒体处理": "media",
  "金融": "finance",
  "金融投研": "finance"
};

export function marketCategoryByKey(key: MarketCategoryKey) {
  return CATEGORY_BY_KEY.get(key) ?? CATEGORY_BY_KEY.get(DEFAULT_CATEGORY_KEY)!;
}

export function normalizeMarketCategoryKey(value: unknown, fallback: MarketCategoryKey = DEFAULT_CATEGORY_KEY): MarketCategoryKey {
  const normalized = normalizeCategoryText(value);
  if (!normalized) {
    return fallback;
  }

  return CATEGORY_BY_EN.get(normalized)?.key ?? CATEGORY_ALIASES[normalized] ?? fallback;
}

export function normalizeMarketCategoryName(value: unknown, fallback: MarketCategoryKey = DEFAULT_CATEGORY_KEY): MarketCategoryName {
  return marketCategoryByKey(normalizeMarketCategoryKey(value, fallback)).en;
}

export function marketCategorySlug(value: unknown, fallback: MarketCategoryKey = DEFAULT_CATEGORY_KEY) {
  return normalizeMarketCategoryKey(value, fallback);
}

export function marketCategoryStableId(value: unknown, fallback: MarketCategoryKey = DEFAULT_CATEGORY_KEY) {
  return `category-${marketCategorySlug(value, fallback)}`;
}

export function marketCategoryOptionLabel(category: (typeof MARKET_CATEGORIES)[number], locale: string) {
  return isEnglishLocale(locale) ? category.en : category.zh;
}

export function marketCategoryLabel(value: unknown, locale: string, fallback: MarketCategoryKey = DEFAULT_CATEGORY_KEY) {
  return marketCategoryOptionLabel(marketCategoryByKey(normalizeMarketCategoryKey(value, fallback)), locale);
}

export function normalizeCategoryText(value: unknown) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ")
    : "";
}

function isEnglishLocale(locale: string) {
  return locale.toLowerCase().startsWith("en");
}
