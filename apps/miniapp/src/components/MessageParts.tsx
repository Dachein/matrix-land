import { Button, Image, Text, View } from "@tarojs/components";
import { memo, useEffect, useState } from "react";
import { MarkdownMessage } from "./MarkdownMessage";
import { chatProcessStatus, chatTurnProcess, shouldShowChatProcess, isProcessPart, isVisibleChatPart, latestChatProcessStep, type ChatProcessStep, type ChatTurnProcess } from "../services/chatPresentation";
import type { ChatMessage, ChatPart, LiveSession, RuntimeApproval } from "../types";
import { summarize } from "../utils/format";
import { useI18n } from "../services/i18n";
import { fileTypeIcon } from "../services/fileTypeIcons";
import { mateFileReferenceFromUrl, mateFileReferencesFromCitations, mateFileReferencesFromTool } from "../../../../src/shared/mateFileReference.js";
import { MateFileLink } from "./MateFileLink";
import { ChatImage } from "./ChatImage";
import { chatImageSegments } from "../services/chatImages";
import { chatFileMetadata, markdownFileUrls } from "../services/fileCard";
import { filePreviewKind } from "../services/filePreview";
import { messageLinks } from "../services/chatLinks";

export type ApprovalHandler = (toolCallId: string, approved: boolean) => void;
export type PartOpenHandler = (part: ChatPart) => void;

/**
 * Renders one assistant turn. Memoised on `message` identity, which the reducer keeps
 * stable for every message except the one receiving the current stream chunk — so a
 * streaming reply re-renders alone instead of re-parsing every earlier message's
 * Markdown on each delta.
 */
export const MessageParts = memo(function MessageParts({ active, message, onApproval, onOpen, approvals = [], session }: {
  active: boolean;
  session?: LiveSession;
  message: ChatMessage;
  onApproval: ApprovalHandler;
  onOpen: PartOpenHandler;
  approvals?: RuntimeApproval[];
}) {
  const { t } = useI18n();
  const process = chatTurnProcess(message, approvals);
  const seenFiles = new Set(message.parts.filter((part) => part.type === "file").map((part) => mateFileReferenceFromUrl(part.url, part.filename)?.url));
  const inlineImages = new Set(message.parts.filter(part => part.type === "text").flatMap(part => chatImageSegments(part.text || "")).filter(part => part.type === "image").map(part => part.url));
  const inlineFiles = new Set(message.parts.filter(part => part.type === "text").flatMap(part => markdownFileUrls(part.text || "")));
  inlineImages.forEach(url => seenFiles.add(url));
  inlineFiles.forEach(url => seenFiles.add(url));
  const fileLinks = message.parts.flatMap((part) => part.type === "data-mate-citations"
    ? mateFileReferencesFromCitations(part.data)
    : mateFileReferencesFromTool(part.toolName || part.type.replace(/^tool-/, ""), part.output)
  ).filter((file) => {
    if (seenFiles.has(file.url)) return false;
    seenFiles.add(file.url);
    return true;
  });
  return <View className="message-parts">
    {process && shouldShowChatProcess(active, process) && <ProcessDisclosure active={active} process={process} onApproval={onApproval} />}
    {message.parts.map((part, index) => {
      if (isProcessPart(part)) return null;
      if (part.type === "file" && (inlineImages.has(mateFileReferenceFromUrl(part.url, part.filename)?.url || "") || inlineFiles.has(mateFileReferenceFromUrl(part.url, part.filename)?.url || ""))) return null;
      if (!isVisibleChatPart(part)) return null;
      return <Part key={`${part.id || part.toolCallId || part.type}-${index}`} part={part} onOpen={onOpen} onApproval={onApproval} session={session} />;
    })}
    {fileLinks.map((file) => filePreviewKind(file.fileName) === "image"
      ? <ChatImage key={file.url} name={file.fileName} url={file.url} session={session} onOpenFile={() => onOpen({ type: "file", filename: file.fileName, url: file.url })} />
      : <MateFileLink file={file} key={file.url} {...chatFileMetadata(file, message.parts)} onOpen={(selected) => { const metadata = chatFileMetadata(file, message.parts); onOpen({ type: "file", filename: selected.fileName, url: selected.url, mediaType: metadata.mimeType, sizeBytes: metadata.sizeBytes }); }} />)}
    {messageLinks(message).map((link) => <View className="source-card" key={link.key} onClick={link.url ? () => onOpen({ type: "source-url", url: link.url, title: link.label }) : undefined}>
      <Text className="part-label">{link.authorization ? t("chat.authorization") : t("parts.source")}</Text>
      <Text className="source-title">{link.label}</Text>
      {link.authorization && <Text className="runtime-approval-operation">{t("chat.copyAuthorization")}</Text>}
    </View>)}
  </View>;
});

