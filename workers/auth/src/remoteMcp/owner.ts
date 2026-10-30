import { HttpError, type Env } from '../types.ts';

/** Session and service credentials authenticate transport, never Mate ownership. */
export async function requireMateOwner(env: Env, orgId: string, userId: string, mateId: string) {
  if (!env.APPS_CONTROL_PLANE || !env.MATE_MCP_SERVICE_TOKEN) throw new HttpError(503, 'mate_owner_check_unavailable');
  const request = new Request(`https://apps.internal/internal/mate-plugins/${encodeURIComponent(mateId)}/owner`, {
    headers: { Authorization: `Bearer ${env.MATE_MCP_SERVICE_TOKEN}`,
      'x-workspace-runtime-user-id': userId, 'x-workspace-runtime-org-id': orgId },
    signal: AbortSignal.timeout(10_000)
  });
  const response = await env.APPS_CONTROL_PLANE.fetch(request);
  if (!response.ok) throw new HttpError(response.status === 404 || response.status === 403 ? 403 : 503,
    response.status === 404 || response.status === 403 ? 'mate_owner_required' : 'mate_owner_check_unavailable');
  const data = await response.json() as { owner?: boolean; mateId?: string };
  if (data.owner !== true || data.mateId !== mateId) throw new HttpError(403, 'mate_owner_required');
}
