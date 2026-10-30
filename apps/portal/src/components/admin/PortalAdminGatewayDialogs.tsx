import { Pause, Play, Save, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "../../../../../src/portal/components/Button";
import { FormField, TextInput } from "../../../../../src/portal/components/FormField";
import { ModalShell } from "../../../../../src/portal/components/ModalShell";
import { useI18n } from "../../../../../src/portal/i18n";
import { tokenDraft, tokenFingerprint, userLimitDraft } from "../../admin/gateway/models";
import type {
  AdminGatewayAllocationResponse,
  AdminGatewayToken,
  AdminGatewayUserLimit,
  AdminTokenDraft,
  AdminUserLimitDraft
} from "../../admin/gateway/types";

export function PortalAdminTokenDialog({
  busy,
  onClose,
  onDelete,
  onSave,
  onStatusChange,
  token,
  modelOptions
}: {
  busy: boolean;
  onClose: () => void;
  onDelete: () => void;
  onSave: (draft: AdminTokenDraft) => Promise<boolean>;
  onStatusChange: (status: "active" | "suspended") => Promise<boolean>;
  modelOptions: AdminGatewayAllocationResponse["modelOptions"];
  token: AdminGatewayToken;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => tokenDraft(token));
  const suspended = token.accessStatus === "suspended";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await onSave(draft)) {
      onClose();
    }
  }

  return (
    <ModalShell
      ariaLabel={t("portal.admin.tokenDialogAria", { name: token.name })}
      header={(
        <div>
          <p className="portal-kicker">{t("portal.admin.tokenDialogKicker")}</p>
          <h2>{token.name}</h2>
          <small>{tokenFingerprint(token)} · {token.externalUserId || t("portal.admin.unassigned")}</small>
        </div>
      )}
      headerActions={<Button aria-label={t("common.close")} iconBefore={<X size={17} />} onClick={onClose} size="compact" />}
      headerClassName="portal-admin-dialog-header"
      modalClassName="portal-admin-dialog"
      onClose={onClose}
      overlayClassName="portal-admin-dialog-overlay"
    >
      <form className="portal-admin-dialog-body" onSubmit={submit}>
        <div className="portal-admin-form-grid">
          <FormField full label={t("portal.admin.tokenName")}>
            <TextInput onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} required value={draft.name} />
          </FormField>
          <FormField description={t("admin.allocations.noCapHelp")} label={t("admin.metrics.monthlyUsd")}>
            <TextInput inputMode="decimal" min="0" onChange={(event) => setDraft((current) => ({ ...current, monthlyBudgetUsd: event.target.value }))} type="number" value={draft.monthlyBudgetUsd} />
          </FormField>
          <FormField description={t("admin.allocations.noCapHelp")} label={t("admin.metrics.requestsPerMinute")}>
            <TextInput inputMode="numeric" min="0" onChange={(event) => setDraft((current) => ({ ...current, requestLimitPerMinute: event.target.value }))} type="number" value={draft.requestLimitPerMinute} />
          </FormField>
          <FormField description={t("admin.allocations.noCapHelp")} label={t("admin.metrics.tokensPerMinute")}>
            <TextInput inputMode="numeric" min="0" onChange={(event) => setDraft((current) => ({ ...current, tokensPerMinute: event.target.value }))} type="number" value={draft.tokensPerMinute} />
          </FormField>
          <fieldset className="formField full portal-admin-model-field"><legend>{t("admin.allocations.allowedModels")}</legend>
            <ModelSelection onChange={(allowedModels) => setDraft((current) => ({ ...current, allowedModels }))} options={modelOptions} value={draft.allowedModels} /><small className="formFieldDescription">{t("admin.allocations.allowedModelsHint")}</small>
          </fieldset>
        </div>

        <p className="portal-admin-help">{t("admin.allocations.suspendHelp")}</p>
        <details className="portal-admin-disclosure"><summary>{t("portal.admin.destructiveKicker")}</summary><p>{t("portal.admin.revokeBody", { name: token.name })}</p><Button disabled={busy} iconBefore={<Trash2 size={16} />} onClick={onDelete} type="button" variant="danger">{t("portal.admin.revokeToken")}</Button></details>
        <div className="portal-admin-dialog-actions">
          <div>
            <Button
              iconBefore={suspended ? <Play size={16} /> : <Pause size={16} />}
              isLoading={busy}
              onClick={async () => {
                if (await onStatusChange(suspended ? "active" : "suspended")) {
                  onClose();
                }
              }}
              type="button"
            >
              {t(suspended ? "portal.admin.activateToken" : "portal.admin.suspendToken")}
            </Button>

          </div>
          <Button disabled={busy} onClick={onClose} type="button">{t("common.cancel")}</Button>
          <Button iconBefore={<Save size={16} />} isLoading={busy} type="submit" variant="primary">
            {t("common.save")}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

