import { defaultAgentInfo, type DefaultAgentInfo } from "../../../../sdk/auth/types.ts";
import type { Env, WorkspaceUser } from "../types.ts";

/** A live basic-info projection; never infer a Mate address from the user's email. */
export async function withDefaultAgent<T extends WorkspaceUser>(env: Env, user: T): Promise<T & { defaultAgent: DefaultAgentInfo | null }> {
  let defaultAgent: DefaultAgentInfo | null = null;
  const orgId = env.WORKSPACE_ORG_ID || env.ENTRA_TENANT_ID;
  if (env.APPS_CONTROL_PLANE && env.MATE_MCP_SERVICE_TOKEN && orgId) {
    try {
      const response = await env.APPS_CONTROL_PLANE.fetch(new Request("https://apps.internal/internal/auth/default-agent", {
        headers: { Authorization: `Bearer ${env.MATE_MCP_SERVICE_TOKEN}`, "x-workspace-runtime-user-id": user.id, "x-workspace-runtime-org-id": orgId },
        signal: AbortSignal.timeout(5000)
      }));
      if (!response.ok) throw new Error("default_agent_lookup_failed");
      const payload = await response.json() as { defaultAgent?: unknown };
      defaultAgent = defaultAgentInfo(payload.defaultAgent);
    } catch {
      // Optional basic info must not invalidate a successful authentication.
      console.warn("default_agent_lookup_unavailable");
    }
  }
  return { ...user, defaultAgent };
}
