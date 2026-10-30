import { AlertTriangle, Bug, ClipboardList, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  createWorkspaceMateClient,
  type WorkspaceMateTask,
  type WorkspaceMateTaskChannel
} from "../../../sdk/mate/dist/index.js";
import { requestMateLiveSession, requestMatePreviewSession, MatePreviewApiError, type MatePreviewSession } from "./api";
import { createPreviewEnvironment } from "./environment";
import type { MateSurfaceSnapshot } from "./surfaceState";
import { useMateLocale } from "./locale";
import { FolderEditApprovals } from "./components/FolderEditApprovals";

export type OperationsSurfaceSnapshot = MateSurfaceSnapshot;

export function PreviewOperationsSurface({
  channel,
  debug,
  endpoint,
  fetch: fetcher,
  onDirectoryChange,
  onSnapshot,
  session
}: {
  channel: WorkspaceMateTaskChannel;
  debug: boolean;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  onDirectoryChange: () => void;
  onSnapshot: (snapshot: OperationsSurfaceSnapshot) => void;
  session: MatePreviewSession;
}) {
  const { text } = useMateLocale();
  const [debugOpen, setDebugOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [hydration, setHydration] = useState<OperationsSurfaceSnapshot["hydration"]>("loading");
  const [lastError, setLastError] = useState("none");
  const [lastOutcome, setLastOutcome] = useState<OperationsSurfaceSnapshot["lastOutcome"]>("idle");
  const [running, setRunning] = useState(false);
  const [tasks, setTasks] = useState<WorkspaceMateTask[]>([]);
  const preview = session.mode === "preview";
  const credentialRef = useRef(session);
  useEffect(() => { credentialRef.current = session; }, [session]);
  const environment = useMemo(() => createPreviewEnvironment({
    coordinate: `mate:${session.mate.id}`,
    debug,
    releaseId: session.release.id,
    releaseVersion: session.release.version,
    revision: 1,
    mateId: session.mate.id
  }), [debug, session.release.id, session.release.version, session.mate.id]);
  const accessToken = useCallback(async () => {
    const current = credentialRef.current;
    if (Date.parse(current.expiresAt) > Date.now() + 30_000) return current.accessToken;
    const refreshed = current.mode === "preview"
      ? await requestMatePreviewSession({
          endpoint,
          fetch: fetcher,
          releaseId: current.release.id,
          mateId: current.mate.id
        })
      : await requestMateLiveSession({
          endpoint,
          fetch: fetcher,
          mateId: current.mate.id
        });
    if (
      refreshed.principalKey !== current.principalKey
      || refreshed.runtimeOrigin !== current.runtimeOrigin
      || !refreshed.surface.entries.some((entry) => entry.kind === "task_inbox" && entry.channel === channel)
    ) throw new MatePreviewApiError(502, "preview_session_refresh_mismatch");
    credentialRef.current = refreshed;
    return refreshed.accessToken;
  }, [channel, endpoint, fetcher]);
  const client = useMemo(() => createWorkspaceMateClient({
    accessToken,
    environment,
    fetch: fetcher,
    mode: session.mode,
    ...(session.mode === "preview" ? { releaseId: session.release.id } : {}),
    runtimeOrigin: session.runtimeOrigin,
    mateId: session.mate.id
  }), [accessToken, environment, fetcher, session.release.id, session.runtimeOrigin, session.mate.id]);

  const hydrate = useCallback(async () => {
    setHydration("loading");
    setLastError("none");
    try {
      const loaded = await client.listTasks();
      setTasks(loaded.filter((task) => (
        task.releaseId === session.release.id
        && task.channel !== undefined
        && ["mate_call", "email", "schedule"].includes(task.channel)
      )));
      setHydration("ready");
    } catch (error) {
      setLastError(safeOperationsError(error));
      setHydration("error");
    }
  }, [channel, client, session.release.id]);

  useEffect(() => { void hydrate(); }, [hydrate]);

  const connection: OperationsSurfaceSnapshot["connection"] = hydration === "error"
    ? "error"
    : hydration === "loading"
      ? "connecting"
      : running
        ? "streaming"
        : "connected";

  useEffect(() => {
    onSnapshot({
      connection,
      hydration,
      lastError,
      lastOutcome,
      messageCount: tasks.length,
      recovering: hydration === "loading",
      streaming: running
    });
  }, [connection, hydration, lastError, lastOutcome, onSnapshot, running, tasks.length]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const instruction = draft.trim();
    if (!instruction || running || hydration !== "ready") return;
    setRunning(true);
    setDraft("");
    setLastError("none");
    setLastOutcome("running");
    try {
      const created = await client.createTask(instruction, { channel });
      setTasks((current) => upsertTask(current, created));
      onDirectoryChange();
      const completed = await client.runTask(created.id);
      setTasks((current) => upsertTask(current, completed));
      setLastOutcome(completed.status === "completed" ? "completed" : "failed");
    } catch (error) {
      setLastError(safeOperationsError(error));
      setLastOutcome("failed");
      setDraft(instruction);
      await hydrate();
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="tm-preview-workspace" data-testid="preview-operations-surface">
      <section className="tm-preview-conversation" aria-label={text("任务收件箱", "Operations task inbox")}>
        <div className="tm-preview-transcript" data-testid="preview-task-inbox" role="feed">
          {hydration === "loading" ? (
            <OperationsNotice title={preview ? text("正在加载 Preview 任务", "Loading Preview tasks") : text("正在加载任务", "Loading tasks")}>{preview ? text("正在从 Preview 空间读取当前 Release 的任务与结论。", "Reading tasks and conclusions for the current release from the Preview namespace.") : text("正在读取当前用户可见的任务与结论。", "Reading tasks and conclusions visible to the current user.")}</OperationsNotice>
          ) : tasks.length === 0 ? (
            <OperationsNotice title={preview ? text("任务 Preview 已就绪", "Operations Preview is ready") : text("任务收件箱已就绪", "Task Inbox is ready")}>{preview ? text("通过 SDK 创建固定到 Release 的任务；待办与提醒只生成建议，不写入 Live。", "Create release-pinned tasks through the SDK. Todos and reminders produce proposals only and do not write to Live.") : text("这里显示当前用户可见的 Mate 任务；写操作继续遵循 Runtime 权限与审批策略。", "Tasks visible to the current user appear here. Writes continue to follow Runtime permissions and approval policies.")}</OperationsNotice>
          ) : tasks.map((task) => <OperationsTaskCard key={task.id} preview={preview} task={task} />)}
          <FolderEditApprovals session={session} accessToken={accessToken} fetcher={fetcher}
            refreshKey={`${tasks.map((task) => `${task.id}:${task.status}`).join(",")}:${running}`}
            onDecision={() => { void hydrate(); }} />
        </div>

        {lastError !== "none" && (
          <div className="tm-preview-inline-error" role="alert">
            <AlertTriangle size={16} />
            <span>{lastError}</span>
            <button onClick={() => void hydrate()} type="button"><RefreshCw size={14} />{text("重新加载", "Reload")}</button>
          </div>
        )}

        <form className="tm-preview-composer tm-preview-operations-composer" data-testid="preview-operations-composer" onSubmit={(event) => void submit(event)}>
          <div className="tm-preview-operations-controls">
            <strong>{channelLabel(channel)} · Task Inbox</strong>
            <span><ShieldCheck size={14} />{preview ? text("Preview 写操作被强制降级为建议", "Preview writes are forced to proposals") : text("用户访问 · Runtime 权限与审批", "User access · Runtime permissions and approval")}</span>
          </div>
          <textarea
            aria-label={preview ? text("发送 Preview 任务", "Send Operations Preview task") : text("发送 Mate 任务", "Send Mate task")}
            data-testid="preview-operations-input"
            disabled={running || hydration !== "ready"}
            maxLength={12_000}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={preview ? text("输入一个候选 Release 测试任务…", "Enter a candidate release test task…") : text("输入一个 Mate 任务…", "Enter a Mate task…")}
            rows={3}
            value={draft}
          />
          <div className="tm-preview-composer-actions">
            <button className="is-primary" data-testid="preview-operations-run" disabled={running || hydration !== "ready" || !draft.trim()} type="submit">
              {running ? <RefreshCw className="is-spinning" size={15} /> : <Send size={15} />}{running ? text("运行中", "Running") : preview ? text("运行 Preview 任务", "Run Preview task") : text("运行任务", "Run task")}
            </button>
          </div>
        </form>
      </section>

      {debug && <aside className={debugOpen ? "tm-preview-debug is-open" : "tm-preview-debug"}>
        <button className="tm-preview-debug-toggle" onClick={() => setDebugOpen((value) => !value)} type="button">
          <Bug size={15} />{debugOpen ? text("收起调试", "Close debug") : text("打开调试", "Open debug")}
        </button>
        <div data-testid="preview-debug-inspector" hidden={!debugOpen}>
            <p className="tm-preview-eyebrow">SDK Host Inspector</p>
            <h2>{text("任务 Runtime 状态", "Operations Runtime status")}</h2>
            <DebugRow field="mode" label="Namespace" value={session.mode} />
            <DebugRow field="surface" label="Surface" value="task_inbox" />
            <DebugRow field="release" label="Release" value={session.release.id} />
            <DebugRow field="channel" label="Channel" value={channel} />
            <DebugRow field="connection" label="Connection" value={connection} />
            <DebugRow field="hydration" label="Hydration" value={hydration} />
            <DebugRow field="streaming" label="Running" value={String(running)} />
            <DebugRow field="recovering" label="Recovering" value={String(hydration === "loading")} />
            <DebugRow field="message-count" label="Tasks" value={String(tasks.length)} />
            <DebugRow field="last-outcome" label="Last outcome" value={lastOutcome} />
            <DebugRow field="last-error" label="Last error" value={lastError} />
            <div className="tm-preview-debug-actions">
              <button data-testid="preview-reconnect" onClick={() => void hydrate()} type="button"><RefreshCw size={15} />{text("重新加载任务", "Reload tasks")}</button>
            </div>
            <p className="tm-preview-secret-note">{text("Bearer 不会在检查器、URL、存储或日志中显示。", "Bearer tokens are never shown in the inspector, URL, storage, or logs.")}</p>
        </div>
      </aside>}
    </div>
  );
}

function OperationsTaskCard({ preview, task }: { preview: boolean; task: WorkspaceMateTask }) {
  const { text } = useMateLocale();
  const summary = task.conclusion?.summary || (task.status === "running" ? text("任务正在运行。", "Task is running.") : text("等待 Runtime 结论。", "Waiting for Runtime conclusion."));
  const proposals = (task.conclusion?.actions ?? []).filter((action) => {
    const type = action && typeof action === "object" ? (action as Record<string, unknown>).type : undefined;
    return type === "todo.proposed" || type === "reminder.proposed"
      || (action && typeof action === "object" && (action as Record<string, unknown>).proposed === true);
  });
  return (
    <article className="tm-preview-operations-task" data-task-id={task.id} data-testid="preview-operation-task">
      <header>
        <div><span>{channelLabel(task.channel ?? "mate_call")}</span><strong>{task.status}</strong></div>
        <small>{task.id}</small>
      </header>
      <p className="tm-preview-operations-instruction">{task.instruction}</p>
      <p>{summary}</p>
      {proposals.length > 0 && <div className="tm-preview-proposal-count"><ShieldCheck size={14} />{preview ? text(`${proposals.length} 个 Preview 建议 · 0 个 Live 写入`, `${proposals.length} Preview proposals · 0 Live writes`) : text(`${proposals.length} 个待处理建议`, `${proposals.length} pending proposals`)}</div>}
    </article>
  );
}

function OperationsNotice({ children, title }: { children: string; title: string }) {
  const { text } = useMateLocale();
  return (
    <div className="tm-preview-welcome">
      <span><ClipboardList size={18} /></span>
      <p className="tm-preview-eyebrow">{text("Release 固定任务收件箱", "Release-pinned Task Inbox")}</p>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

function DebugRow({ field, label, value }: { field: string; label: string; value: string }) {
  return <div className="tm-preview-debug-row" data-debug-field={field}><span>{label}</span><strong>{value}</strong></div>;
}

function channelLabel(channel: string) {
  if (channel === "mate_call") return "Mate Call";
  if (channel === "email") return "Email Call";
  if (channel === "schedule") return "Schedule";
  return "SDK";
}

function upsertTask(tasks: WorkspaceMateTask[], task: WorkspaceMateTask) {
  return [task, ...tasks.filter((candidate) => candidate.id !== task.id)];
}

function safeOperationsError(error: unknown) {
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof source.code === "string" ? source.code : error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{2,95}$/.test(code) ? code : "mate_operations_unavailable";
}
