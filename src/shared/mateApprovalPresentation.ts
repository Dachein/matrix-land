import type { RuntimeApprovalState } from "./mateApprovalState";

export type RuntimeApproval = RuntimeApprovalState & {
  conversationId?: string;
  expiresAt: string;
  releaseId: string;
  operation: {
    type: string;
    toolName?: string;
    arguments?: Record<string, unknown>;
    change?: Record<string, unknown>;
    display?: { fileName?: string; path?: string };
  };
};

type Text = (zh: string, en: string) => string;
export type DiffLine = { kind: "added" | "removed" | "context" | "header"; text: string };
const string = (value: unknown) => typeof value === "string" ? value : "";

/** Only stored operation data is used. Snippets are never presented as a complete document. */
export function approvalPresentation(approval: RuntimeApproval, t: Text) {
  const operation = approval.operation;
  const args = operation.arguments ?? {};
  const edit = string(args.operation);
  const action = string(args.action);
  const knowledge = operation.type === "workspace_knowledge_maintenance"
    || operation.toolName === "knowledge_library_write" || operation.toolName === "knowledge_library_delete";
  const patch = string(args.patch ?? args.patchText ?? args.text);
  const patchPath = edit === "apply_patch" ? patch.match(/^(?:\*\*\* Update File: |\+\+\+ (?:b\/)?)(.+)$/m)?.[1]?.trim() : "";
  const target = string(operation.display?.fileName) || string(args.fileName) || string(args.name) || patchPath || "";
  const actions: Record<string, string> = {
    upload: t("新增文件", "Create file"), create_folder: t("新建文件夹", "Create folder"),
    rename: t("重命名", "Rename"), move: t("移动", "Move"), restore: t("恢复文件", "Restore file"),
    restore_version: t("恢复历史版本", "Restore version"), update: t("更新文件", "Update file"),
    edit: t("更新文件", "Update file"), batch: t("修改多项内容", "Update multiple items")
  };
  const actionLabel = knowledge
    ? operation.toolName === "knowledge_library_delete" ? t("删除文件", "Delete file")
      : edit === "append_text" ? t("追加内容", "Append content") : actions[action] || t("更新知识库", "Update knowledge")
    : operation.type === "mate_self_definition_update" ? t("更新 Mate 定义", "Update Mate definition")
      : operation.toolName === "forum_write" ? t("发布论坛内容", "Publish forum content")
        : t("执行操作", "Run action");
  let diff: DiffLine[] = [];
  let preview = "";
  let previewLabel = t("内容预览", "Content preview");
  let note = "";
  if (knowledge && edit === "apply_patch") {
    let inHunk = false;
    diff = patch.replace(/\r\n?/g, "\n").split("\n").map((line) => {
      if (line.startsWith("@@")) { inHunk = true; return { kind: "header", text: line }; }
      return {
        kind: /^(\*\*\*|diff |index )/.test(line) || (!inHunk && /^(--- |\+\+\+ )/.test(line)) ? "header"
          : line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context",
        text: line
      };
    });
    // Keep hunk boundaries visible rather than fabricating a full post-edit document.
    previewLabel = t("修改后的片段", "Updated excerpts");
    const excerpts: string[][] = [[]];
    for (const line of diff) {
      if (line.kind === "header") {
        if (line.text.startsWith("@@") && excerpts.at(-1)!.length) excerpts.push([]);
      } else if (line.kind !== "removed" && line.text !== "\\ No newline at end of file") {
        excerpts.at(-1)!.push(line.text.replace(/^[ +]/, ""));
      }
    }
    preview = excerpts.filter((lines) => lines.length).map((lines) => lines.join("\n")).join("\n\n---\n\n");
    note = t("这里只展示补丁涉及的片段，未展示的内容保持原样。", "Only the patch excerpts are shown; content outside them is unchanged.");
  } else if (knowledge && edit === "replace_text") {
    diff = [
      ...string(args.oldText ?? args.old_text).split("\n").map((line): DiffLine => ({ kind: "removed", text: `− ${line}` })),
      ...string(args.newText ?? args.new_text).split("\n").map((line): DiffLine => ({ kind: "added", text: `+ ${line}` }))
    ];
    preview = string(args.newText ?? args.new_text);
    previewLabel = t("替换后的片段", "Replacement excerpt");
    const occurrences = Number(args.expectedOccurrences ?? args.expected_occurrences ?? 1);
    note = t(`将替换 ${occurrences} 处匹配内容；这里只展示替换片段。`, `Replaces ${occurrences} matching occurrence(s); only the replacement excerpt is shown.`);
  } else if (knowledge && edit === "append_text") {
    preview = string(args.text ?? args.contentText);
    previewLabel = t("本次新增内容", "Content being appended");
    diff = preview.split("\n").map((line) => ({ kind: "added", text: `+ ${line}` }));
    note = t("以下内容将追加到文件末尾。", "This content will be appended to the end of the file.");
  } else if (knowledge && (edit === "replace_content" || action === "upload" || action === "update")) {
    preview = string(args.contentText ?? args.text);
    previewLabel = edit === "replace_content" || action === "update" ? t("替换后的完整内容", "Full replacement content") : t("新文件预览", "New file preview");
    note = edit === "replace_content" || action === "update"
      ? t("此操作会替换原文件内容。提案未包含原文，无法展示逐行差异。", "This replaces the file content. The proposal has no original text for a line-by-line comparison.") : "";
  }
  return {
    title: target ? `${actionLabel} · ${target}` : actionLabel,
    targetId: string(args.objectId ?? args.parentObjectId),
    path: string(operation.display?.path),
    actionLabel, diff, preview, previewLabel, note,
    additions: diff.filter((line) => line.kind === "added").length,
    removals: diff.filter((line) => line.kind === "removed").length
  };
}

export function approvalCardStatus(approval: RuntimeApprovalState, now = Date.now()) {
  if (approval.status === "denied") return "denied";
  if (approval.status === "expired" || (approval.status === "pending" && Date.parse(approval.expiresAt || "") <= now)) return "expired";
  if (approval.status === "pending") return "pending";
  if (approval.task?.status === "completed") return "completed";
  if (approval.task?.status === "failed") return "failed";
  if (approval.task?.status === "cancelled") return "cancelled";
  return "executing";
}

/** Keep card positions and authoritative decisions when a lagging read arrives. */
export function mergeApprovalStates(previous: RuntimeApproval[], incoming: RuntimeApproval[]) {
  const next = new Map(previous.map((item) => [item.id, item]));
  for (const item of incoming) {
    const existing = next.get(item.id);
    if (existing && existing.status !== "pending" && item.status === "pending") continue;
    const terminalTask = existing?.task && ["completed", "failed", "cancelled"].includes(existing.task.status || "");
    next.set(item.id, { ...existing, ...item, task: terminalTask ? existing.task : item.task ?? existing?.task });
  }
  return [...next.values()];
}
