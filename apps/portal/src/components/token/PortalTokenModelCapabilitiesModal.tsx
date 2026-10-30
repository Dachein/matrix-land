import { Check, CircleHelp, X } from "lucide-react";
import type { WorkspaceCapabilityKey, WorkspaceCapabilityStatus } from "../../../../../src/shared/workspaceModelCapabilities";
import { useI18n, type TranslationKey } from "../../../../../src/portal/i18n";
import type { GatewayModelOption } from "../../../../../src/portal/token/types";

const capabilityColumns = [
  ["image", "portal.token.capabilityImage"],
  ["search", "portal.token.capabilitySearch"],
  ["file_reading", "portal.token.capabilityFile"]
] as const;

export function ModelCapabilityTable({ models, selectedModel }: { models: GatewayModelOption[]; selectedModel?: string }) {
  const { t } = useI18n();
  return (
    <div className="portal-token-capability-table-wrap">
      <table className="portal-token-capability-table">
        <thead>
          <tr>
            <th scope="col">{t("portal.token.priceModel")}</th>
            {capabilityColumns.map(([, label]) => <th key={label} scope="col">{t(label)}</th>)}
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr className={model.id === selectedModel ? "selected" : undefined} key={model.id}>
              <th scope="row"><strong>{model.displayName || model.id}</strong><code>{model.id}</code></th>
              {capabilityColumns.map(([key]) => (
                <td key={key}>{capabilityStatus(capabilityForResponses(model, key), t)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ModelCapabilitySummary({ model }: { model?: GatewayModelOption }) {
  const { t } = useI18n();
  if (!model) return null;

  return (
    <div className="portal-token-capability-summary" aria-label={t("portal.token.capabilities") }>
      <span>{t("portal.token.capabilities")}</span>
      {capabilityColumns.map(([key, label]) => (
        <CapabilityChip key={key} label={t(label)} status={capabilityForResponses(model, key)} t={t} />
      ))}
    </div>
  );
}

function CapabilityChip({ label, status, t }: {
  label: string;
  status: WorkspaceCapabilityStatus;
  t: (key: TranslationKey) => string;
}) {
  const tone = status === "supported" ? "supported" : status === "unsupported" ? "unsupported" : "default";
  return (
    <span className={`portal-token-capability-chip is-${tone}`}>
      <span>{label}: {statusText(status, t)}</span>
    </span>
  );
}

function capabilityForResponses(model: GatewayModelOption, key: WorkspaceCapabilityKey): WorkspaceCapabilityStatus {
  const assessment = model.capabilityAssessment;
  if (!assessment || assessment.responses_api === "unknown") return "unknown";
  if (assessment.responses_api === "unsupported") return "unsupported";
  return assessment.capabilities[key];
}

function capabilityStatus(status: WorkspaceCapabilityStatus, t: (key: TranslationKey) => string) {
  const icon = status === "supported" ? <Check size={14} /> : status === "unsupported" ? <X size={14} /> : <CircleHelp size={14} />;
  const stateClass = status === "supported" ? "passed" : status === "unsupported" ? "failed" : "unknown";
  return <span className={`portal-token-capability-status is-${stateClass}`}>{icon}<span>{statusText(status, t)}</span></span>;
}

function statusText(status: WorkspaceCapabilityStatus, t: (key: TranslationKey) => string) {
  if (status === "supported") return t("portal.token.capabilitySupported");
  if (status === "unsupported") return t("portal.token.capabilityUnsupported");
  return t("portal.token.capabilityUnknown");
}
