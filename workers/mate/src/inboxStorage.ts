import { RuntimeHttpError, type RuntimePrincipal } from "./types.ts";

const THREAD_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SCHEDULE_CLAIM_TIMEOUT_MS = 35 * 60 * 1000;

export type RuntimeTodo = {
  createdAt: string;
  details: string;
  dueAt?: string;
  id: string;
  priority: "low" | "normal" | "high" | "urgent";
  sourceTaskId?: string;
  status: "open" | "in_progress" | "completed" | "cancelled";
  title: string;
  updatedAt: string;
};

export type RuntimeReminder = {
  id: string;
  instruction: string;
  intervalSeconds?: number;
  lastFiredAt?: string;
  lastTaskId?: string;
  managedJobId?: string;
  managedReleaseId?: string;
  nextDueAt: string;
  scheduleKind: "once" | "interval";
  sourceTaskId?: string;
  status: "active" | "paused" | "completed" | "cancelled";
  threadCode?: string;
  timezone: string;
  title: string;
};

export async function listTodos(db: D1Database, mateId: string, principal: RuntimePrincipal) {
  const rows = await db.prepare(`
    SELECT id, source_task_id AS sourceTaskId, title, details, priority, status,
           due_at AS dueAt, created_at AS createdAt, updated_at AS updatedAt
    FROM mate_todos
    WHERE mate_id = ? AND user_id = ?
    ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
             CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             COALESCE(due_at, '9999-12-31T23:59:59.999Z'), updated_at DESC
    LIMIT 200
  `).bind(mateId, principal.userId).all<Record<string, unknown>>();
  return (rows.results ?? []).map(todoFromRow);
}

export async function createTodo(
  db: D1Database,
  mateId: string,
  userId: string,
  input: Record<string, unknown>
) {
  const title = requiredText(input.title, "todo_title_required", 240);
  const details = text(input.details).trim().slice(0, 4000);
  const priority = todoPriority(input.priority);
  const dueAt = optionalFutureOrPastTimestamp(input.dueAt);
  const sourceTaskId = identifier(input.sourceTaskId) || undefined;
  const id = `todo_${randomId()}`;
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO mate_todos (
      mate_id, user_id, id, source_task_id, title, details, priority, status,
      due_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
  `).bind(mateId, userId, id, sourceTaskId || null, title, details, priority, dueAt || null, now, now).run();
  return readTodo(db, mateId, userId, id);
}

export async function updateTodo(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  todoId: string,
  input: Record<string, unknown>
) {
  const existing = await readTodo(db, mateId, principal.userId, todoId);
  const status = input.status === undefined ? existing.status : todoStatus(input.status);
  const title = input.title === undefined ? existing.title : requiredText(input.title, "todo_title_required", 240);
  const details = input.details === undefined ? existing.details : text(input.details).trim().slice(0, 4000);
  const priority = input.priority === undefined ? existing.priority : todoPriority(input.priority);
  const dueAt = input.dueAt === undefined ? existing.dueAt : optionalFutureOrPastTimestamp(input.dueAt);
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE mate_todos
    SET title = ?, details = ?, priority = ?, status = ?, due_at = ?, updated_at = ?,
        completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE NULL END
    WHERE mate_id = ? AND user_id = ? AND id = ?
  `).bind(title, details, priority, status, dueAt || null, now, status, now, mateId, principal.userId, todoId).run();
  return readTodo(db, mateId, principal.userId, todoId);
}

export async function createTodosFromTask(
  db: D1Database,
  mateId: string,
  userId: string,
  taskId: string,
  values: unknown
) {
  if (!Array.isArray(values)) return [];
  const todos: RuntimeTodo[] = [];
  for (const value of values.slice(0, 20)) {
    if (!isRecord(value) || !text(value.title).trim()) continue;
    todos.push(await createTodo(db, mateId, userId, { ...value, sourceTaskId: taskId }));
  }
  return todos;
}

