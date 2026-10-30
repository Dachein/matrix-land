import type { ModelHealthResponse } from "./types";

export async function loadModelHealth(limit: number, fetcher: typeof fetch = fetch): Promise<ModelHealthResponse> {
  const response = await fetcher(`/api/llm-gateway/model-health?limit=${encodeURIComponent(limit)}`);
  const payload = await readJson(response);
  if (!response.ok || !isModelHealthResponse(payload)) {
    throw new Error(readError(payload) || `model_health_load_failed_${response.status}`);
  }
  return payload;
}

function isModelHealthResponse(value: unknown): value is ModelHealthResponse {
  const root = objectValue(value);
  return Array.isArray(root.runs)
    && Array.isArray(root.models)
    && typeof objectValue(root.schedule).timezone === "string"
    && typeof objectValue(root.summary).status === "string";
}

async function readJson(response: Response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function readError(value: unknown) {
  const root = objectValue(value);
  return typeof root.error === "string" ? root.error : "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
