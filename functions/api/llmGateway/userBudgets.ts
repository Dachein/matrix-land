import {
  monthlyBudgetUsdForPortalJourneyLevel,
  normalizePortalJourneyLevelKey
} from "../../../src/shared/journey.ts";
import {
  DEFAULT_LLM_GATEWAY_RPM_LIMIT,
  DEFAULT_LLM_GATEWAY_TPM_LIMIT,
  LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION,
  shouldRepairLlmGatewayTpmLimit
} from "../../../src/shared/llmGatewayLimits.ts";
import type {
  PortalCatalog,
  PortalJourneyLevelKey
} from "../../../src/shared/types.ts";
import {
  liteLlmUserIdForPortalUser,
  liteLlmUserInfoObject,
  normalizeLiteLlmKeys
} from "./litellm.ts";

type CurrentUser = PortalCatalog["currentUser"];

type LlmGatewayUserBudgetEnv = {
  DB?: D1Database;
};

type LlmGatewayUserBudgetContext<TEnv extends LlmGatewayUserBudgetEnv> = EventContext<TEnv, string, unknown>;

type LlmGatewayUserBudgetDeps<TEnv extends LlmGatewayUserBudgetEnv> = {
  adminJson<T = unknown>(
    context: LlmGatewayUserBudgetContext<TEnv>,
    gatewayPath: string,
    init?: { method?: string; body?: unknown }
  ): Promise<T>;
};

const MONTHLY_BUDGET_DURATION = "30d";

export async function ensureLiteLlmUserForPortalUser<TEnv extends LlmGatewayUserBudgetEnv>(
  context: LlmGatewayUserBudgetContext<TEnv>,
  currentUser: CurrentUser,
  deps: LlmGatewayUserBudgetDeps<TEnv>
) {
  const levelKey = await readPortalUserJourneyLevelKey(context.env.DB, currentUser.id);
  const ensured = await ensureLiteLlmUserAtJourneyLevel(context, currentUser, levelKey, deps);
  const payload = ensured.created
    ? ensured.payload
    : await ensurePortalManagedDefaultRateLimits(context, currentUser, ensured.payload, deps);

  if (!ensured.created) {
    const userInfo = liteLlmUserInfoObject(payload);
    const workspaceMetadata = readRecord(readRecord(userInfo.metadata).workspace);
    const budgetManagedBy = readString(workspaceMetadata.budgetManagedBy);
    const currentMonthlyBudgetUsd = readNumber(userInfo.max_budget ?? userInfo.maxBudget);

    if (budgetManagedBy === "journey-level" || (budgetManagedBy !== "admin" && currentMonthlyBudgetUsd <= 0)) {
      await syncLiteLlmUserMonthlyBudget(context, currentUser, levelKey, deps);
      return withBudgetValues(payload, monthlyBudgetUsdForPortalJourneyLevel(levelKey));
    }
  }

  return payload;
}

async function ensurePortalManagedDefaultRateLimits<TEnv extends LlmGatewayUserBudgetEnv>(
  context: LlmGatewayUserBudgetContext<TEnv>,
  currentUser: CurrentUser,
  payload: Record<string, unknown>,
  deps: LlmGatewayUserBudgetDeps<TEnv>
) {
  const userInfo = liteLlmUserInfoObject(payload);
  const metadata = readRecord(userInfo.metadata);
  const workspaceMetadata = readRecord(metadata.workspace);

  const managedByPortal = readString(workspaceMetadata.allocationUpdatedVia) === "workspace-portal"
    || readString(workspaceMetadata.budgetManagedBy) === "journey-level";

  if (!managedByPortal) {
    return payload;
  }

  const repairRpm = requiresDefaultRateLimit(userInfo.rpm_limit ?? userInfo.rpmLimit);
  const repairTpm = shouldRepairLlmGatewayTpmLimit(
    userInfo.tpm_limit ?? userInfo.tpmLimit,
    workspaceMetadata.rateLimitRepairVersion
  );

  if (!repairRpm && !repairTpm) {
    return payload;
  }

  const nextMetadata = {
    ...metadata,
    workspace: {
      ...workspaceMetadata,
      rateLimitRepairVersion: LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION
    }
  };
  const repairedValues = {
    ...(repairRpm ? { rpm_limit: DEFAULT_LLM_GATEWAY_RPM_LIMIT } : {}),
    ...(repairTpm ? { tpm_limit: DEFAULT_LLM_GATEWAY_TPM_LIMIT } : {}),
    metadata: nextMetadata
  };

  await deps.adminJson(context, "/user/update", {
    method: "POST",
    body: {
      user_id: liteLlmUserIdForPortalUser(currentUser),
      ...repairedValues
    }
  });

  return withUserInfoPatch(payload, repairedValues);
}

