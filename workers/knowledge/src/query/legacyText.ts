import { HttpError } from "../http.ts";
import { knowledgeV2Flags } from "../knowledge-v2-flags.ts";
import { KNOWLEDGE_ACTION_MAX_TEXT_BYTES } from "../policy.ts";
import { knowledgeServiceJson, knowledgeServiceVersionJson } from "../services/representation.ts";
import { readSnapshotText } from "../services/snapshots.ts";
import type { Env, Principal } from "../types.ts";
import { readBoolean, readString } from "../values.ts";
import { readableKnowledgeServiceContext } from "./context.ts";
import { knowledgeServiceGrepV2, knowledgeServiceSearchV2 } from "./indexedText.ts";
import { recordKnowledgeQueryShadow } from "./shadow.ts";
import { bestSnippet, readLimit, scoreSearchText, searchTerms, stripMarkup } from "./text.ts";

// Retain snapshot search and optional shadow comparison during the existing rollout.
export async function knowledgeServiceSearch(env: Env, principal: Principal, serviceId: string, body: Record<string, unknown>) {
  if (knowledgeV2Flags(env).indexRead) {
    return knowledgeServiceSearchV2(env, principal, serviceId, body);
  }
  const context = await readableKnowledgeServiceContext(env, principal, serviceId);
  const query = readString(body.query ?? body.q).trim();
  if (!query) {
    throw new HttpError(400, "missing_knowledge_service_search_query");
  }
  const limit = readLimit(body.limit, 10, 50);
  const terms = searchTerms(query);
  const results: unknown[] = [];

  for (const snapshot of context.snapshots) {
    if (results.length >= limit) {
      break;
    }
    if (snapshot.isHandbook) {
      continue;
    }
    const text = await readSnapshotText(env, snapshot, { maxBytes: KNOWLEDGE_ACTION_MAX_TEXT_BYTES, skipNonText: true });
    if (!text) {
      continue;
    }
    const haystack = `${snapshot.relativePath}\n${stripMarkup(text.text)}`;
    const score = scoreSearchText(haystack, terms);
    if (score <= 0) {
      continue;
    }
    results.push({
      objectId: snapshot.objectId,
      versionId: snapshot.versionId,
      path: snapshot.path,
      relativePath: snapshot.relativePath,
      fileName: snapshot.fileName,
      contentKind: snapshot.contentKind,
      mimeType: text.mimeType,
      score,
      snippet: bestSnippet(stripMarkup(text.text), terms)
    });
  }

  results.sort((a, b) => Number((b as { score?: number }).score ?? 0) - Number((a as { score?: number }).score ?? 0));
  const response = {
    service: knowledgeServiceJson(context.service, context.version, context.effectiveRole),
    version: knowledgeServiceVersionJson(context.version),
    query,
    results: results.slice(0, limit)
  };
  if (knowledgeV2Flags(env).shadowRead) {
    await recordKnowledgeQueryShadow(
      env,
      principal,
      serviceId,
      "search",
      query,
      response,
      () => knowledgeServiceSearchV2(env, principal, serviceId, body)
    );
  }
  return response;
}

export async function knowledgeServiceGrep(env: Env, principal: Principal, serviceId: string, body: Record<string, unknown>) {
  if (knowledgeV2Flags(env).indexRead) {
    return knowledgeServiceGrepV2(env, principal, serviceId, body);
  }
  const context = await readableKnowledgeServiceContext(env, principal, serviceId);
  const pattern = readString(body.pattern ?? body.query ?? body.q).trim();
  if (!pattern) {
    throw new HttpError(400, "missing_knowledge_service_grep_pattern");
  }
  const limit = readLimit(body.limit, 20, 100);
  const caseSensitive = readBoolean(body.caseSensitive ?? body.case_sensitive);
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const results: unknown[] = [];

  for (const snapshot of context.snapshots) {
    if (results.length >= limit) {
      break;
    }
    if (snapshot.isHandbook) {
      continue;
    }
    const text = await readSnapshotText(env, snapshot, { maxBytes: KNOWLEDGE_ACTION_MAX_TEXT_BYTES, skipNonText: true });
    if (!text) {
      continue;
    }
    const lines = text.text.split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < limit; index += 1) {
      const line = lines[index];
      const haystack = caseSensitive ? line : line.toLowerCase();
      if (!haystack.includes(needle)) {
        continue;
      }
      results.push({
        objectId: snapshot.objectId,
        versionId: snapshot.versionId,
        path: snapshot.path,
        relativePath: snapshot.relativePath,
        fileName: snapshot.fileName,
        contentKind: snapshot.contentKind,
        mimeType: text.mimeType,
        lineNumber: index + 1,
        line: line.slice(0, 800)
      });
    }
  }

  const response = {
    service: knowledgeServiceJson(context.service, context.version, context.effectiveRole),
    version: knowledgeServiceVersionJson(context.version),
    pattern,
    caseSensitive,
    results
  };
  if (knowledgeV2Flags(env).shadowRead) {
    await recordKnowledgeQueryShadow(
      env,
      principal,
      serviceId,
      "grep",
      pattern,
      response,
      () => knowledgeServiceGrepV2(env, principal, serviceId, body)
    );
  }
  return response;
}
