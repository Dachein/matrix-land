import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimePrincipal } from './types.ts';

export async function readInstalledSkillFile(env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal, skillId: string, path: string) {
  if (!env.MATE_RUNTIME_SERVICE_TOKEN) throw new RuntimeHttpError(503, 'control_plane_service_token_not_configured');
  const url = new URL(`/internal/runtime/mates/${encodeURIComponent(definition.mate.id)}/skill-file`, env.APPS_CONTROL_PLANE_URL || missingConfiguration("APPS_CONTROL_PLANE_URL"));
  url.search = new URLSearchParams({ skillId, path, releaseId: definition.release.id }).toString();
  const request = new Request(url, { headers: { Authorization: `Bearer ${env.MATE_RUNTIME_SERVICE_TOKEN}`,
    'x-workspace-runtime-user-id': principal.userId, 'x-workspace-runtime-org-id': principal.orgId,
    ...(principal.email ? { 'x-workspace-runtime-user-email': principal.email } : {}) }, signal: AbortSignal.timeout(15_000) });
  const response = env.APPS_CONTROL_PLANE ? await env.APPS_CONTROL_PLANE.fetch(request) : await fetch(request);
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new RuntimeHttpError(response.status, result.error || 'mate_skill_file_read_failed');
  return result;
}
