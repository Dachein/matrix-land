import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { approvalCardStatus, approvalPresentation, type RuntimeApproval } from "../approvalPresentation";
import { useMateLocale } from "../locale";

const Markdown = lazy(async () => ({ default: (await import("../MarkdownMessage")).MateMarkdownMessage }));

export function ApprovalCard({ approval, busy, error, onDecision, onRefresh }: {
  approval: RuntimeApproval;
  busy?: "approve" | "deny";
  error?: string;
  onDecision: (id: string, decision: "approve" | "deny") => void;
  onRefresh: () => void;
}) {
  const { text, locale } = useMateLocale();
  const status = busy ? "executing" : approvalCardStatus(approval);
  const terminal = !["pending", "executing"].includes(status);
  const [expanded, setExpanded] = useState(!terminal);
  const [view, setView] = useState(approval.operation.arguments?.operation === "append_text" ? "preview" : "diff");
  const content = useMemo(() => approvalPresentation(approval, text), [approval.operation, text]);
  useEffect(() => { setExpanded(!terminal); }, [terminal]);
  const labels = {
    pending: text("待确认", "Awaiting confirmation"), executing: busy === "deny" ? text("正在拒绝", "Declining") : text("正在执行", "Executing"),
    completed: text("已完成", "Completed"), failed: text("执行失败", "Failed"),
    denied: text("已拒绝", "Declined"), expired: text("已过期", "Expired"), cancelled: text("已取消", "Cancelled")
  };
  const expires = Date.parse(approval.expiresAt);
  const summary = approval.task?.conclusion?.summary || "";
  const diagnostic = approval.task?.conclusion?.failures?.[0];
  const failure = /knowledge_edit_patch_invalid|knowledge_edit_patch_count_mismatch/.test(diagnostic?.code || summary)
    ? text("补丁格式无效，此项修改未完成。请重新生成带行号和正确行数的标准 unified diff，或改用精确文本替换。", "The patch format is invalid. Generate a standard unified diff with numbered hunks and correct line counts, or use an exact text replacement.")
    : /version_conflict|knowledge_edit_occurrence_mismatch|knowledge_edit_patch_context_mismatch/.test(summary)
    ? text("文件内容已变化，此项修改未完成。请读取最新内容并重新生成提案。", "The file has changed and this edit did not complete. Read the latest content and request a new proposal.")
    : /approval_release_changed|approval_action_changed/.test(summary)
      ? text("提案对应的版本或操作已变化，请重新生成提案。", "The proposal's version or action has changed. Request a new proposal.")
      : summary || text("操作未完成，请查看执行详情。", "The action did not complete. Review the execution details.");
  return <article className="tm-approval-card" data-approval-id={approval.id} data-status={status} aria-busy={Boolean(busy)}>
    <header className="tm-approval-card-header">
      <div><span className="tm-approval-eyebrow">{text("操作确认", "Action review")}</span><h3>{content.title}</h3></div>
      <span className="tm-approval-badge" role="status">{labels[status]}</span>
    </header>
    {content.path && <p className="tm-approval-path">{content.path}</p>}
    {!content.path && content.targetId && <p className="tm-approval-path">{text("目标文件 / 位置：", "Target / location: ")}{content.targetId}</p>}
    {status === "pending" && <p className="tm-approval-scope">{text("仅确认本卡片列出的操作，其他待确认项不受影响。", "Confirms only the action listed in this card. Other pending items are unaffected.")}</p>}
    {status === "executing" && <p className="tm-approval-result">{busy
      ? text("正在处理这一项，结果会显示在这里。", "Processing this item. Its result will appear here.")
      : text("已确认，正在核对执行结果。", "Confirmed. Checking the execution result.")}</p>}
    {status === "completed" && <p className="tm-approval-result">{approval.operation.type === "mate_self_definition_update"
      ? text("Mate 新版本已发布。请开始新对话使用更新后的定义。", "The new Mate release is published. Start a new conversation to use it.")
      : text("此项操作已执行成功。", "This action completed successfully.")}</p>}
    {status === "failed" && <p className="tm-approval-result" role="alert">{failure}</p>}
    {status === "failed" && diagnostic && <details className="tm-approval-details">
      <summary>{text("失败详情", "Failure details")}</summary>
      {diagnostic.code && <p>{text("错误码：", "Error code: ")}{diagnostic.code}</p>}
      {diagnostic.upstreamStatus && <p>HTTP {diagnostic.upstreamStatus}</p>}
      {diagnostic.upstreamCode && diagnostic.upstreamCode !== diagnostic.code && <p>{text("服务错误码：", "Service error code: ")}{diagnostic.upstreamCode}</p>}
      {diagnostic.requestId && <p>{text("请求编号：", "Request ID: ")}{diagnostic.requestId}</p>}
      {diagnostic.causeRequestId && <p>{text("知识库请求编号：", "Knowledge request ID: ")}{diagnostic.causeRequestId}</p>}
    </details>}
    {status === "denied" && <p className="tm-approval-result">{text("此项操作未获批准，未执行。", "This action was declined and was not executed.")}</p>}
    {status === "expired" && <p className="tm-approval-result">{text("确认已过期，未执行。请重新生成提案。", "Confirmation expired without execution. Request a new proposal.")}</p>}
    {terminal && <button className="tm-approval-disclosure" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} type="button">{expanded ? text("收起修改", "Hide changes") : text("查看修改", "View changes")}</button>}
    {expanded && <div className="tm-approval-content">
      {content.note && <p className="tm-approval-note">{content.note}</p>}
      {content.diff.length > 0 && <div className="tm-approval-view-switch" aria-label={text("内容视图", "Content view")}>
        <button aria-pressed={view === "diff"} onClick={() => setView("diff")} type="button">{text("修改差异", "Changes")}</button>
        <button aria-pressed={view === "preview"} onClick={() => setView("preview")} type="button">{content.previewLabel}</button>
        <span className="tm-approval-diff-count"><span>+{content.additions}</span><span>−{content.removals}</span></span>
      </div>}
      {content.diff.length > 0 && view === "diff" ? <div className="tm-approval-diff" aria-label={text("修改差异", "Changes")}>
        {content.diff.map((line, index) => <div className={`is-${line.kind}`} key={index}><code>{line.text || " "}</code></div>)}
      </div> : (content.preview || content.diff.length > 0) && <div className="tm-approval-preview" aria-label={content.previewLabel}>
        {!content.diff.length && <h4>{content.previewLabel}</h4>}
        <Suspense fallback={<pre>{content.preview}</pre>}><Markdown content={content.preview} stripFileMarkers={false} /></Suspense>
      </div>}
      {!content.preview && !content.diff.length && <p className="tm-approval-note">{text("请展开操作详情核对具体参数。", "Expand action details to review the exact parameters.")}</p>}
      <details className="tm-approval-details">
        <summary>{text("操作详情", "Action details")}</summary>
        <p>{text("确认编号：", "Approval ID: ")}{approval.id}</p>
        <pre>{JSON.stringify(approval.operation, null, 2)}</pre>
        {approval.task?.conclusion?.summary && <p>{approval.task.conclusion.summary}</p>}
      </details>
    </div>}
    {error && <div className="tm-approval-error" role="alert"><p>{error}</p><button onClick={onRefresh} type="button">{text("刷新此项状态", "Refresh item status")}</button></div>}
    {status === "pending" && <footer className="tm-approval-footer">
      <span>{Number.isFinite(expires) ? text("有效期至 ", "Expires ") + new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(expires) : ""}</span>
      <div className="tm-approval-actions">
        <button disabled={Boolean(error)} onClick={() => onDecision(approval.id, "deny")} type="button">{text("拒绝此项", "Decline this item")}</button>
        <button disabled={Boolean(error)} onClick={() => onDecision(approval.id, "approve")} type="button">{text("确认这项修改", "Confirm this change")}</button>
      </div>
    </footer>}
  </article>;
}