export async function listReminderPage(db:D1Database,mateId:string,principal:RuntimePrincipal,cursor?:string|null) {
  if(cursor && (cursor.length>180 || !/^[A-Za-z0-9_-]+$/.test(cursor))) throw new RuntimeHttpError(400,"reminder_cursor_invalid");
  const result=await db.prepare(`SELECT id,source_task_id AS sourceTaskId,title,instruction,schedule_kind AS scheduleKind,next_due_at AS nextDueAt,interval_seconds AS intervalSeconds,timezone,status,thread_code AS threadCode,last_task_id AS lastTaskId,last_fired_at AS lastFiredAt,managed_job_id AS managedJobId,managed_release_id AS managedReleaseId
    FROM mate_reminders WHERE mate_id=? AND user_id=? ${cursor ? "AND id>?" : ""} ORDER BY id ASC LIMIT 51`)
    .bind(mateId,principal.userId,...(cursor ? [cursor] : [])).all<RuntimeReminder>();
  const reminders=(result.results || []).slice(0,50);
  return {reminders,nextCursor:(result.results?.length || 0)>50 ? reminders.at(-1)!.id : null};
}

export async function listReminders(db: D1Database, mateId: string, principal: RuntimePrincipal) {
  const rows = await db.prepare(`
    SELECT id, source_task_id AS sourceTaskId, title, instruction,
           schedule_kind AS scheduleKind, next_due_at AS nextDueAt,
           interval_seconds AS intervalSeconds, timezone, status,
           thread_code AS threadCode, last_task_id AS lastTaskId, last_fired_at AS lastFiredAt,
           managed_release_id AS managedReleaseId, managed_job_id AS managedJobId
    FROM mate_reminders
    WHERE mate_id = ? AND user_id = ?
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, next_due_at, id
    LIMIT 200
  `).bind(mateId, principal.userId).all<Record<string, unknown>>();
  return (rows.results ?? []).map(reminderFromRow);
}

export async function createReminder(
  db: D1Database,
  mateId: string,
  userId: string,
  input: Record<string, unknown>
) {
  const title = requiredText(input.title, "reminder_title_required", 240);
  const instruction = requiredText(input.instruction || input.title, "reminder_instruction_required", 12_000);
  const nextDueAt = requiredTimestamp(input.nextDueAt, "reminder_due_at_required");
  const scheduleKind = input.scheduleKind === "interval" ? "interval" : "once";
  const intervalSeconds = scheduleKind === "interval" ? boundedInteger(input.intervalSeconds, 300, 31_536_000) : undefined;
  const timezone = text(input.timezone).trim().slice(0, 80) || "UTC";
  const sourceTaskId = identifier(input.sourceTaskId) || undefined;
  const threadCode = normalizeThreadCode(input.threadCode) || undefined;
  const id = identifier(input.reminderId) || `reminder_${randomId()}`;
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO mate_reminders (
      mate_id, user_id, id, source_task_id, title, instruction, schedule_kind,
      next_due_at, interval_seconds, timezone, status, thread_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).bind(
    mateId, userId, id, sourceTaskId || null, title, instruction, scheduleKind,
    nextDueAt, intervalSeconds || null, timezone, threadCode || null, now, now
  ).run();
  return readReminder(db, mateId, userId, id);
}

export async function updateReminder(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  reminderId: string,
  input: Record<string, unknown>
) {
  const existing = await readReminder(db, mateId, principal.userId, reminderId);
  if (existing.managedJobId) throw new RuntimeHttpError(409, "managed_reminder_release_controlled");
  const title = input.title === undefined ? existing.title : requiredText(input.title, "reminder_title_required", 240);
  const instruction = input.instruction === undefined
    ? existing.instruction
    : requiredText(input.instruction, "reminder_instruction_required", 12_000);
  const nextDueAt = input.nextDueAt === undefined
    ? existing.nextDueAt
    : requiredTimestamp(input.nextDueAt, "reminder_due_at_required");
  const scheduleKind = input.scheduleKind === undefined
    ? existing.scheduleKind
    : input.scheduleKind === "interval" ? "interval" : input.scheduleKind === "once" ? "once" : invalidReminderScheduleKind();
  const intervalSeconds = scheduleKind === "interval"
    ? input.intervalSeconds === undefined
      ? existing.scheduleKind === "interval" ? existing.intervalSeconds : undefined
      : boundedInteger(input.intervalSeconds, 300, 31_536_000)
    : undefined;
  if (scheduleKind === "interval" && !intervalSeconds) throw new RuntimeHttpError(422, "reminder_interval_invalid");
  const timezone = input.timezone === undefined
    ? existing.timezone
    : requiredText(input.timezone, "reminder_timezone_required", 80);
  const status = input.status === undefined ? existing.status : reminderStatus(input.status);
  await db.prepare(`
    UPDATE mate_reminders
    SET title = ?, instruction = ?, schedule_kind = ?, next_due_at = ?, interval_seconds = ?,
        timezone = ?, status = ?, updated_at = ?
    WHERE mate_id = ? AND user_id = ? AND id = ?
  `).bind(
    title, instruction, scheduleKind, nextDueAt, intervalSeconds || null,
    timezone, status, new Date().toISOString(), mateId, principal.userId, reminderId
  ).run();
  return readReminder(db, mateId, principal.userId, reminderId);
}

