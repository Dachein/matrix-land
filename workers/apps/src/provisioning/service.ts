import type { AppsProvisioningJob } from "../../../../src/shared/types";
import { canReadApp, requireWritableApp } from "../apps/queries";
import { audit } from "../core/audit";
import { HttpError, type Env, type Principal } from "../core/types";
import type { AppsAppRow, AppsProvisioningJobRow } from "../db/rows";
import { hydrateProvisioningJob } from "./mappers";
import { runProvisioningJob } from "./runner";
import { CREATE_APP_STEPS } from "./steps";

export async function readLatestProvisioningJob(db: D1Database, principal: Principal, appId: string): Promise<AppsProvisioningJob | undefined> {
  const appRow = await db.prepare("SELECT * FROM apps_apps WHERE id = ? LIMIT 1").bind(appId).first<AppsAppRow>();
  if (!appRow || !canReadApp(appRow, principal)) {
    throw new HttpError(404, "apps_app_not_found");
  }

  const jobRow = await db
    .prepare("SELECT * FROM apps_provisioning_jobs WHERE app_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(appId)
    .first<AppsProvisioningJobRow>();

  return jobRow ? hydrateProvisioningJob(db, jobRow) : undefined;
}

export async function readProvisioningJob(db: D1Database, principal: Principal, jobId: string): Promise<AppsProvisioningJob> {
  const jobRow = await db
    .prepare("SELECT * FROM apps_provisioning_jobs WHERE id = ? LIMIT 1")
    .bind(jobId)
    .first<AppsProvisioningJobRow>();

  if (!jobRow) {
    throw new HttpError(404, "provisioning_job_not_found");
  }

  const appRow = await db.prepare("SELECT * FROM apps_apps WHERE id = ? LIMIT 1").bind(jobRow.app_id).first<AppsAppRow>();
  if (!appRow || !canReadApp(appRow, principal)) {
    throw new HttpError(404, "provisioning_job_not_found");
  }

  return hydrateProvisioningJob(db, jobRow);
}

export async function retryProvisioningJob(env: Env, principal: Principal, jobId: string, ctx: ExecutionContext): Promise<AppsProvisioningJob> {
  const job = await readProvisioningJob(env.APPS_DB, principal, jobId);
  const appRow = await requireWritableApp(env.APPS_DB, principal, job.appId);

  if (job.status !== "failed" && job.status !== "queued") {
    return job;
  }

  const now = new Date().toISOString();
  await env.APPS_DB.batch([
    env.APPS_DB
      .prepare(
        `
        UPDATE apps_provisioning_jobs
        SET status = 'queued',
            error_code = NULL,
            error_message = NULL,
            current_step = COALESCE(current_step, ?),
            updated_at = ?
        WHERE id = ?
        `
      )
      .bind(CREATE_APP_STEPS[0]?.key ?? "queued", now, jobId),
    env.APPS_DB
      .prepare(
        `
        UPDATE apps_provisioning_steps
        SET status = 'queued',
            error_code = NULL,
            error_message = NULL,
            updated_at = ?
        WHERE job_id = ?
          AND status = 'failed'
        `
      )
      .bind(now, jobId),
    env.APPS_DB
      .prepare("UPDATE apps_apps SET status = 'provisioning', updated_at = ? WHERE id = ?")
      .bind(now, appRow.id)
  ]);

  ctx.waitUntil(runProvisioningJob(env, jobId));
  await audit(env.APPS_DB, principal, "retried provisioning job", "provisioning_job", jobId, { appId: job.appId });
  return readProvisioningJob(env.APPS_DB, principal, jobId);
}
