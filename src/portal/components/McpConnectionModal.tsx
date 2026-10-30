import { Check, ChevronRight, Clipboard, KeyRound, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import workBuddyIcon from "../../assets/agent-brands/workbuddy-color.svg";
import claudeIcon from "../../assets/model-brands/claude-color.svg";
import cursorIcon from "../../assets/model-brands/cursor.svg";
import openAiIcon from "../../assets/model-brands/openai.svg";
import { useI18n } from "../i18n";
import { classifyMcpConnectionRevokeError, revokeMcpConnection } from "../mcp/connectionApi";
import { WORKSPACE_MCP_GUIDE_TOPIC_ID } from "../mcp/agentHandoff";
import { directMcpInstallPrompt } from "../mcp/installPrompt";
import { copyText } from "../token/clipboard";
import { Button } from "./Button";
import { WorkspaceMcpBrand } from "./WorkspaceMcpBrand";
import { McpAgentTargetPicker, type McpAgentTargetId } from "./McpAgentTargetPicker";
import { ModalShell } from "./ModalShell";
import { RelativeTime } from "./ui";

export type McpConnection = {
  agentType?: "claude-code" | "codex" | "cursor" | "workbuddy";
  clientId?: string;
  createdAt?: string;
  displayName?: string;
  id: string;
  idleExpiresAt?: string;
  lastSeenAt?: string;
  resourceUrl?: string;
  scopes?: string[];
  status?: "active" | "revoked";
  updatedAt?: string;
};

export type McpConnectionStatus = {
  activeCount: number;
  connected: boolean;
  credentialState?: "active" | "idle_expired" | "reauthorization_required";
  currentTaskAvailability?: "reload_may_be_required" | "unavailable";
  connections: McpConnection[];
  maxActiveConnections: number;
};

export type McpConnectionStatusMode = "loading" | "ready" | "error";

type McpInstallMethod = {
  agent: string;
  command: string;
  id: McpAgentTargetId;
  llmsTxt: string;
};

type McpConnectionModalProps = {
  connectionStatus: McpConnectionStatus;
  onClose: () => void;
  onRefresh: () => Promise<void> | void;
  statusMode: McpConnectionStatusMode;
};

export const defaultMcpConnectionStatus: McpConnectionStatus = {
  activeCount: 0,
  connected: false,
  credentialState: "reauthorization_required",
  currentTaskAvailability: "unavailable",
  connections: [],
  maxActiveConnections: 3
};

const fallbackMcpInstallTargets: Array<Omit<McpInstallMethod, "command">> = [
  {
    agent: "WorkBuddy",
    id: "workbuddy",
    llmsTxt: ""
  },
  {
    agent: "Claude Code",
    id: "claude-code",
    llmsTxt: ""
  },
  {
    agent: "Codex",
    id: "codex",
    llmsTxt: ""
  },
  {
    agent: "Cursor",
    id: "cursor",
    llmsTxt: ""
  }
];

export function McpConnectionModal({ connectionStatus, onClose, onRefresh, statusMode }: McpConnectionModalProps) {
  const { locale, t } = useI18n();
  const fallbackMcpInstallMethods = useMemo(() => buildFallbackMcpInstallMethods(), []);
  const [copiedAgent, setCopiedAgent] = useState("");
  const [installMethods, setInstallMethods] = useState<McpInstallMethod[]>(fallbackMcpInstallMethods);
  const [installConfigMode, setInstallConfigMode] = useState<"loading" | "ready" | "error">("loading");
  const [selectedAgentId, setSelectedAgentId] = useState<McpAgentTargetId>("workbuddy");
  const [revokingId, setRevokingId] = useState("");
  const [revokedConnectionIds, setRevokedConnectionIds] = useState<Set<string>>(() => new Set());
  const [feedback, setFeedback] = useState<{ message: string; tone: "error" | "success" }>();
  const visibleConnections = connectionStatus.connections.filter((connection) => !revokedConnectionIds.has(connection.id));
  const locallyRevokedActiveCount = connectionStatus.connections.filter((connection) => (
    connection.status !== "revoked" && revokedConnectionIds.has(connection.id)
  )).length;
  const visibleActiveCount = Math.max(0, connectionStatus.activeCount - locallyRevokedActiveCount);
  const connected = connectionStatus.connected && visibleActiveCount > 0;
  const statusUnavailable = statusMode === "error";
  const atLimit = visibleActiveCount >= connectionStatus.maxActiveConnections;
  const promptLocale = locale === "zh-CN" ? "zh" : "en";
  const selectedMethod = installMethods.find((method) => method.id === selectedAgentId) ?? installMethods[0] ?? fallbackMcpInstallMethods[0];
  const showConnectionList = visibleConnections.length > 0 || statusUnavailable || Boolean(feedback);
  useEffect(() => {
    if (!copiedAgent) {
      return;
    }

    const timer = window.setTimeout(() => setCopiedAgent(""), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedAgent]);

  useEffect(() => {
    let cancelled = false;

    setInstallConfigMode("loading");
    fetchMcpInstallConfig(fallbackMcpInstallMethods)
      .then((methods) => {
        if (cancelled) {
          return;
        }

        setInstallMethods(methods);
        setSelectedAgentId((current) => methods.some((method) => method.id === current) ? current : methods[0]?.id ?? "workbuddy");
        setInstallConfigMode("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setInstallMethods(fallbackMcpInstallMethods);
          setSelectedAgentId((current) => fallbackMcpInstallMethods.some((method) => method.id === current) ? current : fallbackMcpInstallMethods[0]?.id ?? "workbuddy");
          setInstallConfigMode("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fallbackMcpInstallMethods]);

  async function copyInstallCommand(method: McpInstallMethod) {
    await copyText(promptForMethod(method, promptLocale));
    setCopiedAgent(method.id);
  }

  async function revokeConnection(connection: McpConnection) {
    const connectionName = connection.displayName || connection.clientId || shortConnectionId(connection.id);
    if (!window.confirm(t("mcp.revokeConfirm", { name: connectionName }))) {
      return;
    }

    setRevokingId(connection.id);
    setFeedback(undefined);

    try {
      await revokeMcpConnection(connection.id);
      setRevokedConnectionIds((current) => new Set(current).add(connection.id));
      setFeedback({ message: t("mcp.revokeSucceeded", { name: connectionName }), tone: "success" });

      try {
        await onRefresh();
      } catch {
        // The revoke succeeded. Keep the optimistic result if the follow-up status refresh fails.
      }
    } catch (revokeError) {
      setFeedback({ message: t(classifyMcpConnectionRevokeError(revokeError)), tone: "error" });
    } finally {
      setRevokingId("");
    }
  }

  return (
    <ModalShell
      ariaLabel={t("mcp.modalAria")}
      className="appsMcpModal"
      header={(
        <WorkspaceMcpBrand />
      )}
      headerActions={(
        <div className="appsManifestActions">
          <Button aria-label={t("mcp.refreshAria")} className="appsModalClose" iconBefore={<RefreshCw size={18} />} onClick={() => void onRefresh()} variant="icon" />
          <Button aria-label={t("common.close")} className="appsModalClose" iconBefore={<X size={18} />} onClick={onClose} variant="icon" />
        </div>
      )}
      onClose={onClose}
    >

        <div className="appsModalBody appsMcpPanel">
          <div className={`mcpConnectionSummary${connected ? " connected" : ""}${statusUnavailable ? " unavailable" : ""}`}>
            <span className="mcpConnectionMark">
              {connected ? <Check size={18} /> : <KeyRound size={18} />}
            </span>
            <div>
              <h2>{connected ? t("mcp.summaryConnected") : statusUnavailable ? t("forum.agentHandoffStatusUnknown") : t("forum.agentHandoffNeedsMcp")}</h2>
              <p>
                {connected
                  ? t("mcp.summaryConnectedBody")
                  : statusUnavailable
                  ? t("forum.agentHandoffStatusUnknownBody")
                  : t("forum.agentHandoffNeedsMcpBody")}
              </p>
            </div>
          </div>

          {statusUnavailable && (
            <div className="mcpConnectionStatusNote">
              {visibleActiveCount > 0
                ? t("mcp.statusStaleWithCount")
                : t("mcp.statusStaleNoCount")}
            </div>
          )}

          {atLimit && (
            <div className="mcpConnectionLimit">
              {t("mcp.limitReached")}
            </div>
          )}

          {connected && (
            <div className="mcpConnectionStatusNote">
              {t("mcp.reloadRequiredNote")}
            </div>
          )}

          {!connected && connectionStatus.credentialState === "idle_expired" && (
            <div className="mcpConnectionLimit">
              {t("mcp.idleExpiredNote")}
            </div>
          )}

          <div className="mcpConnectionWorkspace">
            {showConnectionList && (
              <section className="mcpConnectionListBlock">
                <div className="mcpPanelHeader">
                  <h3>{t("mcp.currentConnections")}</h3>
                </div>
                {visibleConnections.length > 0 ? (
                  <div className="mcpConnectionList">
                    {visibleConnections.map((connection) => (
                      <article className="mcpConnectionRow" key={connection.id}>
                        <span className="mcpAgentIcon">
                          {agentIconSrc(connection.agentType)
                            ? <img alt="" src={agentIconSrc(connection.agentType)} />
                            : <span className="mcpAgentIconFallback">{agentInitial(connection.agentType)}</span>}
                        </span>
                        <div className="mcpConnectionRowMain">
                          <strong>{agentLabel(connection.agentType)} · {connection.displayName || connection.clientId || "Workspace MCP"}</strong>
                          <span>{shortConnectionId(connection.id)}</span>
                        </div>
                        <div className="mcpConnectionLastSeen">
                          <span>{t("mcp.lastSeen")}</span>
                          <RelativeTime value={connection.lastSeenAt ?? connection.updatedAt ?? connection.createdAt} fallback={t("common.notRecorded")} />
                          {connection.idleExpiresAt && <small>{t("mcp.idleDeadline")} <RelativeTime value={connection.idleExpiresAt} fallback={t("common.notRecorded")} /></small>}
                        </div>
                        <Button
                          aria-label={t("mcp.deleteConnectionAria", { agent: agentLabel(connection.agentType) })}
                          className="mcpDeleteConnectionButton"
                          disabled={Boolean(revokingId) && revokingId !== connection.id}
                          iconBefore={<Trash2 size={15} />}
                          isLoading={revokingId === connection.id}
                          onClick={() => void revokeConnection(connection)}
                          title={t("common.delete")}
                          variant="icon"
                        />
                      </article>
                    ))}
                  </div>
                ) : statusUnavailable ? (
                  <div className="mcpConnectionEmpty">
                    {t("mcp.connectionsUnavailable")}
                  </div>
                ) : null}
                {feedback && (
                  <p
                    className={`mcpConnectionFeedback ${feedback.tone}`}
                    role={feedback.tone === "error" ? "alert" : "status"}
                  >
                    {feedback.message}
                  </p>
                )}
              </section>
            )}

            <section className="agentQuickConnect" aria-labelledby="mcp-agent-picker-title">
              <div>
                <span className="agentHandoffStep">1</span>
                <div>
                  <h3 id="mcp-agent-picker-title">{t("forum.agentHandoffChooseAgent")}</h3>
                  <p>{t("forum.agentHandoffChooseAgentHint")}</p>
                </div>
              </div>
              <McpAgentTargetPicker
                ariaLabel={t("mcp.agentSelectLabel")}
                onChange={setSelectedAgentId}
                value={selectedAgentId}
              />
              {installConfigMode === "error" && (
                <p className="mcpInstallConfigHint">{t("mcp.installConfigFallback")}</p>
              )}
            </section>

            <section className="agentQuickConnect connectStep">
              <div>
                <span className="agentHandoffStep">2</span>
                <div>
                  <h3>{t("forum.agentHandoffConnectTitle", { agent: selectedMethod.agent })}</h3>
                  <p>{t("forum.agentHandoffConnectHint", { agent: selectedMethod.agent })}</p>
                </div>
              </div>
              <Button
                className="agentQuickConnectButton"
                disabled={installConfigMode !== "ready" || !selectedMethod.command}
                iconBefore={copiedAgent === selectedMethod.id ? <Check size={15} /> : <Clipboard size={15} />}
                onClick={() => void copyInstallCommand(selectedMethod)}
                size="compact"
                variant="primary"
              >
                {copiedAgent === selectedMethod.id
                  ? t("forum.agentHandoffInstallCopied")
                  : t("forum.agentHandoffConnectAction")}
              </Button>
            </section>

            <div className="agentHandoffGuideFooter mcpGuideFooter">
              <a href={`#/posts/${WORKSPACE_MCP_GUIDE_TOPIC_ID}`} onClick={onClose}>
                {t("forum.agentHandoffWhyMcp")}
                <ChevronRight aria-hidden="true" size={14} />
              </a>
            </div>
          </div>
        </div>
    </ModalShell>
  );
}

export async function fetchMcpConnectionStatus(): Promise<McpConnectionStatus> {
  const response = await fetch("/api/mcp/connections/status");

  if (!response.ok) {
    throw new Error("mcp_connection_status_unavailable");
  }

  const payload = await response.json() as { status?: Partial<McpConnectionStatus> };
  const connections = normalizeMcpConnections(payload.status?.connections);
  const activeCount = Math.max(0, Number(payload.status?.activeCount ?? connections.length));
  const maxActiveConnections = Math.max(1, Number(payload.status?.maxActiveConnections ?? 3));

  return {
    activeCount,
    connected: Boolean(payload.status?.connected) || activeCount > 0,
    connections,
    credentialState: payload.status?.credentialState === "idle_expired"
      ? "idle_expired"
      : activeCount > 0 ? "active" : "reauthorization_required",
    currentTaskAvailability: activeCount > 0 ? "reload_may_be_required" : "unavailable",
    maxActiveConnections
  };
}

function buildFallbackMcpInstallMethods(): McpInstallMethod[] {
  return fallbackMcpInstallTargets.map((target) => ({
    ...target,
    command: ""
  }));
}

async function fetchMcpInstallConfig(fallbackMethods: McpInstallMethod[]): Promise<McpInstallMethod[]> {
  const response = await fetch("/api/mcp/install/config");

  if (!response.ok) {
    throw new Error("mcp_install_config_unavailable");
  }

  const payload = await response.json() as {
    agents?: Array<{
      detail?: string;
      id?: string;
      installPrompt?: string;
      label?: string;
      llmsTxt?: string;
    }>;
  };
  const methods = (payload.agents ?? [])
    .map((agent) => {
      const id = canonicalMcpAgentTargetId(agent.id);
      const label = String(agent.label ?? "").trim();
      const installPrompt = String(agent.installPrompt ?? "").trim();
      const llmsTxt = String(agent.llmsTxt ?? "").trim() || llmsTxtFromPrompt(installPrompt);

      if (!id || !installPrompt) {
        return undefined;
      }

      return {
        agent: agentLabel(id) ?? label,
        command: installPrompt,
        id,
        llmsTxt
      };
    })
    .filter((method): method is McpInstallMethod => Boolean(method));

  if (methods.length === 0) throw new Error("mcp_install_config_unavailable");
  return fallbackMethods.map((fallbackMethod) => (
    methods.find((method) => method.id === fallbackMethod.id) ?? fallbackMethod
  ));
}

function canonicalMcpAgentTargetId(value: unknown): McpAgentTargetId | undefined {
  const id = canonicalAgentId(value);
  return id === "workbuddy" || id === "claude-code" || id === "codex" || id === "cursor" ? id : undefined;
}

function normalizeMcpConnections(value: unknown): McpConnection[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : undefined)
    .filter((connection): connection is Record<string, unknown> => Boolean(connection))
    .map((connection): McpConnection => ({
      agentType: normalizeAgentType(connection.agentType),
      clientId: readOptionalString(connection.clientId),
      createdAt: readOptionalString(connection.createdAt),
      displayName: readOptionalString(connection.displayName),
      id: readString(connection.id),
      idleExpiresAt: readOptionalString(connection.idleExpiresAt),
      lastSeenAt: readOptionalString(connection.lastSeenAt),
      resourceUrl: readOptionalString(connection.resourceUrl),
      scopes: Array.isArray(connection.scopes) ? connection.scopes.map(String) : [],
      status: connection.status === "revoked" ? "revoked" : "active",
      updatedAt: readOptionalString(connection.updatedAt)
    }))
    .filter((connection) => Boolean(connection.id));
}

function normalizeAgentType(value: unknown): McpConnection["agentType"] {
  const agent = readString(value).trim().toLowerCase().replaceAll("_", "-");
  return canonicalAgentId(agent);
}

function canonicalAgentId(value: unknown): McpConnection["agentType"] {
  const agent = readString(value).trim().toLowerCase().replaceAll("_", "-");
  if (agent === "codex") {
    return "codex";
  }
  if (agent === "claude-code") {
    return "claude-code";
  }

  return agent === "cursor" || agent === "workbuddy" ? agent : undefined;
}

function agentLabel(agent: McpConnection["agentType"] | string | undefined) {
  if (agent === "claude-code") {
    return "Claude Code";
  }

  if (agent === "workbuddy") {
    return "WorkBuddy";
  }

  if (agent === "cursor") {
    return "Cursor";
  }

  if (agent === "codex" || !agent) {
    return "Codex";
  }

  return readString(agent) || "Codex";
}

function agentIconSrc(agent: McpConnection["agentType"] | string | undefined) {
  if (agent === "claude-code") {
    return claudeIcon;
  }

  if (agent === "workbuddy") {
    return workBuddyIcon;
  }

  if (agent === "cursor") {
    return cursorIcon;
  }

  if (agent === "codex") {
    return openAiIcon;
  }

  return undefined;
}

function agentInitial(agent: McpConnection["agentType"] | string | undefined) {
  return (agentLabel(agent).at(0) ?? "A").toUpperCase();
}

function promptForMethod(method: McpInstallMethod, locale: "zh" | "en") {
  if (!method.llmsTxt) throw new Error("mcp_resource_not_configured");
  return directMcpInstallPrompt(method.id, locale, new URL(method.llmsTxt).origin);
}

function llmsTxtFromPrompt(value: string) {
  return value.match(/https?:\/\/\S+\/llms\.txt\S*/)?.[0]?.replace(/[.,;!?。]+$/, "") ?? "";
}

function shortConnectionId(value: string) {
  return value.length > 18 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}