export async function ensureRecurringReminder(
  db: D1Database,
  input: {
    instruction: string;
    intervalSeconds: number;
    jobId: string;
    nextDueAt: string;
    reminderId: string;
    releaseId: string;
    mateId: string;
    threadCode?: string;
    timezone: string;
    title: string;
    userId: string;
  }
) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO mate_reminders (
      mate_id, user_id, id, title, instruction, schedule_kind, next_due_at,
      interval_seconds, timezone, status, thread_code, managed_release_id, managed_job_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'interval', ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    ON CONFLICT(mate_id, user_id, id) DO UPDATE SET
      title = excluded.title,
      instruction = excluded.instruction,
      next_due_at = CASE
        WHEN mate_reminders.managed_release_id IS NOT excluded.managed_release_id
          OR mate_reminders.interval_seconds != excluded.interval_seconds
          OR mate_reminders.timezone != excluded.timezone
        THEN excluded.next_due_at
        ELSE mate_reminders.next_due_at
      END,
      interval_seconds = excluded.interval_seconds,
      timezone = excluded.timezone,
      status = 'active',
      managed_release_id = excluded.managed_release_id,
      managed_job_id = excluded.managed_job_id,
      updated_at = excluded.updated_at
  `).bind(
    input.mateId, input.userId, input.reminderId, input.title, input.instruction,
    input.nextDueAt, input.intervalSeconds, input.timezone, input.threadCode || null,
    input.releaseId, input.jobId, now, now
  ).run();
  return readReminder(db, input.mateId, input.userId, input.reminderId);
}

export async function pauseUnpublishedScheduleReminders(
  db: D1Database,
  mateId: string,
  userId: string,
  activeJobIds: string[]
) {
  const placeholders = activeJobIds.map(() => "?").join(", ");
  const exclusion = activeJobIds.length ? `AND managed_job_id NOT IN (${placeholders})` : "";
  await db.prepare(`
    UPDATE mate_reminders
    SET status = 'paused', updated_at = ?
    WHERE mate_id = ? AND user_id = ? AND managed_job_id IS NOT NULL
      ${exclusion}
  `).bind(new Date().toISOString(), mateId, userId, ...activeJobIds).run();
}

export async function pauseScheduleRemindersForOtherOwners(
  db: D1Database,
  mateId: string,
  currentOwnerUserId: string,
  activeJobIds: string[]
) {
  const placeholders = activeJobIds.map(() => "?").join(", ");
  const legacyManagedJobMatch = activeJobIds.length ? `OR id IN (${placeholders})` : "";
  await db.prepare(`
    UPDATE mate_reminders
    SET status = 'paused', updated_at = ?
    WHERE mate_id = ? AND user_id <> ?
      AND (managed_job_id IS NOT NULL ${legacyManagedJobMatch})
      AND status = 'active'
  `).bind(new Date().toISOString(), mateId, currentOwnerUserId, ...activeJobIds).run();
}

export async function setReminderThreadCode(
  db: D1Database,
  mateId: string,
  userId: string,
  reminderId: string,
  threadCode: string
) {
  const code = normalizeThreadCode(threadCode);
  if (!code) throw new RuntimeHttpError(422, "email_thread_code_invalid");
  await db.prepare(`
    UPDATE mate_reminders SET thread_code = ?, updated_at = ?
    WHERE mate_id = ? AND user_id = ? AND id = ?
  `).bind(code, new Date().toISOString(), mateId, userId, reminderId).run();
}

export async function claimDueReminders(db: D1Database, now: Date, limit = 20) {
  const staleBefore = new Date(now.getTime() - SCHEDULE_CLAIM_TIMEOUT_MS).toISOString();
  const stale = await db.prepare(`
    SELECT execution_key AS executionKey, mate_id AS mateId, user_id AS userId,
           reminder_id AS reminderId, scheduled_for AS scheduledFor
    FROM mate_schedule_executions
    WHERE status = 'claimed' AND created_at <= ?
    ORDER BY created_at LIMIT ?
  `).bind(staleBefore, Math.min(Math.max(limit, 1), 100)).all<Record<string, unknown>>();
  for (const execution of stale.results ?? []) {
    await db.batch([
      db.prepare(`
        UPDATE mate_schedule_executions
        SET status = 'failed', error_code = 'schedule_claim_timed_out', completed_at = ?
        WHERE execution_key = ? AND status = 'claimed'
      `).bind(now.toISOString(), execution.executionKey),
      db.prepare(`
        UPDATE mate_reminders SET next_due_at = ?, updated_at = ?
        WHERE mate_id = ? AND user_id = ? AND id = ?
          AND status = 'active' AND next_due_at = ?
      `).bind(
        now.toISOString(), now.toISOString(), execution.mateId, execution.userId,
        execution.reminderId, execution.scheduledFor
      )
    ]);
  }
  const rows = await db.prepare(`
    SELECT mate_id AS mateId, user_id AS userId, id, title, instruction,
           schedule_kind AS scheduleKind, next_due_at AS nextDueAt,
           interval_seconds AS intervalSeconds, timezone, thread_code AS threadCode,
           last_task_id AS lastTaskId, managed_release_id AS managedReleaseId,
           managed_job_id AS managedJobId
    FROM mate_reminders
    WHERE status = 'active' AND next_due_at <= ?
    ORDER BY next_due_at, id LIMIT ?
  `).bind(now.toISOString(), Math.min(Math.max(limit, 1), 100)).all<Record<string, unknown>>();
  const claimed: Array<Record<string, unknown> & { executionKey: string }> = [];
  for (const row of rows.results ?? []) {
    const executionKey = `${row.mateId}:${row.userId}:${row.id}:${row.nextDueAt}`;
    try {
      await db.prepare(`
        INSERT INTO mate_schedule_executions (
          execution_key, mate_id, user_id, reminder_id, scheduled_for, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'claimed', ?)
      `).bind(executionKey, row.mateId, row.userId, row.id, row.nextDueAt, now.toISOString()).run();
      claimed.push({ ...row, executionKey });
    } catch (error) {
      if (!String(error).toLowerCase().includes("unique")) throw error;
    }
  }
  return claimed;
}

export async function completeReminderExecution(
  db: D1Database,
  execution: Record<string, unknown> & { executionKey: string },
  taskId: string,
  completedAt = new Date(),
  managedNextDueAt?: string
) {
  const scheduledFor = new Date(String(execution.nextDueAt));
  const intervalSeconds = Number(execution.intervalSeconds || 0);
  let nextDueAt: string | null = null;
  let reminderStatus = "completed";
  if (managedNextDueAt && Number.isFinite(Date.parse(managedNextDueAt))) {
    nextDueAt = new Date(managedNextDueAt).toISOString();
    reminderStatus = "active";
  } else if (execution.scheduleKind === "interval" && intervalSeconds >= 300) {
    let next = scheduledFor.getTime() + intervalSeconds * 1000;
    while (next <= completedAt.getTime()) next += intervalSeconds * 1000;
    nextDueAt = new Date(next).toISOString();
    reminderStatus = "active";
  }
  await db.batch([
    db.prepare(`
      UPDATE mate_schedule_executions
      SET status = 'completed', task_id = ?, completed_at = ?
      WHERE execution_key = ? AND status = 'claimed'
    `).bind(taskId, completedAt.toISOString(), execution.executionKey),
    db.prepare(`
      UPDATE mate_reminders
      SET status = ?, next_due_at = COALESCE(?, next_due_at), last_task_id = ?,
          last_fired_at = ?, updated_at = ?
      WHERE mate_id = ? AND user_id = ? AND id = ?
    `).bind(
      reminderStatus, nextDueAt, taskId, completedAt.toISOString(), completedAt.toISOString(),
      execution.mateId, execution.userId, execution.id
    )
  ]);
}

export async function failReminderExecution(
  db: D1Database,
  execution: Record<string, unknown> & { executionKey: string },
  errorCode: string,
  failedAt = new Date()
) {
  const retryAt = new Date(failedAt.getTime() + 15 * 60 * 1000).toISOString();
  await db.batch([
    db.prepare(`
      UPDATE mate_schedule_executions
      SET status = 'failed', error_code = ?, completed_at = ?
      WHERE execution_key = ? AND status = 'claimed'
    `).bind(errorCode.slice(0, 160), failedAt.toISOString(), execution.executionKey),
    db.prepare(`
      UPDATE mate_reminders SET next_due_at = ?, updated_at = ?
      WHERE mate_id = ? AND user_id = ? AND id = ? AND status = 'active'
    `).bind(retryAt, failedAt.toISOString(), execution.mateId, execution.userId, execution.id)
  ]);
}

export async function findOrCreateEmailThread(
  db: D1Database,
  input: { requestedCode?: string; subject: string; mateId: string; userId: string }
) {
  const requested = normalizeThreadCode(input.requestedCode);
  if (requested) {
    const existing = await readEmailThread(db, input.mateId, requested);
    if (existing && existing.userId === input.userId && existing.status === "open") return existing;
  }
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const code = randomThreadCode();
    const now = new Date().toISOString();
    try {
      await db.prepare(`
        INSERT INTO mate_email_threads (
          mate_id, user_id, thread_code, subject, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'open', ?, ?)
      `).bind(input.mateId, input.userId, code, cleanSubject(input.subject), now, now).run();
      return (await readEmailThread(db, input.mateId, code))!;
    } catch (error) {
      if (!String(error).toLowerCase().includes("unique")) throw error;
    }
  }
  throw new RuntimeHttpError(503, "email_thread_code_exhausted");
}

export async function attachEmailThreadTask(
  db: D1Database,
  mateId: string,
  userId: string,
  threadCode: string,
  taskId: string
) {
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE mate_email_threads
    SET root_task_id = COALESCE(root_task_id, ?), last_task_id = ?, updated_at = ?
    WHERE mate_id = ? AND user_id = ? AND thread_code = ?
  `).bind(taskId, taskId, now, mateId, userId, threadCode).run();
}