export async function syncLiteLlmUserMonthlyBudget<TEnv extends LlmGatewayUserBudgetEnv>(
  context: LlmGatewayUserBudgetContext<TEnv>,
  currentUser: CurrentUser,
  levelKey: PortalJourneyLevelKey,
  deps: LlmGatewayUserBudgetDeps<TEnv>
) {
  const ensured = await ensureLiteLlmUserAtJourneyLevel(context, currentUser, levelKey, deps);

  if (ensured.created) {
    return;
  }

  const liteUserId = liteLlmUserIdForPortalUser(currentUser);
  const monthlyBudgetUsd = monthlyBudgetUsdForPortalJourneyLevel(levelKey);
  const userInfo = liteLlmUserInfoObject(ensured.payload);
  const metadata = readRecord(userInfo.metadata);
  const workspaceMetadata = readRecord(metadata.workspace);
  const nextWorkspaceMetadata = journeyBudgetMetadata(currentUser, levelKey, monthlyBudgetUsd, workspaceMetadata);

  if (
    !moneyEquals(readNumber(userInfo.max_budget ?? userInfo.maxBudget), monthlyBudgetUsd)
    || readString(userInfo.budget_duration ?? userInfo.budgetDuration) !== MONTHLY_BUDGET_DURATION
    || readString(workspaceMetadata.journeyLevelKey) !== levelKey
    || !moneyEquals(readNumber(workspaceMetadata.baseMonthlyBudgetUsd), monthlyBudgetUsd)
  ) {
    await deps.adminJson(context, "/user/update", {
      method: "POST",
      body: {
        user_id: liteUserId,
        user_email: readString(userInfo.user_email) || liteUserId,
        user_alias: readString(userInfo.user_alias) || currentUser.name || liteUserId,
        max_budget: monthlyBudgetUsd,
        budget_duration: MONTHLY_BUDGET_DURATION,
        metadata: {
          ...metadata,
          workspace: nextWorkspaceMetadata
        }
      }
    });
  }

  await syncLiteLlmTokenBudgetsForUser(context, liteUserId, monthlyBudgetUsd, deps);
}

export async function readPortalUserJourneyLevelKey(
  db: D1Database | undefined,
  userId: string
): Promise<PortalJourneyLevelKey> {
  if (!db) {
    return "newcomer";
  }

  try {
    const row = await db
      .prepare("SELECT current_level_key AS currentLevelKey FROM portal_user_journey_state WHERE user_id = ? LIMIT 1")
      .bind(userId)
      .first<{ currentLevelKey?: string }>();

    return normalizePortalJourneyLevelKey(readString(row?.currentLevelKey));
  } catch (error) {
    if (error instanceof Error && /no such table[^\n]*portal_user_journey_state/i.test(error.message)) {
      return "newcomer";
    }
    throw error;
  }
}

