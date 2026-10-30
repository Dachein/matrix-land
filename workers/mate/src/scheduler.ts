import type { MateScheduledJob } from "../../../src/shared/mate.ts";
import { listPublishedMateIdentities, loadRuntimeDefinition } from "./controlPlane.ts";
import {
  claimDueReminders,
  completeReminderExecution,
  ensureRecurringReminder,
  failReminderExecution,
  pauseScheduleRemindersForOtherOwners,
  pauseUnpublishedScheduleReminders
} from "./inboxStorage.ts";
import { executeReminderTask } from "./reminderTask.ts";
import { resolveScheduledRuntimePrincipal } from "./runtimeIdentity.ts";
import { createTask } from "./storage.ts";
import { scheduledJob } from "./taskExecutor.ts";
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimePrincipal } from "./types.ts";

const DAILY_INTERVAL_SECONDS = 24 * 60 * 60;

export async function runMateScheduledTick(env: RuntimeEnv, scheduledTime = Date.now()) {
  const now = new Date(scheduledTime);
  const reconciliation = await reconcilePublishedSchedules(env, now);
  const executions = await claimDueReminders(env.RUNTIME_DB, now, 20);
  const results = [];
  for (const execution of executions) {
    try {
      const principal = await resolveScheduledRuntimePrincipal(env, String(execution.userId));
      const definition = await loadRuntimeDefinition(env, principal, String(execution.mateId), "live");
      const job = scheduledJob(definition, String(execution.managedJobId || execution.id));
      if (execution.managedJobId && !job) throw new RuntimeHttpError(409, "scheduled_job_not_in_active_release");
      const created = await createTask(env.RUNTIME_DB, definition, principal, "live", {
        channel: "schedule",
        title: String(execution.title),
        context: {
          reminderId: String(execution.id),
          scheduledFor: String(execution.nextDueAt),
          threadCode: String(execution.threadCode || ""),
          timezone: String(execution.timezone || definition.release.manifest.taskPolicy.defaultTimezone || "UTC")
        },
        instruction: String(execution.instruction),
        ...(execution.lastTaskId ? { parentTaskId: String(execution.lastTaskId) } : {})
      }, { allowInternalSchedule: true });
      await executeReminderTask(env, definition, principal, String(created.id), {
        deliverEmail: job ? job.delivery?.channel === "email" : true,
        id: String(execution.id),
        threadCode: execution.threadCode ? String(execution.threadCode) : undefined,
        title: String(execution.title)
      });
      const wallClock = job ? parseWallClock(job.cadence.at) : undefined;
      const nextManagedDueAt = job && wallClock
        ? nextDailyOccurrence(now, job.cadence.timezone, wallClock.hour, wallClock.minute).toISOString()
        : undefined;
      await completeReminderExecution(env.RUNTIME_DB, execution, String(created.id), now, nextManagedDueAt);
      results.push({ reminderId: execution.id, status: "completed", taskId: created.id });
    } catch (error) {
      const code = error instanceof RuntimeHttpError ? error.code : "scheduled_execution_failed";
      await failReminderExecution(env.RUNTIME_DB, execution, code, now);
      console.error("mate_schedule_failed", { code, reminderId: execution.id, mateId: execution.mateId });
      results.push({ error: code, reminderId: execution.id, status: "failed" });
    }
  }
  return { processed: results.length, reconciliation, results };
}

export async function reconcilePublishedSchedules(env: RuntimeEnv, now = new Date()) {
  const identities = await listPublishedMateIdentities(env);
  const results = [];
  for (const identity of identities) {
    try {
      const principal = await resolveScheduledRuntimePrincipal(env, identity.ownerUserId);
      if (principal.orgId !== identity.orgId) throw new RuntimeHttpError(403, "scheduled_owner_org_mismatch");
      const definition = await loadRuntimeDefinition(env, principal, identity.id, "live");
      const jobs = configuredScheduleJobs(definition);
      await pauseScheduleRemindersForOtherOwners(env.RUNTIME_DB, identity.id, principal.userId, jobs.map((job) => job.id));
      await pauseUnpublishedScheduleReminders(env.RUNTIME_DB, identity.id, principal.userId, jobs.map((job) => job.id));
      const reminders = [];
      for (const job of jobs) reminders.push(await ensureScheduledJob(env, definition, principal, job, now));
      results.push({ jobs: reminders.length, status: "reconciled", mateId: identity.id });
    } catch (error) {
      const code = error instanceof RuntimeHttpError ? error.code : "schedule_reconciliation_failed";
      console.error("mate_schedule_reconciliation_failed", { code, mateId: identity.id });
      results.push({ error: code, jobs: 0, status: "failed", mateId: identity.id });
    }
  }
  return results;
}

