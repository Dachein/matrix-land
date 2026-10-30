import { audit } from "../audit.ts";
import type { PortalCatalog } from "../../../src/shared/types.ts";
import {
  DEFAULT_LLM_GATEWAY_RPM_LIMIT,
  DEFAULT_LLM_GATEWAY_TPM_LIMIT,
  LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION,
  shouldRepairLlmGatewayTpmLimit
} from "../../../src/shared/llmGatewayLimits.ts";
import { normalizeGatewayUsagePurpose, readPercentLimit } from "./normalizers.ts";
import {
  liteLlmDataSource,
  liteLlmUserIdForPortalUser,
  liteLlmUserInfoObject,
  llmGatewayUserScopeFromPortalUser,
  normalizeLiteLlmKey,
  normalizeLiteLlmKeys,
  normalizeLiteLlmModelOptions,
  normalizeLiteLlmUserLimit,
  readLiteLlmDataArray,
} from "./litellm.ts";
import {
  addIsoDateDays,
  dateKeyInTimeZone,
  claimCumulativeUsageSummaryRefresh,
  readCumulativeUsageSummary,
  readUsageAnalytics,
  recordUsageRefreshCheck,
  GATEWAY_USAGE_TIMEZONE,
  USAGE_SUMMARY_REFRESH_INTERVAL_MS,
  type UsageAnalytics
} from "./usageSnapshots.ts";
import {
  buildUsageBreakdown,
  mergeUsageBreakdowns,
  normalizeUsageBreakdownScope,
  resolveUsageBreakdownRange,
  type UsageBreakdownModelRow
} from "./usageBreakdown.ts";
import {
  readUsageLedgerCoverage,
  readUserUsageModelLedger,
  USAGE_LEDGER_ENDPOINT
} from "./usageLedger.ts";
import {
  evaluateUsageRefreshNeed,
  refreshUsageForUser,
  usageRefreshActivityForKeys
} from "./usageRefresh.ts";
import { ensureLiteLlmUserForPortalUser } from "./userBudgets.ts";

type CurrentUser = PortalCatalog["currentUser"];

const DEFAULT_GATEWAY_TEST_TIMEOUT_MS = 30_000;
const GATEWAY_TOKEN_NAME_MAX_LENGTH = 120;
const GATEWAY_TOKEN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_\-/.@]{0,118}[A-Za-z0-9]$/;
const LIVE_USAGE_CHUNK_DAYS = 31;
const LIVE_USAGE_MAX_PAGES_PER_CHUNK = 100;
const LIVE_USAGE_PAGE_SIZE = 100;

type LlmGatewayAccessEnv = {
  DB?: D1Database;
  LITELLM_URL?: string;
  USAGE_HISTORY_START_DATE?: string;
  USAGE_REFRESH_LOOKBACK_DAYS?: string;
  USAGE_RECONCILE_AFTER_HOURS?: string;
};

type LlmGatewayAccessContext<TEnv extends LlmGatewayAccessEnv> = EventContext<TEnv, string, unknown>;

type LlmGatewayAccessDeps<TEnv extends LlmGatewayAccessEnv> = {
  audit?: typeof audit;
  adminJson<T = unknown>(context: LlmGatewayAccessContext<TEnv>, gatewayPath: string, init?: { method?: string; body?: unknown }): Promise<T>;
  baseUrl(env: TEnv): string;
  clock?: () => Date;
  fetch?: typeof fetch;
  httpError(status: number, message: string): Error;
  json(body: unknown, init?: ResponseInit): Response;
  onTestError?(event: LlmGatewayTestErrorEvent): void;
  optionalText(value: unknown, maxLength: number): string;
  readBody<T>(request: Request): Promise<T>;
  requireText(value: unknown, errorCode: string, maxLength: number): string;
  readUsageAnalytics?: typeof readUsageAnalytics;
  readCumulativeUsageSummary?: typeof readCumulativeUsageSummary;
  claimCumulativeUsageSummaryRefresh?: typeof claimCumulativeUsageSummaryRefresh;
  readUsageLedgerCoverage?: typeof readUsageLedgerCoverage;
  readUserUsageModelLedger?: typeof readUserUsageModelLedger;
  recordUsageRefreshCheck?: typeof recordUsageRefreshCheck;
  refreshUsageForUser?: typeof refreshUsageForUser;
  resolveCurrentUser(context: LlmGatewayAccessContext<TEnv>): Promise<CurrentUser>;
  testTimeoutMs?: number;
};

type LlmGatewayTestErrorEvent = {
  code: string;
  model: string;
  requestId: string;
  upstreamStatus: number;
};

