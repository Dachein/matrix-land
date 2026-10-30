import type { WorkspaceModelCapabilityAssessment } from "../../shared/workspaceModelCapabilities";

export type TokenUsagePurpose = "agent" | "app";

export type GatewayAccessToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  tokenLast4: string;
  environment: "live" | "test";
  status: string;
  accessStatus: string;
  accessReason?: string;
  allowedModels?: string[];
  usagePurpose: TokenUsagePurpose;
  monthlyBudgetPercent: number;
  lastUsedAt?: string;
  createdAt: string;
};

export type GatewayUsageRollup = {
  scopeType: string;
  scopeId: string;
  periodType: string;
  periodStart: string;
  requests: number;
  billableUnits: number;
  estimatedCostUsd: number;
};

export type GatewayUsageSeriesRow = {
  periodStart: string;
  groupType: string;
  groupId: string;
  requests: number;
  blockedRequests: number;
  failedRequests: number;
  billableUnits: number;
  estimatedCostUsd: number;
};

export type LiteLlmUserLimit = {
  id: string;
  userId: string;
  status: string;
  allowedModels?: string[];
  requestLimitPerMinute: number;
  tokensPerMinute: number;
  monthlyBudgetUsd: number;
  spendUsd: number;
  updatedAt?: string;
};

export type GatewayAnalyticsStatus = "ready" | "pending" | "error";

export type GatewayUsageSnapshotTrigger = "automatic" | "manual" | "scheduled" | "reconcile";

export type GatewayUsageRefreshReason =
  | "snapshot_missing"
  | "keyset_changed"
  | "key_activity"
  | "reconcile_due"
  | "current";

export type GatewayUsageRefreshRecommendation = {
  recommended: boolean;
  reason: GatewayUsageRefreshReason;
};

export type GatewayAnalyticsDailyUsage = {
  date: string;
  tokens: number;
  requests: number;
  estimatedCostUsd: number;
};

export type GatewayAnalyticsTokenUsage = {
  tokenId: string;
  tokens: number;
  requests: number;
  estimatedCostUsd: number;
};

export type GatewayUsageAnalytics = {
  timezone: string;
  source?: "snapshot" | "live";
  status: GatewayAnalyticsStatus;
  updatedAt?: string;
  dataThroughAt?: string;
  dataThroughDate?: string;
  lastCheckedAt?: string;
  activityWatermarkAt?: string;
  lastReconciledAt?: string;
  triggerType?: GatewayUsageSnapshotTrigger;
  summary: {
    cumulativeTokens: number;
    peakDailyTokens: number;
    currentMonthSpendUsd: number;
    monthlyBudgetUsd: number;
  };
  dailyUsage: GatewayAnalyticsDailyUsage[];
  tokenUsage: GatewayAnalyticsTokenUsage[];
};

export type GatewayModelOption = {
  id: string;
  displayName: string;
  capabilityAssessment?: WorkspaceModelCapabilityAssessment;
  pricing?: {
    currency: string;
    inputPerMillionTokens?: number;
    outputPerMillionTokens?: number;
    cacheReadPerMillionTokens?: number;
  };
};

export type GatewayAccessResponse = {
  source: {
    provider: "litellm";
    mode: "admin-api";
    fetchedAt: string;
    endpoints: string[];
    range?: {
      from: string;
      to: string;
    };
  };
  gatewayUrl: string;
  modelOptions?: GatewayModelOption[];
  tokens: GatewayAccessToken[];
  usage: GatewayUsageRollup[];
  series: GatewayUsageSeriesRow[];
  userLimit?: LiteLlmUserLimit;
  analytics?: GatewayUsageAnalytics;
  usageRefresh?: GatewayUsageRefreshRecommendation;
};

export type GatewayUsageRefreshResponse = {
  source: GatewayAccessResponse["source"];
  analytics: GatewayUsageAnalytics;
  usage: GatewayUsageRollup[];
  series: GatewayUsageSeriesRow[];
};

export type GatewayUsageSummary = {
  source: "snapshot";
  hasSnapshot: boolean;
  cumulativeTokens: number;
  updatedAt?: string;
  dataThroughAt?: string;
  lastRefreshRequestedAt?: string;
  refreshScheduled: boolean;
};

export type UsageBreakdownScope = "today" | "week" | "month" | "all" | "date";

export type UsageBreakdownTotals = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cacheRate: number | null;
  estimatedCostUsd: number;
};

export type UsageBreakdownModelRow = UsageBreakdownTotals & {
  model: string;
  displayName: string;
};

export type UsageBreakdownResponse = {
  source: GatewayAccessResponse["source"];
  scope: {
    type: UsageBreakdownScope;
    from: string;
    to: string;
  };
  selectedKey?: {
    id: string;
    name: string;
  };
  models: UsageBreakdownModelRow[];
  total: UsageBreakdownTotals;
};

export type TokenDraft = {
  name: string;
  monthlyBudgetPercent: string;
  usagePurpose: TokenUsagePurpose;
};

export type GatewayTokenTestResponse = {
  content: string;
  finishReason: string;
  latencyMs: number;
  model: string;
  raw: unknown;
  requestId: string;
  status: number;
  usage: {
    completionTokens: number;
    promptTokens: number;
    totalTokens: number;
  };
};

export type UsageSummary = {
  requests: number;
  billableUnits: number;
  estimatedCostUsd: number;
};

export type TokenUsageRow = {
  token: GatewayAccessToken;
  usage: UsageSummary;
};

export type DailyUsagePoint = {
  date: string;
  summary: UsageSummary;
};
