import { Bug, RotateCw } from "lucide-react";
import { useState } from "react";
import type { MatePreviewSession } from "../api";
import type { MateSurfaceSnapshot } from "../surfaceState";
import { useMateLocale } from "../locale";

export default function DebugInspector({
  connection,
  isRecovering,
  isStreaming,
  lastError,
  lastOutcome,
  messageCount,
  onReconnect,
  session
}: {
  connection: MateSurfaceSnapshot["connection"];
  isRecovering: boolean;
  isStreaming: boolean;
  lastError: string;
  lastOutcome: MateSurfaceSnapshot["lastOutcome"];
  messageCount: number;
  onReconnect: () => void;
  session: MatePreviewSession;
}) {
  const { text } = useMateLocale();
  const [open, setOpen] = useState(false);
  return (
    <aside className={open ? "tm-preview-debug is-open" : "tm-preview-debug"}>
      <button className="tm-preview-debug-toggle" onClick={() => setOpen((value) => !value)} type="button">
        <Bug size={15} />{open ? text("收起调试", "Close debug") : text("打开调试", "Open debug")}
      </button>
      <div data-testid="preview-debug-inspector" hidden={!open}>
        <p className="tm-preview-eyebrow">SDK Host Inspector</p>
        <h2>{text("Runtime 状态", "Runtime status")}</h2>
        <DebugRow field="mode" label="Namespace" value={session.mode} />
        <DebugRow field="release" label="Release" value={session.release.id} />
        <DebugRow field="conversation" label="Conversation" value={session.conversationId} />
        <DebugRow field="connection" label="Connection" value={connection} />
        <DebugRow field="hydration" label="Hydration" value="ready" />
        <DebugRow field="streaming" label="Streaming" value={String(isStreaming)} />
        <DebugRow field="recovering" label="Recovering" value={String(isRecovering)} />
        <DebugRow field="message-count" label="Messages" value={String(messageCount)} />
        <DebugRow field="last-outcome" label="Last outcome" value={lastOutcome} />
        <DebugRow field="last-error" label="Last error" value={lastError} />
        <div className="tm-preview-debug-actions">
          <button data-testid="preview-reconnect" onClick={onReconnect} type="button"><RotateCw size={15} />{text("重新挂载并加载", "Remount and hydrate")}</button>
        </div>
        <p className="tm-preview-secret-note">{text("Bearer 与聊天授权不会在检查器、URL、存储或日志中显示。", "Bearer and chat grants are never shown in the inspector, URL, storage, or logs.")}</p>
      </div>
    </aside>
  );
}

function DebugRow({ field, label, value }: { field: string; label: string; value: string }) {
  return <div className="tm-preview-debug-row" data-debug-field={field}><span>{label}</span><strong>{value}</strong></div>;
}
