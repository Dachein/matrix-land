import { HttpError, type Principal } from "./types";
import { readString } from "./utils";

const MAX_COLLABORATORS = 200;
const MAX_USER_IDENTIFIER_LENGTH = 180;

export function normalizeCollaboratorUserIds(value: unknown) {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "invalid_collaborator_user_ids");
  }

  if (value.some((identifier) => typeof identifier !== "string")) {
    throw new HttpError(400, "invalid_collaborator_user_id");
  }

  if (value.length > MAX_COLLABORATORS) {
    throw new HttpError(400, "too_many_collaborators");
  }

  const normalized = value
    .map(normalizeUserIdentifier)
    .filter(Boolean);

  if (normalized.some((identifier) => identifier.length > MAX_USER_IDENTIFIER_LENGTH)) {
    throw new HttpError(400, "invalid_collaborator_user_id");
  }

  return Array.from(new Set(normalized)).slice(0, MAX_COLLABORATORS);
}

export function collaboratorUserIdsFromJson(value: unknown) {
  const source = readString(value).trim();
  if (!source) {
    return [];
  }

  try {
    const parsed = JSON.parse(source) as unknown;
    return Array.isArray(parsed)
      ? Array.from(new Set(parsed
        .filter((identifier): identifier is string => typeof identifier === "string")
        .map(normalizeUserIdentifier)
        .filter((identifier) => identifier.length > 0 && identifier.length <= MAX_USER_IDENTIFIER_LENGTH)))
        .slice(0, MAX_COLLABORATORS)
      : [];
  } catch {
    return [];
  }
}

export function principalIsCollaborator(collaboratorUserIdsJson: unknown, principal: Principal) {
  const candidates = new Set(principalUserIdentifiers(principal).map(normalizeUserIdentifier).filter(Boolean));
  return collaboratorUserIdsFromJson(collaboratorUserIdsJson).some((identifier) => candidates.has(identifier));
}

export function principalCanManageAppsAsset(
  asset: { collaborator_user_ids_json?: unknown; org_id: string; owner_user_id: string },
  principal: Principal
) {
  if (asset.org_id !== principal.orgId) {
    return false;
  }

  return principalOwnsUserId(asset.owner_user_id, principal)
    || principalIsCollaborator(asset.collaborator_user_ids_json, principal);
}

export function principalOwnsUserId(ownerUserId: string, principal: Principal) {
  const owner = normalizeUserIdentifier(ownerUserId);
  return principalUserIdentifiers(principal).some((candidate) => normalizeUserIdentifier(candidate) === owner);
}

export function principalUserIdentifiers(principal: Principal) {
  return Array.from(new Set([
    principal.sub,
    principal.email,
    legacyWorkspaceEmailIdentifier(principal.email)
  ].filter((value): value is string => Boolean(value))));
}

export function normalizeUserIdentifier(value: unknown) {
  return readString(value)
    .trim()
    .toLowerCase();
}

function legacyWorkspaceEmailIdentifier(value: string | undefined) {
  const text = readString(value).trim().toLowerCase();
  return text.endsWith("@example.invalid")
    ? text
    : "";
}
