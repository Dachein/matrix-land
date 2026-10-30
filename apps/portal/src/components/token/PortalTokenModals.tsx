import { FeedbackNotice } from "../../../../../src/portal/components/FeedbackNotice";
import { Check, Copy, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "../../../../../src/portal/components/Button";
import { FormField, TextInput } from "../../../../../src/portal/components/FormField";
import { ModalShell } from "../../../../../src/portal/components/ModalShell";
import { useI18n, type TranslationKey } from "../../../../../src/portal/i18n";
import { copyText } from "../../../../../src/portal/token/clipboard";
import {
  budgetPercentLabel,
  budgetRangeStyle,
  GATEWAY_TOKEN_NAME_INPUT_PATTERN,
  GATEWAY_TOKEN_NAME_MAX_LENGTH,
  isGatewayTokenNameValid
} from "../../../../../src/portal/token/models";
import type {
  TokenDraft,
  TokenUsagePurpose
} from "../../../../../src/portal/token/types";
import { PortalTokenListboxField } from "./PortalTokenListboxField";

export function PortalTokenCreateModal({
  busy,
  createdSecret,
  draft,
  error,
  monthlyBudgetUsd,
  onClose,
  onDraftChange,
  onSubmit
}: {
  busy: boolean;
  createdSecret?: string;
  draft: TokenDraft;
  error: string;
  monthlyBudgetUsd: number;
  onClose: () => void;
  onDraftChange: (draft: TokenDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { t } = useI18n();
  const [secretCopied, setSecretCopied] = useState(false);
  const [secretCopyError, setSecretCopyError] = useState(false);
  const tokenNameValid = isGatewayTokenNameValid(draft.name);

  async function copyCreatedSecret() {
    if (!createdSecret) return;
    setSecretCopyError(false);
    try {
      await copyText(createdSecret);
      setSecretCopied(true);
      window.setTimeout(() => setSecretCopied(false), 1600);
    } catch {
      setSecretCopied(false);
      setSecretCopyError(true);
    }
  }

  return (
    <ModalShell
      ariaLabel={t(createdSecret ? "portal.token.secretRecoveryTitle" : "portal.token.createAria")}
      header={(
        <div>
          <p className="portal-kicker">{t("portal.token.createKicker")}</p>
          <h2>{createdSecret ? t("portal.token.secretRecoveryTitle") : t("my.createTokenTitle")}</h2>
        </div>
      )}
      headerActions={<Button aria-label={t("common.close")} iconBefore={<X size={18} />} onClick={onClose} variant="icon" />}
      headerClassName="portal-token-modal-header"
      modalClassName="portal-token-modal"
      onClose={onClose}
      overlayClassName="portal-token-modal-overlay"
    >
      {createdSecret ? (
        <section className="portal-token-secret-recovery" role="status">
          <p>{t("portal.token.secretRecoveryBody")}</p>
          <code>{createdSecret}</code>
          {secretCopyError && <FeedbackNotice tone="error">{t("portal.token.copyFailed")}</FeedbackNotice>}
          <div>
            <Button iconBefore={secretCopied ? <Check size={16} /> : <Copy size={16} />} onClick={() => void copyCreatedSecret()} variant="primary">
              {secretCopied ? t("portal.token.copied") : t("portal.token.copyApiKey")}
            </Button>
            <Button onClick={onClose}>{t("common.close")}</Button>
          </div>
        </section>
      ) : (
        <form className="portal-token-create-form" onSubmit={onSubmit}>
          <FormField
            description={t("my.tokenNameHint")}
            htmlFor="portal-new-token-name"
            label={t("my.tokenName")}
            required
          >
            <TextInput
              aria-invalid={draft.name.length > 0 && !tokenNameValid}
              autoFocus
              id="portal-new-token-name"
              maxLength={GATEWAY_TOKEN_NAME_MAX_LENGTH}
              minLength={2}
              onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
              pattern={GATEWAY_TOKEN_NAME_INPUT_PATTERN}
              placeholder={t("my.defaultTokenName")}
              required
              value={draft.name}
            />
          </FormField>
          <PortalTokenListboxField<TokenUsagePurpose>
            ariaLabel={t("portal.token.usagePurpose")}
            description={t("portal.token.usagePurposeHint")}
            label={t("portal.token.usagePurpose")}
            onChange={(usagePurpose) => onDraftChange({ ...draft, usagePurpose })}
            options={usagePurposeOptions(t)}
            required
            value={draft.usagePurpose}
          />
          <FormField
            description={budgetPercentLabel(draft.monthlyBudgetPercent, monthlyBudgetUsd, { of: t("my.budgetOf"), perMonth: t("my.budgetPerMonth") })}
            htmlFor="portal-new-token-budget"
            label={t("my.budgetPercent")}
          >
            <input
              id="portal-new-token-budget"
              max="100"
              min="1"
              onChange={(event) => onDraftChange({ ...draft, monthlyBudgetPercent: event.target.value })}
              style={budgetRangeStyle(draft.monthlyBudgetPercent)}
              type="range"
              value={draft.monthlyBudgetPercent}
            />
          </FormField>
          {error && <FeedbackNotice tone="error">{error}</FeedbackNotice>}
          <footer>
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            <Button disabled={!tokenNameValid} iconBefore={<Plus size={16} />} isLoading={busy} type="submit" variant="primary">
              {t("my.createToken")}
            </Button>
          </footer>
        </form>
      )}
    </ModalShell>
  );
}

export function PortalTokenRotateModal({ busy, error, name, onClose, onConfirm }: {
  busy: boolean;
  error: string;
  name: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <ModalShell
      ariaLabel={t("portal.token.rotateTitle")}
      modalClassName="portal-token-delete-modal"
      onClose={onClose}
      overlayClassName="portal-token-modal-overlay"
    >
      <header>
        <span className="portal-token-delete-icon" aria-hidden="true"><RefreshCw size={22} /></span>
        <h2>{t("portal.token.rotateTitle")}</h2>
      </header>
      <p>{t("portal.token.rotateBody", { name })}</p>
      {error && <FeedbackNotice tone="error">{error}</FeedbackNotice>}
      <footer>
        <Button disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
        <Button disabled={busy} iconBefore={<RefreshCw size={16} />} isLoading={busy} onClick={onConfirm} variant="danger">
          {t("portal.token.rotateConfirm")}
        </Button>
      </footer>
    </ModalShell>
  );
}

export function PortalTokenDeleteModal({
  busy,
  name,
  onClose,
  onConfirm
}: {
  busy: boolean;
  name: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();

  return (
    <ModalShell
      ariaLabel={t("portal.token.deleteTitle")}
      modalClassName="portal-token-delete-modal"
      onClose={onClose}
      overlayClassName="portal-token-modal-overlay"
    >
      <header>
        <span className="portal-token-delete-icon" aria-hidden="true"><Trash2 size={22} /></span>
        <div>
          <p className="portal-kicker">{t("portal.token.destructiveKicker")}</p>
          <h2>{t("portal.token.deleteTitle")}</h2>
        </div>
      </header>
      <p>{t("portal.token.deleteBody", { name })}</p>
      <footer>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button iconBefore={<Trash2 size={16} />} isLoading={busy} onClick={onConfirm} variant="danger">
          {t("portal.token.deleteConfirm")}
        </Button>
      </footer>
    </ModalShell>
  );
}

function usagePurposeOptions(t: (key: TranslationKey) => string) {
  return [
    { label: t("portal.token.usagePurposeAgent"), value: "agent" as const },
    { label: t("portal.token.usagePurposeApp"), value: "app" as const }
  ];
}