export async function claimInboundEmail(
  db: D1Database,
  input: {
    envelopeFrom: string;
    envelopeTo: string;
    messageDigest: string;
    externalMessageId?: string;
    subject: string;
    mateId: string;
    threadCode: string;
    userId: string;
  }
) {
  const now = new Date().toISOString();
  try {
    await db.prepare(`
      INSERT INTO mate_email_messages (
        mate_id, user_id, message_digest, direction, thread_code, envelope_from,
        envelope_to, subject, status, created_at,external_message_id
      ) VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, 'accepted', ?,?)
    `).bind(
      input.mateId, input.userId, input.messageDigest, input.threadCode,
      input.envelopeFrom, input.envelopeTo, cleanSubject(input.subject), now,input.externalMessageId || null
    ).run();
    return true;
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      const existing = await db.prepare(`
        SELECT status FROM mate_email_messages
        WHERE mate_id = ? AND message_digest = ? AND direction = 'inbound' LIMIT 1
      `).bind(input.mateId, input.messageDigest).first<{ status?: string }>();
      if (existing?.status === "failed") {
        const retried=await db.prepare(`
          UPDATE mate_email_messages SET status = 'accepted'
          WHERE mate_id = ? AND message_digest = ? AND status = 'failed'
        `).bind(input.mateId, input.messageDigest).run();
        return retried.meta?.changes !== 0;
      }
      return false;
    }
    throw error;
  }
}

