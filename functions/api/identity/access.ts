import { HttpError } from "../http.ts";
import { resolveCurrentUser } from "./currentUser.ts";
import type { CurrentUser, IdentityContext, IdentityEnv } from "./types.ts";

export async function requireAdminPortalUser<TEnv extends IdentityEnv>(context: IdentityContext<TEnv>): Promise<CurrentUser> {
  const currentUser = await resolveCurrentUser(context);

  if (currentUser.role !== "admin") {
    throw new HttpError(403, "admin_required");
  }

  return currentUser;
}
