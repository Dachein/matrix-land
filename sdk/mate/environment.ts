export const WORKSPACE_MATE_ENVIRONMENT_SCHEMA_VERSION = "workspace.mate-environment/v1" as const;
export const WORKSPACE_MATE_ENVIRONMENT_ACCEPTED_SCHEMA_VERSION = "workspace.mate-environment-accepted/v1" as const;

export type WorkspaceMateEnvironmentContext = {
  schemaVersion: typeof WORKSPACE_MATE_ENVIRONMENT_SCHEMA_VERSION;
  /** Monotonic within one mounted SDK session. */
  revision: number;
  /** Identifies the host surface, never the authenticated principal. */
  host: {
    appId: string;
    surface: "standalone" | "embedded" | "preview" | "debug" | (string & {});
    instanceId?: string;
  };
  /** A relevance coordinate. It does not grant access to the referenced resource. */
  location: {
    kind: string;
    ref: string;
    route?: string;
  };
  ancestry?: Array<{ kind: string; ref: string }>;
  summary?: {
    label?: string;
    description?: string;
    state?: string;
    facets?: Record<string, string | number | boolean | null>;
  };
  resolutionHints?: Array<{
    capability: "app_mcp" | "knowledge" | "builtin" | (string & {});
    bindingId?: string;
    purpose?: string;
  }>;
};

export type WorkspaceAcceptedMateEnvironment = {
  schemaVersion: typeof WORKSPACE_MATE_ENVIRONMENT_ACCEPTED_SCHEMA_VERSION;
  context: WorkspaceMateEnvironmentContext;
  digest: string;
  /** Resolver evidence is verified separately and is never implied by this field. */
  trust: "host_asserted" | "ingress_derived";
};

const MAX_ENCODED_BYTES = 16 * 1024;
const SENSITIVE_KEY = /^(userId|ownerUserId|orgId|authorization|cookie|password|secret|token|credential|accessToken|refreshToken|scopes?|api[_-]?key|jwt|bearer|session(cookie|token|secret)|client[_-]?secret|private[_-]?key)$/i;

export function normalizeWorkspaceMateEnvironmentContext(value: unknown): WorkspaceMateEnvironmentContext {
  assertEncodedSize(value);
  const source = record(value, "mate_environment_invalid");
  rejectSensitiveKeys(source);
  assertKnownKeys(source, ["schemaVersion", "revision", "host", "location", "ancestry", "summary", "resolutionHints"]);
  if (source.schemaVersion !== WORKSPACE_MATE_ENVIRONMENT_SCHEMA_VERSION) throw new Error("mate_environment_schema_invalid");

  const revision = integer(source.revision, 1, Number.MAX_SAFE_INTEGER);
  if (!revision) throw new Error("mate_environment_revision_invalid");

  const hostSource = record(source.host, "mate_environment_host_invalid");
  assertKnownKeys(hostSource, ["appId", "surface", "instanceId"]);
  const appId = requiredText(hostSource.appId, 180, "mate_environment_host_app_id_invalid");
  const surface = requiredText(hostSource.surface, 80, "mate_environment_host_surface_invalid");
  const instanceId = optionalText(hostSource.instanceId, 180, "mate_environment_host_instance_id_invalid");

  const locationSource = record(source.location, "mate_environment_location_invalid");
  assertKnownKeys(locationSource, ["kind", "ref", "route"]);
  const kind = namespacedKind(locationSource.kind, "mate_environment_location_kind_invalid");
  const ref = requiredText(locationSource.ref, 500, "mate_environment_location_ref_invalid");
  const route = optionalRoute(locationSource.route);

  const ancestry = source.ancestry === undefined
    ? undefined
    : boundedArray(source.ancestry, 8, "mate_environment_ancestry_invalid", "mate_environment_ancestry_too_many").map((item) => {
        const coordinate = record(item, "mate_environment_ancestry_invalid");
        assertKnownKeys(coordinate, ["kind", "ref"]);
        return {
          kind: namespacedKind(coordinate.kind, "mate_environment_ancestry_kind_invalid"),
          ref: requiredText(coordinate.ref, 500, "mate_environment_ancestry_ref_invalid")
        };
      });

  const summarySource = source.summary === undefined
    ? undefined
    : record(source.summary, "mate_environment_summary_invalid");
  if (summarySource) assertKnownKeys(summarySource, ["label", "description", "state", "facets"]);
  const summary = summarySource ? compact({
    label: optionalText(summarySource.label, 300, "mate_environment_summary_label_invalid"),
    description: optionalText(summarySource.description, 1_000, "mate_environment_summary_description_invalid"),
    state: optionalText(summarySource.state, 100, "mate_environment_summary_state_invalid"),
    facets: normalizeFacets(summarySource.facets)
  }) : undefined;

  const resolutionHints = source.resolutionHints === undefined
    ? undefined
    : boundedArray(source.resolutionHints, 16, "mate_environment_hints_invalid", "mate_environment_hints_too_many").map((item) => {
        const hint = record(item, "mate_environment_hint_invalid");
        assertKnownKeys(hint, ["capability", "bindingId", "purpose"]);
        return compact({
          capability: namespacedKind(hint.capability, "mate_environment_hint_capability_invalid"),
          bindingId: optionalText(hint.bindingId, 180, "mate_environment_hint_binding_id_invalid"),
          purpose: optionalText(hint.purpose, 300, "mate_environment_hint_purpose_invalid")
        });
      });

  const output: WorkspaceMateEnvironmentContext = {
    schemaVersion: WORKSPACE_MATE_ENVIRONMENT_SCHEMA_VERSION,
    revision,
    host: compact({ appId, surface, instanceId }),
    location: compact({ kind, ref, route }),
    ...(ancestry ? { ancestry } : {}),
    ...(summary && Object.keys(summary).length ? { summary } : {}),
    ...(resolutionHints ? { resolutionHints } : {})
  };
  assertEncodedSize(output);
  return output;
}

