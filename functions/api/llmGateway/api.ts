import { HttpError, json, readBody } from "../http.ts";
import { readAuthWorkerSessionPrincipal, requireAdminPortalUser, resolveCurrentUser } from "../identity/index.ts";
import { optionalText, requireText } from "../values.ts";
import { createLlmGatewayAccessApi } from "./access.ts";
import { createLlmGatewayAdminAllocationsApi } from "./adminAllocations.ts";
import { createLlmGatewayAdminUsageApi } from "./adminUsage.ts";
import { createLlmGatewayClient } from "./client.ts";
import { createLlmGatewayDevProxyApi } from "./devProxy.ts";
import { createLlmGatewayGroupUsageApi } from "./groupUsage.ts";
import { createLlmGatewayModelHealthApi } from "./modelHealth.ts";

export function createLlmGatewayServices() {
  const client = createLlmGatewayClient({
    httpError: (status, message) => new HttpError(status, message),
    onAdminError: (event) => console.warn("llm_gateway_admin_request_failed", event)
  });
  const adminJson = client.adminJson;
  const baseUrl = client.baseUrl;

  return {
    llmGatewayAccessApi: createLlmGatewayAccessApi({
      adminJson,
      baseUrl,
      httpError: (status, message) => new HttpError(status, message),
      json,
      onTestError: (event) => console.warn("llm_gateway_token_test_failed", event),
      optionalText,
      readBody,
      requireText,
      resolveCurrentUser
    }),
    llmGatewayAdminAllocationsApi: createLlmGatewayAdminAllocationsApi({
      adminJson,
      baseUrl,
      httpError: (status, message) => new HttpError(status, message),
      json,
      readBody,
      requireAdminPortalUser,
      requireText
    }),
    llmGatewayAdminUsageApi: createLlmGatewayAdminUsageApi({
      adminJson,
      httpError: (status, message) => new HttpError(status, message),
      json,
      optionalText,
      readBody,
      requireAdminPortalUser
    }),
    llmGatewayDevProxyApi: createLlmGatewayDevProxyApi({
      baseUrl,
      json,
      parseJson: client.parseJson,
      readBody,
      requireAdminPortalUser,
      requireSecret: client.requireSecret
    }),
    llmGatewayGroupUsageApi: createLlmGatewayGroupUsageApi({
      httpError: (status, message) => new HttpError(status, message),
      json,
      async requireAuthenticated(context) {
        const principal = await readAuthWorkerSessionPrincipal(context.request, context.env);
        if (!principal) {
          throw new HttpError(401, "not_authenticated");
        }
      }
    }),
    llmGatewayModelHealthApi: createLlmGatewayModelHealthApi({
      httpError: (status, message) => new HttpError(status, message),
      json,
      resolveCurrentUser
    })
  };
}
