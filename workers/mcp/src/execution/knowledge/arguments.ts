import { readString } from "../../http.ts";
import { HttpError } from "../../types.ts";
import { base64ToBytes, isRecord, optionalText, readOptionalString, requireText } from "../values.ts";

export function knowledgeQueryContext(value: unknown) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new HttpError(400, "invalid_knowledge_query_context");
  }
  const context: Record<string, unknown> = {};
  const stringFields = [
    ["queryId", 140],
    ["parentStepId", 140],
    ["clientSessionId", 240],
    ["clientTurnId", 240],
    ["originalQuestion", 4_000]
  ] as const;
  for (const [key, maxLength] of stringFields) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string") {
      throw new HttpError(400, "invalid_knowledge_query_context");
    }
    const text = value[key].trim();
    if (text.length > maxLength || /[\u0000-\u001f]/.test(text)) {
      throw new HttpError(400, "invalid_knowledge_query_context");
    }
    if (text) context[key] = text;
  }
  if (value.storeOriginalQuestion !== undefined) {
    if (typeof value.storeOriginalQuestion !== "boolean") {
      throw new HttpError(400, "invalid_knowledge_query_context");
    }
    context.storeOriginalQuestion = value.storeOriginalQuestion;
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

export function requireToolConfirmation(args: Record<string, unknown>) {
  if (args.confirm === true || args.confirmation === true) {
    return;
  }
  throw new HttpError(409, "tool_confirmation_required");
}

export function normalizeKnowledgeShareExpiry(value: unknown): "24h" | "permanent" {
  const expiry = readString(value).trim() || "24h";
  if (expiry === "24h" || expiry === "permanent") {
    return expiry;
  }
  throw new HttpError(400, "invalid_knowledge_public_share_expiry");
}

export function knowledgePublicShareResult(payload: unknown) {
  const record = isRecord(payload) ? payload : {};
  const url = readOptionalString(record.url);
  return url
    ? { ...record, rawUrl: `${url}/raw`, downloadUrl: `${url}/download` }
    : payload;
}

export function mergeKnowledgeRootListings(personalPayload: unknown, sharedPayload: unknown) {
  const personal = isRecord(personalPayload) ? personalPayload : {};
  const shared = isRecord(sharedPayload) ? sharedPayload : {};
  const personalItems = Array.isArray(personal.items) ? personal.items : [];
  const sharedItems = Array.isArray(shared.items) ? shared.items : [];
  const seenIds = new Set<string>();
  const items = [...personalItems, ...sharedItems].filter((item) => {
    const id = isRecord(item) ? readString(item.id).trim() : "";
    if (!id) return true;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
  return { ...personal, items };
}

export function knowledgeFileFormData(args: Record<string, unknown>, options: { includeParent: boolean }) {
  const form = new FormData();
  const fileName = requireText(args.fileName ?? args.name, "missing_knowledge_file_name", 240);
  const mimeType = optionalText(args.mimeType ?? args.contentType, 160) || "application/octet-stream";
  const sourceUrl = readString(args.sourceUrl).trim();
  if (sourceUrl && (!options.includeParent || args.contentText !== undefined || args.contentBase64 !== undefined || args.text !== undefined || args.base64 !== undefined))
    throw new HttpError(400, 'knowledge_upload_content_conflict');
  const bytes = sourceUrl ? undefined : knowledgeFileBytes(args);

  if (options.includeParent) {
    const parentObjectId = readOptionalString(args.parentObjectId);
    if (parentObjectId) {
      form.set("parentObjectId", parentObjectId);
    } else {
      form.set("parentPath", optionalText(args.parentPath, 800));
    }
    if (args.extractZip === false || readString(args.extractZip).trim().toLowerCase() === "false") {
      form.set("extractZip", "false");
    }
  }
  const expectedVersionId = readOptionalString(args.expectedCurrentVersionId);
  if (expectedVersionId) {
    form.set("expectedCurrentVersionId", expectedVersionId);
  }

  if (sourceUrl) {
    form.set('sourceUrl', sourceUrl); form.set('fileName', fileName); form.set('mimeType', mimeType);
  } else form.set("file", new Blob([bytes!], { type: mimeType }), fileName.slice(0, 240));
  return form;
}

function knowledgeFileBytes(args: Record<string, unknown>) {
  const rawBase64 = readString(args.contentBase64 ?? args.base64).trim();
  if (rawBase64) {
    return base64ToBytes(rawBase64);
  }

  if (Object.prototype.hasOwnProperty.call(args, "contentText") || Object.prototype.hasOwnProperty.call(args, "text")) {
    return new TextEncoder().encode(readString(args.contentText ?? args.text));
  }

  throw new HttpError(400, "missing_knowledge_file_content");
}