export async function completeInboundEmail(
  db: D1Database,
  mateId: string,
  messageDigest: string,
  taskId: string,
  status: "accepted" | "replied" | "failed"
) {
  await db.prepare(`
    UPDATE mate_email_messages SET task_id = ?, status = ?
    WHERE mate_id = ? AND message_digest = ? AND direction = 'inbound'
  `).bind(taskId, status, mateId, messageDigest).run();
}

export async function recordOutboundEmail(
  db: D1Database,
  input: {
    envelopeFrom: string;
    envelopeTo: string;
    messageDigest: string;
    status?: "sent" | "failed";
    providerMessageId?: string;
    externalMessageId?: string;
    subject: string;
    taskId?: string;
    mateId: string;
    threadCode: string;
    userId: string;
  }
) {
  await db.prepare(`
    INSERT INTO mate_email_messages (
      mate_id, user_id, message_digest, direction, thread_code, task_id,
      envelope_from, envelope_to, subject, status, provider_message_id, created_at,external_message_id
    ) VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?,?)
    ON CONFLICT(mate_id,message_digest) DO UPDATE SET status=excluded.status,provider_message_id=excluded.provider_message_id,external_message_id=excluded.external_message_id
  `).bind(
    input.mateId, input.userId, input.messageDigest, input.threadCode,
    input.taskId || null, input.envelopeFrom, input.envelopeTo, cleanSubject(input.subject),input.status || "sent",
    input.providerMessageId || null, new Date().toISOString(),input.externalMessageId || input.providerMessageId || null
  ).run();
}

