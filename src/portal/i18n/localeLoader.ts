import type { Locale, TranslationResource } from "./resources";

const loadedResources = new Map<Locale, TranslationResource>();
const pendingResources = new Map<Locale, Promise<TranslationResource>>();

const resourceLoaders: Record<Locale, () => Promise<TranslationResource>> = {
  "zh-CN": () => import("./resources.zh-CN.ts").then((module) => module.zhCN),
  en: () => import("./resources.en.ts").then((module) => module.en)
};

export function readLoadedLocaleResource(locale: Locale) {
  return loadedResources.get(locale);
}

export async function loadLocaleResource(locale: Locale) {
  const loaded = loadedResources.get(locale);
  if (loaded) {
    return loaded;
  }

  const pending = pendingResources.get(locale);
  if (pending) {
    return await pending;
  }

  const request = resourceLoaders[locale]()
    .then((resource) => {
      loadedResources.set(locale, resource);
      return resource;
    })
    .finally(() => {
      if (pendingResources.get(locale) === request) {
        pendingResources.delete(locale);
      }
    });
  pendingResources.set(locale, request);
  return await request;
}

export function clearLoadedLocaleResources() {
  loadedResources.clear();
  pendingResources.clear();
}
