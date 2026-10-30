import { createLiteLlmAdminClient } from "./litellmAdmin.ts";
import { buildModelCatalog } from "../../../src/shared/modelCatalog.ts";
import { WORKSPACE_MCP_VERSION } from "../../../src/shared/mcpHandbook.ts";
import { runModelHealthCheck } from "./jobs/modelHealth.ts";
import { runTokenUsageRollup } from "./jobs/usageRollup.ts";
import type { Env } from "./types.ts";

const CATALOG_NOTES = [
  "Capability and endpoint values are tri-state: supported, unsupported, or unknown.",
  "The catalog is read from /v1/model/info; /model_group/info is not used because it collapses null into false.",
  "Workspace capability assessments use the Responses API only: the endpoint is assessed separately from image, search, and file-reading behavior.",
  "Image and file-reading support require a semantic probe; search requires an actual Responses web_search_call and a usable source URL."
];

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/internal/models") {
      const adminJson = createLiteLlmAdminClient(env);
      const [availablePayload, infoPayload] = await Promise.all([
        adminJson("/v1/models"),
        adminJson("/v1/model/info")
      ]);
      const availableRows = modelRows(availablePayload);
      const availableModelIds = new Set(
        availableRows.map(modelId).filter((id): id is string => Boolean(id))
      );
      const infoById = new Map(
        modelRows(infoPayload)
          .map((row) => [modelId(row), row] as const)
          .filter(([id]) => Boolean(id))
      );
      const payload = {
        data: [...availableModelIds].map((id) => infoById.get(id) ?? { model_name: id })
      };
      return Response.json(buildModelCatalog(payload, {
        availableModelIds,
        catalogVersion: WORKSPACE_MCP_VERSION,
        importedFrom: "/v1/model/info",
        notes: [
          ...CATALOG_NOTES,
          "Model capability assessments are read from model_info.workspace_capabilities in LiteLLM; no code-side model capability overrides are applied.",
          "Only model IDs currently returned by /v1/models are eligible for the catalog.",
          "Hidden but working models are returned under hiddenModels and are omitted from the default models list."
        ]
      }), { headers: { "Cache-Control": "private, no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "llm-gateway-worker" }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },

  scheduled(controller: ScheduledController, env: Env, context: ExecutionContext) {
    if (controller.cron === "0 16 * * *") {
      context.waitUntil(runTokenUsageRollup(env, new Date(controller.scheduledTime)));
      return;
    }
    context.waitUntil(runModelHealthCheck(env, new Date(controller.scheduledTime)));
  }
};

function modelRows(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const rows = (value as { data?: unknown }).data;
  return Array.isArray(rows)
    ? rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    : [];
}

function modelId(row: Record<string, unknown>) {
  const modelInfo = row.model_info;
  const infoId = modelInfo && typeof modelInfo === "object" && !Array.isArray(modelInfo)
    ? (modelInfo as { id?: unknown }).id
    : undefined;
  const id = row.id ?? row.model_name ?? infoId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}
