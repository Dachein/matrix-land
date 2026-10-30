import type { Controller } from "./knowledgePresentation";
import { useI18n } from "../../../../../src/portal/i18n";
import {
  knowledgeViewerUrl,
  knowledgeAgentHandoffText,
  canCreateKnowledgePublicShare,
  canDirectlyEditKnowledgeItem,
  downloadKnowledgeItem
} from "../../../../../src/portal/knowledge/utils";
import { ModalShell } from "../../../../../src/portal/components/ModalShell";
import { PortalKnowledgeItemIcon } from "./knowledgePresentation";
import { CopyForAgentButton } from "../../../../../src/portal/components/WorkspaceAgentHandoff";
import { knowledgeDisplayPath, ContextAction } from "./knowledgePresentation";
import { Button } from "../../../../../src/portal/components/Button";
import {
  Share2,
  X,
  MoreHorizontal,
  Pencil,
  ExternalLink,
  Download,
  Minimize2,
  Maximize2
} from "lucide-react";
import type { KnowledgeItem } from "../../../../../src/portal/knowledge/types";
import { useState, useRef, useEffect } from "react";

export function PortalKnowledgeViewer({ controller }: { controller: Controller }) {
  const { locale, t } = useI18n();
  const item = controller.viewerItem;
  if (!item) return null;
  const isMyFolder = controller.section === "my";
  const viewerUrl = knowledgeViewerUrl(item, { embedded: true });

  return (
    <ModalShell
      ariaLabel={t("knowledge.viewerAria", { name: item.name })}
      header={(
        <div className="portal-knowledge-viewer-title">
          <PortalKnowledgeItemIcon item={item} size={20} />
          <strong>{item.name}</strong>
          {isMyFolder && (
            <CopyForAgentButton
              actionLabel={t("knowledge.copyForAgent")}
              handoffText={knowledgeAgentHandoffText(
                item,
                knowledgeDisplayPath(controller.section, controller.breadcrumbs.map((crumb) => crumb.label), item, t),
                locale
              )}
              variant="compact"
            />
          )}
        </div>
      )}
      headerActions={(
        <div className="portal-knowledge-viewer-actions">
          {canCreateKnowledgePublicShare(item) && <Button aria-label={t("knowledge.share")} iconBefore={<Share2 size={15} />} onClick={() => controller.shareKnowledgeItem(item)} size="compact" variant="secondary"><span className="portal-knowledge-viewer-action-label">{t("knowledge.share")}</span></Button>}
          <PortalKnowledgeViewerMoreMenu controller={controller} item={item} />
          <Button aria-label={t("common.close")} iconBefore={<X size={16} />} onClick={() => controller.setViewerItem(undefined)} variant="icon" />
        </div>
      )}
      headerClassName="portal-knowledge-viewer-header"
      modalClassName={`portal-knowledge-viewer ${controller.viewerFullscreen ? "fullscreen" : ""}`}
      onClose={() => controller.setViewerItem(undefined)}
      overlayClassName="portal-knowledge-viewer-layer"
    >
      <iframe key={`${item.id}:${item.currentVersionId}`} className="portal-knowledge-viewer-frame" src={viewerUrl} title={t("knowledge.viewerAria", { name: item.name })} />
    </ModalShell>
  );
}

function PortalKnowledgeViewerMoreMenu({ controller, item }: { controller: Controller; item: KnowledgeItem }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="portal-knowledge-viewer-more" ref={menuRef}>
      <Button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("knowledge.more")}
        iconBefore={<MoreHorizontal size={16} />}
        onClick={() => setOpen((current) => !current)}
        variant="icon"
      />
      {open && (
        <div aria-label={t("knowledge.viewerMoreAria")} className="portal-knowledge-viewer-menu" role="menu">
          {canDirectlyEditKnowledgeItem(item) && (
            <ContextAction
              icon={<Pencil size={15} />}
              label={t("knowledge.edit")}
              onClick={() => {
                setOpen(false);
                void controller.openEditDialog(item);
              }}
            />
          )}
          <ContextAction
            icon={<ExternalLink size={15} />}
            label={t("knowledge.openNewTab")}
            onClick={() => {
              setOpen(false);
              window.open(knowledgeViewerUrl(item, { embedded: false }), "_blank", "noopener,noreferrer");
            }}
          />
          <ContextAction
            icon={<Download size={15} />}
            label={t("knowledge.download")}
            onClick={() => {
              setOpen(false);
              downloadKnowledgeItem(item);
            }}
          />
          <ContextAction
            icon={controller.viewerFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            label={controller.viewerFullscreen ? t("knowledge.exitFullscreen") : t("knowledge.fullscreen")}
            onClick={() => {
              setOpen(false);
              controller.setViewerFullscreen(!controller.viewerFullscreen);
            }}
          />
        </div>
      )}
    </div>
  );
}
