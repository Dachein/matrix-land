import type { WorkspaceMateCapabilitySelection } from "../../../packages/mate-sdk/dist/chatHost.js";
import type { MateRuntimeCapabilityProfile } from "./api";
import { allChatCapabilities, type ChatCapabilitySelection } from "./chatSelection";

export type HostedCapabilityProfile = {
  profile: MateRuntimeCapabilityProfile;
  selection: ChatCapabilitySelection;
};

/**
 * The Runtime profile is already the Release × current-user permission
 * boundary. Host input chooses the defaults for this Conversation; it must not
 * hide other capabilities the user is allowed to select.
 */
export function resolveHostedCapabilityProfile(
  profile: MateRuntimeCapabilityProfile,
  selection?: WorkspaceMateCapabilitySelection
): HostedCapabilityProfile {
  const available = allChatCapabilities(profile);
  const appIds = new Set(available.appIds);
  const knowledgeServiceIds = new Set(available.knowledgeServiceIds);
  return {
    profile,
    selection: {
      appIds: selection?.appIds === undefined
        ? available.appIds
        : selection.appIds.filter((id) => appIds.has(id)),
      knowledgeServiceIds: selection?.knowledgeServiceIds === undefined
        ? available.knowledgeServiceIds
        : selection.knowledgeServiceIds.filter((id) => knowledgeServiceIds.has(id))
    }
  };
}
