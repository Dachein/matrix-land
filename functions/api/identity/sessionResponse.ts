import { isPortalAuthConfigured, readAuthWorkerSession } from "./authSessionClient.ts";
import { resolveCurrentUserFromAuthPrincipal } from "./currentUser.ts";
import type { IdentityContext, IdentityEnv } from "./types.ts";

export async function readAuthSession<TEnv extends IdentityEnv>(context: IdentityContext<TEnv>) {
  const configured = isPortalAuthConfigured(context.env);
  const emailLoginUrl = "/auth/email/login";
  const loginUrl = "/auth/login";
  const logoutUrl = "/auth/logout";

  if (!configured) {
    return {
      configured,
      authenticated: false,
      emailLoginConfigured: false,
      emailLoginUrl,
      loginUrl,
      logoutUrl
    };
  }

  const authWorkerSession = await readAuthWorkerSession(context.request, context.env);
  const common = {
    configured,
    emailLoginConfigured: authWorkerSession.emailLoginConfigured,
    emailLoginUrl: authWorkerSession.emailLoginUrl,
    loginUrl,
    logoutUrl
  };

  if (!authWorkerSession.principal) {
    return { ...common, authenticated: false };
  }

  const user = await resolveCurrentUserFromAuthPrincipal(context, authWorkerSession.principal);
  return { ...common, authenticated: true, user };
}
