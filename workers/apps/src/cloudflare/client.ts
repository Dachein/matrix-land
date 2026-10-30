import { HttpError, type Env } from "../core/types";
import { readString } from "../core/utils";

export type CloudflareApiPayload<T> = {
  errors?: Array<{ code?: number | string; message?: string }>;
  messages?: Array<{ code?: number | string; message?: string } | string>;
  result?: T;
  success?: boolean;
};

export function requireCloudflareAccountId(env: Env) {
  const accountId = readString(env.CF_ACCOUNT_ID).trim();
  if (!accountId) {
    throw new HttpError(503, "cloudflare_account_not_configured");
  }
  return accountId;
}

export function requireCloudflareZoneId(env: Env) {
  const zoneId = readString(env.CF_ZONE_ID).trim();
  if (!zoneId) {
    throw new HttpError(503, "cloudflare_zone_not_configured");
  }
  return zoneId;
}

export async function cloudflareFetch<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const response = await cloudflareApiResponse(env, path, init);
  const payload = await response.json().catch(() => ({})) as CloudflareApiPayload<T>;

  if (payload.success === false) {
    logCloudflareApiError(path, init, response.status, payload);
    throw cloudflareHttpError(path, init, response.status, payload);
  }

  return payload.result as T;
}

export async function cloudflareOptionalFetch<T>(env: Env, path: string, init: RequestInit = {}): Promise<T | undefined> {
  const response = await cloudflareApiResponse(env, path, init, { allowNotFound: true });
  if (response.status === 404) {
    return undefined;
  }
  const payload = await response.json().catch(() => ({})) as CloudflareApiPayload<T>;
  if (payload.success === false) {
    logCloudflareApiError(path, init, response.status, payload);
    throw cloudflareHttpError(path, init, response.status, payload);
  }
  return payload.result as T;
}

export async function cloudflareApiResponse(
  env: Env,
  path: string,
  init: RequestInit = {},
  options: { allowNotFound?: boolean } = {}
): Promise<Response> {
  const token = readString(env.CF_API_TOKEN).trim();
  if (!token) {
    throw new HttpError(503, "cloudflare_api_token_not_configured");
  }

  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const body = init.body;
  if (body != null && !headers.has("Content-Type") && shouldDefaultJsonContentType(body)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers
  });

  if (options.allowNotFound && response.status === 404) {
    return response;
  }
  if (!response.ok) {
    const payload = await response.clone().json().catch(() => ({})) as CloudflareApiPayload<unknown>;
    logCloudflareApiError(path, init, response.status, payload);
    throw cloudflareHttpError(path, init, response.status, payload);
  }
  return response;
}

function cloudflareHttpError(
  path: string,
  init: RequestInit,
  status: number,
  payload: CloudflareApiPayload<unknown>
) {
  return new HttpError(status >= 400 ? status : 502, cloudflareErrorCode(status, payload), {
    cloudflare: {
      message: cloudflareErrorMessage(payload),
      method: readString(init.method || "GET").toUpperCase(),
      path,
      status
    }
  });
}

function shouldDefaultJsonContentType(body: BodyInit) {
  return typeof body === "string";
}

function cloudflareErrorMessage(payload: CloudflareApiPayload<unknown>, fallback = "cloudflare_api_error") {
  const errors = payload.errors
    ?.map((error) => [error.code, error.message].filter(Boolean).join(" "))
    .filter(Boolean);
  if (errors?.length) {
    return errors.join("; ");
  }
  const messages = payload.messages
    ?.map((message) => typeof message === "string" ? message : [message.code, message.message].filter(Boolean).join(" "))
    .filter(Boolean);
  return messages?.join("; ") || fallback;
}

function cloudflareErrorCode(status: number, payload: CloudflareApiPayload<unknown>) {
  if (status === 401) {
    return "cloudflare_api_auth_failed";
  }
  if (status === 403) {
    return "cloudflare_api_forbidden";
  }
  if (status === 404) {
    return "cloudflare_api_not_found";
  }
  return `cloudflare_api_${status || "error"}`;
}

function logCloudflareApiError(path: string, init: RequestInit, status: number, payload: CloudflareApiPayload<unknown>) {
  console.warn("cloudflare_api_error", {
    method: readString(init.method || "GET").toUpperCase(),
    path,
    status,
    message: cloudflareErrorMessage(payload)
  });
}
