import { Check, ChevronRight, CircleAlert, Clock3, LoaderCircle, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  previewTurnProcessStatus,
  type PreviewProcessStep,
  type PreviewTurnProcess
} from "../messageParts";
import { useMateLocale, type MateLocale } from "../locale";

export function TurnProcessDisclosure({ active, onOpenChange, open, process }: {
  active: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  process: PreviewTurnProcess;
}) {
  const { locale, text } = useMateLocale();
  const status = previewTurnProcessStatus(active, process);
  const latest = latestProcessStep(process.steps);
  const durationMs = useProcessDuration(status === "running", process.timing);
  const duration = durationMs === undefined ? "" : formatDuration(durationMs, locale);
  const toolCount = process.steps.filter((step) => step.kind === "tool").length;

  return (
    <details
      className="tm-preview-turn-process"
      data-status={status}
      data-testid="preview-turn-process"
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      open={open}
    >
      <summary>
        <ProcessStatusIcon status={status} />
        <span className="tm-preview-process-state" role="status">{processStatusLabel(status, locale)}</span>
        {duration && <span aria-hidden="true" className="tm-preview-process-duration">{duration}</span>}
        <strong>{latestProcessLabel(latest, locale)}</strong>
        <em>{status === "failed" || status === "cancelled" || status === "paused" || status === "waiting"
          ? processStatusLabel(status, locale) : latestProcessState(latest, status === "running", locale)}</em>
        <ChevronRight aria-hidden="true" className="tm-preview-process-chevron" size={14} />
      </summary>

      <div className="tm-preview-process-heading">
        <strong>{text("处理过程", "Process")}</strong>
        <span>{text(`${process.steps.length} 个步骤 · ${toolCount} 次工具调用`, `${process.steps.length} steps · ${toolCount} tool calls`)}</span>
      </div>
      <ol className="tm-preview-process-steps">
        {process.steps.map((step, index) => (
          <li key={`${step.kind}-${step.label || "step"}-${index}`}>
            {step.kind === "tool"
              ? <ToolProcessStep index={index} step={step} />
              : <SummaryProcessStep index={index} step={step} />}
          </li>
        ))}
      </ol>
    </details>
  );
}

function SummaryProcessStep({ index, step }: { index: number; step: PreviewProcessStep }) {
  const { text } = useMateLocale();
  return (
    <div className={`tm-preview-process-summary is-${step.kind}`} data-testid="preview-process-summary">
      <span className="tm-preview-process-index">{index + 1}</span>
      <div>
        <strong>{localizeStepLabel(step.label, step.kind, text)}</strong>
        <p>{step.text}</p>
      </div>
    </div>
  );
}

function ToolProcessStep({ index, step }: { index: number; step: PreviewProcessStep }) {
  const { locale, text } = useMateLocale();
  return (
    <details
      className="tm-preview-process-tool"
      data-status={step.status || "running"}
      data-testid="preview-process-tool"
    >
      <summary>
        <span className="tm-preview-process-index">{index + 1}</span>
        <span className="tm-preview-process-tool-name">
          <strong>{toolDisplayName(step.label, locale)}</strong>
          <code>{step.label || "tool"}</code>
        </span>
        <em>{localizeToolState(step.text, text)}</em>
        <ChevronRight aria-hidden="true" className="tm-preview-process-chevron" size={13} />
      </summary>
      <div className="tm-preview-process-tool-detail">
        {(step.details?.length ?? 0) > 0
          ? step.details?.map((detail, detailIndex) => (
              <div className={`tm-preview-process-result is-${detail.kind}`} key={`${detail.kind}-${detailIndex}`}>
                <strong>{detail.label || detail.kind}</strong>
                {detail.kind === "citation" && /^https:\/\//.test(detail.text)
                  ? <a href={detail.text} rel="noopener noreferrer" target="_blank">{detail.text}</a>
                  : <span>{detail.text}</span>}
              </div>
            ))
          : <p>{text("此工具没有可显示的结果详情。", "This tool has no displayable result details.")}</p>}
      </div>
    </details>
  );
}