export function createLlmGatewayAccessApi<TEnv extends LlmGatewayAccessEnv>(deps: LlmGatewayAccessDeps<TEnv>) {
  const clock = deps.clock ?? (() => new Date());
  const fetchImpl = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const loadUsageAnalytics = deps.readUsageAnalytics ?? readUsageAnalytics;
  const loadCumulativeUsageSummary = deps.readCumulativeUsageSummary ?? readCumulativeUsageSummary;
  const claimCumulativeUsageRefresh = deps.claimCumulativeUsageSummaryRefresh ?? claimCumulativeUsageSummaryRefresh;
  const loadUsageLedgerCoverage = deps.readUsageLedgerCoverage ?? readUsageLedgerCoverage;
  const loadUserUsageModelLedger = deps.readUserUsageModelLedger ?? readUserUsageModelLedger;

  return {
    async getUsageSummary(context: LlmGatewayAccessContext<TEnv>) {
      const authStartedAt = Date.now();
      const currentUser = await deps.resolveCurrentUser(context);
      const authDuration = Date.now() - authStartedAt;
      const liteUserId = liteLlmUserIdForPortalUser(currentUser);
      const now = clock();
      const summaryStartedAt = Date.now();
      const summary = await loadCumulativeUsageSummary(context.env.DB, liteUserId);
      let refreshScheduled = false;

      if (context.env.DB && summary) {
        const updatedAtMillis = Date.parse(summary.updatedAt ?? "");
        const checkedAtMillis = Date.parse(summary.lastRefreshRequestedAt ?? "");
        const latestFreshnessMillis = Math.max(
          Number.isFinite(updatedAtMillis) ? updatedAtMillis : Number.NEGATIVE_INFINITY,
          Number.isFinite(checkedAtMillis) ? checkedAtMillis : Number.NEGATIVE_INFINITY
        );
        const refreshDue = !Number.isFinite(latestFreshnessMillis)
          || now.getTime() - latestFreshnessMillis >= USAGE_SUMMARY_REFRESH_INTERVAL_MS;
        if (refreshDue) {
          const requestedAt = now.toISOString();
          const staleBefore = new Date(now.getTime() - USAGE_SUMMARY_REFRESH_INTERVAL_MS).toISOString();
          try {
            const claimed = await claimCumulativeUsageRefresh(context.env.DB, {
              externalUserId: liteUserId,
              requestedAt,
              staleBefore
            });
            if (claimed) {
              refreshScheduled = true;
              const refreshTask = refreshCumulativeUsageSummary(context, currentUser, liteUserId, deps, clock)
                .catch((error: unknown) => {
                  console.warn("token_usage_summary_background_refresh_failed", {
                    error: usageRefreshCheckErrorCode(error),
                    userId: liteUserId
                  });
                });
              if (typeof context.waitUntil === "function") {
                context.waitUntil(refreshTask);
              } else {
                void refreshTask;
              }
            }
          } catch (error) {
            console.warn("token_usage_summary_refresh_claim_failed", {
              error: usageRefreshCheckErrorCode(error),
              userId: liteUserId
            });
          }
        }
      }

      return deps.json({
        source: "snapshot",
        hasSnapshot: summary?.hasSnapshot ?? false,
        cumulativeTokens: summary?.cumulativeTokens ?? 0,
        ...(summary?.updatedAt ? { updatedAt: summary.updatedAt } : {}),
        ...(summary?.dataThroughAt ? { dataThroughAt: summary.dataThroughAt } : {}),
        ...(summary?.lastRefreshRequestedAt ? { lastRefreshRequestedAt: summary.lastRefreshRequestedAt } : {}),
        refreshScheduled
      }, {
        headers: {
          "cache-control": "no-store",
          "server-timing": `auth;dur=${authDuration}, summary;dur=${Date.now() - summaryStartedAt}`
        }
      });
    },

    async getAccess(context: LlmGatewayAccessContext<TEnv>) {
      const totalStartedAt = Date.now();
      const authStartedAt = Date.now();
      const currentUser = await deps.resolveCurrentUser(context);
      const authDuration = Date.now() - authStartedAt;
      const liteUserId = liteLlmUserIdForPortalUser(currentUser);
      const now = clock();
      const userPath = `/user/info?user_id=${encodeURIComponent(liteUserId)}`;
      const modelsPath = "/v1/model/info";
      const dataStartedAt = Date.now();
      const userPromise = ensureLiteLlmUserForPortalUser(context, currentUser, deps);
      const keysPromise = readAllLiteLlmUserKeys(context, liteUserId, deps).catch(async (error: unknown) => {
        if (!isHttpStatus(error, 404)) {
          throw error;
        }

        // A brand-new LiteLLM user may not exist when the parallel key read
        // starts. Wait for provisioning and retry that read exactly once.
        await userPromise;
        return await readAllLiteLlmUserKeys(context, liteUserId, deps);
      });
      const [userPayload, keyCollection, modelInfoPayload, analytics] = await Promise.all([
        userPromise,
        keysPromise,
        deps.adminJson<{ data?: unknown[] }>(context, modelsPath),
        loadUsageAnalytics(context.env.DB, liteUserId, now)
      ]);
      const dataDuration = Date.now() - dataStartedAt;
      const allTokens = normalizeLiteLlmKeys(keyCollection.keys);
      const usageActivity = await usageRefreshActivityForKeys(allTokens);
      const usageRefresh = evaluateUsageRefreshNeed({
        snapshot: analytics.status === "ready" ? analytics : null,
        activity: usageActivity,
        now,
        reconcileAfterHours: configuredUsageReconcileAfterHours(
          context.env.USAGE_RECONCILE_AFTER_HOURS
        )
      });
      const tokenLineage = completedGatewayTokenLineage(allTokens);
      const tokens = allTokens.filter((token) => !isArchivedGatewayTokenGeneration(token, tokenLineage));
      let attributedAnalytics = mergeGatewayTokenLineageUsage(analytics, tokenLineage);
      if (!usageRefresh.recommended && context.env.DB) {
        const checkedAt = now.toISOString();
        const recordRefreshCheck = deps.recordUsageRefreshCheck ?? recordUsageRefreshCheck;
        try {
          const recorded = await recordRefreshCheck(context.env.DB, {
            externalUserId: liteUserId,
            checkedAt,
            activityWatermarkAt: usageActivity.maxLastUsedAt,
            keysetFingerprint: usageActivity.keysetFingerprint
          });
          if (recorded) {
            attributedAnalytics = { ...attributedAnalytics, lastCheckedAt: checkedAt };
          }
        } catch (error) {
          console.warn("token_usage_refresh_check_record_failed", {
            error: usageRefreshCheckErrorCode(error),
            userId: liteUserId
          });
        }
      }
      const userLimit = normalizeLiteLlmUserLimit(liteUserId, userPayload);
      const analyticsWithLiveBudget = {
        ...attributedAnalytics,
        summary: {
          ...attributedAnalytics.summary,
          monthlyBudgetUsd: userLimit.monthlyBudgetUsd
        }
      };

      const responseBody = {
        source: liteLlmDataSource([userPath, ...keyCollection.endpoints, modelsPath]),
        gatewayUrl: deps.baseUrl(context.env),
        user: llmGatewayUserScope(currentUser),
        modelOptions: normalizeLiteLlmModelOptions(readLiteLlmDataArray(modelInfoPayload))
          .filter((model) => modelAllowedByUserLimit(model.id, userLimit)),
        tokens,
        usage: legacyUsageRollups(analyticsWithLiveBudget),
        series: legacyUsageSeries(analyticsWithLiveBudget),
        userLimit,
        analytics: publicUsageAnalytics(analyticsWithLiveBudget),
        usageRefresh
      };
      const totalDuration = Date.now() - totalStartedAt;

      return deps.json(responseBody, {
        headers: {
          "cache-control": "no-store",
          "server-timing": `auth;dur=${authDuration}, data;dur=${dataDuration}, total;dur=${totalDuration}`
        }
      });
    },

    async refreshAccessUsage(context: LlmGatewayAccessContext<TEnv>) {
      const currentUser = await deps.resolveCurrentUser(context);
      const liteUserId = liteLlmUserIdForPortalUser(currentUser);
      const [keyCollection, userPayload] = await Promise.all([
        readAllLiteLlmUserKeys(context, liteUserId, deps),
        ensureLiteLlmUserForPortalUser(context, currentUser, deps)
      ]);
      const allTokens = normalizeLiteLlmKeys(keyCollection.keys);
      const userLimit = normalizeLiteLlmUserLimit(liteUserId, userPayload);
      const runUserRefresh = deps.refreshUsageForUser ?? refreshUsageForUser;
      const triggerType = new URL(context.request.url).searchParams.get("trigger") === "automatic"
        ? "automatic"
        : "manual";
      const refreshed = await runUserRefresh({
        db: context.env.DB,
        externalUserId: liteUserId,
        historyStartDate: context.env.USAGE_HISTORY_START_DATE,
        keys: allTokens,
        lookbackDays: configuredUsageLookbackDays(context.env.USAGE_REFRESH_LOOKBACK_DAYS),
        monthlyBudgetUsd: userLimit.monthlyBudgetUsd,
        now: clock(),
        triggerType,
        fetchSpendLogs: async ({ fromDate, toDate }) => await readLiveSpendLogs(
          context,
          liteUserId,
          addIsoDateDays(fromDate, -1),
          addIsoDateDays(toDate, 1),
          deps
        )
      });
      if (refreshed.status === "busy") {
        throw deps.httpError(409, "usage_refresh_in_progress");
      }

      const tokenLineage = completedGatewayTokenLineage(allTokens);
      const attributedAnalytics = mergeGatewayTokenLineageUsage(refreshed.analytics, tokenLineage);

      return deps.json({
        source: liteLlmDataSource(
          [...keyCollection.endpoints, ...refreshed.endpoints],
          { from: refreshed.sourceFromDate, to: refreshed.sourceToDate }
        ),
        analytics: publicUsageAnalytics(attributedAnalytics),
        usage: legacyUsageRollups(attributedAnalytics),
        series: legacyUsageSeries(attributedAnalytics)
      }, {
        headers: { "cache-control": "no-store" }
      });
    },

    async getUsageBreakdown(context: LlmGatewayAccessContext<TEnv>) {
      const currentUser = await deps.resolveCurrentUser(context);
      const liteUserId = liteLlmUserIdForPortalUser(currentUser);
      const now = clock();
      const search = new URL(context.request.url).searchParams;
      const scope = normalizeUsageBreakdownScope(search.get("scope") ?? "");
      if (!scope) {
        throw deps.httpError(400, "invalid_usage_breakdown_scope");
      }
      const range = resolveUsageBreakdownRange(scope, now, GATEWAY_USAGE_TIMEZONE, {
        date: search.get("date") ?? undefined,
        historyStartDate: context.env.USAGE_HISTORY_START_DATE
      });
      const keyParam = readString(search.get("key")).trim();
      const [keyCollection, modelInfoPayload, ledgerCoverage] = await Promise.all([
        readAllLiteLlmUserKeys(context, liteUserId, deps),
        deps.adminJson<{ data?: unknown[] }>(context, "/v1/model/info"),
        loadUsageLedgerCoverage(context.env.DB)
      ]);
      const allTokens = normalizeLiteLlmKeys(keyCollection.keys);
      const selectedKey = keyParam
        ? allTokens.find((token) => token.id === keyParam)
        : undefined;
      const displayNames = new Map(
        normalizeLiteLlmModelOptions(readLiteLlmDataArray(modelInfoPayload))
          .map((model) => [model.id, model.displayName])
      );
      const endpoints = [...keyCollection.endpoints, "/v1/model/info"];
      const modelRows: UsageBreakdownModelRow[] = [];
      let useLedger = Boolean(ledgerCoverage.available && ledgerCoverage.dataThroughDate);
      let liveFrom = range.from;

      if (useLedger && ledgerCoverage.dataThroughDate) {
        const historyTo = minIsoDate(range.to, ledgerCoverage.dataThroughDate);
        if (range.from <= historyTo) {
          const ledger = await loadUserUsageModelLedger(context.env.DB, {
            externalUserId: liteUserId,
            tokenId: selectedKey?.id,
            fromDate: range.from,
            toDate: historyTo
          });
          useLedger = ledger.available;
          if (ledger.available) {
            modelRows.push(...ledger.models);
            endpoints.push(USAGE_LEDGER_ENDPOINT);
            liveFrom = addIsoDateDays(historyTo, 1);
          }
        }
      }

      // A missing binding/schema falls back to the previous full live query.
      // Otherwise only the unclosed tail (normally today) touches LiteLLM.
      if (!useLedger) {
        liveFrom = range.from;
      }
      if (liveFrom <= range.to) {
        const live = await readLiveSpendLogs(
          context,
          liteUserId,
          addIsoDateDays(liveFrom, -1),
          addIsoDateDays(range.to, 1),
          deps
        );
        endpoints.push(...live.endpoints);
        modelRows.push(...buildUsageBreakdown({
          logs: live.logs,
          scope: { ...range, from: liveFrom },
          selectedKeyId: selectedKey?.id
        }).models);
      }
      const breakdown = mergeUsageBreakdowns(modelRows, displayNames);

      return deps.json({
        source: liteLlmDataSource(
          endpoints,
          { from: range.from, to: range.to }
        ),
        scope: range,
        ...(selectedKey ? { selectedKey: { id: selectedKey.id, name: selectedKey.name } } : {}),
        models: breakdown.models,
        total: breakdown.total
      }, {
        headers: { "cache-control": "no-store" }
      });
    },

    async createAccessToken(context: LlmGatewayAccessContext<TEnv>) {
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<{
        name?: string;
        monthlyBudgetPercent?: number;
        usagePurpose?: string;
      }>(context.request);
      const scope = llmGatewayUserScope(currentUser);
      const keyAlias = requireGatewayTokenName(body.name, deps);
      const userPayload = await ensureLiteLlmUserForPortalUser(context, currentUser, deps);
      const userInfo = liteLlmUserInfoObject(userPayload);
      const userMaxBudget = readNumber(userInfo.max_budget);
      const monthlyBudgetPercent = readPercentLimit(body.monthlyBudgetPercent ?? 100);
      const usagePurpose = requireGatewayUsagePurpose(body.usagePurpose ?? "agent", deps);
      const payload = {
        key_alias: keyAlias,
        key_type: "llm_api",
        user_id: scope.externalUserId,
        models: readStringArray(userInfo.models),
        max_budget: userMaxBudget > 0 ? Math.round((userMaxBudget * monthlyBudgetPercent) * 10000 / 100) / 10000 : undefined,
        rpm_limit: DEFAULT_LLM_GATEWAY_RPM_LIMIT,
        tpm_limit: DEFAULT_LLM_GATEWAY_TPM_LIMIT,
        budget_duration: readString(userInfo.budget_duration) || "30d",
        metadata: {
          workspace: {
            credentialId: crypto.randomUUID(),
            generation: 1,
            issuedVia: "workspace-portal",
            monthlyBudgetPercent,
            usagePurpose,
            ownerEmail: currentUser.email,
            ownerName: currentUser.name,
            ownerTeam: currentUser.team,
            externalOrgId: scope.externalOrgId,
            externalTeamId: scope.externalTeamId,
            rateLimitRepairVersion: LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION
          }
        }
      };
      const created = await deps.adminJson<Record<string, unknown>>(context, "/key/generate", {
        method: "POST",
        body: payload
      });
      const token = readString(created.key).trim();
      if (!token) {
        throw deps.httpError(502, "gateway_token_create_missing_secret");
      }
      const tokenHash = await hashLiteLlmToken(token);
      const upstreamTokenHashes = [created.token_id, created.token_hash, created.key_hash, created.token]
        .map((value) => readString(value).trim())
        .filter((value) => /^[a-f0-9]{64}$/i.test(value));
      if (upstreamTokenHashes.some((value) => value.toLowerCase() !== tokenHash)) {
        throw deps.httpError(502, "gateway_token_create_identity_mismatch");
      }

      return deps.json({
        token,
        tokenRecord: normalizeLiteLlmKey({ ...created, token_hash: tokenHash })
      }, {
        status: 201,
        headers: { "cache-control": "no-store" }
      });
    },

    async updateAccessToken(context: LlmGatewayAccessContext<TEnv>, tokenId: string) {
      const currentUser = await deps.resolveCurrentUser(context);
      const ownedToken = await requireOwnedLlmGatewayToken(context, tokenId, currentUser, deps);

      const body = await deps.readBody<{
        name?: string;
        monthlyBudgetPercent?: number;
        usagePurpose?: string;
      }>(context.request);
      const ownedWorkspaceMetadata = readRecord(ownedToken.metadata.workspace);
      const nextKeyAlias = body.name === undefined
        ? undefined
        : gatewayTokenNameUpdate(body.name, ownedToken.name, deps);
      const nextWorkspaceMetadata: Record<string, unknown> = {
        ...ownedWorkspaceMetadata,
        usagePurpose: body.usagePurpose === undefined
          ? normalizeGatewayUsagePurpose(ownedWorkspaceMetadata.usagePurpose)
          : requireGatewayUsagePurpose(body.usagePurpose, deps)
      };
      const payload = {
        key: tokenId,
        ...(nextKeyAlias === undefined ? {} : { key_alias: nextKeyAlias }),
        max_budget: undefined as number | undefined,
        metadata: {
          ...ownedToken.metadata,
          workspace: nextWorkspaceMetadata
        }
      };
      if (body.monthlyBudgetPercent !== undefined) {
        const userPayload = await ensureLiteLlmUserForPortalUser(context, currentUser, deps);
        const userMaxBudget = readNumber(liteLlmUserInfoObject(userPayload).max_budget);
        const monthlyBudgetPercent = readPercentLimit(body.monthlyBudgetPercent);
        payload.max_budget = userMaxBudget > 0 ? Math.round((userMaxBudget * monthlyBudgetPercent) * 10000 / 100) / 10000 : undefined;
        payload.metadata = {
          ...payload.metadata,
          workspace: {
            ...payload.metadata.workspace,
            monthlyBudgetPercent
          }
        };
      }
      const updated = await deps.adminJson(context, "/key/update", {
        method: "POST",
        body: payload
      });

      return deps.json(updated);
    },

    async testAccessToken(context: LlmGatewayAccessContext<TEnv>, tokenId: string) {
      const currentUser = await deps.resolveCurrentUser(context);
      const ownedToken = await requireOwnedLlmGatewayToken(context, tokenId, currentUser, deps);
      const body = await deps.readBody<{
        apiKey?: string;
        messages?: unknown[];
        model?: string;
      }>(context.request);
      const model = deps.requireText(body.model, "missing_gateway_test_model", 240);

      if (ownedToken.status !== "active") {
        throw deps.httpError(409, "gateway_token_inactive");
      }
      if (ownedToken.accessStatus === "suspended") {
        throw deps.httpError(409, "gateway_token_suspended");
      }
      if (ownedToken.allowedModels.length > 0 && !ownedToken.allowedModels.includes(model)) {
        throw deps.httpError(403, "gateway_token_model_not_allowed");
      }

      const apiKey = deps.requireText(body.apiKey, "missing_gateway_test_api_key", 512);
      const normalizedTokenId = ownedToken.id.toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(normalizedTokenId)) {
        throw deps.httpError(409, "gateway_token_hash_unavailable");
      }
      const submittedTokenHash = await hashLiteLlmToken(apiKey);
      if (!constantTimeEqual(submittedTokenHash, normalizedTokenId)) {
        throw deps.httpError(400, "gateway_token_secret_mismatch");
      }

      const messages = normalizeGatewayTestMessages(body.messages, deps);
      const clientSignal = context.request.signal;
      const upstreamAbortController = new AbortController();
      let abortSource: "client" | "timeout" | undefined;
      const abortForClientDisconnect = () => {
        if (!upstreamAbortController.signal.aborted) {
          abortSource = "client";
          upstreamAbortController.abort(clientSignal.reason);
        }
      };
      let listeningForClientDisconnect = false;

      if (clientSignal.aborted) {
        abortForClientDisconnect();
      } else {
        clientSignal.addEventListener("abort", abortForClientDisconnect, { once: true });
        listeningForClientDisconnect = true;
      }

      const timeoutId = setTimeout(() => {
        if (!upstreamAbortController.signal.aborted) {
          abortSource = "timeout";
          upstreamAbortController.abort();
        }
      }, gatewayTestTimeoutMs(deps.testTimeoutMs));
      let response: Response;
      let responseText: string;
      try {
        response = await fetchImpl(`${deps.baseUrl(context.env)}/v1/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            messages,
            stream: false
          }),
          signal: upstreamAbortController.signal
        });
        responseText = (await response.text()).split(apiKey).join("[REDACTED]");
      } catch {
        if (abortSource === "timeout") {
          reportGatewayTestError(deps.onTestError, {
            code: "llm_gateway_test_timeout",
            model,
            requestId: requestIdFromPortalRequest(context.request),
            upstreamStatus: 504
          });
          throw deps.httpError(504, "llm_gateway_test_timeout");
        }
        reportGatewayTestError(deps.onTestError, {
          code: "llm_gateway_test_unavailable",
          model,
          requestId: requestIdFromPortalRequest(context.request),
          upstreamStatus: 0
        });
        throw deps.httpError(502, "llm_gateway_test_unavailable");
      } finally {
        clearTimeout(timeoutId);
        if (listeningForClientDisconnect) {
          clientSignal.removeEventListener("abort", abortForClientDisconnect);
        }
      }
      const requestId = response.headers.get("x-request-id")
        || response.headers.get("cf-ray")
        || requestIdFromPortalRequest(context.request);
      const rayId = response.headers.get("cf-ray") || "";
      const headers: Record<string, string> = {
        "cache-control": "no-store"
      };

      if (requestId) {
        headers["x-request-id"] = requestId;
      }
      if (rayId) {
        headers["cf-ray"] = rayId;
      }

      if (!response.ok) {
        const error = gatewayTestFailureCode(response.status, responseText);
        reportGatewayTestError(deps.onTestError, {
          code: error,
          model,
          requestId,
          upstreamStatus: response.status
        });
        return deps.json({
          error,
          ...(requestId ? { requestId } : {})
        }, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }

      const responsePayload = parseGatewayTestJson(responseText, deps);

      return deps.json(redactSecret(responsePayload, apiKey), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    },

    async revokeAccessToken(context: LlmGatewayAccessContext<TEnv>, tokenId: string) {
      const currentUser = await deps.resolveCurrentUser(context);
      await requireOwnedLlmGatewayToken(context, tokenId, currentUser, deps);

      const body = await deps.readBody<{ reason?: string }>(context.request);
      const revoked = await deps.adminJson(context, "/key/delete", {
        method: "POST",
        body: {
          keys: [tokenId],
          reason: deps.optionalText(body.reason, 180) || "user_revoke"
        }
      });

      return deps.json(revoked);
    },

    async suspendAccessToken(context: LlmGatewayAccessContext<TEnv>, tokenId: string) {
      const currentUser = await deps.resolveCurrentUser(context);
      await requireOwnedLlmGatewayToken(context, tokenId, currentUser, deps);

      const suspended = await deps.adminJson(context, "/key/block", {
        method: "POST",
        body: {
          key: tokenId
        }
      });

      return deps.json(suspended);
    },

    async activateAccessToken(context: LlmGatewayAccessContext<TEnv>, tokenId: string) {
      const currentUser = await deps.resolveCurrentUser(context);
      await requireOwnedLlmGatewayToken(context, tokenId, currentUser, deps);

      const activated = await deps.adminJson(context, "/key/unblock", {
        method: "POST",
        body: {
          key: tokenId
        }
      });

      return deps.json(activated);
    },

    async deleteAccessToken(context: LlmGatewayAccessContext<TEnv>, tokenId: string) {
      const currentUser = await deps.resolveCurrentUser(context);
      await requireOwnedLlmGatewayToken(context, tokenId, currentUser, deps);

      const deleted = await deps.adminJson(context, "/key/delete", {
        method: "POST",
        body: {
          keys: [tokenId]
        }
      });

      return deps.json(deleted);
    },

    async rotateAccessToken(context: LlmGatewayAccessContext<TEnv>, tokenId: string) {
      const currentUser = await deps.resolveCurrentUser(context);
      const ownedToken = await requireOwnedLlmGatewayToken(context, tokenId, currentUser, deps);

      if (ownedToken.expiresAt) {
        throw deps.httpError(409, "gateway_token_rotation_expiring_key_unsupported");
      }

      if (!context.env.DB && !deps.audit) {
        throw deps.httpError(503, "gateway_token_rotation_audit_unavailable");
      }
      const operationId = crypto.randomUUID();
      const startedAt = clock().toISOString();
      const writeAudit = deps.audit ?? audit;
      const auditMetadata = {
        operationId,
        startedAt,
        actorEmail: currentUser.email,
        actorName: currentUser.name,
        oldTokenId: tokenId,
        keyName: ownedToken.name,
        source: "workspace-portal"
      };
      // Persist intent before changing either key. If storage fails, rotation
      // stops so there can be no unaudited destructive operation.
      await writeAudit(context.env.DB, "user", currentUser.id, "requested gateway token rotation", "gateway_token", tokenId, {
        ...auditMetadata, outcome: "started"
      });
      let newTokenId = "";
      let oldKeyBlocked = false;
      let warning = "";
      const recordOutcome = async (outcome: "completed" | "failed") => {
        try {
          await writeAudit(context.env.DB, "user", currentUser.id, `${outcome} gateway token rotation`, "gateway_token", tokenId, {
            ...auditMetadata,
            finishedAt: clock().toISOString(),
            outcome,
            newTokenId: newTokenId || null,
            oldKeyBlocked,
            warning: warning || null
          });
        } catch {
          // Never lose the only copy of a replacement secret after rotation.
          // The durable intent remains available for investigation.
          console.warn("gateway_token_rotation_audit_outcome_failed", { operationId, outcome, oldKeyBlocked });
        }
      };
      try {
        const ownedWorkspaceMetadata = readRecord(ownedToken.metadata.workspace);
        const credentialId = readString(ownedWorkspaceMetadata.credentialId).trim() || crypto.randomUUID();
        const generation = positiveInteger(ownedWorkspaceMetadata.generation, 1);
        const previousTokenIds = uniqueStrings([
          ...readStringArray(ownedWorkspaceMetadata.previousTokenIds),
          tokenId
        ]);
        const temporaryAlias = gatewayTokenRotationAlias(ownedToken.name, tokenId);
        const {
          lifecycle: _oldLifecycle,
          rotatedAt: _oldRotatedAt,
          rotatedToTokenId: _oldRotatedToTokenId,
          ...carriedWorkspaceMetadata
        } = ownedWorkspaceMetadata;
        const replacementMetadata = {
          ...ownedToken.metadata,
          workspace: {
            ...carriedWorkspaceMetadata,
            credentialId,
            generation: generation + 1,
            previousTokenIds,
            rotatedFromTokenId: tokenId,
            rotatedVia: "workspace-portal-replacement",
            rateLimitRepairVersion: LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION
          }
        };
        const replacementRpmLimit = ownedToken.requestLimitPerMinute > 0
          ? ownedToken.requestLimitPerMinute
          : DEFAULT_LLM_GATEWAY_RPM_LIMIT;
        const replacementTpmLimit = shouldRepairLlmGatewayTpmLimit(
          ownedToken.tokensPerMinute,
          ownedWorkspaceMetadata.rateLimitRepairVersion
        )
          ? DEFAULT_LLM_GATEWAY_TPM_LIMIT
          : ownedToken.tokensPerMinute;
        const created = await deps.adminJson<Record<string, unknown>>(context, "/key/generate", {
          method: "POST",
          body: {
            key_alias: temporaryAlias,
            key_type: "llm_api",
            user_id: ownedToken.externalUserId,
            organization_id: ownedToken.externalOrgId,
            team_id: ownedToken.externalTeamId,
            models: ownedToken.allowedModels,
            max_budget: ownedToken.monthlyBudgetUsd || undefined,
            spend: ownedToken.spendUsd || undefined,
            rpm_limit: replacementRpmLimit,
            tpm_limit: replacementTpmLimit,
            ...(ownedToken.budgetId
              ? { budget_id: ownedToken.budgetId }
              : { budget_duration: ownedToken.budgetDuration || "30d" }),
            metadata: replacementMetadata
          }
        });

        const token = readString(created.key).trim();
        if (!token) {
          const orphanTokenId = firstLiteLlmTokenHash(created);
          if (orphanTokenId) {
            await deleteReplacementAfterFailedRotation(context, orphanTokenId, deps);
          }
          throw deps.httpError(502, "gateway_token_rotation_missing_secret");
        }

        const tokenHash = await hashLiteLlmToken(token);
        const upstreamTokenHashes = liteLlmTokenHashes(created);
        if (upstreamTokenHashes.some((value) => value !== tokenHash)) {
          await deleteReplacementAfterFailedRotation(context, tokenHash, deps);
          throw deps.httpError(502, "gateway_token_rotation_identity_mismatch");
        }

        newTokenId = tokenHash;
        try {
          await deps.adminJson(context, "/key/block", {
            method: "POST",
            body: {
              key: tokenId
            }
          });
          oldKeyBlocked = true;
        } catch {
          try {
            const oldKey = await readOwnedLlmGatewayToken(context, tokenId, currentUser, deps);
            if (oldKey && oldKey.accessStatus !== "suspended") {
              await deleteReplacementAfterFailedRotation(context, tokenHash, deps);
              throw deps.httpError(502, "gateway_token_rotation_old_key_block_failed");
            }
            oldKeyBlocked = true;
          } catch (error) {
            if (isHttpErrorCode(error, "gateway_token_rotation_old_key_block_failed")
              || isHttpErrorCode(error, "gateway_token_rotation_cleanup_failed")) {
              throw error;
            }
            // The block response was ambiguous and its state could not be read
            // back. Keep the only copy of the replacement secret deliverable;
            // getAccess will keep an active old generation visible until its
            // blocked state can be confirmed.
            warning = "gateway_token_rotation_old_key_state_unknown";
          }
        }

        if (oldKeyBlocked) {
          try {
            await deps.adminJson(context, "/key/update", {
              method: "POST",
              body: {
                key: tokenId,
                key_alias: gatewayTokenArchivedAlias(ownedToken.name, tokenId, generation),
                metadata: {
                  ...ownedToken.metadata,
                  workspace: {
                    ...ownedWorkspaceMetadata,
                    credentialId,
                    generation,
                    lifecycle: "rotated",
                    rotatedToTokenId: tokenHash,
                    rotatedAt: clock().toISOString()
                  }
                }
              }
            });
          } catch {
            // Blocking is the security boundary. The new generation contains
            // the complete predecessor list, so usage remains attributable even
            // if the best-effort archive metadata update fails.
            warning ||= "gateway_token_rotation_archive_pending";
          }
        }

        let finalAlias = temporaryAlias;
        try {
          await deps.adminJson(context, "/key/update", {
            method: "POST",
            body: {
              key: tokenHash,
              key_alias: ownedToken.name
            }
          });
          finalAlias = ownedToken.name;
        } catch {
          // The replacement is already the only usable key. Return its secret
          // instead of stranding the user after a non-critical alias failure.
          warning ||= "gateway_token_rotation_alias_pending";
        }

        await recordOutcome("completed");
        return deps.json({
          token,
          tokenRecord: normalizeLiteLlmKey({
            ...created,
            key_alias: finalAlias,
            user_id: ownedToken.externalUserId,
            organization_id: ownedToken.externalOrgId,
            team_id: ownedToken.externalTeamId,
            models: ownedToken.allowedModels,
            rpm_limit: replacementRpmLimit,
            tpm_limit: replacementTpmLimit,
            max_budget: ownedToken.monthlyBudgetUsd,
            status: "active",
            blocked: false,
            expires: ownedToken.expiresAt,
            last_active: ownedToken.lastUsedAt,
            created_at: ownedToken.createdAt,
            spend: ownedToken.spendUsd,
            budget_duration: ownedToken.budgetDuration,
            budget_id: ownedToken.budgetId,
            metadata: replacementMetadata,
            token_hash: tokenHash
          }),
          ...(warning ? { warning } : {})
        }, {
          status: 201,
          headers: { "cache-control": "no-store" }
        });
      } catch (error) {
        await recordOutcome("failed");
        throw error;
      }
    }
  };
}

async function refreshCumulativeUsageSummary<TEnv extends LlmGatewayAccessEnv>(
  context: LlmGatewayAccessContext<TEnv>,
  currentUser: CurrentUser,
  liteUserId: string,
  deps: LlmGatewayAccessDeps<TEnv>,
  clock: () => Date
) {
  const userPromise = ensureLiteLlmUserForPortalUser(context, currentUser, deps);
  const keysPromise = readAllLiteLlmUserKeys(context, liteUserId, deps).catch(async (error: unknown) => {
    if (!isHttpStatus(error, 404)) {
      throw error;
    }

    await userPromise;
    return await readAllLiteLlmUserKeys(context, liteUserId, deps);
  });
  const [userPayload, keyCollection] = await Promise.all([userPromise, keysPromise]);
  const keys = normalizeLiteLlmKeys(keyCollection.keys);
  const userLimit = normalizeLiteLlmUserLimit(liteUserId, userPayload);
  const runUserRefresh = deps.refreshUsageForUser ?? refreshUsageForUser;

  await runUserRefresh({
    db: context.env.DB,
    externalUserId: liteUserId,
    historyStartDate: context.env.USAGE_HISTORY_START_DATE,
    keys,
    lookbackDays: configuredUsageLookbackDays(context.env.USAGE_REFRESH_LOOKBACK_DAYS),
    monthlyBudgetUsd: userLimit.monthlyBudgetUsd,
    now: clock(),
    triggerType: "automatic",
    fetchSpendLogs: async ({ fromDate, toDate }) => await readLiveSpendLogs(
      context,
      liteUserId,
      addIsoDateDays(fromDate, -1),
      addIsoDateDays(toDate, 1),
      deps
    )
  });
}

export function llmGatewayUserScope(currentUser: CurrentUser) {
  return llmGatewayUserScopeFromPortalUser(currentUser);
}

async function requireOwnedLlmGatewayToken<TEnv extends LlmGatewayAccessEnv>(
  context: LlmGatewayAccessContext<TEnv>,
  tokenId: string,
  currentUser: CurrentUser,
  deps: Pick<LlmGatewayAccessDeps<TEnv>, "adminJson" | "httpError">
) {
  const token = await readOwnedLlmGatewayToken(context, tokenId, currentUser, deps);

  if (!token) {
    throw deps.httpError(404, "gateway_token_not_found");
  }

  return token;
}

async function readOwnedLlmGatewayToken<TEnv extends LlmGatewayAccessEnv>(
  context: LlmGatewayAccessContext<TEnv>,
  tokenId: string,
  currentUser: CurrentUser,
  deps: Pick<LlmGatewayAccessDeps<TEnv>, "adminJson">
) {
  const currentUserId = liteLlmUserIdForPortalUser(currentUser);
  const payload = await deps.adminJson<{ keys?: unknown[] }>(
    context,
    `/key/list?user_id=${encodeURIComponent(currentUserId)}&return_full_object=true&size=100`
  );
  return normalizeLiteLlmKeys(payload.keys ?? [])
    .find((item) => item.id === tokenId && item.externalUserId === currentUserId);
}

function isHttpErrorCode(value: unknown, code: string) {
  return value instanceof Error && value.message === code;
}

function completedGatewayTokenLineage(tokens: ReturnType<typeof normalizeLiteLlmKeys>) {
  const tokenById = new Map(tokens.map((token) => [token.id, token]));
  const candidates = new Map<string, { generation: number; targetId: string }>();

  for (const token of tokens) {
    const workspaceMetadata = readRecord(token.metadata.workspace);
    const rotatedFromTokenId = readString(workspaceMetadata.rotatedFromTokenId).trim();
    if (!rotatedFromTokenId) {
      continue;
    }

    const immediatePredecessor = tokenById.get(rotatedFromTokenId);
    if (immediatePredecessor && immediatePredecessor.accessStatus !== "suspended") {
      continue;
    }

    const generation = positiveInteger(workspaceMetadata.generation, 1);
    const predecessorIds = uniqueStrings([
      ...readStringArray(workspaceMetadata.previousTokenIds),
      rotatedFromTokenId
    ]);

    for (const predecessorId of predecessorIds) {
      if (predecessorId === token.id) {
        continue;
      }
      const predecessor = tokenById.get(predecessorId);
      if (predecessor && predecessor.accessStatus !== "suspended") {
        continue;
      }

      const current = candidates.get(predecessorId);
      if (!current
        || generation > current.generation
        || (generation === current.generation && token.id > current.targetId)) {
        candidates.set(predecessorId, { generation, targetId: token.id });
      }
    }
  }

  return new Map(Array.from(candidates, ([predecessorId, candidate]) => [predecessorId, candidate.targetId]));
}

function isArchivedGatewayTokenGeneration(
  token: ReturnType<typeof normalizeLiteLlmKey>,
  lineage: Map<string, string>
) {
  return token.accessStatus === "suspended" && lineage.has(token.id);
}

function mergeGatewayTokenLineageUsage(analytics: UsageAnalytics, lineage: Map<string, string>): UsageAnalytics {
  if (lineage.size === 0 || analytics.tokenUsage.length === 0) {
    return analytics;
  }

  const mergedUsage = new Map<string, UsageAnalytics["tokenUsage"][number]>();
  for (const row of analytics.tokenUsage) {
    const tokenId = canonicalGatewayTokenId(row.tokenId, lineage);
    const current = mergedUsage.get(tokenId) ?? {
      tokenId,
      tokens: 0,
      requests: 0,
      estimatedCostUsd: 0
    };
    mergedUsage.set(tokenId, {
      tokenId,
      tokens: current.tokens + row.tokens,
      requests: current.requests + row.requests,
      estimatedCostUsd: current.estimatedCostUsd + row.estimatedCostUsd
    });
  }

  return {
    ...analytics,
    tokenUsage: Array.from(mergedUsage.values())
  };
}

function canonicalGatewayTokenId(tokenId: string, lineage: Map<string, string>) {
  const seen = new Set<string>();
  let current = tokenId;

  while (!seen.has(current)) {
    seen.add(current);
    const next = lineage.get(current);
    if (!next) {
      return current;
    }
    current = next;
  }

  return tokenId;
}

export async function readAllLiteLlmUserKeys<TEnv extends LlmGatewayAccessEnv>(
  context: LlmGatewayAccessContext<TEnv>,
  userId: string,
  deps: Pick<LlmGatewayAccessDeps<TEnv>, "adminJson" | "httpError">
) {
  const keys: unknown[] = [];
  const endpoints: string[] = [];
  const seenTokenIds = new Set<string>();

  for (let page = 1; page <= LIVE_USAGE_MAX_PAGES_PER_CHUNK; page += 1) {
    const search = new URLSearchParams({
      user_id: userId,
      return_full_object: "true",
      page: String(page),
      size: String(LIVE_USAGE_PAGE_SIZE)
    });
    const path = `/key/list?${search.toString()}`;
    const payload = await deps.adminJson<unknown>(context, path);
    const root = readRecord(payload);
    const pageKeys = root.keys ?? root.data;
    if (!Array.isArray(pageKeys)) {
      throw deps.httpError(502, "litellm_key_list_invalid_payload");
    }

    const reportedPage = optionalInteger(root.page);
    const totalPages = optionalInteger(root.total_pages ?? root.totalPages ?? root.pages);
    if ((reportedPage !== undefined && reportedPage !== page)
      || (totalPages !== undefined && (totalPages < 0 || totalPages > LIVE_USAGE_MAX_PAGES_PER_CHUNK))) {
      throw deps.httpError(502, totalPages !== undefined && totalPages > LIVE_USAGE_MAX_PAGES_PER_CHUNK
        ? "litellm_key_list_truncated"
        : "litellm_key_list_invalid_payload");
    }

    let added = 0;
    for (const row of pageKeys) {
      const tokenId = normalizeLiteLlmKey(row).id;
      if (!tokenId || seenTokenIds.has(tokenId)) {
        continue;
      }
      seenTokenIds.add(tokenId);
      keys.push(row);
      added += 1;
    }
    endpoints.push(path);

    const explicitHasMore = root.has_more ?? root.hasMore;
    const totalRows = optionalInteger(root.total_count ?? root.totalCount ?? root.total);
    const hasMore = typeof explicitHasMore === "boolean"
      ? explicitHasMore
      : totalPages !== undefined
        ? page < totalPages
        : totalRows !== undefined
          ? page * LIVE_USAGE_PAGE_SIZE < totalRows
          : pageKeys.length >= LIVE_USAGE_PAGE_SIZE && added > 0;
    if (!hasMore) {
      return { endpoints, keys };
    }
    if (page === LIVE_USAGE_MAX_PAGES_PER_CHUNK) {
      throw deps.httpError(502, "litellm_key_list_truncated");
    }
  }

  throw deps.httpError(502, "litellm_key_list_truncated");
}

async function readLiveSpendLogs<TEnv extends LlmGatewayAccessEnv>(
  context: LlmGatewayAccessContext<TEnv>,
  userId: string,
  fromDate: string,
  toDate: string,
  deps: Pick<LlmGatewayAccessDeps<TEnv>, "adminJson" | "httpError">
) {
  const logs: unknown[] = [];
  const endpoints: string[] = [];

  for (const chunk of chunkUsageDateRange(fromDate, toDate, LIVE_USAGE_CHUNK_DAYS)) {
    let totalPages = 1;

    for (let page = 1; page <= totalPages; page += 1) {
      const search = new URLSearchParams({
        start_date: chunk.fromDate,
        end_date: chunk.toDate,
        user_id: userId,
        page: String(page),
        page_size: String(LIVE_USAGE_PAGE_SIZE),
        sort_by: "startTime",
        sort_order: "asc"
      });
      const path = `/spend/logs/v2?${search.toString()}`;
      const payload = await deps.adminJson<unknown>(context, path);
      const root = readRecord(payload);
      const pageLogs = root.data;
      const reportedPage = Number(root.page);
      const reportedTotalPages = Number(root.total_pages ?? root.totalPages);

      if (!Array.isArray(pageLogs)
        || !Number.isInteger(reportedPage)
        || reportedPage !== page
        || !Number.isInteger(reportedTotalPages)
        || reportedTotalPages < 0) {
        throw deps.httpError(502, "litellm_spend_logs_invalid_payload");
      }
      if (reportedTotalPages > LIVE_USAGE_MAX_PAGES_PER_CHUNK) {
        throw deps.httpError(502, "litellm_spend_logs_truncated");
      }

      totalPages = Math.max(totalPages, reportedTotalPages);
      logs.push(...pageLogs);
      if (page === 1) {
        endpoints.push(path);
      }
    }
  }

  return { endpoints, logs };
}

function chunkUsageDateRange(fromDate: string, toDate: string, chunkDays: number) {
  const chunks: Array<{ fromDate: string; toDate: string }> = [];
  let cursor = fromDate;

  while (cursor <= toDate) {
    const chunkEnd = minIsoDate(addIsoDateDays(cursor, chunkDays - 1), toDate);
    chunks.push({ fromDate: cursor, toDate: chunkEnd });
    cursor = addIsoDateDays(chunkEnd, 1);
  }
  return chunks;
}

function validUsageDate(value: unknown) {
  const date = readString(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return "";
  }
  try {
    return new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date ? date : "";
  } catch {
    return "";
  }
}

function minIsoDate(left: string, right: string) {
  return left <= right ? left : right;
}

function configuredUsageLookbackDays(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(31, Math.max(1, Math.round(parsed)))
    : 7;
}

function configuredUsageReconcileAfterHours(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(168, Math.max(1, Math.round(parsed)))
    : 24;
}

function publicUsageAnalytics(analytics: UsageAnalytics): UsageAnalytics {
  const { keysetFingerprint: _keysetFingerprint, ...publicAnalytics } = analytics;
  return publicAnalytics;
}

function usageRefreshCheckErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "unknown_error");
  return message.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 160);
}

function optionalInteger(value: unknown) {
  const number = Number(value);
  return value !== undefined && value !== null && Number.isInteger(number) ? number : undefined;
}

function legacyUsageRollups(analytics: UsageAnalytics) {
  const periodStart = analyticsMonthStart(analytics);
  return analytics.tokenUsage.map((row) => ({
    scopeType: "token",
    scopeId: row.tokenId,
    periodType: "month",
    periodStart,
    requests: row.requests,
    billableUnits: row.tokens,
    estimatedCostUsd: row.estimatedCostUsd
  }));
}

function legacyUsageSeries(analytics: UsageAnalytics) {
  const periodStart = `${analyticsMonthStart(analytics)} 00:00:00`;
  return analytics.tokenUsage.map((row) => ({
    periodStart,
    groupType: "token",
    groupId: row.tokenId,
    requests: row.requests,
    blockedRequests: 0,
    failedRequests: 0,
    billableUnits: row.tokens,
    estimatedCostUsd: row.estimatedCostUsd
  }));
}

function analyticsMonthStart(analytics: UsageAnalytics) {
  const referenceDate = validUsageDate(analytics.dataThroughDate)
    || dateKeyInTimeZone(new Date(), analytics.timezone);
  return `${referenceDate.slice(0, 7)}-01`;
}

function modelAllowedByUserLimit(modelId: string, userLimit: ReturnType<typeof normalizeLiteLlmUserLimit> | undefined) {
  return !userLimit?.allowedModels.length || userLimit.allowedModels.includes(modelId);
}

function requireGatewayUsagePurpose<TEnv extends LlmGatewayAccessEnv>(
  value: unknown,
  deps: Pick<LlmGatewayAccessDeps<TEnv>, "httpError">
): "agent" | "app" {
  const usagePurpose = readString(value).trim();

  if (usagePurpose === "agent" || usagePurpose === "app") {
    return usagePurpose;
  }

  throw deps.httpError(400, "invalid_gateway_token_usage_purpose");
}

function requireGatewayTokenName<TEnv extends LlmGatewayAccessEnv>(
  value: unknown,
  deps: Pick<LlmGatewayAccessDeps<TEnv>, "httpError">
) {
  const name = readString(value).trim();

  if (!name) {
    throw deps.httpError(400, "missing_gateway_token_name");
  }

  if (name.length > GATEWAY_TOKEN_NAME_MAX_LENGTH || !GATEWAY_TOKEN_NAME_PATTERN.test(name)) {
    throw deps.httpError(400, "invalid_gateway_token_name");
  }

  return name;
}

function gatewayTokenNameUpdate<TEnv extends LlmGatewayAccessEnv>(
  value: unknown,
  existingName: string,
  deps: Pick<LlmGatewayAccessDeps<TEnv>, "httpError">
) {
  const name = readString(value).trim();

  if (name === existingName) {
    return undefined;
  }

  return requireGatewayTokenName(name, deps);
}

function normalizeGatewayTestMessages<TEnv extends LlmGatewayAccessEnv>(
  value: unknown,
  deps: Pick<LlmGatewayAccessDeps<TEnv>, "httpError">
) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw deps.httpError(400, "invalid_gateway_test_messages");
  }

  return value.map((item) => {
    const message = readRecord(item);
    const role = readString(message.role).trim();
    const content = typeof message.content === "string" ? message.content.trim() : "";

    if (!(["system", "user", "assistant"] as string[]).includes(role) || !content || content.length > 20_000) {
      throw deps.httpError(400, "invalid_gateway_test_messages");
    }

    return { role, content };
  });
}

export async function hashLiteLlmToken(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function gatewayTestTimeoutMs(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.max(1, Math.round(number))
    : DEFAULT_GATEWAY_TEST_TIMEOUT_MS;
}

function gatewayTestFailureCode(upstreamStatus: number, value: string) {
  const payload = parseOptionalJsonRecord(value);
  const nestedError = readRecord(payload.error);
  const discriminator = [
    nestedError.type,
    nestedError.code,
    nestedError.message,
    nestedError.detail,
    payload.type,
    payload.code,
    payload.message,
    payload.detail
  ].map((item) => readString(item).toLowerCase()).join(" ");

  if (upstreamStatus === 401) {
    return "gateway_token_auth_rejected";
  }
  if (upstreamStatus === 403) {
    return "gateway_token_access_denied";
  }
  if (upstreamStatus === 400 || upstreamStatus === 422) {
    return "gateway_test_request_rejected";
  }
  if (upstreamStatus === 404 || /model[_ -]?(not[_ -]?found|unavailable|invalid)/.test(discriminator)) {
    return "gateway_model_unavailable";
  }
  if (upstreamStatus === 429) {
    return /budget|quota|spend|credit/.test(discriminator)
      ? "gateway_token_budget_exceeded"
      : "gateway_token_rate_limited";
  }
  if (upstreamStatus === 408 || upstreamStatus === 504) {
    return "llm_gateway_test_timeout";
  }
  if (upstreamStatus >= 500) {
    return "llm_gateway_test_unavailable";
  }
  return "llm_gateway_test_invalid_response";
}

function requestIdFromPortalRequest(request: Request) {
  return request.headers.get("x-request-id") || request.headers.get("cf-ray") || "";
}

function reportGatewayTestError(
  handler: LlmGatewayAccessDeps<LlmGatewayAccessEnv>["onTestError"],
  event: LlmGatewayTestErrorEvent
) {
  try {
    handler?.(event);
  } catch {
    // Diagnostics must never change the token-test response contract.
  }
}

function parseGatewayTestJson<TEnv extends LlmGatewayAccessEnv>(
  value: string,
  deps: Pick<LlmGatewayAccessDeps<TEnv>, "httpError">
) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw deps.httpError(502, "llm_gateway_test_invalid_response");
  }
}

function parseOptionalJsonRecord(value: string) {
  try {
    return readRecord(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function liteLlmTokenHashes(value: Record<string, unknown>) {
  return [value.token_id, value.token_hash, value.key_hash, value.token]
    .map((item) => readString(item).trim().toLowerCase())
    .filter((item) => /^[a-f0-9]{64}$/.test(item));
}

function firstLiteLlmTokenHash(value: Record<string, unknown>) {
  return liteLlmTokenHashes(value)[0] ?? "";
}

function gatewayTokenRotationAlias(name: string, tokenId: string) {
  const suffix = `-rotate-${tokenId.slice(0, 8)}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const base = name
    .replace(/[^A-Za-z0-9_\-/.@]/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .slice(0, Math.max(1, GATEWAY_TOKEN_NAME_MAX_LENGTH - suffix.length)) || "key";
  return `${base}${suffix}`;
}

function gatewayTokenArchivedAlias(name: string, tokenId: string, generation: number) {
  const tokenMarker = tokenId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "key";
  const suffix = `-rotated-g${generation}-${tokenMarker}`;
  const base = name
    .replace(/[^A-Za-z0-9_\-/.@]/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .slice(0, Math.max(1, GATEWAY_TOKEN_NAME_MAX_LENGTH - suffix.length)) || "key";
  return `${base}${suffix}`;
}

async function deleteReplacementAfterFailedRotation<TEnv extends LlmGatewayAccessEnv>(
  context: LlmGatewayAccessContext<TEnv>,
  tokenId: string,
  deps: Pick<LlmGatewayAccessDeps<TEnv>, "adminJson" | "httpError">
) {
  try {
    await deps.adminJson(context, "/key/delete", {
      method: "POST",
      body: {
        keys: [tokenId],
        reason: "rotation_compensation"
      }
    });
  } catch {
    throw deps.httpError(502, "gateway_token_rotation_cleanup_failed");
  }
}

function redactSecret(value: unknown, secret: string): unknown {
  if (typeof value === "string") {
    return value.split(secret).join("[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecret(item, secret));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecret(item, secret)]));
  }
  return value;
}

function readStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => readString(item).trim()).filter(Boolean);
  }
  return [];
}

function uniqueStrings(values: unknown[]) {
  return Array.from(new Set(values
    .map((value) => readString(value).trim())
    .filter(Boolean)))
    .slice(0, 1_000);
}

function positiveInteger(value: unknown, fallback: number) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isHttpStatus(error: unknown, status: number) {
  return typeof error === "object"
    && error !== null
    && "status" in error
    && Number((error as { status?: unknown }).status) === status;
}
