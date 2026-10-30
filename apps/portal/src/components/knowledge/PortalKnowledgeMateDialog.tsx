import { useEffect, useRef, useState } from "react";
import {
  mountWorkspaceMateEmbed,
  type WorkspaceMateEmbedHandle
} from "../../../../../packages/mate-sdk/dist/embed.js";
import { Button } from "../../../../../src/portal/components/Button";
import { useI18n } from "../../../../../src/portal/i18n";
import { X } from "lucide-react";
import { PortalUtilityRailPanel } from "../PortalUtilityRail";

const KNOWLEDGE_ACCESS_MATE_ID = "knowledge-access";

export function PortalKnowledgeMateDialog({
  conversationCacheKey,
  knowledgeServiceId,
  knowledgeServiceName,
  onClose
}: {
  conversationCacheKey: string;
  knowledgeServiceId: string;
  knowledgeServiceName: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<WorkspaceMateEmbedHandle | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  const initialTargetRef = useRef({ id: knowledgeServiceId, name: knowledgeServiceName });
  const configuredTargetRef = useRef("");
  const environmentRevisionRef = useRef(1);
  const [state, setState] = useState<"error" | "loading" | "ready">("loading");
  onCloseRef.current = onClose;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  useEffect(() => {
    if (!mountRef.current) return undefined;
    try {
      const initialTarget = initialTargetRef.current;
      const handle = mountWorkspaceMateEmbed({
        container: mountRef.current,
        conversationCache: { key: conversationCacheKey },
        environment: knowledgeMateEnvironment(initialTarget.id, initialTarget.name, 1),
        onEvent(event) {
          if (event.type === "workspace.mate.embed.state/v1") setState(event.state);
          if (event.type === "workspace.mate.embed.error/v1") setState("error");
        },
        onClose: () => onCloseRef.current(),
        origin: window.location.origin,
        selection: {
          appIds: [],
          knowledgeServiceIds: [initialTarget.id]
        },
        mateId: KNOWLEDGE_ACCESS_MATE_ID,
        title: t("knowledge.mateDialogTitle", { name: initialTarget.name })
      });
      handleRef.current = handle;
      configuredTargetRef.current = `${initialTarget.id}\u0000${initialTarget.name}`;
      return () => {
        handle.destroy();
        if (handleRef.current === handle) handleRef.current = undefined;
      };
    } catch {
      setState("error");
      return undefined;
    }
  }, [conversationCacheKey]);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    const targetKey = `${knowledgeServiceId}\u0000${knowledgeServiceName}`;
    handle.iframe.title = t("knowledge.mateDialogTitle", { name: knowledgeServiceName });
    if (configuredTargetRef.current === targetKey) return;
    configuredTargetRef.current = targetKey;
    environmentRevisionRef.current += 1;
    handle.update({
      environment: knowledgeMateEnvironment(
        knowledgeServiceId,
        knowledgeServiceName,
        environmentRevisionRef.current
      ),
      selection: {
        appIds: [],
        knowledgeServiceIds: [knowledgeServiceId]
      }
    });
  }, [knowledgeServiceId, knowledgeServiceName, t]);

  const drawer = (
    <aside
      aria-busy={state === "loading"}
      aria-label={t("knowledge.mateDialogAria", { name: knowledgeServiceName })}
      aria-modal="false"
      className="portal-knowledge-mate-drawer"
      data-state={state}
      role="dialog"
    >
      <div className="portal-knowledge-mate-frame" data-state={state} ref={mountRef} />
      {state === "error" && (
        <div className="portal-knowledge-mate-error" role="alert">
          <span>{t("knowledge.mateDialogError")}</span>
          <Button aria-label={t("common.close")} iconBefore={<X size={15} />} onClick={onClose} variant="icon" />
        </div>
      )}
    </aside>
  );

  return (
    <PortalUtilityRailPanel dismissOnScrim={false} onClose={onClose} open variant="wide">
      {drawer}
    </PortalUtilityRailPanel>
  );
}

function knowledgeMateEnvironment(
  knowledgeServiceId: string,
  knowledgeServiceName: string,
  revision: number
) {
  return {
    schemaVersion: "workspace.mate-environment/v1" as const,
    revision,
    host: {
      appId: "workspace-knowledge",
      surface: "embedded"
    },
    location: {
      kind: "knowledge.service",
      ref: knowledgeServiceId,
      route: window.location.pathname
    },
    summary: {
      label: knowledgeServiceName,
      state: "selected"
    },
    resolutionHints: [{
      bindingId: knowledgeServiceId,
      capability: "knowledge",
      purpose: "qa"
    }]
  };
}
