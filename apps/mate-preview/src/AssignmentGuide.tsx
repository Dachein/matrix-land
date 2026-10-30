import { ArrowUp, LoaderCircle, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../src/portal/components/Button";
import { WorkspaceMcpBrand } from "../../../src/portal/components/WorkspaceMcpBrand";
import { ModalShell } from "../../../src/portal/components/ModalShell";
import { McpConnectionModal, defaultMcpConnectionStatus, type McpConnectionStatus } from "../../../src/portal/components/McpConnectionModal";
import { getCachedMcpConnectionStatus } from "../../../src/portal/mcp/connectionStatusCache";
import { useMateLocale } from "./locale";

export function AssignmentGuide({ mateName, onClose }: { mateName: string; onClose: () => void }) {
  const { text } = useMateLocale();
  const [connection, setConnection] = useState<"checking" | "connected" | "disconnected" | "unknown">("checking");
  const [connectionStatus, setConnectionStatus] = useState<McpConnectionStatus>(defaultMcpConnectionStatus);
  const [installOpen, setInstallOpen] = useState(false);
  const [checkRevision, setCheckRevision] = useState(0);
  const [typedLength, setTypedLength] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const prompt = text(`请你帮我呼叫${mateName}同事，执行“整理本周客户会议纪要”任务。`, `Please call my colleague ${mateName} to summarize this week's client meeting notes.`);
  const promptCharacters = Array.from(prompt);

  useEffect(() => {
    if (installOpen) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let delay: number | undefined;
    let timer: number | undefined;
    const length = Array.from(prompt).length;
    const animate = () => {
      window.clearTimeout(delay); window.clearInterval(timer);
      if (motion.matches) { setTypedLength(length); return; }
      setTypedLength(0);
      delay = window.setTimeout(() => {
        let position = 0;
        timer = window.setInterval(() => {
          position += 1; setTypedLength(position);
          if (position >= length) window.clearInterval(timer);
        }, 55);
      }, 600);
    };
    animate(); motion.addEventListener("change", animate);
    return () => { window.clearTimeout(delay); window.clearInterval(timer); motion.removeEventListener("change", animate); };
  }, [prompt, installOpen]);

  useEffect(() => {
    if (installOpen) return;
    let cancelled = false;
    setConnection("checking");
    void getCachedMcpConnectionStatus({ forceRefresh: true }).then(status => {
      if (!cancelled) { setConnectionStatus(status); setConnection(status.connected && status.activeCount > 0 ? "connected" : "disconnected"); }
    }).catch(() => { if (!cancelled) setConnection("unknown"); });
    return () => { cancelled = true; };
  }, [installOpen, checkRevision]);

  useEffect(() => {
    if (installOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const controls = root.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]');
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onClose, installOpen]);

  if (installOpen) return <McpConnectionModal connectionStatus={connectionStatus} statusMode={connection === "checking" ? "loading" : connection === "unknown" ? "error" : "ready"} onClose={() => setInstallOpen(false)} onRefresh={async () => {
    setConnection("checking");
    try {
      const status = await getCachedMcpConnectionStatus({ forceRefresh: true });
      setConnectionStatus(status); setConnection(status.connected && status.activeCount > 0 ? "connected" : "disconnected");
    } catch { setConnection("unknown"); }
  }} />;

  const connectionHint = connection === "checking"
    ? text("正在检查 Workspace MCP 连接…", "Checking your Workspace MCP connection…")
    : connection === "connected"
    ? text("账号已有有效连接，请确认当前 Agent 已启用 Workspace MCP。", "Your account has an active connection. Make sure Workspace MCP is enabled in your Agent.")
    : connection === "disconnected"
    ? text("未检测到有效连接，请先在你使用的 Agent 中安装 Workspace MCP。", "No active connection found. Install Workspace MCP in your Agent first.")
    : text("暂时无法确认连接状态，请在 Agent 中检查或重试。", "Unable to confirm your connection. Check in your Agent or try again.");

  return <ModalShell ariaLabel={text("从 Agent 指派任务", "Assign a task from your Agent")} onClose={onClose} modalClassName="mate-task-guide" overlayClassName="mate-task-guide-overlay">
    <div ref={root}>
      <header className="appsModalHeader">
        <div className="mate-task-guide-heading"><WorkspaceMcpBrand /><small>{text(`从 Agent 指派任务 · ${mateName}`, `Assign a task from your Agent · ${mateName}`)}</small></div>
        <Button className="appsModalClose" aria-label={text("关闭指引", "Close guide")} iconBefore={<X size={18} />} onClick={onClose} variant="icon" />
      </header>
      <div className="agentHandoffGuide mate-task-guide-demo">
        <section className="agentQuickConnect mate-task-guide-step is-connection">
          <div><span className="agentHandoffStep">1</span><div><h3>{text("检查 MCP 连接", "Check your MCP connection")}</h3><p role="status">{connectionHint}</p></div></div>
          <div className="mate-task-guide-actions">
            <Button onClick={() => setInstallOpen(true)} size="compact" variant="primary">{text(connection === "disconnected" ? "连接 Workspace MCP" : "查看 MCP 连接", connection === "disconnected" ? "Connect Workspace MCP" : "View MCP connections")}</Button>
            <Button aria-label={text("重新检查 MCP 连接", "Check MCP connection again")} disabled={connection === "checking"} iconBefore={connection === "checking" ? <LoaderCircle size={14} className="spinIcon" /> : <RotateCw size={14} />} onClick={() => setCheckRevision(value => value + 1)} size="compact" variant="icon" />
          </div>
        </section>
        <section className="agentQuickConnect mate-task-guide-step is-prompt">
          <div><span className="agentHandoffStep">2</span><div><h3>{text("在你的桌面 Agent 中输入，如 Workbuddy、Cursor、Claude Code", "Enter a message in your desktop Agent, such as Workbuddy, Cursor, or Claude Code")}</h3><p>{text("打开你正在使用的 Agent，直接说出要指派的任务。", "Open your Agent and describe the task you want to assign.")}</p></div></div>
          <div className="mate-task-guide-prompt"><span className="mate-task-guide-prompt-text" aria-hidden="true"><span className="mate-task-guide-prompt-measure">{prompt}</span><span className="mate-task-guide-typed">{promptCharacters.slice(0, typedLength).join("")}{typedLength < promptCharacters.length && <i className="mate-task-guide-cursor" />}</span></span><span className="mate-task-guide-accessible-prompt">{prompt}</span><span className="mate-task-guide-send" aria-hidden="true"><ArrowUp size={16} /></span></div>
        </section>
      </div>
    </div>
  </ModalShell>;
}
