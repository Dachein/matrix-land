import type { PortalCatalog } from "../../../src/shared/types.ts";
import { appsOrgContext } from "./context.ts";
import { APPS_READ_SCOPES, sanitizeAppsScopes } from "./scopes.ts";

type CurrentUser = PortalCatalog["currentUser"];

type AppsTokenEnv = {
  APPS_JWT_SECRET?: string;
  APPS_ORG_ID?: string;
  APPS_ORG_SLUG?: string;
  PORTAL_ISSUER?: string;
  TOKEN_TTL_SECONDS?: string;
};

type AppsTokenContext<TEnv extends AppsTokenEnv> = EventContext<TEnv, string, unknown>;

type AppsTokenDeps<TEnv extends AppsTokenEnv> = {
  audit(
    db: D1Database | undefined,
    actorType: string,
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>
  ): Promise<string>;
  getTtlSeconds(env: TEnv): number;
  readBody<T>(request: Request): Promise<T>;
  resolveCurrentUser(context: AppsTokenContext<TEnv>): Promise<CurrentUser>;
  signAppsToken(env: TEnv, payload: Record<string, unknown>): Promise<string>;
};

export function createAppsTokenApi<TEnv extends AppsTokenEnv & { DB?: D1Database }>(deps: AppsTokenDeps<TEnv>) {
  return {
    async issueAppsToken(context: AppsTokenContext<TEnv>) {
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<{
        appId?: string;
        skillId?: string;
        toolId?: string;
        scopes?: string[];
      }>(context.request);
      const scopes = sanitizeAppsScopes(body.scopes, APPS_READ_SCOPES);
      const expiresAt = Math.floor(Date.now() / 1000) + Math.min(deps.getTtlSeconds(context.env), 900);
      const { orgId, orgSlug } = appsOrgContext(context.env, currentUser);
      const token = await deps.signAppsToken(context.env, {
        typ: "apps_access",
        iss: context.env.PORTAL_ISSUER ?? "frontier-workspace",
        sub: currentUser.id,
        org_id: orgId,
        org_slug: orgSlug,
        provider: currentUser.identity.provider,
        oid: currentUser.identity.objectId,
        tid: currentUser.identity.tenantId,
        email: currentUser.email,
        name: currentUser.name,
        platform_role: currentUser.role,
        department_id: currentUser.departmentId,
        department_path: currentUser.departmentPath ?? [],
        app_id: body.appId,
        skill_id: body.skillId,
        tool_id: body.toolId,
        scopes,
        exp: expiresAt
      });

      await deps.audit(context.env.DB, "user", currentUser.id, "issued apps token", "apps", body.toolId ?? body.skillId ?? body.appId ?? "portal", {
        appId: body.appId,
        skillId: body.skillId,
        scopes,
        expiresAt
      });

      return {
        token,
        tokenType: "Bearer",
        expiresAt,
        scopes
      };
    }
  };
}
