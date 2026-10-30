export type LiteLlmSource = {
  provider: "litellm";
  mode: "admin-api";
  fetchedAt: string;
  endpoints: string[];
  range?: {
    from: string;
    to: string;
  };
};

export type AdminGatewayToken = {
  id: string;
  name: string;
  tokenPrefix?: string;
  tokenLast4?: string;
  status: string;
  accessStatus?: string;
  accessReason?: string;
  externalUserId?: string;
  allowedModels?: string[];
  monthlyBudgetUsd: number;
  requestLimitPerMinute?: number;
  tokensPerMinute?: number;
  createdAt: string;
  lastUsedAt?: string;
};

export type AdminGatewayUserLimit = {
  id: string;
  userId: string;
  status: string;
  allowedModels?: string[];
  requestLimitPerMinute: number;
  tokensPerMinute: number;
  monthlyBudgetUsd: number;
  updatedAt?: string;
};

export type AdminGatewayUsageRollup = {
  id: string;
  scopeType: string;
  scopeId: string;
  requests: number;
  blockedRequests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  billableUnits: number;
  estimatedCostUsd: number;
};

export type AdminGatewayUsageSeriesRow = {
  periodStart: string;
  groupType: string;
  groupId: string;
  requests: number;
  blockedRequests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  billableUnits: number;
  estimatedCostUsd: number;
};

export type AdminGatewayRequest = {
  id?: string;
  request_id?: string;
  token_id?: string;
  external_user_id?: string;
  provider?: string;
  model?: string;
  status?: string;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  billable_units?: number;
  estimated_cost_usd?: number;
  latency_ms?: number;
  created_at?: string;
};

export type AdminGatewayAllocationResponse = {
  source: LiteLlmSource;
  gatewayUrl: string;
  tokens: AdminGatewayToken[];
  userLimits: AdminGatewayUserLimit[];
  usage: AdminGatewayUsageRollup[];
  modelOptions: Array<{
    id: string;
    displayName: string;
  }>;
};

export type AdminGatewayUsageResponse = {
  source: LiteLlmSource;
  usage: AdminGatewayUsageRollup[];
  requests: AdminGatewayRequest[];
  requestTotal: number;
  series: AdminGatewayUsageSeriesRow[];
  tokens: AdminGatewayToken[];
};

export type AdminGatewayData = {
  allocations: AdminGatewayAllocationResponse;
  usage: AdminGatewayUsageResponse;
};

export type AdminGatewayViewData = Partial<AdminGatewayData>;

export type AdminGatewaySection = "tokens" | "allocations" | "usage";
export type AdminGatewayGroupBy = "model" | "provider" | "user" | "token";

export type AdminTokenDraft = {
  name: string;
  monthlyBudgetUsd: string;
  requestLimitPerMinute: string;
  tokensPerMinute: string;
  allowedModels: string;
};

export type AdminUserLimitDraft = {
  monthlyBudgetUsd: string;
  requestLimitPerMinute: string;
  tokensPerMinute: string;
  allowedModels: string;
};
