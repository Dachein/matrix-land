import type { NamespaceRow, ObjectRow, Env, Principal } from "../types.ts";
import { requireReadableKnowledgeService } from "../services/access.ts";
import { HttpError } from "../http.ts";
import { requireReadableObject } from "../objects/access.ts";
import {
  requireNamespaceForPrincipal,
  requireRootObjectForMutation,
  requireObject
} from "../objects/repository.ts";
import { readString, isRecord } from "../values.ts";
import { writeAuditEvent } from "../audit/events.ts";
import { requireKnowledgeChangeAuditAccess } from "../audit/reads.ts";
import { readLimit } from "../query/text.ts";

type KnowledgeFeedbackTarget = {
  feedbackEnabled: boolean;
  namespace: NamespaceRow;
  root: ObjectRow;
  serviceId: string;
};

async function resolveKnowledgeFeedbackTarget(
  env: Env,
  principal: Principal,
  input: { rootObjectId: string; serviceId: string }
): Promise<KnowledgeFeedbackTarget> {
  if (input.serviceId) {
    const readable = await requireReadableKnowledgeService(env, principal, input.serviceId);
    if (input.rootObjectId && input.rootObjectId !== readable.folder.id) {
      throw new HttpError(409, "knowledge_feedback_target_mismatch");
    }
    return {
      feedbackEnabled: true,
      namespace: readable.namespace,
      root: readable.folder,
      serviceId: readable.row.id
    };
  }
  if (!input.rootObjectId) {
    throw new HttpError(400, "knowledge_feedback_target_required");
  }
  const root = await requireReadableObject(env, principal, input.rootObjectId);
  if (root.object_kind !== "folder" || root.parent_path) {
    throw new HttpError(400, "knowledge_feedback_root_required");
  }
  return {
    feedbackEnabled: true,
    namespace: await requireNamespaceForPrincipal(env, root.namespace_id, principal),
    root,
    serviceId: ""
  };
}

export async function submitKnowledgeFeedback(
  env: Env,
  principal: Principal,
  body: Record<string, unknown>,
  request: {
    idempotencyKey: string;
    requestId: string;
    sourceChannel: "api" | "mcp" | "portal";
  }
) {
  const kind = readString(body.kind).trim().toLowerCase();
  if (!["question", "correction", "issue", "suggestion"].includes(kind)) {
    throw new HttpError(400, "knowledge_feedback_kind_invalid");
  }
  const message = readString(body.message).trim();
  if (!message || message.length > 4_000) {
    throw new HttpError(400, "knowledge_feedback_message_invalid");
  }
  const target = await resolveKnowledgeFeedbackTarget(env, principal, {
    rootObjectId: readString(body.rootObjectId ?? body.root_object_id).trim(),
    serviceId: readString(body.serviceId ?? body.service_id).trim()
  });
  if (!target.feedbackEnabled) {
    throw new HttpError(409, "knowledge_feedback_disabled");
  }
  const objectId = readString(body.objectId ?? body.object_id).trim();
  if (objectId) {
    const object = await requireReadableObject(env, principal, objectId);
    const objectRoot = await requireRootObjectForMutation(env, object);
    if (objectRoot.id !== target.root.id) {
      throw new HttpError(409, "knowledge_feedback_object_outside_root");
    }
  }
  const changeSetId = readString(body.changeSetId ?? body.change_set_id).trim();
  if (changeSetId) {
    const change = await env.KNOWLEDGE_DB
      .prepare("SELECT root_object_id FROM knowledge_change_sets WHERE id = ?")
      .bind(changeSetId)
      .first<{ root_object_id: string }>();
    if (!change || change.root_object_id !== target.root.id) {
      throw new HttpError(409, "knowledge_feedback_change_outside_root");
    }
  }
  const context = isRecord(body.context) ? body.context : {};
  const contextJson = JSON.stringify(context);
  if (contextJson.length > 8_000) {
    throw new HttpError(400, "knowledge_feedback_context_too_large");
  }
  const idempotencyKey = request.idempotencyKey.trim().slice(0, 200);
  if (!idempotencyKey) {
    throw new HttpError(400, "knowledge_feedback_idempotency_key_required");
  }
  const queryLink = await resolveKnowledgeFeedbackQueryLink(env, principal, target, body);
  const previous = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT feedback.*, link.query_id, link.query_step_id
       FROM knowledge_feedback AS feedback
       LEFT JOIN knowledge_feedback_query_links AS link ON link.feedback_id = feedback.id
       WHERE feedback.org_id = ? AND feedback.actor_user_id = ? AND feedback.idempotency_key = ?
       LIMIT 1`
    )
    .bind(principal.orgId, principal.sub, idempotencyKey)
    .first<Record<string, unknown>>();
  if (previous) {
    const sameIntent = (
      readString(previous.root_object_id) === target.root.id
      && readString(previous.service_id) === target.serviceId
      && readString(previous.object_id) === objectId
      && readString(previous.change_set_id) === changeSetId
      && readString(previous.kind) === kind
      && readString(previous.message) === message
      && readString(previous.context_json) === contextJson
      && readString(previous.query_id) === queryLink.queryId
      && readString(previous.query_step_id) === queryLink.queryStepId
    );
    if (!sameIntent) {
      throw new HttpError(409, "knowledge_feedback_idempotency_conflict");
    }
    return { ...knowledgeFeedbackJson(previous), replayed: true };
  }
  const id = `kfeedback_${crypto.randomUUID()}`;
  const statements = [
    env.KNOWLEDGE_DB.prepare(
      `INSERT INTO knowledge_feedback (
         id, org_id, namespace_id, root_object_id, service_id, object_id,
         change_set_id, actor_user_id, source_channel, kind, message,
         context_json, idempotency_key
       ) VALUES (?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      principal.orgId,
      target.namespace.id,
      target.root.id,
      target.serviceId,
      objectId,
      changeSetId,
      principal.sub,
      request.sourceChannel,
      kind,
      message,
      contextJson,
      idempotencyKey
    )
  ];
  if (queryLink.queryId) {
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_feedback_query_links (
             feedback_id, query_id, query_step_id
           ) VALUES (?, ?, NULLIF(?, ''))`
        )
        .bind(id, queryLink.queryId, queryLink.queryStepId)
    );
  }
  await env.KNOWLEDGE_DB.batch(statements);
  const row = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT feedback.*, link.query_id, link.query_step_id
       FROM knowledge_feedback AS feedback
       LEFT JOIN knowledge_feedback_query_links AS link ON link.feedback_id = feedback.id
       WHERE feedback.id = ?`
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) {
    throw new HttpError(500, "knowledge_feedback_create_failed");
  }
  await writeAuditEvent(env, {
    action: "knowledge.feedback.submit",
    metadata: {
      feedbackId: id,
      kind,
      requestId: request.requestId,
      serviceId: target.serviceId,
      sourceChannel: request.sourceChannel
    },
    namespace: target.namespace,
    objectId: target.root.id,
    principal
  });
  return { ...knowledgeFeedbackJson(row), replayed: false };
}

