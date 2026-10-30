import type { WorkspaceAgentRuntimeManifest } from "../../../src/shared/mate.ts";
import { normalizeWorkspaceMateHostContext } from "../../../sdk/mate/context.ts";
import {
  acceptWorkspaceMateEnvironment,
  WORKSPACE_MATE_ENVIRONMENT_SCHEMA_VERSION
} from "../../../sdk/mate/environment.ts";
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeMode, type RuntimePrincipal } from "./types.ts";

import { ensureWorkThread, readWorkThread } from "./workThreads.ts";
import { attachEmailThreadTask } from "./inboxStorage.ts";

const CHANNELS = new Set(["web", "sdk", "email", "mate_call", "schedule"]);

export type RuntimeApproval = {
  actionDigest: string;
  conversationId?: string;
  consumedAt?: string;
  decidedAt?: string;
  expiresAt: string;
  id: string;
  manifestSha256: string;
  operation: Record<string, unknown>;
  policyVersion?: string;
  releaseId: string;
  requestedAt: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  runId?: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  taskId: string;
  toolDefinitionVersion: string;
};

export async function listConversations(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode
) {
  const rows = await db.prepare(`
    SELECT id,
           CASE WHEN TRIM(title) = '' THEN '未命名对话' ELSE title END AS title,
           channel, status, pinned_at AS pinnedAt,
           created_at AS createdAt, updated_at AS updatedAt
    FROM mate_conversations
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ?
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
             CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END,
             pinned_at DESC,
             updated_at DESC
    LIMIT 100
  `).bind(mateId, principal.userId, mode).all();
  return rows.results ?? [];
}

// Cursor pagination keeps later pages stable when earlier rows are archived.
export async function listConversationPage(
  db: D1Database, mateId: string, principal: RuntimePrincipal, mode: RuntimeMode,
  status: string, cursor: string | null
) {
  if (status !== "active" && status !== "archived") throw new RuntimeHttpError(400, "conversation_status_invalid");
  let after: { updatedAt: string; id: string } | undefined;
  if (cursor) {
    try {
      after = JSON.parse(cursor);
      if (!after || typeof after.updatedAt !== "string" || typeof after.id !== "string"
        || after.updatedAt.length > 100 || after.id.length > 180) throw new Error("invalid cursor");
    } catch { throw new RuntimeHttpError(400, "conversation_cursor_invalid"); }
  }
  const rows = await db.prepare(`
    SELECT id, CASE WHEN TRIM(title) = '' THEN '未命名对话' ELSE title END AS title,
           channel, status, pinned_at AS pinnedAt, created_at AS createdAt, updated_at AS updatedAt
    FROM mate_conversations
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND channel = 'sdk' AND status = ?
      ${after ? "AND (updated_at < ? OR (updated_at = ? AND id < ?))" : ""}
    ORDER BY updated_at DESC, id DESC LIMIT 51
  `).bind(mateId, principal.userId, mode, status,
    ...(after ? [after.updatedAt, after.updatedAt, after.id] : [])).all<{ id: string; updatedAt: string }>();
  const conversations = (rows.results ?? []).slice(0, 50);
  const last = conversations.at(-1);
  return { conversations, nextCursor: (rows.results?.length ?? 0) > 50 && last
    ? JSON.stringify({ updatedAt: last.updatedAt, id: last.id }) : null };
}

export async function createConversation(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  input: Record<string, unknown>
) {
  rejectCallerIdentityFields(input);
  const channel = normalizeChannel(input.channel, principal);
  if (channel !== "sdk" && (mode !== "live" || channel !== "web")) {
    throw new RuntimeHttpError(400, "conversation_channel_invalid");
  }
  const id = identifier(input.conversationId) || `conv_${randomId()}`;
  const title = text(input.title).slice(0, 160);
  const now = new Date().toISOString();
  await db.prepare(`
      INSERT INTO mate_conversations (mate_id, user_id, runtime_mode, id, title, channel, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT (mate_id, user_id, runtime_mode, id) DO NOTHING
    `).bind(mateId, principal.userId, mode, id, title, channel, now, now).run();
  const conversation = await readConversation(db, mateId, principal.userId, mode, id);
  if (conversation.channel !== channel) {
    throw new RuntimeHttpError(409, "conversation_exists");
  }
  return conversation;
}

export async function updateConversation(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  conversationId: string,
  input: Record<string, unknown>
) {
  rejectCallerIdentityFields(input);
  const current = await readConversation(db, mateId, principal.userId, mode, conversationId);
  const changes = Object.keys(input);
  if (!changes.length || changes.some((key) => !["title", "status", "pinned"].includes(key))) {
    throw new RuntimeHttpError(400, "conversation_update_invalid");
  }
  const title = Object.hasOwn(input, "title")
    ? text(input.title).replace(/\s+/g, " ").trim().slice(0, 160)
    : String(current.title || "");
  if (Object.hasOwn(input, "title") && !title) {
    throw new RuntimeHttpError(400, "conversation_title_required");
  }
  const status = Object.hasOwn(input, "status") ? input.status : current.status;
  if (status !== "active" && status !== "archived") {
    throw new RuntimeHttpError(400, "conversation_status_invalid");
  }
  const pinned = Object.hasOwn(input, "pinned")
    ? input.pinned === true
    : Boolean(current.pinnedAt);
  if (Object.hasOwn(input, "pinned") && typeof input.pinned !== "boolean") {
    throw new RuntimeHttpError(400, "conversation_pinned_invalid");
  }
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE mate_conversations
    SET title = ?, status = ?, pinned_at = ?, updated_at = ?
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ?
  `).bind(
    title,
    status,
    status === "archived" || !pinned ? null : current.pinnedAt || now,
    now,
    mateId,
    principal.userId,
    mode,
    conversationId
  ).run();
  return readConversation(db, mateId, principal.userId, mode, conversationId);
}

/** Chat grants retain an idempotent projection repair for older SDK Hosts. */
export async function ensurePreviewSdkConversation(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  conversationId: string
) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO mate_conversations (
      mate_id, user_id, runtime_mode, id, title, channel, status, created_at, updated_at
    ) VALUES (?, ?, 'preview', ?, '', 'sdk', 'active', ?, ?)
    ON CONFLICT (mate_id, user_id, runtime_mode, id) DO NOTHING
  `).bind(mateId, principal.userId, conversationId, now, now).run();
  const conversation = await readConversation(db, mateId, principal.userId, "preview", conversationId);
  if (conversation.channel !== "sdk") {
    throw new RuntimeHttpError(409, "mate_chat_conversation_channel_invalid");
  }
  return conversation;
}

