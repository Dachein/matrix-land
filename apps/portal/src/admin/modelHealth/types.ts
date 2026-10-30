export type ModelHealthStatus = "operational" | "degraded" | "failed";
export type ModelHealthRunStatus = "running" | "operational" | "degraded" | "outage" | "error";

export type ModelHealthResult = {
  runId: string;
  modelId: string;
  displayName: string;
  vendorId: string;
  status: ModelHealthStatus;
  latencyMs: number;
  httpStatus: number;
  errorCode: string;
  requestId: string;
  responseExcerpt: string;
  testedAt: string;
};

export type ModelHealthRun = {
  id: string;
  scheduledAt: string;
  slotLocal: string;
  timezone: string;
  status: ModelHealthRunStatus;
  modelCount: number;
  operationalCount: number;
  degradedCount: number;
  failedCount: number;
  startedAt: string;
  completedAt: string;
  errorCode: string;
};

export type ModelHealthModel = {
  id: string;
  displayName: string;
  vendorId: string;
  uptimePercent: number;
  results: ModelHealthResult[];
};

export type ModelHealthResponse = {
  generatedAt: string;
  rangeDays: number;
  rangeRunLimit: number;
  schedule: {
    timezone: string;
    weekdaysOnly: boolean;
    slots: string[];
    nextScheduledAt: string;
  };
  summary: {
    status: ModelHealthRunStatus | "unknown";
    latestRunId: string;
    modelCount: number;
    operationalCount: number;
    degradedCount: number;
    failedCount: number;
    averageLatencyMs: number;
    uptimePercent: number;
    uptimeWindowDays: number;
    lastCheckedAt: string;
  };
  runs: ModelHealthRun[];
  models: ModelHealthModel[];
};