async function resolveKnowledgeFeedbackQueryLink(
  env: Env,
  principal: Principal,
  target: KnowledgeFeedbackTarget,
  body: Record<string, unknown>
) {
  const context = isRecord(body.context) ? body.context : {};
  const queryId = readString(body.queryId ?? body.query_id ?? context.queryId ?? context.query_id).trim();
  const queryStepId = readString(
    body.queryStepId
    ?? body.query_step_id
    ?? context.queryStepId
    ?? context.query_step_id
  ).trim();
  if (!queryId && queryStepId) {
    throw new HttpError(400, "knowledge_feedback_query_id_required");
  }
  if (!queryId) {
    return { queryId: "", queryStepId: "" };
  }
  const query = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT id, org_id, actor_user_id
       FROM knowledge_query_sessions
       WHERE id = ?`
    )
    .bind(queryId)
    .first<Record<string, unknown>>();
  if (
    !query
    || readString(query.org_id) !== principal.orgId
    || readString(query.actor_user_id) !== principal.sub
  ) {
    throw new HttpError(409, "knowledge_feedback_query_mismatch");
  }
  if (queryStepId) {
    const step = await env.KNOWLEDGE_DB
      .prepare("SELECT query_id, actor_user_id, service_id FROM knowledge_query_steps WHERE id = ?")
      .bind(queryStepId)
      .first<Record<string, unknown>>();
    if (
      !step
      || readString(step.query_id) !== queryId
      || readString(step.actor_user_id) !== principal.sub
      || (
        target.serviceId
        && readString(step.service_id) !== target.serviceId
      )
    ) {
      throw new HttpError(409, "knowledge_feedback_query_step_mismatch");
    }
  }
  return { queryId, queryStepId };
}

export async function listKnowledgeFeedback(
  env: Env,
  principal: Principal,
  filters: { limit: string; rootObjectId: string; serviceId: string; status: string }
) {
  const target = await resolveKnowledgeFeedbackTarget(env, principal, filters);
  await requireKnowledgeChangeAuditAccess(env, principal, target.root);
  const status = filters.status.trim().toLowerCase();
  if (status && !["open", "triaged", "resolved", "dismissed"].includes(status)) {
    throw new HttpError(400, "knowledge_feedback_status_invalid");
  }
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT feedback.*, link.query_id, link.query_step_id
       FROM knowledge_feedback AS feedback
       LEFT JOIN knowledge_feedback_query_links AS link ON link.feedback_id = feedback.id
       WHERE feedback.root_object_id = ?
         AND (? = '' OR feedback.service_id = ?)
         AND (? = '' OR feedback.status = ?)
       ORDER BY feedback.created_at DESC, feedback.id DESC
       LIMIT ?`
    )
    .bind(
      target.root.id,
      target.serviceId,
      target.serviceId,
      status,
      status,
      readLimit(filters.limit, 50, 100)
    )
    .all<Record<string, unknown>>();
  return {
    feedback: (rows.results ?? []).map(knowledgeFeedbackJson),
    rootObjectId: target.root.id,
    serviceId: target.serviceId || null
  };
}

