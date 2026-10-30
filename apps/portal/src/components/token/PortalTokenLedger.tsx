import {
  ChevronRight,
  KeyRound
} from "lucide-react";
import { useI18n } from "../../../../../src/portal/i18n";
import {
  formatDate,
  formatNumber,
  formatUsd
} from "../../../../../src/portal/token/models";
import type {
  GatewayModelOption,
  TokenDraft,
  TokenUsageRow
} from "../../../../../src/portal/token/types";
import { PortalTokenDetailModal } from "./PortalTokenDetailModal";

export function PortalTokenLedger({
  apiKey,
  busyId,
  draft,
  error,
  gatewayBaseUrl,
  modelOptions,
  monthlyBudgetUsd,
  newlyCreatedTokenId,
  onActivate,
  onCloseInspector,
  onDelete,
  onDraftChange,
  onOpen,
  onRotate,
  onSave,
  onSuspend,
  selected,
  tokenRows,
  usageAvailable
}: {
  apiKey?: string;
  busyId: string;
  draft?: TokenDraft;
  error: string;
  gatewayBaseUrl: string;
  modelOptions: GatewayModelOption[];
  monthlyBudgetUsd: number;
  newlyCreatedTokenId: string;
  onActivate: (tokenId: string) => void;
  onCloseInspector: () => void;
  onDelete: (tokenId: string) => void;
  onDraftChange: (tokenId: string, updates: Partial<TokenDraft>) => void;
  onOpen: (tokenId: string) => void;
  onRotate: (tokenId: string) => void;
  onSave: (tokenId: string) => void;
  onSuspend: (tokenId: string) => void;
  selected?: TokenUsageRow;
  tokenRows: TokenUsageRow[];
  usageAvailable: boolean;
}) {
  const { t } = useI18n();

  return (
    <div className={`portal-token-ledger-layout ${selected ? "has-inspector" : ""}`}>
      <section className="portal-token-ledger" aria-label={t("portal.token.ledger")}>
        <div className="portal-token-ledger-header" aria-hidden="true">
          <span>{t("my.table.token")}</span>
          <span>{t("my.table.monthlyUnits")}</span>
          <span>{t("my.table.estimatedCost")}</span>
          <span>{t("my.table.lastUsed")}</span>
          <span>{t("portal.token.open")}</span>
        </div>
        {tokenRows.map((row) => (
          <TokenLedgerRow
            active={selected?.token.id === row.token.id}
            key={row.token.id}
            onOpen={() => onOpen(row.token.id)}
            row={row}
            usageAvailable={usageAvailable}
          />
        ))}
      </section>

      {selected && draft && (
        <PortalTokenDetailModal
          apiKey={apiKey}
          busy={busyId === selected.token.id}
          draft={draft}
          error={error}
          gatewayBaseUrl={gatewayBaseUrl}
          modelOptions={modelOptions}
          monthlyBudgetUsd={monthlyBudgetUsd}
          newlyCreated={selected.token.id === newlyCreatedTokenId}
          onActivate={() => onActivate(selected.token.id)}
          onClose={onCloseInspector}
          onDelete={() => onDelete(selected.token.id)}
          onDraftChange={(updates) => onDraftChange(selected.token.id, updates)}
          onRotate={() => onRotate(selected.token.id)}
          onSave={() => onSave(selected.token.id)}
          onSuspend={() => onSuspend(selected.token.id)}
          row={selected}
          usageAvailable={usageAvailable}
        />
      )}
    </div>
  );
}

function TokenLedgerRow({
  active,
  onOpen,
  row,
  usageAvailable
}: {
  active: boolean;
  onOpen: () => void;
  row: TokenUsageRow;
  usageAvailable: boolean;
}) {
  const { locale, t } = useI18n();
  const { token, usage } = row;
  const suspended = token.accessStatus === "suspended";

  return (
    <button
      aria-label={t("portal.token.manageKey", { name: token.name })}
      aria-pressed={active}
      className={`portal-token-row ${active ? "active" : ""}`}
      onClick={onOpen}
      type="button"
    >
      <span className="portal-token-row-identity">
        <span className="portal-token-key-icon" aria-hidden="true"><KeyRound size={18} /></span>
        <span>
          <strong>{token.name}</strong>
          <code>{token.tokenPrefix}...{token.tokenLast4}</code>
          <small className={token.status === "active" && !suspended ? "active" : "limited"}>
            {suspended ? t("my.paused") : token.status}
          </small>
        </span>
      </span>
      <span data-label={t("my.table.monthlyUnits")}><strong>{usageAvailable ? formatNumber(usage.billableUnits) : "—"}</strong></span>
      <span data-label={t("my.table.estimatedCost")}><strong>{usageAvailable ? formatUsd(usage.estimatedCostUsd) : "—"}</strong></span>
      <span data-label={t("my.table.lastUsed")}><strong>{token.lastUsedAt ? formatDate(token.lastUsedAt, locale) : t("my.never")}</strong></span>
      <span className="portal-token-row-open" aria-hidden="true"><ChevronRight size={18} /></span>
    </button>
  );
}
