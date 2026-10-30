import type { CSSProperties } from "react";
import type { PortalCatalog } from "../../shared/types";
import type {
  DailyUsagePoint,
  GatewayAnalyticsDailyUsage,
  GatewayAnalyticsTokenUsage,
  GatewayAccessResponse,
  GatewayAccessToken,
  GatewayModelOption,
  LiteLlmUserLimit,
  GatewayUsageRollup,
  GatewayUsageSeriesRow,
  TokenDraft,
  TokenUsageRow,
  UsageSummary
} from "./types";

export const GATEWAY_TOKEN_NAME_MAX_LENGTH = 120;
export const GATEWAY_TOKEN_NAME_INPUT_PATTERN = "[A-Za-z0-9][A-Za-z0-9_\\/.@\\-]{0,118}[A-Za-z0-9]";

const GATEWAY_TOKEN_NAME_PATTERN = new RegExp(`^${GATEWAY_TOKEN_NAME_INPUT_PATTERN}$`);
const DEFAULT_TOKEN_NAME_SUFFIX_LENGTH = "-app-YYYYMMDD-HHmm".length;

export const emptyTokenDraft: TokenDraft = {
  name: "",
  monthlyBudgetPercent: "100",
  usagePurpose: "agent"
};

export function buildDefaultGatewayTokenName(email: string, now = new Date()) {
  const localPart = email.trim().split("@", 1)[0] ?? "";
  const firstSegment = localPart.split(".", 1)[0] ?? "";
  const prefix = firstSegment
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, GATEWAY_TOKEN_NAME_MAX_LENGTH - DEFAULT_TOKEN_NAME_SUFFIX_LENGTH) || "user";
  const timestamp = shanghaiTimestamp(now);

  return `${prefix}-app-${timestamp}`;
}

export function isGatewayTokenNameValid(value: string) {
  return value.length <= GATEWAY_TOKEN_NAME_MAX_LENGTH && GATEWAY_TOKEN_NAME_PATTERN.test(value);
}

export function payloadFromDraft(draft: TokenDraft) {
  return {
    name: draft.name.trim(),
    monthlyBudgetPercent: readPercentDraft(draft.monthlyBudgetPercent),
    usagePurpose: draft.usagePurpose
  };
}

export function draftFromToken(token: GatewayAccessToken): TokenDraft {
  return {
    name: token.name,
    monthlyBudgetPercent: String(token.monthlyBudgetPercent || 100),
    usagePurpose: token.usagePurpose || "agent"
  };
}

export function summarizeMonthlyRollups(usage: GatewayUsageRollup[]) {
  return usage
    .filter((item) => item.periodType === "month")
    .reduce((total, item) => ({
      requests: total.requests + item.requests,
      billableUnits: total.billableUnits + item.billableUnits,
      estimatedCostUsd: total.estimatedCostUsd + item.estimatedCostUsd
    }), emptyUsageSummary());
}

export function summarizeSeries(series: GatewayUsageSeriesRow[]) {
  return series.reduce((total, row) => ({
    requests: total.requests + row.requests,
    billableUnits: total.billableUnits + row.billableUnits,
    estimatedCostUsd: total.estimatedCostUsd + row.estimatedCostUsd
  }), emptyUsageSummary());
}

export function buildTokenRows(tokens: GatewayAccessToken[], series: GatewayUsageSeriesRow[]): TokenUsageRow[] {
  const usageByToken = new Map<string, UsageSummary>();

  for (const row of series) {
    const current = usageByToken.get(row.groupId) ?? emptyUsageSummary();
    usageByToken.set(row.groupId, {
      requests: current.requests + row.requests,
      billableUnits: current.billableUnits + row.billableUnits,
      estimatedCostUsd: current.estimatedCostUsd + row.estimatedCostUsd
    });
  }

  return tokens.map((token) => ({
    token,
    usage: usageByToken.get(token.id) ?? emptyUsageSummary()
  })).sort((left, right) => right.usage.estimatedCostUsd - left.usage.estimatedCostUsd);
}

export function buildTokenRowsFromAnalytics(
  tokens: GatewayAccessToken[],
  analyticsUsage: GatewayAnalyticsTokenUsage[]
): TokenUsageRow[] {
  const usageByToken = new Map(analyticsUsage.map((row) => [row.tokenId, {
    requests: finiteNonNegative(row.requests),
    billableUnits: finiteNonNegative(row.tokens),
    estimatedCostUsd: finiteNonNegative(row.estimatedCostUsd)
  }]));

  return tokens.map((token) => ({
    token,
    usage: usageByToken.get(token.id) ?? emptyUsageSummary()
  })).sort((left, right) => right.usage.estimatedCostUsd - left.usage.estimatedCostUsd);
}

