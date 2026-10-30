import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import { isMateAllResourceScope, type WorkspaceAgentRuntimeManifest } from "../../../src/shared/mate.ts";
import { validFolderEditBindings } from "../../../src/shared/mateFolderEditing.ts";
import { isMateMcpCapacity } from "../../../src/shared/mateMcpCapacity.ts";
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimeMode, type RuntimePrincipal } from "./types.ts";

export type PublishedMateIdentity = {
  activeReleaseId: string;
  id: string;
  orgId: string;
  ownerUserId: string;
};

export async function listPublishedMateIdentities(env: RuntimeEnv): Promise<PublishedMateIdentity[]> {
  const response = await controlPlaneRequest(env, "/internal/runtime/mates");
  const payload = await response.json() as { mates?: unknown };
  if (!Array.isArray(payload.mates)) return [];
  return payload.mates.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const id = text(row.id);
    const ownerUserId = text(row.ownerUserId);
    const orgId = text(row.orgId);
    const activeReleaseId = text(row.activeReleaseId);
    return id && ownerUserId && orgId && activeReleaseId ? [{ activeReleaseId, id, orgId, ownerUserId }] : [];
  });
}

export async function loadRuntimeDefinition(
  env: RuntimeEnv,
  principal: RuntimePrincipal,
  mateId: string,
  mode: RuntimeMode = "live",
  options?: { abortSignal?: AbortSignal }
): Promise<RuntimeDefinition> {
  throwIfAborted(options?.abortSignal);
  const origin = env.APPS_CONTROL_PLANE_URL?.trim() || missingConfiguration("APPS_CONTROL_PLANE_URL");
  const releaseId = mode === "preview" ? requireOwnerTestGrant(principal, mateId) : "";
  const path = mode === "preview"
    ? `/internal/runtime/mates/${encodeURIComponent(mateId)}/releases/${encodeURIComponent(releaseId)}`
    : `/internal/runtime/mates/${encodeURIComponent(mateId)}`;
  const url = new URL(path, origin);
  const headers = new Headers({ Accept: "application/json" });
  const token = env.MATE_RUNTIME_SERVICE_TOKEN?.trim();
  if (!token) throw new RuntimeHttpError(503, "control_plane_service_token_not_configured");
  headers.set("authorization", `Bearer ${token}`);
  headers.set("x-workspace-runtime-user-id", principal.userId);
  headers.set("x-workspace-runtime-org-id", principal.orgId);
  if (mode === "preview") headers.set("x-workspace-runtime-owner-user-id", principal.userId);
  const request = new Request(url, { headers, signal: options?.abortSignal });
  const response = env.APPS_CONTROL_PLANE
    ? await env.APPS_CONTROL_PLANE.fetch(request)
    : await fetch(request);
  throwIfAborted(options?.abortSignal);
  if (!response.ok) {
    if (response.status === 404) throw new RuntimeHttpError(404, "mate_not_published");
    throw new RuntimeHttpError(502, "control_plane_unavailable");
  }
  const definition = validateRuntimeDefinition(await response.json());
  throwIfAborted(options?.abortSignal);
  if (mode === "preview" && definition.release.id !== releaseId) {
    throw invalidRuntimeDefinition("runtime_preview_release_binding_invalid");
  }
  if (mode === "preview" && definition.mate.ownerUserId !== principal.userId) {
    throw new RuntimeHttpError(404, "mate_owner_test_not_found");
  }
  assertInvocationAllowed(definition, principal);
  return definition;
}

export async function loadRuntimeDefinitionByEmail(
  env: RuntimeEnv,
  principal: RuntimePrincipal,
  address: string
): Promise<RuntimeDefinition> {
  const origin = env.APPS_CONTROL_PLANE_URL?.trim() || missingConfiguration("APPS_CONTROL_PLANE_URL");
  const url = new URL("/internal/runtime/mate-by-email", origin);
  url.searchParams.set("address", address.trim().toLowerCase());
  const token = env.MATE_RUNTIME_SERVICE_TOKEN?.trim();
  if (!token) throw new RuntimeHttpError(503, "control_plane_service_token_not_configured");
  const request = new Request(url, { headers: {
    Accept: "application/json", Authorization: `Bearer ${token}`,
    "x-workspace-runtime-user-id": principal.userId,
    "x-workspace-runtime-org-id": principal.orgId
  } });
  const response = env.APPS_CONTROL_PLANE ? await env.APPS_CONTROL_PLANE.fetch(request) : await fetch(request);
  if (!response.ok) {
    if (response.status === 404) throw new RuntimeHttpError(404, "mate_email_not_published");
    throw new RuntimeHttpError(502, "control_plane_unavailable");
  }
  const definition = validateRuntimeDefinition(await response.json());
  assertInvocationAllowed(definition, principal);
  if (definition.mate.workEmail?.trim().toLowerCase() !== address.trim().toLowerCase()) {
    throw new RuntimeHttpError(404, "mate_email_not_published");
  }
  return definition;
}

