import { authPublicUrl, authPublicUrlFromRequest, issuer } from "../configuration.ts";
import type { Env } from "../types.ts";
import { readString } from "../values.ts";

// Validate login navigation targets against registered return destinations.
export function normalizeRedirectPath(value: string) {
  const trimmed = value.trim();

  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return "/home";
  }

  return trimmed.slice(0, 160);
}

export function normalizeLoginReturnTo(request: Request, env: Env, value: unknown) {
  const text = readString(value).trim();
  if (!text || text.length > 1400) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(text, authPublicUrlFromRequest(request));
  } catch {
    return undefined;
  }

  const publicOrigins = new Set(
    [authPublicUrl(env), authPublicUrlFromRequest(request)]
      .map((origin) => {
        try {
          return new URL(origin).origin;
        } catch {
          return "";
        }
      })
      .filter(Boolean)
  );

  if (publicOrigins.has(url.origin) && (url.pathname === "/auth/v1/authorize" || url.pathname === "/auth/mcp/oauth/authorize")) {
    return url.toString();
  }

  try {
    const issuerOrigin = new URL(issuer(env)).origin;
    if (url.origin === issuerOrigin && url.pathname === "/v1/authorize") {
      return url.toString();
    }
  } catch {
    // Ignore malformed issuer configuration and reject the return URL below.
  }

  return undefined;
}
