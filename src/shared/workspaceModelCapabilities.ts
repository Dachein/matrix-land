/**
 * LiteLLM model_info field used as the source of truth for Workspace model
 * capability assessments.
 */

export type WorkspaceCapabilityStatus = "supported" | "unsupported" | "unknown";
export type WorkspaceCapabilityKey = "image" | "search" | "file_reading";

export type WorkspaceModelCapabilityAssessment = {
  schema_version: 2;
  evaluated_at?: string;
  responses_api: WorkspaceCapabilityStatus;
  capabilities: Record<WorkspaceCapabilityKey, WorkspaceCapabilityStatus>;
};

const CAPABILITY_KEYS: WorkspaceCapabilityKey[] = ["image", "search", "file_reading"];

/** Parse the Responses-only JSON value returned in LiteLLM model_info. */
export function normalizeWorkspaceModelCapabilities(value: unknown): WorkspaceModelCapabilityAssessment | undefined {
  const source = parseObject(value);
  if (source.schema_version !== 2) return undefined;
  const rawCapabilities = asObject(source.capabilities);
  const responsesApi = normalizeStatus(source.responses_api);
  const capabilities = Object.fromEntries(CAPABILITY_KEYS.map((key) => [
    key,
    normalizeStatus(rawCapabilities[key])
  ])) as WorkspaceModelCapabilityAssessment["capabilities"];
  if (responsesApi === "unknown" && CAPABILITY_KEYS.every((key) => capabilities[key] === "unknown")) return undefined;
  const evaluatedAt = typeof source.evaluated_at === "string" ? source.evaluated_at : undefined;
  return {
    schema_version: 2,
    ...(evaluatedAt ? { evaluated_at: evaluatedAt } : {}),
    responses_api: responsesApi,
    capabilities
  };
}

export function isWorkspaceModelCapabilityAssessmentComplete(value: unknown) {
  const assessment = normalizeWorkspaceModelCapabilities(value);
  if (!assessment || assessment.responses_api === "unknown") return false;
  if (assessment.responses_api === "unsupported") return true;
  return CAPABILITY_KEYS.every((key) => assessment.capabilities[key] !== "unknown");
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asObject(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeStatus(value: unknown): WorkspaceCapabilityStatus {
  return value === "supported" || value === "unsupported" ? value : "unknown";
}
