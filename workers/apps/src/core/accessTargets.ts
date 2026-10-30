import { normalizeUserIdentifier, principalUserIdentifiers } from "./collaborators";
import type { Principal } from "./types";
import { readString } from "./utils";

export function accessTargetsMatchPrincipal(targets: string[], principal: Principal) {
  return targets.some((target) => accessTargetMatchesPrincipal(target, principal));
}

export function accessTargetMatchesPrincipal(target: string, principal: Principal) {
  const normalized = target.trim().toLowerCase();
  if (normalized.startsWith("user:")) {
    const userId = normalizeUserIdentifier(normalized.slice("user:".length));
    return principalUserIdentifiers(principal).some((candidate) => normalizeUserIdentifier(candidate) === userId);
  }
  if (!normalized.startsWith("department:")) {
    return false;
  }

  const departmentId = normalizeDepartmentPath(normalized.slice("department:".length));
  return principalDepartmentLineage(principal).some((candidate) => (
    candidate === departmentId || candidate.startsWith(`${departmentId}/`)
  ));
}

function principalDepartmentLineage(principal: Principal) {
  return Array.from(new Set([
    principal.departmentId,
    ...(principal.departmentPath ?? [])
  ].map(normalizeDepartmentPath).filter(Boolean)));
}

function normalizeDepartmentPath(value: unknown) {
  return readString(value)
    .split("/")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join("/");
}