/** Memoised so a streaming turn does not re-render settled tool/file/source cards. */
const Part = memo(function Part({ part, onApproval, onOpen, session }: { part: ChatPart; onApproval: ApprovalHandler; onOpen: PartOpenHandler; session?: LiveSession }) {
  const { t } = useI18n();
  if (part.type === "text") return <View>{chatImageSegments(part.text || "").map((segment, index) => segment.type === "image"
    ? <ChatImage key={`${segment.url}-${index}`} name={segment.name} url={segment.url} session={session} onOpenFile={() => onOpen({ type: "file", filename: segment.name, mediaType: "image/*", url: segment.url })} />
    : <MarkdownMessage key={index} content={segment.text} onOpenFile={(url, filename) => onOpen({ type: "file", url, filename })} />)}</View>;
  if (part.type === "file") {
    const reference = mateFileReferenceFromUrl(part.url, part.filename || t("parts.generatedFile"));
    if (reference && filePreviewKind(part.filename || "", part.mediaType) === "image") return <ChatImage name={part.filename || t("preview.image")} url={reference.url} session={session} onOpenFile={() => onOpen(part)} />;
    return reference
      ? <MateFileLink file={reference} mimeType={part.mediaType} sizeBytes={part.sizeBytes} onOpen={(selected) => onOpen({ ...part, url: selected.url })} />
      : <View className="file-card" onClick={() => onOpen(part)}><Image className="file-icon" src={fileTypeIcon(part.filename || "", part.mediaType)} mode="aspectFit" /><View><Text className="file-name">{part.filename || t("parts.generatedFile")}</Text><Text className="file-type">{part.mediaType || t("parts.file")} · {t("parts.open")}</Text></View></View>;
  }
  if (part.type === "source-url" || part.type === "source-document") return <View className="source-card" onClick={() => onOpen(part)}><Text className="part-label">{t("parts.source")}</Text><Text className="source-title">{part.title || part.filename || part.url || t("parts.reference")}</Text></View>;
  if (part.type.startsWith("data-")) return <View className="data-card"><Text className="part-label">{t("parts.result")}</Text><Text>{summarize(part.data)}</Text></View>;
  const approval = part.state === "approval-requested" && part.approval?.approved === undefined;
  return <View className={`tool-card ${part.state || ""}`}>
    <Text className="tool-label">{part.title || part.toolName || part.type.replace(/^tool-/, "") || t("parts.toolCall")}</Text>
    <Text className="tool-state">{toolStateLabel(part, t)}</Text>
    {part.errorText && <Text className="tool-error">{part.errorText}</Text>}
    {approval && <ApprovalActions toolCallId={part.toolCallId} onApproval={onApproval} />}
  </View>;
});

function ApprovalActions({ toolCallId, onApproval }: { toolCallId?: string; onApproval: ApprovalHandler }) {
  const { t } = useI18n();
  return <View className="approval-actions">
    <Button onClick={() => toolCallId && onApproval(toolCallId, false)}>{t("parts.reject")}</Button>
    <Button className="approve" onClick={() => toolCallId && onApproval(toolCallId, true)}>{t("parts.allowOnce")}</Button>
  </View>;
}

