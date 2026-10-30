export function portalLoginUrl(
  loginUrl: string,
  currentHash: string,
  origin: string,
  returnTo?: string
) {
  const target = new URL(loginUrl, origin);
  const route = portalRedirectRoute(currentHash);
  target.searchParams.set("redirect", route);
  if (returnTo) {
    target.searchParams.set("return_to", returnTo);
  }
  return target.toString();
}

export function portalAuthReturnTo(search: string, origin: string) {
  const value = new URLSearchParams(search).get("return_to")?.trim();
  if (!value || value.length > 1_400) {
    return undefined;
  }

  try {
    const target = new URL(value);
    const portalOrigin = new URL(origin).origin;
    if (
      target.origin === portalOrigin
      && (target.pathname === "/auth/v1/authorize" || target.pathname === "/auth/mcp/oauth/authorize")
    ) {
      return target.toString();
    }
  } catch {
    // Invalid or untrusted return targets fall back to the normal Portal route.
  }

  return undefined;
}

export function portalRedirectRoute(rawHash: string) {
  const rawRoute = rawHash.replace(/^#/, "").trim();
  if (!rawRoute || !rawRoute.startsWith("/") || rawRoute.startsWith("//")) {
    return "/home";
  }

  return rawRoute.slice(0, 1_000);
}
