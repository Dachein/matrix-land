import type { PortalCatalog } from "../../../src/shared/types.ts";
import {
  DEFAULT_LLM_GATEWAY_RPM_LIMIT,
  DEFAULT_LLM_GATEWAY_TPM_LIMIT,
  LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION,
  shouldRepairLlmGatewayTpmLimit
} from "../../../src/shared/llmGatewayLimits.ts";
import {
  readMoneyLimit,
  sanitizeAllowedModels,
} from "./normalizers.ts";
import {
  liteLlmDataSource,
  liteLlmUserInfoObject,
  normalizeLiteLlmKeys,
  normalizeLiteLlmModelOptions,
  normalizeLiteLlmUserLimit,
  readLiteLlmDataArray
} from "./litellm.ts";
import { syncLiteLlmTokenBudgetsForUser } from "./userBudgets.ts";

type CurrentUser = PortalCatalog["currentUser"];

type LlmGatewayAdminAllocationsEnv = {
  DB?: D1Database;
  LITELLM_URL?: string;
};

type LlmGatewayAdminAllocationsContext<TEnv extends LlmGatewayAdminAllocationsEnv> = EventContext<TEnv, string, unknown>;

type LlmGatewayAdminAllocationsDeps<TEnv extends LlmGatewayAdminAllocationsEnv> = {
  adminJson<T = unknown>(context: LlmGatewayAdminAllocationsContext<TEnv>, gatewayPath: string, init?: { method?: string; body?: unknown }): Promise<T>;
  baseUrl(env: TEnv): string;
  httpError(status: number, message: string): Error;
  json(body: unknown, init?: ResponseInit): Response;
  readBody<T>(request: Request): Promise<T>;
  requireAdminPortalUser(context: LlmGatewayAdminAllocationsContext<TEnv>): Promise<CurrentUser>;
  requireText(value: unknown, errorCode: string, maxLength: number): string;
};