export function applyGatewayTokenRotation(
  access: GatewayAccessResponse,
  previousTokenId: string,
  tokenRecord: GatewayAccessToken,
  keepPreviousGeneration = false
): GatewayAccessResponse {
  if (keepPreviousGeneration) {
    return {
      ...access,
      tokens: access.tokens.some((token) => token.id === tokenRecord.id)
        ? access.tokens
        : [...access.tokens, tokenRecord]
    };
  }

  const replacedTokens = access.tokens.map((token) => token.id === previousTokenId ? tokenRecord : token);
  const tokens = replacedTokens.some((token) => token.id === tokenRecord.id)
    ? replacedTokens
    : [...replacedTokens, tokenRecord];
  const remapTokenId = (tokenId: string) => tokenId === previousTokenId ? tokenRecord.id : tokenId;

  return {
    ...access,
    tokens,
    usage: access.usage.map((row) => row.scopeType === "token"
      ? { ...row, scopeId: remapTokenId(row.scopeId) }
      : row),
    series: access.series.map((row) => row.groupType === "token"
      ? { ...row, groupId: remapTokenId(row.groupId) }
      : row),
    analytics: access.analytics ? {
      ...access.analytics,
      tokenUsage: mergeAnalyticsTokenUsage(access.analytics.tokenUsage, previousTokenId, tokenRecord.id)
    } : undefined
  };
}

export function buildDailyUsage(series: GatewayUsageSeriesRow[]): DailyUsagePoint[] {
  const usageByDay = new Map<string, UsageSummary>();

  for (const row of series) {
    const date = row.periodStart.slice(0, 10);
    const current = usageByDay.get(date) ?? emptyUsageSummary();
    usageByDay.set(date, {
      requests: current.requests + row.requests,
      billableUnits: current.billableUnits + row.billableUnits,
      estimatedCostUsd: current.estimatedCostUsd + row.estimatedCostUsd
    });
  }

  return dateKeysThisMonth().map((date) => ({
    date,
    summary: usageByDay.get(date) ?? emptyUsageSummary()
  }));
}

export function buildAnnualDailyUsage(
  usage: GatewayAnalyticsDailyUsage[],
  dataThroughDate?: string
): DailyUsagePoint[] {
  const usageByDay = new Map<string, UsageSummary>();

  for (const row of usage) {
    if (!isDateKey(row.date)) {
      continue;
    }
    const current = usageByDay.get(row.date) ?? emptyUsageSummary();
    usageByDay.set(row.date, {
      requests: current.requests + finiteNonNegative(row.requests),
      billableUnits: current.billableUnits + finiteNonNegative(row.tokens),
      estimatedCostUsd: current.estimatedCostUsd + finiteNonNegative(row.estimatedCostUsd)
    });
  }

  return annualDateKeys(normalizeDataThroughDate(dataThroughDate)).map((date) => ({
    date,
    summary: usageByDay.get(date) ?? emptyUsageSummary()
  }));
}

export function buildAnnualDailyUsageFromSeries(
  series: GatewayUsageSeriesRow[],
  dataThroughDate?: string
) {
  return buildAnnualDailyUsage(series.map((row) => ({
    date: row.periodStart.slice(0, 10),
    tokens: row.billableUnits,
    requests: row.requests,
    estimatedCostUsd: row.estimatedCostUsd
  })), dataThroughDate);
}

export function peakDailyTokens(points: DailyUsagePoint[]) {
  return Math.max(0, ...points.map((point) => finiteNonNegative(point.summary.billableUnits)));
}

export function usageIntensityLevel(tokens: number, peakTokens: number) {
  const normalizedTokens = finiteNonNegative(tokens);
  const normalizedPeak = finiteNonNegative(peakTokens);
  if (normalizedTokens <= 0 || normalizedPeak <= 0) {
    return 0;
  }

  const logarithmicRatio = Math.log1p(normalizedTokens) / Math.log1p(normalizedPeak);
  return Math.min(4, Math.max(1, Math.ceil(logarithmicRatio * 4)));
}

export function latestCompleteShanghaiDate(now = new Date()) {
  const today = dateKeyAsUtc(shanghaiDateKey(now));
  today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);
}

export function emptyUsageSummary(): UsageSummary {
  return { requests: 0, billableUnits: 0, estimatedCostUsd: 0 };
}

export function gatewayModelOptions(access: GatewayAccessResponse | undefined): GatewayModelOption[] {
  return uniqueModelOptions(access?.modelOptions ?? []);
}

export function effectiveMonthlyBudgetUsd(userLimit: LiteLlmUserLimit | undefined, _user: PortalCatalog["currentUser"]) {
  return userLimit?.monthlyBudgetUsd ?? 0;
}

export function budgetUsagePercent(cost: number, budget: number) {
  if (budget <= 0) {
    return 0;
  }

  return Math.min(999, Math.round((cost / budget) * 100));
}

