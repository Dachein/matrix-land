import type { WorkspaceAcceptedMateEnvironment } from "../../../sdk/mate/environment.ts";

const WORKSPACE_FILE_URL = /\/api\/workspace-files\/[A-Za-z0-9_%.-]+\/(?:raw|download)/g;
const WEIXIN_TEXT_LIMIT = 3_900;

export function weixinConversationInstruction(environment: unknown) {
  if (!isWeixinEnvironment(environment)) return "";
  return [
    "This turn will be delivered through Weixin. Return concise plain text only.",
    "Do not use Markdown headings, emphasis, fenced code blocks, tables, blockquotes, bullet markers, or Markdown link syntax.",
    "Prefer one short answer within 800 Chinese characters unless accuracy requires more detail.",
    "When a file is available, include its file name and the exact /api/workspace-files/.../download reference returned by the tool. The trusted Weixin gateway converts it to an HTTPS download entry."
  ].join(" ");
}

export function formatWeixinConversationResponse(
  value: string,
  input: {
    conversationId: string;
    mateId: string;
    webHostUrl?: string;
  }
) {
  const original = String(value ?? "").trim();
  const workspaceEntryUrl = mateConversationUrl(input);
  const hasWorkspaceFile = WORKSPACE_FILE_URL.test(original);
  WORKSPACE_FILE_URL.lastIndex = 0;

  let output = original
    .replace(/!\[([^\]]*)\]\((https:\/\/[^\s)]+|\/api\/workspace-files\/[A-Za-z0-9_%.-]+\/(?:raw|download))\)/g, (_match, label, url) => (
      `${plainLabel(label, "文件")}：${workspaceUrl(url, workspaceEntryUrl)}`
    ))
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+|\/api\/workspace-files\/[A-Za-z0-9_%.-]+\/(?:raw|download))\)/g, (_match, label, url) => (
      `${plainLabel(label, "链接")}：${workspaceUrl(url, workspaceEntryUrl)}`
    ))
    .replace(WORKSPACE_FILE_URL, workspaceEntryUrl || "请在 Mate 工作台下载文件")
    .replace(/^\s*```[^\n]*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/^\s*(\d+)[.)]\s+/gm, "$1、")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, "")
    .replace(/^\s*\|(.+)\|\s*$/gm, (_match, cells) => String(cells).split("|").map((cell) => cell.trim()).filter(Boolean).join(" ｜ "))
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!output) output = "本次没有生成可发送的文字回答，请稍后重试。";
  if (output.length > WEIXIN_TEXT_LIMIT) {
    output = `${output.slice(0, WEIXIN_TEXT_LIMIT - 1).trimEnd()}…`;
  }
  if (hasWorkspaceFile && workspaceEntryUrl && !output.includes(workspaceEntryUrl)) {
    const suffix = `\n文件下载：${workspaceEntryUrl}`;
    output = `${output.slice(0, Math.max(0, WEIXIN_TEXT_LIMIT - suffix.length)).trimEnd()}${suffix}`;
  }
  return output;
}

function isWeixinEnvironment(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  if (source.environment && source.environment !== value && isWeixinEnvironment(source.environment)) return true;
  if (source.schemaVersion !== "workspace.mate-environment-accepted/v1") return false;
  const accepted = source as WorkspaceAcceptedMateEnvironment;
  return accepted.context?.host?.surface === "weixin";
}

function mateConversationUrl(input: { conversationId: string; mateId: string; webHostUrl?: string }) {
  try {
    const origin = new URL(input.webHostUrl?.trim() || "");
    if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) return "";
    const url = new URL(`/mates/${encodeURIComponent(input.mateId)}`, origin);
    url.searchParams.set("conversation", input.conversationId);
    return url.toString();
  } catch {
    return "";
  }
}

function workspaceUrl(value: string, workspaceEntryUrl: string) {
  return value.startsWith("/api/workspace-files/")
    ? workspaceEntryUrl || "请在 Mate 工作台下载文件"
    : value;
}

function plainLabel(value: string, fallback: string) {
  return value.replace(/[*_~`]/g, "").trim() || fallback;
}
