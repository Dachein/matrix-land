import type { UIMessage } from "ai";
import { lazy, Suspense, useState } from "react";
import { previewMessagePartViews, previewMessageResources, previewMessageTurnProcess, previewTurnProcessStatus, type PreviewMessageLike } from "../messageParts";
import { MateAvatar, UserAvatar } from "./MateAvatar";
import { TurnProcessDisclosure } from "./TurnProcessDisclosure";
import { PendingTurnStatus, type PendingTurn } from "./PendingTurnStatus";
import { useMateLocale } from "../locale";
import { ConversationFile } from "./ConversationFile";
import type { MatePetMotion } from "../../../../src/shared/matePet";

import type { RuntimeApprovalState } from "../approvalState";

const MateMarkdownMessage = lazy(async () => {
  const module = await import("../MarkdownMessage");
  return { default: module.MateMarkdownMessage };
});

export function MateMessage({ active = false, approvals = [], message, motion, onLoadFile, onOpenFile, pendingTurn, mate, user }: {
  active?: boolean;
  approvals?: RuntimeApprovalState[];
  message: UIMessage;
  motion?: MatePetMotion;
  onLoadFile?: (url: string) => Promise<Blob>;
  onOpenFile?: (url: string, fileName: string) => void;
  pendingTurn?: PendingTurn;
  mate: { avatarUrl?: string; displayName: string };
  user?: { avatarUrl?: string; name: string };
}) {
  const { text } = useMateLocale();
  const [processOpen, setProcessOpen] = useState(false);
  const parts = previewMessagePartViews(message as PreviewMessageLike, approvals);
  const directFileUrls = new Set(parts.filter((part) => part.kind === "artifact").map((part) => part.text));
  const toolFiles = previewMessageResources([message as PreviewMessageLike]).filter((part) => (
    part.kind === "artifact" && part.text.startsWith("/api/workspace-files/") && !directFileUrls.has(part.text)
  ));
  const process = previewMessageTurnProcess(message as PreviewMessageLike, approvals);
  const failed = process && previewTurnProcessStatus(active, process) === "failed";
  const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "system";
  const avatar = role === "assistant"
    ? <MateAvatar active={active} avatarUrl={mate.avatarUrl} motion={motion} name={mate.displayName} />
    : role === "user"
      ? <UserAvatar avatarUrl={user?.avatarUrl} name={user?.name} />
      : null;
  return (
    <article
      className={`tm-preview-message is-${role}`}
      data-message-id={message.id}
      data-testid={`preview-message-${role}`}
    >
      {role !== "assistant" && avatar}
      <div className="tm-preview-message-column">
        {role === "assistant" ? (
          <header className="tm-preview-message-header">
            {avatar}
            <div className="tm-preview-message-role">{mate.displayName}</div>
          </header>
        ) : (
          <div className="tm-preview-message-role">
            {role === "user" ? user?.name || text("你", "You") : text("系统", "System")}
          </div>
        )}
        <div className="tm-preview-message-body">
          {!process && pendingTurn && <PendingTurnStatus turn={pendingTurn} />}
          {process?.endPartIndex === -1 && <TurnProcessDisclosure active={active} onOpenChange={setProcessOpen} open={processOpen} process={process} />}
          {failed && <p className="tm-preview-muted" role="alert">{text("本次回复未完成。请先核对已执行的操作，再继续对话。", "This response failed. Check any operations already performed before continuing.")}</p>}
          {parts.length === 0
            ? process || pendingTurn ? null : <p className="tm-preview-muted" role={active ? "status" : "alert"}>{active
              ? text("正在生成回复…", "Generating a response…")
              : text("没有可显示的回复内容，请重试或发送新消息。", "No response content is available. Retry or send another message.")}</p>
            : parts.map((part, index) => {
                if (process && process.endPartIndex >= 0 && index === process.startPartIndex) {
                  return <TurnProcessDisclosure active={active} key="turn-process" onOpenChange={setProcessOpen} open={processOpen} process={process} />;
                }
                if (
                  process
                  && index >= process.startPartIndex
                  && index <= process.endPartIndex
                  && (part.kind === "reasoning" || part.kind === "text" || part.kind === "tool")
                ) return null;
                if (part.kind === "text") {
                  return (
                    <Suspense fallback={<p>{part.text}</p>} key={`${part.kind}-${index}`}>
                      <MateMarkdownMessage content={part.text} />
                    </Suspense>
                  );
                }
                if (part.kind === "reasoning" || part.kind === "tool") return null;
                if (part.kind === 'authorization') return <div className="tm-preview-part" key={`authorization-${index}`}>
                  <strong>{text(`授权 ${part.label}`, `Authorize ${part.label}`)}</strong>
                  <p>{text('在服务网页完成登录与授权。Workspace 安全保存令牌，Mate 会继续检查连接。', 'Sign in and authorize on the service website. Workspace stores credentials securely; Mate continues checking the connection.')}</p>
                  <a href={part.text} rel="noopener noreferrer" referrerPolicy="no-referrer">{text('打开授权网页', 'Open authorization page')}</a>
                </div>;
                if (part.kind === "artifact") return <ConversationFile fileName={part.label || text("文件", "File")} key={`${part.kind}-${index}`} mediaType={part.mediaType} onLoad={onLoadFile} onOpen={onOpenFile} url={part.text} />;
                return (
                  <div className={`tm-preview-part is-${part.kind}`} key={`${part.kind}-${index}`}>
                    <strong>{part.label || part.kind}</strong><span>{part.text}</span>
                  </div>
                );
              })}
          {parts.some((part) => part.approvalId) && <p className="tm-preview-muted" role="status">{text("以上回复保留提案时的记录；最新审核与执行状态请见处理过程。", "The reply above preserves the original proposal. See the process for the latest approval and execution status.")}</p>}
          {toolFiles.map((file) => <ConversationFile fileName={file.label || text("文件", "File")} key={`tool-file-${file.text}`} mediaType={file.mediaType} onLoad={onLoadFile} onOpen={onOpenFile} url={file.text} />)}
        </div>
      </div>
    </article>
  );
}
