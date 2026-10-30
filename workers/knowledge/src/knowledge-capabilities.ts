export type KnowledgeRole = "owner" | "collaborator" | "viewer" | "none";

export type KnowledgeCapability =
  | "readContent"
  | "editContent"
  | "manageAccess"
  | "manageService"
  | "updateServiceInfo"
  | "manageProtectedStructure"
  | "transferOwnership"
  | "createPublicShare"
  | "readChangeAudit";

const ROLE_CAPABILITIES: Readonly<Record<KnowledgeRole, ReadonlySet<KnowledgeCapability>>> = {
  owner: new Set([
    "readContent",
    "editContent",
    "manageAccess",
    "manageService",
    "updateServiceInfo",
    "manageProtectedStructure",
    "transferOwnership",
    "createPublicShare",
    "readChangeAudit"
  ]),
  collaborator: new Set([
    "readContent",
    "editContent",
    "updateServiceInfo",
    "readChangeAudit"
  ]),
  viewer: new Set([
    "readContent"
  ]),
  none: new Set()
};

export function hasKnowledgeCapability(role: KnowledgeRole, capability: KnowledgeCapability) {
  return ROLE_CAPABILITIES[role].has(capability);
}

export function knowledgeCapabilitiesForRole(role: KnowledgeRole) {
  return [...ROLE_CAPABILITIES[role]];
}

export function canUseKnowledgeService(role: KnowledgeRole, serviceEnabled: boolean) {
  return serviceEnabled && hasKnowledgeCapability(role, "readContent");
}
