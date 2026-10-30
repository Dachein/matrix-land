import { AppsOwnershipSettings } from './AppsOwnership';
import { AppsAppMailSettings } from "./AppsAppMailSettings";
import { Bot, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { isAppsAppMcpRequiredType, isAppsAppMcpSupportedType } from "../../../shared/appsResourceCatalog";
import type { AppsApp, AppsAppSecret, PortalCatalog } from "../../../shared/types";
import { Button } from "../../components/Button";
import { useI18n } from "../../i18n";
import { appsAccessUpdateErrorMessage } from "../accessErrorMessages";
import { appsAccessTemplates } from "../constants";
import type { AppsAccessMode, AppsAppAccessInput, AppsAppConfigInput, AppsSecretInput } from "../types";
import { privateAccessTargets } from "../utils";
import { AppsAccessScopeEditor } from "./AppsAccessScopeEditor";
import { AppsCapabilityCard } from "./AppsCapabilityCard";
import { AppsAppSecretsPanel } from "./AppsAppSecretsPanel";
import { AppsCollaboratorSettings } from "./AppsCollaboratorSettings";

const DEFAULT_EMAIL_ROUTING_DOMAIN = "mail.example.invalid";
type CapabilityKey = "appMcp" | "emailRouting" | "emailSending" | "llm";

export function AppsAppConfigTab({
  app,
  catalog,
  onAccessUpdate,
  onCollaboratorsUpdate,
  onConfigUpdate,
  onSecretConfigure,
  onSecretDelete,
  onTargetedModeChange
}: {
  app: AppsApp;
  catalog: PortalCatalog;
  onAccessUpdate: (input: AppsAppAccessInput) => Promise<AppsApp | undefined>;
  onCollaboratorsUpdate: (collaboratorUserIds: string[]) => Promise<AppsApp | undefined>;
  onConfigUpdate: (input: AppsAppConfigInput) => Promise<AppsApp | undefined>;
  onSecretConfigure: (input: AppsSecretInput) => Promise<void>;
  onSecretDelete: (secret: AppsAppSecret) => Promise<void>;
  onTargetedModeChange?: (active: boolean) => void;
}) {
  const { t } = useI18n();
  const [capabilitySaving, setCapabilitySaving] = useState<CapabilityKey | undefined>();
  const [capabilityErrors, setCapabilityErrors] = useState<Partial<Record<CapabilityKey, string>>>({});
  const [accessDraft, setAccessDraft] = useState<AppsAppAccessInput>(() => accessInputFromApp(app, catalog));
  const [accessSaving, setAccessSaving] = useState(false);
  const [accessError, setAccessError] = useState("");
  const appMcpSupported = isAppsAppMcpSupportedType(app.type);
  const appMcpRequired = isAppsAppMcpRequiredType(app.type);

  useEffect(() => {
    setAccessDraft(accessInputFromApp(app, catalog));
  }, [app.id, app.visibility, app.loginRequired, app.accessTargets, catalog]);

  async function toggleLlm() {
    clearCapabilityError("llm");
    setCapabilitySaving("llm");
    try {
      const nextEnabled = !app.llmEnabled;
      await onConfigUpdate({ llmEnabled: nextEnabled });
    } catch {
      setCapabilityError("llm");
    } finally {
      setCapabilitySaving(undefined);
    }
  }

  async function toggleAppMcp() {
    if (appMcpRequired) return;
    clearCapabilityError("appMcp");
    setCapabilitySaving("appMcp");
    try {
      await onConfigUpdate({ agentMcpEnabled: !app.agentMcpEnabled });
    } catch {
      setCapabilityError("appMcp");
    } finally {
      setCapabilitySaving(undefined);
    }
  }

  function updateAccessMode(accessMode: AppsAccessMode) {
    setAccessError("");
    setAccessDraft((current) => {
      const template = accessTemplateForMode(accessMode);
      return {
        accessMode,
        accessTargets: accessMode === "private"
          ? privateAccessTargets(catalog)
          : accessMode === "targeted" && current.accessMode !== "private"
            ? current.accessTargets
            : [],
        loginRequired: true,
        visibility: template.visibility
      };
    });
  }

  function updateLoginRequired(loginRequired: boolean) {
    setAccessError("");
    setAccessDraft((current) => {
      const accessMode = loginRequired
        ? current.accessMode === "public" ? "private" : current.accessMode
        : "public";
      const template = accessTemplateForMode(accessMode);
      return {
        ...current,
        accessMode,
        accessTargets: loginRequired && accessMode === "private" ? privateAccessTargets(catalog) : [],
        loginRequired,
        visibility: template.visibility
      };
    });
  }

  function updateAccessTargets(accessTargets: string[]) {
    setAccessError("");
    setAccessDraft((current) => {
      return { ...current, accessTargets };
    });
  }

  async function saveAccess() {
    const loginRequired = accessDraft.loginRequired;
    const accessMode = loginRequired
      ? accessDraft.accessMode === "public" ? "private" : accessDraft.accessMode
      : "public";
    const accessTargets = accessMode === "private"
      ? privateAccessTargets(catalog)
      : accessMode === "targeted"
        ? accessDraft.accessTargets
        : [];

    if (accessMode === "targeted" && accessTargets.length === 0) {
      setAccessError(t("apps.message.accessTargetsRequired"));
      return false;
    }

    setAccessSaving(true);
    setAccessError("");
    try {
      const template = accessTemplateForMode(accessMode);
      const updated = await onAccessUpdate({
        ...accessDraft,
        accessMode,
        accessTargets,
        loginRequired,
        visibility: template.visibility
      });
      if (updated) {
        setAccessDraft(accessInputFromApp(updated, catalog));
      }
      return Boolean(updated);
    } catch (error) {
      setAccessError(appsAccessUpdateErrorMessage(error, t));
      return false;
    } finally {
      setAccessSaving(false);
    }
  }

  function clearCapabilityError(capability: CapabilityKey) {
    setCapabilityErrors((current) => ({ ...current, [capability]: undefined }));
  }

  function setCapabilityError(capability: CapabilityKey) {
    setCapabilityErrors((current) => ({ ...current, [capability]: t("apps.config.capabilityUpdateFailed") }));
  }

  return (
    <AppsAccessScopeEditor
      access={accessDraft}
      catalog={catalog}
      entityType="app"
      error={accessError}
      loginRequiredLocked={app.status === "published"}
      onLoginRequiredChange={updateLoginRequired}
      onModeChange={updateAccessMode}
      onSave={saveAccess}
      onTargetedModeChange={onTargetedModeChange}
      onTargetsChange={updateAccessTargets}
      saving={accessSaving}
    >
      <AppsOwnershipSettings catalog={catalog} asset={{ id: app.id, type: "app", name: app.name, ownerUserId: app.ownerUserId }} />
      <AppsCollaboratorSettings
        catalog={catalog}
        collaboratorUserIds={app.collaboratorUserIds ?? []}
        entityId={app.id}
        entityType="app"
        onSave={async (collaboratorUserIds) => Boolean(await onCollaboratorsUpdate(collaboratorUserIds))}
        ownerUserId={app.ownerUserId}
      />
      {(
        <>
          {appMcpSupported && (
            <AppsCapabilityCard
              action={appMcpRequired ? undefined : (
                <Button
                  disabled={capabilitySaving === "appMcp"}
                  isLoading={capabilitySaving === "appMcp"}
                  onClick={() => void toggleAppMcp()}
                  size="compact"
                  variant={app.agentMcpEnabled ? "secondary" : "primary"}
                >
                  {app.agentMcpEnabled ? t("apps.config.disableCapability") : t("apps.config.enableCapability")}
                </Button>
              )}
              className="appsAppMcpStatusSection"
              description={appMcpRequired ? t("apps.config.appMcpRequiredBody") : t("apps.config.appMcpBody")}
              icon={<Bot size={17} />}
              statusLabel={app.agentMcpEnabled ? t("apps.config.enabled") : t("apps.config.disabled")}
              statusTone={app.agentMcpEnabled ? "enabled" : "neutral"}
              title={t("apps.config.appMcpTitle")}
            >
              {(app.agentMcpEnabled || capabilityErrors.appMcp) && (
                <>
                  {app.agentMcpEnabled && (
                    <div className="assetDetailGrid appsCapabilityDetails">
                      <div className="assetDetailItem">
                        <span>{t("apps.config.appMcpConfiguration")}</span>
                        <strong>{t("apps.config.enabled")}</strong>
                      </div>
                      <div className="assetDetailItem">
                        <span>{t("apps.config.appMcpRegistration")}</span>
                        <strong>{app.manifest.mcp.registered ? t("apps.config.appMcpRegistered") : t("apps.config.appMcpPendingDeployment")}</strong>
                      </div>
                    </div>
                  )}
                  {capabilityErrors.appMcp && <div className="formMessage error">{capabilityErrors.appMcp}</div>}
                </>
              )}
            </AppsCapabilityCard>
          )}
          <AppsCapabilityCard
            action={(
              <Button
                disabled={capabilitySaving === "llm"}
                isLoading={capabilitySaving === "llm"}
                onClick={() => void toggleLlm()}
                size="compact"
                variant={app.llmEnabled ? "secondary" : "primary"}
              >
                {app.llmEnabled ? t("apps.config.disableCapability") : t("apps.config.enableCapability")}
              </Button>
            )}
            className="appsLlmStatusSection"
            description={t("apps.config.llmBody")}
            icon={<Sparkles size={17} />}
            statusLabel={app.llmEnabled ? t("apps.config.enabled") : t("apps.config.disabled")}
            statusTone={app.llmEnabled ? "enabled" : "neutral"}
            title={t("apps.config.llmTitle")}
          >
            {(app.llmEnabled || capabilityErrors.llm) && (
              <>
                {app.llmEnabled && (
                  <div className="assetDetailGrid appsCapabilityDetails">
                    <div className="assetDetailItem">
                      <span>{t("apps.config.modelChoice")}</span>
                      <strong>{t("apps.config.devChoice")}</strong>
                    </div>
                    <div className="assetDetailItem">
                      <span>{t("apps.config.gateway")}</span>
                      <strong>{app.manifest.llm?.gatewayUrl || "-"}</strong>
                    </div>
                    <div className="assetDetailItem wide">
                      <span>{t("apps.config.secretName")}</span>
                      <strong>{app.manifest.llm?.secretName || "WORKSPACE_LLM_APP_KEY"}</strong>
                    </div>
                  </div>
                )}
                {capabilityErrors.llm && <div className="formMessage error">{capabilityErrors.llm}</div>}
              </>
            )}
          </AppsCapabilityCard>

        </>
      )}
      <AppsAppMailSettings app={app} onConfigUpdate={onConfigUpdate} />
      <AppsAppSecretsPanel app={app} onConfigure={onSecretConfigure} onDelete={onSecretDelete} />
    </AppsAccessScopeEditor>
  );
}

function accessInputFromApp(app: AppsApp, catalog: PortalCatalog): AppsAppAccessInput {
  const loginRequired = app.loginRequired;
  const inferredAccessMode = accessModeFromApp(app);
  const accessMode = loginRequired
    ? inferredAccessMode === "public" ? "private" : inferredAccessMode
    : "public";
  const template = accessTemplateForMode(accessMode);
  return {
    accessMode,
    accessTargets: accessMode === "private" && app.accessTargets.length === 0 ? privateAccessTargets(catalog) : app.accessTargets,
    loginRequired,
    visibility: template.visibility
  };
}

function defaultEmailSenderPrefix(appCode: string) {
  return normalizeEmailSenderDraft(appCode) || "app";
}

function normalizeEmailSenderDraft(value: string) {
  const trimmed = value.trim().toLowerCase();
  const withoutDomain = trimmed.endsWith(`@${DEFAULT_EMAIL_ROUTING_DOMAIN}`)
    ? trimmed.slice(0, -(`@${DEFAULT_EMAIL_ROUTING_DOMAIN}`).length)
    : trimmed;
  return withoutDomain.slice(0, 64);
}

function normalizeEmailSenderPrefix(value: string) {
  const prefix = normalizeEmailSenderDraft(value);
  return /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(prefix) && !prefix.includes("..") ? prefix : "";
}

function accessModeFromApp(app: AppsApp): AppsAccessMode {
  if (app.visibility === "public") {
    return "public";
  }
  if (app.visibility === "team") {
    return "targeted";
  }
  if (app.visibility === "private") {
    return "private";
  }
  return "company";
}

function accessTemplateForMode(accessMode: AppsAccessMode) {
  return appsAccessTemplates.find((item) => item.value === accessMode) ?? appsAccessTemplates[0];
}