async function ensureLiteLlmUserAtJourneyLevel<TEnv extends LlmGatewayUserBudgetEnv>(
  context: LlmGatewayUserBudgetContext<TEnv>,
  currentUser: CurrentUser,
  levelKey: PortalJourneyLevelKey,
  deps: LlmGatewayUserBudgetDeps<TEnv>
) {
  const liteUserId = liteLlmUserIdForPortalUser(currentUser);
  const existing = await getLiteLlmUserInfo(context, liteUserId, deps);

  if (existing) {
    return { created: false, payload: existing };
  }

  const monthlyBudgetUsd = monthlyBudgetUsdForPortalJourneyLevel(levelKey);

  try {
    const payload = await deps.adminJson<Record<string, unknown>>(context, "/user/new", {
      method: "POST",
      body: {
        user_id: liteUserId,
        user_email: liteUserId,
        user_alias: currentUser.name || liteUserId,
        user_role: "internal_user",
        auto_create_key: false,
        max_budget: monthlyBudgetUsd,
        rpm_limit: DEFAULT_LLM_GATEWAY_RPM_LIMIT,
        tpm_limit: DEFAULT_LLM_GATEWAY_TPM_LIMIT,
        budget_duration: MONTHLY_BUDGET_DURATION,
        metadata: {
          workspace: journeyBudgetMetadata(currentUser, levelKey, monthlyBudgetUsd)
        }
      }
    });

    return {
      created: true,
      payload: withBudgetDefaults(payload, monthlyBudgetUsd)
    };
  } catch (error) {
    const recovered = await getLiteLlmUserInfo(context, liteUserId, deps);
    if (recovered) {
      return { created: false, payload: recovered };
    }
    throw error;
  }
}

async function getLiteLlmUserInfo<TEnv extends LlmGatewayUserBudgetEnv>(
  context: LlmGatewayUserBudgetContext<TEnv>,
  liteUserId: string,
  deps: LlmGatewayUserBudgetDeps<TEnv>
) {
  try {
    return await deps.adminJson<Record<string, unknown>>(context, `/user/info?user_id=${encodeURIComponent(liteUserId)}`);
  } catch (error) {
    if (isHttpStatus(error, 404)) {
      return undefined;
    }
    throw error;
  }
}

export async function syncLiteLlmTokenBudgetsForUser<TEnv extends LlmGatewayUserBudgetEnv>(
  context: LlmGatewayUserBudgetContext<TEnv>,
  liteUserId: string,
  monthlyBudgetUsd: number,
  deps: LlmGatewayUserBudgetDeps<TEnv>
) {
  const payload = await deps.adminJson<{ keys?: unknown[] }>(
    context,
    `/key/list?user_id=${encodeURIComponent(liteUserId)}&return_full_object=true&size=100`
  );
  const tokens = normalizeLiteLlmKeys(payload.keys ?? [])
    .filter((token) => token.status !== "deleted" && token.status !== "revoked");

  await Promise.all(tokens.map(async (token) => {
    const monthlyBudgetPercent = normalizeMonthlyBudgetPercent(token.monthlyBudgetPercent);
    const tokenMonthlyBudgetUsd = roundMoney(monthlyBudgetUsd * monthlyBudgetPercent / 100);
    const metadata = readRecord(token.metadata);
    const workspaceMetadata = readRecord(metadata.workspace);
    const repairTpm = shouldRepairLlmGatewayTpmLimit(
      token.tokensPerMinute,
      workspaceMetadata.rateLimitRepairVersion
    );

    if (moneyEquals(token.monthlyBudgetUsd, tokenMonthlyBudgetUsd) && !repairTpm) {
      return;
    }

    await deps.adminJson(context, "/key/update", {
      method: "POST",
      body: {
        key: token.id,
        ...(moneyEquals(token.monthlyBudgetUsd, tokenMonthlyBudgetUsd)
          ? {}
          : { max_budget: tokenMonthlyBudgetUsd }),
        ...(repairTpm ? { tpm_limit: DEFAULT_LLM_GATEWAY_TPM_LIMIT } : {}),
        metadata: {
          ...metadata,
          workspace: {
            ...workspaceMetadata,
            monthlyBudgetPercent,
            ...(repairTpm
              ? { rateLimitRepairVersion: LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION }
              : {})
          }
        }
      }
    });
  }));
}

