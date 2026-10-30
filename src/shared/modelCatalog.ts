import {
  normalizeWorkspaceModelCapabilities,
  type WorkspaceModelCapabilityAssessment
} from "./workspaceModelCapabilities.ts";

/**
 * Canonical Workspace LLM gateway model catalog.
 *
 * The source of truth is LiteLLM `/v1/model/info`. Never build this catalog from
 * `/model_group/info`: it collapses an undeclared (`null`) capability bit into
 * `false`, so it reports a model as unsupported when the gateway never declared
 * anything at all.
 *
 * Capability and endpoint support are tri-state here. `unknown` means "not
 * declared" and must never be rendered or read as unsupported.
 */

export type ModelCapabilityState = "supported" | "unsupported" | "unknown";
export type ModelCapabilitySource = "declared" | "verified";
export type ModelEndpointSupport = "supported" | "unsupported" | "unknown";

export type ModelCapabilityEntry = {
  checkedAt?: string;
  evidence?: string;
  source: ModelCapabilitySource;
  state: ModelCapabilityState;
};

export type ModelCatalogCapabilityKey =
  | "functionCalling"
  | "pdfInput"
  | "promptCaching"
  | "reasoning"
  | "urlContext"
  | "vision"
  | "webSearch";

export type ModelCatalogCapabilities = Record<ModelCatalogCapabilityKey, ModelCapabilityEntry>;

export type ModelCatalogEndpoints = {
  chatCompletions: ModelEndpointSupport;
  messagesApi: ModelEndpointSupport;
  responsesApi: ModelEndpointSupport;
};

export type ModelCatalogPricing = {
  cacheReadPerMillionTokens?: number;
  currency: string;
  inputPerMillionTokens?: number;
  outputPerMillionTokens?: number;
};

