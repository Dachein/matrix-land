import type { PortalCatalog } from "../../../../../src/shared/types";
import type { Controller } from "./knowledgePresentation";
import type { KnowledgeItem } from "../../../../../src/portal/knowledge/types";
import { useI18n } from "../../../../../src/portal/i18n";
import { communityLevelLabel } from "../../../../../src/portal/forum/profileModels";
import {
  ProfileAvatarButton,
  ProfileHoverNameButton
} from "../../../../../src/portal/forum/components/ForumProfile";
import {
  knowledgeParticipantProfile,
  PortalKnowledgeItemIcon,
  knowledgeOwnerProfile
} from "./knowledgePresentation";
import { Button } from "../../../../../src/portal/components/Button";
import {
  X,
  Info,
  FolderOpen,
  FileText,
  Pencil,
  Download,
  Upload,
  History,
  Share2,
  Users,
  ArrowRightLeft,
  BookOpen,
  Power,
  Trash2
} from "lucide-react";
import {
  kindLabel,
  formatDate,
  formatBytes,
  knowledgeAccessScopeLabel,
  shareModeLabel,
  knowledgeAgentAccessLabel,
  knowledgeIndexStatusLabel,
  canDirectlyEditKnowledgeItem,
  downloadKnowledgeItem,
  canEditKnowledgeItem,
  canCreateKnowledgePublicShare,
  canRenameKnowledgeItem,
  canManageKnowledgeAccess,
  canManageKnowledgeService,
  canUpdateKnowledgeServiceInfo,
  canDeleteKnowledgeItem
} from "../../../../../src/portal/knowledge/utils";

export function PortalKnowledgeMaintainers({ catalog, controller, item }: { catalog: PortalCatalog; controller: Controller; item: KnowledgeItem }) {
  const { locale, t } = useI18n();
  if (item.maintenanceTeam) {
    return <span className="portal-knowledge-maintenance-team" title={item.maintenanceTeam}>{item.maintenanceTeam}</span>;
  }

  const userIds = [...new Set([item.ownerUserId, ...item.collaboratorUserIds].filter(Boolean))];
  const profileHoverContext = {
    currentUserEmail: catalog.currentUser.email.toLowerCase(),
    currentUserId: catalog.currentUser.id,
    currentUserLevelLabel: communityLevelLabel(catalog.journey.level.key, locale)
  };
  return (
    <span aria-label={t("knowledge.maintenancePeopleAria", { name: item.name })} className="portal-knowledge-maintainer-avatars">
      {userIds.map((userId) => (
        <ProfileAvatarButton
          key={userId}
          profileHoverContext={profileHoverContext}
          user={knowledgeParticipantProfile(item, userId, controller.ownerProfiles.get(userId), t("common.notAvailable"))}
        />
      ))}
    </span>
  );
}

