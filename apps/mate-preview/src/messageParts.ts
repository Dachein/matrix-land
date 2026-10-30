import { mateFileReferencesFromCitations, mateFileReferencesFromTool } from "../../../src/shared/mateFileReference.js";
import { approvalDisplayState, type RuntimeApprovalState } from "./approvalState";

export type PreviewMessageLike = {
  id: string;
  parts?: unknown[];
  role: string;
};

export type PreviewMessagePartView = {
  details?: PreviewMessagePartView[];
  kind: "authorization" | "artifact" | "citation" | "data" | "reasoning" | "text" | "tool";
  label?: string;
  mediaType?: string;
  status?: "cancelled" | "completed" | "failed" | "running" | "waiting";
  approvalId?: string;
  text: string;
};

export type PreviewProcessStep = Omit<PreviewMessagePartView, "kind"> & {
  kind: "progress" | "reasoning" | "tool";
};

export type PreviewTurnProcess = {
  endPartIndex: number;
  startPartIndex: number;
  steps: PreviewProcessStep[];
  timing?: {
    completedAt?: string;
    durationMs?: number;
    startedAt: string;
    status: "cancelled" | "completed" | "failed" | "paused" | "running";
  };
};

/** The transport can append an empty observer message after an error frame. */
export function previewTranscriptMessages<T extends PreviewMessageLike>(messages: T[]): T[] {
  let failedInTurn = false;
  return messages.filter((message) => {
    if (message.role === "user") failedInTurn = false;
    if (message.role !== "assistant") return true;
    if (previewMessageProcessTiming(message)?.status === "failed") failedInTurn = true;
    return !(failedInTurn && (message.parts?.length ?? 0) === 0);
  });
}

export function previewTurnProcessStatus(active: boolean, process: PreviewTurnProcess) {
  // Approval tasks outlive the proposal turn; their current state takes priority.
  // Otherwise the persisted turn terminal is authoritative, including when a
  // recoverable tool failure remains visible after the model completed the turn.
  const approvalSteps = process.steps.filter((step) => step.approvalId);
  if (approvalSteps.some((step) => step.status === "waiting")) return "waiting";
  if (approvalSteps.some((step) => step.status === "failed")) return "failed";
  if (approvalSteps.some((step) => step.status === "cancelled")) return "cancelled";
  if (process.timing?.status === "paused") return "paused";
  if (process.timing?.status === "completed") return "completed";
  if (process.timing?.status === "failed") return "failed";
  if (process.timing?.status === "cancelled") return "cancelled";
  if (process.steps.some((step) => step.status === "waiting")) return "waiting";
  if (active || process.timing?.status === "running" || process.steps.some((step) => step.status === "running")) return "running";
  if (process.steps.some((step) => step.status === "failed")) return "failed";
  return "completed";
}

function pluginAuthorizationLink(part: Record<string, unknown>): PreviewMessagePartView | undefined {
  if (part.state !== 'output-available') return;
  const output = record(part.output);
  try {
    const url = new URL(text(output.authorizationUrl));
    if (url.protocol !== 'https:' || url.username || url.password) return;
    return { kind: 'authorization', label: text(record(output.connection).name) || 'MCP', text: url.toString() };
  } catch { return; }
}