export async function listTasks(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  conversationId?: string
) {
  const statement = conversationId
    ? db.prepare(`
        SELECT task.*, conversation.title AS conversation_title
        FROM mate_tasks AS task
        LEFT JOIN mate_conversations AS conversation
          ON conversation.mate_id = task.mate_id
          AND conversation.user_id = task.user_id
          AND conversation.runtime_mode = task.runtime_mode
          AND conversation.id = task.conversation_id
        WHERE task.mate_id = ? AND task.user_id = ? AND task.runtime_mode = ? AND task.conversation_id = ?
        ORDER BY task.created_at DESC LIMIT 100
      `).bind(mateId, principal.userId, mode, conversationId)
    : db.prepare(`
        SELECT task.*, conversation.title AS conversation_title
        FROM mate_tasks AS task
        LEFT JOIN mate_conversations AS conversation
          ON conversation.mate_id = task.mate_id
          AND conversation.user_id = task.user_id
          AND conversation.runtime_mode = task.runtime_mode
          AND conversation.id = task.conversation_id
        WHERE task.mate_id = ? AND task.user_id = ? AND task.runtime_mode = ?
        ORDER BY task.created_at DESC LIMIT 100
      `).bind(mateId, principal.userId, mode);
  const rows = await statement.all<TaskRow>();
  return (rows.results ?? []).map(taskFromRow);
}