export async function digestWorkspaceMateEnvironment(context: WorkspaceMateEnvironmentContext) {
  const normalized = normalizeWorkspaceMateEnvironmentContext(context);
  const bytes = new TextEncoder().encode(canonicalJson(normalized));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function acceptWorkspaceMateEnvironment(
  value: unknown
): Promise<WorkspaceAcceptedMateEnvironment> {
  const context = normalizeWorkspaceMateEnvironmentContext(value);
  return {
    schemaVersion: WORKSPACE_MATE_ENVIRONMENT_ACCEPTED_SCHEMA_VERSION,
    context,
    digest: await digestWorkspaceMateEnvironment(context),
    trust: "host_asserted"
  };
}

function normalizeFacets(value: unknown) {
  if (value === undefined) return undefined;
  const source = record(value, "mate_environment_facets_invalid");
  const entries = Object.entries(source);
  if (entries.length > 32) throw new Error("mate_environment_facets_too_many");
  return Object.fromEntries(entries.map(([key, child]) => {
    const normalizedKey = requiredText(key, 100, "mate_environment_facet_key_invalid");
    if (child !== null && typeof child !== "string" && typeof child !== "number" && typeof child !== "boolean") {
      throw new Error("mate_environment_facet_value_invalid");
    }
    if (typeof child === "number" && !Number.isFinite(child)) throw new Error("mate_environment_facet_value_invalid");
    const normalizedValue = typeof child === "string"
      ? requiredText(child, 300, "mate_environment_facet_value_invalid")
      : child;
    return [normalizedKey, normalizedValue] as const;
  }));
}

function assertEncodedSize(value: unknown) {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("mate_environment_invalid");
  }
  if (!encoded || new TextEncoder().encode(encoded).byteLength > MAX_ENCODED_BYTES) {
    throw new Error("mate_environment_too_large");
  }
}

function rejectSensitiveKeys(value: unknown, depth = 0) {
  if (depth > 8) throw new Error("mate_environment_too_deep");
  if (Array.isArray(value)) return value.forEach((child) => rejectSensitiveKeys(child, depth + 1));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) throw new Error("mate_environment_sensitive_field_forbidden");
    rejectSensitiveKeys(child, depth + 1);
  }
}

function assertKnownKeys(value: Record<string, unknown>, allowed: string[]) {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error("mate_environment_field_unknown");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function namespacedKind(value: unknown, code: string) {
  const output = requiredText(value, 160, code);
  if (!/^[a-z][a-z0-9_.-]*$/i.test(output)) throw new Error(code);
  return output;
}

function requiredText(value: unknown, max: number, code: string) {
  const output = optionalText(value, max, code);
  if (!output) throw new Error(code);
  return output;
}

function optionalText(value: unknown, max: number, code: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(code);
  const output = value.trim();
  if (!output) return undefined;
  if (output.length > max || /[\u0000-\u001f\u007f]/.test(output)) throw new Error(code);
  return output;
}

function optionalRoute(value: unknown) {
  const output = optionalText(value, 1_000, "mate_environment_route_invalid");
  if (!output) return undefined;
  if (!output.startsWith("/") || output.startsWith("//")) throw new Error("mate_environment_route_invalid");
  return output;
}

function integer(value: unknown, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : 0;
}

function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as T;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function boundedArray(value: unknown, maximum: number, invalidCode: string, limitCode: string) {
  if (!Array.isArray(value)) throw new Error(invalidCode);
  if (value.length > maximum) throw new Error(limitCode);
  return value;
}