export function createLlmGatewayAdminAllocationsApi<TEnv extends LlmGatewayAdminAllocationsEnv>(deps: LlmGatewayAdminAllocationsDeps<TEnv>) {
  return {
    async getAdminAllocations(context: LlmGatewayAdminAllocationsContext<TEnv>) {
      const totalStartedAt = Date.now();
      const authStartedAt = Date.now();
      await deps.requireAdminPortalUser(context);
      const authDuration = Date.now() - authStartedAt;
      const keysPath = "/key/list?return_full_object=true&size=100";
      const usersPath = "/user/list?page=1&page_size=100";
      const modelsPath = "/v1/model/info";

      const dataStartedAt = Date.now();
      const [tokensPayload, usersPayload, modelInfoPayload] = await Promise.all([
        readAdminInventory(context, deps, "keys", keysPath),
        readAdminInventory(context, deps, "users", usersPath),
        deps.adminJson<{ data?: unknown[] }>(context, modelsPath)
      ]);
      const dataDuration = Date.now() - dataStartedAt;
      const tokens = normalizeLiteLlmKeys(tokensPayload.rows);
      const userLimits = normalizeLiteLlmUsers(usersPayload.rows)
        .map((user) => normalizeLiteLlmUserLimit(user.userId, user.raw));

      const responseBody = {
        source: liteLlmDataSource(
          [...tokensPayload.endpoints, ...usersPayload.endpoints, modelsPath]
        ),
        gatewayUrl: deps.baseUrl(context.env),
        tokens,
        userLimits,
        usage: [],
        modelOptions: normalizeLiteLlmModelOptions(readLiteLlmDataArray(modelInfoPayload))
      };
      const totalDuration = Date.now() - totalStartedAt;

      return deps.json(responseBody, {
        headers: {
          "cache-control": "no-store",
          "server-timing": `auth;dur=${authDuration}, data;dur=${dataDuration}, total;dur=${totalDuration}`
        }
      });
    },

    async upsertAdminUserLimit(context: LlmGatewayAdminAllocationsContext<TEnv>) {
      await deps.requireAdminPortalUser(context);

      const body = await deps.readBody<{
        targetType?: string;
        targetId?: string;
        status?: string;
        allowedModels?: string[];
        requestLimitPerMinute?: number | null;
        tokensPerMinute?: number | null;
        monthlyBudgetUsd?: number;
      }>(context.request);
      const targetType = normalizeAdminAllocationTarget(body.targetType, deps);
      const targetId = normalizeLiteLlmUserId(deps.requireText(body.targetId, "missing_target_id", 240));

      if (targetType !== "user") {
        throw deps.httpError(400, "litellm_user_allocation_only");
      }

      const monthlyBudgetUsd = requirePositiveMoneyLimit(body.monthlyBudgetUsd, deps);
      const existing = await ensureLiteLlmUser(context, targetId, monthlyBudgetUsd, deps);
      const existingLimit = normalizeLiteLlmUserLimit(targetId, existing);
      const existingUserInfo = liteLlmUserInfoObject(existing);
      const existingMetadata = readRecord(existingUserInfo.metadata);
      const existingWorkspaceMetadata = readRecord(existingMetadata.workspace);
      const allowedModels = sanitizeAllowedModels(body.allowedModels);
      const requestLimitPerMinute = readOptionalLimitNumber(body.requestLimitPerMinute)
        ?? readOptionalLimitNumber(existingLimit.requestLimitPerMinute)
        ?? DEFAULT_LLM_GATEWAY_RPM_LIMIT;
      const requestedTokensPerMinute = readOptionalLimitNumber(body.tokensPerMinute);
      const tokensPerMinute = requestedTokensPerMinute
        ?? (shouldRepairLlmGatewayTpmLimit(
          existingLimit.tokensPerMinute,
          existingWorkspaceMetadata.rateLimitRepairVersion
        )
          ? DEFAULT_LLM_GATEWAY_TPM_LIMIT
          : readOptionalLimitNumber(existingLimit.tokensPerMinute))
        ?? DEFAULT_LLM_GATEWAY_TPM_LIMIT;
      const payload = {
        user_id: targetId,
        user_email: targetId,
        user_role: "internal_user",
        max_budget: monthlyBudgetUsd,
        models: allowedModels.length > 0 ? allowedModels : existingLimit.allowedModels,
        rpm_limit: requestLimitPerMinute,
        tpm_limit: tokensPerMinute,
        budget_duration: "30d",
        metadata: {
          ...existingMetadata,
          workspace: {
            ...existingWorkspaceMetadata,
            allocationUpdatedVia: "workspace-portal",
            budgetManagedBy: "admin",
            manualMonthlyBudgetUsd: monthlyBudgetUsd,
            rateLimitRepairVersion: LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION
          }
        }
      };
      const updated = await deps.adminJson(context, "/user/update", {
        method: "POST",
        body: payload
      });

      await syncLiteLlmTokenBudgetsForUser(context, targetId, monthlyBudgetUsd, deps);

      return deps.json(normalizeLiteLlmUserLimit(targetId, updated));
    },

    async updateAdminToken(context: LlmGatewayAdminAllocationsContext<TEnv>, tokenId: string) {
      await deps.requireAdminPortalUser(context);
      const key = deps.requireText(tokenId, "missing_gateway_token_id", 240);
      const body = await deps.readBody<{
        name?: string;
        allowedModels?: string[];
        monthlyBudgetUsd?: number;
        requestLimitPerMinute?: number | null;
        tokensPerMinute?: number | null;
      }>(context.request);
      const payload: Record<string, unknown> = { key };

      if (body.name !== undefined) {
        payload.key_alias = deps.requireText(body.name, "missing_gateway_token_name", 120);
      }
      if (body.allowedModels !== undefined) {
        payload.models = sanitizeAllowedModels(body.allowedModels);
      }
      if (body.monthlyBudgetUsd !== undefined) {
        payload.max_budget = readMoneyLimit(body.monthlyBudgetUsd);
      }
      if (body.requestLimitPerMinute !== undefined) {
        payload.rpm_limit = readNullableLimitNumber(body.requestLimitPerMinute);
      }
      if (body.tokensPerMinute !== undefined) {
        payload.tpm_limit = readNullableLimitNumber(body.tokensPerMinute);
      }

      if (Object.keys(payload).length === 1) {
        throw deps.httpError(400, "missing_gateway_token_updates");
      }

      const updated = await deps.adminJson(context, "/key/update", {
        method: "POST",
        body: payload
      });

      return deps.json(updated);
    },

    async suspendAdminToken(context: LlmGatewayAdminAllocationsContext<TEnv>, tokenId: string) {
      await deps.requireAdminPortalUser(context);
      const key = deps.requireText(tokenId, "missing_gateway_token_id", 240);
      const result = await deps.adminJson(context, "/key/block", {
        method: "POST",
        body: { key }
      });
      return deps.json(result);
    },

    async activateAdminToken(context: LlmGatewayAdminAllocationsContext<TEnv>, tokenId: string) {
      await deps.requireAdminPortalUser(context);
      const key = deps.requireText(tokenId, "missing_gateway_token_id", 240);
      const result = await deps.adminJson(context, "/key/unblock", {
        method: "POST",
        body: { key }
      });
      return deps.json(result);
    },

    async deleteAdminToken(context: LlmGatewayAdminAllocationsContext<TEnv>, tokenId: string) {
      await deps.requireAdminPortalUser(context);
      const key = deps.requireText(tokenId, "missing_gateway_token_id", 240);
      const result = await deps.adminJson(context, "/key/delete", {
        method: "POST",
        body: { keys: [key], reason: "admin_revoke" }
      });
      return deps.json(result);
    }
  };
}

