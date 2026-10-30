import { type AppClient, HttpError } from "../types.ts";
import { readOptionalString } from "../values.ts";

// Validate registered app callbacks and launch destinations.
export function validateRedirectUrl(app: AppClient, redirectUrl?: string) {
  const requested = readOptionalString(redirectUrl);

  if (!requested) {
    return app.launchUrl;
  }

  if (!app.launchUrl) {
    return requested;
  }

  const launch = new URL(app.launchUrl);
  const redirect = new URL(requested);

  if (launch.origin !== redirect.origin) {
    throw new HttpError(400, "redirect_origin_mismatch");
  }

  return redirect.toString();
}

export function assertCallbackAllowed(app: AppClient, callbackUrl: string) {
  const allowed = app.callbackUrls ?? [];

  if (allowed.length === 0) {
    throw new HttpError(409, "app_callback_not_configured");
  }

  const requested = new URL(callbackUrl).toString();
  const match = allowed.some((value) => new URL(value).toString() === requested);

  if (!match) {
    throw new HttpError(400, "callback_not_allowed");
  }
}

export function buildDirectJumpUrl(callbackUrl: string, appId: string, token: string, redirectUrl?: string) {
  const url = new URL(callbackUrl);
  url.searchParams.set("workspace_token", token);
  url.searchParams.set("app_id", appId);
  if (redirectUrl) {
    url.searchParams.set("redirect_url", redirectUrl);
  }
  return url.toString();
}

export function firstCallbackUrl(app: AppClient) {
  return app.callbackUrls?.[0];
}

export function sameCallbackUrl(left: string | undefined, right: string) {
  if (!left) {
    return false;
  }
  return new URL(left).toString() === new URL(right).toString();
}
