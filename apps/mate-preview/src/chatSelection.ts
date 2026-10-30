import type { MateRuntimeCapabilityProfile } from "./api";

export type ChatCapabilitySelection = {
  appIds: string[];
  knowledgeServiceIds: string[];
};

export type ChatCapabilityKind = "app" | "knowledge";

export function allChatCapabilities(profile: MateRuntimeCapabilityProfile): ChatCapabilitySelection {
  return {
    appIds: unique(profile.appMcp.map((resource) => resource.id)),
    knowledgeServiceIds: unique(profile.knowledge.map((resource) => resource.id))
  };
}

export function toggleChatCapability(
  selection: ChatCapabilitySelection,
  kind: ChatCapabilityKind,
  id: string
): ChatCapabilitySelection {
  const key = kind === "app" ? "appIds" : "knowledgeServiceIds";
  const values = new Set(selection[key]);
  if (values.has(id)) values.delete(id);
  else values.add(id);
  return { ...selection, [key]: [...values] };
}

export function setChatCapabilityCategory(
  selection: ChatCapabilitySelection,
  kind: ChatCapabilityKind,
  ids: string[]
): ChatCapabilitySelection {
  const key = kind === "app" ? "appIds" : "knowledgeServiceIds";
  return { ...selection, [key]: unique(ids) };
}

export function chatCapabilitySummary(selection: ChatCapabilitySelection, locale: "zh-CN" | "en" = "zh-CN") {
  const knowledge = selection.knowledgeServiceIds.length;
  const apps = selection.appIds.length;
  if (!knowledge && !apps) return locale === "en" ? "None selected" : "未选择";
  return [
    knowledge ? (locale === "en" ? `${knowledge} knowledge` : `${knowledge} 知识库`) : "",
    apps ? (locale === "en" ? `${apps} apps` : `${apps} 应用`) : ""
  ].filter(Boolean).join(" · ");
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