async function ensureLiteLlmUser<TEnv extends LlmGatewayAdminAllocationsEnv>(
  context: LlmGatewayAdminAllocationsContext<TEnv>,
  userId: string,
  monthlyBudgetUsd: number,
  deps: Pick<LlmGatewayAdminAllocationsDeps<TEnv>, "adminJson">
) {
  try {
    return await deps.adminJson<Record<string, unknown>>(context, `/user/info?user_id=${encodeURIComponent(userId)}`);
  } catch (error) {
    if (!isHttpStatus(error, 404)) {
      throw error;
    }
  }

  return await deps.adminJson<Record<string, unknown>>(context, "/user/new", {
    method: "POST",
    body: {
      user_id: userId,
      user_email: userId,
      user_role: "internal_user",
      auto_create_key: false,
      max_budget: monthlyBudgetUsd,
      rpm_limit: DEFAULT_LLM_GATEWAY_RPM_LIMIT,
      tpm_limit: DEFAULT_LLM_GATEWAY_TPM_LIMIT,
      budget_duration: "30d",
      metadata: {
        workspace: {
          allocationUpdatedVia: "workspace-portal",
          budgetManagedBy: "admin",
          manualMonthlyBudgetUsd: monthlyBudgetUsd,
          rateLimitRepairVersion: LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION
        }
      }
    }
  });
}

function normalizeAdminAllocationTarget<TEnv extends LlmGatewayAdminAllocationsEnv>(
  value: unknown,
  deps: Pick<LlmGatewayAdminAllocationsDeps<TEnv>, "httpError">
) {
  const targetType = readString(value);

  if (targetType === "user" || targetType === "team" || targetType === "default") {
    return targetType;
  }

  return "user";
}

function readOptionalLimitNumber(value: unknown) {
  const number = Number(value);

  if (value === undefined || value === null || !Number.isFinite(number) || number <= 0) {
    return undefined;
  }

  return Math.min(Math.round(number), 1_000_000_000);
}

function readNullableLimitNumber(value: unknown) {
  return readOptionalLimitNumber(value) ?? null;
}

function requirePositiveMoneyLimit<TEnv extends LlmGatewayAdminAllocationsEnv>(
  value: unknown,
  deps: Pick<LlmGatewayAdminAllocationsDeps<TEnv>, "httpError">
) {
  const monthlyBudgetUsd = readMoneyLimit(value);

  if (monthlyBudgetUsd <= 0) {
    throw deps.httpError(400, "invalid_monthly_budget_usd");
  }

  return monthlyBudgetUsd;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeLiteLlmUsers(users: unknown[]) {
  return users.map((raw) => {
    const info = liteLlmUserInfoObject(raw);
    return {
      raw,
      userId: normalizeLiteLlmUserId(readString(info.user_id))
    };
  }).filter((user) => user.userId && user.userId !== "default_user_id");
}

function normalizeLiteLlmUserId(value: string) {
  return value.trim().toLowerCase();
}

function isHttpStatus(error: unknown, status: number) {
  return typeof error === "object" && error !== null && "status" in error && Number((error as { status?: unknown }).status) === status;
}

async function readAdminInventory<TEnv extends LlmGatewayAdminAllocationsEnv>(
  context: LlmGatewayAdminAllocationsContext<TEnv>,
  deps: Pick<LlmGatewayAdminAllocationsDeps<TEnv>, "adminJson" | "httpError">,
  collection: "keys" | "users",
  firstPath: string
) {
  const rows: unknown[] = [];
  const seen = new Set<string>();
  const endpoints: string[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const path = page === 1 ? firstPath : collection === "keys"
      ? `/key/list?return_full_object=true&size=100&page=${page}`
      : `/user/list?page=${page}&page_size=100`;
    const payload = await deps.adminJson<Record<string, unknown>>(context, path);
    if (!payload || typeof payload !== "object") throw deps.httpError(502, `litellm_${collection}_list_invalid_payload`);
    const items = payload[collection] ?? payload.data;
    if (!Array.isArray(items)) throw deps.httpError(502, `litellm_${collection}_list_invalid_payload`);
    endpoints.push(path);
    const previousSize = rows.length;
    for (const item of items) {
      const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const id = collection === "keys"
        ? row.token_hash ?? row.key_hash ?? row.api_key ?? row.token_id ?? row.key ?? row.token
        : row.user_id ?? row.id;
      const identity = id ? String(id) : JSON.stringify(item);
      if (!seen.has(identity)) { seen.add(identity); rows.push(item); }
    }
    const totalPages = Number(payload.total_pages ?? payload.totalPages ?? payload.pages);
    const totalRows = Number(payload.total_count ?? payload.totalCount ?? payload.total ?? (collection === "users" ? payload.total_users : undefined));
    const explicit = payload.has_more ?? payload.hasMore;
    const hasMore = typeof explicit === "boolean" ? explicit
      : Number.isFinite(totalPages) && totalPages > 0 ? page < totalPages
      : Number.isFinite(totalRows) && totalRows >= 0 ? page * 100 < totalRows
      : items.length >= 100;
    if (!hasMore) return { rows, endpoints };
    if (rows.length === previousSize) throw deps.httpError(502, `litellm_${collection}_list_truncated`);
  }
  throw deps.httpError(502, `litellm_${collection}_list_truncated`);
}
