import { FeedbackNotice } from "../../../../../src/portal/components/FeedbackNotice";
import {
  Braces,
  CheckCircle2,
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  PauseCircle,
  Play,
  PlayCircle,
  Save,
  Sparkles,
  TerminalSquare,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../../../../../src/portal/components/Button";
import { WorkspaceListbox } from "../../../../../src/portal/components/WorkspaceListbox";
import { FormField, TextArea, TextInput } from "../../../../../src/portal/components/FormField";
import { ModalShell } from "../../../../../src/portal/components/ModalShell";
import { SegmentedControl } from "../../../../../src/portal/components/SegmentedControl";
import { useI18n, type TranslationKey } from "../../../../../src/portal/i18n";
import { GatewayTokenApiError, testGatewayToken } from "../../../../../src/portal/token/apiClient";
import { copyText } from "../../../../../src/portal/token/clipboard";
import {
  budgetPercentLabel,
  budgetRangeStyle,
  formatDate,
  formatNumber,
  formatUsd,
  GATEWAY_TOKEN_NAME_INPUT_PATTERN,
  GATEWAY_TOKEN_NAME_MAX_LENGTH,
  isGatewayTokenNameValid
} from "../../../../../src/portal/token/models";
import type {
  GatewayModelOption,
  GatewayTokenTestResponse,
  TokenDraft,
  TokenUsagePurpose,
  TokenUsageRow
} from "../../../../../src/portal/token/types";
import { PortalTokenListboxField } from "./PortalTokenListboxField";
import { ModelCapabilitySummary, ModelCapabilityTable } from "./PortalTokenModelCapabilitiesModal";

type UsageScenario = "node" | "python" | "curl" | "agent";
type ResponseView = "result" | "json";
type RightPanelMode = "test" | "compare";
type ModelComparisonTab = "pricing" | "capabilities";

export function PortalTokenDetailModal({
  apiKey,
  busy,
  draft,
  error,
  gatewayBaseUrl,
  modelOptions,
  monthlyBudgetUsd,
  newlyCreated,
  onActivate,
  onClose,
  onDelete,
  onDraftChange,
  onRotate,
  onSave,
  onSuspend,
  row,
  usageAvailable
}: {
  apiKey?: string;
  busy: boolean;
  draft: TokenDraft;
  error: string;
  gatewayBaseUrl: string;
  modelOptions: GatewayModelOption[];
  monthlyBudgetUsd: number;
  newlyCreated: boolean;
  onActivate: () => void;
  onClose: () => void;
  onDelete: () => void;
  onDraftChange: (updates: Partial<TokenDraft>) => void;
  onRotate: () => void;
  onSave: () => void;
  onSuspend: () => void;
  row: TokenUsageRow;
  usageAvailable: boolean;
}) {
  const { locale, t } = useI18n();
  const { token, usage } = row;
  const [usageScenario, setUsageScenario] = useState<UsageScenario>("node");
  const [copyError, setCopyError] = useState(false);
  const [copiedKey, setCopiedKey] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [rightPanel, setRightPanel] = useState<RightPanelMode | null>(null);
  const [comparisonTab, setComparisonTab] = useState<ModelComparisonTab>("pricing");
  const testTriggerId = `portal-token-test-trigger-${token.id}`;
  const compareTriggerId = `portal-token-compare-trigger-${token.id}`;
  const pricingPanelId = `portal-token-pricing-${token.id}`;
  const suspended = token.accessStatus === "suspended";
  const disabled = token.status !== "active" || busy;
  const tokenNameChanged = draft.name.trim() !== token.name;
  const tokenNameValid = !tokenNameChanged || isGatewayTokenNameValid(draft.name);
  const allowedModelOptions = useMemo(() => {
    const allowedModels = token.allowedModels ?? [];
    return allowedModels.length > 0
      ? modelOptions.filter((model) => allowedModels.includes(model.id))
      : modelOptions;
  }, [modelOptions, token.allowedModels]);
  const selectedModelOption = useMemo(
    () => allowedModelOptions.find((model) => model.id === selectedModel),
    [allowedModelOptions, selectedModel]
  );

  useEffect(() => {
    if (!allowedModelOptions.some((model) => model.id === selectedModel)) {
      setSelectedModel(allowedModelOptions[0]?.id ?? "");
    }
  }, [allowedModelOptions, selectedModel]);

  const usageSnippet = buildUsageSnippet(usageScenario, gatewayBaseUrl, selectedModel);

  async function copyValue(key: string, value: string) {
    if (!value) return;
    setCopyError(false);
    try {
      await copyText(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => current === key ? "" : current), 1600);
    } catch {
      setCopyError(true);
      window.setTimeout(() => setCopyError(false), 2400);
    }
  }

  function closeSidePanel() {
    const focusTargetId = rightPanel === "compare" ? compareTriggerId : testTriggerId;
    setRightPanel(null);
    window.requestAnimationFrame(() => document.getElementById(focusTargetId)?.focus());
  }

  return (
    <ModalShell
      ariaLabel={t("portal.token.manageKey", { name: token.name })}
      modalClassName={`portal-token-detail-modal ${rightPanel ? "has-side-panel" : ""}`}
      onClose={onClose}
      overlayClassName="portal-token-modal-overlay portal-token-detail-overlay"
    >
      <div className="portal-token-detail-shell">
        <header className="portal-token-detail-header">
          <div>
            <p className="portal-kicker">{t("portal.token.inspectorKicker")}</p>
            {newlyCreated && <p className="portal-token-created-title">{t("portal.token.secretTitle")}</p>}
            <h2>{token.name}</h2>
            <code>{token.tokenPrefix}...{token.tokenLast4}</code>
          </div>
          <div className="portal-token-detail-header-actions">
            <Button
              aria-pressed={rightPanel === "test"}
              id={testTriggerId}
              iconBefore={<Play size={16} />}
              onClick={() => setRightPanel((current) => current === "test" ? null : "test")}
              variant={rightPanel === "test" ? "primary" : "secondary"}
            >
              {t("portal.token.test")}
            </Button>
            <Button aria-label={t("portal.token.closeInspector")} iconBefore={<X size={17} />} onClick={onClose} variant="icon" />
          </div>
        </header>

        <div className="portal-token-detail-body">
          <section className="portal-token-detail-manage" aria-label={t("portal.token.settings") }>
            <dl className="portal-token-inspector-stats">
              <div><dt>{t("my.table.monthlyUnits")}</dt><dd>{usageAvailable ? formatNumber(usage.billableUnits) : "—"}</dd></div>
              <div><dt>{t("my.table.estimatedCost")}</dt><dd>{usageAvailable ? formatUsd(usage.estimatedCostUsd) : "—"}</dd></div>
              <div><dt>{t("my.table.requests")}</dt><dd>{usageAvailable ? formatNumber(usage.requests) : "—"}</dd></div>
              <div><dt>{t("my.table.lastUsed")}</dt><dd>{token.lastUsedAt ? formatDate(token.lastUsedAt, locale) : t("my.never")}</dd></div>
            </dl>

            <div className="portal-token-inspector-form">
              <FormField
                description={t("my.tokenNameHint")}
                htmlFor={`portal-token-name-${token.id}`}
                label={t("my.tokenName")}
              >
                <TextInput
                  aria-invalid={tokenNameChanged && !tokenNameValid}
                  disabled={disabled}
                  id={`portal-token-name-${token.id}`}
                  maxLength={GATEWAY_TOKEN_NAME_MAX_LENGTH}
                  minLength={tokenNameChanged ? 2 : undefined}
                  onChange={(event) => onDraftChange({ name: event.target.value })}
                  pattern={tokenNameChanged ? GATEWAY_TOKEN_NAME_INPUT_PATTERN : undefined}
                  value={draft.name}
                />
              </FormField>
              <PortalTokenListboxField<TokenUsagePurpose>
                ariaLabel={t("portal.token.usagePurpose")}
                disabled={disabled}
                label={t("portal.token.usagePurpose")}
                onChange={(usagePurpose) => onDraftChange({ usagePurpose })}
                options={usagePurposeOptions(t)}
                value={draft.usagePurpose}
              />
              <FormField
                description={budgetPercentLabel(draft.monthlyBudgetPercent, monthlyBudgetUsd, { of: t("my.budgetOf"), perMonth: t("my.budgetPerMonth") })}
                htmlFor={`portal-token-budget-${token.id}`}
                label={t("my.budgetPercent")}
              >
                <input
                  disabled={disabled}
                  id={`portal-token-budget-${token.id}`}
                  max="100"
                  min="1"
                  onChange={(event) => onDraftChange({ monthlyBudgetPercent: event.target.value })}
                  style={budgetRangeStyle(draft.monthlyBudgetPercent)}
                  type="range"
                  value={draft.monthlyBudgetPercent}
                />
              </FormField>
              <Button disabled={disabled || !draft.name.trim() || !tokenNameValid} iconBefore={<Save size={16} />} isLoading={busy} onClick={onSave} variant="primary">
                {t("my.saveChanges")}
              </Button>
              {error && <FeedbackNotice tone="error">{error}</FeedbackNotice>}
            </div>

            {token.accessReason && token.accessReason !== "user_disabled" && (
              <p className="portal-token-access-reason">{token.accessReason}</p>
            )}
          </section>

          <section className="portal-token-inline-how" aria-label={t("my.howToAria")}>
            <header>
              <div>
                <p className="portal-kicker">{t("my.gatewayEyebrow")}</p>
                <h3>{t("my.howToTitle")}</h3>
              </div>
              <span>{t("portal.token.liteLlmCompatible")}</span>
            </header>

            <div className="portal-token-copy-list">
              <CopyRow
                copied={copiedKey === "base-url"}
                copyLabel={t("my.copyBaseUrl")}
                label={t("my.howTo.baseUrl")}
                onCopy={() => void copyValue("base-url", gatewayBaseUrl)}
                value={gatewayBaseUrl}
              />
              <CopyRow
                copied={copiedKey === "api-key"}
                copyLabel={t("portal.token.copyApiKey")}
                disabled={!apiKey}
                label={t("my.howTo.apiKey")}
                note={apiKey ? t("portal.token.sessionKeyReady") : (
                  <>
                    {t("portal.token.keyNotRecoverable")} {" "}
                    <button className="portal-token-rotate-link" disabled={disabled} onClick={onRotate} type="button">
                      {busy ? t("portal.token.rotatingKey") : t("portal.token.rotateKey")}
                    </button>
                  </>
                )}
                onCopy={() => void copyValue("api-key", apiKey ?? "")}
                revealable={Boolean(apiKey)}
                revealedByDefault={newlyCreated}
                secret
                value={apiKey || `sk-••••••••••••${token.tokenLast4}`}
              />
              <div className="portal-token-copy-row portal-token-model-copy-row">
                <div className="portal-token-model-label">
                  <span>{t("portal.token.supportedModels")}</span>
                  <button
                    id={compareTriggerId}
                    disabled={!selectedModelOption}
                    onClick={() => {
                      setComparisonTab("pricing");
                      setRightPanel("compare");
                    }}
                    type="button"
                  >
                    {t("portal.token.compareModels")}
                  </button>
                </div>
                <WorkspaceListbox
                  ariaLabel={t("portal.token.supportedModels")}
                  className="portal-token-model-listbox"
                  disabled={allowedModelOptions.length === 0}
                  noResultsLabel={t("common.noResults")}
                  onChange={setSelectedModel}
                  options={modelListboxOptions(allowedModelOptions)}
                  placeholder={t("my.modelsUnavailable")}
                  searchable="auto"
                  searchPlaceholder={t("common.search")}
                  value={selectedModel}
                />
                <CopyIcon
                  copied={copiedKey === "model"}
                  disabled={!selectedModel}
                  label={t("my.copyModel")}
                  onClick={() => void copyValue("model", selectedModel)}
                />
                <ModelPricingSummary model={selectedModelOption} />
                <ModelCapabilitySummary model={selectedModelOption} />
              </div>
            </div>
            {copyError && <FeedbackNotice tone="error">{t("portal.token.copyFailed")}</FeedbackNotice>}

            <div className="portal-token-agent-copy">
              <header>
                <div>
                  <strong>{t("portal.token.usageExamples")}</strong>
                  <p>{t("portal.token.usageExamplesBody")}</p>
                </div>
                <CopyIcon
                  copied={copiedKey === "usage-code"}
                  disabled={!selectedModel}
                  label={t("portal.token.copyUsageExample")}
                  onClick={() => void copyValue("usage-code", usageSnippet)}
                />
              </header>
              <SegmentedControl
                ariaLabel={t("portal.token.usageScenario")}
                className="portal-token-use-case-tabs"
                compact
                onChange={setUsageScenario}
                options={[
                  { icon: <Braces size={13} />, label: "Node.js", value: "node" },
                  { icon: <Sparkles size={13} />, label: "Python", value: "python" },
                  { icon: <TerminalSquare size={13} />, label: "cURL", value: "curl" },
                  { icon: <KeyRound size={13} />, label: "Agent / CLI", value: "agent" }
                ]}
                value={usageScenario}
              />
              <pre aria-live="polite"><code>{usageSnippet}</code></pre>
              <small>{t("portal.token.liteLlmHint")}</small>
            </div>
          </section>
        </div>

        <footer className="portal-token-detail-footer">
          {suspended ? (
            <Button disabled={token.status !== "active"} iconBefore={<PlayCircle size={16} />} isLoading={busy} onClick={onActivate}>
              {t("my.activate")}
            </Button>
          ) : (
            <Button disabled={token.status !== "active"} iconBefore={<PauseCircle size={16} />} isLoading={busy} onClick={onSuspend}>
              {t("my.suspend")}
            </Button>
          )}
          <Button disabled={token.status !== "active" || busy} iconBefore={<Trash2 size={16} />} onClick={onDelete} variant="danger">
            {t("my.deleteToken")}
          </Button>
        </footer>
      </div>

      {rightPanel === "test" && (
        <PortalTokenTestPanel
          apiKey={apiKey}
          modelOptions={allowedModelOptions}
          onClose={closeSidePanel}
          onModelChange={setSelectedModel}
          selectedModel={selectedModel}
          tokenId={token.id}
          tokenName={token.name}
        />
      )}
      {rightPanel === "compare" && (
        <PortalTokenModelComparisonPanel
          models={allowedModelOptions}
          onClose={closeSidePanel}
          onTabChange={setComparisonTab}
          selectedModel={selectedModel}
          tab={comparisonTab}
          tableId={pricingPanelId}
        />
      )}
    </ModalShell>
  );
}

