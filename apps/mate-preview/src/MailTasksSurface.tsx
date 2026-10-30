import { ArrowLeft, CalendarClock, Check, ChevronDown, Copy, FileText, Inbox, Mail, Reply, Search, Send, Workflow, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { requestMateLiveSession, type MatePreviewSession } from "./api";
import { useMateLocale } from "./locale";
import { MateAvatar } from "./components/MateAvatar";
import { formatCompactRelativeTime } from "./relativeTime";
import { WorkspaceListbox } from "../../../src/portal/components/WorkspaceListbox";
import { AssignmentGuide } from "./AssignmentGuide";
import "./mail-tasks.css";

const LazyMarkdownMessage = lazy(() => import("./MarkdownMessage").then(module => ({ default: module.MateMarkdownMessage })));
function MailTaskMessage({ content }: { content: string }) {
  return <Suspense fallback={<div className="tm-agent-markdown"><p>{content}</p></div>}><LazyMarkdownMessage content={content} /></Suspense>;
}

type Artifact = { name?: string; title?: string; fileName?: string; objectId?: string; expiresAt?: string; type?: string };
type Task = {
  id: string; instruction: string; status: string; channel: string; createdAt: string; completedAt?: string;
  conversationId?: string; threadId?: string;
  context?: { route?: string };
  conclusion?: { summary?: string; actions?: Array<{ toolName?: string; type?: string; proposed?: boolean }>; artifacts?: Artifact[]; failures?: Array<{ code?: string }>; pendingApprovals?: Array<{ approvalId: string }> };
};
type Thread = { id: string; title?: string; titleIsInstruction?: boolean; initialChannel?: string; initialInstruction?: string; mateCallId: string; threadCode: string; kind: "task" | "schedule"; scheduleId?: string; updatedAt: string; status?: string; channel?: string; preview?: string; taskCount?: number };
type Schedule = { id: string; title: string; instruction: string; status: string; nextDueAt: string; timezone: string; scheduleKind: string; intervalSeconds?: number; managedReleaseId?: string };
type Delivery = { taskId: string; direction: string; status: string; createdAt: string; fromEmail?: string; toEmail?: string };
type ThreadPage = { thread: Thread; tasks: Task[]; deliveries: Delivery[]; nextCursor?: string | null; executionProfile?: { releaseId: string; skills: Array<{name: string; version: string}> } };
type Run = { id: string; status: string; attempt?: number; startedAt?: string; completedAt?: string; errorCode?: string };

export function MailTasksSurface({ active, description, email, fetcher = globalThis.fetch, session, onCountChange, onOpenConversation, onExit }: {
  active: boolean; description?: string; email?: string; fetcher?: typeof fetch; session: MatePreviewSession;
  onExit: () => void; onCountChange?: (count: number) => void; onOpenConversation: (id: string) => void;
}) {
  const { locale, text } = useMateLocale();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [scheduledThreads, setScheduledThreads] = useState<Thread[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [tab, setTab] = useState<"task" | "schedule">("task");
  const [queries, setQueries] = useState({ task: "", schedule: "" });
  const [statusFilter, setStatusFilter] = useState("all");
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState<ThreadPage>();
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [scheduleError, setScheduleError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [replyError, setReplyError] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const closeGuide = useCallback(() => setGuideOpen(false), []);
  const [copied, setCopied] = useState(false);
  const [runHistory, setRunHistory] = useState<Record<string, Run[] | "error" | "loading">>({});
  const [deliveryBusy, setDeliveryBusy] = useState("");
  const timeline = useRef<HTMLDivElement>(null);
  const credentials = useRef(session);
  useEffect(() => { credentials.current = session; }, [session]);
  const request = useCallback(async (path: string, signal?: AbortSignal, body?: unknown) => {
    let current = credentials.current;
    if (Date.parse(current.expiresAt) <= Date.now() + 30_000 && current.mode === "live") {
      const renewed = await requestMateLiveSession({ fetch: fetcher, mateId: current.mate.id });
      if (renewed.principalKey !== current.principalKey || renewed.mate.id !== current.mate.id || renewed.runtimeOrigin !== current.runtimeOrigin) throw new Error("session_mismatch");
      credentials.current = current = renewed;
    }
    const prefix = current.mode === "preview" ? "/v1/owner-test/mates" : "/v1/mates";
    const url = new URL(`${prefix}/${encodeURIComponent(current.mate.id)}/${path}`, current.runtimeOrigin);
    if (current.mode === "preview") url.searchParams.set("release", current.release.id);
    const response = await fetcher(url, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${current.accessToken}`, ...(body === undefined ? {} : {"content-type": "application/json"}) }, signal, ...(body === undefined ? {} : {body: JSON.stringify(body)}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "mail_tasks_load_failed");
    return result;
  }, [fetcher]);
  const allThreads = useCallback(async (kind: string, signal?: AbortSignal) => {
    const rows: Thread[] = [];
    let cursor: string | null = null;
    do {
      const result = await request(`threads?kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, signal);
      if (!Array.isArray(result.threads)) throw Error("thread_response_invalid");
      rows.push(...result.threads); cursor = result.nextCursor || null;
    } while (cursor && !signal?.aborted);
    return [...new Map(rows.map(row=>[row.id,row])).values()];
  }, [request]);
  const allReminders = useCallback(async (signal?:AbortSignal) => {
    const rows:Schedule[]=[]; let cursor:string|null=null;
    do { const result=await request(`reminders${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,signal);
      if(!Array.isArray(result.reminders)) throw Error("reminder_response_invalid"); rows.push(...result.reminders); cursor=result.nextCursor || null;
    } while(cursor && !signal?.aborted);
    return {reminders:rows};
  },[request]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const [calls, plans, reminders] = await Promise.allSettled([allThreads("task", signal), allThreads("schedule", signal), session.mode === "live" ? allReminders(signal) : Promise.resolve({reminders: []})]);
    if (signal?.aborted) return;
    if (calls.status === "fulfilled") { setThreads(calls.value); onCountChange?.(calls.value.length); setListError(""); }
    else setListError(text("任务列表加载失败，请重试。", "Could not load tasks. Please retry."));
    if (plans.status === "fulfilled" && reminders.status === "fulfilled" && Array.isArray(reminders.value.reminders)) {
      setScheduledThreads(plans.value); setSchedules(reminders.value.reminders); setScheduleError("");
    } else setScheduleError(text("定时任务加载失败，请重试。", "Could not load schedules. Please retry."));
    setLoading(false);
  }, [allThreads, allReminders, session.mode, onCountChange, text]);
  useEffect(() => {
    const controller = new AbortController(); void load(controller.signal);
    const timer = active ? window.setInterval(() => { void load(controller.signal); setRefresh(value => value + 1); }, 15_000) : undefined;
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [active, load, session.mate.id]);
  const plans = [...schedules].sort((a, b) => Date.parse(a.nextDueAt) - Date.parse(b.nextDueAt));
  const query = queries[tab].trim().toLocaleLowerCase();
  const matches = (...values: Array<string | undefined>) => values.some(value => value?.toLocaleLowerCase().includes(query));
  const filteredThreads = threads.filter(thread => matches(thread.title, thread.initialInstruction, thread.preview, thread.mateCallId)
    && (statusFilter === "all" || (statusFilter === "attention" ? ["failed", "waiting_for_approval", "waiting_for_input"].includes(thread.status || "")
      : statusFilter === "running" ? ["queued", "running"].includes(thread.status || "") : thread.status === statusFilter)));
  const filteredPlans = plans.filter(plan => matches(plan.title, plan.instruction, scheduledThreads.find(thread => thread.scheduleId === plan.id)?.mateCallId));
  const resultCount = tab === "task" ? filteredThreads.length : filteredPlans.length;
  const filtering = Boolean(query || (tab === "task" && statusFilter !== "all"));
  const selectedSchedule = tab === "schedule" ? plans.find(item => item.id === selected) : undefined;
  const selectedThread = tab === "task" ? threads.find(item => item.id === selected) : scheduledThreads.find(item => item.scheduleId === selected);
  useEffect(() => {
    const items = tab === "task" ? filteredThreads : filteredPlans;
    if (!items.some(item => item.id === selected)) setSelected(items[0]?.id || "");
  }, [tab, threads, schedules, scheduledThreads, selected, query, statusFilter]);
  useEffect(() => { timeline.current?.scrollTo({ top: 0 }); setCopied(false); }, [selected, tab]);
  const reply = drafts[selectedThread?.id || ""] || "";
  useEffect(() => { setReplyError(""); setRunHistory({}); }, [selectedThread?.id]);
  useEffect(() => {
    const controller = new AbortController();
    if (!active || !selectedThread) { setPage(undefined); setDetailError(""); setDetailLoading(false); return; }
    setDetailLoading(true); setDetailError("");
    void request(`threads/${encodeURIComponent(selectedThread.id)}`, controller.signal).then(async result => {
      if (!controller.signal.aborted) { if (!Array.isArray(result.tasks)) throw Error(); setPage(current => {
        if(!current || current.thread.id!==result.thread.id) return result;
        const newer=new Set(result.tasks.map((task:Task)=>task.id));
        const older=current.tasks.filter(task=>!newer.has(task.id));
        return {...result,tasks:[...result.tasks,...older],deliveries:[...result.deliveries,...current.deliveries.filter(item=>!result.deliveries.some((entry:Delivery)=>entry.taskId===item.taskId && entry.direction===item.direction))],nextCursor:older.length ? current.nextCursor : result.nextCursor};
      });
        const openRuns = new Set([...document.querySelectorAll<HTMLDetailsElement>(".mate-mail-process[open]")].map(element=>element.dataset.runTask));
        await Promise.allSettled(result.tasks.filter((task:Task)=>openRuns.has(task.id)).map(async (task:Task)=>{
          try { const history=await request(`tasks/${encodeURIComponent(task.id)}/runs`,controller.signal);
            if(!controller.signal.aborted) setRunHistory(current=>({...current,[task.id]:history.runs}));
          } catch { if(!controller.signal.aborted) setRunHistory(current=>({...current,[task.id]:"error"})); }
        }));
      }
    }).catch(() => { if (!controller.signal.aborted) setDetailError(text("往来记录加载失败，请重试。", "Could not load this conversation. Please retry.")); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [active, selectedThread?.id, selectedThread?.updatedAt, refresh, request, text]);
  const status = (value: string) => ({queued: text("排队中", "Queued"), running: text("运行中", "Running"), waiting_for_approval: text("待审核", "Needs approval"), waiting_for_input: text("待补充", "Needs input"), completed: text("已完成", "Completed"), failed: text("失败", "Failed"), cancelled: text("已取消", "Cancelled"), active: text("已安排", "Scheduled"), paused: text("已暂停", "Paused")}[value] || value);
  const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en", {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"}) : "—";
  const frequency = (plan: Schedule) => {
    if (plan.scheduleKind === "once") return text("单次", "Once");
    const seconds = plan.intervalSeconds || 0;
    if (!seconds) return "—";
    if (seconds % 86400 === 0) return text(`每 ${seconds / 86400} 天`, seconds === 86400 ? "Every day" : `Every ${seconds / 86400} days`);
    if (seconds % 3600 === 0) return text(`每 ${seconds / 3600} 小时`, seconds === 3600 ? "Every hour" : `Every ${seconds / 3600} hours`);
    if (seconds % 60 === 0) return text(`每 ${seconds / 60} 分钟`, seconds === 60 ? "Every minute" : `Every ${seconds / 60} minutes`);
    return text(`每 ${seconds} 秒`, seconds === 1 ? "Every second" : `Every ${seconds} seconds`);
  };
  const source = (channel?: string, route?: string) => route === "/mate/mail-tasks" ? text("页面补充", "Workspace instruction") : channel === "email" ? text("邮件", "Email") : channel === "schedule" ? text("定时执行", "Scheduled run") : "Mate Call";
  const copyId = async () => { if (!selectedThread) return; try { await navigator.clipboard.writeText(selectedThread.mateCallId); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); } };
  const sendReply = async () => {
    if (!reply.trim() || !selectedThread || sending) return;
    const id = selectedThread.id;
    setSending(true); setReplyError("");
    try {
      const created = await request("tasks", undefined, {channel: "mate_call", threadId: id, instruction: reply.trim(), context: {route: "/mate/mail-tasks"}});
      setDrafts(current => { const next = {...current}; delete next[id]; return next; });
      // Admission can be retried without submitting another assignment.
      try { await request(`tasks/${encodeURIComponent(created.task.id)}/run`, undefined, {background: true}); }
      catch { setReplyError(text("补充已保存，但启动失败。请在该条记录中重试启动。", "Instruction saved, but the run could not start. Retry in its execution record.")); }
      await load(); setRefresh(value => value + 1);
    } catch { setReplyError(text("补充发送失败，请重试。", "Could not save your instruction. Please retry.")); }
    finally { setSending(false); }
  };
  const history = async (taskId: string) => {
    if (runHistory[taskId] && runHistory[taskId] !== "error") return;
    setRunHistory(value => ({...value, [taskId]: "loading"}));
    try { const result = await request(`tasks/${encodeURIComponent(taskId)}/runs`); setRunHistory(value => ({...value, [taskId]: result.runs})); }
    catch { setRunHistory(value => ({...value, [taskId]: "error"})); }
  };
  const delivery = async (taskId: string) => {
    setDeliveryBusy(taskId); setReplyError("");
    try { await request(`tasks/${encodeURIComponent(taskId)}/receipt`, undefined, {}); setRefresh(value => value + 1); }
    catch { setReplyError(text("回执未发送成功。执行结果已保留，可以重试发送。", "Receipt could not be sent. The result is saved; retry delivery.")); }
    finally { setDeliveryBusy(""); }
  };
  const visiblePage = page?.thread.id === selectedThread?.id ? page : undefined;
  const taskLetter = (task: Task, index: number) => {
    const inbound = visiblePage?.deliveries.find(item => item.taskId === task.id && item.direction === "inbound");
    const sent = visiblePage?.deliveries.some(item => item.taskId === task.id && item.direction === "outbound" && item.status === "sent");
    const failedDelivery = !sent && visiblePage?.deliveries.some(item => item.taskId === task.id && item.status === "failed");
    const pending = task.conclusion?.pendingApprovals?.length;
    const recordedRuns=runHistory[task.id];
    const sender = task.channel === "email" ? inbound?.fromEmail || text("邮箱未记录", "Email not recorded") : task.channel === "schedule" ? text("定时计划", "Schedule") : task.context?.route === "/mate/mail-tasks" ? session.user?.name || text("我", "Me") : text("发起方", "Requester");
    return <details className="mate-mail-letter" key={task.id} open={index === 0}>
      <summary><span className="mate-letter-source" aria-hidden="true">{task.channel === "email" ? <Mail size={18} /> : task.channel === "schedule" ? <CalendarClock size={18} /> : task.context?.route === "/mate/mail-tasks" ? <Reply size={18} /> : <Workflow size={18} />}</span><span className="mate-letter-summary"><strong>{text("任务指令", "Task request")}{index === 0 && <em>{text("最新", "Latest")}</em>}</strong><small><b>{source(task.channel, task.context?.route)}</b><span> · </span>{sender}<span> · </span><time>{time(task.createdAt)}</time></small><span className="mate-letter-excerpt">{task.instruction}</span></span><span className="mate-task-badge" data-status={pending ? "waiting_for_approval" : task.status}>{pending ? status("waiting_for_approval") : status(task.status)}</span><ChevronDown size={15} /></summary>
      <div className="mate-mail-letter-body">
        <div className="mate-mail-request"><MailTaskMessage content={task.instruction} /></div>
        <div className="mate-mail-message-heading is-receipt"><span className="mate-mail-receipt-author"><span className="mate-mail-avatar" aria-hidden="true">{session.mate.avatarUrl ? <img src={session.mate.avatarUrl} alt="" /> : session.mate.displayName.slice(0, 1)}</span>{session.mate.displayName}<span className="mate-mail-receipt-label">{text("交付回执", "Receipt")}</span></span><time>{time(task.completedAt)}</time></div>
        {task.conclusion?.summary ? <MailTaskMessage content={task.conclusion.summary} /> : <p className="mate-mail-muted">{text("已收到，执行结果会继续显示在这条往来中。", "Received. The result will appear in this conversation.")}</p>}
        {!!task.conclusion?.artifacts?.length && <div className="mate-mail-deliverables"><small>{text("交付物", "Deliverables")}</small>{task.conclusion.artifacts.map((artifact, i) => <div key={i}><FileText size={16} /><span>{artifact.fileName || artifact.name || artifact.title || text(`交付物 ${i + 1}`, `Deliverable ${i + 1}`)}{artifact.expiresAt && <small className="mate-mail-muted">{text("可下载至", "Available until")} {time(artifact.expiresAt)}</small>}</span>{artifact.type === "workspace_file" && artifact.objectId && <button type="button" disabled={Boolean(artifact.expiresAt && Date.parse(artifact.expiresAt) <= Date.now())} onClick={async () => { try { const current = credentials.current; const response = await fetcher(new URL(`/v1/${current.mode === "preview" ? "owner-test/" : ""}mates/${encodeURIComponent(current.mate.id)}/workspace-files/${encodeURIComponent(artifact.objectId!)}/download`, current.runtimeOrigin), {headers: {authorization: `Bearer ${current.accessToken}`}}); if (!response.ok) { setReplyError(text("交付物下载失败。", "Could not download deliverable.")); return; } const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url; link.download = artifact.fileName || artifact.name || "deliverable"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); } catch { setReplyError(text("交付物下载失败，请重试。", "Could not download. Please retry.")); } }}>{artifact.expiresAt && Date.parse(artifact.expiresAt) <= Date.now() ? text("已过期", "Expired") : text("下载", "Download")}</button>}</div>)}</div>}
        <div className="mate-mail-letter-footer"><span>{sent ? text("回执已发邮件", "Receipt emailed") : failedDelivery ? text("邮件发送失败 · 结果已保存", "Email failed · Result saved") : text("回执保留在此往来中", "Receipt saved in this conversation")}</span>{session.mode === "live" && task.conclusion?.summary && !sent && <button disabled={Boolean(deliveryBusy)} onClick={() => void delivery(task.id)} type="button"><Send size={13} />{deliveryBusy === task.id ? text("发送中…", "Sending…") : text("发送回执到我的邮箱", "Email receipt to me")}</button>}{task.status === "queued" && <button onClick={async () => { try { await request(`tasks/${encodeURIComponent(task.id)}/run`, undefined, {background: true}); setRefresh(value => value + 1); } catch { setReplyError(text("启动失败，请重试。", "Could not start. Please retry.")); } }} type="button">{text("启动执行", "Start execution")}</button>}</div>
        <details className="mate-mail-process" data-run-task={task.id} onToggle={event => { if (event.currentTarget.open) void history(task.id); }}><summary>{text("执行记录", "Execution records")}<ChevronDown size={13} /></summary>{!!task.conclusion?.failures?.length && <p className="mate-mail-error">{task.conclusion.failures.map(item => item.code).join(" · ")}</p>}{task.conclusion?.actions?.length ? <ol>{task.conclusion.actions.map((action, i) => <li key={i}>{action.toolName || action.type}{action.proposed && ` · ${text("待审核提案", "Approval proposal")}`}</li>)}</ol> : null}{runHistory[task.id] === "error" ? <button onClick={() => void history(task.id)} type="button">{text("加载失败，重试", "Could not load. Retry")}</button> : runHistory[task.id] === "loading" ? <p>{text("加载中…", "Loading…")}</p> : (Array.isArray(recordedRuns) ? recordedRuns : []).map(run => <p key={run.id}>{text(`第 ${run.attempt || 1} 次执行`, `Attempt ${run.attempt || 1}`)} · {status(run.status)} · {time(run.startedAt)}{run.errorCode && ` · ${run.errorCode}`}</p>)}{task.conversationId && <button onClick={() => onOpenConversation(task.conversationId!)} type="button">{text("查看关联对话", "View linked chat")}</button>}</details>
      </div>
    </details>;
  };
  if (!active) return null;
  return <>
    <section className="mate-mail-workspace" data-mobile-reading={reading} aria-label={text("邮箱与任务模式", "Mail & Tasks mode")}>
      <header className="mate-mail-toolbar"><div className="mate-mail-toolbar-title"><button onClick={onExit} type="button" aria-label={text("返回对话", "Back to chat")} title={text("返回 Mate 对话", "Back to Mate chat")}><ArrowLeft size={18} /></button><MateAvatar avatarUrl={session.mate.avatarUrl} name={session.mate.displayName} className="mate-mail-mate-avatar" /><div className="mate-mail-identity"><div className="mate-mail-breadcrumb">Mate <span>/</span> {session.mate.displayName}</div><h1>{text("邮箱与任务", "Mail & Tasks")}</h1><p>{description || session.mate.jobRole || session.mate.description}</p></div></div><div className="mate-mail-toolbar-links"><a href={email ? `mailto:${email}` : undefined}><Mail size={16} /><span>{email || text("邮箱未配置", "Email not configured")}</span></a><button onClick={() => setGuideOpen(true)} type="button"><Workflow size={16} /><span>{text("指派指引", "Assignment guide")}</span></button></div></header>
      <div className="mate-mail-columns">
        <aside className="mate-mail-list" aria-label={text("任务列表", "Task list")}><div className="mate-mail-tabs" role="tablist" aria-label={text("任务类型", "Task type")}>{(["task", "schedule"] as const).map(kind => <button key={kind} id={`mate-${kind}-tab`} role="tab" tabIndex={tab === kind ? 0 : -1} onKeyDown={event => { if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "task" : event.key === "End" ? "schedule" : kind === "task" ? "schedule" : "task"; setTab(next); setSelected(""); setReading(false); document.getElementById(`mate-${next}-tab`)?.focus(); } }} aria-selected={tab === kind} aria-controls="mate-mail-list-panel" onClick={() => { setTab(kind); setSelected(""); setReading(false); }} type="button">{kind === "task" ? text("任务", "Tasks") : text("定时任务", "Scheduled")}<span>{kind === "task" ? threads.length : plans.length}</span></button>)}</div>
          <div className="mate-mail-list-tools"><div className="mate-mail-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label={tab === "task" ? text("搜索任务", "Search tasks") : text("搜索定时任务", "Search schedules")} placeholder={text("搜索标题、摘要或编号", "Search title, summary or ID")} value={queries[tab]} onChange={event => setQueries(current => ({...current, [tab]: event.target.value}))} />{queries[tab] && <button type="button" aria-label={text("清除搜索", "Clear search")} onClick={() => setQueries(current => ({...current, [tab]: ""}))}><X size={14} /></button>}</div><div className="mate-mail-list-filter"><span>{tab === "task" ? text("任务列表", "Task list") : text("按下次执行排序", "Next run first")}</span>{tab === "task" && <WorkspaceListbox ariaLabel={text("筛选任务状态", "Filter task status")} variant="filter" popoverAlign="end" value={statusFilter} onChange={setStatusFilter} options={[
              {value:"all",label:text("全部状态", "All statuses")},
              {value:"attention",label:text("需要处理", "Needs attention")},
              {value:"running",label:text("进行中", "In progress")},
              {value:"completed",label:text("已完成", "Completed")},
              {value:"cancelled",label:text("已取消", "Cancelled")}
            ]} />}</div></div>
          <div className="mate-mail-list-scroll" id="mate-mail-list-panel" role="tabpanel" aria-labelledby={`mate-${tab}-tab`}>{(filtering || tab === "schedule") && <div className="mate-mail-list-caption" role="status">{filtering ? text(`${resultCount} 个匹配结果`, `${resultCount} ${resultCount === 1 ? "match" : "matches"}`) : text("每个计划汇总全部执行回执", "Each plan collects its execution receipts")}</div>}{loading && <p role="status">{text("加载中…", "Loading…")}</p>}{(tab === "task" ? listError : scheduleError) && <p className="mate-mail-error" role="alert">{tab === "task" ? listError : scheduleError}<button type="button" onClick={() => void load()}>{text("重试", "Retry")}</button></p>}
            {tab === "task" ? filteredThreads.map(thread => {
              const isEmail = (thread.initialChannel || thread.channel) === "email";
              const untitledInstruction = !isEmail && (!thread.title?.trim() || thread.titleIsInstruction);
              return <button className="mate-mail-list-item" data-selected={selected === thread.id} aria-current={selected === thread.id ? "page" : undefined} key={thread.id} onClick={() => { setSelected(thread.id); setReading(true); }} type="button">
                <span className="mate-mail-source-icon" title={source(isEmail ? "email" : "mate_call")}>{isEmail ? <Mail size={18} /> : <Workflow size={18} />}</span>
                <span className="mate-mail-item-copy">
                  {untitledInstruction ? <span className="mate-mail-instruction-title"><span>{text("指令任务", "Instruction task")}</span><span className="mate-mail-item-id" title={thread.mateCallId}>[{thread.mateCallId}]</span></span> : <span className="mate-mail-item-title">{thread.title?.trim() || text("无主题", "No subject")}</span>}
                  <span className="mate-mail-item-preview">{untitledInstruction ? thread.initialInstruction?.trim() || thread.title?.trim() || thread.preview?.trim() : thread.preview?.trim()}</span>
                  <span className="mate-mail-item-bottom"><span className="mate-task-badge" data-status={thread.status}>{status(thread.status || "queued")}</span><time>{formatCompactRelativeTime(thread.updatedAt, Date.now(), locale)}</time></span>
                </span>
              </button>;
            }) : filteredPlans.map(plan => <button className="mate-mail-list-item" data-selected={selected === plan.id} aria-current={selected === plan.id ? "page" : undefined} key={plan.id} onClick={() => { setSelected(plan.id); setReading(true); }} type="button"><span className="mate-mail-source-icon"><CalendarClock size={18} /></span><span className="mate-mail-item-copy"><span className="mate-mail-item-title">{plan.title?.trim() || text("未命名定时任务", "Untitled schedule")}</span><span className="mate-mail-item-preview">{plan.instruction?.trim()}</span><span className="mate-mail-item-bottom"><span className="mate-task-badge" data-status={plan.status}>{status(plan.status)}</span><time title={text("下次执行", "Next run")}>{time(plan.nextDueAt)}</time></span></span></button>)}
            {!loading && !resultCount && !(tab === "task" ? listError : scheduleError) && <div className="mate-mail-list-empty"><Search size={24} /><strong>{filtering ? text("没有匹配的任务", "No matching tasks") : tab === "schedule" ? text("暂无定时任务", "No scheduled tasks yet") : text("暂无任务", "No tasks yet")}</strong><p>{filtering ? text("试试其他关键词，或清除筛选。", "Try another keyword or clear the filters.") : tab === "schedule" ? text("创建的定时计划会显示在这里。", "Scheduled tasks will appear here.") : text("收到的任务会显示在这里。", "Incoming tasks will appear here.")}</p>{filtering && <button type="button" onClick={() => {setQueries(current => ({...current, [tab]: ""})); setStatusFilter("all");}}>{text("清除筛选", "Clear filters")}</button>}</div>}
          </div>
        </aside>
        <section className="mate-mail-reader" aria-label={text("任务正文", "Task content")}><button className="mate-mail-back-list" onClick={() => setReading(false)} type="button"><ArrowLeft size={16} />{text("返回列表", "Back to list")}</button>
          {(selectedThread || selectedSchedule) && <header className="mate-mail-heading"><div className="mate-mail-heading-title"><h2>{tab === "task" ? text("任务往来", "Task exchanges") : text("执行回执", "Run receipts")}</h2><div className="mate-mail-heading-meta"><span>{text("最新在前", "Newest first")}</span></div></div>{selectedThread && <button className="mate-mail-thread-id" onClick={() => void copyId()} type="button" title={text("复制 Mate Call ID，可在 Agent 或邮件中继续此项工作", "Copy Mate Call ID to continue in an Agent or email")} aria-label={text(`复制 Mate Call ID ${selectedThread.mateCallId}`, `Copy Mate Call ID ${selectedThread.mateCallId}`)}><span>{selectedThread.mateCallId}</span>{copied ? <Check size={13} /> : <Copy size={13} />}</button>}</header>}
          <div className="mate-mail-timeline" ref={timeline}>{selectedSchedule && <section className="mate-mail-schedule-rule"><div><CalendarClock size={17} /><strong>{text("执行安排", "Execution schedule")}</strong><span className="mate-task-badge" data-status={selectedSchedule.status}>{status(selectedSchedule.status)}</span></div><dl><dt>{text("下次执行", "Next run")}</dt><dd>{time(selectedSchedule.nextDueAt)} · {selectedSchedule.timezone}</dd><dt>{text("频率", "Frequency")}</dt><dd>{frequency(selectedSchedule)}</dd>{visiblePage?.executionProfile?.skills.length ? <><dt>{text("技能", "Skills")}</dt><dd>{visiblePage.executionProfile.skills.map(skill => `${skill.name} · ${skill.version}`).join(" / ")}</dd></> : null}</dl><MailTaskMessage content={selectedSchedule.instruction} /></section>}
            {detailError && <p className="mate-mail-error" role="alert">{detailError}<button type="button" onClick={() => setRefresh(value => value + 1)}>{text("重试", "Retry")}</button></p>}{detailLoading && !visiblePage && <p role="status">{text("加载往来记录…", "Loading exchanges…")}</p>}{visiblePage?.tasks.map(taskLetter)}{visiblePage?.nextCursor && <button className="mate-mail-older" type="button" onClick={async () => { try { const older = await request(`threads/${encodeURIComponent(visiblePage.thread.id)}?cursor=${visiblePage.nextCursor}`); setPage(current => current && current.thread.id === older.thread.id ? {...current, tasks: [...current.tasks, ...older.tasks], deliveries: [...current.deliveries, ...older.deliveries], nextCursor: older.nextCursor} : current); } catch { setDetailError(text("较早记录加载失败。", "Could not load earlier exchanges.")); } }}>{text("查看更早记录", "Earlier exchanges")}</button>}{!detailLoading && !detailError && !visiblePage?.tasks.length && <div className="mate-mail-welcome"><Inbox size={32} /><h2>{selectedSchedule ? text("等待首次执行", "Waiting for the first run") : filtering ? text("没有匹配的任务", "No matching tasks") : text("每项工作，都有来有回", "Every task gets a reply")}</h2><p>{selectedSchedule ? text("执行完成后，回执与交付物会出现在这里。", "Receipts and deliverables will appear here after execution.") : filtering ? text("调整左侧搜索或状态筛选，继续查找工作。", "Adjust the search or status filter to find your work.") : text("从左侧选择一项工作，查看完整往来。", "Select work from the list to see its exchanges.")}</p></div>}
          </div>
          {replyError && <p className="mate-mail-error mate-mail-reply-error" role="alert">{replyError}</p>}{selectedThread && session.mode === "live" && <form className="mate-mail-reply" onSubmit={event => { event.preventDefault(); void sendReply(); }}><div className="mate-mail-compose-card"><span className="mate-mail-avatar mate-mail-user-avatar" aria-hidden="true">{session.user?.avatarUrl ? <img src={session.user.avatarUrl} alt="" /> : session.user?.name ? session.user.name.split(/\s+/).map(part => part[0]).slice(0, 2).join("").toUpperCase() : text("我", "ME")}</span><div className="mate-mail-compose-input"><label htmlFor="mate-thread-reply">{text(`给 ${session.mate.displayName} 补充指令`, `Additional instruction for ${session.mate.displayName}`)}</label><textarea id="mate-thread-reply" rows={1} value={reply} onChange={event => {const value = event.target.value; setDrafts(current => ({...current, [selectedThread.id]: value}));}} maxLength={12000} placeholder={text("补充要求、反馈或下一步安排…", "Add requirements, feedback or next steps…")} disabled={sending} /></div><button type="submit" disabled={!reply.trim() || sending}><Send size={15} />{sending ? text("提交中…", "Submitting…") : text("提交指令", "Submit")}</button></div><p>{tab === "schedule" ? text("在此往来中新增一次执行，不修改定时规则。", "Adds a run to this conversation without changing the schedule.") : text("沿用当前往来，新增一次执行；此操作不会发送邮件。", "Adds a run to this conversation. No email is sent.")}</p></form>}

        </section>
      </div>
    </section>
    {guideOpen && <AssignmentGuide mateName={session.mate.displayName} onClose={closeGuide} />}
  </>;
}
