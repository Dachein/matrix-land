import { Check, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import type { AppsApp, AppsAppSecret, AppsAppSecretEnvironment } from "../../../shared/types";
import { Button } from "../../components/Button";
import { useI18n } from "../../i18n";
import type { AppsSecretInput } from "../types";
import { normalizeSecretNameForUi } from "../utils";
import { AppsCapabilityCard } from "./AppsCapabilityCard";

export function AppsAppSecretsPanel({
  app,
  onConfigure,
  onDelete
}: {
  app: AppsApp;
  onConfigure: (input: AppsSecretInput) => Promise<void>;
  onDelete: (secret: AppsAppSecret) => Promise<void>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<AppsAppSecret | "new" | undefined>();
  const [draft, setDraft] = useState<AppsSecretInput>(emptySecretInput());
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [error, setError] = useState("");
  const configuredCount = app.secrets.filter((secret) => secret.status === "configured").length;
  const pendingCount = app.secrets.length - configuredCount;

  function openSecret(secret?: AppsAppSecret) {
    setError("");
    setEditing(secret ?? "new");
    setDraft(secret ? {
      description: secret.description,
      environment: secret.environment,
      name: secret.name,
      required: secret.required,
      value: ""
    } : emptySecretInput());
  }

  async function submitSecret(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = normalizeSecretNameForUi(draft.name);

    if (!name) {
      setError(t("apps.config.secretNameRequired"));
      return;
    }

    if (!draft.value.trim()) {
      setError(t("apps.config.secretValueRequired"));
      return;
    }

    setSaving(true);
    setError("");
    try {
      await onConfigure({ ...draft, name });
      setEditing(undefined);
      setDraft(emptySecretInput());
    } finally {
      setSaving(false);
    }
  }

  async function deleteSecret(secret: AppsAppSecret) {
    if (!window.confirm(t("apps.config.deleteSecretConfirm", { name: secret.name }))) {
      return;
    }

    setDeletingId(secret.id);
    setError("");
    try {
      await onDelete(secret);
      if (editing !== "new" && editing?.id === secret.id) {
        setEditing(undefined);
        setDraft(emptySecretInput());
      }
    } catch {
      setError(t("apps.message.secretDeleteFailed"));
    } finally {
      setDeletingId("");
    }
  }

  return (
    <AppsCapabilityCard
      action={editing ? (
        <Button disabled={saving} onClick={() => setEditing(undefined)} size="compact" variant="secondary">
          {t("apps.editor.cancel")}
        </Button>
      ) : (
        <Button iconBefore={<KeyRound size={15} />} onClick={() => openSecret()} size="compact" variant="primary">
          {t("apps.config.addSecret")}
        </Button>
      )}
      className="appsSecretsSection"
      description={t("apps.config.secretsBody")}
      icon={<KeyRound size={17} />}
      statusLabel={app.secrets.length > 0
        ? t("apps.config.secretsConfiguredCount", { configured: configuredCount, total: app.secrets.length })
        : t("common.notConfigured")}
      statusTone={pendingCount > 0 ? "warning" : configuredCount > 0 ? "enabled" : "neutral"}
      title={t("apps.config.secretsTitle")}
    >
      <div className="appsSecretList">
        {app.secrets.map((secret) => (
          <article className="appsSecretRow" key={secret.id}>
            <div className="appsSecretMeta">
              <div className="appsSecretTitleRow">
                <strong>{secret.name}</strong>
                <span className={`capabilityStatusText ${secret.status === "configured" ? "enabled" : "warning"}`}>
                  {secret.status === "configured" ? <Check aria-hidden="true" size={11} /> : null}
                  {secret.status === "configured" ? t("apps.config.configured") : t("apps.config.pendingConfiguration")}
                </span>
              </div>
              <span>{secret.description || t("apps.config.noDescription")}</span>
              <small>{t("apps.environment.production")}{secret.required ? ` · ${t("apps.config.requiredSecret")}` : ""}</small>
            </div>
            <div className="appsSecretRowActions">
              <Button disabled={deletingId === secret.id} onClick={() => openSecret(secret)} size="compact" variant="secondary">
                {t("apps.config.update")}
              </Button>
              <Button disabled={saving} iconBefore={<Trash2 size={15} />} isLoading={deletingId === secret.id} onClick={() => void deleteSecret(secret)} size="compact" variant="danger">
                {t("apps.config.deleteSecret")}
              </Button>
            </div>
          </article>
        ))}
        {app.secrets.length === 0 && <div className="emptyState">{t("apps.config.emptySecrets")}</div>}
      </div>

      {editing && (
        <form className="appsSecretEditor" onSubmit={(event) => void submitSecret(event)}>
          <div className="appReviewGrid">
            <label>
              {t("apps.config.secretName")}
              <input disabled={saving || editing !== "new"} onChange={(event) => setDraft((current) => ({ ...current, name: normalizeSecretNameForUi(event.target.value) }))} placeholder={t("apps.config.secretNamePlaceholder")} value={draft.name} />
            </label>
            <label>
              {t("apps.config.environment")}
              <select disabled={saving || editing !== "new"} onChange={(event) => setDraft((current) => ({ ...current, environment: event.target.value as AppsAppSecretEnvironment }))} value={draft.environment}>
                <option value="production">{t("apps.environment.production")}</option>
              </select>
            </label>
            <label className="wide">
              {t("apps.config.description")}
              <input disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder={t("apps.config.descriptionPlaceholder")} value={draft.description} />
            </label>
            <label className="wide">
              {t("apps.config.secretValue")}
              <input autoComplete="new-password" disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))} placeholder={t("apps.config.secretValuePlaceholder")} type="password" value={draft.value} />
            </label>
            <label className="appsSecretRequired">
              <input checked={draft.required} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, required: event.target.checked }))} type="checkbox" />
              {t("apps.config.requiredSecret")}
            </label>
          </div>
          {error && <div className="formMessage error">{error}</div>}
          <div className="formActions">
            <Button isLoading={saving} size="compact" type="submit" variant="primary">{saving ? t("apps.editor.saving") : t("apps.config.saveSecret")}</Button>
          </div>
        </form>
      )}
    </AppsCapabilityCard>
  );
}

function emptySecretInput(): AppsSecretInput {
  return {
    description: "",
    environment: "production",
    name: "",
    required: true,
    value: ""
  };
}
