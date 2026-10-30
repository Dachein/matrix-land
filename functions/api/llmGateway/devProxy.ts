import type { PortalCatalog } from "../../../src/shared/types.ts";
import { normalizeLiteLlmModelCatalog, readLiteLlmDataArray } from "./litellm.ts";

type CurrentUser = PortalCatalog["currentUser"];

type LlmGatewayDevProxyEnv = {
  LITELLM_MASTER_KEY?: string;
  LITELLM_PROVISIONING_KEY?: string;
  LITELLM_URL?: string;
  LITELLM_USER_TOKEN?: string;
};

type LlmGatewayDevProxyContext<TEnv extends LlmGatewayDevProxyEnv> = EventContext<TEnv, string, unknown>;

type LlmGatewayDevProxyDeps<TEnv extends LlmGatewayDevProxyEnv> = {
  baseUrl(env: TEnv): string;
  fetch?: typeof fetch;
  json(body: unknown, init?: ResponseInit): Response;
  parseJson(value: string): unknown;
  readBody<T>(request: Request): Promise<T>;
  requireAdminPortalUser(context: LlmGatewayDevProxyContext<TEnv>): Promise<CurrentUser>;
  requireSecret(value: string | undefined, name: string): string;
};

export function createLlmGatewayDevProxyApi<TEnv extends LlmGatewayDevProxyEnv>(deps: LlmGatewayDevProxyDeps<TEnv>) {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));

  return {
    async getModelCatalog(context: LlmGatewayDevProxyContext<TEnv>) {
      await deps.requireAdminPortalUser(context);

      const gatewayUrl = deps.baseUrl(context.env);
      const adminToken = deps.requireSecret(liteLlmProvisioningKey(context.env), "litellm_provisioning_key");
      const response = await fetchImpl(`${gatewayUrl}/v1/model/info`, {
        headers: {
          Authorization: `Bearer ${adminToken}`,
          Accept: "application/json"
        }
      });
      const responseText = await response.text();

      if (!response.ok) {
        return deps.json(
          {
            error: "llm_gateway_catalog_unavailable",
            upstreamStatus: response.status,
            upstreamBody: responseText.slice(0, 500)
          },
          { status: 502 }
        );
      }

      const payload = deps.parseJson(responseText);

      return deps.json({
        gatewayUrl,
        catalog: normalizeLiteLlmModelCatalog(readLiteLlmDataArray(payload))
      });
    },

    async runChat(context: LlmGatewayDevProxyContext<TEnv>) {
      await deps.requireAdminPortalUser(context);

      const gatewayUrl = deps.baseUrl(context.env);
      const userToken = deps.requireSecret(context.env.LITELLM_USER_TOKEN, "litellm_user_token");
      const body = await deps.readBody<Record<string, unknown>>(context.request);
      const response = await fetchImpl(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      const headers = new Headers();
      const contentType = response.headers.get("content-type");
      const requestId = response.headers.get("x-request-id");
      const rayId = response.headers.get("cf-ray");

      if (contentType) {
        headers.set("Content-Type", contentType);
      }
      if (requestId) {
        headers.set("x-request-id", requestId);
      }
      if (rayId) {
        headers.set("cf-ray", rayId);
      }

      return new Response(await response.arrayBuffer(), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }
  };
}

function liteLlmProvisioningKey(env: LlmGatewayDevProxyEnv) {
  return env.LITELLM_PROVISIONING_KEY || env.LITELLM_MASTER_KEY;
}
