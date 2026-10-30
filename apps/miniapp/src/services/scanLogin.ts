const TICKET = /^[A-Za-z0-9_-]{20,80}$/;
const ALLOWED_URL = /^https:\/\/(?:ai\.example-org\.com|auth\.example-org\.app)\/(?:auth\/miniapp\/(?:login|scan))(?:\?([^#]*))?$/;

export function scanLoginTicket(value: { path?: string; result?: string }) {
  const pathTicket = miniappPathTicket(value.path || "");
  if (pathTicket) return pathTicket;

  const result = (value.result || "").trim();
  const opaque = result.match(/^workspace-miniapp-login:([A-Za-z0-9_-]{20,80})$/)?.[1];
  if (opaque) return opaque;

  const query = result.match(ALLOWED_URL)?.[1];
  const ticket = queryValue(query || "", "ticket");
  return TICKET.test(ticket) ? ticket : "";
}

function miniappPathTicket(path: string) {
  const [pathname, query = ""] = path.split("?", 2);
  if (pathname !== "pages/login/index" && pathname !== "/pages/login/index") return "";
  const ticket = queryValue(query, "scene") || queryValue(query, "ticket");
  return TICKET.test(ticket) ? ticket : "";
}

function queryValue(query: string, key: string) {
  for (const part of query.split("&")) {
    const [rawKey, rawValue = ""] = part.split("=", 2);
    if (decode(rawKey) === key) return decode(rawValue);
  }
  return "";
}

function decode(value: string) {
  try { return decodeURIComponent(value.replace(/\+/g, "%20")); } catch { return ""; }
}
