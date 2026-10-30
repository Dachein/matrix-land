import { hashAppSecret, readAppClient, readAppClientSecretHash } from "../repositories/apps.ts";
import { readGrantStatus } from "../repositories/grants.ts";
import { requireServiceToken, safeEqual } from "../serviceAuthorization.ts";
import { type AppClient, type Env, HttpError, type ResourceClient } from "../types.ts";
import { requireText } from "../values.ts";
import type { DirectJumpBody } from "./types.ts";

// Own registered app-client resolution and client authentication.
export async function resolveRequestApp(request: Request, env: Env, body: DirectJumpBody) {
  requireServiceToken(request, env);
  const appId = requireText(body.appId ?? body.app?.id, "missing_app_id", 160);
  return resolveAppClient(env, appId);
}

export async function resolveRequestGrantStatus(request: Request, env: Env, _body: DirectJumpBody, appId: string, userId: string) {
  requireServiceToken(request, env);
  return readGrantStatus(env, appId, userId);
}

export async function resolveAppClient(env: Env, appId: string) {
  const app = await readAppClient(env, appId);

  if (!app) {
    throw new HttpError(404, "app_client_not_found");
  }

  return app;
}

export function appClientFromResource(resource: ResourceClient): AppClient {
  return {
    id: resource.id,
    name: resource.name,
    status: resource.status,
    sdkStatus: "connected",
    accessMode: resource.accessMode ?? "public",
    accessTargets: resource.accessTargets ?? [],
    collaboratorUserIds: resource.collaboratorUserIds ?? [],
    publisherUserId: resource.publisherUserId,
    businessOwnerUserId: resource.businessOwnerUserId,
    systemRolePolicyVersion: resource.systemRolePolicyVersion
  };
}

export async function requireAppClientAuthentication(request: Request, env: Env, appId: string) {
  const expectedHash = await readAppClientSecretHash(env, appId);

  if (!expectedHash) {
    throw new HttpError(401, "app_client_authentication_required");
  }

  const credentials = basicClientCredentials(request);
  if (!credentials || credentials.clientId !== appId) {
    throw new HttpError(401, "invalid_app_client_authentication");
  }

  const actualHash = await hashAppSecret(credentials.clientSecret);
  if (!safeEqual(actualHash, expectedHash)) {
    throw new HttpError(401, "invalid_app_client_authentication");
  }
}

export function basicClientCredentials(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Basic\s+(.+)$/i);
  if (!match) {
    return undefined;
  }

  try {
    const decoded = atob(match[1]);
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex < 0) {
      return undefined;
    }
    return {
      clientId: decoded.slice(0, separatorIndex),
      clientSecret: decoded.slice(separatorIndex + 1)
    };
  } catch {
    return undefined;
  }
}
