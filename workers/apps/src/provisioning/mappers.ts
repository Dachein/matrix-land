import type { AppsProvisioningJob, AppsProvisioningStep } from "../../../../src/shared/types";
import { normalizeProvisioningStatus, normalizeProvisioningStepStatus, normalizeProvisioningType } from "../core/normalizers";
import { readOptionalString } from "../core/utils";
import type { AppsProvisioningJobRow, AppsProvisioningStepRow } from "../db/rows";

export async function hydrateProvisioningJob(db: D1Database, row: AppsProvisioningJobRow): Promise<AppsProvisioningJob> {
  const steps = await db
    .prepare("SELECT * FROM apps_provisioning_steps WHERE job_id = ? ORDER BY step_order")
    .bind(row.id)
    .all<AppsProvisioningStepRow>();

  return {
    id: row.id,
    appId: row.app_id,
    orgId: row.org_id,
    type: normalizeProvisioningType(row.type),
    status: normalizeProvisioningStatus(row.status),
    progress: Number(row.progress) || 0,
    currentStep: readOptionalString(row.current_step),
    errorCode: readOptionalString(row.error_code),
    errorMessage: readOptionalString(row.error_message),
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: readOptionalString(row.started_at),
    completedAt: readOptionalString(row.completed_at),
    steps: (steps.results ?? []).map(stepFromRow)
  };
}

function stepFromRow(row: AppsProvisioningStepRow): AppsProvisioningStep {
  return {
    id: row.id,
    jobId: row.job_id,
    appId: row.app_id,
    order: row.step_order,
    key: row.step_key,
    label: row.label,
    status: normalizeProvisioningStepStatus(row.status),
    progress: Number(row.progress) || 0,
    resourceType: readOptionalString(row.resource_type),
    resourceId: readOptionalString(row.resource_id),
    errorCode: readOptionalString(row.error_code),
    errorMessage: readOptionalString(row.error_message),
    startedAt: readOptionalString(row.started_at),
    completedAt: readOptionalString(row.completed_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
