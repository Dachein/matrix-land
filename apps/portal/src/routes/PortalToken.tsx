import { PageHeading } from "../../../../src/portal/components/PageHeading";
import { KeyRound, Plus, RefreshCw } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { useI18n } from "../../../../src/portal/i18n";
import { loadMemoryResource, readMemoryResource, writeMemoryResource } from "../../../../src/portal/lib/memoryResourceCache";
import {
  activateGatewayToken,
  createGatewayToken,
  deleteGatewayToken,
  fetchGatewayAccess,
  fetchGatewayUsageSummary,
  GatewayTokenApiError,
  refreshGatewayUsage,
  rotateGatewayToken,
  suspendGatewayToken,
  updateGatewayToken
} from "../../../../src/portal/token/apiClient";
import {
  applyGatewayTokenRotation,
  buildAnnualDailyUsage,
  buildAnnualDailyUsageFromSeries,
  buildDefaultGatewayTokenName,
  buildTokenRows,
  buildTokenRowsFromAnalytics,
  draftFromToken,
  effectiveMonthlyBudgetUsd,
  emptyTokenDraft,
  gatewayModelOptions,
  latestCompleteShanghaiDate,
  peakDailyTokens,
  summarizeMonthlyRollups,
  summarizeSeries
} from "../../../../src/portal/token/models";
import type {
  GatewayAccessResponse,
  GatewayUsageSummary,
  TokenDraft
} from "../../../../src/portal/token/types";
import type { PortalCatalog } from "../../../../src/shared/types";
import { PortalRouteLoading } from "../components/PortalRecovery";
import { PortalTokenLedger } from "../components/token/PortalTokenLedger";
import type { BreakdownModalOpenState } from "../components/token/PortalTokenBreakdownModal";
import { PortalTokenModelHealthEntry } from "../components/token/PortalTokenModelHealthEntry";
import { PortalTokenEarlyTotal, PortalTokenOverview } from "../components/token/PortalTokenOverview";
import "../styles/token.css";

const TOKEN_ACCESS_CACHE_MAX_AGE_MS = 30 * 1000;
const PortalModelHealth = lazy(() => import("./PortalModelHealth").then((module) => ({ default: module.PortalModelHealth })));
const PortalTokenBreakdownModal = lazy(() => import("../components/token/PortalTokenBreakdownModal").then((module) => ({ default: module.PortalTokenBreakdownModal })));
const PortalTokenCreateModal = lazy(() => import("../components/token/PortalTokenModals").then((module) => ({ default: module.PortalTokenCreateModal })));
const PortalTokenRotateModal = lazy(() => import("../components/token/PortalTokenModals").then((module) => ({ default: module.PortalTokenRotateModal })));
const PortalTokenDeleteModal = lazy(() => import("../components/token/PortalTokenModals").then((module) => ({ default: module.PortalTokenDeleteModal })));