export async function createTask(
  db: D1Database,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  input: Record<string, unknown>,
  options: { allowInternalSchedule?: boolean; internalToolTask?: boolean; idempotencyId?: string } = {}
) {
  rejectCallerIdentityFields(input);
  if (options.idempotencyId) {
    const existing = await db.prepare("SELECT id FROM mate_tasks WHERE mate_id=? AND user_id=? AND runtime_mode=? AND id=?").bind(definition.mate.id,principal.userId,mode,options.idempotencyId).first();
    if (existing) return readTask(db,definition.mate.id,principal,mode,options.idempotencyId);
  }
  const instruction = text(input.instruction).trim().slice(0, 12_000);
  if (!instruction) throw new RuntimeHttpError(400, "task_instruction_required");
  const channel = normalizeChannel(input.channel, principal);
  assertChannelEnabled(definition.release.manifest as WorkspaceAgentRuntimeManifest, channel, options);
  const context = await normalizeHostContext(input.context, channel, mode) as Record<string, unknown>;
  const selectedModel = isRecord(context.capabilitySelection) ? text(context.capabilitySelection.modelId) : "";
  if (selectedModel) {
    const policy = definition.release.manifest.modelPolicy;
    if (![policy.defaultModel, ...(policy.allowedModels ?? [])].includes(selectedModel)) {
      throw new RuntimeHttpError(422, "mate_model_not_allowed", { modelId: selectedModel });
    }
  }
  let conversationId = identifier(input.conversationId);
  const conversationChannel = channel === "web" || channel === "sdk";
  if (mode === "preview" && conversationId) throw new RuntimeHttpError(409, "preview_conversation_not_supported");
  if (mode === "live" && conversationChannel && !conversationId) {
    const conversation = await createConversation(db, definition.mate.id, principal, mode, {
      channel,
      title: instruction.slice(0, 80)
    });
    conversationId = String(conversation.id);
  } else if (conversationId) {
    await readConversation(db, definition.mate.id, principal.userId, mode, conversationId);
  }

  const id = options.idempotencyId || `task_${randomId()}`;
  const sessionId = `session_${randomId()}`;
  const parentTaskId = identifier(input.parentTaskId);
  let rootTaskId = id;
  if (parentTaskId) {
    const parent = await readTaskRow(db, definition.mate.id, principal.userId, mode, parentTaskId);
    rootTaskId = parent.root_task_id;
    assertMateCallLimits(definition.release.manifest as WorkspaceAgentRuntimeManifest, parent, input);
  }
  const inboxChannel = ["email", "mate_call", "schedule"].includes(channel) && !options.internalToolTask;
  const scope = { mateId: definition.mate.id, userId: principal.userId, mode };
  const parentThread = parentTaskId ? (await readTaskRow(db, scope.mateId,scope.userId,mode,parentTaskId)).thread_id : undefined;
  const requestedThread = text(input.threadId).trim() || text(input.mateCallId).trim();
  if ((Object.hasOwn(input,"threadId") || Object.hasOwn(input,"mateCallId")) && !requestedThread) throw new RuntimeHttpError(400,"thread_id_invalid");
  if (input.threadId && input.mateCallId) {
    const a = await readWorkThread(db,scope,String(input.threadId));
    const b = await readWorkThread(db,scope,String(input.mateCallId));
    if (a.id !== b.id) throw new RuntimeHttpError(409,"thread_identifier_mismatch");
  }
  if (!inboxChannel && requestedThread) throw new RuntimeHttpError(400,"thread_channel_invalid");
  const thread = inboxChannel ? await ensureWorkThread(db,scope,{
    identifier: requestedThread || parentThread || undefined,
    title: text(input.title) || text(context.subject) || instruction,
    ...(channel === "schedule" && options.allowInternalSchedule ? {scheduleId:text(context.reminderId) || undefined} : {}),
    ...(channel === "email" || channel === "schedule" && options.allowInternalSchedule ? {threadCode:text(context.threadCode) || undefined} : {})
  }) : undefined;
  if (thread && parentThread && parentThread !== thread.id) throw new RuntimeHttpError(409,"parent_task_thread_mismatch");
  if (thread) { context.threadId = thread.id; context.threadCode = thread.threadCode; context.mateCallId = thread.mateCallId; }
  const sessionKind = mode === "preview" ? "owner_test" : conversationId ? "conversation_turn" : "task_ingress";
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`
      INSERT INTO mate_sessions (
        mate_id, user_id, runtime_mode, id, kind, channel, conversation_id,
        release_id, context_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `).bind(
      definition.mate.id,
      principal.userId,
      mode,
      sessionId,
      sessionKind,
      channel,
      conversationId || null,
      definition.release.id,
      JSON.stringify(context),
      now
    ),
    db.prepare(`
      INSERT INTO mate_tasks (
        mate_id, user_id, runtime_mode, id, session_id, conversation_id, parent_task_id, root_task_id,
        release_id, channel, status, instruction, context_json, created_at, updated_at, thread_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
    `).bind(
      definition.mate.id,
      principal.userId,
      mode,
      id,
      sessionId,
      conversationId || null,
      parentTaskId || null,
      rootTaskId,
      definition.release.id,
      channel,
      instruction,
      JSON.stringify(context),
      now,
      now,
      thread?.id || null
    ),
    db.prepare(`
      INSERT INTO mate_task_events (mate_id, user_id, runtime_mode, task_id, run_id, sequence, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, NULL, 1, 'mate.task.created', ?, ?)
    `).bind(definition.mate.id, principal.userId, mode, id, JSON.stringify({ channel, mode, releaseId: definition.release.id, sessionId }), now),
    ...(conversationId ? [
      db.prepare(`
        UPDATE mate_conversations SET updated_at = ?
        WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ?
      `).bind(now, definition.mate.id, principal.userId, mode, conversationId)
    ] : [])
  ]);
  if (thread) {
    await db.prepare(`UPDATE mate_work_threads SET updated_at=? WHERE id=?`).bind(now,thread.id).run();
    if (mode === "live" && !thread.threadCode.startsWith("LEGACY-")) await attachEmailThreadTask(db,scope.mateId,scope.userId,thread.threadCode,id);
  }
  return taskFromRow(await readTaskRow(db, definition.mate.id, principal.userId, mode, id));
}

export async function readTask(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  taskId: string
) {
  return taskFromRow(await readTaskRow(db, mateId, principal.userId, mode, taskId));
}

export async function listTaskRuns(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  taskId: string
) {
  await readTaskRow(db, mateId, principal.userId, mode, taskId);
  const rows = await db.prepare(`
    SELECT id, task_id AS taskId, attempt, status, release_id AS releaseId,
           started_at AS startedAt, completed_at AS completedAt, error_code AS errorCode
    FROM mate_task_runs
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND task_id = ?
    ORDER BY attempt DESC
  `).bind(mateId, principal.userId, mode, taskId).all();
  return rows.results ?? [];
}

