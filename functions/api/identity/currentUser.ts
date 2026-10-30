import { HttpError } from "../http.ts";
import { readAuthWorkerSessionPrincipal, requireAuthWorkerConfigured } from "./authSessionClient.ts";
import { syncPortalCurrentUser } from "./portalUserSync.ts";
import type { AuthPrincipal, CurrentUser, IdentityContext, IdentityEnv } from "./types.ts";

export async function resolveCurrentUser<TEnv extends IdentityEnv>(context: IdentityContext<TEnv>): Promise<CurrentUser> {
  requireAuthWorkerConfigured(context.env);

  const principal = await readAuthWorkerSessionPrincipal(context.request, context.env);

  if (!principal) {
    throw new HttpError(401, "not_authenticated");
  }

  return resolveCurrentUserFromAuthPrincipal(context, principal);
}

export async function resolveCurrentUserFromAuthPrincipal<TEnv extends IdentityEnv>(
  context: IdentityContext<TEnv>,
  principal: AuthPrincipal
): Promise<CurrentUser> {
  const currentUser = currentUserFromAuthPrincipal(principal, context.env);

  if (!context.env.DB) {
    return currentUser;
  }

  return syncPortalCurrentUser(context.env.DB, principal, currentUser, context.env);
}

export function currentUserFromAuthPrincipal(principal: AuthPrincipal, env: IdentityEnv): CurrentUser {
  return {
    defaultAgent: principal.defaultAgent ?? null,
    id: principal.userId,
    name: principal.name,
    email: principal.email,
    avatarUrl: principal.avatarUrl,
    team: principal.team || "",
    department: principal.department,
    ...(principal.departmentDisplayPath ? { departmentDisplayPath: principal.departmentDisplayPath } : {}),
    departmentId: principal.departmentId,
    departmentPath: principal.departmentPath,
    jobTitle: "",
    role: principal.role,
    roles: principal.role === "admin" ? ["admin"] : [],
    identity: principal.identity
  };
}
