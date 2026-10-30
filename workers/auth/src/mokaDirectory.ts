import { resolveMokaLoginUser } from "./mokaSync.ts";
import type { Env, WorkspaceUser } from "./types.ts";

/**
 * Enrich an authenticated Workspace identity from Moka using its normalized work
 * email as the sole cross-system key. Workspace's own id, role, and grants remain
 * local and are never replaced by a Moka identifier.
 */
export async function resolveMokaDirectoryUser(env: Env, user: WorkspaceUser): Promise<WorkspaceUser> {
  return (await resolveMokaLoginUser(env, user)).user;
}

export { resolveMokaLoginUser } from "./mokaSync.ts";
