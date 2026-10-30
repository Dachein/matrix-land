import type { Controller } from "./knowledgePresentation";
import { useI18n } from "../../../../../src/portal/i18n";
import {
  FolderOpen,
  FileText,
  Pencil,
  Trash2,
  Download,
  Share2,
  Users,
  ArrowRightLeft,
  BookOpen,
  Power,
  PanelRight
} from "lucide-react";
import { CopyForAgentButton } from "../../../../../src/portal/components/WorkspaceAgentHandoff";
import {
  knowledgeAgentHandoffText,
  canRenameKnowledgeItem,
  canDeleteKnowledgeItem,
  canDirectlyEditKnowledgeItem,
  downloadKnowledgeItem,
  canCreateKnowledgePublicShare,
  canManageKnowledgeAccess,
  canManageKnowledgeService,
  canUpdateKnowledgeServiceInfo
} from "../../../../../src/portal/knowledge/utils";
import { knowledgeDisplayPath, ContextAction } from "./knowledgePresentation";

export function PortalKnowledgeContextMenu({ controller }: { controller: Controller }) {
  const { locale, t } = useI18n();
  const item = controller.contextMenu?.item;
  if (!item || !controller.contextMenu) return null;
  const isMyFolder = controller.section === "my";
  const propertiesOnly = controller.contextMenu.propertiesOnly === true;

  return (
    <div
      aria-label={t("knowledge.contextMenuAria")}
      className="portal-knowledge-context-menu"
      onClick={(event) => event.stopPropagation()}
      role="menu"
      style={{ left: controller.contextMenu.x, top: controller.contextMenu.y }}
    >
      {!propertiesOnly && (
        isMyFolder ? (
          <>
            <ContextAction icon={item.kind === "folder" ? <FolderOpen size={15} /> : <FileText size={15} />} label={t("knowledge.open")} onClick={() => controller.openItemFromPrimaryAction(item)} />
            <CopyForAgentButton
              actionLabel={t("knowledge.copyForAgent")}
              handoffText={knowledgeAgentHandoffText(
                item,
                knowledgeDisplayPath(controller.section, controller.breadcrumbs.map((crumb) => crumb.label), item, t),
                locale
              )}
              onCopied={() => controller.setContextMenu(undefined)}
              role="menuitem"
              variant="compact"
            />
            {canRenameKnowledgeItem(item) && <ContextAction icon={<Pencil size={15} />} label={t("knowledge.rename")} onClick={() => controller.openRenameDialog(item)} />}
            {canDeleteKnowledgeItem(item) && <ContextAction icon={<Trash2 size={15} />} label={t("knowledge.delete")} onClick={() => controller.openDeleteDialog(item)} tone="danger" />}
          </>
        ) : (
          <>
            <ContextAction icon={item.kind === "folder" ? <FolderOpen size={15} /> : <FileText size={15} />} label={t("knowledge.open")} onClick={() => controller.openItemFromPrimaryAction(item)} />
            {canDirectlyEditKnowledgeItem(item) && <ContextAction icon={<Pencil size={15} />} label={t("knowledge.editContent")} onClick={() => void controller.openEditDialog(item)} />}
            {item.kind !== "folder" && <ContextAction icon={<Download size={15} />} label={t("knowledge.download")} onClick={() => downloadKnowledgeItem(item)} />}
            {canCreateKnowledgePublicShare(item) && <ContextAction icon={<Share2 size={15} />} label={t("knowledge.publicShareTitle")} onClick={() => controller.shareKnowledgeItem(item)} />}
            {canManageKnowledgeAccess(item) && <ContextAction icon={<Users size={15} />} label={t("knowledge.setCollaborators")} onClick={() => controller.openAccessSettings(item)} />}
            {item.kind === "folder" && !item.parentPath && item.capabilities.canTransferOwnership && <ContextAction icon={<ArrowRightLeft size={15} />} label={t("knowledge.ownerTransfer")} onClick={() => controller.openOwnerTransfer(item)} />}
            {(canManageKnowledgeService(item) || canUpdateKnowledgeServiceInfo(item)) && <ContextAction icon={<BookOpen size={15} />} label={item.agentEnabled ? t("knowledge.updateService") : t("knowledge.enableService")} onClick={() => controller.openKnowledgeServiceSettings(item)} />}
            {canManageKnowledgeService(item) && item.agentEnabled && <ContextAction icon={<Power size={15} />} label={t("knowledge.disableService")} onClick={() => controller.openDisableKnowledgeService(item)} tone="danger" />}
          </>
        )
      )}
      {isMyFolder && <ContextAction icon={<PanelRight size={15} />} label={t(item.kind === "folder" && !item.parentPath ? "knowledge.knowledgeBaseSettings" : "knowledge.more")} onClick={() => controller.openItemProperties(item)} />}
      {!propertiesOnly && !isMyFolder && canDeleteKnowledgeItem(item) && <ContextAction icon={<Trash2 size={15} />} label={t("knowledge.delete")} onClick={() => controller.openDeleteDialog(item)} tone="danger" />}
    </div>
  );
}
