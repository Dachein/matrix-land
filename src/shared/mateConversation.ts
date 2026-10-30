const DEFAULT_TITLE_MAX_LENGTH = 72;

export type MateConversationTitleInput = {
  attachmentNames?: string[];
  maxLength?: number;
  text?: string;
};

/**
 * Builds the stable, write-once title for a Mate Conversation.
 * This is deliberately deterministic: creating the first turn must not wait
 * for, or spend tokens on, a second LLM request.
 */
export function mateConversationTitle(input: MateConversationTitleInput) {
  const maxLength = Number.isSafeInteger(input.maxLength) && Number(input.maxLength) > 0
    ? Math.min(Number(input.maxLength), 160)
    : DEFAULT_TITLE_MAX_LENGTH;
  const text = normalizeTitleText(input.text);
  const attachmentTitle = (input.attachmentNames ?? [])
    .map(normalizeAttachmentName)
    .filter(Boolean)
    .slice(0, 3)
    .join("、");
  const candidate = text || (attachmentTitle ? `附件：${attachmentTitle}` : "");
  if (candidate.length <= maxLength) return candidate;
  return `${candidate.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function normalizeTitleText(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAttachmentName(value: unknown) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f/\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 80)
    : "";
}