export function PortalKnowledgeDetails({ catalog, controller, onClose }: { catalog: PortalCatalog; controller: Controller; onClose: () => void }) {
  const { locale, t } = useI18n();
  const item = controller.selectedItem;
  const profileHoverContext = {
    currentUserEmail: catalog.currentUser.email.toLowerCase(),
    currentUserId: catalog.currentUser.id,
    currentUserLevelLabel: communityLevelLabel(catalog.journey.level.key, locale)
  };

  return (
    <aside
      aria-label={t("knowledge.detailsAria")}
      className="portal-knowledge-details"
      id="portal-knowledge-details"
    >
      <header>
        <div>
          <p className="portal-panel-kicker">{t("knowledge.detailsAria")}</p>
          <strong>{item?.name ?? t("knowledge.noSelection")}</strong>
        </div>
        <Button aria-label={t("knowledge.hideDetails")} iconBefore={<X size={16} />} onClick={onClose} variant="icon" />
      </header>
      {!item ? (
        <div className="portal-knowledge-details-empty">
          <Info size={22} />
          <p>{t("knowledge.noSelectionHint")}</p>
        </div>
      ) : (
        <>
          <div className="portal-knowledge-details-mark"><PortalKnowledgeItemIcon item={item} size={28} /></div>
          <dl>
            <div><dt>{t("knowledge.type")}</dt><dd>{kindLabel(item.kind, t)}</dd></div>
            <div>
              <dt>{t("knowledge.owner")}</dt>
              <dd>
                <ProfileHoverNameButton
                  className="portal-knowledge-owner-name"
                  profileHoverContext={profileHoverContext}
                  user={knowledgeOwnerProfile(item, controller.ownerProfiles.get(item.ownerUserId), t("common.notAvailable"))}
                />
              </dd>
            </div>
            <div><dt>{t("knowledge.modified")}</dt><dd>{formatDate(item.modifiedAt, locale)}</dd></div>
            <div><dt>{t("knowledge.size")}</dt><dd>{item.kind === "folder" ? "-" : formatBytes(item.sizeBytes, locale)}</dd></div>
            <div><dt>{t("knowledge.version")}</dt><dd>{item.version || "-"}</dd></div>
            <div><dt>{t("knowledge.access")}</dt><dd>{knowledgeAccessScopeLabel(item, t)}</dd></div>
            {item.kind !== "folder" && <div><dt>{t("knowledge.share")}</dt><dd>{shareModeLabel(item.shareMode, t)}</dd></div>}
            {item.kind === "folder" && <div><dt>{t("knowledge.agentAccess")}</dt><dd>{knowledgeAgentAccessLabel(item, t)}</dd></div>}
            {item.kind === "folder" && item.agentEnabled && <div><dt>{t("knowledge.handbook")}</dt><dd>{t("knowledge.handbookFileName")}</dd></div>}
            {item.kind === "folder" && item.agentEnabled && <div><dt>{t("knowledge.indexStatus")}</dt><dd>{knowledgeIndexStatusLabel(item.indexStatus, t)}</dd></div>}
          </dl>
          <p className="portal-knowledge-description">{item.description || t("knowledge.noDescription")}</p>
          <div className="portal-knowledge-details-actions">
            {item.id !== controller.currentFolderId && (
              <Button iconBefore={item.kind === "folder" ? <FolderOpen size={15} /> : <FileText size={15} />} onClick={() => controller.openItemFromPrimaryAction(item)} variant="primary">
                {t("knowledge.open")}
              </Button>
            )}
            {canDirectlyEditKnowledgeItem(item) && <Button iconBefore={<Pencil size={15} />} onClick={() => void controller.openEditDialog(item)} variant="secondary">{t("knowledge.edit")}</Button>}
            {item.kind !== "folder" && <Button iconBefore={<Download size={15} />} onClick={() => downloadKnowledgeItem(item)} variant="secondary">{t("knowledge.download")}</Button>}
            {item.kind !== "folder" && canEditKnowledgeItem(item) && <Button iconBefore={<Upload size={15} />} onClick={() => controller.requestVersionUpload(item)} variant="secondary">{t("knowledge.uploadVersion")}</Button>}
            {item.capabilities.canReadChangeAudit && <Button iconBefore={<History size={15} />} onClick={() => controller.openChangeHistory(item)} variant="secondary">{t("knowledge.history")}</Button>}
            {canCreateKnowledgePublicShare(item) && <Button iconBefore={<Share2 size={15} />} onClick={() => controller.shareKnowledgeItem(item)} variant="secondary">{t("knowledge.publicShareTitle")}</Button>}
            {canRenameKnowledgeItem(item) && <Button iconBefore={<Pencil size={15} />} onClick={() => controller.openRenameDialog(item)} variant="secondary">{t("knowledge.rename")}</Button>}
            {canManageKnowledgeAccess(item) && <Button iconBefore={<Users size={15} />} onClick={() => controller.openAccessSettings(item)} variant="secondary">{t("knowledge.setCollaborators")}</Button>}
            {item.kind === "folder" && !item.parentPath && item.capabilities.canTransferOwnership && <Button iconBefore={<ArrowRightLeft size={15} />} onClick={() => controller.openOwnerTransfer(item)} variant="secondary">{t("knowledge.ownerTransfer")}</Button>}
            {(canManageKnowledgeService(item) || canUpdateKnowledgeServiceInfo(item)) && <Button iconBefore={<BookOpen size={15} />} onClick={() => controller.openKnowledgeServiceSettings(item)} variant="secondary">{item.agentEnabled ? t("knowledge.updateService") : t("knowledge.enableService")}</Button>}
            {canManageKnowledgeService(item) && item.agentEnabled && <Button iconBefore={<Power size={15} />} onClick={() => controller.openDisableKnowledgeService(item)} variant="danger">{t("knowledge.disableService")}</Button>}
            {canDeleteKnowledgeItem(item) && <Button iconBefore={<Trash2 size={15} />} onClick={() => controller.openDeleteDialog(item)} variant="danger">{t("knowledge.delete")}</Button>}
          </div>
        </>
      )}
    </aside>
  );
}