export function PortalAdminUserLimitDialog({
  busy,
  limit,
  modelOptions,
  onClose,
  onSave
}: {
  busy: boolean;
  modelOptions: AdminGatewayAllocationResponse["modelOptions"];
  limit: AdminGatewayUserLimit;
  onClose: () => void;
  onSave: (draft: AdminUserLimitDraft) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => userLimitDraft(limit));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await onSave(draft)) {
      onClose();
    }
  }

  return (
    <ModalShell
      ariaLabel={t("portal.admin.userLimitDialogAria", { user: limit.userId })}
      header={(
        <div>
          <p className="portal-kicker">{t("portal.admin.allocationDialogKicker")}</p>
          <h2>{limit.userId}</h2>
        </div>
      )}
      headerActions={<Button aria-label={t("common.close")} iconBefore={<X size={17} />} onClick={onClose} size="compact" />}
      headerClassName="portal-admin-dialog-header"
      modalClassName="portal-admin-dialog"
      onClose={onClose}
      overlayClassName="portal-admin-dialog-overlay"
    >
      <form className="portal-admin-dialog-body" onSubmit={submit}>
        <div className="portal-admin-form-grid">
          <FormField label={t("admin.metrics.monthlyUsd")}>
            <TextInput inputMode="decimal" min="0.0001" onChange={(event) => setDraft((current) => ({ ...current, monthlyBudgetUsd: event.target.value }))} required step="0.0001" type="number" value={draft.monthlyBudgetUsd} />
          </FormField>
          <FormField description={t("admin.allocations.rateDefaultHelp")} label={t("admin.metrics.requestsPerMinute")}>
            <TextInput inputMode="numeric" min="0" onChange={(event) => setDraft((current) => ({ ...current, requestLimitPerMinute: event.target.value }))} type="number" value={draft.requestLimitPerMinute} />
          </FormField>
          <FormField description={t("admin.allocations.rateDefaultHelp")} label={t("admin.metrics.tokensPerMinute")}>
            <TextInput inputMode="numeric" min="0" onChange={(event) => setDraft((current) => ({ ...current, tokensPerMinute: event.target.value }))} type="number" value={draft.tokensPerMinute} />
          </FormField>
          <fieldset className="formField full portal-admin-model-field"><legend>{t("admin.allocations.allowedModels")}</legend>
            <ModelSelection onChange={(allowedModels) => setDraft((current) => ({ ...current, allowedModels }))} options={modelOptions} value={draft.allowedModels} /><small className="formFieldDescription">{t("admin.allocations.allowedModelsHint")}</small>
          </fieldset>
        </div>
        <div className="portal-admin-dialog-actions end">
          <Button disabled={busy} onClick={onClose} type="button">{t("common.cancel")}</Button>
          <Button iconBefore={<Save size={16} />} isLoading={busy} type="submit" variant="primary">
            {t("admin.allocations.saveCap")}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

export function PortalAdminDeleteTokenDialog({
  busy,
  onClose,
  onConfirm,
  token
}: {
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<boolean>;
  token: AdminGatewayToken;
}) {
  const { t } = useI18n();

  return (
    <ModalShell
      ariaLabel={t("portal.admin.revokeDialogAria", { name: token.name })}
      header={<div><p className="portal-kicker">{t("portal.admin.destructiveKicker")}</p><h2>{t("portal.admin.revokeTitle")}</h2></div>}
      headerActions={<Button aria-label={t("common.close")} iconBefore={<X size={17} />} onClick={onClose} size="compact" />}
      headerClassName="portal-admin-dialog-header"
      modalClassName="portal-admin-dialog compact"
      onClose={onClose}
      overlayClassName="portal-admin-dialog-overlay"
    >
      <div className="portal-admin-dialog-body">
        <p>{t("portal.admin.revokeBody", { name: token.name })}</p>
        <div className="portal-admin-dialog-actions end">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            iconBefore={<Trash2 size={16} />}
            isLoading={busy}
            onClick={async () => {
              if (await onConfirm()) {
                onClose();
              }
            }}
            variant="danger"
          >
            {t("portal.admin.revokeToken")}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

function ModelSelection({ onChange, options, value }: { onChange: (value: string) => void; options: AdminGatewayAllocationResponse["modelOptions"]; value: string }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const selected = [...new Set(value.split(/[\s,;]+/).filter(Boolean))];
  const legacy = selected.filter((id) => !options.some((model) => model.id === id));
  const choices = [...options, ...legacy.map((id) => ({ id, displayName: `${id} (${t("admin.allocations.legacyModel")})` }))];
  const filtered = choices.filter((model) => `${model.displayName} ${model.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="portal-admin-model-picker"><TextInput aria-label={t("admin.allocations.searchModels")} onChange={(event) => setQuery(event.target.value)} placeholder={t("admin.allocations.searchModels")} value={query} /><div className="portal-admin-model-picker-summary"><span>{selected.length ? t("admin.allocations.selectedModels", { count: selected.length }) : t("portal.admin.defaultModels")}</span><Button disabled={!selected.length} onClick={() => onChange("")} size="compact" type="button">{t("admin.allocations.useDefault")}</Button></div><div className="portal-admin-model-options">{filtered.map((model) => <label key={model.id}><input checked={selected.includes(model.id)} onChange={(event) => onChange((event.target.checked ? [...selected, model.id] : selected.filter((id) => id !== model.id)).join("\n"))} type="checkbox" /><span><strong>{model.displayName}</strong><small>{model.id}</small></span></label>)}{!filtered.length && <p>{t("common.noResults")}</p>}</div></div>;
}
