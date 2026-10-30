import "./ChatRecoveryDialog.css";
import { AlertCircle } from "lucide-react";
import { Button } from "../../../../src/portal/components/Button";
import { useEffect, useRef, useState } from "react";
import { useMateLocale } from "../locale";

export function ChatRecoveryDialog({ onClose, onReconnect }: { onClose: () => void; onReconnect: () => Promise<void> }) {
  const { text } = useMateLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>(".primaryButton")?.focus();
    return () => element?.close();
  }, []);
  return <dialog aria-describedby="tm-chat-recovery-description" aria-labelledby="tm-chat-recovery-title" className="tm-preview-recovery-dialog" onCancel={(event) => event.preventDefault()} ref={dialog}>
    <header className="tm-preview-recovery-header">
      <h2 id="tm-chat-recovery-title">{text("重新连接当前对话", "Reconnect this conversation")}</h2>
    </header>
    <div className="tm-preview-recovery-body">
      <p id="tm-chat-recovery-description">{text("您长时间没有操作，为了保护你的对话安全，进入到休眠状态，请重新点击连接", "Your conversation has entered sleep mode after a long period of inactivity to keep it secure. Please reconnect to continue.")}</p>
      {failed && <p className="tm-preview-recovery-error" role="alert"><AlertCircle aria-hidden="true" size={16} />{text("暂时无法恢复连接，请稍后重试。", "Could not restore the connection. Please try again shortly.")}</p>}
    </div>
    <footer className="tm-preview-recovery-actions">
      <Button className="tm-preview-recovery-secondary" disabled={reconnecting} onClick={onClose} variant="secondary">{text("关闭当前对话", "Close conversation")}</Button>
      <Button autoFocus className="tm-preview-recovery-primary" isLoading={reconnecting} variant="primary" onClick={async () => {
        setReconnecting(true); setFailed(false);
        try { await onReconnect(); } catch { setFailed(true); } finally { setReconnecting(false); }
      }}>{reconnecting ? text("正在重新连接…", "Reconnecting…") : text("重新连接", "Reconnect")}</Button>
    </footer>
  </dialog>;
}