async function controlPlaneRequest(env: RuntimeEnv, path: string) {
  const origin = env.APPS_CONTROL_PLANE_URL?.trim() || missingConfiguration("APPS_CONTROL_PLANE_URL");
  const token = env.MATE_RUNTIME_SERVICE_TOKEN?.trim();
  if (!token) throw new RuntimeHttpError(503, "control_plane_service_token_not_configured");
  const request = new Request(new URL(path, origin), {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
  });
  const response = env.APPS_CONTROL_PLANE ? await env.APPS_CONTROL_PLANE.fetch(request) : await fetch(request);
  if (!response.ok) throw new RuntimeHttpError(502, "control_plane_unavailable");
  return response;
}

function requireOwnerTestGrant(principal: RuntimePrincipal, mateId: string) {
  const grant = principal.testGrant;
  if (!grant || grant.mateId !== mateId || !grant.releaseId) {
    throw new RuntimeHttpError(403, "mate_owner_test_grant_required");
  }
  return grant.releaseId;
}

function assertInvocationAllowed(definition: RuntimeDefinition, principal: RuntimePrincipal) {
  const manifest = definition.release.manifest as WorkspaceAgentRuntimeManifest;
  if (definition.mate.orgId !== principal.orgId) throw new RuntimeHttpError(404, "mate_not_found");
  if (!manifest.invocationPolicy.allowedCallerKinds.includes(principal.callerKind)) throw new RuntimeHttpError(403, "mate_caller_kind_denied");
  if (manifest.invocationPolicy.visibility === "private" && definition.mate.ownerUserId !== principal.userId) {
    throw new RuntimeHttpError(403, "mate_invocation_denied");
  }
  if (manifest.invocationPolicy.visibility === "targets") {
    if (!invocationTargetMatchesPrincipal(manifest.invocationPolicy.targetIds ?? [], principal)) {
      throw new RuntimeHttpError(403, "mate_invocation_denied");
    }
  }
}

function validateRuntimeDefinition(value: unknown): RuntimeDefinition {
  const definition = object(value);
  const mate = object(definition.mate);
  const release = object(definition.release);
  const manifest = object(release.manifest);
  const manifestMate = object(manifest.mate);
  const manifestRelease = object(manifest.release);
  const resources = object(manifest.resources);
  const invocationPolicy = object(manifest.invocationPolicy);
  const taskPolicy = object(manifest.taskPolicy);
  const approvals = object(taskPolicy.approvals);

  const mateId = requiredId(mate.id);
  const releaseId = requiredId(release.id);
  if (
    manifest.schemaVersion !== "workspace.agentruntime/v1"
    || requiredId(release.mateId) !== mateId
    || requiredId(manifestMate.mateId) !== mateId
    || requiredId(manifestRelease.releaseId) !== releaseId
    || requiredId(manifestMate.ownerUserId) !== requiredId(mate.ownerUserId)
    || Number(manifestRelease.version) !== Number(release.version)
    || !/^sha256:[a-f0-9]{64}$/i.test(text(release.manifestSha256))
  ) {
    throw invalidRuntimeDefinition("runtime_release_integrity_invalid");
  }

  if (
    invocationPolicy.requireAuthenticatedUser !== true
    || taskPolicy.requireUserOwnership !== true
    || approvals.revalidateDelegation !== true
    || approvals.singleUse !== true
  ) {
    throw invalidRuntimeDefinition("runtime_user_authority_policy_invalid");
  }

  const appBindings = strictArray(resources.appMcpBindings);
  const knowledgeBindings = strictArray(resources.knowledgeServiceBindings);
  const skillRefs = strictArray(manifestRelease.skills);
  const skills = definition.skills === undefined ? [] : strictArray(definition.skills);
  if (skills.length > skillRefs.length || new Set(skills.map((value) => text(object(value).skillId))).size !== skills.length
    || skills.some((value) => {
      const skill = object(value);
      return !skillRefs.some((ref) => {
        const pinned = object(ref);
        return pinned.skillId === skill.skillId && pinned.version === skill.version;
      }) || !text(skill.name) || typeof skill.markdown !== "string" || skill.markdown.length > 200_000;
    })) {
    throw invalidRuntimeDefinition("runtime_skill_binding_invalid");
  }
  const workspacePassMcpScope = resources.workspacePassMcpScope === undefined
    ? undefined
    : object(resources.workspacePassMcpScope);
  const knowledgeScope = resources.knowledgeServiceScope === undefined
    ? undefined
    : object(resources.knowledgeServiceScope);
  const builtInBindings = strictArray(resources.builtInToolBindings);
  if (resources.mcpCapacity !== undefined && !isMateMcpCapacity(resources.mcpCapacity)) {
    throw invalidRuntimeDefinition("runtime_mcp_capacity_invalid");
  }
  if (resources.appMcpScope !== undefined && (!isMateAllResourceScope(resources.appMcpScope) || appBindings.length)) {
    throw invalidRuntimeDefinition("runtime_app_mcp_scope_invalid");
  }
  if (resources.folderEditScope !== undefined && (!isMateAllResourceScope(resources.folderEditScope) || strictArray(resources.folderEditBindings).length)) {
    throw invalidRuntimeDefinition("runtime_folder_edit_scope_invalid");
  }
  if (resources.folderEditBindings !== undefined && !validFolderEditBindings(resources.folderEditBindings)) {
    throw invalidRuntimeDefinition("runtime_folder_edit_bindings_invalid");
  }
  if (
    appBindings.some((binding) => object(binding).requiresCurrentUserDelegation !== true || containsUnsupportedAuthority(binding))
    || knowledgeBindings.some((binding) => object(binding).requiresCurrentUserAuthorization !== true || containsUnsupportedAuthority(binding))
    || (workspacePassMcpScope !== undefined && (
      workspacePassMcpScope.mode !== "all_authorized_for_invoking_user"
      || workspacePassMcpScope.requiresCurrentUserAuthorization !== true
      || !hasExactWorkspacePassDomains(workspacePassMcpScope.domains)
      || !hasExactInvokingUserAuthority(workspacePassMcpScope.authority)
      || containsUnsupportedAuthority(workspacePassMcpScope)
      || appBindings.length > 0
      || knowledgeBindings.length > 0
      || strictArray(resources.folderEditBindings).length > 0
      || resources.appMcpScope !== undefined
      || resources.folderEditScope !== undefined
    ))
    || (knowledgeScope !== undefined && (
      knowledgeScope.mode !== "all_visible_to_invoking_user"
      || knowledgeScope.requiresCurrentUserAuthorization !== true
      || !hasExactKnowledgeReadOperations(knowledgeScope.allowedOperations)
      || containsUnsupportedAuthority(knowledgeScope)
      || knowledgeBindings.length > 0
    ))
    || builtInBindings.some((binding) => object(binding).requiresCurrentUserContext !== true || containsUnsupportedAuthority(binding))
  ) {
    throw invalidRuntimeDefinition("runtime_user_authority_policy_invalid");
  }

  return value as RuntimeDefinition;
}