export async function startTask(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  taskId: string,
  expectedReleaseId: string
) {
  const row = await readTaskRow(db, mateId, principal.userId, mode, taskId);
  if (row.status !== "queued") throw new RuntimeHttpError(409, "task_not_queued");
  if (row.release_id !== expectedReleaseId) {
    throw new RuntimeHttpError(409, "task_release_changed", {
      expectedReleaseId: row.release_id
    });
  }
  if (row.thread_id) {
    await db.prepare(`UPDATE mate_work_threads SET active_task_id=? WHERE id=? AND (active_task_id IS NULL OR active_task_id=?)
      AND NOT EXISTS(SELECT 1 FROM mate_tasks WHERE thread_id=? AND status IN ('queued','running') AND rowid<(SELECT rowid FROM mate_tasks WHERE id=? AND mate_id=? AND user_id=? AND runtime_mode=?))`)
      .bind(taskId,row.thread_id,taskId,row.thread_id,taskId,mateId,principal.userId,mode).run();
    const lock=await readWorkThread(db,{mateId,userId:principal.userId,mode},row.thread_id);
    if(lock.activeTaskId!==taskId) throw new RuntimeHttpError(409,"thread_busy");
  }
  const now = new Date().toISOString();
  const sequence = await nextEventSequence(db, mateId, principal.userId, mode, taskId);
  const attempt = Number(row.attempt_count || 0) + 1;
  const runId = `run_${randomId()}`;
  await db.batch([
    db.prepare(`
      INSERT INTO mate_task_runs (
        mate_id, user_id, runtime_mode, task_id, id, attempt, status, release_id, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).bind(mateId, principal.userId, mode, taskId, runId, attempt, row.release_id, now),
    db.prepare(`
      UPDATE mate_tasks SET status = 'running', active_run_id = ?, attempt_count = ?, updated_at = ?
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ? AND status = 'queued'
    `).bind(runId, attempt, now, mateId, principal.userId, mode, taskId),
    db.prepare(`
      INSERT INTO mate_task_events (mate_id, user_id, runtime_mode, task_id, run_id, sequence, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'mate.task.started', ?, ?)
    `).bind(mateId, principal.userId, mode, taskId, runId, sequence, JSON.stringify({ attempt }), now)
  ]);
  return {
    run: { id: runId, taskId, attempt, status: "running", releaseId: row.release_id, startedAt: now },
    task: await readTask(db, mateId, principal, mode, taskId)
  };
}

export async function concludeTask(
  db: D1Database,
  mateId: string,
  userId: string,
  mode: RuntimeMode,
  taskId: string,
  input: Record<string, unknown>
) {
  const row = await readTaskRow(db, mateId, userId, mode, taskId);
  if (["completed", "failed", "cancelled"].includes(row.status)) throw new RuntimeHttpError(409, "task_already_concluded");
  const outcome = text(input.outcome);
  const summary = text(input.summary).trim().slice(0, 8000);
  if (!summary || !["completed", "failed", "cancelled"].includes(outcome)) throw new RuntimeHttpError(400, "task_conclusion_invalid");
  const conclusion = {
    outcome,
    summary,
    actions: Array.isArray(input.actions) ? input.actions.slice(0, 50) : [],
    artifacts: Array.isArray(input.artifacts) ? input.artifacts.slice(0, 50) : [],
    failures: Array.isArray(input.failures) ? input.failures.slice(0, 50) : [],
    followUps: Array.isArray(input.followUps) ? input.followUps.slice(0, 50) : [],
    pendingApprovals: Array.isArray(input.pendingApprovals) ? input.pendingApprovals.slice(0, 50) : []
  };
  const now = new Date().toISOString();
  const sequence = await nextEventSequence(db, mateId, userId, mode, taskId);
  const errorCode = outcome === "failed" ? text(input.errorCode).slice(0, 160) || "task_failed" : null;
  await db.batch([
    db.prepare(`
      UPDATE mate_tasks SET status = ?, conclusion_json = ?, updated_at = ?, completed_at = ?
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ?
    `).bind(outcome, JSON.stringify(conclusion), now, now, mateId, userId, mode, taskId),
    ...(row.active_run_id ? [
      db.prepare(`
        UPDATE mate_task_runs SET status = ?, completed_at = ?, error_code = ?
        WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND task_id = ? AND id = ?
      `).bind(outcome, now, errorCode, mateId, userId, mode, taskId, row.active_run_id)
    ] : []),
    db.prepare(`
      UPDATE mate_sessions SET status = 'closed', closed_at = ?
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ?
    `).bind(now, mateId, userId, mode, row.session_id),
    db.prepare(`
      INSERT INTO mate_task_events (mate_id, user_id, runtime_mode, task_id, run_id, sequence, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'mate.task.concluded', ?, ?)
    `).bind(mateId, userId, mode, taskId, row.active_run_id || null, sequence, JSON.stringify(conclusion), now)
  ]);
  if (row.thread_id) await db.prepare(`UPDATE mate_work_threads SET active_task_id=CASE WHEN active_task_id=? THEN NULL ELSE active_task_id END,updated_at=? WHERE id=?`).bind(taskId,now,row.thread_id).run();
  return readTask(db, mateId, { callerKind: "user", orgId: "", scopes: [], userId }, mode, taskId);
}

export async function readPreferences(db: D1Database, mateId: string, principal: RuntimePrincipal) {
  const row = await db.prepare(`
    SELECT schema_version AS schemaVersion, data_json AS dataJson, etag, created_at AS createdAt, updated_at AS updatedAt
    FROM mate_preferences WHERE mate_id = ? AND user_id = ? LIMIT 1
  `).bind(mateId, principal.userId).first<{ createdAt: string; dataJson: string; etag: string; schemaVersion: number; updatedAt: string }>();
  return row ? { ...row, data: parseJson(row.dataJson), dataJson: undefined } : undefined;
}

export async function savePreferences(
  db: D1Database,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  input: Record<string, unknown>
) {
  rejectCallerIdentityFields(input);
  const manifest = definition.release.manifest as WorkspaceAgentRuntimeManifest;
  const preferenceSchema = manifest.preferenceSchema as { fields?: Array<{ allowedValues?: string[]; key: string; sensitive: boolean; type: string }>; version?: number };
  const data = isRecord(input.data) ? input.data : {};
  const fields = new Map((preferenceSchema.fields ?? []).map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(data)) {
    const field = fields.get(key);
    if (!field || field.sensitive || !preferenceValueMatches(field, value)) throw new RuntimeHttpError(422, "preference_value_invalid", { field: key });
  }
  const now = new Date().toISOString();
  const etag = await sha256Hex(JSON.stringify(data));
  await db.prepare(`
    INSERT INTO mate_preferences (mate_id, user_id, schema_version, data_json, etag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mate_id,user_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      data_json = excluded.data_json,
      etag = excluded.etag,
      updated_at = excluded.updated_at
  `).bind(definition.mate.id, principal.userId, Number(preferenceSchema.version) || 1, JSON.stringify(data), etag, now, now).run();
  return readPreferences(db, definition.mate.id, principal);
}

export async function listApprovals(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode
) {
  const rows = await db.prepare(`
    SELECT a.id, a.task_id AS taskId, a.run_id AS runId, a.status, a.risk_level AS riskLevel,
           a.action_digest AS actionDigest, a.release_id AS releaseId, a.manifest_sha256 AS manifestSha256,
           a.tool_definition_version AS toolDefinitionVersion, a.policy_version AS policyVersion,
           a.operation_json AS operationJson, a.requested_at AS requestedAt, a.decided_at AS decidedAt,
           a.consumed_at AS consumedAt, a.expires_at AS expiresAt,
           t.conversation_id AS conversationId, t.status AS taskStatus, t.conclusion_json AS taskConclusionJson
    FROM mate_approvals a
    LEFT JOIN mate_tasks t ON t.mate_id = a.mate_id AND t.user_id = a.user_id
      AND t.runtime_mode = a.runtime_mode AND t.id = a.task_id
    WHERE a.mate_id = ? AND a.user_id = ? AND a.runtime_mode = ?
    ORDER BY a.requested_at DESC LIMIT 100
  `).bind(mateId, principal.userId, mode).all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    ...approvalFromRow(row),
    // Join the matching task directly: it may be older than the recent-task
    // listing window, but its approval must still retain the execution result.
    task: row.taskStatus ? {
      id: String(row.taskId), status: String(row.taskStatus),
      conclusion: row.taskConclusionJson ? recordFromUnknown(parseJson(String(row.taskConclusionJson))) : undefined
    } : undefined
  }));
}

export async function createApproval(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  taskId: string,
  input: {
    actionDigest: string;
    expiresAt: string;
    manifestSha256: string;
    operation: Record<string, unknown>;
    policyVersion?: string;
    releaseId: string;
    riskLevel: "low" | "medium" | "high" | "critical";
    toolDefinitionVersion: string;
  }
) {
  const task = await readTaskRow(db, mateId, principal.userId, mode, taskId);
  if (task.status !== "running" || !task.active_run_id) throw new RuntimeHttpError(409, "task_not_running");
  const id = `approval_${randomId()}`;
  const now = new Date().toISOString();
  const sequence = await nextEventSequence(db, mateId, principal.userId, mode, taskId);
  await db.batch([
    db.prepare(`
      INSERT INTO mate_approvals (
        mate_id, user_id, runtime_mode, id, task_id, run_id, status, risk_level,
        action_digest, release_id, manifest_sha256, tool_definition_version, policy_version,
        operation_json, requested_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      mateId, principal.userId, mode, id, taskId, task.active_run_id, input.riskLevel,
      input.actionDigest, input.releaseId, input.manifestSha256, input.toolDefinitionVersion,
      input.policyVersion || null, JSON.stringify(input.operation), now, input.expiresAt
    ),
    db.prepare(`
      UPDATE mate_tasks SET status = 'waiting_for_approval', updated_at = ?
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ? AND status = 'running'
    `).bind(now, mateId, principal.userId, mode, taskId),
    db.prepare(`
      UPDATE mate_task_runs SET status = 'waiting_for_approval'
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND task_id = ? AND id = ? AND status = 'running'
    `).bind(mateId, principal.userId, mode, taskId, task.active_run_id),
    db.prepare(`
      INSERT INTO mate_task_events (mate_id, user_id, runtime_mode, task_id, run_id, sequence, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'mate.task.approval_requested', ?, ?)
    `).bind(mateId, principal.userId, mode, taskId, task.active_run_id, sequence, JSON.stringify({
      actionDigest: input.actionDigest,
      approvalId: id,
      expiresAt: input.expiresAt,
      riskLevel: input.riskLevel
    }), now)
  ]);
  return readApproval(db, mateId, principal, mode, id);
}

export async function readApproval(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  approvalId: string
) {
  const row = await db.prepare(`
    SELECT id, task_id AS taskId, run_id AS runId, status, risk_level AS riskLevel,
           action_digest AS actionDigest, release_id AS releaseId, manifest_sha256 AS manifestSha256,
           tool_definition_version AS toolDefinitionVersion, policy_version AS policyVersion,
           operation_json AS operationJson, requested_at AS requestedAt, decided_at AS decidedAt,
           consumed_at AS consumedAt, expires_at AS expiresAt
    FROM mate_approvals
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ? LIMIT 1
  `).bind(mateId, principal.userId, mode, approvalId).first<Record<string, unknown>>();
  if (!row) throw new RuntimeHttpError(404, "approval_not_found");
  return approvalFromRow(row);
}

export async function decideApproval(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  approvalId: string,
  decision: unknown
) {
  const status = decision === "approve" ? "approved" : decision === "deny" ? "denied" : "";
  if (!status) throw new RuntimeHttpError(400, "approval_decision_invalid");
  const existing = await readApproval(db, mateId, principal, mode, approvalId);
  if (existing.status !== "pending") throw new RuntimeHttpError(409, "approval_not_pending");
  if (Date.parse(String(existing.expiresAt)) <= Date.now()) {
    await db.prepare(`
      UPDATE mate_approvals SET status = 'expired'
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ? AND status = 'pending'
    `).bind(mateId, principal.userId, mode, approvalId).run();
    try {
      await concludeTask(db, mateId, principal.userId, mode, existing.taskId, {
        actions: [], artifacts: [], errorCode: "approval_expired",
        failures: [{ approvalId, code: "approval_expired" }], followUps: [],
        outcome: "failed", pendingApprovals: [], summary: "审批已过期，未执行 App 操作。"
      });
    } catch { /* A terminal Task needs no second conclusion. */ }
    throw new RuntimeHttpError(409, "approval_expired");
  }
  const now = new Date().toISOString();
  const decisionToken = `decision_${randomId()}`;
  await db.prepare(`
    UPDATE mate_approvals SET status = ?, decided_at = ?, decision_token = ?
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ? AND status = 'pending'
  `).bind(status, now, decisionToken, mateId, principal.userId, mode, approvalId).run();
  const claimed = await db.prepare(`
    SELECT decision_token FROM mate_approvals
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ? LIMIT 1
  `).bind(mateId, principal.userId, mode, approvalId).first<{ decision_token?: string }>();
  if (claimed?.decision_token !== decisionToken) throw new RuntimeHttpError(409, "approval_not_pending");
  const sequence = await nextEventSequence(db, mateId, principal.userId, mode, existing.taskId);
  await db.prepare(`
    INSERT INTO mate_task_events (mate_id, user_id, runtime_mode, task_id, run_id, sequence, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    mateId, principal.userId, mode, existing.taskId, existing.runId || null, sequence,
    status === "approved" ? "mate.task.approved" : "mate.task.rejected",
    JSON.stringify({ approvalId, decision }), now
  ).run();
  return readApproval(db, mateId, principal, mode, approvalId);
}

export async function consumeApproval(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  approvalId: string
) {
  const existing = await readApproval(db, mateId, principal, mode, approvalId);
  if (existing.status !== "approved") throw new RuntimeHttpError(409, "approval_not_approved");
  if (Date.parse(String(existing.expiresAt)) <= Date.now()) throw new RuntimeHttpError(409, "approval_expired");
  const token = `consume_${randomId()}`;
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE mate_approvals SET status = 'consumed', consumed_at = ?, consumption_token = ?
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ? AND status = 'approved'
  `).bind(now, token, mateId, principal.userId, mode, approvalId).run();
  const claimed = await db.prepare(`
    SELECT consumption_token FROM mate_approvals
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ? LIMIT 1
  `).bind(mateId, principal.userId, mode, approvalId).first<{ consumption_token?: string }>();
  if (claimed?.consumption_token !== token) throw new RuntimeHttpError(409, "approval_already_consumed");
  return readApproval(db, mateId, principal, mode, approvalId);
}

export async function resumeTaskAfterApproval(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  taskId: string,
  approvalId: string
) {
  const task = await readTaskRow(db, mateId, principal.userId, mode, taskId);
  if (task.status !== "waiting_for_approval" || !task.active_run_id) throw new RuntimeHttpError(409, "task_not_waiting_for_approval");
  const now = new Date().toISOString();
  const sequence = await nextEventSequence(db, mateId, principal.userId, mode, taskId);
  await db.batch([
    db.prepare(`
      UPDATE mate_tasks SET status = 'running', updated_at = ?
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ? AND status = 'waiting_for_approval'
    `).bind(now, mateId, principal.userId, mode, taskId),
    db.prepare(`
      UPDATE mate_task_runs SET status = 'running'
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND task_id = ? AND id = ? AND status = 'waiting_for_approval'
    `).bind(mateId, principal.userId, mode, taskId, task.active_run_id),
    db.prepare(`
      INSERT INTO mate_task_events (mate_id, user_id, runtime_mode, task_id, run_id, sequence, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'mate.task.resumed', ?, ?)
    `).bind(mateId, principal.userId, mode, taskId, task.active_run_id, sequence, JSON.stringify({ approvalId }), now)
  ]);
  return readTask(db, mateId, principal, mode, taskId);
}

export async function startToolAudit(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  input: {
    actionDigest: string;
    appId: string;
    approvalId?: string;
    releaseId: string;
    taskId: string;
    toolName: string;
  }
) {
  const task = await readTaskRow(db, mateId, principal.userId, mode, input.taskId);
  if (!task.active_run_id) throw new RuntimeHttpError(409, "task_run_missing");
  const id = `toolaudit_${randomId()}`;
  const now = new Date().toISOString();
  const sequence = await nextEventSequence(db, mateId, principal.userId, mode, input.taskId);
  await db.batch([
    db.prepare(`
      INSERT INTO mate_tool_audit (
        mate_id, user_id, runtime_mode, id, task_id, run_id, approval_id, release_id,
        app_id, tool_name, action_digest, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?)
    `).bind(
      mateId, principal.userId, mode, id, input.taskId, task.active_run_id,
      input.approvalId || null, input.releaseId, input.appId, input.toolName, input.actionDigest, now
    ),
    db.prepare(`
      INSERT INTO mate_task_events (mate_id, user_id, runtime_mode, task_id, run_id, sequence, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'mate.task.tool_started', ?, ?)
    `).bind(mateId, principal.userId, mode, input.taskId, task.active_run_id, sequence, JSON.stringify({
      actionDigest: input.actionDigest, appId: input.appId, approvalId: input.approvalId,
      auditId: id, toolName: input.toolName
    }), now)
  ]);
  return { id, runId: task.active_run_id };
}

export async function completeToolAudit(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  auditId: string,
  input: { errorCode?: string; resultDigest?: string; status: "succeeded" | "failed" }
) {
  const audit = await db.prepare(`
    SELECT task_id AS taskId, run_id AS runId, app_id AS appId, tool_name AS toolName, action_digest AS actionDigest
    FROM mate_tool_audit
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ? AND status = 'started' LIMIT 1
  `).bind(mateId, principal.userId, mode, auditId).first<Record<string, unknown>>();
  if (!audit) throw new RuntimeHttpError(404, "tool_audit_not_found");
  const now = new Date().toISOString();
  const taskId = String(audit.taskId || "");
  const sequence = await nextEventSequence(db, mateId, principal.userId, mode, taskId);
  await db.batch([
    db.prepare(`
      UPDATE mate_tool_audit
      SET status = ?, result_digest = ?, error_code = ?, completed_at = ?
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ? AND status = 'started'
    `).bind(input.status, input.resultDigest || null, input.errorCode || null, now, mateId, principal.userId, mode, auditId),
    db.prepare(`
      INSERT INTO mate_task_events (mate_id, user_id, runtime_mode, task_id, run_id, sequence, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      mateId, principal.userId, mode, taskId, audit.runId || null, sequence,
      input.status === "succeeded" ? "mate.task.tool_completed" : "mate.task.tool_failed",
      JSON.stringify({ actionDigest: audit.actionDigest, appId: audit.appId, auditId, errorCode: input.errorCode, resultDigest: input.resultDigest, toolName: audit.toolName }), now
    )
  ]);
}

export function runtimeIsolationKey(mateId: string, userId: string, mode: RuntimeMode, resourceId: string) {
  return `${encodeURIComponent(mateId)}:${encodeURIComponent(userId)}:${mode}:${encodeURIComponent(resourceId)}`;
}

export async function readConversation(db: D1Database, mateId: string, userId: string, mode: RuntimeMode, conversationId: string) {
  const row = await db.prepare(`
    SELECT id, title, channel, status, pinned_at AS pinnedAt,
           created_at AS createdAt, updated_at AS updatedAt
    FROM mate_conversations
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ? LIMIT 1
  `).bind(mateId, userId, mode, conversationId).first();
  if (!row) throw new RuntimeHttpError(404, "conversation_not_found");
  return row;
}

type TaskRow = {
  active_run_id?: string; attempt_count: number; channel: string; completed_at?: string; conclusion_json?: string;
  context_json: string; conversation_id?: string; created_at: string; id: string; instruction: string;
  conversation_title?: string; thread_id?: string;
  parent_task_id?: string; release_id: string; root_task_id: string; runtime_mode: RuntimeMode; session_id: string;
  status: string; mate_id: string; updated_at: string; user_id: string;
};

async function readTaskRow(db: D1Database, mateId: string, userId: string, mode: RuntimeMode, taskId: string) {
  const row = await db.prepare(`
    SELECT * FROM mate_tasks
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ? LIMIT 1
  `).bind(mateId, userId, mode, taskId).first<TaskRow>();
  if (!row) throw new RuntimeHttpError(404, "task_not_found");
  return row;
}

export function taskFromRow(row: TaskRow) {
  const title = taskTitle(row);
  return {
    id: row.id,
    mateId: row.mate_id,
    mode: row.runtime_mode,
    sessionId: row.session_id,
    conversationId: row.conversation_id || undefined,
    threadId: row.thread_id || undefined,
    threadCode: recordFromUnknown(parseJson(row.context_json)).threadCode,
    mateCallId: recordFromUnknown(parseJson(row.context_json)).mateCallId,
    parentTaskId: row.parent_task_id || undefined,
    rootTaskId: row.root_task_id,
    releaseId: row.release_id,
    activeRunId: row.active_run_id || undefined,
    attemptCount: Number(row.attempt_count || 0),
    channel: row.channel,
    status: row.status,
    title,
    instruction: row.instruction,
    context: parseJson(row.context_json),
    conclusion: row.conclusion_json ? parseJson(row.conclusion_json) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || undefined
  };
}

function taskTitle(row: TaskRow) {
  const conversationTitle = String(row.conversation_title || "").replace(/\s+/g, " ").trim();
  if (conversationTitle) return conversationTitle.slice(0, 160);
  if (row.instruction.startsWith("agent-do-message:")) return "对话任务";
  return row.instruction.replace(/\s+/g, " ").trim().slice(0, 160) || "未命名任务";
}

function approvalFromRow(row: Record<string, unknown>): RuntimeApproval {
  return {
    actionDigest: String(row.actionDigest || ""),
    conversationId: row.conversationId ? String(row.conversationId) : undefined,
    consumedAt: row.consumedAt ? String(row.consumedAt) : undefined,
    decidedAt: row.decidedAt ? String(row.decidedAt) : undefined,
    expiresAt: String(row.expiresAt || ""),
    id: String(row.id || ""),
    manifestSha256: String(row.manifestSha256 || ""),
    operation: recordFromUnknown(parseJson(String(row.operationJson || "{}"))),
    policyVersion: row.policyVersion ? String(row.policyVersion) : undefined,
    releaseId: String(row.releaseId || ""),
    requestedAt: String(row.requestedAt || ""),
    riskLevel: String(row.riskLevel || "medium") as RuntimeApproval["riskLevel"],
    runId: row.runId ? String(row.runId) : undefined,
    status: String(row.status || "pending") as RuntimeApproval["status"],
    taskId: String(row.taskId || ""),
    toolDefinitionVersion: String(row.toolDefinitionVersion || "")
  };
}

async function nextEventSequence(db: D1Database, mateId: string, userId: string, mode: RuntimeMode, taskId: string) {
  const row = await db.prepare(`
    SELECT MAX(sequence) AS sequence FROM mate_task_events
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND task_id = ?
  `).bind(mateId, userId, mode, taskId).first<{ sequence?: number }>();
  return Number(row?.sequence || 0) + 1;
}

function assertChannelEnabled(
  manifest: WorkspaceAgentRuntimeManifest,
  channel: string,
  options: { allowInternalSchedule?: boolean } = {}
) {
  if (
    channel === "schedule"
    && options.allowInternalSchedule === true
    && manifest.experiencePolicy.taskInbox.enabled === true
  ) return;
  const channels = manifest.channels as Record<string, any>;
  const enabled = channel === "web" ? channels.standalone?.enabled
    : channel === "sdk" ? channels.embedded?.enabled
      : channel === "email" ? channels.inbox?.email?.enabled
        : channel === "schedule" ? channels.inbox?.schedule?.enabled
          : channels.inbox?.mateCall?.enabled;
  if (enabled !== true) throw new RuntimeHttpError(403, "mate_channel_disabled");
}

function assertMateCallLimits(manifest: WorkspaceAgentRuntimeManifest, _parent: TaskRow, input: Record<string, unknown>) {
  const limits = (manifest.taskPolicy as Record<string, any>).mateCallLimits ?? {};
  const depth = Number(input.depth || 1);
  if (depth > Number(limits.maxDepth || 3)) throw new RuntimeHttpError(409, "mate_call_depth_exceeded");
}

async function normalizeHostContext(value: unknown, channel: string, mode: RuntimeMode) {
  if (isRecord(value) && value.schemaVersion === WORKSPACE_MATE_ENVIRONMENT_SCHEMA_VERSION) {
    if (channel !== "sdk" && mode !== "preview") {
      throw new RuntimeHttpError(422, "mate_environment_channel_invalid");
    }
    try { return await acceptWorkspaceMateEnvironment(value); }
    catch (error) {
      throw new RuntimeHttpError(422, error instanceof Error ? error.message : "mate_environment_invalid");
    }
  }
  if (channel === "sdk") {
    try { return normalizeWorkspaceMateHostContext(value); }
    catch (error) {
      throw new RuntimeHttpError(422, error instanceof Error ? error.message : "mate_host_context_invalid");
    }
  }
  if (!isRecord(value)) return {};
  const allowed = ["route", "recordType", "recordId", "selection", "locale", "timezone", "threadCode", "messageIdDigest", "subject", "reminderId", "scheduledFor"];
  const context = Object.fromEntries(Object.entries(value).filter(([key]) => allowed.includes(key)).map(([key, child]) => [key, sanitizeContextValue(child)]));
  const capabilitySelection = isRecord(value.capabilitySelection) ? value.capabilitySelection : undefined;
  if (capabilitySelection) {
    const modelId = text(capabilitySelection.modelId).trim();
    if (modelId && (modelId.length > 180 || /[\u0000-\u001f\u007f]/.test(modelId))) {
      throw new RuntimeHttpError(422, "mate_model_not_allowed");
    }
    context.capabilitySelection = {
      appIds: capabilityIdList(capabilitySelection.appIds),
      knowledgeServiceIds: capabilityIdList(capabilitySelection.knowledgeServiceIds),
      ...(modelId ? { modelId } : {})
    };
  }
  return context;
}

function capabilityIdList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((item) => {
    const id = text(item).trim();
    return id && id.length <= 180 && !/[\u0000-\u001f\u007f]/.test(id) ? [id] : [];
  }))).slice(0, 64);
}

function sanitizeContextValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 2000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(sanitizeContextValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, child]) => [key.slice(0, 64), sanitizeContextValue(child)]));
  return undefined;
}

function rejectCallerIdentityFields(input: Record<string, unknown>) {
  for (const key of Object.keys(input)) if (/^(userId|ownerUserId|orgId)$/i.test(key)) throw new RuntimeHttpError(400, "caller_identity_is_server_derived");
}

function normalizeChannel(value: unknown, principal: RuntimePrincipal) {
  const channel = text(value) || (principal.callerKind === "email_binding" ? "email" : principal.callerKind === "mate" ? "mate_call" : "web");
  if (!CHANNELS.has(channel)) throw new RuntimeHttpError(400, "task_channel_invalid");
  if (principal.callerKind === "email_binding" && channel !== "email") throw new RuntimeHttpError(403, "caller_channel_mismatch");
  if (principal.callerKind === "mate" && channel !== "mate_call" && channel !== "schedule") throw new RuntimeHttpError(403, "caller_channel_mismatch");
  return channel;
}

function preferenceValueMatches(field: { allowedValues?: string[]; type: string }, value: unknown) {
  if (field.type === "string") return typeof value === "string";
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (field.type === "string_list") return Array.isArray(value) && value.every((item) => typeof item === "string");
  if (field.type === "enum") return typeof value === "string" && (field.allowedValues ?? []).includes(value);
  return false;
}

function identifier(value: unknown) { const result = text(value); return /^[A-Za-z0-9_-]{8,128}$/.test(result) ? result : ""; }
function randomId() { return crypto.randomUUID().replaceAll("-", ""); }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function recordFromUnknown(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function parseJson(value: string) { try { return JSON.parse(value) as unknown; } catch { return {}; } }
async function sha256Hex(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
