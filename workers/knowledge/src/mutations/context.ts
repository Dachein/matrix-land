import { HttpError } from "../http.ts";
import type { KnowledgeMutationContext, KnowledgeMutationSource } from "../types.ts";
import { readString } from "../values.ts";

export function mutationContextFromRequest(
  request: Request,
  requestId: string,
  operation: string,
  bodyExpectedVersionId = ""
): KnowledgeMutationContext {
  const requestedChannel = readString(request.headers.get("x-workspace-source-channel")).trim().toLowerCase();
  const sourceChannel: KnowledgeMutationSource = (
    ["portal", "mcp", "api", "zip", "sync", "system"] as KnowledgeMutationSource[]
  ).includes(requestedChannel as KnowledgeMutationSource)
    ? requestedChannel as KnowledgeMutationSource
    : "api";
  const rawExpectedVersionId = bodyExpectedVersionId
    || readString(request.headers.get("x-expected-current-version-id"))
    || readString(request.headers.get("if-match"));
  return {
    expectedVersionId: rawExpectedVersionId.trim().replace(/^W\//, "").replace(/^"|"$/g, ""),
    idempotencyKey: normalizeKnowledgeIdempotencyKey(
      request.headers.get("idempotency-key") ?? request.headers.get("x-idempotency-key") ?? undefined
    ) ?? `request:${requestId}`,
    operation,
    requestId,
    sourceChannel
  };
}

export function normalizeKnowledgeIdempotencyKey(value: unknown) {
  const key = readString(value).trim();
  if (!key) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._:/-]{1,160}$/.test(key)) {
    throw new HttpError(400, "invalid_idempotency_key");
  }
  return key;
}

export function requireArgString(value: unknown, code: string) {
  const result = readString(value).trim();
  if (!result) {
    throw new HttpError(400, code);
  }
  return result;
}