function hasExactWorkspacePassDomains(value: unknown) {
  return Array.isArray(value)
    && value.length === 2
    && value[0] === "apps"
    && value[1] === "knowledge";
}

function hasExactInvokingUserAuthority(value: unknown) {
  const authority = object(value);
  return authority.mode === "invoking_user" && Object.keys(authority).length === 1;
}

function hasExactKnowledgeReadOperations(value: unknown) {
  return Array.isArray(value)
    && value.length === 2
    && value.includes("search")
    && value.includes("read");
}

function containsUnsupportedAuthority(value: unknown, depth = 0): boolean {
  if (depth > 6) return true;
  if (Array.isArray(value)) return value.some((child) => containsUnsupportedAuthority(child, depth + 1));
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
    if (["grantid", "owneruserid", "owneraccess", "ownerdelegated"].includes(normalizedKey)) return true;
    if (key.toLowerCase() === "authority") {
      const authority = object(child);
      if (authority.mode !== "invoking_user" || Object.keys(authority).some((authorityKey) => authorityKey !== "mode")) return true;
      continue;
    }
    if (containsUnsupportedAuthority(child, depth + 1)) return true;
  }
  return false;
}

function invalidRuntimeDefinition(reason: string) {
  return new RuntimeHttpError(502, "runtime_definition_invalid", { reason });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRuntimeDefinition("runtime_definition_shape_invalid");
  return value as Record<string, unknown>;
}

function strictArray(value: unknown) {
  if (!Array.isArray(value)) throw invalidRuntimeDefinition("runtime_definition_shape_invalid");
  return value;
}

function requiredId(value: unknown) {
  const output = text(value);
  if (!output || output.length > 180 || /[\u0000-\u001f\u007f]/.test(output)) {
    throw invalidRuntimeDefinition("runtime_definition_identifier_invalid");
  }
  return output;
}

function invocationTargetMatchesPrincipal(targets: string[], principal: RuntimePrincipal) {
  const userId = normalizeTargetValue(principal.userId);
  const departmentLineage = Array.from(new Set([
    normalizeDepartmentPath(principal.departmentId ?? ""),
    ...(principal.departmentPath ?? []).map(normalizeDepartmentPath)
  ].filter(Boolean)));

  return targets.some((target) => {
    const normalized = target.trim().toLowerCase();
    if (normalized.startsWith("user:")) return normalizeTargetValue(normalized.slice("user:".length)) === userId;
    if (!normalized.startsWith("department:")) return false;
    const departmentTarget = normalizeDepartmentPath(normalized.slice("department:".length));
    return Boolean(departmentTarget) && departmentLineage.some((value) => value === departmentTarget || value.startsWith(`${departmentTarget}/`));
  });
}

function normalizeDepartmentPath(value: string) {
  return value.split("/").map(normalizeTargetValue).filter(Boolean).join("/");
}

function normalizeTargetValue(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new RuntimeHttpError(499, "runtime_request_aborted");
}
