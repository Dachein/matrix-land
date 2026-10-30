import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import type { OwnerMateDefinitionChange } from "../../apps/src/mates/service.ts";
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimePrincipal } from "./types.ts";

export async function reviewSelfDefinition(env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal) {
  return selfDefinitionRequest(env, definition, principal, "GET");
}
export async function inspectInstallableSkill(env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal, skillId: string) {
  return selfDefinitionRequest(env, definition, principal, 'GET', undefined, `skill-inspect?skillId=${encodeURIComponent(skillId)}`);
}

export async function applySelfDefinition(
  env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal, change: OwnerMateDefinitionChange
) {
  return selfDefinitionRequest(env, definition, principal, "POST", change);
}

async function selfDefinitionRequest(
  env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal,
  method: "GET" | "POST", body?: OwnerMateDefinitionChange, path = 'self-definition'
) {
  if (principal.userId !== definition.mate.ownerUserId || principal.orgId !== definition.mate.orgId) {
    throw new RuntimeHttpError(403, "mate_owner_required");
  }
  if (principal.callerKind !== "user") throw new RuntimeHttpError(403, "mate_owner_user_required");
  const token = env.MATE_RUNTIME_SERVICE_TOKEN?.trim();
  if (!token) throw new RuntimeHttpError(503, "control_plane_service_token_not_configured");
  const origin = env.APPS_CONTROL_PLANE_URL?.trim() || missingConfiguration("APPS_CONTROL_PLANE_URL");
  const url = new URL(`/internal/runtime/mates/${encodeURIComponent(definition.mate.id)}/${path}`, origin);
  const request = new Request(url, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-workspace-runtime-user-id": principal.userId,
      "x-workspace-runtime-org-id": principal.orgId,
      ...(principal.orgSlug ? { "x-workspace-runtime-org-slug": principal.orgSlug } : {})
    },
    method
  });
  const response = env.APPS_CONTROL_PLANE ? await env.APPS_CONTROL_PLANE.fetch(request) : await fetch(request);
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof payload.error === "string" ? payload.error : "mate_definition_control_plane_failed";
    throw new RuntimeHttpError(response.status, code, payload);
  }
  return payload;
}
