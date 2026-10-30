import { syncAppsAppAuthClient } from "../apps/authSync";
import { HttpError, type Env } from "../core/types";
import type { AppsAppRow, AppsProvisioningJobRow, AppsProvisioningStepRow } from "../db/rows";
import { ensureAndMarkAppDomains } from "../domains/cloudflare";
import { provisionResourceTypes } from "./cloudflareResources";

type RunProvisioningJobOptions = {
  throwOnFailure?: boolean;
};

export async function runProvisioningJob(env: Env, jobId: string, options: RunProvisioningJobOptions = {}): Promise<void> {
  const jobRow = await env.APPS_DB
    .prepare("SELECT * FROM apps_provisioning_jobs WHERE id = ? LIMIT 1")
    .bind(jobId)
    .first<AppsProvisioningJobRow>();

  if (!jobRow || jobRow.status === "ready" || jobRow.status === "cancelled") {
    return;
  }

  const appRow = await env.APPS_DB
    .prepare("SELECT * FROM apps_apps WHERE id = ? LIMIT 1")
    .bind(jobRow.app_id)
    .first<AppsAppRow>();

  if (!appRow) {
    await markProvisioningFailed(env.APPS_DB, jobId, "app_not_found", "The target APPS app no longer exists.");
    return;
  }

  const steps = await env.APPS_DB
    .prepare("SELECT * FROM apps_provisioning_steps WHERE job_id = ? ORDER BY step_order")
    .bind(jobId)
    .all<AppsProvisioningStepRow>();

  const now = new Date().toISOString();
  await env.APPS_DB
    .prepare(
      `
      UPDATE apps_provisioning_jobs
      SET status = 'running',
          started_at = COALESCE(started_at, ?),
          updated_at = ?
      WHERE id = ?
        AND status != 'ready'
      `
    )
    .bind(now, now, jobId)
    .run();

  try {
    for (const step of steps.results ?? []) {
      if (step.status === "ready" || step.status === "skipped") {
        continue;
      }

      const jobCompleted = await runProvisioningStep(env, jobRow, appRow, step);
      if (jobCompleted) {
        return;
      }
    }

    const completedAt = new Date().toISOString();
    await env.APPS_DB.batch([
      env.APPS_DB
        .prepare(
          `
          UPDATE apps_provisioning_jobs
          SET status = 'ready',
              progress = 100,
              current_step = 'ready',
              error_code = NULL,
              error_message = NULL,
              completed_at = COALESCE(completed_at, ?),
              updated_at = ?
          WHERE id = ?
          `
        )
        .bind(completedAt, completedAt, jobId),
      env.APPS_DB
        .prepare("UPDATE apps_apps SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'provisioning'")
        .bind(completedAt, jobRow.app_id)
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown provisioning error";
    const code = error instanceof HttpError ? error.code : "provisioning_step_failed";
    await markProvisioningFailed(env.APPS_DB, jobId, code, message);
    if (options.throwOnFailure) {
      throw error;
    }
  }
}

async function runProvisioningStep(
  env: Env,
  job: AppsProvisioningJobRow,
  app: AppsAppRow,
  step: AppsProvisioningStepRow
) {
  const startedAt = new Date().toISOString();
  await env.APPS_DB.batch([
    env.APPS_DB
      .prepare(
        `
        UPDATE apps_provisioning_steps
        SET status = 'running',
            started_at = COALESCE(started_at, ?),
            updated_at = ?
        WHERE id = ?
          AND EXISTS (
            SELECT 1
            FROM apps_provisioning_jobs
            WHERE id = ?
              AND status != 'ready'
          )
        `
      )
      .bind(startedAt, startedAt, step.id, job.id),
    env.APPS_DB
      .prepare(
        `
        UPDATE apps_provisioning_jobs
        SET status = 'running',
            progress = ?,
            current_step = ?,
            updated_at = ?
        WHERE id = ?
          AND status != 'ready'
        `
      )
      .bind(Math.max(0, step.progress - 4), step.step_key, startedAt, job.id)
  ]);

  const jobCompleted = await applyProvisioningStep(env, app, step);
  if (jobCompleted) {
    return true;
  }

  const completedAt = new Date().toISOString();
  await env.APPS_DB.batch([
    env.APPS_DB
      .prepare(
        `
        UPDATE apps_provisioning_steps
        SET status = 'ready',
            progress = ?,
            error_code = NULL,
            error_message = NULL,
            completed_at = COALESCE(completed_at, ?),
            updated_at = ?
        WHERE id = ?
        `
      )
      .bind(step.progress, completedAt, completedAt, step.id),
    env.APPS_DB
      .prepare("UPDATE apps_provisioning_jobs SET progress = ?, current_step = ?, updated_at = ? WHERE id = ? AND status != 'ready'")
      .bind(step.progress, step.step_key, completedAt, job.id)
  ]);
  return false;
}

async function applyProvisioningStep(
  env: Env,
  app: AppsAppRow,
  step: AppsProvisioningStepRow
) {
  const now = new Date().toISOString();
  const resourceTypes = step.resource_type
    ?.split(",")
    .map((type) => type.trim())
    .filter(Boolean) ?? [];

  if (resourceTypes.length > 0) {
    await provisionResourceTypes(env, app, resourceTypes, now, { requireRegistered: true });
  }

  if (step.step_key === "register_auth") {
    await syncAppsAppAuthClient(env, app, {
      loginRequired: app.login_required === 1,
      sdkStatus: "pending",
      status: "draft",
      visibility: "private"
    });
  }

  if (step.step_key === "configure_routes") {
    await ensureAndMarkAppDomains(env, app.id, {
      production: "reserved"
    });
  }

  return false;
}

async function markProvisioningFailed(db: D1Database, jobId: string, code: string, message: string) {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `
        UPDATE apps_provisioning_jobs
        SET status = 'failed',
            error_code = ?,
            error_message = ?,
            updated_at = ?
        WHERE id = ?
          AND status != 'ready'
        `
      )
      .bind(code, message.slice(0, 500), now, jobId),
    db
      .prepare(
        `
        UPDATE apps_provisioning_steps
        SET status = 'failed',
            error_code = ?,
            error_message = ?,
            updated_at = ?
        WHERE job_id = ?
          AND step_key = (
            SELECT current_step
            FROM apps_provisioning_jobs
            WHERE id = ?
            LIMIT 1
          )
          AND status = 'running'
          AND EXISTS (
            SELECT 1
            FROM apps_provisioning_jobs
            WHERE id = ?
              AND status != 'ready'
          )
        `
      )
      .bind(code, message.slice(0, 500), now, jobId, jobId, jobId)
  ]);
}
