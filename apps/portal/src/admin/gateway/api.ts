import type {
  AdminGatewayAllocationResponse,
  AdminGatewayData,
  AdminGatewayGroupBy,
  AdminGatewayUsageResponse,
  AdminTokenDraft,
  AdminUserLimitDraft
} from "./types";

type Fetcher = typeof fetch;

export async function loadAdminGatewayData({
  fetcher = fetch,
  from,
  groupBy,
  to
}: {
  fetcher?: Fetcher;
  from: string;
  groupBy: AdminGatewayGroupBy;
  to: string;
}): Promise<AdminGatewayData> {
  const [allocations, usage] = await Promise.all([
    loadAdminGatewayAllocations({ fetcher }),
    loadAdminGatewayUsage({ fetcher, from, groupBy, to })
  ]);

  return { allocations, usage };
}

export async function loadAdminGatewayAllocations({
  fetcher = fetch
}: {
  fetcher?: Fetcher;
}) {
  const allocations = await requestJson<AdminGatewayAllocationResponse>(
    fetcher,
    "/api/llm-gateway/admin/allocations"
  );
  requireLiteLlmSource(allocations.source);
  return allocations;
}

export async function loadAdminGatewayUsage({
  fetcher = fetch,
  from,
  groupBy,
  to
}: {
  fetcher?: Fetcher;
  from: string;
  groupBy: AdminGatewayGroupBy;
  to: string;
}) {
  const usageSearch = new URLSearchParams({ from, to, groupBy });
  const usage = await requestJson<AdminGatewayUsageResponse>(
    fetcher,
    `/api/llm-gateway/admin/usage?${usageSearch.toString()}`
  );
  requireLiteLlmSource(usage.source);
  return usage;
}

export async function updateAdminGatewayToken(tokenId: string, draft: AdminTokenDraft, fetcher: Fetcher = fetch) {
  return requestJson(fetcher, `/api/llm-gateway/admin/tokens/${encodeURIComponent(tokenId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: draft.name.trim(),
      monthlyBudgetUsd: parseLimit(draft.monthlyBudgetUsd),
      requestLimitPerMinute: parseNullableLimit(draft.requestLimitPerMinute),
      tokensPerMinute: parseNullableLimit(draft.tokensPerMinute),
      allowedModels: parseModelList(draft.allowedModels)
    })
  });
}

export async function setAdminGatewayTokenStatus(tokenId: string, status: "active" | "suspended", fetcher: Fetcher = fetch) {
  const action = status === "active" ? "activate" : "suspend";
  return requestJson(fetcher, `/api/llm-gateway/admin/tokens/${encodeURIComponent(tokenId)}/${action}`, {
    method: "POST"
  });
}

export async function deleteAdminGatewayToken(tokenId: string, fetcher: Fetcher = fetch) {
  return requestJson(fetcher, `/api/llm-gateway/admin/tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE"
  });
}

export async function updateAdminGatewayUserLimit(userId: string, draft: AdminUserLimitDraft, fetcher: Fetcher = fetch) {
  const requestLimitPerMinute = parseOptionalLimit(draft.requestLimitPerMinute);
  const tokensPerMinute = parseOptionalLimit(draft.tokensPerMinute);

  return requestJson(fetcher, "/api/llm-gateway/admin/allocations/user-limits", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      targetType: "user",
      targetId: userId,
      monthlyBudgetUsd: parseLimit(draft.monthlyBudgetUsd),
      ...(requestLimitPerMinute === undefined ? {} : { requestLimitPerMinute }),
      ...(tokensPerMinute === undefined ? {} : { tokensPerMinute }),
      allowedModels: parseModelList(draft.allowedModels)
    })
  });
}

export async function createAdminUsageExportLink({
  fetcher = fetch,
  from,
  to
}: {
  fetcher?: Fetcher;
  from: string;
  to: string;
}) {
  return requestJson<{ url: string; expiresAt: string }>(fetcher, "/api/llm-gateway/admin/usage/export-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, to })
  });
}

function requireLiteLlmSource(source: unknown) {
  if (!source || typeof source !== "object" || (source as { provider?: unknown }).provider !== "litellm") {
    throw new Error("admin_gateway_source_not_litellm");
  }
}

async function requestJson<T = unknown>(fetcher: Fetcher, input: string, init?: RequestInit): Promise<T> {
  const response = await fetcher(input, init);
  const payload = await response.json().catch(() => undefined) as T | { error?: string } | undefined;

  if (!response.ok || payload === undefined) {
    const errorCode = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new Error(errorCode || `admin_gateway_request_failed_${response.status}`);
  }

  return payload as T;
}

function parseModelList(value: string) {
  return Array.from(new Set(value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)));
}

function parseLimit(value: string) {
  const number = Number(value.trim() || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function parseOptionalLimit(value: string) {
  const normalized = value.trim();
  const number = Number(normalized);
  return normalized && Number.isFinite(number) && number > 0 ? number : undefined;
}

function parseNullableLimit(value: string) {
  return parseOptionalLimit(value) ?? null;
}
