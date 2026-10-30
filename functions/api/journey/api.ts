import { audit } from "../audit.ts";
import { emitActivityEvent } from "../activity/service.ts";
import { authWorkerBaseUrl, authWorkerUser } from "../authBoundary/service.ts";
import type { Env } from "../env.ts";
import { HttpError, parseJsonBody, readBody, requireConfiguredSecret, requireDb } from "../http.ts";
import { resolveCurrentUser } from "../identity/index.ts";
import { readAllLiteLlmUserKeys } from "../llmGateway/access.ts";
import { createLlmGatewayClient } from "../llmGateway/client.ts";
import { liteLlmUserIdForPortalUser, normalizeLiteLlmKeys } from "../llmGateway/litellm.ts";
import { syncLiteLlmUserMonthlyBudget } from "../llmGateway/userBudgets.ts";
import { appsOrgContext, appsWorkerBaseUrl } from "../appsProxy/context.ts";
import { APPS_READ_SCOPES } from "../appsProxy/scopes.ts";
import { signAppsToken } from "../appsProxy/tokenSigner.ts";
import { createPublicationAppsAuthorIndexReader } from "../publication/appsSource.ts";
import { getTtlSeconds } from "../values.ts";
import { createJourneyApi, normalizeAgentPreference } from "./service.ts";

export function createJourneyServices() {
  const llmGatewayClient = createLlmGatewayClient({
    httpError: (status, message) => new HttpError(status, message)
  });
  const readAppsAuthorIndex = createPublicationAppsAuthorIndexReader<Env>({
    getTtlSeconds,
    httpError: (status: number, message: string) => new HttpError(status, message),
    appsOrgContext,
    appsReadScopes: APPS_READ_SCOPES,
    appsWorkerBaseUrl,
    parseJson: (value: string) => parseJsonBody(value) as Record<string, unknown>,
    signAppsToken
  });

  return {
    journeyApi: createJourneyApi({
      audit,
      emitActivityEvent,
      readActiveGatewayTokenCount: async (context, currentUser) => {
        const collection = await readAllLiteLlmUserKeys(
          context,
          liteLlmUserIdForPortalUser(currentUser),
          {
            adminJson: llmGatewayClient.adminJson,
            httpError: (status: number, message: string) => new HttpError(status, message)
          }
        );
        const now = Date.now();
        return normalizeLiteLlmKeys(collection.keys).filter((token) => (
          token.status === "active"
          && token.accessStatus === "active"
          && (!token.expiresAt || Date.parse(token.expiresAt) > now)
        )).length;
      },
      readMcpConnectionEvidence: async (context, currentUser) => {
        const token = requireConfiguredSecret(context.env.MCP_APPROVAL_TOKEN, "mcp_approval_token");
        const response = await fetch(`${authWorkerBaseUrl(context.env, {
          httpError: (status, message) => new HttpError(status, message)
        })}/v1/mcp/connections/status`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ user: authWorkerUser(currentUser) })
        });
        const responseText = await response.text();
        if (!response.ok) {
          throw new HttpError(response.status, `mcp_connection_status_failed:${responseText.slice(0, 160)}`);
        }
        const payload = parseJsonBody(responseText, "mcp_connection_status_invalid") as Record<string, unknown>;
        const status = payload.status && typeof payload.status === "object" && !Array.isArray(payload.status)
          ? payload.status as Record<string, unknown>
          : {};
        const authorizedCount = Number(status.authorizedCount);
        const connections = Array.isArray(status.connections)
          ? status.connections.filter((connection): connection is Record<string, unknown> => (
            Boolean(connection) && typeof connection === "object" && !Array.isArray(connection)
          ))
          : [];
        const agentPreference = connections
          .map((connection) => normalizeAgentPreference(connection.agentType))
          .find(Boolean);

        return {
          agentPreference,
          authorizedCount: Number.isFinite(authorizedCount) && authorizedCount > 0
            ? authorizedCount
            : status.everConnected === true ? 1 : 0
        };
      },
      readBody,
      readAppsAuthorIndex,
      requireDb,
      resolveCurrentUser,
      syncMonthlyBudget: (context, currentUser, levelKey) => syncLiteLlmUserMonthlyBudget(
        context,
        currentUser,
        levelKey,
        { adminJson: llmGatewayClient.adminJson }
      )
    })
  };
}