function journeyBudgetMetadata(
  currentUser: CurrentUser,
  levelKey: PortalJourneyLevelKey,
  monthlyBudgetUsd: number,
  existing: Record<string, unknown> = {}
) {
  const preservedMetadata = { ...existing };
  delete preservedMetadata.manualMonthlyBudgetUsd;

  return {
    ...preservedMetadata,
    portalUserId: currentUser.id,
    ownerTeam: currentUser.team,
    tenantId: currentUser.identity?.tenantId,
    journeyLevelKey: levelKey,
    baseMonthlyBudgetUsd: monthlyBudgetUsd,
    budgetManagedBy: "journey-level",
    rateLimitRepairVersion: LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION
  };
}

function withBudgetDefaults(payload: Record<string, unknown>, monthlyBudgetUsd: number) {
  const wrappedUserInfo = readRecord(payload.user_info);

  if (Object.keys(wrappedUserInfo).length > 0) {
    return {
      ...payload,
      user_info: {
        ...wrappedUserInfo,
        max_budget: wrappedUserInfo.max_budget ?? monthlyBudgetUsd,
        rpm_limit: wrappedUserInfo.rpm_limit ?? DEFAULT_LLM_GATEWAY_RPM_LIMIT,
        tpm_limit: wrappedUserInfo.tpm_limit ?? DEFAULT_LLM_GATEWAY_TPM_LIMIT,
        budget_duration: wrappedUserInfo.budget_duration ?? MONTHLY_BUDGET_DURATION
      }
    };
  }

  return {
    ...payload,
    max_budget: payload.max_budget ?? monthlyBudgetUsd,
    rpm_limit: payload.rpm_limit ?? DEFAULT_LLM_GATEWAY_RPM_LIMIT,
    tpm_limit: payload.tpm_limit ?? DEFAULT_LLM_GATEWAY_TPM_LIMIT,
    budget_duration: payload.budget_duration ?? MONTHLY_BUDGET_DURATION
  };
}

function withBudgetValues(payload: Record<string, unknown>, monthlyBudgetUsd: number) {
  const wrappedUserInfo = readRecord(payload.user_info);

  if (Object.keys(wrappedUserInfo).length > 0) {
    return {
      ...payload,
      user_info: {
        ...wrappedUserInfo,
        max_budget: monthlyBudgetUsd,
        budget_duration: MONTHLY_BUDGET_DURATION
      }
    };
  }

  return {
    ...payload,
    max_budget: monthlyBudgetUsd,
    budget_duration: MONTHLY_BUDGET_DURATION
  };
}

function withUserInfoPatch(payload: Record<string, unknown>, patch: Record<string, unknown>) {
  const wrappedUserInfo = readRecord(payload.user_info);

  if (Object.keys(wrappedUserInfo).length > 0) {
    return {
      ...payload,
      user_info: {
        ...wrappedUserInfo,
        ...patch
      }
    };
  }

  return {
    ...payload,
    ...patch
  };
}

function requiresDefaultRateLimit(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return value === undefined || value === null || value === "" || !Number.isFinite(number) || number <= 0;
}

function normalizeMonthlyBudgetPercent(value: unknown) {
  const percent = readNumber(value) || 100;
  return Math.min(Math.max(percent, 1), 100);
}

function roundMoney(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function moneyEquals(left: unknown, right: unknown) {
  return Math.abs(readNumber(left) - readNumber(right)) < 0.00005;
}

function readNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isHttpStatus(error: unknown, status: number) {
  return typeof error === "object" && error !== null && "status" in error && Number((error as { status?: unknown }).status) === status;
}
