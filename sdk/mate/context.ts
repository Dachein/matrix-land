export const WORKSPACE_MATE_HOST_SCHEMA_VERSION = "workspace.mate-host/v1" as const;

export type WorkspaceMateHostContext = {
  schemaVersion: typeof WORKSPACE_MATE_HOST_SCHEMA_VERSION;
  appId: string;
  page: { route: string; title?: string };
  resources: Array<{ type: string; id: string }>;
  allowedActions?: string[];
};

export function normalizeWorkspaceMateHostContext(value: unknown): WorkspaceMateHostContext {
  const source = record(value);
  rejectSensitiveKeys(source);
  if (source.schemaVersion !== WORKSPACE_MATE_HOST_SCHEMA_VERSION) throw new Error("mate_host_schema_invalid");
  const appId = identifier(source.appId, 180);
  if (!appId) throw new Error("mate_host_app_id_invalid");
  const page = record(source.page);
  const route = text(page.route).slice(0, 1000);
  if (!route.startsWith("/") || route.startsWith("//")) throw new Error("mate_host_route_invalid");
  const resources = array(source.resources).slice(0, 50).map((value) => {
    const resource = record(value);
    const type = identifier(resource.type, 100);
    const id = identifier(resource.id, 500);
    if (!type || !id) throw new Error("mate_host_resource_invalid");
    return { type, id };
  });
  const allowedActions = source.allowedActions === undefined
    ? undefined
    : Array.from(new Set(array(source.allowedActions).map((action) => identifier(action, 160)).filter(Boolean))).slice(0, 100);
  return {
    schemaVersion: WORKSPACE_MATE_HOST_SCHEMA_VERSION,
    appId,
    page: { route, ...(text(page.title) ? { title: text(page.title).slice(0, 300) } : {}) },
    resources,
    ...(allowedActions ? { allowedActions } : {})
  };
}

function rejectSensitiveKeys(value: unknown, depth = 0) {
  if (depth > 8) throw new Error("mate_host_context_too_deep");
  if (Array.isArray(value)) {
    value.forEach((child) => rejectSensitiveKeys(child, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(userId|ownerUserId|orgId|authorization|cookie|password|secret|token|credential)$/i.test(key)) {
      throw new Error("mate_host_sensitive_field_forbidden");
    }
    rejectSensitiveKeys(child, depth + 1);
  }
}

function identifier(value: unknown, max: number) {
  const output = text(value).trim().slice(0, max);
  return output && !/[\u0000-\u001f\u007f]/.test(output) ? output : "";
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
