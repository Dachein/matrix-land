import { Check, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useMateLocale } from "../locale";

export type PendingTurn = { completedAt?: number; startedAt: number; phase: "starting" | "preparing" | "completed"; previousAssistantId?: string };

export function PendingTurnStatus({ turn }: { turn: PendingTurn }) {
  const { locale, text } = useMateLocale();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (turn.completedAt) return undefined;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [turn.completedAt, turn.startedAt]);
  const seconds = Math.max(0, Math.floor(((turn.completedAt ?? now) - turn.startedAt) / 1_000));

  return <div className="tm-preview-turn-process tm-preview-turn-pending" data-status={turn.phase === "completed" ? "completed" : "running"} data-testid="preview-turn-pending" role="status">
    <div className="tm-preview-turn-pending-row">
      {turn.phase === "completed" ? <Check aria-hidden="true" size={14} /> : <LoaderCircle aria-hidden="true" className="tm-preview-process-spinner" size={14} />}
      <span className="tm-preview-process-state">{turn.phase === "starting" ? text("正在启动", "Starting") : turn.phase === "completed" ? text("已处理", "Processed") : text("准备中", "Preparing")}</span>
      <span aria-label={text(`已等待 ${seconds} 秒`, `Waiting ${seconds} seconds`)} className="tm-preview-process-duration">{locale === "en" ? `${seconds}s` : `${seconds}秒`}</span>
      {turn.phase === "starting" && <><strong>{text("创建新对话", "Create new conversation")}</strong><em>{text("进行中", "In progress")}</em></>}
    </div>
  </div>;
}
