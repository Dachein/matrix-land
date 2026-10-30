import type {
  AdminGatewayData,
  AdminGatewayGroupBy,
  AdminGatewayToken,
  AdminGatewayUsageRollup,
  AdminGatewayUsageSeriesRow,
  AdminGatewayUserLimit,
  AdminTokenDraft,
  AdminUserLimitDraft
} from "./types";

export type AdminGatewayTotals = {
  requests: number;
  billableUnits: number;
  estimatedCostUsd: number;
  failedRequests: number;
};

export function summarizeAdminGateway(data: AdminGatewayData): AdminGatewayTotals {
  return data.usage.series.reduce((total, row) => ({
    requests: total.requests + row.requests,
    billableUnits: total.billableUnits + row.billableUnits,
    estimatedCostUsd: total.estimatedCostUsd + row.estimatedCostUsd,
    failedRequests: total.failedRequests + row.failedRequests + row.blockedRequests
  }), emptyTotals());
}

export function buildAdminGatewayDailySeries(rows: AdminGatewayUsageSeriesRow[]) {
  const byDay = new Map<string, AdminGatewayTotals>();

  rows.forEach((row) => {
    const day = row.periodStart.slice(0, 10);
    const current = byDay.get(day) ?? emptyTotals();
    byDay.set(day, {
      requests: current.requests + row.requests,
      billableUnits: current.billableUnits + row.billableUnits,
      estimatedCostUsd: current.estimatedCostUsd + row.estimatedCostUsd,
      failedRequests: current.failedRequests + row.failedRequests + row.blockedRequests
    });
  });

  return Array.from(byDay, ([date, totals]) => ({ date, ...totals }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function buildAdminGatewayBreakdown(rows: AdminGatewayUsageSeriesRow[], groupBy: AdminGatewayGroupBy) {
  const groups = new Map<string, AdminGatewayTotals>();
  for (const row of rows) {
    if (row.groupType !== groupBy) continue;
    const current = groups.get(row.groupId) ?? emptyTotals();
    groups.set(row.groupId, {
      requests: current.requests + row.requests,
      billableUnits: current.billableUnits + row.billableUnits,
      estimatedCostUsd: current.estimatedCostUsd + row.estimatedCostUsd,
      failedRequests: current.failedRequests + row.failedRequests + row.blockedRequests
    });
  }
  return Array.from(groups, ([groupId, totals]) => ({ groupId, ...totals }))
    .sort((left, right) => right.requests - left.requests || left.groupId.localeCompare(right.groupId));
}

export function usageByToken(usage: AdminGatewayUsageRollup[]) {
  return new Map(usage
    .filter((row) => row.scopeType === "token")
    .map((row) => [row.scopeId, row]));
}

export function tokenDraft(token: AdminGatewayToken): AdminTokenDraft {
  return {
    name: token.name,
    monthlyBudgetUsd: positiveString(token.monthlyBudgetUsd),
    requestLimitPerMinute: positiveString(token.requestLimitPerMinute),
    tokensPerMinute: positiveString(token.tokensPerMinute),
    allowedModels: (token.allowedModels ?? []).join("\n")
  };
}

export function userLimitDraft(limit: AdminGatewayUserLimit): AdminUserLimitDraft {
  return {
    monthlyBudgetUsd: positiveString(limit.monthlyBudgetUsd),
    requestLimitPerMinute: positiveString(limit.requestLimitPerMinute),
    tokensPerMinute: positiveString(limit.tokensPerMinute),
    allowedModels: (limit.allowedModels ?? []).join("\n")
  };
}

export function tokenFingerprint(token: Pick<AdminGatewayToken, "id" | "tokenPrefix" | "tokenLast4">) {
  if (token.tokenPrefix && token.tokenLast4) {
    return `${token.tokenPrefix}...${token.tokenLast4}`;
  }
  return token.id.length > 14 ? `${token.id.slice(0, 10)}...${token.id.slice(-4)}` : token.id;
}

function positiveString(value: number | undefined) {
  return value && value > 0 ? String(value) : "";
}

function emptyTotals(): AdminGatewayTotals {
  return {
    requests: 0,
    billableUnits: 0,
    estimatedCostUsd: 0,
    failedRequests: 0
  };
}
