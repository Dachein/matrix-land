import { HttpError } from "../http.ts";
import { canUseKnowledgeService, hasKnowledgeCapability, type KnowledgeCapability, type KnowledgeRole } from "../knowledge-capabilities.ts";
import type { CanonicalKnowledgeRole, ObjectRow, PermissionRow, Principal } from "../types.ts";
import { readString } from "../values.ts";

// Canonical roles and subject policy; storage aliases remain compatible with deployed schemas.
export function permissionAppliesToPrincipal(row: PermissionRow, principal: Principal) {
  return principalSubjectPairs(principal).some((subject) => subject.type === row.subject_type && subject.id === row.subject_id);
}

export function principalSubjectPairs(principal: Principal) {
  const subjects: Array<{ type: PermissionRow["subject_type"]; id: string }> = [
    { type: "user", id: principal.sub },
    { type: "company", id: principal.orgId }
  ];
  [principal.teamId, principal.team].filter(Boolean).forEach((id) => subjects.push({ type: "team", id: String(id) }));
  [principal.departmentId, principal.department, ...principal.departmentPath].filter(Boolean).forEach((id) => subjects.push({ type: "department", id: String(id) }));
  const seen = new Set<string>();
  return subjects.filter((subject) => {
    const key = `${subject.type}:${subject.id}`;
    if (!subject.id || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function roleRank(role: string | undefined) {
  if (role === "owner") return 3;
  if (role === "editor" || role === "collaborator") return 2;
  if (role === "viewer") return 1;
  return 0;
}

export function validatePermissionRole(value: unknown): Exclude<CanonicalKnowledgeRole, "owner"> {
  if (value === "viewer") return "viewer";
  if (value === "collaborator" || value === "editor") return "collaborator";
  throw new HttpError(400, "invalid_permission_role");
}

export function canonicalPermissionRole(value: string | undefined): CanonicalKnowledgeRole | "none" {
  if (value === "owner") return "owner";
  if (value === "editor" || value === "collaborator") return "collaborator";
  if (value === "viewer") return "viewer";
  return "none";
}

export function roleHasKnowledgeCapability(value: string | undefined, capability: KnowledgeCapability) {
  return hasKnowledgeCapability(canonicalPermissionRole(value) as KnowledgeRole, capability);
}

export function permissionRoleForRow(row: Pick<PermissionRow, "role" | "subject_type">): CanonicalKnowledgeRole | "none" {
  const role = canonicalPermissionRole(row.role);
  if (role === "viewer" || role === "none") {
    return role;
  }
  // Only a person can collaborate. Historical elevated grants to companies,
  // departments, teams, or MCP clients are fail-closed to read-only until the
  // data migration normalizes their stored role.
  if (row.subject_type !== "user") {
    return "viewer";
  }
  return role;
}

export function storagePermissionRole(value: CanonicalKnowledgeRole): PermissionRow["role"] {
  // Existing production D1 tables constrain this value to `editor`. Keep the
  // storage alias until the table-rebuild migration is universally deployed.
  return value === "collaborator" ? "editor" : value;
}

export function validateSubjectType(value: unknown): PermissionRow["subject_type"] {
  if (value === "user" || value === "team" || value === "department" || value === "company" || value === "mcp_client") {
    return value;
  }
  throw new HttpError(400, "invalid_permission_subject_type");
}

export function validateSubjectId(value: unknown, subjectType: PermissionRow["subject_type"], orgId: string) {
  const id = readString(value).trim();
  if (subjectType === "company") {
    return id || orgId;
  }
  if (!id || id.length > 240 || /[\u0000-\u001f]/.test(id)) {
    throw new HttpError(400, "invalid_permission_subject_id");
  }
  return id;
}

export function knowledgeCapabilities(
  role: CanonicalKnowledgeRole | "none",
  agentEnabled: boolean,
  objectKind: ObjectRow["object_kind"] = "folder",
  protectedHandbook = false,
  isRootFolder = objectKind === "folder"
) {
  const canEdit = roleHasKnowledgeCapability(role, "editContent");
  return {
    canRead: roleHasKnowledgeCapability(role, "readContent"),
    canEdit,
    canCreatePublicShare: roleHasKnowledgeCapability(role, "createPublicShare")
      && objectKind === "file"
      && !protectedHandbook,
    canManageAccess: roleHasKnowledgeCapability(role, "manageAccess") && isRootFolder,
    canManageKnowledgeService: roleHasKnowledgeCapability(role, "manageService") && isRootFolder,
    canUpdateKnowledgeServiceInfo: roleHasKnowledgeCapability(role, "updateServiceInfo") && isRootFolder,
    canManageProtectedStructure: roleHasKnowledgeCapability(role, "manageProtectedStructure"),
    canReadChangeAudit: roleHasKnowledgeCapability(role, "readChangeAudit"),
    canTransferOwnership: roleHasKnowledgeCapability(role, "transferOwnership") && isRootFolder,
    canUseKnowledgeService: canUseKnowledgeService(role as KnowledgeRole, agentEnabled)
  };
}