function ModelPricingSummary({ model }: { model?: GatewayModelOption }) {
  const { locale, t } = useI18n();
  const pricing = model?.pricing;

  return (
    <div className="portal-token-model-pricing" aria-live="polite">
      {pricing ? (
        <>
          <dl>
            <div>
              <dt>{t("portal.token.priceInput")}</dt>
              <dd>{formatModelPrice(pricing.inputPerMillionTokens, pricing.currency, locale)}</dd>
            </div>
            <div>
              <dt>{t("portal.token.priceOutput")}</dt>
              <dd>{formatModelPrice(pricing.outputPerMillionTokens, pricing.currency, locale)}</dd>
            </div>
            <div>
              <dt>{t("portal.token.priceCache")}</dt>
              <dd>{formatModelPrice(pricing.cacheReadPerMillionTokens, pricing.currency, locale)}</dd>
            </div>
          </dl>
          <small>{t("portal.token.priceUnit", { currency: pricing.currency })}</small>
        </>
      ) : (
        <span className="portal-token-model-pricing-empty">{t("portal.token.pricingUnavailable")}</span>
      )}
    </div>
  );
}

function ModelPricingTable({
  id,
  models,
  selectedModel
}: {
  id: string;
  models: GatewayModelOption[];
  selectedModel: string;
}) {
  const { locale, t } = useI18n();

  return (
    <section className="portal-token-pricing-panel" id={id}>
      <header>
        <strong>{t("portal.token.allModelPricing")}</strong>
        <span>{t("portal.token.allModelPricingUnit")}</span>
      </header>
      <div className="portal-token-pricing-table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">{t("portal.token.priceModel")}</th>
              <th scope="col">{t("portal.token.priceInput")}</th>
              <th scope="col">{t("portal.token.priceOutput")}</th>
              <th scope="col">{t("portal.token.priceCache")}</th>
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <tr className={model.id === selectedModel ? "selected" : undefined} key={model.id}>
                <th scope="row">
                  <strong>{model.displayName || model.id}</strong>
                  <code>{model.id}</code>
                </th>
                <td>{formatModelPrice(model.pricing?.inputPerMillionTokens, model.pricing?.currency, locale)}</td>
                <td>{formatModelPrice(model.pricing?.outputPerMillionTokens, model.pricing?.currency, locale)}</td>
                <td>{formatModelPrice(model.pricing?.cacheReadPerMillionTokens, model.pricing?.currency, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatModelPrice(value: number | undefined, currency = "USD", locale = "en") {
  if (!Number.isFinite(value)) {
    return "—";
  }

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 4
  }).format(Number(value));
}

function PortalTokenModelComparisonPanel({
  models,
  onClose,
  onTabChange,
  selectedModel,
  tab,
  tableId
}: {
  models: GatewayModelOption[];
  onClose: () => void;
  onTabChange: (tab: ModelComparisonTab) => void;
  selectedModel: string;
  tab: ModelComparisonTab;
  tableId: string;
}) {
  const { t } = useI18n();
  return (
    <aside className="portal-token-side-panel portal-token-comparison-panel" aria-label={t("portal.token.compareModels")}>
      <header>
        <div>
          <p className="portal-kicker">{t("portal.token.capabilityKicker")}</p>
          <h3>{t("portal.token.compareModels")}</h3>
          <code>{t("portal.token.comparisonIntro")}</code>
        </div>
        <div className="portal-token-side-panel-actions">
          <Button aria-label={t("portal.token.closeTest")} iconBefore={<X size={16} />} onClick={onClose} variant="icon" />
        </div>
      </header>
      <SegmentedControl
        ariaLabel={t("portal.token.comparisonTabs")}
        className="portal-token-comparison-tabs"
        onChange={onTabChange}
        options={[
          { label: t("portal.token.priceComparison"), value: "pricing" },
          { label: t("portal.token.capabilityComparison"), value: "capabilities" }
        ]}
        value={tab}
      />
      <div className="portal-token-comparison-content">
        {tab === "pricing" ? (
          <ModelPricingTable id={tableId} models={models} selectedModel={selectedModel} />
        ) : (
          <>
            <p className="portal-token-capability-intro">{t("portal.token.capabilityScope")}</p>
            <ModelCapabilityTable models={models} selectedModel={selectedModel} />
            <footer className="portal-token-capability-legend">
              <span>{t("portal.token.capabilitySupported")}</span>
              <span>{t("portal.token.capabilityUnsupported")}</span>
              <span>{t("portal.token.capabilityUnknown")}</span>
            </footer>
          </>
        )}
      </div>
    </aside>
  );
}

function PortalTokenTestPanel({
  apiKey: initialApiKey,
  modelOptions,
  onClose,
  onModelChange,
  selectedModel,
  tokenId,
  tokenName
}: {
  apiKey?: string;
  modelOptions: GatewayModelOption[];
  onClose: () => void;
  onModelChange: (model: string) => void;
  selectedModel: string;
  tokenId: string;
  tokenName: string;
}) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState(initialApiKey ?? "");
  const [error, setError] = useState("");
  const [input, setInput] = useState(t("portal.token.testDefaultInput"));
  const [response, setResponse] = useState<GatewayTokenTestResponse>();
  const [responseView, setResponseView] = useState<ResponseView>("result");
  const [running, setRunning] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const requestControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    if (modelOptions.length === 0) apiKeyInputRef.current?.focus();
    return () => {
      mountedRef.current = false;
      requestControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (initialApiKey) setApiKey(initialApiKey);
  }, [initialApiKey]);

  async function runTest() {
    if (!apiKey.trim() || !input.trim() || !selectedModel || running) return;
    setRunning(true);
    setError("");
    setResponse(undefined);
    setResponseView("result");
    const controller = new AbortController();
    requestControllerRef.current = controller;
    try {
      const nextResponse = await testGatewayToken({
        apiKey: apiKey.trim(),
        input: input.trim(),
        model: selectedModel,
        signal: controller.signal,
        tokenId
      });
      if (mountedRef.current && !controller.signal.aborted) setResponse(nextResponse);
    } catch (runError) {
      if (mountedRef.current && !controller.signal.aborted) setError(testErrorMessage(runError, t));
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      if (mountedRef.current) setRunning(false);
    }
  }

  function closePanel() {
    requestControllerRef.current?.abort();
    onClose();
  }

  return (
    <aside className="portal-token-side-panel" aria-label={t("portal.token.testPanelAria")}>
      <header>
        <div>
          <p className="portal-kicker">{t("portal.token.liveCredentialCheck")}</p>
          <h3>{t("portal.token.testToken")}</h3>
          <code>{tokenName}</code>
        </div>
        <div className="portal-token-side-panel-actions">
          <Button aria-label={t("portal.token.closeTest")} iconBefore={<X size={16} />} onClick={closePanel} variant="icon" />
        </div>
      </header>

      <div className="portal-token-test-fields">
        <FormField
          description={initialApiKey ? t("portal.token.sessionKeyReady") : t("portal.token.pasteKeyHint")}
          htmlFor={`portal-token-test-key-${tokenId}`}
          label={t("my.howTo.apiKey")}
          required
        >
          <span className="portal-token-secret-input">
            <TextInput
              autoComplete="off"
              id={`portal-token-test-key-${tokenId}`}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={t("portal.token.keyPlaceholder")}
              ref={apiKeyInputRef}
              spellCheck={false}
              type={showKey ? "text" : "password"}
              value={apiKey}
            />
            <button
              aria-label={t(showKey ? "portal.token.hideKey" : "portal.token.showKey")}
              onClick={() => setShowKey((visible) => !visible)}
              type="button"
            >
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </span>
        </FormField>
        <PortalTokenListboxField
          ariaLabel={t("portal.token.supportedModels")}
          autoFocus={modelOptions.length > 0}
          disabled={modelOptions.length === 0}
          label={t("portal.token.supportedModels")}
          noResultsLabel={t("common.noResults")}
          onChange={onModelChange}
          options={modelListboxOptions(modelOptions)}
          placeholder={t("my.modelsUnavailable")}
          searchable="auto"
          searchPlaceholder={t("common.search")}
          value={selectedModel}
        />
        <FormField htmlFor={`portal-token-test-input-${tokenId}`} label={t("portal.token.input")} required>
          <TextArea
            id={`portal-token-test-input-${tokenId}`}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void runTest();
              }
            }}
            value={input}
          />
        </FormField>
        <div className="portal-token-test-run-row">
          {error && <span role="alert"><CircleAlert size={15} /> {error}</span>}
          <Button
            disabled={!apiKey.trim() || !input.trim() || !selectedModel}
            iconBefore={<Play size={16} />}
            isLoading={running}
            onClick={() => void runTest()}
            variant="primary"
          >
            {t(running ? "portal.token.running" : "portal.token.run")}
          </Button>
        </div>
      </div>

      <section className="portal-token-test-output" aria-label={t("portal.token.output")}>
        <header>
          <div>
            <h4>{t("portal.token.output")}</h4>
            {response && (
              <span><CheckCircle2 size={14} /> {t("portal.token.usable")}</span>
            )}
          </div>
          <SegmentedControl
            ariaLabel={t("portal.token.outputView")}
            compact
            onChange={setResponseView}
            options={[
              { icon: <Sparkles size={13} />, label: t("portal.token.result"), value: "result" },
              { icon: <Braces size={13} />, label: "JSON", value: "json" }
            ]}
            value={responseView}
          />
        </header>
        <div className="portal-token-test-output-body">
          {running ? (
            <p className="empty"><Sparkles size={18} /> {t("portal.token.waitingResponse")}</p>
          ) : !response ? (
            <p className="empty"><KeyRound size={18} /> {t("portal.token.noTestResponse")}</p>
          ) : responseView === "json" ? (
            <pre>{JSON.stringify(response.raw, null, 2)}</pre>
          ) : (
            <div className="portal-token-test-result">{response.content || t("portal.token.emptyResponse")}</div>
          )}
        </div>
        {response && (
          <footer>
            <span>{response.latencyMs} ms</span>
            <span>{t("portal.token.tokenUsage", { count: response.usage.totalTokens })}</span>
            {response.requestId && <code>{response.requestId}</code>}
          </footer>
        )}
      </section>
    </aside>
  );
}

