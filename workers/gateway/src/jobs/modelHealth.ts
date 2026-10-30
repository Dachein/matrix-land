import { missingConfiguration } from "../../../../src/shared/requiredConfiguration.ts";
import {
  beginModelHealthRun,
  completeModelHealthRun,
  deleteOldModelHealthRuns,
  failModelHealthRun,
  replaceModelHealthResults,
  type ModelHealthResultInput
} from "../../../../functions/api/llmGateway/modelHealth.ts";
import {
  normalizeLiteLlmVisibleModelEntries,
  readLiteLlmDataArray
} from "../../../../functions/api/llmGateway/litellm.ts";
import type { Env } from "../types.ts";

type HealthModel = {
  id: string;
  displayName: string;
  defaultVendor: string;
  supported: boolean;
};

type HealthDependencies = {
  fetch?: typeof fetch;
  clock?: () => Date;
};

export async function runModelHealthCheck(
  env: Env,
  scheduledAt: Date,
  dependencies: HealthDependencies = {}
) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const clock = dependencies.clock ?? (() => new Date());
  const slotLocal = shanghaiSlot(scheduledAt);
  const runId = `model-health:${slotLocal}`;
  const inserted = await beginModelHealthRun(env.DB, {
    id: runId,
    scheduledAt: scheduledAt.toISOString(),
    slotLocal,
    startedAt: clock().toISOString()
  });

  if ((inserted.meta?.changes ?? 0) === 0) {
    return { runId, skipped: true };
  }

  try {
    const models = await loadModels(env, fetchImpl);
    if (models.length === 0) {
      throw new Error("model_health_catalog_empty");
    }

    const results = await mapWithConcurrency(
      models,
      configuredInteger(env.MODEL_HEALTH_CONCURRENCY, 5, 1, 12),
      (model) => probeModel(env, model, fetchImpl, clock)
    );
    await replaceModelHealthResults(env.DB, runId, results);

    const operationalCount = results.filter((result) => result.status === "operational").length;
    const degradedCount = results.filter((result) => result.status === "degraded").length;
    const failedCount = results.filter((result) => result.status === "failed").length;
    const status = failedCount === 0 && degradedCount === 0
      ? "operational"
      : operationalCount === 0 && degradedCount === 0
        ? "outage"
        : "degraded";

    await completeModelHealthRun(env.DB, {
      id: runId,
      status,
      modelCount: results.length,
      operationalCount,
      degradedCount,
      failedCount,
      completedAt: clock().toISOString()
    });
    await deleteOldModelHealthRuns(
      env.DB,
      new Date(scheduledAt.getTime() - 90 * 86_400_000).toISOString()
    );

    return {
      runId,
      skipped: false,
      status,
      modelCount: results.length,
      operationalCount,
      degradedCount,
      failedCount
    };
  } catch (error) {
    await failModelHealthRun(env.DB, {
      id: runId,
      completedAt: clock().toISOString(),
      errorCode: healthErrorCode(error)
    });
    throw error;
  }
}

