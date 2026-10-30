import { basicClientCredentials, requireAppClientAuthentication, resolveAppClient } from "../apps/clients.ts";
import { evaluateAppAccess } from "../policy.ts";
import { listAuthUsers } from "../repositories/users/reads.ts";
import { readGrantStatus } from "../repositories/grants.ts";
import { type AppClient, type Env, type WorkspaceUser, HttpError } from "../types.ts";

// App-scoped directory permission checks and response shaping.
export async function requireDirectoryApp(request: Request, env: Env) {
  const credentials = basicClientCredentials(request);
  if (!credentials?.clientId) {
    throw new HttpError(401, "app_client_authentication_required");
  }
  const app = await resolveAppClient(env, credentials.clientId);
  await requireAppClientAuthentication(request, env, app.id);
  if (app.sdkStatus !== "connected") {
    throw new HttpError(403, "app_directory_sdk_not_connected");
  }
  return app;
}

export async function eligibleAppDirectoryPeople(
  env: Env,
  app: AppClient,
  input: {
    departmentId?: string;
    includeDescendants?: boolean;
    limit?: number;
    q?: string;
  }
) {
  const candidates = await listAuthUsers(env, {
    departmentId: input.departmentId,
    includeDescendants: input.includeDescendants,
    limit: input.limit ?? 1000,
    q: input.q,
    statuses: ["active"]
  });
  if (app.directoryReadScope === "company") {
    return candidates;
  }
  const decisions = await Promise.all(candidates.map(async (user) => evaluateAppAccess({
    action: "launch",
    app,
    grantStatus: app.accessMode === "request" ? await readGrantStatus(env, app.id, user.id) : undefined,
    user
  })));
  return candidates.filter((_user, index) => decisions[index].decision === "allow");
}

export function directoryPerson(user: WorkspaceUser) {
  return {
    department: user.department,
    departmentId: user.departmentId,
    departmentPath: user.departmentPath ?? [],
    email: user.email,
    id: user.id,
    jobTitle: user.jobTitle,
    name: user.name,
    team: user.team,
    teamId: user.teamId,
    teamPath: user.teamPath ?? []
  };
}