function CopyRow({
  copied,
  copyLabel,
  disabled = false,
  label,
  note,
  onCopy,
  revealable = false,
  revealedByDefault = false,
  secret = false,
  value
}: {
  copied: boolean;
  copyLabel: string;
  disabled?: boolean;
  label: string;
  note?: ReactNode;
  onCopy: () => void;
  revealable?: boolean;
  revealedByDefault?: boolean;
  secret?: boolean;
  value: string;
}) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(revealedByDefault);
  const displayValue = secret && !revealed ? maskApiKey(value) : value;

  return (
    <div className="portal-token-copy-row">
      <span>{label}</span>
      <code className={secret ? "secret" : ""}>{displayValue}</code>
      <div className="portal-token-copy-actions">
        {secret && revealable && (
          <button
            aria-label={t(revealed ? "portal.token.hideKey" : "portal.token.showKey")}
            className="portal-token-copy-icon"
            onClick={() => setRevealed((current) => !current)}
            title={t(revealed ? "portal.token.hideKey" : "portal.token.showKey")}
            type="button"
          >
            {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
        <CopyIcon copied={copied} disabled={disabled} label={copyLabel} onClick={onCopy} />
      </div>
      {note && <small>{note}</small>}
    </div>
  );
}

function CopyIcon({ copied, disabled = false, label, onClick }: { copied: boolean; disabled?: boolean; label: string; onClick: () => void }) {
  const { t } = useI18n();
  const accessibleLabel = copied ? t("portal.token.copied") : label;

  return (
    <button
      aria-label={accessibleLabel}
      className={`portal-token-copy-icon ${copied ? "copied" : ""}`}
      disabled={disabled}
      onClick={onClick}
      title={accessibleLabel}
      type="button"
    >
      {copied ? <CheckCircle2 size={15} /> : <Copy size={15} />}
    </button>
  );
}

function usagePurposeOptions(t: (key: TranslationKey) => string) {
  return [
    { label: t("portal.token.usagePurposeAgent"), value: "agent" as const },
    { label: t("portal.token.usagePurposeApp"), value: "app" as const }
  ];
}

function modelListboxOptions(models: GatewayModelOption[]) {
  return models.map((model) => ({
    label: model.displayName || model.id,
    searchText: model.id,
    value: model.id
  }));
}

function buildUsageSnippet(scenario: UsageScenario, baseUrl: string, model: string) {
  if (scenario === "python") {
    return `import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["WORKSPACE_LLM_APP_KEY"],
    base_url=${JSON.stringify(baseUrl)},
)

response = client.chat.completions.create(
    model=${JSON.stringify(model)},
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`;
  }

  if (scenario === "curl") {
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "Hello" }]
    }, null, 2);

    return `curl ${shellQuote(`${baseUrl}/chat/completions`)} \\
  -H "Authorization: Bearer \${WORKSPACE_LLM_APP_KEY}" \\
  -H "Content-Type: application/json" \\
  -d ${shellQuote(body)}`;
  }

  if (scenario === "agent") {
    return `export OPENAI_API_KEY="\${WORKSPACE_LLM_APP_KEY}"
export OPENAI_BASE_URL=${shellQuote(baseUrl)}
export OPENAI_MODEL=${shellQuote(model)}

# Start your OpenAI-compatible agent or CLI in this shell.`;
  }

  return `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.WORKSPACE_LLM_APP_KEY,
  baseURL: ${JSON.stringify(baseUrl)},
});

const response = await client.chat.completions.create({
  model: ${JSON.stringify(model)},
  messages: [{ role: "user", content: "Hello" }],
});`;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function maskApiKey(value: string) {
  const prefix = value.startsWith("sk-") ? "sk-" : "";
  return `${prefix}••••••••••••${value.slice(-4)}`;
}

