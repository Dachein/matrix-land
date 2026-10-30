import { KnowledgeTextPatchError, parseKnowledgeTextPatch } from "../../../src/shared/knowledgeTextPatch.ts";
import { RuntimeHttpError } from "./types.ts";

export function validateKnowledgeEditPatch(args: Record<string, unknown>) {
  if (args.operation !== "apply_patch") return;
  try { parseKnowledgeTextPatch(args.patch ?? args.patchText ?? args.text); }
  catch (error) {
    if (error instanceof KnowledgeTextPatchError) throw new RuntimeHttpError(400, error.code, {
      guidance: knowledgeMaintenanceGuidance(error.code)
    });
    throw error;
  }
}

/** Keep bounded machine identifiers only; never persist upstream message/body/headers. */
export function knowledgeMaintenanceUpstreamError(status: number, raw: string, fallbackCode: string) {
  const payload = parseObject(raw);
  const upstreamCode = safeCode(payload.error);
  const nested = upstreamCode === "knowledge_worker_request_failed" && typeof payload.message === "string"
    ? parseObject(payload.message) : {};
  const causeCode = safeCode(nested.error);
  const code = causeCode || upstreamCode || fallbackCode;
  return new RuntimeHttpError(status >= 500 ? 502 : status, code, {
    upstreamStatus: status,
    ...(upstreamCode ? { upstreamCode } : {}),
    ...(safeId(payload.requestId) ? { requestId: safeId(payload.requestId) } : {}),
    ...(safeId(nested.requestId) ? { causeRequestId: safeId(nested.requestId) } : {})
  });
}

export function knowledgeMaintenanceGuidance(code: string) {
  if (["knowledge_edit_patch_invalid", "knowledge_edit_patch_count_mismatch"].includes(code)) {
    return "补丁格式无效。请重新生成标准 unified diff，使用带行号和正确行数的 @@ -1,1 +1,1 @@，不要使用 *** Begin Patch 或无行号的 @@；也可使用 replace_text。";
  }
  if (/version_conflict|occurrence_mismatch|patch_context_mismatch/.test(code)) return "文件版本或原文已变化。请重新读取最新内容和版本，再生成修改提案。";
  if (/denied|forbidden|not_bound|scope_required/.test(code)) return "当前用户或 Mate 无权维护此文件。请检查文件夹权限和 Mate 的维护范围。";
  if (/approval_/.test(code)) return "审批状态或提案版本已变化。请重新生成提案并逐项确认。";
  return "知识库服务未完成操作。请根据错误码和请求编号排查；重新提交前先核对文件当前版本。";
}

function parseObject(raw: string): Record<string, unknown> {
  if (raw.length > 8192) return {};
  try { const value = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
function safeCode(value: unknown) {
  return typeof value === "string" && /^(?:knowledge_|folder_edit_|approval_|runtime_|mate_)[a-z0-9_]{1,100}$/.test(value) ? value : undefined;
}
function safeId(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
