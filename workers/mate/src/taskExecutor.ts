import { executeRemoteMcpWriteTask, isRemoteMcpOperation } from './remoteMcpExecutor.ts';
import type { MateScheduledJob } from "../../../src/shared/mate.ts";
import type { StepResult, ToolSet } from "ai";
import type { MateChatCapabilitySelection } from "./chatAgentProtocol.ts";
import { executeAppMcpTask } from "./appMcpExecutor.ts";
import { executeWorkspacePassMcpWriteTask, isWorkspacePassMcpOperation } from "./workspacePassMcpExecutor.ts";
import { createRoleConversationAgent } from "./conversationAgent.ts";
import { workThreadConversation } from "./workThreads.ts";
import { concludeTask, startTask } from "./storage.ts";
import { executeForumPostTask, isForumPostOperation } from "./forumPostExecutor.ts";
import { executeKnowledgeMaintenanceTask, isKnowledgeMaintenanceOperation } from "./knowledgeMaintenanceExecutor.ts";
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimeMode, type RuntimePrincipal } from "./types.ts";
import { isSelfDefinitionOperation, proposeSelfDefinitionTask } from "./selfDefinitionExecutor.ts";

export async function executeConfiguredTask(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  taskId: string,
  input: Record<string, unknown> = {}
) {
  if (isSelfDefinitionOperation(input.operation)) {
    const change = (input.operation as { change: import("../../apps/src/mates/service.ts").OwnerMateDefinitionChange }).change;
    return proposeSelfDefinitionTask(env, definition, principal, mode, taskId, change);
  }
  if (isForumPostOperation(input.operation)) {
    return executeForumPostTask(env, definition, principal, mode, taskId, input);
  }
  if (isKnowledgeMaintenanceOperation(input.operation)) {
    return executeKnowledgeMaintenanceTask(env, definition, principal, mode, taskId, input);
  }
  if (isWorkspacePassMcpOperation(input.operation)) {
    return executeWorkspacePassMcpWriteTask(env, definition, principal, mode, taskId, input);
  }
  if (isRemoteMcpOperation(input.operation)) return executeRemoteMcpWriteTask(env, definition, principal, mode, taskId, input);
  // Explicit tool calls retain their authorization/approval adapter. Legacy
  // executor labels never select an Agent or restrict its available tools.
  if (input.operation && typeof input.operation === "object" && "appId" in input.operation) {
    return executeAppMcpTask(env, definition, principal, mode, taskId, input);
  }
  const { task } = await startTask(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId, definition.release.id);
  const steps: StepResult<ToolSet>[] = [];
  let artifacts: unknown[] = [];
  const abortSignal = AbortSignal.timeout(task.channel === "email" ? 600_000 : 180_000);
  try {
    const instruction = String(task.instruction);
    const agent = await createRoleConversationAgent(env, definition, principal, {
      abortSignal,
      emailTask: task.channel === "email",
      conversation: await workThreadConversation(env.RUNTIME_DB, {mateId:definition.mate.id,userId:principal.userId,mode},taskId,task.threadId),
      environment: task.context,
      instruction,
      mode,
      selection: (task.context as { capabilitySelection?: MateChatCapabilitySelection })?.capabilitySelection,
      onStepFinish: (step) => { steps.push(step); },
      taskId,
      turnId: taskId,
      userMessage: { id: taskId, role: "user", parts: [{ type: "text", text: instruction }] }
    });
    if (!agent) throw new RuntimeHttpError(503, "mate_model_not_configured");
    artifacts = agent.artifacts;
    // Consume the complete multi-tool loop before recording the conclusion.
    await agent.result.consumeStream({ onError: (error) => { throw error; } });
    const summary = (await agent.result.text).trim();
    if (abortSignal.aborted) throw new RuntimeHttpError(504, "mate_task_timeout");
    if (!summary) throw new RuntimeHttpError(502, "mate_model_response_empty");
    const toolResults = steps.flatMap((step) => step.toolResults);
    const failedTools = toolResults.filter((result) => {
      const output = result.output as Record<string, any> | undefined;
      return output?.task?.status === "failed";
    });
    const failures = [...steps.flatMap((step) => step.content.filter((part) => part.type === "tool-error")), ...failedTools];
    const pendingApprovals = toolResults.flatMap((result) => {
      const output = result.output as Record<string, any> | undefined;
      return output?.approval?.status === "pending" ? [{ approvalId: output.approval.id, taskId: output.task?.id }] : [];
    });
    return { task: await concludeTask(env.RUNTIME_DB, definition.mate.id, principal.userId, mode, taskId, {
      actions: taskActions(steps),
      artifacts: taskArtifacts(steps,agent.artifacts),
      failures: failures.map(() => ({ code: "task_tool_failed" })),
      followUps: [],
      outcome: failures.length ? "failed" : "completed",
      pendingApprovals,
      summary
    }) };
  } catch (error) {
    const code = abortSignal.aborted ? "mate_task_timeout" : error instanceof RuntimeHttpError ? error.code : "task_agent_execution_failed";
    await concludeTask(env.RUNTIME_DB, definition.mate.id, principal.userId, mode, taskId, {
      actions: taskActions(steps), artifacts:taskArtifacts(steps,artifacts), failures: [{ code }], followUps: [],
      outcome: "failed", errorCode: code, pendingApprovals: [], summary: `Task failed (${code}).`
    });
    throw error;
  }
}

function taskArtifacts(steps:StepResult<ToolSet>[],recorded:unknown[]) {
  const files=steps.flatMap(step=>step.toolResults.flatMap(result=>{
    const output=result.output as {saved?:boolean;file?:Record<string,unknown>;expiresAt?:string}|undefined;
    if(output?.saved!==true || !output.file || typeof output.file.objectId!=="string") return [];
    return [{...output.file,objectId:output.file.objectId,type:"workspace_file",expiresAt:output.expiresAt}];
  }));
  return [...recorded,...new Map(files.map(file=>[file.objectId,file])).values()];
}

function taskActions(steps: StepResult<ToolSet>[]) {
  return steps.flatMap((step) => step.toolResults.map((result) => {
    const output = result.output as Record<string, any> | undefined;
    return {
      toolName: result.toolName, toolCallId: result.toolCallId,
      ...(output?.id ? { recordId: output.id } : {}),
      ...(output?.task?.id ? { taskId: output.task.id } : {}),
      ...(output?.approval?.id ? { approvalId: output.approval.id } : {}),
      ...(output?.proposed ? { proposed: true, writesApplied: false } : {})
    };
  }));
}

export function scheduledJob(definition: RuntimeDefinition, id: string): MateScheduledJob | undefined {
  const jobs = definition.release.manifest.taskPolicy?.scheduledJobs;
  return Array.isArray(jobs) ? jobs.find((job) => job.id === id) : undefined;
}