async function loadModels(env: Env, fetchImpl: typeof fetch): Promise<HealthModel[]> {
  const baseUrl = gatewayBaseUrl(env);
  const provisioningKey = env.LITELLM_PROVISIONING_KEY?.trim();
  if (!provisioningKey) {
    throw new Error("litellm_health_probe_token_not_configured");
  }
  // Use the unified provisioning credential for the OpenAI-compatible catalog
  // and probe calls. There is intentionally no user-token fallback: a missing
  // or misconfigured provisioning key must fail loudly instead of masking a
  // production secret migration problem.
  const catalogPath = "/v1/models";
  const response = await fetchImpl(`${baseUrl}${catalogPath}`, {
    headers: { Authorization: `Bearer ${provisioningKey}`, Accept: "application/json" }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`model_health_catalog_failed:${response.status}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("model_health_catalog_invalid_json");
  }

  const excludedModels = configuredModelSet(env.MODEL_HEALTH_EXCLUDED_MODELS);
  return normalizeLiteLlmVisibleModelEntries(readLiteLlmDataArray(payload))
    .filter((model) => !excludedModels.has(model.id))
    .map((model) => ({
      id: model.id,
      displayName: model.displayName,
      defaultVendor: model.provider || "litellm",
      supported: model.supported
    }));
}

async function probeModel(
  env: Env,
  model: HealthModel,
  fetchImpl: typeof fetch,
  clock: () => Date
): Promise<ModelHealthResultInput> {
  const started = clock();
  const timeoutMs = configuredInteger(env.MODEL_HEALTH_TIMEOUT_MS, 30_000, 1_000, 120_000);
  const degradedMs = configuredInteger(env.MODEL_HEALTH_DEGRADED_MS, 8_000, 500, timeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("model_health_timeout"), timeoutMs);

  try {
    const response = await fetchImpl(`${gatewayBaseUrl(env)}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireSecret(
          env.LITELLM_PROVISIONING_KEY,
          "litellm_health_probe_token"
        )}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "Reply with OK only." }],
        ...completionLimit(model.id),
        stream: false
      }),
      signal: controller.signal
    });
    const text = await response.text();
    const latencyMs = Math.max(0, clock().getTime() - started.getTime());
    const requestId = response.headers.get("x-request-id") || response.headers.get("cf-ray") || "";

    if (!response.ok) {
      return resultFor(model, "failed", latencyMs, response.status, upstreamErrorCode(text, response.status), requestId, upstreamErrorMessage(text), clock());
    }

    const content = responseContent(text);
    const status = latencyMs >= degradedMs ? "degraded" : "operational";
    const errorCode = latencyMs >= degradedMs ? "model_health_slow_response" : "";
    return resultFor(model, status, latencyMs, response.status, errorCode, requestId, content, clock());
  } catch (error) {
    const latencyMs = Math.max(0, clock().getTime() - started.getTime());
    const code = controller.signal.aborted ? "model_health_timeout" : healthErrorCode(error);
    return resultFor(model, "failed", latencyMs, 0, code, "", "", clock());
  } finally {
    clearTimeout(timeout);
  }
}

function completionLimit(modelId: string) {
  // GPT-5.6 reasoning models reject the legacy max_tokens parameter. Keep the
  // legacy parameter for other LiteLLM providers whose adapters expect it.
  return modelId.startsWith("cf-openai-gpt-5.6-")
    ? { max_completion_tokens: 512 }
    : { max_tokens: 512 };
}

function resultFor(
  model: HealthModel,
  status: ModelHealthResultInput["status"],
  latencyMs: number,
  httpStatus: number,
  errorCode: string,
  requestId: string,
  responseExcerpt: string,
  testedAt: Date
): ModelHealthResultInput {
  return {
    modelId: model.id,
    displayName: model.displayName,
    vendorId: model.defaultVendor,
    status,
    latencyMs,
    httpStatus,
    errorCode: errorCode.slice(0, 160),
    requestId: requestId.slice(0, 160),
    responseExcerpt: responseExcerpt.replace(/\s+/g, " ").trim().slice(0, 160),
    testedAt: testedAt.toISOString()
  };
}

function responseContent(text: string) {
  try {
    const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String(part.text ?? "");
        return "";
      }).filter(Boolean).join(" ");
    }
    return "";
  } catch {
    return "";
  }
}

function upstreamErrorCode(text: string, status: number) {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const error = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : {};
    const candidate = error.type ?? error.code ?? payload.code;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  } catch {
    // The status remains the stable fallback when an upstream body is not JSON.
  }
  return `model_health_http_${status}`;
}

function upstreamErrorMessage(text: string) {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const error = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : {};
    const message = error.message ?? payload.message;
    return typeof message === "string" ? message : "";
  } catch {
    return "";
  }
}

export function shanghaiSlot(value: Date) {
  const local = new Date(value.getTime() + 8 * 3_600_000);
  return `${local.toISOString().slice(0, 10)}T${local.toISOString().slice(11, 16)}`;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function gatewayBaseUrl(env: Env) {
  return (env.LITELLM_URL?.trim() || missingConfiguration("LITELLM_URL")).replace(/\/+$/, "");
}

function requireSecret(value: string | undefined, name: string) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name}_not_configured`);
  return normalized;
}

function configuredInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function configuredModelSet(value: string | undefined) {
  return new Set((value ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean));
}

function healthErrorCode(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error ?? "model_health_unknown_error");
  return raw.trim().replace(/[^a-zA-Z0-9:_-]+/g, "_").slice(0, 120) || "model_health_unknown_error";
}
