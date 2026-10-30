import { decideAndExecuteRemoteMcpApproval, isRemoteMcpOperation } from './remoteMcpExecutor.ts';
import { decideAndExecutePluginApproval, isPluginOperation } from './pluginExecutor.ts';
import { decideAndExecuteAppMcpApproval } from "./appMcpExecutor.ts";
import { decideAndExecuteWorkspacePassMcpApproval, isWorkspacePassMcpOperation } from "./workspacePassMcpExecutor.ts";
import { decideAndExecuteForumPostApproval, isForumPostOperation } from "./forumPostExecutor.ts";
import {
  decideAndExecuteKnowledgeMaintenanceApproval,
  isKnowledgeMaintenanceOperation
} from "./knowledgeMaintenanceExecutor.ts";
import { readApproval } from "./storage.ts";
import { decideAndExecuteSelfDefinitionApproval, isSelfDefinitionOperation } from "./selfDefinitionExecutor.ts";
import type { RuntimeDefinition, RuntimeEnv, RuntimeMode, RuntimePrincipal } from "./types.ts";

export async function decideAndExecuteApproval(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  approvalId: string,
  decision: unknown
) {
  const approval = await readApproval(env.RUNTIME_DB, definition.mate.id, principal, mode, approvalId);
  if (isPluginOperation(approval.operation)) return decideAndExecutePluginApproval(env, definition, principal, mode, approvalId, decision);
  if (isSelfDefinitionOperation(approval.operation)) {
    return decideAndExecuteSelfDefinitionApproval(env, definition, principal, mode, approvalId, decision);
  }
  if (isForumPostOperation(approval.operation)) {
    return decideAndExecuteForumPostApproval(env, definition, principal, mode, approvalId, decision);
  }
  if (isKnowledgeMaintenanceOperation(approval.operation)) {
    return decideAndExecuteKnowledgeMaintenanceApproval(env, definition, principal, mode, approvalId, decision);
  }
  if (isWorkspacePassMcpOperation(approval.operation)) {
    return decideAndExecuteWorkspacePassMcpApproval(env, definition, principal, mode, approvalId, decision);
  }
  if (isRemoteMcpOperation(approval.operation)) return decideAndExecuteRemoteMcpApproval(env, definition, principal, mode, approvalId, decision);
  return decideAndExecuteAppMcpApproval(env, definition, principal, mode, approvalId, decision);
}