function ProcessDisclosure({ active, process, onApproval }: { active: boolean; process: ChatTurnProcess; onApproval: ApprovalHandler }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const status = chatProcessStatus(active, process);
  useEffect(() => {
    if (status === "completed") setOpen(false);
  }, [status]);
  const latest = latestChatProcessStep(process.steps);
  const toolCount = process.steps.filter((step) => step.kind === "tool").length;
  const expandable = toolCount > 0;
  const approval = process.steps.find((step) => step.needsApproval);
  return <View className={`turn-process ${status}`}>
    <View className="process-summary-row" onClick={expandable ? () => setOpen((value) => !value) : undefined}>
      <Text className={`process-status-icon ${status === "running" ? "spinning" : ""}`}>{statusIcon(status)}</Text>
      <Text className="process-state">{processStatusLabel(status, t)}</Text>
      <Text className="process-latest">{localizeProcessText(latest?.label || t("parts.process"), t)}</Text>
      {latest && <Text className="process-latest-state">{localizeProcessText(latest.text, t)}</Text>}
      {expandable && <Text className={`process-chevron ${open ? "open" : ""}`}>›</Text>}
    </View>
    {approval?.toolCallId && <ApprovalActions toolCallId={approval.toolCallId} onApproval={onApproval} />}
    {open && <View className="process-detail">
      <View className="process-heading"><Text>{t("parts.process")}</Text><Text>{t("parts.stepsAndTools", { steps: process.steps.length, tools: toolCount })}</Text></View>
      {process.steps.map((step, index) => <ProcessStep key={`${step.kind}-${step.label}-${index}`} index={index} step={step} t={t} />)}
    </View>}
  </View>;
}

function ProcessStep({ index, step, t }: { index: number; step: ChatProcessStep; t: ReturnType<typeof useI18n>["t"] }) {
  if (step.kind !== "tool") return <View className={`process-step process-${step.kind}`}>
    <Text className="process-index">{index + 1}</Text>
    <View className="process-step-body"><Text className="process-step-label">{localizeProcessText(step.label, t)}</Text><Text className="process-tool-state">{localizeProcessText(step.text, t)}</Text></View>
  </View>;
  return <View className={`process-step process-tool ${step.status || "running"}`}>
    <Text className="process-index">{index + 1}</Text>
    <View className="process-step-body">
      <Text className="process-step-label">{localizeProcessText(step.label, t)}</Text>
      <Text className="process-tool-state">{localizeProcessText(step.text, t)}</Text>
    </View>
  </View>;
}


function toolStateLabel(part: ChatPart, t: ReturnType<typeof useI18n>["t"]) {
  if (part.state === "approval-requested") return t("parts.approval");
  if (part.state === "output-available") return t("parts.completed");
  if (part.state === "output-error") return t("parts.failed");
  if (part.state === "output-denied") return t("parts.denied");
  if (part.state === "approval-responded") return part.approval?.approved ? t("parts.allowedContinue") : t("parts.denied");
  return t("parts.running");
}

function processStatusLabel(status: ReturnType<typeof chatProcessStatus>, t: ReturnType<typeof useI18n>["t"]) {
  return status === "paused" ? t("chat.paused") : status === "failed" ? t("parts.processFailed") : status === "cancelled" ? t("parts.processCancelled") : status === "waiting" ? t("parts.waitApproval") : status === "running" ? t("chat.statusProcessing") : t("parts.processCompleted");
}

function localizeProcessText(value: string, t: ReturnType<typeof useI18n>["t"]) {
  const map: Record<string, Parameters<typeof t>[0]> = {
    "思考": "parts.thinking", "进行中": "parts.inProgress", "已完成": "parts.completed", "需要你的确认": "parts.approval", "执行失败": "parts.failed", "已拒绝": "parts.denied", "已允许，继续执行": "parts.allowedContinue", "正在准备参数": "parts.preparing", "等待执行": "parts.waiting", "运行中": "parts.running", "处理过程": "parts.process"
  };
  return map[value] ? t(map[value]) : value;
}

function statusIcon(status: ReturnType<typeof chatProcessStatus>) {
  return status === "completed" ? "✓" : status === "failed" || status === "cancelled" ? "!" : status === "waiting" ? "◷" : "↻";
}