export function previewMessagePartViews(message: PreviewMessageLike, approvals: RuntimeApprovalState[] = []): PreviewMessagePartView[] {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.flatMap((value): PreviewMessagePartView[] => {
    const part = record(value);
    const type = text(part.type);
    if (!type) return [];
    if (type === "text" && text(part.text)) return [{ kind: "text", text: text(part.text) }];
    if (type === "reasoning" && text(part.text)) return [{ kind: "reasoning", text: text(part.text) }];
    if (type === "source-url") {
      const url = text(part.url);
      return url ? [{ kind: "citation", label: text(part.title) || "网页来源", text: url }] : [];
    }
    if (type === "source-document") {
      const label = text(part.title) || text(part.filename) || "文档来源";
      return [{ kind: "citation", label, text: text(part.id) || label }];
    }
    if (type === "file") {
      const label = text(part.filename) || text(part.mediaType) || "Artifact";
      return [{ kind: "artifact", label, ...(text(part.mediaType) ? { mediaType: text(part.mediaType) } : {}), text: text(part.url) || label }];
    }
    if (type === "dynamic-tool" || type.startsWith("tool-")) {
      const state = text(part.state);
      const proposal = record(record(part.output).approval);
      const approvalId = text(proposal.id);
      const current = approvals.find((approval) => approval.id === approvalId);
      const approvalState = current ? approvalDisplayState(current)
        : approvalId ? approvalDisplayState({ id: approvalId, status: text(proposal.status), expiresAt: text(proposal.expiresAt) }) : undefined;
      const authorization = type === 'tool-mate_mcp_manage' || part.toolName === 'mate_mcp_manage'
        ? pluginAuthorizationLink(part) : undefined;
      return [{
        details: toolResourceViews(part),
        kind: "tool",
        label: text(part.toolName) || type.replace(/^tool-/, ""),
        ...(approvalId ? { approvalId } : {}),
        status: approvalState?.status ?? toolStatus(state),
        text: approvalState?.text ?? toolStateLabel(state)
      }, ...(authorization ? [authorization] : [])];
    }
    if (type === "data-mate-process" || type === "data-mate-turn") return [];
    if (
      type === "data-mate-task"
      && text(record(part.data).schemaVersion) === "workspace.mate-chat-terminal/v1"
    ) return [];
    if (type === "data-mate-citations") {
      const sources = Array.isArray(record(part.data).sources) ? record(part.data).sources as unknown[] : [];
      const files = mateFileReferencesFromCitations(part.data);
      const fileIds = new Set(files.map((file) => file.objectId));
      return [
        ...files.map((file): PreviewMessagePartView => ({ kind: "artifact", label: file.fileName, text: file.url })),
        ...sources.flatMap((source): PreviewMessagePartView[] => {
        const citation = record(source);
        if (fileIds.has(text(citation.objectId))) return [];
        const serviceName = text(citation.serviceName) || "Knowledge";
        const path = text(citation.relativePath) || text(citation.url);
        return path ? [{ kind: "citation", label: serviceName, text: path }] : [];
        })
      ];
    }
    if (type.startsWith("data-")) {
      return [{ kind: "data", label: type.slice(5) || "data", text: dataPartSummary(part.data) }];
    }
    return [];
  });
}

export function previewMessageTurnProcess(message: PreviewMessageLike, approvals: RuntimeApprovalState[] = []): PreviewTurnProcess | undefined {
  const parts = previewMessagePartViews(message, approvals);
  const timing = previewMessageProcessTiming(message);
  let endPartIndex = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.kind === "reasoning" || parts[index]?.kind === "tool") {
      endPartIndex = index;
      break;
    }
  }
  if (endPartIndex < 0) {
    return timing ? { endPartIndex: -1, startPartIndex: 0, steps: [], timing } : undefined;
  }
  const startPartIndex = parts.findIndex((part, index) => (
    index <= endPartIndex && (part.kind === "reasoning" || part.kind === "text" || part.kind === "tool")
  ));
  const steps = parts.slice(startPartIndex, endPartIndex + 1).flatMap((part): PreviewProcessStep[] => {
    if (part.kind === "tool") return [{ ...part, kind: "tool" }];
    if (part.kind === "reasoning") return [{ kind: "reasoning", label: "过程摘要", text: part.text }];
    if (part.kind === "text") return [{ kind: "progress", label: "执行说明", text: part.text }];
    return [];
  }).reduce<PreviewProcessStep[]>((result, step) => {
    const previous = result.at(-1);
    if (previous && step.kind !== "tool" && previous.kind === step.kind) {
      previous.text = `${previous.text}\n\n${step.text}`;
      return result;
    }
    result.push(step);
    return result;
  }, []);
  return {
    endPartIndex,
    startPartIndex,
    steps,
    timing
  };
}