export async function listMyKnowledgeFeedback(
  env: Env,
  principal: Principal,
  filters: { limit: string; serviceId: string; status: string }
) {
  const serviceId = filters.serviceId.trim();
  if (serviceId) {
    await requireReadableKnowledgeService(env, principal, serviceId);
  }
  const status = filters.status.trim().toLowerCase();
  if (status && !["open", "triaged", "resolved", "dismissed"].includes(status)) {
    throw new HttpError(400, "knowledge_feedback_status_invalid");
  }
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT feedback.*, link.query_id, link.query_step_id
       FROM knowledge_feedback AS feedback
       LEFT JOIN knowledge_feedback_query_links AS link ON link.feedback_id = feedback.id
       WHERE feedback.org_id = ?
         AND feedback.actor_user_id = ?
         AND (? = '' OR feedback.service_id = ?)
         AND (? = '' OR feedback.status = ?)
       ORDER BY feedback.created_at DESC, feedback.id DESC
       LIMIT ?`
    )
    .bind(
      principal.orgId,
      principal.sub,
      serviceId,
      serviceId,
      status,
      status,
      readLimit(filters.limit, 50, 100)
    )
    .all<Record<string, unknown>>();
  return {
    feedback: (rows.results ?? []).map(knowledgeFeedbackJson),
    serviceId: serviceId || null
  };
}

export async function readKnowledgeFeedback(env: Env, principal: Principal, feedbackId: string) {
  const row = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT feedback.*, link.query_id, link.query_step_id
       FROM knowledge_feedback AS feedback
       LEFT JOIN knowledge_feedback_query_links AS link ON link.feedback_id = feedback.id
       WHERE feedback.id = ? AND feedback.org_id = ?`
    )
    .bind(feedbackId, principal.orgId)
    .first<Record<string, unknown>>();
  if (!row) {
    throw new HttpError(404, "knowledge_feedback_not_found");
  }
  if (readString(row.actor_user_id) === principal.sub) {
    return knowledgeFeedbackJson(row);
  }
  const root = await requireObject(env, readString(row.root_object_id));
  await requireKnowledgeChangeAuditAccess(env, principal, root);
  return knowledgeFeedbackJson(row);
}

export async function updateKnowledgeFeedback(
  env: Env,
  principal: Principal,
  feedbackId: string,
  body: Record<string, unknown>
) {
  const row = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT feedback.*, link.query_id, link.query_step_id
       FROM knowledge_feedback AS feedback
       LEFT JOIN knowledge_feedback_query_links AS link ON link.feedback_id = feedback.id
       WHERE feedback.id = ?`
    )
    .bind(feedbackId)
    .first<Record<string, unknown>>();
  if (!row) {
    throw new HttpError(404, "knowledge_feedback_not_found");
  }
  const root = await requireObject(env, readString(row.root_object_id));
  await requireKnowledgeChangeAuditAccess(env, principal, root);
  const status = readString(body.status).trim().toLowerCase();
  if (!["open", "triaged", "resolved", "dismissed"].includes(status)) {
    throw new HttpError(400, "knowledge_feedback_status_invalid");
  }
  await env.KNOWLEDGE_DB
    .prepare(
      `UPDATE knowledge_feedback
       SET status = ?,
           resolved_at = CASE WHEN ? IN ('resolved', 'dismissed') THEN CURRENT_TIMESTAMP ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(status, status, feedbackId)
    .run();
  const updated = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT feedback.*, link.query_id, link.query_step_id
       FROM knowledge_feedback AS feedback
       LEFT JOIN knowledge_feedback_query_links AS link ON link.feedback_id = feedback.id
       WHERE feedback.id = ?`
    )
    .bind(feedbackId)
    .first<Record<string, unknown>>();
  const namespace = await requireNamespaceForPrincipal(env, root.namespace_id, principal);
  await writeAuditEvent(env, {
    action: "knowledge.feedback.status.update",
    metadata: { feedbackId, status },
    namespace,
    objectId: root.id,
    principal
  });
  return knowledgeFeedbackJson(updated ?? row);
}

function knowledgeFeedbackJson(row: Record<string, unknown>) {
  let context: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readString(row.context_json)) as unknown;
    context = isRecord(parsed) ? parsed : {};
  } catch {
    context = {};
  }
  return {
    actorUserId: readString(row.actor_user_id),
    changeSetId: readString(row.change_set_id) || null,
    context,
    createdAt: readString(row.created_at),
    id: readString(row.id),
    kind: readString(row.kind),
    message: readString(row.message),
    objectId: readString(row.object_id) || null,
    queryId: readString(row.query_id) || null,
    queryStepId: readString(row.query_step_id) || null,
    resolvedAt: readString(row.resolved_at) || null,
    rootObjectId: readString(row.root_object_id),
    serviceId: readString(row.service_id) || null,
    sourceChannel: readString(row.source_channel),
    status: readString(row.status),
    updatedAt: readString(row.updated_at)
  };
}

export function knowledgeFeedbackSourceChannel(request: Request): "api" | "mcp" | "portal" {
  const requested = readString(request.headers.get("x-workspace-source-channel")).trim().toLowerCase();
  return requested === "mcp" || requested === "portal" ? requested : "api";
}