export function PortalToken({
  catalog,
  initialModelStatusOpen = false,
  onModelStatusClosed
}: {
  catalog: PortalCatalog;
  initialModelStatusOpen?: boolean;
  onModelStatusClosed?: () => void;
}) {
  const { t } = useI18n();
  const accessCacheKey = `token-access:${catalog.currentUser.id}`;
  const [usageSummaryCache, setUsageSummaryCache] = useState<{
    key: string;
    summary: GatewayUsageSummary;
  }>();
  const usageSummary = usageSummaryCache?.key === accessCacheKey ? usageSummaryCache.summary : undefined;
  const initialAccess = readMemoryResource<GatewayAccessResponse>(accessCacheKey, TOKEN_ACCESS_CACHE_MAX_AGE_MS)?.value;
  const [access, setAccess] = useState<GatewayAccessResponse | undefined>(() => initialAccess);
  const [loading, setLoading] = useState(() => !initialAccess);
  const [refreshingUsage, setRefreshingUsage] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [usageRefreshError, setUsageRefreshError] = useState("");
  const [message, setMessage] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [breakdownOpen, setBreakdownOpen] = useState<BreakdownModalOpenState>();
  const [modelStatusOpen, setModelStatusOpen] = useState(initialModelStatusOpen);
  const [draft, setDraft] = useState<TokenDraft>(() => freshTokenDraft(catalog.currentUser.email));
  const [editDrafts, setEditDrafts] = useState<Record<string, TokenDraft>>({});
  const [selectedTokenId, setSelectedTokenId] = useState("");
  const [deleteTokenId, setDeleteTokenId] = useState("");
  const [rotateTokenId, setRotateTokenId] = useState("");
  const rotationInFlight = useRef(false);
  const [newlyCreatedTokenId, setNewlyCreatedTokenId] = useState("");
  const [sessionSecrets, setSessionSecrets] = useState<Record<string, string>>({});
  const [createdSecretRecovery, setCreatedSecretRecovery] = useState("");
  const initialAccessLoadStarted = useRef(false);
  const automaticUsageRefreshAttempted = useRef(false);
  const usageRefreshInFlight = useRef(false);
  const busyUsageReloadTimer = useRef<number | undefined>(undefined);

  const loadAccess = useCallback(async ({
    background = false,
    forceRefresh = false
  }: {
    background?: boolean;
    forceRefresh?: boolean;
  } = {}) => {
    if (!background) {
      setLoading(true);
      setError("");
      setUsageRefreshError("");
    }

    try {
      const payload = await loadMemoryResource({
        forceRefresh,
        key: accessCacheKey,
        load: fetchGatewayAccess,
        maxAgeMs: TOKEN_ACCESS_CACHE_MAX_AGE_MS
      });
      setAccess(payload);
      setEditDrafts((current) => {
        const next = { ...current };
        payload.tokens.forEach((token) => {
          next[token.id] = next[token.id] ?? draftFromToken(token);
        });
        return next;
      });
    } catch {
      if (!background) {
        setError(t("my.accessUnavailable"));
      }
    } finally {
      if (!background) {
        setLoading(false);
      }
    }
  }, [accessCacheKey, t]);

  useEffect(() => {
    if (initialAccessLoadStarted.current) {
      return;
    }
    initialAccessLoadStarted.current = true;
    void loadAccess();
  }, [loadAccess]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchGatewayUsageSummary(controller.signal)
      .then((summary) => {
        if (!controller.signal.aborted) {
          setUsageSummaryCache({ key: accessCacheKey, summary });
        }
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, [accessCacheKey]);

  useEffect(() => {
    const refreshAccess = () => void loadAccess({ forceRefresh: true });
    window.addEventListener("workspace:refresh-my-token", refreshAccess);
    return () => window.removeEventListener("workspace:refresh-my-token", refreshAccess);
  }, [loadAccess]);

  useEffect(() => () => {
    if (busyUsageReloadTimer.current !== undefined) {
      window.clearTimeout(busyUsageReloadTimer.current);
    }
  }, []);

  useEffect(() => {
    if (initialModelStatusOpen) {
      setModelStatusOpen(true);
    }
  }, [initialModelStatusOpen]);

  const refreshUsage = useCallback(async (trigger: "automatic" | "manual") => {
    if (usageRefreshInFlight.current) {
      return;
    }

    usageRefreshInFlight.current = true;
    setRefreshingUsage(true);
    setUsageRefreshError("");
    if (trigger === "manual") {
      setMessage("");
    }

    try {
      const payload = await refreshGatewayUsage(trigger === "automatic" ? { trigger } : undefined);
      setAccess((current) => {
        if (!current) return current;
        const next = {
          ...current,
          source: payload.source,
          analytics: payload.analytics,
          usage: payload.usage,
          series: payload.series,
          usageRefresh: { recommended: false as const, reason: "current" as const }
        };
        writeMemoryResource(accessCacheKey, next);
        return next;
      });
      if (trigger === "manual") {
        setMessage(t("my.statisticsUpdated"));
      }
    } catch (cause) {
      if (
        cause instanceof GatewayTokenApiError
        && cause.status === 409
        && cause.code === "usage_refresh_in_progress"
      ) {
        if (busyUsageReloadTimer.current !== undefined) {
          window.clearTimeout(busyUsageReloadTimer.current);
        }
        busyUsageReloadTimer.current = window.setTimeout(() => {
          busyUsageReloadTimer.current = undefined;
          void loadAccess({ background: true, forceRefresh: true });
        }, 750);
      } else if (trigger === "manual") {
        setUsageRefreshError(t("my.statisticsRefreshFailed"));
      }
    } finally {
      usageRefreshInFlight.current = false;
      setRefreshingUsage(false);
    }
  }, [accessCacheKey, loadAccess, t]);

  useEffect(() => {
    if (!access || automaticUsageRefreshAttempted.current) {
      return;
    }

    automaticUsageRefreshAttempted.current = true;
    if (access.usageRefresh?.recommended) {
      void refreshUsage("automatic");
    }
  }, [access, refreshUsage]);

  const tokens = access?.tokens ?? [];
  const series = access?.series ?? [];
  const analytics = access?.analytics;
  const usageSnapshotAvailable = analytics
    ? analytics.status === "ready" || Boolean(analytics.dataThroughDate)
    : true;
  const dataThroughDate = analytics?.dataThroughDate ?? latestCompleteShanghaiDate();
  const fallbackMonthlyUsage = useMemo(() => summarizeMonthlyRollups(access?.usage ?? []), [access?.usage]);
  const monthlyUsage = useMemo(() => {
    const summary = summarizeSeries(series);
    return summary.requests > 0 || summary.billableUnits > 0 || summary.estimatedCostUsd > 0
      ? summary
      : fallbackMonthlyUsage;
  }, [fallbackMonthlyUsage, series]);
  const dailyUsage = useMemo(
    () => analytics
      ? buildAnnualDailyUsage(analytics.dailyUsage ?? [], dataThroughDate)
      : buildAnnualDailyUsageFromSeries(series, dataThroughDate),
    [analytics, dataThroughDate, series]
  );
  const tokenRows = useMemo(
    () => analytics
      ? buildTokenRowsFromAnalytics(tokens, analytics.tokenUsage ?? [])
      : buildTokenRows(tokens, series),
    [analytics, series, tokens]
  );
  const selectedRow = tokenRows.find((row) => row.token.id === selectedTokenId);
  const deleteRow = tokenRows.find((row) => row.token.id === deleteTokenId);
  const rotateRow = tokenRows.find((row) => row.token.id === rotateTokenId);
  const liveMonthlyBudgetUsd = useMemo(
    () => effectiveMonthlyBudgetUsd(access?.userLimit, catalog.currentUser),
    [access?.userLimit, catalog.currentUser]
  );
  const cumulativeTokens = analytics?.summary.cumulativeTokens
    ?? usageSummary?.cumulativeTokens
    ?? monthlyUsage.billableUnits;
  const dailyPeakTokens = analytics?.summary.peakDailyTokens ?? peakDailyTokens(dailyUsage);
  const currentMonthSpendUsd = analytics?.summary.currentMonthSpendUsd ?? monthlyUsage.estimatedCostUsd;
  const modelOptions = useMemo(() => gatewayModelOptions(access), [access]);
  const gatewayUrl = (access?.gatewayUrl || "https://token.example.invalid").replace(/\/+$/, "");
  const gatewayBaseUrl = `${gatewayUrl}/v1`;

  async function handleRefreshUsage() {
    await refreshUsage("manual");
  }

  useEffect(() => {
    if (selectedTokenId && !tokens.some((token) => token.id === selectedTokenId)) {
      setSelectedTokenId("");
    }
  }, [selectedTokenId, tokens]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyId("create");
    setError("");
    setMessage("");

    try {
      const payload = await createGatewayToken(draft);
      const token = payload.token ?? "";
      let tokenRecord = payload.tokenRecord;
      if (token && !tokenRecord?.id) {
        try {
          const latestAccess = await fetchGatewayAccess();
          tokenRecord = latestAccess.tokens.find((item) => item.name === draft.name.trim());
        } catch {
          // Keep the issued secret available in the create modal if reconciliation is unavailable.
        }
      }

      if (!token || !tokenRecord?.id) {
        if (token) {
          setCreatedSecretRecovery(token);
        } else {
          setError(t("my.createTokenFailed"));
        }
        return;
      }

      const createdTokenRecord = tokenRecord;
      setSessionSecrets((current) => ({ ...current, [createdTokenRecord.id]: token }));
      setAccess((current) => {
        const base: GatewayAccessResponse = current ?? {
          source: {
            provider: "litellm",
            mode: "admin-api",
            fetchedAt: new Date().toISOString(),
            endpoints: []
          },
          gatewayUrl: "https://token.example.invalid",
          tokens: [],
          usage: [],
          series: []
        };
        return {
          ...base,
          tokens: [createdTokenRecord, ...base.tokens.filter((item) => item.id !== createdTokenRecord.id)]
        };
      });
      setEditDrafts((current) => ({ ...current, [createdTokenRecord.id]: draftFromToken(createdTokenRecord) }));
      setNewlyCreatedTokenId(createdTokenRecord.id);
      setSelectedTokenId(createdTokenRecord.id);
      setDraft(freshTokenDraft(catalog.currentUser.email));
      setCreatedSecretRecovery("");
      setCreateOpen(false);
      void loadAccess({ background: true, forceRefresh: true }).then(() => {
        setAccess((current) => current ? ({
          ...current,
          tokens: [createdTokenRecord, ...current.tokens.filter((item) => item.id !== createdTokenRecord.id)]
        }) : current);
      });
    } catch (cause) {
      if (cause instanceof GatewayTokenApiError && cause.code === "gateway_token_name_conflict") {
        setError(t("my.tokenNameConflict"));
      } else if (cause instanceof GatewayTokenApiError && cause.code === "invalid_gateway_token_name") {
        setError(t("my.tokenNameInvalid"));
      } else {
        setError(t("my.createTokenFailed"));
      }
    } finally {
      setBusyId("");
    }
  }

  async function handleUpdate(tokenId: string) {
    const editDraft = editDrafts[tokenId];
    if (!editDraft) {
      return;
    }

    await runTokenAction(
      tokenId,
      t("my.updateTokenSuccess"),
      (cause) => gatewayTokenNameError(cause, {
        conflict: t("my.tokenNameConflict"),
        fallback: t("my.updateTokenFailed"),
        invalid: t("my.tokenNameInvalid")
      }),
      () => updateGatewayToken(tokenId, editDraft)
    );
  }

  async function handleSuspend(tokenId: string) {
    await runTokenAction(tokenId, t("my.tokenSuspended"), t("my.tokenSuspendFailed"), () => suspendGatewayToken(tokenId));
  }

  async function handleActivate(tokenId: string) {
    await runTokenAction(tokenId, t("my.tokenActivated"), t("my.tokenActivateFailed"), () => activateGatewayToken(tokenId));
  }

  async function handleRotate(tokenId: string) {
    if (rotationInFlight.current || tokenId !== rotateTokenId) return;
    rotationInFlight.current = true;
    setBusyId(tokenId);
    setError("");
    setMessage("");

    try {
      const payload = await rotateGatewayToken(tokenId);
      const token = payload.token ?? "";
      const tokenRecord = payload.tokenRecord;
      if (!token || !tokenRecord?.id) {
        throw new Error("token_rotate_invalid_response");
      }

      setSessionSecrets((current) => {
        const next = { ...current };
        delete next[tokenId];
        next[tokenRecord.id] = token;
        return next;
      });
      setEditDrafts((current) => {
        const next = { ...current };
        const previousDraft = next[tokenId];
        delete next[tokenId];
        next[tokenRecord.id] = previousDraft ?? draftFromToken(tokenRecord);
        return next;
      });
      setAccess((current) => {
        if (!current) return current;
        const next = applyGatewayTokenRotation(
          current,
          tokenId,
          tokenRecord,
          payload.warning === "gateway_token_rotation_old_key_state_unknown"
        );
        writeMemoryResource(accessCacheKey, next);
        return next;
      });
      setSelectedTokenId(tokenRecord.id);
      setRotateTokenId("");
      setBusyId(tokenRecord.id);
      setMessage(t(payload.warning === "gateway_token_rotation_old_key_state_unknown"
        ? "portal.token.rotateStateUnknown"
        : payload.warning === "gateway_token_rotation_archive_pending"
          ? "portal.token.rotateArchivePending"
          : payload.warning === "gateway_token_rotation_alias_pending"
            ? "portal.token.rotateAliasPending"
            : "portal.token.rotateSuccess"));
    } catch {
      setError(t("portal.token.rotateFailed"));
    } finally {
      rotationInFlight.current = false;
      setBusyId("");
    }
  }

  async function handleDelete() {
    if (!deleteTokenId) {
      return;
    }

    const tokenId = deleteTokenId;
    setBusyId(tokenId);
    setError("");
    setMessage("");

    try {
      await deleteGatewayToken(tokenId);
      setMessage(t("my.revokeTokenSuccess"));
      setDeleteTokenId("");
      setSelectedTokenId("");
      await loadAccess({ forceRefresh: true });
    } catch {
      setError(t("my.revokeTokenFailed"));
    } finally {
      setBusyId("");
    }
  }

  async function runTokenAction(
    tokenId: string,
    successMessage: string,
    failureMessage: string | ((cause: unknown) => string),
    action: () => Promise<void>
  ) {
    setBusyId(tokenId);
    setError("");
    setMessage("");

    try {
      await action();
      setMessage(successMessage);
      await loadAccess({ forceRefresh: true });
    } catch (cause) {
      setError(typeof failureMessage === "function" ? failureMessage(cause) : failureMessage);
    } finally {
      setBusyId("");
    }
  }

  function updateEditDraft(tokenId: string, updates: Partial<TokenDraft>) {
    setError("");
    setEditDrafts((current) => ({
      ...current,
      [tokenId]: { ...(current[tokenId] ?? emptyTokenDraft), ...updates }
    }));
  }

  function closeCreateModal() {
    setCreateOpen(false);
    setError("");
    setCreatedSecretRecovery("");
  }

  function openCreateModal() {
    setDraft(freshTokenDraft(catalog.currentUser.email));
    setError("");
    setCreatedSecretRecovery("");
    setMessage("");
    setNewlyCreatedTokenId("");
    setCreateOpen(true);
  }

  if (loading && !access && !usageSummary?.hasSnapshot) {
    return <PortalRouteLoading variant="token" />;
  }

  return (
    <div className="portal-workspace-inner portal-token-workspace">
      <section className="portal-page portal-token-page" aria-labelledby="portal-token-title">
        <PageHeading
          id="portal-token-title"
          className="portal-editorial-heading portal-token-heading"
          title={t("portal.token.title")}
          eyebrow={<><div className="portal-editorial-kicker">
              <span aria-hidden="true" className="portal-editorial-mark"><i /></span>
              <span>{t("portal.token.kicker")}</span>
            </div></>}
          actions={<><div className="portal-token-heading-actions">
            <Button
              disabled={!access}
              iconBefore={<RefreshCw size={16} />}
              isLoading={refreshingUsage}
              onClick={() => void handleRefreshUsage()}
            >
              {t("my.refreshStatistics")}
            </Button>
            <Button iconBefore={<Plus size={16} />} onClick={openCreateModal} variant="primary">
              {t("my.createNewToken")}
            </Button>
          </div></>}
        ><blockquote className="portal-editorial-quote">
              <p>{t("portal.token.editorialQuote")}</p>
              <cite>{t("portal.token.editorialSource")}</cite>
            </blockquote></PageHeading>

        {!access ? (
          <>
            {usageSummary?.hasSnapshot && (
              <PortalTokenEarlyTotal
                cumulativeTokens={usageSummary.cumulativeTokens}
                updatedAt={usageSummary.updatedAt}
              />
            )}
            {loading ? (
              <PortalRouteLoading variant="token" />
            ) : (
          <section className="portal-token-state error" role="alert">
            <span className="portal-token-state-icon"><KeyRound size={22} /></span>
            <div><h2>{t("my.accessUnavailable")}</h2><p>{t("portal.token.errorBody")}</p></div>
            <Button iconBefore={<RefreshCw size={16} />} onClick={() => void loadAccess({ forceRefresh: true })}>{t("portal.token.retry")}</Button>
          </section>
            )}
          </>
        ) : (
          <>
            <PortalTokenOverview
              activityLead={<PortalTokenModelHealthEntry onOpen={() => setModelStatusOpen(true)} />}
              budgetSpendUsd={access.userLimit?.spendUsd ?? 0}
              cumulativeTokens={cumulativeTokens}
              currentMonthSpendUsd={currentMonthSpendUsd}
              dailyUsage={dailyUsage}
              monthlyBudgetUsd={liveMonthlyBudgetUsd}
              onOpenBreakdown={(scope, date) => setBreakdownOpen({ scope, date })}
              peakDailyTokenCount={dailyPeakTokens}
              snapshotDataThroughAt={analytics?.dataThroughAt ?? usageSummary?.dataThroughAt}
              snapshotDataThroughDate={analytics ? analytics.dataThroughDate : dataThroughDate}
              snapshotStatus={analytics?.status ?? (usageSummary?.hasSnapshot ? "ready" : "pending")}
              snapshotTimezone={analytics?.timezone ?? "Asia/Shanghai"}
              snapshotUpdatedAt={analytics?.updatedAt ?? usageSummary?.updatedAt}
            />

            {(message || error || usageRefreshError) && (
              <div
                className={`portal-token-notice ${error || usageRefreshError ? "error" : "success"}`}
                role={error || usageRefreshError ? "alert" : "status"}
              >
                {error || usageRefreshError || message}
              </div>
            )}

            <div className="portal-token-ledger-title">
              <div><p className="portal-kicker">{t("portal.token.ledgerKicker")}</p><h2>{t("portal.token.ledger")}</h2></div>
              <span>{t("portal.token.keyCount", { count: tokenRows.length })}</span>
            </div>

            {tokenRows.length > 0 ? (
              <PortalTokenLedger
                apiKey={selectedRow ? sessionSecrets[selectedRow.token.id] : undefined}
                busyId={busyId}
                draft={selectedRow ? editDrafts[selectedRow.token.id] ?? draftFromToken(selectedRow.token) : undefined}
                error={error}
                gatewayBaseUrl={gatewayBaseUrl}
                modelOptions={modelOptions}
                monthlyBudgetUsd={liveMonthlyBudgetUsd}
                onActivate={(tokenId) => void handleActivate(tokenId)}
                onCloseInspector={() => {
                  setError("");
                  setNewlyCreatedTokenId("");
                  setSelectedTokenId("");
                }}
                onDelete={(tokenId) => {
                  setDeleteTokenId(tokenId);
                  setSelectedTokenId("");
                }}
                onDraftChange={updateEditDraft}
                onOpen={(tokenId) => {
                  setError("");
                  setMessage("");
                  setNewlyCreatedTokenId("");
                  setSelectedTokenId(tokenId);
                }}
                onRotate={(tokenId) => {
                  setError("");
                  setRotateTokenId(tokenId);
                }}
                onSave={(tokenId) => void handleUpdate(tokenId)}
                onSuspend={(tokenId) => void handleSuspend(tokenId)}
                selected={selectedRow}
                newlyCreatedTokenId={newlyCreatedTokenId}
                tokenRows={tokenRows}
                usageAvailable={usageSnapshotAvailable}
              />
            ) : (
              <section className="portal-token-empty">
                <span><KeyRound size={24} /></span>
                <div><h2>{t("my.emptyTokenTitle")}</h2><p>{t("my.emptyTokenBody")}</p></div>
                <Button iconBefore={<Plus size={16} />} onClick={openCreateModal} variant="primary">{t("my.requestToken")}</Button>
              </section>
            )}
          </>
        )}
      </section>

      {breakdownOpen && (
        <Suspense fallback={null}>
          <PortalTokenBreakdownModal
            initialDate={breakdownOpen.date}
            initialScope={breakdownOpen.scope}
            keys={tokenRows.map((row) => row.token)}
            modelOptions={modelOptions}
            onClose={() => setBreakdownOpen(undefined)}
          />
        </Suspense>
      )}

      {createOpen && (
        <Suspense fallback={null}>
          <PortalTokenCreateModal
            busy={busyId === "create"}
            createdSecret={createdSecretRecovery}
            draft={draft}
            error={error}
            monthlyBudgetUsd={liveMonthlyBudgetUsd}
            onClose={closeCreateModal}
            onDraftChange={setDraft}
            onSubmit={handleCreate}
          />
        </Suspense>
      )}
      {rotateRow && (
        <Suspense fallback={null}>
          <PortalTokenRotateModal
            busy={busyId === rotateRow.token.id}
            error={error}
            name={rotateRow.token.name}
            onClose={() => { if (!rotationInFlight.current) setRotateTokenId(""); }}
            onConfirm={() => void handleRotate(rotateRow.token.id)}
          />
        </Suspense>
      )}
      {deleteRow && (
        <Suspense fallback={null}>
          <PortalTokenDeleteModal
            busy={busyId === deleteRow.token.id}
            name={deleteRow.token.name}
            onClose={() => setDeleteTokenId("")}
            onConfirm={() => void handleDelete()}
          />
        </Suspense>
      )}
      {modelStatusOpen && (
        <Suspense fallback={null}>
          <PortalModelHealth onClose={() => {
            setModelStatusOpen(false);
            onModelStatusClosed?.();
          }} />
        </Suspense>
      )}
    </div>
  );
}

function freshTokenDraft(email: string): TokenDraft {
  return {
    ...emptyTokenDraft,
    name: buildDefaultGatewayTokenName(email)
  };
}

function gatewayTokenNameError(
  cause: unknown,
  messages: { conflict: string; fallback: string; invalid: string }
) {
  if (cause instanceof GatewayTokenApiError && cause.code === "gateway_token_name_conflict") {
    return messages.conflict;
  }
  if (cause instanceof GatewayTokenApiError && cause.code === "invalid_gateway_token_name") {
    return messages.invalid;
  }
  return messages.fallback;
}
