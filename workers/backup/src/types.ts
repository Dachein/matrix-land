import type { AppsBackupFrequency } from "../../../src/shared/types";

export interface Env {
  BACKUP_DB: D1Database;
  APPS_DB: D1Database;
  BACKUP_ARCHIVES: R2Bucket;
  BACKUP_WORKFLOW: Workflow;
  BACKUP_PORTAL_JWT_SECRET?: string;
  BACKUP_NODE_CREDENTIAL_ENCRYPTION_KEY?: string;
  BACKUP_TRANSFER_AGENT_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  BACKUP_CF_SOURCE_READ_TOKEN?: string;
  BACKUP_LOCAL_COPY_LIMIT?: string;
  DEV_AUTH_BYPASS?: string;
}

export type BackupWorkflowParams = {
  jobId: string;
};

export type Principal = {
  sub: string;
  email?: string;
  orgId: string;
  role: string;
};

export type AppResourceSnapshot = {
  id: string;
  type: "d1_database" | "r2_bucket";
  resourceId: string;
  resourceName: string;
  status: string;
};

export type AppSnapshot = {
  id: string;
  orgId: string;
  name: string;
  code: string;
  ownerUserId: string;
  collaboratorUserIds: string[];
  resources: AppResourceSnapshot[];
};

export type BackupSchedule = {
  frequency: AppsBackupFrequency;
  scheduleTime: string;
  scheduleTimezone: string;
  scheduleWeekday: number;
  scheduleMonthday: number;
};

export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
