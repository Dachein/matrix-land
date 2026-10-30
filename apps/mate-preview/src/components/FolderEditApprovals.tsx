import { useCallback, useEffect, useRef, useState } from "react";
import type { MatePreviewSession } from "../api";
import { useMateLocale } from "../locale";
import { fetchReadWithRetry } from "../readRetry";
import type { RuntimeApprovalState } from "../approvalState";
import { approvalCardStatus, mergeApprovalStates, type RuntimeApproval } from "../approvalPresentation";
import { ApprovalCard } from "./ApprovalCard";
import "../approvals.css";

/** Approval content and results come from authenticated Runtime storage, never assistant text. */
export function FolderEditApprovals({ session, accessToken, fetcher = fetch, refreshKey, conversationId, onDecision, onStateChange }: {
  session: MatePreviewSession;
  accessToken: () => Promise<string>;
  fetcher?: typeof fetch;
  refreshKey: string;
  conversationId?: string;
  onDecision?: () => void;
  onStateChange?: (states: RuntimeApprovalState[]) => void;
}) {
  const { text } = useMateLocale();
  const [approvals, setApprovals] = useState<RuntimeApproval[]>([]);
  const [busy, setBusy] = useState<Record<string, "approve" | "deny">>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  const generation = useRef(0);
  const revision = useRef(0);
  const latest = useRef<RuntimeApproval[]>([]);
  const deciding = useRef(new Set<string>());
  const seenIds = useRef(new Set<string>());
  const callbacks = useRef({ onStateChange, onDecision });
  callbacks.current = { onStateChange, onDecision };
  const base = `${session.runtimeOrigin.replace(/\/$/, "")}/v1/mates/${encodeURIComponent(session.mate.id)}/approvals`;
  const request = useCallback(async (suffix = "", decision?: string) => {
    const init = {
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      ...(decision ? { method: "POST", body: JSON.stringify({ decision }) } : {})
    };
    const response = decision ? await fetcher(`${base}${suffix}`, init) : await fetchReadWithRetry(fetcher, `${base}${suffix}`, init);
    if (!response.ok) throw new Error("approval_request_failed");
    return response.json();
  }, [base, accessToken, fetcher]);
  const publish = useCallback((items: RuntimeApproval[]) => {
    latest.current = mergeApprovalStates(latest.current, items);
    setApprovals(latest.current);
    callbacks.current.onStateChange?.(latest.current);
  }, []);
  const reload = useCallback(async () => {
    const data = await request();
    let items = ((Array.isArray(data.approvals) ? data.approvals : []) as RuntimeApproval[]).filter((item) => (
      item.releaseId === session.release.id && (conversationId === undefined || Boolean(conversationId) && item.conversationId === conversationId)
    ));
    let resultsUnavailable = false;
    if (items.some((item) => !item.task && (item.status === "approved" || item.status === "consumed"))) {
      try {
        const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
        const response = await fetchReadWithRetry(fetcher, `${base.replace(/\/approvals$/, "/tasks")}${query}`, {
          headers: { Authorization: `Bearer ${await accessToken()}` }
        });
        if (!response.ok) throw new Error("task_read_failed");
        const result = await response.json();
        items = items.map((item) => ({ ...item, task: item.task ?? (result.tasks ?? []).find((task: { id: string }) => task.id === item.taskId) }));
      } catch { resultsUnavailable = true; }
    }
    return { items, resultsUnavailable };
  }, [request, session.release.id, conversationId, fetcher, base, accessToken]);
  useEffect(() => {
    generation.current += 1;
    revision.current += 1;
    deciding.current = new Set();
    latest.current = [];
    seenIds.current = new Set();
    setApprovals([]); setBusy({}); setErrors({}); setLoadError("");
    callbacks.current.onStateChange?.([]);
    return () => { generation.current += 1; };
  }, [conversationId, session.release.id, base, session.principalKey, session.mode]);
  useEffect(() => {
    const added = approvals.some((item) => !seenIds.current.has(item.id) && approvalCardStatus(item) === "pending");
    approvals.forEach((item) => seenIds.current.add(item.id));
    if (added && conversationId) sectionRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [approvals, conversationId]);
  useEffect(() => {
    if (session.mode !== "live") return;
    let cancelled = false;
    let loading = false;
    const refresh = async () => {
      if (loading || deciding.current.size || document.visibilityState === "hidden") return;
      loading = true;
      const readRevision = revision.current;
      try {
        const result = await reload();
        if (!cancelled && readRevision === revision.current) {
          publish(result.items);
          setErrors((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => !result.items.some((item) => item.id === id))));
          setLoadError(result.resultsUnavailable ? text("执行结果暂时无法加载，将自动重试。", "Execution results are temporarily unavailable. Retrying automatically.") : "");
        }
      } catch {
        if (!cancelled && readRevision === revision.current) setLoadError(text("审批暂时无法加载，将自动重试。", "Approvals are temporarily unavailable. Retrying automatically."));
      } finally { loading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [reload, refreshKey, retryKey, session.mode, session.principalKey, text, publish]);
  async function decide(id: string, decision: "approve" | "deny") {
    if (deciding.current.has(id) || approvalCardStatus(latest.current.find((item) => item.id === id) ?? { id, status: "missing" }) !== "pending") return;
    const scope = generation.current;
    deciding.current.add(id);
    revision.current += 1;
    setBusy((items) => ({ ...items, [id]: decision }));
    try {
      const result = await request(`/${encodeURIComponent(id)}/decision`, decision);
      if (scope !== generation.current) return;
      if (!result.approval || result.approval.id !== id || result.approval.status === "pending") throw new Error("decision_not_confirmed");
      publish([{ ...latest.current.find((item) => item.id === id)!, ...result.approval, task: result.task }]);
      callbacks.current.onDecision?.();
    } catch {
      if (scope === generation.current) setErrors((items) => ({ ...items, [id]: text("尚未确认此项的执行结果。请先刷新状态，避免重复提交。", "This item's result is not confirmed. Refresh its status before submitting again.") }));
    } finally {
      if (scope === generation.current) {
        deciding.current.delete(id);
        revision.current += 1;
        setBusy((items) => { const next = { ...items }; delete next[id]; return next; });
        if (!deciding.current.size) setRetryKey((key) => key + 1);
      }
    }
  }
  if (session.mode !== "live" || (!approvals.length && !loadError)) return null;
  const pending = approvals.filter((item) => !busy[item.id] && approvalCardStatus(item) === "pending").length;
  const completed = approvals.filter((item) => approvalCardStatus(item) === "completed").length;
  return <section aria-label={text("操作审批", "Action approvals")} className="tm-preview-approvals" ref={sectionRef}>
    <div className="tm-approval-list-header"><strong>{text("操作确认", "Action review")}</strong><span>{text(`待确认 ${pending} 项 · 已完成 ${completed} 项`, `${pending} pending · ${completed} completed`)}</span></div>
    {approvals.map((approval) => <ApprovalCard approval={approval} busy={busy[approval.id]} error={errors[approval.id]} key={approval.id}
      onDecision={(id, decision) => { void decide(id, decision); }} onRefresh={() => setRetryKey((key) => key + 1)} />)}
    {loadError && <div className="tm-approval-error"><p role="alert">{loadError}</p><button onClick={() => setRetryKey((key) => key + 1)} type="button">{text("重试加载审批", "Retry loading approvals")}</button></div>}
  </section>;
}
