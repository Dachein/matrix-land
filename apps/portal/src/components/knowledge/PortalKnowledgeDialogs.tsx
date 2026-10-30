import { FeedbackNotice } from "../../../../../src/portal/components/FeedbackNotice";
import { ArrowRightLeft, BookOpen, Check, ChevronDown, ChevronUp, Copy, FileArchive, FilePenLine, Link2Off, Power, RefreshCw, Trash2, Users, X } from "lucide-react";
import type { ReactNode } from "react";
import { AccessTargetPicker, AccessTargetSelectedTags, accessTargetPickerNodesFromUsers } from "../../../../../src/portal/components/AccessTargetPicker";
import { Button } from "../../../../../src/portal/components/Button";
import { WorkspaceListbox } from "../../../../../src/portal/components/WorkspaceListbox";
import { FormField, TextArea, TextInput } from "../../../../../src/portal/components/FormField";
import { ModalShell } from "../../../../../src/portal/components/ModalShell";
import { PeopleMentionPicker } from "../../../../../src/portal/components/PeopleMentionPicker";
import { useI18n } from "../../../../../src/portal/i18n";
import type { KnowledgePublicShareExpiry, KnowledgeWorkspaceController } from "../../../../../src/portal/knowledge/useKnowledgeWorkspace";
import { canManageKnowledgeService, formatDate, knowledgeIndexStatusLabel } from "../../../../../src/portal/knowledge/utils";

