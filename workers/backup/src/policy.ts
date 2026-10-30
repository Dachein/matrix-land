import type { AppsBackupPolicy } from "../../../src/shared/types";

export function defaultBackupPolicy(appId: string): AppsBackupPolicy {
  return {
    appId,
    enabled: false,
    frequency: "weekly",
    scheduleTime: "00:00",
    scheduleTimezone: "Asia/Hong_Kong",
    scheduleWeekday: 1,
    scheduleMonthday: 1,
    complianceRetentionEnabled: false,
    complianceRetentionYears: 7,
    localCopyLimit: 10
  };
}

export function resolvePolicyForTrigger(
  policy: Record<string, unknown> | null,
  triggerType: "manual" | "scheduled",
  orgId: string
): Record<string, unknown> | null {
  if (triggerType === "scheduled" && Number(policy?.enabled) !== 1) return null;
  return policy ?? {
    org_id: orgId,
    backup_node_id: null,
    compliance_retention_enabled: 0,
    compliance_retention_years: 7
  };
}