export function budgetPercentLabel(value: string, monthlyBudgetUsd: number, copy: { of: string; perMonth: string } = { of: "of", perMonth: "/mo" }) {
  const percent = readPercentDraft(value);

  if (monthlyBudgetUsd <= 0) {
    return `${percent}%`;
  }

  return `${percent}% · ${formatUsd((monthlyBudgetUsd * percent) / 100)} ${copy.of} ${formatUsd(monthlyBudgetUsd)}${copy.perMonth}`;
}

export function budgetRangeStyle(value: string) {
  return { "--budget-percent": `${readPercentDraft(value)}%` } as CSSProperties;
}

export function currentMonthLabel(locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date());
}

export function formatNumber(value: number) {
  return Math.round(value).toLocaleString();
}

export function formatCompactTokens(value: number, locale: string) {
  const parts = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    notation: "compact"
  }).formatToParts(Math.round(finiteNonNegative(value)));
  const compactUnit = parts.find((part) => part.type === "compact")?.value;
  const amount = parts
    .filter((part) => part.type !== "compact")
    .map((part) => part.value)
    .join("")
    .trim();

  if (!compactUnit) {
    return amount;
  }

  if (locale.toLowerCase().startsWith("zh")) {
    return `${amount}${compactUnit}`;
  }

  return `${amount} ${compactUnit === "B" ? "Billion" : compactUnit}`;
}

export function formatUsd(value: number) {
  const normalized = Number.isFinite(value) ? value : 0;
  return `$${normalized.toLocaleString(undefined, { maximumFractionDigits: normalized >= 1 ? 2 : 4, minimumFractionDigits: normalized > 0 && normalized < 1 ? 4 : 0 })}`;
}

export function formatDate(value: string, locale: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(timestamp) : value;
}

export function formatDateOnly(value: string, locale: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(timestamp) : value;
}

function uniqueModelOptions(models: GatewayModelOption[]) {
  const seen = new Set<string>();
  const normalized: GatewayModelOption[] = [];

  for (const model of models) {
    const id = model.id.trim();

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    normalized.push({
      id,
      displayName: model.displayName.trim() || id,
      ...(model.capabilityAssessment ? { capabilityAssessment: model.capabilityAssessment } : {}),
      ...(model.pricing ? {
        pricing: {
          currency: model.pricing.currency.trim().toUpperCase() || "USD",
          ...(finiteModelPrice(model.pricing.inputPerMillionTokens) !== undefined
            ? { inputPerMillionTokens: finiteModelPrice(model.pricing.inputPerMillionTokens) }
            : {}),
          ...(finiteModelPrice(model.pricing.outputPerMillionTokens) !== undefined
            ? { outputPerMillionTokens: finiteModelPrice(model.pricing.outputPerMillionTokens) }
            : {}),
          ...(finiteModelPrice(model.pricing.cacheReadPerMillionTokens) !== undefined
            ? { cacheReadPerMillionTokens: finiteModelPrice(model.pricing.cacheReadPerMillionTokens) }
            : {})
        }
      } : {})
    });
  }

  return normalized;
}

function finiteModelPrice(value: number | undefined) {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function readPercentDraft(value: string) {
  const number = Number(value || 100);
  return Number.isFinite(number) ? Math.max(1, Math.min(100, Math.round(number))) : 100;
}

function dateKeysThisMonth() {
  const now = new Date();
  const cursor = new Date(now.getFullYear(), now.getMonth(), 1);
  const dates: string[] = [];

  while (cursor <= now && dates.length < 31) {
    dates.push(dateInputValue(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function dateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function annualDateKeys(endDate: string) {
  const end = dateKeyAsUtc(endDate);
  const dates: string[] = [];

  for (let offset = 364; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - offset);
    dates.push(date.toISOString().slice(0, 10));
  }

  return dates;
}

function normalizeDataThroughDate(value: string | undefined) {
  if (isDateKey(value)) {
    return value;
  }
  return latestCompleteShanghaiDate();
}

function dateKeyAsUtc(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = dateKeyAsUtc(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString().slice(0, 10) === value;
}

function shanghaiDateKey(date: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric"
  }).formatToParts(date).map((part) => [part.type, part.value]));

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function finiteNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function mergeAnalyticsTokenUsage(
  usage: GatewayAnalyticsTokenUsage[],
  previousTokenId: string,
  currentTokenId: string
) {
  const merged = new Map<string, GatewayAnalyticsTokenUsage>();

  for (const row of usage) {
    const tokenId = row.tokenId === previousTokenId ? currentTokenId : row.tokenId;
    const current = merged.get(tokenId) ?? { tokenId, tokens: 0, requests: 0, estimatedCostUsd: 0 };
    merged.set(tokenId, {
      tokenId,
      tokens: current.tokens + finiteNonNegative(row.tokens),
      requests: current.requests + finiteNonNegative(row.requests),
      estimatedCostUsd: current.estimatedCostUsd + finiteNonNegative(row.estimatedCostUsd)
    });
  }

  return Array.from(merged.values());
}

function shanghaiTimestamp(date: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric"
  }).formatToParts(date).map((part) => [part.type, part.value]));

  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
}
