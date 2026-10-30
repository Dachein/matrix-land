// Own session cookie transport and redirect responses.
export function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie");

  if (!cookie) {
    return undefined;
  }

  return cookie
    .split(";")
    .map((part) => part.trim())
    .map((part) => {
      const separatorIndex = part.indexOf("=");
      return separatorIndex < 0 ? [part, ""] : [part.slice(0, separatorIndex), part.slice(separatorIndex + 1)];
    })
    .find(([key]) => key === name)?.[1];
}

export function cookieHeader(
  name: string,
  value: string,
  request: Request,
  options: { maxAge: number; sameSite: "Lax" | "Strict" | "None" }
) {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${options.sameSite}`,
    `Max-Age=${options.maxAge}`
  ];

  if (new URL(request.url).protocol === "https:") {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

export function clearCookieHeader(name: string, request: Request) {
  const attributes = [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];

  if (new URL(request.url).protocol === "https:") {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

export function redirect(location: string, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "no-store");
  }
  headers.set("location", location);
  if (!headers.has("referrer-policy")) {
    headers.set("referrer-policy", "no-referrer");
  }

  return new Response(null, {
    ...init,
    status: init.status ?? 302,
    headers
  });
}
