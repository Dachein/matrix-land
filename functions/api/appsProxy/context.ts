type AppsProxyEnv = {
  APPS_ORG_ID?: string;
  APPS_ORG_SLUG?: string;
  APPS_WORKER_URL?: string;
};

type AppsProxyUser = {
  team: string;
};

export function appsWorkerBaseUrl(env: AppsProxyEnv) {
  return (env.APPS_WORKER_URL?.trim() || "http://127.0.0.1:8791").replace(/\/+$/, "");
}

export function appsOrgContext(env: AppsProxyEnv, currentUser: AppsProxyUser) {
  const orgId = readOptionalString(env.APPS_ORG_ID) ?? slugify(currentUser.team) ?? currentUser.team;
  const orgSlug = readOptionalString(env.APPS_ORG_SLUG) ?? slugify(orgId) ?? orgId;
  return { orgId, orgSlug };
}

function readOptionalString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : undefined;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
