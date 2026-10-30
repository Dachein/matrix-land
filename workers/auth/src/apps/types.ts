import type { AppClient, WorkspaceUser } from "../types.ts";

// App access and launch request payloads.
export type DirectJumpBody = {
  app?: AppClient;
  appId?: string;
  grantStatus?: "approved" | "pending" | "rejected" | "revoked";
  redirectUrl?: string;
  user?: WorkspaceUser;
};

export type VerifyBody = {
  appId?: string;
  token?: string;
};

export type AppLaunchExchangeBody = {
  appId?: string;
  clientId?: string;
  code?: string;
  redirectUri?: string;
};
