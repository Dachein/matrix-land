import type { AuthenticationMethod, IdentityProvider, PortalCatalog, UserRole } from "../../../src/shared/types.ts";

export type CurrentUser = PortalCatalog["currentUser"];

export type AuthPrincipal = {
  defaultAgent?: import("../../../sdk/auth/types.ts").DefaultAgentInfo | null;
  userId: string;
  email: string;
  name: string;
  avatarUrl?: string;
  team?: string;
  department?: string;
  departmentDisplayPath?: string;
  departmentId?: string;
  departmentPath?: string[];
  jobTitle?: string;
  role: UserRole;
  identity: {
    authenticationMethod?: AuthenticationMethod;
    provider: IdentityProvider;
    tenantId: string;
    objectId: string;
    principalName: string;
  };
};

export type IdentityEnv = {
  AUTH_WORKER_URL?: string;
  DB?: D1Database;
  DEFAULT_TEAM_ID?: string;
  DEFAULT_TEAM_NAME?: string;
  LITELLM_MASTER_KEY?: string;
  LITELLM_PROVISIONING_KEY?: string;
  LITELLM_URL?: string;
};

export type IdentityContext<TEnv extends IdentityEnv> = EventContext<TEnv, string, unknown>;

export type { IdentityProvider, UserRole };