export type ModelCatalogEntry = {
  available: boolean;
  baseModel: string;
  capabilities: ModelCatalogCapabilities;
  capabilityAssessment?: WorkspaceModelCapabilityAssessment;
  context: {
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  description: string;
  displayName: string;
  endpoints: ModelCatalogEndpoints;
  hidden: boolean;
  id: string;
  pricing?: ModelCatalogPricing;
  provider: string;
  supported: boolean;
  tags: string[];
};

export type ModelCatalog = {
  catalogVersion: string;
  generatedAt: string;
  models: ModelCatalogEntry[];
  hiddenModels: ModelCatalogEntry[];
  notes: string[];
  source: {
    hiddenModelCount: number;
    importedFrom: string;
    modelCount: number;
  };
  summary: {
    capabilityKeys: ModelCatalogCapabilityKey[];
    modelCount: number;
    hiddenAvailableModelCount: number;
    undeclaredCapabilityCount: number;
    verifiedCapabilityCount: number;
  };
};

export const MODEL_CATALOG_CAPABILITY_KEYS: ModelCatalogCapabilityKey[] = [
  "webSearch",
  "urlContext",
  "vision",
  "pdfInput",
  "functionCalling",
  "reasoning",
  "promptCaching"
];

const CAPABILITY_FIELDS: Array<{ field: string; key: ModelCatalogCapabilityKey }> = [
  { field: "supports_web_search", key: "webSearch" },
  { field: "supports_url_context", key: "urlContext" },
  { field: "supports_vision", key: "vision" },
  { field: "supports_pdf_input", key: "pdfInput" },
  { field: "supports_function_calling", key: "functionCalling" },
  { field: "supports_reasoning", key: "reasoning" },
  { field: "supports_prompt_caching", key: "promptCaching" }
];

/**
 * LiteLLM declares capability bits as `true`, `false`, or `null`. Anything that
 * is not an explicit boolean stays `unknown` instead of degrading to `false`.
 */
export function capabilityStateFromDeclaration(value: unknown): ModelCapabilityState {
  if (value === true) return "supported";
  if (value === false) return "unsupported";
  return "unknown";
}

export function normalizeModelCatalogEntry(value: unknown): ModelCatalogEntry {
  const row = normalizeUnknownObject(value);
  const modelInfo = normalizeUnknownObject(row.model_info);
  const litellmParams = normalizeUnknownObject(row.litellm_params);
  const publishedPricing = normalizeUnknownObject(modelInfo.pricing_usd_per_million_tokens);
  const workspaceCapabilities = normalizeWorkspaceModelCapabilities(modelInfo.workspace_capabilities);
  const modelName = readString(row.model_name ?? modelInfo.id ?? row.id).trim();
  const blocked = modelInfo.blocked === true || row.blocked === true;
  const hidden = modelInfo.hidden === true || row.hidden === true;
  const mode = readString(modelInfo.mode ?? row.mode).trim();
  const inputCostPerMillion = readOptionalNumber(publishedPricing.input)
    ?? perTokenCostPerMillion(modelInfo.input_cost_per_token)
    ?? perTokenCostPerMillion(litellmParams.input_cost_per_token);
  const outputCostPerMillion = readOptionalNumber(publishedPricing.output)
    ?? perTokenCostPerMillion(modelInfo.output_cost_per_token)
    ?? perTokenCostPerMillion(litellmParams.output_cost_per_token);
  const cacheCostPerMillion = readOptionalNumber(publishedPricing.cache)
    ?? perTokenCostPerMillion(modelInfo.cache_read_input_token_cost)
    ?? perTokenCostPerMillion(litellmParams.cache_read_input_token_cost)
    ?? perTokenCostPerMillion(litellmParams.input_cost_per_token_cache_hit);
  const hasPricing = inputCostPerMillion !== undefined
    || outputCostPerMillion !== undefined
    || cacheCostPerMillion !== undefined;

  return {
    available: !blocked && (!mode || mode === "chat"),
    baseModel: readString(modelInfo.base_model ?? litellmParams.model).replace(/^openai\//, ""),
    capabilities: normalizeCapabilities(modelInfo, workspaceCapabilities),
    ...(workspaceCapabilities ? { capabilityAssessment: workspaceCapabilities } : {}),
    context: {
      maxInputTokens: readNumber(modelInfo.max_input_tokens),
      maxOutputTokens: readNumber(modelInfo.max_output_tokens ?? modelInfo.max_tokens)
    },
    description: readString(modelInfo.description ?? row.description),
    displayName: readString(modelInfo.display_name ?? row.display_name).trim() || modelName,
    endpoints: normalizeEndpoints(modelInfo, workspaceCapabilities),
    hidden,
    id: modelName,
    ...(hasPricing ? {
      pricing: {
        currency: readString(modelInfo.currency).trim().toUpperCase() || "USD",
        inputPerMillionTokens: inputCostPerMillion,
        outputPerMillionTokens: outputCostPerMillion,
        cacheReadPerMillionTokens: cacheCostPerMillion
      }
    } : {}),
    provider: readString(modelInfo.provider ?? modelInfo.litellm_provider ?? row.provider).trim()
      || providerForModel(modelName),
    supported: !blocked && !hidden && (!mode || mode === "chat"),
    tags: readStringArray(modelInfo.tags)
  };
}

export function modelCatalogRowsFromPayload(payload: unknown) {
  const row = normalizeUnknownObject(payload);
  if (Array.isArray(row.data)) return row.data;
  if (Array.isArray(row.models)) return row.models;
  return Array.isArray(payload) ? payload : [];
}

/**
 * Builds the published catalog. Hidden models stay out of the visible list but
 * are still counted so the result never silently claims full coverage.
 */
export function buildModelCatalog(
  payload: unknown,
  options: {
    catalogVersion: string;
    availableModelIds?: Iterable<string>;
    generatedAt?: string;
    importedFrom?: string;
    notes?: string[];
  }
): ModelCatalog {
  const entries = modelCatalogRowsFromPayload(payload)
    .map(normalizeModelCatalogEntry)
    .filter((entry) => entry.id.length > 0);
  const seen = new Set<string>();
  const deduped = entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
  const availableIds = options.availableModelIds ? new Set(options.availableModelIds) : undefined;
  const availableEntries = availableIds
    ? deduped.filter((entry) => availableIds.has(entry.id))
    : deduped;
  const models = availableEntries
    .filter((entry) => !entry.hidden && entry.supported)
    .sort(compareModelNames);
  const hiddenModels = availableEntries
    .filter((entry) => entry.hidden || !entry.supported)
    .sort(compareModelNames);
  const capabilityEntries = models.flatMap((model) => (
    MODEL_CATALOG_CAPABILITY_KEYS.map((key) => model.capabilities[key])
  ));

  return {
    catalogVersion: options.catalogVersion,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    hiddenModels,
    models,
    notes: options.notes ?? [],
    source: {
      hiddenModelCount: deduped.length - models.length,
      importedFrom: options.importedFrom ?? "/v1/model/info",
      modelCount: models.length
    },
    summary: {
      capabilityKeys: [...MODEL_CATALOG_CAPABILITY_KEYS],
      hiddenAvailableModelCount: hiddenModels.length,
      modelCount: models.length,
      undeclaredCapabilityCount: capabilityEntries.filter((entry) => entry.state === "unknown").length,
      verifiedCapabilityCount: capabilityEntries.filter((entry) => entry.source === "verified").length
    }
  };
}

function normalizeCapabilities(
  modelInfo: Record<string, unknown>,
  workspaceCapabilities?: WorkspaceModelCapabilityAssessment
): ModelCatalogCapabilities {
  const capabilities = {} as ModelCatalogCapabilities;
  for (const { field, key } of CAPABILITY_FIELDS) {
    capabilities[key] = {
      source: "declared",
      state: capabilityStateFromDeclaration(modelInfo[field])
    };
  }
  if (workspaceCapabilities) {
    const mappings: Array<[keyof WorkspaceModelCapabilityAssessment["capabilities"], ModelCatalogCapabilityKey]> = [
      ["image", "vision"],
      ["search", "webSearch"],
      ["file_reading", "pdfInput"]
    ];
    for (const [workspaceKey, catalogKey] of mappings) {
      const state = workspaceCapabilities.responses_api === "unsupported"
        ? "unsupported"
        : workspaceCapabilities.responses_api === "supported"
          ? workspaceCapabilities.capabilities[workspaceKey]
          : "unknown";
      capabilities[catalogKey] = {
        source: state === "unknown" ? "declared" : "verified",
        state
      };
    }
  }
  return capabilities;
}

function normalizeEndpoints(
  modelInfo: Record<string, unknown>,
  workspaceCapabilities?: WorkspaceModelCapabilityAssessment
): ModelCatalogEndpoints {
  const declared = readStringArray(modelInfo.supported_endpoints);
  return {
    chatCompletions: endpointSupport(declared, "/v1/chat/completions", "/chat/completions", "chat"),
    messagesApi: endpointSupport(declared, "/v1/messages", "/messages", "anthropic"),
    responsesApi: workspaceCapabilities?.responses_api
      ?? endpointSupport(declared, "/v1/responses", "/responses")
  };
}

/**
 * `supported_endpoints` is absent or `null` on every model the gateway has not
 * declared yet, which has to stay `unknown` rather than becoming `unsupported`.
 */
function endpointSupport(declared: string[], ...aliases: string[]): ModelEndpointSupport {
  if (declared.length === 0) return "unknown";
  return declared.some((entry) => aliases.includes(entry)) ? "supported" : "unsupported";
}

function compareModelNames(
  left: { displayName: string; id: string },
  right: { displayName: string; id: string }
) {
  return left.displayName.localeCompare(right.displayName, "en", { sensitivity: "base" })
    || left.id.localeCompare(right.id, "en", { sensitivity: "base" });
}

function providerForModel(model: string) {
  if (model.startsWith("tencent-")) return "tencent-tokenhub-intl";
  if (model.startsWith("aws-") || model.includes("bedrock")) return "aws-bedrock";
  if (model.startsWith("openai") || model.startsWith("gpt-")) return "openai";
  return "litellm";
}

function readStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => readString(item).trim()).filter(Boolean);
  }
  try {
    const parsed = JSON.parse(readString(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => readString(item).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function readOptionalNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function perTokenCostPerMillion(value: unknown) {
  const cost = readOptionalNumber(value);
  return cost === undefined ? undefined : Number((cost * 1_000_000).toFixed(9));
}

function normalizeUnknownObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