export async function readRuntimeCursor(db: D1Database, mateId: string, userId: string, cursorKey: string) {
  const row = await db.prepare(`
    SELECT value FROM mate_runtime_cursors
    WHERE mate_id = ? AND user_id = ? AND cursor_key = ? LIMIT 1
  `).bind(mateId, userId, cursorKey).first<{ value?: string }>();
  return row?.value;
}

export async function saveRuntimeCursor(db: D1Database, mateId: string, userId: string, cursorKey: string, value: string) {
  await db.prepare(`
    INSERT INTO mate_runtime_cursors (mate_id, user_id, cursor_key, value, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(mate_id,user_id,cursor_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(mateId, userId, cursorKey, value.slice(0, 4000), new Date().toISOString()).run();
}

export function threadCodeFromSubject(subject: unknown, mateId?: string) {
  const value = text(subject).toUpperCase();
  const prefix = threadPrefix(mateId);
  return (prefix ? value.match(new RegExp(`\\[${escapeRegex(prefix)}[- ]([A-Z0-9]{4})\\]`))?.[1] : undefined)
    || value.match(/\[([A-Z0-9]{4})\]/)?.[1]
    || "";
}

export function subjectWithThreadCode(subject: string, threadCode: string, mateId?: string) {
  const clean = cleanSubject(subject).replace(/^RE:\s*/i, "").replace(/\[[A-Z0-9_-]{1,48}[- ][A-Z0-9]{4}\]\s*/ig, "").trim();
  return `[${threadPrefix(mateId) || "MATE"}-${normalizeThreadCode(threadCode)}] ${clean || "Task update"}`.slice(0, 240);
}

async function readTodo(db: D1Database, mateId: string, userId: string, todoId: string): Promise<RuntimeTodo> {
  const row = await db.prepare(`
    SELECT id, source_task_id AS sourceTaskId, title, details, priority, status,
           due_at AS dueAt, created_at AS createdAt, updated_at AS updatedAt
    FROM mate_todos WHERE mate_id = ? AND user_id = ? AND id = ? LIMIT 1
  `).bind(mateId, userId, todoId).first<Record<string, unknown>>();
  if (!row) throw new RuntimeHttpError(404, "todo_not_found");
  return todoFromRow(row);
}

async function readReminder(db: D1Database, mateId: string, userId: string, reminderId: string): Promise<RuntimeReminder> {
  const row = await db.prepare(`
    SELECT id, source_task_id AS sourceTaskId, title, instruction,
           schedule_kind AS scheduleKind, next_due_at AS nextDueAt,
           interval_seconds AS intervalSeconds, timezone, status,
           thread_code AS threadCode, last_task_id AS lastTaskId, last_fired_at AS lastFiredAt,
           managed_release_id AS managedReleaseId, managed_job_id AS managedJobId
    FROM mate_reminders WHERE mate_id = ? AND user_id = ? AND id = ? LIMIT 1
  `).bind(mateId, userId, reminderId).first<Record<string, unknown>>();
  if (!row) throw new RuntimeHttpError(404, "reminder_not_found");
  return reminderFromRow(row);
}

async function readEmailThread(db: D1Database, mateId: string, threadCode: string) {
  const row = await db.prepare(`
    SELECT thread_code AS threadCode, user_id AS userId, subject, root_task_id AS rootTaskId,
           last_task_id AS lastTaskId, status, created_at AS createdAt, updated_at AS updatedAt
    FROM mate_email_threads WHERE mate_id = ? AND thread_code = ? LIMIT 1
  `).bind(mateId, threadCode).first<Record<string, unknown>>();
  return row ? {
    createdAt: String(row.createdAt),
    lastTaskId: row.lastTaskId ? String(row.lastTaskId) : undefined,
    rootTaskId: row.rootTaskId ? String(row.rootTaskId) : undefined,
    status: String(row.status),
    subject: String(row.subject),
    threadCode: String(row.threadCode),
    updatedAt: String(row.updatedAt),
    userId: String(row.userId)
  } : undefined;
}

function todoFromRow(row: Record<string, unknown>): RuntimeTodo {
  return {
    createdAt: String(row.createdAt || ""),
    details: String(row.details || ""),
    dueAt: row.dueAt ? String(row.dueAt) : undefined,
    id: String(row.id || ""),
    priority: todoPriority(row.priority),
    sourceTaskId: row.sourceTaskId ? String(row.sourceTaskId) : undefined,
    status: todoStatus(row.status),
    title: String(row.title || ""),
    updatedAt: String(row.updatedAt || "")
  };
}

function reminderFromRow(row: Record<string, unknown>): RuntimeReminder {
  return {
    id: String(row.id || ""),
    instruction: String(row.instruction || ""),
    intervalSeconds: row.intervalSeconds ? Number(row.intervalSeconds) : undefined,
    lastFiredAt: row.lastFiredAt ? String(row.lastFiredAt) : undefined,
    lastTaskId: row.lastTaskId ? String(row.lastTaskId) : undefined,
    managedJobId: row.managedJobId ? String(row.managedJobId) : undefined,
    managedReleaseId: row.managedReleaseId ? String(row.managedReleaseId) : undefined,
    nextDueAt: String(row.nextDueAt || ""),
    scheduleKind: row.scheduleKind === "interval" ? "interval" : "once",
    sourceTaskId: row.sourceTaskId ? String(row.sourceTaskId) : undefined,
    status: ["active", "paused", "completed", "cancelled"].includes(String(row.status)) ? row.status as RuntimeReminder["status"] : "active",
    threadCode: row.threadCode ? String(row.threadCode) : undefined,
    timezone: String(row.timezone || "UTC"),
    title: String(row.title || "")
  };
}

function todoPriority(value: unknown): RuntimeTodo["priority"] {
  const output = text(value);
  return output === "low" || output === "high" || output === "urgent" ? output : "normal";
}

function todoStatus(value: unknown): RuntimeTodo["status"] {
  const output = text(value);
  if (output === "in_progress" || output === "completed" || output === "cancelled") return output;
  return "open";
}

function reminderStatus(value: unknown): RuntimeReminder["status"] {
  const output = text(value);
  if (output === "active" || output === "paused" || output === "completed" || output === "cancelled") return output;
  throw new RuntimeHttpError(422, "reminder_status_invalid");
}

function invalidReminderScheduleKind(): never {
  throw new RuntimeHttpError(422, "reminder_schedule_kind_invalid");
}

function boundedInteger(value: unknown, minimum: number, maximum: number) {
  const output = Number(value);
  if (!Number.isInteger(output) || output < minimum || output > maximum) throw new RuntimeHttpError(422, "reminder_interval_invalid");
  return output;
}

function requiredTimestamp(value: unknown, code: string) {
  const timestamp = Date.parse(text(value));
  if (!Number.isFinite(timestamp)) throw new RuntimeHttpError(422, code);
  return new Date(timestamp).toISOString();
}

function optionalFutureOrPastTimestamp(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredTimestamp(value, "todo_due_at_invalid");
}

function requiredText(value: unknown, code: string, maxLength: number) {
  const output = text(value).trim();
  if (!output) throw new RuntimeHttpError(422, code);
  return output.slice(0, maxLength);
}

function normalizeThreadCode(value: unknown) {
  const output = text(value).trim().toUpperCase();
  return /^[A-Z0-9]{4}$/.test(output) ? output : "";
}

function threadPrefix(mateId: unknown) {
  return text(mateId).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32);
}

function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function randomThreadCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((byte) => THREAD_CODE_ALPHABET[byte % THREAD_CODE_ALPHABET.length]).join("");
}

function cleanSubject(value: unknown) { return text(value).replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 240); }
function identifier(value: unknown) { const output = text(value); return /^[A-Za-z0-9_-]{8,160}$/.test(output) ? output : ""; }
function randomId() { return crypto.randomUUID().replaceAll("-", ""); }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