function previewMessageProcessTiming(message: PreviewMessageLike): PreviewTurnProcess["timing"] {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = record(parts[index]);
    if (text(part.type) !== "data-mate-process") continue;
    const data = record(part.data);
    if (text(data.schemaVersion) !== "workspace.mate-process/v1") continue;
    const startedAt = isoTimestamp(data.startedAt);
    const status = text(data.status);
    if (!startedAt || !["cancelled", "completed", "failed", "paused", "running"].includes(status)) continue;
    const completedAt = isoTimestamp(data.completedAt);
    const durationMs = safeDuration(data.durationMs);
    return {
      ...(completedAt ? { completedAt } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      startedAt,
      status: status as NonNullable<PreviewTurnProcess["timing"]>["status"]
    };
  }
  return undefined;
}

function isoTimestamp(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return "";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : "";
}

function safeDuration(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 7 * 24 * 60 * 60_000
    ? Math.round(value)
    : undefined;
}

export function previewMessageResources(messages: PreviewMessageLike[]) {
  const seen = new Set<string>();
  return messages.flatMap((message) => previewMessagePartViews(message)).flatMap(nestedResourceViews).filter((part) => {
    const key = `${part.kind}\u0000${part.label ?? ""}\u0000${part.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nestedResourceViews(part: PreviewMessagePartView): PreviewMessagePartView[] {
  const current = part.kind === "artifact" || part.kind === "citation" ? [part] : [];
  return [...current, ...(part.details ?? []).flatMap(nestedResourceViews)];
}

function toolResourceViews(part: Record<string, unknown>): PreviewMessagePartView[] {
  const output = record(part.output);
  const toolName = text(part.toolName) || text(part.type).replace(/^tool-/, "");
  const files = mateFileReferencesFromTool(toolName, output);
  if (files.length) return files.map((file) => ({ kind: "artifact", label: file.fileName, text: file.url }));
  if (["tools_image_generation", "tools_video_generation", "tools_audio_tts"].includes(toolName)) {
    const artifactId = text(output.artifactId);
    if (!/^art_[0-9a-f-]{36}$/.test(artifactId)) return [];
    const extension = toolName === "tools_image_generation" ? "png" : toolName === "tools_video_generation" ? "mp4" : text(output.format) || "mp3";
    return [{ kind: "artifact", label: `generated-${toolName.slice(6).replace("_generation", "")}.${extension}`, text: `/api/workspace-files/${artifactId}/download` }];
  }
  if (toolName === "knowledge_base_search") {
    const searches = Array.isArray(output.searches) ? output.searches : [];
    return searches.flatMap((value) => {
      const search = record(value);
      const service = record(search.service);
      const serviceName = text(service.name) || text(service.serviceId) || "Knowledge";
      const results = Array.isArray(search.results) ? search.results : [];
      return results.flatMap((value): PreviewMessagePartView[] => {
        const result = record(value);
        const path = text(result.relativePath) || text(result.fileName) || text(result.objectId);
        return path ? [{ kind: "citation", label: serviceName, text: path }] : [];
      });
    });
  }
  if (toolName === "knowledge_file_read" || toolName === "knowledge_base_handbook") {
    const file = record(output.file);
    const path = text(file.relativePath) || text(file.fileName) || text(file.objectId);
    return path ? [{
      kind: "citation",
      label: text(file.serviceName) || text(file.serviceId) || "Knowledge",
      text: path
    }] : [];
  }
  if (["workspace_file_create", "workspace_image_generate", "workspace_video_generate", "workspace_audio_generate", "workspace_file_save_to_knowledge"].includes(toolName)) {
    const file = record(output.file);
    const url = safeArtifactUrl(file.downloadUrl) || safeArtifactUrl(file.previewUrl);
    const label = text(file.fileName) || text(file.path) || "Agent Workspace file";
    return label ? [{ kind: "artifact", label, text: url || text(file.path) || label }] : [];
  }
  if (toolName === "public_web_read") {
    const url = safePublicUrl(output.url);
    return url ? [{ kind: "citation", label: "公开网页", text: url }] : [];
  }
  if (["public_web_search", "exa_web_search", "tools_web_search"].includes(toolName)) {
    const results = Array.isArray(output.results) ? output.results : [];
    const sources = results.flatMap((value): PreviewMessagePartView[] => {
      const result = record(value);
      const url = safePublicUrl(result.url);
      return url ? [{ kind: "citation", label: text(result.title) || "网页搜索结果", text: url }] : [];
    });
    const summary: PreviewMessagePartView[] = output.truncated === true
      ? [{ kind: "data", label: "结果预览 / Result preview", text: `已保留 ${sources.length} 个来源链接；正文已省略。 / ${sources.length} source links retained; full text omitted.` }]
      : typeof output.count === "number" && output.count === 0
        ? [{ kind: "data", label: "搜索结果 / Search results", text: "没有找到结果。 / No results found." }]
        : [];
    return [...summary, ...sources];
  }
  if (toolName === "forum_read") {
    const topics = Array.isArray(output.topics) ? output.topics : [];
    const topic = record(output.topic);
    return [...topics, ...(text(topic.id) ? [topic] : [])].flatMap((value): PreviewMessagePartView[] => {
      const item = record(value);
      const topicId = text(item.id);
      return topicId ? [{ kind: "citation", label: text(item.title) || "Workspace Forum", text: `Workspace Forum · ${topicId}` }] : [];
    });
  }
  if (toolName === "workspace_forum_search") {
    return (Array.isArray(part.output) ? part.output : []).flatMap((value): PreviewMessagePartView[] => {
      const topic = record(value);
      const topicId = text(topic.id);
      return topicId ? [{ kind: "citation", label: text(topic.title) || "Workspace Forum", text: `Workspace Forum · ${topicId}` }] : [];
    });
  }
  if (toolName === "workspace_forum_topic_read") {
    const topicId = text(output.id);
    return topicId ? [{ kind: "citation", label: text(output.title) || "Workspace Forum", text: `Workspace Forum · ${topicId}` }] : [];
  }
  return [];
}

function toolStateLabel(value: string) {
  if (value === "input-streaming") return "正在准备参数";
  if (value === "input-available") return "等待执行";
  if (value === "output-available") return "已完成";
  if (value === "output-error") return "执行失败";
  if (value === "approval-requested") return "等待批准";
  if (value === "output-denied") return "未获批准";
  return value || "正在调用";
}

function toolStatus(value: string): PreviewMessagePartView["status"] {
  if (value === "output-available") return "completed";
  if (value === "output-error" || value === "output-denied") return "failed";
  if (value === "approval-requested" || value === "input-available") return "waiting";
  return "running";
}

function safeArtifactUrl(value: unknown) {
  const url = text(value);
  return /^\/api\/workspace-files\/[A-Za-z0-9_%.-]+\/(raw|download)$/.test(url) ? url : "";
}

function safePublicUrl(value: unknown) {
  const url = text(value);
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.toString() : "";
  } catch { return ""; }
}

export function previewMessageText(message: PreviewMessageLike) {
  return previewMessagePartViews(message)
    .filter((part) => part.kind === "text" || part.kind === "reasoning")
    .map((part) => part.text)
    .join("\n\n");
}

function dataPartSummary(value: unknown) {
  if (typeof value === "string") return value.slice(0, 500);
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object") return "Data event";
  const source = value as Record<string, unknown>;
  for (const key of ["title", "label", "summary", "status", "state", "name"]) {
    const candidate = text(source[key]);
    if (candidate) return candidate.slice(0, 500);
  }
  return "Structured data";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function previewMessageExecution(message: PreviewMessageLike | undefined): { state: "paused" | "completed"; reason?: string } | undefined {
  for (const item of message?.parts ?? []) {
    const part = record(item);
    if (part.type !== "data-mate-turn") continue;
    const data = record(part.data);
    const execution = record(data.execution);
    if (execution.state === "paused" || execution.state === "completed") return { state: execution.state, ...(typeof execution.reason === "string" ? { reason: execution.reason } : {}) };
  }
  return undefined;
}
