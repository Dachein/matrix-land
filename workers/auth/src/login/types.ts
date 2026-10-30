import type { AuthLoginCandidate, AuthLoginResolution } from "../repositories/users/login.ts";
import type { WorkspaceUser } from "../types.ts";

// Login provider and confirmation payload types.
export type EmailOtpRequestBody = {
  email?: string;
  redirect?: string;
  returnTo?: string;
};

export type EmailOtpVerifyBody = {
  challengeId?: string;
  code?: string;
  redirect?: string;
};

export type EntraTokenResponse = {
  access_token?: string;
  expires_in?: number;
  id_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export type EntraGraphProfile = {
  id?: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
  department?: string;
  jobTitle?: string;
};

export type OAuthStatePayload = {
  linkUserId?: string;
  typ?: string;
  state?: string;
  nonce?: string;
  verifier?: string;
  redirectPath?: string;
  returnTo?: string;
  exp?: number;
};

export type LoginConfirmationPayload = {
  typ?: string;
  candidates?: AuthLoginCandidate[];
  identity?: {
    avatarUrl?: string;
    objectId?: string;
    principalName?: string;
    provider?: string;
    tenantId?: string;
  };
  reason?: AuthLoginResolution extends { reason: infer Reason } ? Reason : string;
  redirectPath?: string;
  requestId?: string;
  returnTo?: string;
  runtimeUser?: WorkspaceUser;
  exp?: number;
};

export type EntraJsonWebKey = JsonWebKey & {
  kid?: string;
};
