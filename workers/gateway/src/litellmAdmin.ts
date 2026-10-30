import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import type { Env } from "./types.ts";

// Shared transport contract for model discovery and usage snapshot collection.
export function createLiteLlmAdminClient(env: Pick<Env, "LITELLM_URL" | "LITELLM_PROVISIONING_KEY">, fetchImpl: typeof fetch = fetch) {
  const baseUrl = (env.LITELLM_URL?.trim() || missingConfiguration("LITELLM_URL")).replace(/\/+$/, "");
  const provisioningKey = env.LITELLM_PROVISIONING_KEY?.trim();
  if (!provisioningKey) {
    throw new Error("litellm_provisioning_key_not_configured");
  }

  return async function adminJson(path: string) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${provisioningKey}`,
        Accept: "application/json"
      }
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`litellm_admin_request_failed:${response.status}`);
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("litellm_invalid_json");
    }
  };
}