function useProcessDuration(active: boolean, timing: PreviewTurnProcess["timing"]) {
  const [now, setNow] = useState(() => Date.now());
  const running = active;
  useEffect(() => {
    if (!running || !timing?.startedAt) return undefined;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [running, timing?.startedAt]);
  return useMemo(() => {
    if (timing?.durationMs !== undefined) return timing.durationMs;
    if (!timing?.startedAt) return undefined;
    const startedAt = Date.parse(timing.startedAt);
    const completedAt = timing.completedAt ? Date.parse(timing.completedAt) : undefined;
    if (!Number.isFinite(startedAt)) return undefined;
    return Math.max(0, (Number.isFinite(completedAt) ? completedAt as number : now) - startedAt);
  }, [now, timing?.completedAt, timing?.durationMs, timing?.startedAt]);
}

function processStatusLabel(status: ReturnType<typeof previewTurnProcessStatus>, locale: MateLocale) {
  if (locale === "en") {
    if (status === "paused") return "Process paused";
    if (status === "failed") return "Process incomplete";
    if (status === "cancelled") return "Process cancelled";
    if (status === "waiting") return "Awaiting confirmation";
    if (status === "running") return "Processing";
    return "Processed";
  }
  if (status === "paused") return "处理已暂停";
  if (status === "failed") return "处理未完成";
  if (status === "cancelled") return "处理已取消";
  if (status === "waiting") return "等待确认";
  if (status === "running") return "正在处理";
  return "已处理";
}

function latestProcessStep(steps: PreviewProcessStep[]) {
  return [...steps].reverse().find((step) => step.status === "running" || step.status === "waiting") ?? [...steps].reverse().find((step) => step.approvalId) ?? steps.at(-1);
}

function latestProcessLabel(step: PreviewProcessStep | undefined, locale: MateLocale) {
  if (!step) return locale === "en" ? "Process" : "处理过程";
  if (step.kind === "tool") return toolDisplayName(step.label, locale);
  if (step.label === "过程摘要") return locale === "en" ? "Process summary" : step.label;
  if (step.label === "执行说明") return locale === "en" ? "Execution note" : step.label;
  return step.label || (step.kind === "reasoning" ? (locale === "en" ? "Process summary" : "过程摘要") : (locale === "en" ? "Execution note" : "执行说明"));
}

function latestProcessState(step: PreviewProcessStep | undefined, active: boolean, locale: MateLocale) {
  if (!step) return active ? (locale === "en" ? "In progress" : "进行中") : (locale === "en" ? "Completed" : "已完成");
  if (step.kind === "tool") return localizeToolState(step.text, (zh, en) => locale === "en" ? en : zh);
  return active ? (locale === "en" ? "In progress" : "进行中") : (locale === "en" ? "Completed" : "已完成");
}

function formatDuration(durationMs: number, locale: MateLocale) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (locale === "en") {
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  }
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours}时${String(minutes % 60).padStart(2, "0")}分`;
}

function toolDisplayName(value: string | undefined, locale: MateLocale) {
  const names: Record<string, [string, string]> = {
    forum_read: ["读取 Workspace Forum", "Read Workspace Forum"],
    forum_write: ["写入 Workspace Forum", "Write Workspace Forum"],
    workspace_forum_search: ["搜索 Workspace Forum", "Search Workspace Forum"],
    workspace_forum_topic_read: ["读取 Workspace Forum 帖子", "Read Workspace Forum topic"],
    knowledge_base_search: ["搜索知识库", "Search knowledge"],
    knowledge_file_read: ["读取知识库文件", "Read knowledge file"],
    public_web_read: ["读取公开网页", "Read public webpage"],
    public_web_search: ["搜索公开网页", "Search public web"],
    web_search: ["联网搜索", "Search the web"],
    exa_web_search: ["Exa 联网搜索", "Search the web with Exa"],
    workspace_file_create: ["创建 Workspace 文件", "Create workspace file"]
  };
  const name = names[value || ""];
  return name ? name[locale === "en" ? 1 : 0] : (locale === "en" ? "Use tool" : "使用工具");
}

function localizeStepLabel(label: string | undefined, kind: PreviewProcessStep["kind"], text: (chinese: string, english: string) => string) {
  if (label === "过程摘要") return text("过程摘要", "Process summary");
  if (label === "执行说明") return text("执行说明", "Execution note");
  return label || (kind === "reasoning" ? text("过程摘要", "Process summary") : text("执行说明", "Execution note"));
}

function localizeToolState(value: string, text: (chinese: string, english: string) => string) {
  const known: Record<string, string> = {
    "正在准备参数": text("正在准备参数", "Preparing input"),
    "等待执行": text("等待执行", "Ready to run"),
    "已完成": text("已完成", "Completed"),
    "执行失败": text("执行失败", "Failed"),
    "等待批准": text("等待批准", "Awaiting approval"),
    "未获批准": text("未获批准", "Denied"),
    "提案已生成，等待审核": text("提案已生成，等待审核", "Proposal ready, awaiting approval"),
    "未获批准，已取消": text("未获批准，已取消", "Denied, cancelled"),
    "审批已过期，未执行": text("审批已过期，未执行", "Approval expired, not executed"),
    "审核通过，执行成功": text("审核通过，执行成功", "Approved, execution succeeded"),
    "审核通过，执行失败": text("审核通过，执行失败", "Approved, execution failed"),
    "任务已取消": text("任务已取消", "Task cancelled"),
    "审核通过，等待执行结果": text("审核通过，等待执行结果", "Approved, awaiting execution result"),
    "正在调用": text("正在调用", "Running")
  };
  return known[value] || value;
}

function ProcessStatusIcon({ status }: { status: ReturnType<typeof previewTurnProcessStatus> }) {
  if (status === "completed") return <Check aria-hidden="true" size={14} />;
  if (status === "failed" || status === "cancelled") return <CircleAlert aria-hidden="true" size={14} />;
  if (status === "waiting") return <Clock3 aria-hidden="true" size={14} />;
  if (status === "running") return <LoaderCircle aria-hidden="true" className="tm-preview-process-spinner" size={14} />;
  return <Wrench aria-hidden="true" size={14} />;
}