function testErrorMessage(error: unknown, t: (key: TranslationKey, values?: Record<string, number | string | undefined>) => string) {
  const code = error instanceof Error ? error.message : "";
  const knownErrors: Record<string, TranslationKey> = {
    gateway_model_unavailable: "portal.token.testModelUnavailable",
    gateway_test_request_rejected: "portal.token.testRequestRejected",
    gateway_token_access_denied: "portal.token.testAccessDenied",
    gateway_token_auth_rejected: "portal.token.testAuthRejected",
    gateway_token_budget_exceeded: "portal.token.testBudgetExceeded",
    gateway_token_hash_unavailable: "portal.token.testHashUnavailable",
    gateway_token_inactive: "portal.token.testInactive",
    gateway_token_model_not_allowed: "portal.token.testModelNotAllowed",
    gateway_token_not_found: "portal.token.testNotFound",
    gateway_token_rate_limited: "portal.token.testRateLimited",
    gateway_token_secret_mismatch: "portal.token.testMismatch",
    gateway_token_suspended: "portal.token.testSuspended",
    llm_gateway_test_invalid_response: "portal.token.testInvalidResponse",
    llm_gateway_test_unavailable: "portal.token.testUnavailable",
    llm_gateway_test_timeout: "portal.token.testTimeout"
  };
  const key = knownErrors[code];
  const message = t(key ?? "portal.token.testFailed");
  return error instanceof GatewayTokenApiError && error.requestId
    ? `${message} ${t("portal.token.testRequestId", { id: error.requestId })}`
    : message;
}