export function PortalKnowledgeDialogs({ controller }: { controller: KnowledgeWorkspaceController }) {
  const { locale, t } = useI18n();
  const serviceAccessNodes = accessTargetPickerNodesFromUsers({
    departments: controller.accessTargetDepartments,
    departmentDetail: t("knowledge.serviceAccessDepartment"),
    rootLabel: t("knowledge.serviceAccessOrganization"),
    unassignedDepartment: t("knowledge.serviceAccessUnassignedDepartment"),
    users: controller.accessTargetUsers
  });
  const serviceTargetedAccessMissing = controller.knowledgeServiceAccessMode === "targeted"
    && controller.knowledgeServiceAccessTargets.length === 0;
  const serviceHandbookUnavailable = controller.knowledgeServiceHandbookStatus !== "present"
    && (controller.knowledgeServiceTarget?.agentEnabled
      || controller.knowledgeServiceHandbookStatus !== "missing"
      || !controller.knowledgeServiceCreateHandbookTemplate);
  const canManageService = Boolean(controller.knowledgeServiceTarget && canManageKnowledgeService(controller.knowledgeServiceTarget));
  const serviceTargetedAccessBlocked = canManageService && controller.knowledgeServiceAccessMode === "targeted"
    && (serviceTargetedAccessMissing || controller.accessTargetDirectoryState !== "ready");
  const serviceAccessPickerCopy = {
    collapseNodeLabel: (label: string) => t("knowledge.serviceAccessCollapse", { label }),
    expandNodeLabel: (label: string) => t("knowledge.serviceAccessExpand", { label }),
    noResults: t("knowledge.serviceAccessNoResults"),
    loadingLabel: t("knowledge.serviceAccessDirectoryLoading"),
    unavailableLabel: t("knowledge.serviceAccessDirectoryError"),
    removeTargetLabel: (label: string) => t("knowledge.serviceAccessRemove", { label }),
    requiredLabel: t("knowledge.serviceAccessRequired"),
    searchPlaceholder: t("knowledge.serviceAccessSearch"),
    selectedCountLabel: t("knowledge.serviceAccessSelected", { count: controller.knowledgeServiceAccessTargets.length }),
    selectedObjectsLabel: t("knowledge.serviceAccessSelectedObjects"),
    title: t("knowledge.serviceAccessPickerTitle"),
    validationHint: serviceTargetedAccessMissing ? t("knowledge.serviceAccessRequired") : undefined
  };

  return (
    <>
      {controller.createFolderOpen && (
        <PortalKnowledgeDialog
          busy={controller.isBusy}
          confirmLabel={controller.createFolderMode === "knowledgeBase"
            ? t(controller.publishOnCreate ? "knowledge.continueToPublish" : "knowledge.createKnowledgeBase")
            : undefined}
          onClose={controller.closeCreateFolderDialog}
          onConfirm={() => void controller.createFolder()}
          title={controller.createFolderMode === "knowledgeBase" ? t("knowledge.newKnowledgeBase") : t("knowledge.newFolder")}
        >
          <FormField full label={t(controller.createFolderMode === "knowledgeBase" ? "knowledge.knowledgeBaseName" : "knowledge.folderName")}>
            <TextInput
              autoFocus
              onChange={(event) => controller.setFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void controller.createFolder();
              }}
              value={controller.folderName}
            />
          </FormField>
          {controller.createFolderMode === "knowledgeBase" && (
            <label className="portal-knowledge-confirm-row portal-knowledge-create-publish-row">
              <input
                checked={controller.publishOnCreate}
                onChange={(event) => controller.setPublishOnCreate(event.target.checked)}
                type="checkbox"
              />
              <span>{t("knowledge.publishOnCreate")}</span>
            </label>
          )}
        </PortalKnowledgeDialog>
      )}

      {controller.renameTarget && (
        <PortalKnowledgeDialog
          busy={controller.isBusy}
          confirmDisabled={controller.renameName.trim() === controller.renameTarget.name}
          onClose={controller.closeRenameDialog}
          onConfirm={() => void controller.renameItem()}
          title={t("knowledge.rename")}
        >
          <FormField full label={t("knowledge.name")}>
            <TextInput
              autoFocus
              onChange={(event) => controller.setRenameName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void controller.renameItem();
              }}
              value={controller.renameName}
            />
          </FormField>
        </PortalKnowledgeDialog>
      )}

      {controller.deleteTarget && (
        <ModalShell
          ariaLabel={t("knowledge.deleteTitle", { name: controller.deleteTarget.name })}
          header={(
            <div className="portal-knowledge-dialog-title">
              <Trash2 size={17} />
              <strong>{t("knowledge.deleteTitle", { name: controller.deleteTarget.name })}</strong>
            </div>
          )}
          headerActions={<Button aria-label={t("common.close")} iconBefore={<X size={16} />} onClick={controller.closeDeleteDialog} variant="icon" />}
          headerClassName="portal-knowledge-dialog-header"
          modalClassName="portal-knowledge-dialog portal-knowledge-delete-dialog"
          onClose={controller.closeDeleteDialog}
          overlayClassName="portal-knowledge-dialog-layer"
        >
          <div className="portal-knowledge-dialog-body">
            <p>{controller.deleteTarget.kind === "folder"
              ? t("knowledge.deleteFolderWarning")
              : t("knowledge.deleteFileWarning")}</p>
          </div>
          <footer className="portal-knowledge-dialog-actions">
            <Button onClick={controller.closeDeleteDialog} variant="secondary">{t("common.cancel")}</Button>
            <Button
              iconBefore={<Trash2 size={15} />}
              isLoading={controller.isBusy}
              onClick={() => void controller.deleteItem()}
              variant="danger"
            >
              {t("knowledge.deleteConfirm")}
            </Button>
          </footer>
        </ModalShell>
      )}

      {controller.disableKnowledgeServiceTarget && (
        <ModalShell
          ariaLabel={t("knowledge.disableServiceDialogTitle", { name: controller.disableKnowledgeServiceTarget.name })}
          header={(
            <div className="portal-knowledge-dialog-title">
              <Power size={17} />
              <strong>{t("knowledge.disableServiceDialogTitle", { name: controller.disableKnowledgeServiceTarget.name })}</strong>
            </div>
          )}
          headerActions={<Button aria-label={t("common.close")} iconBefore={<X size={16} />} onClick={controller.closeDisableKnowledgeService} variant="icon" />}
          headerClassName="portal-knowledge-dialog-header"
          modalClassName="portal-knowledge-dialog portal-knowledge-delete-dialog"
          onClose={controller.closeDisableKnowledgeService}
          overlayClassName="portal-knowledge-dialog-layer"
        >
          <div className="portal-knowledge-dialog-body">
            <p>{t("knowledge.disableServiceDescription")}</p>
            <label className="portal-knowledge-confirm-row">
              <input checked={controller.disableKnowledgeServiceConfirmed} onChange={(event) => controller.setDisableKnowledgeServiceConfirmed(event.target.checked)} type="checkbox" />
              <span>{t("knowledge.disableServiceConfirm")}</span>
            </label>
          </div>
          <footer className="portal-knowledge-dialog-actions">
            <Button onClick={controller.closeDisableKnowledgeService} variant="secondary">{t("common.cancel")}</Button>
            <Button disabled={!controller.disableKnowledgeServiceConfirmed} iconBefore={<Power size={15} />} isLoading={controller.isSavingKnowledgeService} onClick={() => void controller.disableKnowledgeService()} variant="danger">
              {t("knowledge.disableService")}
            </Button>
          </footer>
        </ModalShell>
      )}

      {controller.editTarget && (
        <ModalShell
          ariaLabel={t("knowledge.edit")}
          header={<div className="portal-knowledge-dialog-title"><FilePenLine size={17} /><strong>{t("knowledge.edit")}: {controller.editTarget.name}</strong></div>}
          headerActions={<Button aria-label={t("common.close")} iconBefore={<X size={16} />} onClick={controller.closeEditDialog} variant="icon" />}
          headerClassName="portal-knowledge-dialog-header"
          modalClassName="portal-knowledge-dialog portal-knowledge-edit-dialog"
          onClose={controller.closeEditDialog}
          overlayClassName="portal-knowledge-dialog-layer"
        >
          <div className="portal-knowledge-dialog-body">
            <p className="portal-knowledge-inline-note">{t("knowledge.editDescription")}</p>
            {controller.editError && <FeedbackNotice tone="error">{controller.editError}</FeedbackNotice>}
            <TextArea
              autoFocus
              className="portal-knowledge-edit-textarea"
              disabled={controller.isEditLoading}
              onChange={(event) => controller.setEditContent(event.target.value)}
              rows={24}
              value={controller.editContent}
            />
          </div>
          <footer className="portal-knowledge-dialog-actions">
            <Button onClick={controller.closeEditDialog} variant="secondary">{t("common.cancel")}</Button>
            <Button
              disabled={controller.editContent === controller.editOriginalContent}
              isLoading={controller.isEditLoading}
              onClick={() => void controller.saveEditedFile()}
              variant="primary"
            >
              {t("knowledge.save")}
            </Button>
          </footer>
        </ModalShell>
      )}

      {controller.pendingUploadFiles.length > 0 && (
        <ModalShell
          ariaLabel={t("knowledge.zipUploadTitle")}
          header={<div className="portal-knowledge-dialog-title"><FileArchive size={17} /><strong>{t("knowledge.zipUploadTitle")}</strong></div>}
          headerActions={<Button aria-label={t("common.close")} iconBefore={<X size={16} />} onClick={controller.cancelPendingUpload} variant="icon" />}
          headerClassName="portal-knowledge-dialog-header"
          modalClassName="portal-knowledge-dialog"
          onClose={controller.cancelPendingUpload}
          overlayClassName="portal-knowledge-dialog-layer"
        >
          <div className="portal-knowledge-dialog-body">
            <p>{t("knowledge.zipUploadDescription")}</p>
            <label className="portal-knowledge-choice-row">
              <input checked={controller.zipUploadMode === "extract"} name="zip-upload-mode" onChange={() => controller.setZipUploadMode("extract")} type="radio" />
              <span><strong>{t("knowledge.zipUploadExtract")}</strong><small>{t("knowledge.zipUploadExtractDescription")}</small></span>
            </label>
            <label className="portal-knowledge-choice-row">
              <input checked={controller.zipUploadMode === "store"} name="zip-upload-mode" onChange={() => controller.setZipUploadMode("store")} type="radio" />
              <span><strong>{t("knowledge.zipUploadStore")}</strong><small>{t("knowledge.zipUploadStoreDescription")}</small></span>
            </label>
          </div>
          <footer className="portal-knowledge-dialog-actions">
            <Button onClick={controller.cancelPendingUpload} variant="secondary">{t("common.cancel")}</Button>
            <Button isLoading={controller.isBusy} onClick={() => void controller.confirmPendingUpload()} variant="primary">{t("knowledge.upload")}</Button>
          </footer>
        </ModalShell>
      )}

      {controller.ownerTransferTarget && (
        <ModalShell
          ariaLabel={t("knowledge.ownerTransferTitle")}
          header={<div className="portal-knowledge-dialog-title"><ArrowRightLeft size={17} /><strong>{t("knowledge.ownerTransferTitle")}</strong></div>}
          headerActions={<Button aria-label={t("common.close")} iconBefore={<X size={16} />} onClick={controller.closeOwnerTransfer} variant="icon" />}
          headerClassName="portal-knowledge-dialog-header"
          modalClassName="portal-knowledge-dialog"
          onClose={controller.closeOwnerTransfer}
          overlayClassName="portal-knowledge-dialog-layer"
        >
          <div className="portal-knowledge-dialog-body">
            <p>{t("knowledge.ownerTransferDescription")}</p>
            <FormField full label={t("knowledge.ownerTransferTo")}>
              <PeopleMentionPicker
                ariaLabel={t("knowledge.ownerTransferTo")}
                candidates={controller.collaboratorCandidates}
                disabled={controller.isAccessLoading || controller.collaboratorDirectoryState !== "ready"}
                emptyText={t("knowledge.collaboratorNoResults")}
                onChange={(userIds) => controller.setOwnerTransferUserId(userIds[0] ?? "")}
                placeholder={t("knowledge.collaboratorSearchPlaceholder")}
                removePersonLabel={(person) => t("knowledge.ownerTransferRemoveSelection", { name: person.name })}
                selectedIds={controller.ownerTransferUserId ? [controller.ownerTransferUserId] : []}
                showSuggestionsOnEmptyQuery={false}
                singleSelect
                suggestionsLabel={t("knowledge.ownerTransferSuggestions")}
                suggestionsPlacement="below"
              />
            </FormField>
            {controller.collaboratorDirectoryState === "error" && <p className="formMessage error">{t("knowledge.collaboratorDirectoryUnavailable")}</p>}
            <label className="portal-knowledge-confirm-row">
              <input checked={controller.retainPreviousOwner} onChange={(event) => controller.setRetainPreviousOwner(event.target.checked)} type="checkbox" />
              <span>{t("knowledge.ownerTransferRetain")}</span>
            </label>
          </div>
          <footer className="portal-knowledge-dialog-actions">
            <Button onClick={controller.closeOwnerTransfer} variant="secondary">{t("common.cancel")}</Button>
            <Button disabled={!controller.ownerTransferUserId} isLoading={controller.isAccessLoading} onClick={() => void controller.initiateOwnerTransfer()} variant="primary">{t("knowledge.ownerTransfer")}</Button>
          </footer>
        </ModalShell>
      )}

      {controller.shareTarget && (
        <ModalShell
          ariaLabel={t("knowledge.publicShareTitle")}
          header={<strong>{t("knowledge.publicShareTitle")}</strong>}
          headerActions={<Button aria-label={t("common.close")} iconBefore={<X size={16} />} onClick={controller.closeShareDialog} variant="icon" />}
          headerClassName="portal-knowledge-dialog-header"
          modalClassName="portal-knowledge-dialog"
          onClose={controller.closeShareDialog}
          overlayClassName="portal-knowledge-dialog-layer"
        >
          <div className="portal-knowledge-dialog-body">
            <p>{t("knowledge.publicShareWarning", { name: controller.shareTarget.name })}</p>
            <p className="portal-knowledge-inline-note">{t("knowledge.publicShareLatestNote")}</p>
            {controller.shareUrl ? (
              <>
                <FormField full label={t("knowledge.publicShareLink")}>
                  <TextInput readOnly value={controller.shareUrl} />
                </FormField>
                <p>{controller.shareExpiresAt
                  ? t("knowledge.publicShareExpiresAt", { date: formatDate(controller.shareExpiresAt, locale) })
                  : t("knowledge.publicSharePermanentActive")}</p>
              </>
            ) : (
              <>
                <FormField full label={t("knowledge.publicShareExpiry")}>
                  <WorkspaceListbox<KnowledgePublicShareExpiry>
                    ariaLabel={t("knowledge.publicShareExpiry")}
                    onChange={controller.setShareExpiry}
                    options={[
                      { label: t("knowledge.publicShareExpiry24h"), value: "24h" },
                      { label: t("knowledge.publicShareExpiryPermanent"), value: "permanent" }
                    ]}
                    value={controller.shareExpiry}
                  />
                </FormField>
                {controller.shareExpiry === "permanent" && (
                  <label className="portal-knowledge-confirm-row">
                    <input checked={controller.sharePermanentConfirmed} onChange={(event) => controller.setSharePermanentConfirmed(event.target.checked)} type="checkbox" />
                    <span>{t("knowledge.publicSharePermanentConfirm")}</span>
                  </label>
                )}
              </>
            )}
          </div>
          <footer className="portal-knowledge-dialog-actions">
            <Button onClick={controller.closeShareDialog} variant="secondary">{t("common.cancel")}</Button>
            {controller.shareUrl ? (
              <>
                <Button iconBefore={<Link2Off size={15} />} isLoading={controller.isSharing} onClick={() => void controller.revokePublicShareLink()} variant="danger">
                  {t("knowledge.revokePublicLink")}
                </Button>
                <Button iconBefore={controller.shareCopied ? <Check size={15} /> : <Copy size={15} />} isLoading={controller.isSharing} onClick={() => void controller.copyPublicShareLink()} variant="primary">
                  {controller.shareCopied ? t("knowledge.publicLinkCopied") : t("knowledge.copyPublicLink")}
                </Button>
              </>
            ) : (
              <Button
                disabled={controller.shareExpiry === "permanent" && !controller.sharePermanentConfirmed}
                isLoading={controller.isSharing}
                onClick={() => void controller.createPublicShareLink()}
                variant="primary"
              >
                {t("knowledge.createPublicLink")}
              </Button>
            )}
          </footer>
        </ModalShell>
      )}

      {controller.accessTarget && (
        <ModalShell
          ariaLabel={t("knowledge.setCollaborators")}
          header={<div className="portal-knowledge-dialog-title"><Users size={17} /><strong>{t("knowledge.setCollaborators")}</strong></div>}
          headerActions={<Button aria-label={t("common.close")} iconBefore={<X size={16} />} onClick={controller.closeAccessSettings} variant="icon" />}
          headerClassName="portal-knowledge-dialog-header"
          modalClassName="portal-knowledge-publish-dialog"
          onClose={controller.closeAccessSettings}
          overlayClassName="portal-knowledge-dialog-layer"
        >
          <div className="portal-knowledge-publish-body">
            <p>{t("knowledge.collaboratorsDescription")}</p>
            <p className="portal-knowledge-inline-note">{t("knowledge.collaboratorRoleDescription")}</p>
            <PeopleMentionPicker
              ariaLabel={t("knowledge.collaboratorPickerAria")}
              candidates={controller.collaboratorCandidates}
              disabled={controller.isAccessLoading || controller.collaboratorDirectoryState !== "ready" || !controller.collaboratorSettingsReady}
              emptyText={t("knowledge.collaboratorNoResults")}
              onChange={controller.setCollaboratorUserIds}
              placeholder={t("knowledge.collaboratorSearchPlaceholder")}
              removePersonLabel={(person) => t("knowledge.removeCollaborator", { name: person.name })}
              selectedIds={controller.collaboratorUserIds}
              showSuggestionsOnEmptyQuery={false}
              suggestionsLabel={t("knowledge.collaboratorSuggestions")}
              suggestionsPlacement="below"
            />
            {controller.collaboratorDirectoryState === "error" && <p className="formMessage error">{t("knowledge.collaboratorDirectoryUnavailable")}</p>}
            {!controller.isAccessLoading && !controller.collaboratorSettingsReady && <p className="formMessage error">{t("knowledge.collaboratorSettingsUnavailable")}</p>}
          </div>
          <footer className="portal-knowledge-dialog-actions">
            <Button onClick={controller.closeAccessSettings} variant="secondary">{t("common.cancel")}</Button>
            <Button disabled={controller.collaboratorDirectoryState !== "ready" || !controller.collaboratorSettingsReady || !controller.collaboratorsChanged} isLoading={controller.isAccessLoading} onClick={() => void controller.saveCollaborators()} variant="primary">
              {t("knowledge.saveCollaborators")}
            </Button>
          </footer>
        </ModalShell>
      )}

      {controller.knowledgeServiceTarget && (
        <ModalShell
          ariaLabel={controller.knowledgeServiceTarget.agentEnabled ? t("knowledge.updateService") : t("knowledge.enableService")}
          header={(
            <div>
              <p className="portal-panel-kicker">{t("knowledge.knowledgeService")}</p>
              <h2>{controller.knowledgeServiceTarget.agentEnabled ? t("knowledge.updateService") : t("knowledge.enableService")}</h2>
            </div>
          )}
          headerActions={<Button aria-label={t("common.close")} iconBefore={<X size={16} />} onClick={controller.closeKnowledgeServiceSettings} variant="icon" />}
          headerClassName="portal-knowledge-publish-header"
          modalClassName={`portal-knowledge-publish-dialog portal-knowledge-service-dialog${canManageService && controller.knowledgeServiceAccessMode === "targeted" ? " with-access-picker" : ""}`}
          onClose={controller.closeKnowledgeServiceSettings}
          overlayClassName="portal-knowledge-dialog-layer"
        >
          <div className="portal-knowledge-publish-body portal-knowledge-service-workspace">
            <div className="portal-knowledge-service-form-column">
              <p>{t("knowledge.serviceDescriptionBody")}</p>
              <div className="portal-knowledge-inline-note portal-knowledge-publication-outcome" role="note">
                <strong>{t("knowledge.publishOutcomeTitle")}</strong>
                <p>{t(controller.knowledgeServiceAccessMode === "private"
                  ? "knowledge.publishOutcomePrivate"
                  : "knowledge.publishOutcomeShared")}</p>
                {controller.knowledgeServiceAccessMode !== "private" && <p>{t("knowledge.publishOutcomeReadOnly")}</p>}
                <p>{t("knowledge.serviceInheritedAccess")}</p>
              </div>
              <div className="portal-knowledge-publish-grid">
                <FormField full label={t("knowledge.serviceName")}>
                  <TextInput disabled={!canManageService} onChange={(event) => controller.setKnowledgeServiceName(event.target.value)} value={controller.knowledgeServiceName} />
                </FormField>
                <div className="portal-knowledge-service-description-field">
                  <div className="portal-knowledge-service-description-heading">
                    <span>{t("knowledge.serviceDescription")}</span>
                    <button
                      aria-expanded={controller.knowledgeServiceAdvancedOpen}
                      className="portal-knowledge-advanced-toggle"
                      onClick={() => controller.setKnowledgeServiceAdvancedOpen(!controller.knowledgeServiceAdvancedOpen)}
                      type="button"
                    >
                      {t("knowledge.serviceAdvanced")}
                      {controller.knowledgeServiceAdvancedOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                  </div>
                  <TextArea maxLength={1000} onChange={(event) => controller.setKnowledgeServiceDescription(event.target.value)} rows={3} value={controller.knowledgeServiceDescription} />
                </div>
                {controller.knowledgeServiceAdvancedOpen && (
                  <div className="portal-knowledge-service-card-fields">
                    <p>{t("knowledge.serviceAdvancedHint")}</p>
                    <FormField description={t("knowledge.serviceRoleHint")} full label={t("knowledge.serviceRole")}>
                      <TextArea maxLength={500} onChange={(event) => controller.setKnowledgeServiceRole(event.target.value)} rows={2} value={controller.knowledgeServiceRole} />
                    </FormField>
                    <FormField description={t("knowledge.serviceBestForHint")} full label={t("knowledge.serviceBestFor")}>
                      <TextArea onChange={(event) => controller.setKnowledgeServiceBestFor(event.target.value)} rows={3} value={controller.knowledgeServiceBestFor} />
                    </FormField>
                    <FormField description={t("knowledge.serviceNotForHint")} full label={t("knowledge.serviceNotFor")}>
                      <TextArea onChange={(event) => controller.setKnowledgeServiceNotFor(event.target.value)} rows={3} value={controller.knowledgeServiceNotFor} />
                    </FormField>
                    <FormField description={t("knowledge.serviceKeywordsHint")} full label={t("knowledge.serviceKeywords")}>
                      <TextInput onChange={(event) => controller.setKnowledgeServiceKeywords(event.target.value)} value={controller.knowledgeServiceKeywords} />
                    </FormField>
                    <FormField description={t("knowledge.serviceSearchHintsHint")} full label={t("knowledge.serviceSearchHints")}>
                      <TextArea onChange={(event) => controller.setKnowledgeServiceSearchHints(event.target.value)} rows={3} value={controller.knowledgeServiceSearchHints} />
                    </FormField>
                  </div>
                )}
                {canManageService && (
                  <FormField description={t("knowledge.serviceMaintenanceTeamHint")} full label={t("knowledge.serviceMaintenanceTeam")}>
                    <TextInput maxLength={120} onChange={(event) => controller.setKnowledgeServiceMaintenanceTeam(event.target.value)} value={controller.knowledgeServiceMaintenanceTeam} />
                  </FormField>
                )}
                {controller.knowledgeServiceTarget.agentEnabled
                  && !controller.isKnowledgeServiceLoading
                  && !controller.knowledgeServiceSettingsReady
                  && <p className="formMessage error">{t("knowledge.serviceSettingsUnavailable")}</p>}
                {canManageService && <fieldset
                  className="portal-knowledge-service-access"
                  disabled={controller.isKnowledgeServiceLoading || !controller.knowledgeServiceSettingsReady}
                >
                  <legend>{t("knowledge.serviceAccessTitle")}</legend>
                  <p>
                    {t("knowledge.serviceAccessDescriptionPrefix")}
                    <strong>{t("knowledge.serviceAccessDescriptionAgent")}</strong>
                    {t("knowledge.serviceAccessDescriptionSuffix")}
                  </p>
                  <div className="portal-knowledge-service-access-options">
                    <label className={controller.knowledgeServiceAccessMode === "company" ? "active" : ""}>
                      <input
                        checked={controller.knowledgeServiceAccessMode === "company"}
                        name="knowledge-service-access"
                        onChange={() => {
                          controller.setKnowledgeServiceAccessMode("company");
                          controller.setKnowledgeServiceAccessTargets([]);
                        }}
                        type="radio"
                      />
                      <span><strong>{t("knowledge.serviceAccessCompany")}</strong><small>{t("knowledge.serviceAccessCompanyDescription")}</small></span>
                    </label>
                    <label className={controller.knowledgeServiceAccessMode === "targeted" ? "active" : ""}>
                      <input checked={controller.knowledgeServiceAccessMode === "targeted"} name="knowledge-service-access" onChange={() => controller.setKnowledgeServiceAccessMode("targeted")} type="radio" />
                      <span><strong>{t("knowledge.serviceAccessTargeted")}</strong><small>{t("knowledge.serviceAccessTargetedDescription")}</small></span>
                    </label>
                    <label className={controller.knowledgeServiceAccessMode === "private" ? "active" : ""}>
                      <input
                        checked={controller.knowledgeServiceAccessMode === "private"}
                        name="knowledge-service-access"
                        onChange={() => {
                          controller.setKnowledgeServiceAccessMode("private");
                          controller.setKnowledgeServiceAccessTargets([]);
                        }}
                        type="radio"
                      />
                      <span><strong>{t("knowledge.serviceAccessPrivate")}</strong><small>{t("knowledge.serviceAccessPrivateDescription")}</small></span>
                    </label>
                  </div>
                  {controller.knowledgeServiceAccessMode === "targeted" && (
                    <div className="portal-knowledge-service-access-summary">
                      <div>
                        <strong>{t("knowledge.serviceAccessPickerTitle")}</strong>
                        <small>{controller.knowledgeServiceAccessTargets.length > 0
                          ? t("knowledge.serviceAccessSelected", { count: controller.knowledgeServiceAccessTargets.length })
                          : t("knowledge.serviceAccessRequired")}</small>
                      </div>
                      <AccessTargetSelectedTags
                        copy={serviceAccessPickerCopy}
                        emptyLabel={t("knowledge.serviceAccessRequired")}
                        nodes={serviceAccessNodes}
                        onRemove={(value) => controller.setKnowledgeServiceAccessTargets(controller.knowledgeServiceAccessTargets.filter((target) => target !== value))}
                        selectedValues={controller.knowledgeServiceAccessTargets}
                      />
                    </div>
                  )}
                </fieldset>}
                <div className="portal-knowledge-service-meta">
                  <BookOpen size={18} />
                  <div><strong>{t("knowledge.handbookFileName")}</strong><span>{t("knowledge.handbookDescription")}</span></div>
                </div>
                {controller.knowledgeServiceHandbookStatus === "checking" && (
                  <p className="formMessage">{t("knowledge.handbookChecking")}</p>
                )}
                {controller.knowledgeServiceHandbookStatus === "missing" && !controller.knowledgeServiceTarget.agentEnabled && (
                  <label className="portal-knowledge-confirm-row">
                    <input
                      checked={controller.knowledgeServiceCreateHandbookTemplate}
                      onChange={(event) => controller.setKnowledgeServiceCreateHandbookTemplate(event.target.checked)}
                      type="checkbox"
                    />
                    <span>{t("knowledge.handbookCreateTemplate")}</span>
                  </label>
                )}
                {controller.knowledgeServiceHandbookStatus === "missing" && controller.knowledgeServiceTarget.agentEnabled && (
                  <p className="formMessage error">{t("knowledge.handbookRequired")}</p>
                )}
                {controller.knowledgeServiceHandbookStatus === "error" && (
                  <div className="portal-knowledge-handbook-actions">
                    <p className="formMessage error">{t("knowledge.handbookCheckFailed")}</p>
                    <Button iconBefore={<RefreshCw size={15} />} onClick={() => void controller.recheckKnowledgeServiceHandbook()} size="compact" variant="secondary">
                      {t("common.refresh")}
                    </Button>
                  </div>
                )}
                {controller.knowledgeServiceTarget.agentEnabled && (
                  <dl className="portal-knowledge-service-status">
                    <div><dt>{t("knowledge.indexStatus")}</dt><dd>{knowledgeIndexStatusLabel(controller.knowledgeServiceResult?.service?.indexStatus ?? controller.knowledgeServiceTarget.indexStatus, t)}</dd></div>
                  </dl>
                )}
              </div>
            </div>
            {canManageService && controller.knowledgeServiceAccessMode === "targeted" && (
              <aside aria-label={t("knowledge.serviceAccessPickerTitle")} className="portal-knowledge-service-access-pane">
                <AccessTargetPicker
                  copy={serviceAccessPickerCopy}
                  nodes={serviceAccessNodes}
                  onSelectionChange={controller.setKnowledgeServiceAccessTargets}
                  selectedValues={controller.knowledgeServiceAccessTargets}
                  state={controller.accessTargetDirectoryState}
                />
              </aside>
            )}
          </div>
          <footer className="portal-knowledge-dialog-actions">
            <Button onClick={controller.closeKnowledgeServiceSettings} variant="secondary">{t("common.cancel")}</Button>
            <Button
              disabled={!controller.knowledgeServiceSettingsReady || controller.isKnowledgeServiceLoading || (canManageService && serviceHandbookUnavailable) || serviceTargetedAccessBlocked}
              isLoading={controller.isSavingKnowledgeService || controller.isKnowledgeServiceLoading}
              onClick={() => void controller.saveKnowledgeService()}
              variant="primary"
            >
              {controller.knowledgeServiceTarget.agentEnabled ? t("knowledge.saveServiceSettings") : t("knowledge.enableService")}
            </Button>
          </footer>
        </ModalShell>
      )}
    </>
  );
}

function PortalKnowledgeDialog({
  busy,
  children,
  confirmLabel,
  confirmDisabled = false,
  onClose,
  onConfirm,
  title
}: {
  busy: boolean;
  children: ReactNode;
  confirmLabel?: ReactNode;
  confirmDisabled?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
}) {
  const { t } = useI18n();

  return (
    <ModalShell
      ariaLabel={title}
      header={<strong>{title}</strong>}
      headerActions={<Button aria-label={t("common.close")} iconBefore={<X size={16} />} onClick={onClose} variant="icon" />}
      headerClassName="portal-knowledge-dialog-header"
      modalClassName="portal-knowledge-dialog"
      onClose={onClose}
      overlayClassName="portal-knowledge-dialog-layer"
    >
      <div className="portal-knowledge-dialog-body">{children}</div>
      <footer className="portal-knowledge-dialog-actions">
        <Button onClick={onClose} variant="secondary">{t("common.cancel")}</Button>
        <Button disabled={confirmDisabled} isLoading={busy} onClick={onConfirm} variant="primary">{confirmLabel ?? t("knowledge.save")}</Button>
      </footer>
    </ModalShell>
  );
}
