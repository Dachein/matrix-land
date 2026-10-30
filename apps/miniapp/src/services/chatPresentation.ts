import type { ChatMessage, ChatPart } from "../types";
import type { RuntimeApprovalState } from "../../../../src/shared/mateApprovalState";
import { approvalDisplayState } from "../../../../src/shared/mateApprovalState";
import { mateFileReferencesFromCitations, mateFileReferencesFromTool } from "../../../../src/shared/mateFileReference.js";
import { messageLinks } from "./chatLinks";
import { messageExecution } from "./chatExecution";

export type ChatProcessStep = {
  kind: "reasoning" | "tool";
  label: string;
  toolCallId?: string;
  approvalId?: string;
  needsApproval?: boolean;
  status?: "cancelled" | "completed" | "failed" | "running" | "waiting";
  text: string;
};

export type ChatTurnProcess = {
  steps: ChatProcessStep[];
  timingStatus?: "cancelled" | "completed" | "failed" | "paused" | "running";
};

export function chatTurnProcess(message: ChatMessage, approvals: RuntimeApprovalState[] = []): ChatTurnProcess | undefined {
  const timingStatus = messageExecution(message)?.state === "paused" ? "paused" : processTimingStatus(message.parts);
  const steps = message.parts.flatMap((part): ChatProcessStep[] => {
    if (isToolPart(part)) {
      const proposal = (part.output as { approval?: RuntimeApprovalState } | undefined)?.approval;
      const current = proposal?.id ? approvals.find((item) => item.id === proposal.id) || proposal : undefined;
      const state = current ? approvalDisplayState(current) : undefined;
      return [{ kind: "tool", label: safeToolName(part), toolCallId: part.toolCallId, approvalId: current?.id, needsApproval: part.state === "approval-requested" && part.approval?.approved === undefined, status: state?.status || toolStatus(part), text: state?.text || toolStateLabel(part) }];
    }
    if (part.type === "reasoning" || part.type === "reasoning-file") return [{ kind: "reasoning", label: "思考", status: part.state === "streaming" ? "running" : "completed", text: part.state === "streaming" ? "进行中" : "已完成" }];
    return [];
  });
  if (!steps.length && !timingStatus) return undefined;
  return { steps, ...(timingStatus ? { timingStatus } : {}) };
}

export function chatProcessStatus(active: boolean, process: ChatTurnProcess) {
  if (process.steps.some((step) => step.status === "waiting")) return "waiting" as const;
  if (process.steps.some((step) => step.approvalId && step.status === "failed")) return "failed" as const;
  if (process.steps.some((step) => step.approvalId && step.status === "cancelled")) return "cancelled" as const;
  if (process.timingStatus === "paused") return "paused" as const;
  if (process.timingStatus === "completed") return "completed" as const;
  if (process.timingStatus === "failed") return "failed" as const;
  if (process.timingStatus === "cancelled") return "cancelled" as const;
  if (process.steps.some((step) => step.status === "waiting")) return "waiting" as const;
  if (active || process.timingStatus === "running" || process.steps.some((step) => step.status === "running")) return "running" as const;
  if (process.steps.some((step) => step.status === "failed")) return "failed" as const;
  return "completed" as const;
}

/** Hide settled tool/thinking traces from transcript history, but keep approval actions visible. */
export function shouldShowChatProcess(active: boolean, process: ChatTurnProcess) {
  return active || process.steps.some((step) => step.needsApproval);
}

/** Removing completed process UI must not leave blank rows or discard generated files. */
export function hasVisibleMessageContent(message: ChatMessage, active = false) {
  if (message.parts.some(part => !isProcessPart(part) && isVisibleChatPart(part))) return true;
  const process = chatTurnProcess(message);
  if (process && shouldShowChatProcess(active, process)) return true;
  if (message.parts.some(part => part.type === "data-mate-citations"
    ? mateFileReferencesFromCitations(part.data).length > 0
    : mateFileReferencesFromTool(part.toolName || part.type.replace(/^tool-/, ""), part.output).length > 0)) return true;
  return messageLinks(message).length > 0;
}

/** Keep an action requiring approval visible; otherwise show the newest status. */
export function latestChatProcessStep(steps: ChatProcessStep[]) {
  return [...steps].reverse().find((step) => step.needsApproval)
    || steps[steps.length - 1];
}

export function isProcessPart(part: ChatPart) { return part.type === "reasoning" || part.type === "reasoning-file" || isToolPart(part); }
export function isToolPart(part: ChatPart) { return part.type === "dynamic-tool" || part.type.startsWith("tool-"); }
export function isVisibleChatPart(part: ChatPart) {
  if (part.type === "text") return Boolean(part.text?.trim());
  if (part.type === "step-start") return false;
  if (part.type === "data-mate-process" || part.type === "data-mate-turn" || part.type === "data-mate-citations") return false;
  if (part.type !== "data-mate-task" || !part.data || typeof part.data !== "object") return true;
  return (part.data as Record<string, unknown>).schemaVersion !== "workspace.mate-chat-terminal/v1";
}

function safeToolName(part: ChatPart) {
  const name = part.toolName || part.type.replace(/^tool-/, "");
  return /^[a-z0-9_.:-]{1,64}$/i.test(name) ? name : "能力调用";
}
function toolStatus(part: ChatPart): ChatProcessStep["status"] {
  if (part.state === "approval-requested" && part.approval?.approved === undefined) return "waiting";
  if (part.state === "input-available") return "waiting";
  if (part.state === "output-error" || part.state === "output-denied") return "failed";
  if (part.state === "output-available") return "completed";
  return "running";
}
function toolStateLabel(part: ChatPart) {
  if (part.state === "approval-requested") return "需要你的确认";
  if (part.state === "output-available") return "已完成";
  if (part.state === "output-error") return "执行失败";
  if (part.state === "output-denied") return "已拒绝";
  if (part.state === "approval-responded") return part.approval?.approved ? "已允许，继续执行" : "已拒绝";
  if (part.state === "input-streaming") return "正在准备参数";
  if (part.state === "input-available") return "等待执行";
  return "运行中";
}
function processTimingStatus(parts: ChatPart[]) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part.type !== "data-mate-process" || !part.data || typeof part.data !== "object") continue;
    const data = part.data as Record<string, unknown>;
    if (data.schemaVersion !== "workspace.mate-process/v1" || !["cancelled", "completed", "failed", "paused", "running"].includes(String(data.status))) continue;
    return data.status as ChatTurnProcess["timingStatus"];
  }
  return undefined;
}
