import { useInstallationEndpoints } from "../brand/PlatformBrandProvider";
import { Check, ChevronRight, Clipboard, Loader2, PlugZap, RotateCw, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState, type AriaRole } from "react";
import workspaceMcpSignalIcon from "../../assets/workspace-pass-mcp-signal.svg";
import { useI18n } from "../i18n";
import { directMcpInstallPrompt } from "../mcp/installPrompt";
import { WORKSPACE_MCP_GUIDE_TOPIC_ID, forumAgentHandoffText } from "../mcp/agentHandoff";
import { getCachedMcpConnectionStatus } from "../mcp/connectionStatusCache";
import { copyText } from "../token/clipboard";
import { Button } from "./Button";
import { WorkspaceMcpBrand } from "./WorkspaceMcpBrand";
import {
  McpAgentTargetPicker,
  mcpAgentTargets,
  type McpAgentTargetId
} from "./McpAgentTargetPicker";
import { ModalShell } from "./ModalShell";

export function CopyForAgentButton({
  actionLabel,
  className = "",
  handoffText: customHandoffText,
  onCopied,
  postId,
  role,
  title = "",
  topicId = "",
  variant = "default"
}: {
  actionLabel?: string;
  className?: string;
  handoffText?: string;
  onCopied?: () => void;
  postId?: string;
  role?: AriaRole;
  title?: string;
  topicId?: string;
  variant?: "compact" | "default";
}) {
  const { locale, t } = useI18n();
  const endpoints = useInstallationEndpoints();
  const [handoffState, setHandoffState] = useState<"checking" | "copied" | "error" | "idle">("idle");
  const [guideOpen, setGuideOpen] = useState(false);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<McpAgentTargetId>("workbuddy");
  const [installCopied, setInstallCopied] = useState(false);
  const selectedAgent = mcpAgentTargets.find((target) => target.id === selectedAgentId) ?? mcpAgentTargets[0];
  const handoffText = useMemo(() => customHandoffText ?? forumAgentHandoffText({
    postId,
    title,
    topicId,
    url: typeof window === "undefined" ? `#/posts/${topicId}` : window.location.href
  }, locale), [customHandoffText, locale, postId, title, topicId]);

  useEffect(() => {
    if (handoffState !== "copied" && handoffState !== "error") {
      return undefined;
    }

    const timeout = window.setTimeout(() => setHandoffState("idle"), 1800);
    return () => window.clearTimeout(timeout);
  }, [handoffState]);

  useEffect(() => {
    if (!installCopied) {
      return undefined;
    }

    const timeout = window.setTimeout(() => setInstallCopied(false), 2600);
    return () => window.clearTimeout(timeout);
  }, [installCopied]);

  async function handoff(forceRefresh = false) {
    if (handoffState === "checking") {
      return;
    }

    setHandoffState("checking");
    setStatusUnavailable(false);

    let status;
    try {
      status = await getCachedMcpConnectionStatus({ forceRefresh });
    } catch {
      setHandoffState("idle");
      setStatusUnavailable(true);
      setGuideOpen(true);
      return;
    }

    if (!status.connected || status.activeCount < 1) {
      setHandoffState("idle");
      setGuideOpen(true);
      return;
    }

    try {
      await copyText(handoffText);
      setGuideOpen(false);
      setHandoffState("copied");
      onCopied?.();
    } catch {
      setHandoffState("error");
    }
  }

  async function copyInstallPrompt() {
    const promptLocale = locale === "zh-CN" ? "zh" : "en";

    try {
      await copyText(directMcpInstallPrompt(selectedAgent.id, promptLocale, endpoints.mcpUrl ?? ""));
      setInstallCopied(true);
    } catch {
      setInstallCopied(false);
    }
  }

  const label = handoffState === "checking"
    ? t("forum.agentHandoffChecking")
    : handoffState === "copied"
      ? t("forum.agentHandoffCopied")
      : handoffState === "error"
        ? t("forum.agentHandoffCopyFailed")
        : actionLabel ?? t("forum.agentHandoffAction");

  return (
    <>
      <button
        aria-label={label}
        className={`agentHandoffButton ${variant}${handoffState === "copied" ? " copied" : ""}${className ? ` ${className}` : ""}`}
        data-state={handoffState}
        disabled={handoffState === "checking"}
        onClick={() => void handoff()}
        role={role}
        title={label}
        type="button"
      >
        {handoffState === "checking"
          ? <Loader2 aria-hidden="true" className="spinIcon" size={14} />
          : handoffState === "copied"
            ? <Check aria-hidden="true" size={14} />
            : handoffState === "error"
              ? <TriangleAlert aria-hidden="true" size={14} />
              : <img alt="" aria-hidden="true" src={workspaceMcpSignalIcon} />}
        <span>{label}</span>
      </button>

      {guideOpen && (
        <ModalShell
          ariaLabel={t("forum.agentHandoffGuideAria")}
          className="agentHandoffModal"
          header={(
            <div className="agentHandoffModalTitle">
              <WorkspaceMcpBrand />
              <p>{t("forum.agentHandoffGuideEyebrow")}</p>
            </div>
          )}
          headerActions={(
            <Button
              aria-label={t("common.close")}
              className="appsModalClose"
              iconBefore={<X size={18} />}
              onClick={() => setGuideOpen(false)}
              variant="icon"
            />
          )}
          onClose={() => setGuideOpen(false)}
        >
          <div className="agentHandoffGuide">
            <div className={statusUnavailable ? "agentHandoffStatus unavailable" : "agentHandoffStatus"}>
              <span><PlugZap aria-hidden="true" size={18} /></span>
              <div>
                <h2>{statusUnavailable ? t("forum.agentHandoffStatusUnknown") : t("forum.agentHandoffNeedsMcp")}</h2>
                <p>{statusUnavailable ? t("forum.agentHandoffStatusUnknownBody") : t("forum.agentHandoffNeedsMcpBody")}</p>
              </div>
            </div>

            <section className="agentQuickConnect" aria-labelledby="agent-quick-connect-title">
              <div>
                <span className="agentHandoffStep">1</span>
                <div>
                  <h3 id="agent-quick-connect-title">{t("forum.agentHandoffChooseAgent")}</h3>
                  <p>{t("forum.agentHandoffChooseAgentHint")}</p>
                </div>
              </div>
              <McpAgentTargetPicker
                ariaLabel={t("mcp.agentSelectLabel")}
                onChange={setSelectedAgentId}
                value={selectedAgentId}
              />
            </section>

            <section className="agentQuickConnect connectStep">
              <div>
                <span className="agentHandoffStep">2</span>
                <div>
                  <h3>{t("forum.agentHandoffConnectTitle", { agent: selectedAgent.label })}</h3>
                  <p>{t("forum.agentHandoffConnectHint", { agent: selectedAgent.label })}</p>
                </div>
              </div>
              <Button
                className="agentQuickConnectButton"
                iconBefore={installCopied ? <Check size={15} /> : <Clipboard size={15} />}
                onClick={() => void copyInstallPrompt()}
                size="compact"
                variant="primary"
              >
                {installCopied ? t("forum.agentHandoffInstallCopied") : t("forum.agentHandoffConnectAction")}
              </Button>
            </section>

            <div className="agentHandoffGuideFooter">
              <a href={`#/posts/${WORKSPACE_MCP_GUIDE_TOPIC_ID}`} onClick={() => setGuideOpen(false)}>
                {t("forum.agentHandoffWhyMcp")}
                <ChevronRight aria-hidden="true" size={14} />
              </a>
              <button onClick={() => void handoff(true)} type="button">
                <RotateCw aria-hidden="true" size={13} />
                {t("forum.agentHandoffRetry")}
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  );
}

export function AskInAgentButton({ prompt, variant = "compact" }: { prompt: string; variant?: "compact" | "default" }) {
  const { t } = useI18n();
  return (
    <CopyForAgentButton
      actionLabel={t("knowledge.askInAgent")}
      handoffText={prompt}
      variant={variant}
    />
  );
}