export async function bootstrapMateSchedules(env: RuntimeEnv, mateId: string, now = new Date()) {
  const { definition, principal } = await ownerDefinition(env, mateId);
  const jobs = configuredScheduleJobs(definition);
  await pauseScheduleRemindersForOtherOwners(env.RUNTIME_DB, mateId, principal.userId, jobs.map((job) => job.id));
  await pauseUnpublishedScheduleReminders(env.RUNTIME_DB, mateId, principal.userId, jobs.map((job) => job.id));
  const reminders = [];
  for (const job of jobs) reminders.push(await ensureScheduledJob(env, definition, principal, job, now));
  return reminders;
}

export async function runMateScheduleNow(env: RuntimeEnv, mateId: string, jobId: string, now = new Date()) {
  const { definition, principal } = await ownerDefinition(env, mateId);
  const jobs = configuredScheduleJobs(definition);
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new RuntimeHttpError(404, "scheduled_job_not_found");
  await pauseScheduleRemindersForOtherOwners(env.RUNTIME_DB, mateId, principal.userId, jobs.map((candidate) => candidate.id));
  await pauseUnpublishedScheduleReminders(env.RUNTIME_DB, mateId, principal.userId, jobs.map((candidate) => candidate.id));
  const reminder = await ensureScheduledJob(env, definition, principal, job, now);
  const task = await createTask(env.RUNTIME_DB, definition, principal, "live", {
    channel: "schedule",
    title: job.title,
    context: {
      reminderId: reminder.id,
      scheduledFor: now.toISOString(),
      threadCode: reminder.threadCode || "",
      timezone: reminder.timezone
    },
    instruction: job.instruction,
    ...(reminder.lastTaskId ? { parentTaskId: reminder.lastTaskId } : {})
  }, { allowInternalSchedule: true });
  return executeReminderTask(env, definition, principal, String(task.id), {
    deliverEmail: job.delivery?.channel === "email",
    id: reminder.id,
    threadCode: reminder.threadCode,
    title: reminder.title
  });
}

function configuredScheduleJobs(definition: RuntimeDefinition) {
  if (definition.release.manifest.channels.inbox?.schedule?.enabled !== true) return [];
  const jobs = definition.release.manifest.taskPolicy?.scheduledJobs;
  return Array.isArray(jobs) ? jobs : [];
}

async function ensureScheduledJob(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  job: MateScheduledJob,
  now: Date
) {
  const at = parseWallClock(job.cadence.at);
  return ensureRecurringReminder(env.RUNTIME_DB, {
    instruction: job.instruction,
    intervalSeconds: DAILY_INTERVAL_SECONDS,
    jobId: job.id,
    nextDueAt: nextDailyOccurrence(now, job.cadence.timezone, at.hour, at.minute).toISOString(),
    reminderId: job.id,
    releaseId: definition.release.id,
    mateId: definition.mate.id,
    timezone: job.cadence.timezone,
    title: job.title,
    userId: principal.userId
  });
}

async function ownerDefinition(env: RuntimeEnv, mateId: string) {
  const identity = (await listPublishedMateIdentities(env)).find((candidate) => candidate.id === mateId);
  if (!identity) throw new RuntimeHttpError(404, "mate_not_published");
  const principal = await resolveScheduledRuntimePrincipal(env, identity.ownerUserId);
  if (principal.orgId !== identity.orgId) throw new RuntimeHttpError(403, "scheduled_owner_org_mismatch");
  const definition = await loadRuntimeDefinition(env, principal, identity.id, "live");
  return { definition, principal };
}

function parseWallClock(value: string) {
  const match = value.trim().match(/^(\d{2}):(\d{2})$/);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new RuntimeHttpError(422, "daily_schedule_time_invalid");
  return { hour, minute };
}

function nextDailyOccurrence(now: Date, timezone: string, hour: number, minute: number) {
  const local = localParts(now, timezone);
  let candidate = zonedToUtc(local.year, local.month, local.day, hour, minute, timezone);
  if (candidate.getTime() <= now.getTime()) {
    const tomorrow = new Date(Date.UTC(local.year, local.month - 1, local.day + 1, 12));
    const parts = localParts(tomorrow, timezone);
    candidate = zonedToUtc(parts.year, parts.month, parts.day, hour, minute, timezone);
  }
  return candidate;
}

function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const actual = localParts(new Date(guess), timezone);
  const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
  return new Date(guess - (represented - guess));
}

function localParts(value: Date, timezone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit",
      month: "2-digit", timeZone: timezone, year: "numeric"
    }).formatToParts(value);
  } catch {
    throw new RuntimeHttpError(422, "scheduled_timezone_invalid");
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  return { day: part("day"), hour: part("hour"), minute: part("minute"), month: part("month"), year: part("year") };
}
