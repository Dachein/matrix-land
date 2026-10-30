import { HttpError } from "../http.ts";
import { requireReadableKnowledgeService } from "../services/access.ts";
import type { Env, Principal } from "../types.ts";
import { beginKnowledgeQueryLedgerStep, completeKnowledgeQueryLedgerStep } from "./ledger.ts";
import { knowledgeServiceGrep, knowledgeServiceSearch } from "./legacyText.ts";
import { knowledgeServiceRead } from "./read.ts";
import { knowledgeServiceGlob, knowledgeServiceTree } from "./tree.ts";
import type { KnowledgeServiceQueryAction } from "./types.ts";

// Authorize, execute and record each Knowledge query step.
export async function executeKnowledgeServiceQuery(
  env: Env,
  principal: Principal,
  serviceId: string,
  rawAction: string,
  body: Record<string, unknown>,
  requestId: string
) {
  if (!["tree", "glob", "search", "grep", "read"].includes(rawAction)) {
    throw new HttpError(400, "invalid_knowledge_service_query_action");
  }
  const action = rawAction as KnowledgeServiceQueryAction;
  const readable = await requireReadableKnowledgeService(env, principal, serviceId);
  const ledger = await beginKnowledgeQueryLedgerStep(
    env,
    principal,
    readable.row,
    action,
    body,
    requestId
  );
  try {
    const result = action === "search"
      ? await knowledgeServiceSearch(env, principal, serviceId, body)
      : action === "grep"
        ? await knowledgeServiceGrep(env, principal, serviceId, body)
        : action === "tree"
          ? await knowledgeServiceTree(env, principal, serviceId, body)
          : action === "glob"
            ? await knowledgeServiceGlob(env, principal, serviceId, body)
            : await knowledgeServiceRead(env, principal, serviceId, body);
    await completeKnowledgeQueryLedgerStep(env, ledger, "succeeded", result);
    return {
      ...result,
      queryLedger: {
        queryId: ledger.queryId,
        queryStepId: ledger.queryStepId
      }
    };
  } catch (error) {
    await completeKnowledgeQueryLedgerStep(env, ledger, "failed", undefined, error);
    throw error;
  }
}
