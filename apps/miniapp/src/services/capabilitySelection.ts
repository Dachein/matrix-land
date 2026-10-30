import type { ChatCapabilitySelection, RuntimeProfile } from "../types";

export function normalizeCapabilitySelection(profile: RuntimeProfile, selection?: ChatCapabilitySelection): ChatCapabilitySelection {
  return {
    appIds: (selection?.appIds || profile.appMcp.map((item) => item.id)).filter((id) => profile.appMcp.some((item) => item.id === id)).slice(0, 32),
    knowledgeServiceIds: (selection?.knowledgeServiceIds || profile.knowledge.map((item) => item.id)).filter((id) => profile.knowledge.some((item) => item.id === id)).slice(0, 12),
    modelId: profile.models.allowUserSelection && profile.models.allowed.some((model) => model.id === selection?.modelId) ? selection!.modelId : profile.models.defaultModel
  };
}
