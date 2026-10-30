import { BookOpen, Boxes, ChevronDown, Clipboard, Code2, Download, ExternalLink, EyeOff, Pencil, Rocket, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AppsProvisionedResourceType } from "../../../shared/appsResourceCatalog";
import type { AppsApp, AppsSkill, PublicationListing, PortalCatalog } from "../../../shared/types";
import { Button, ButtonLink } from "../../components/Button";
import { ModalShell } from "../../components/ModalShell";
import { useI18n } from "../../i18n";
import { AppsAppConfigTab } from "../components/AppsAppConfig";
import { AppsAppDataSecurity } from "../components/AppsAppDataSecurity";
import { AppsProductBasicTab } from "../components/AppsProductBasicTab";
import { AppsSkillConfigTab } from "../components/AppsSkillConfig";
import {
  AppsDetailSection,
  AppsHistoryPanel
} from "../components/AppsDetailPanels";
import { AppsAppPublishForm, AppsSkillPublishForm } from "../components/AppsPublishForms";
import {
  appInfoInputFromApp,
  appDevelopmentResourcesReady,
  appPublishDraftFromProduct,
  emptyAppPublishDraft,
  emptySkillPublishDraft,
  isCurrentAppsAuthor,
  appsProductProductionUrl,
  appsProductProgressSteps,
  marketListingRows,
  skillInfoInputFromSkill,
  skillPublishDraftFromProduct
} from "../productDetailModels";
import type {
  AppsAppAccessInput,
  AppsAppHandoffMode,
  AppsAppInfoInput,
  AppsAppConfigInput,
  AppsAppPublishDraft,
  AppsDetailTab,
  AppsProductItem,
  AppsSecretInput,
  AppsSkillAccessInput,
  AppsSkillInfoInput,
  AppsSkillPublishDraft
} from "../types";
import { AppsAuthorAvatarGroup } from "../components/AppsAuthorAvatarGroup";

type EditableTab = "basic" | "review";

export function AppsProductDetailModal({
  catalog,
  currentUser,
  marketSubmittingId,
  onAppDelete,
  onAppAccessUpdate,
  onAppCollaboratorsUpdate,
  onAppProduction,
  onAppConfigUpdate,
  onAppRefresh,
  onAppResources,
  onAppSecretConfigure,
  onAppSecretDelete,
  onAppUpdate,
  onClose,
  onDelist,
  onSkillDownload,
  onSkillDelete,
  onSkillInstallPrompt,
  onSkillAccessUpdate,
  onSkillCollaboratorsUpdate,
  onSkillUpdate,
  onSubmitApp,
  onSubmitSkill,
  product
}: {
  catalog: PortalCatalog;
  currentUser: PortalCatalog["currentUser"];
  marketSubmittingId: string;
  onAppDelete: (app: AppsApp, listing: AppsProductItem["marketListing"] | undefined, confirmation: string) => Promise<void>;
  onAppAccessUpdate: (app: AppsApp, input: AppsAppAccessInput) => Promise<AppsApp | undefined>;
  onAppCollaboratorsUpdate: (app: AppsApp, collaboratorUserIds: string[]) => Promise<AppsApp | undefined>;
  onAppProduction: (app: AppsApp) => void;
  onAppConfigUpdate: (app: AppsApp, input: AppsAppConfigInput) => Promise<AppsApp | undefined>;
  onAppRefresh: (app: AppsApp) => Promise<AppsApp | undefined>;
  onAppResources: (app: AppsApp, mode?: AppsAppHandoffMode) => Promise<void>;
  onAppSecretConfigure: (app: AppsApp, input: AppsSecretInput) => Promise<void>;
  onAppSecretDelete: (app: AppsApp, secret: AppsApp["secrets"][number]) => Promise<void>;
  onAppUpdate: (app: AppsApp, input: AppsAppInfoInput) => Promise<AppsApp | undefined>;
  onClose: () => void;
  onDelist: (listing: PublicationListing) => Promise<boolean>;
  onSkillDownload: (skill: AppsSkill) => void;
  onSkillDelete: (skill: AppsSkill, listing: AppsProductItem["marketListing"] | undefined, confirmation: string) => Promise<void>;
  onSkillInstallPrompt: (skill: AppsSkill) => void;
  onSkillAccessUpdate: (skill: AppsSkill, input: AppsSkillAccessInput) => Promise<AppsSkill | undefined>;
  onSkillCollaboratorsUpdate: (skill: AppsSkill, collaboratorUserIds: string[]) => Promise<AppsSkill | undefined>;
  onSkillUpdate: (skill: AppsSkill, input: AppsSkillInfoInput) => Promise<AppsSkill | undefined>;
  onSubmitApp: (app: AppsApp, draft: AppsAppPublishDraft) => Promise<boolean>;
  onSubmitSkill: (skill: AppsSkill, draft: AppsSkillPublishDraft) => Promise<boolean>;
  product: AppsProductItem;
}) {
  const { t } = useI18n();
  const listing = product.marketListing ?? product.listing;
  const app = product.app;
  const skill = product.appsSkill;
  const handoffReady = app ? appDevelopmentResourcesReady(app) : true;
  const canDeleteApp = app ? isCurrentAppsAuthor(app.ownerUserId, app.collaboratorUserIds, currentUser) : false;
  const canEditSkillInfo = !skill || isCurrentAppsAuthor(skill.ownerUserId, skill.collaboratorUserIds, currentUser);
  const canDeleteSkill = skill ? isCurrentAppsAuthor(skill.ownerUserId, skill.collaboratorUserIds, currentUser) : false;
  const canManageAccess = app ? canDeleteApp : Boolean(skill && canDeleteSkill);
  const canPublishProduct = app ? canDeleteApp : skill ? canDeleteSkill : true;
  const productionUrl = appsProductProductionUrl(app, listing);
  const progressSteps = appsProductProgressSteps({ app, listing, product, skill }, t);
  const infoFormId = `apps-basic-info-${product.id}`;
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const handoffMenuRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<AppsDetailTab>("basic");
  const [isTargetedAccessMode, setIsTargetedAccessMode] = useState(false);
  const [editingTab, setEditingTab] = useState<EditableTab | undefined>();
  const [isSavingInfo, setIsSavingInfo] = useState(false);
  const [appInfoInput, setAppInfoInput] = useState<AppsAppInfoInput>(() => appInfoInputFromApp(app));
  const [appResourceTypes, setAppResourceTypes] = useState<AppsProvisionedResourceType[]>(() => appResourceTypesFromApp(app));
  const [handoffElapsedSeconds, setHandoffElapsedSeconds] = useState(1);
  const [isHandoffMenuOpen, setIsHandoffMenuOpen] = useState(false);
  const [isGeneratingHandoff, setIsGeneratingHandoff] = useState(false);
  const [skillInfoInput, setSkillInfoInput] = useState<AppsSkillInfoInput>(() => skillInfoInputFromSkill(skill));
  const [appDraft, setAppDraft] = useState<AppsAppPublishDraft>(() => app ? appPublishDraftFromProduct(app, listing) : emptyAppPublishDraft());
  const [skillDraft, setSkillDraft] = useState<AppsSkillPublishDraft>(() => skill ? skillPublishDraftFromProduct(skill, listing) : emptySkillPublishDraft());
  const [isDeleteConfirming, setIsDeleteConfirming] = useState(false);
  const [isDelistConfirming, setIsDelistConfirming] = useState(false);
  const [deleteConfirmValue, setDeleteConfirmValue] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const deleteExpectedValue = app?.appCode ?? skill?.slug ?? "";
  const deleteConfirmMatches = deleteConfirmValue.trim() === deleteExpectedValue;
  const tabs: Array<{ key: AppsDetailTab; label: string }> = [
    { key: "basic", label: t("apps.detail.tab.basic") },
    ...(canManageAccess ? [{ key: "config" as const, label: t("apps.detail.tab.config") }] : []),
    ...(app?.resources.some((resource) => resource.type === "d1_database" || resource.type === "r2_bucket") ? [{ key: "security" as const, label: t("backup.tab") }] : []),
    ...(canPublishProduct ? [{ key: "review" as const, label: t("apps.detail.tab.review") }] : []),
    { key: "history", label: t("apps.detail.tab.history") }
  ];

  useEffect(() => {
    setActiveTab("basic");
    setIsTargetedAccessMode(false);
    setEditingTab(undefined);
    setAppInfoInput(appInfoInputFromApp(app));
    setAppResourceTypes(appResourceTypesFromApp(app));
    setHandoffElapsedSeconds(1);
    setIsHandoffMenuOpen(false);
    setIsGeneratingHandoff(false);
    setSkillInfoInput(skillInfoInputFromSkill(skill));
    setAppDraft(app ? appPublishDraftFromProduct(app, listing) : emptyAppPublishDraft());
    setSkillDraft(skill ? skillPublishDraftFromProduct(skill, listing) : emptySkillPublishDraft());
    setIsDeleteConfirming(false);
    setDeleteConfirmValue("");
    setDeleteError("");
    setIsDeleting(false);
  }, [product.id]);

  useEffect(() => {
    if (!isHandoffMenuOpen) {
      return;
    }

    function closeHandoffMenu(event: PointerEvent) {
      if (!handoffMenuRef.current?.contains(event.target as Node)) {
        setIsHandoffMenuOpen(false);
      }
    }

    function closeHandoffMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsHandoffMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeHandoffMenu);
    document.addEventListener("keydown", closeHandoffMenuOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeHandoffMenu);
      document.removeEventListener("keydown", closeHandoffMenuOnEscape);
    };
  }, [isHandoffMenuOpen]);

  useLayoutEffect(() => {
    const scroller = tabScrollRef.current;
    if (!scroller) {
      return;
    }

    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
  }, [activeTab, editingTab, product.id]);

  useEffect(() => {
    if (editingTab !== "basic") {
      setAppInfoInput(appInfoInputFromApp(app));
      setAppResourceTypes(appResourceTypesFromApp(app));
      setSkillInfoInput(skillInfoInputFromSkill(skill));
    }
  }, [app?.id, app?.updatedAt, editingTab, skill?.id, skill?.updatedAt]);

  useEffect(() => {
    if (editingTab !== "review") {
      setAppDraft(app ? appPublishDraftFromProduct(app, listing) : emptyAppPublishDraft());
      setSkillDraft(skill ? skillPublishDraftFromProduct(skill, listing) : emptySkillPublishDraft());
    }
  }, [app?.id, app?.updatedAt, editingTab, listing?.id, listing?.status, listing?.updatedAt, skill?.id, skill?.updatedAt]);

  useEffect(() => {
    if (!app || handoffReady) {
      setHandoffElapsedSeconds(1);
      return;
    }

    let refreshInFlight = false;
    const refreshEverySeconds = 5;
    let elapsedSeconds = 1;

    setHandoffElapsedSeconds(elapsedSeconds);
    const timer = window.setInterval(() => {
      elapsedSeconds = elapsedSeconds >= refreshEverySeconds ? 1 : elapsedSeconds + 1;
      setHandoffElapsedSeconds(elapsedSeconds);
      if (elapsedSeconds === 1) {
        if (!refreshInFlight) {
          refreshInFlight = true;
          void onAppRefresh(app).then(() => {
            refreshInFlight = false;
          }, () => {
            refreshInFlight = false;
          });
        }
      }
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [app, handoffReady, onAppRefresh]);

  async function saveAppInfo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!app) {
      return;
    }

    const existingResourceTypes = new Set(app.resources.map((resource) => resource.type as AppsProvisionedResourceType));
    const addResourceTypes = appResourceTypes.filter((resourceType) => !existingResourceTypes.has(resourceType));
    const hasInfoChanges = appInfoInput.name.trim() !== app.name || appInfoInput.note !== (app.description || "");

    setIsSavingInfo(true);
    try {
      let updated = app;
      if (hasInfoChanges) {
        const infoUpdated = await onAppUpdate(app, appInfoInput);
        if (!infoUpdated) {
          return;
        }
        updated = infoUpdated;
      }
      if (addResourceTypes.length > 0) {
        updated = await onAppConfigUpdate(updated, { addResourceTypes }) || updated;
      }
      setEditingTab(undefined);
    } finally {
      setIsSavingInfo(false);
    }
  }

  async function saveSkillInfo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!skill) {
      return;
    }

    setIsSavingInfo(true);
    try {
      const updated = await onSkillUpdate(skill, skillInfoInput);
      if (updated) {
        setEditingTab(undefined);
      }
    } finally {
      setIsSavingInfo(false);
    }
  }

  async function confirmDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deleteConfirmMatches) {
      setDeleteError(t("apps.detail.deleteMismatch"));
      return;
    }

    setIsDeleting(true);
    setDeleteError("");
    try {
      if (app) {
        await onAppDelete(app, listing, deleteConfirmValue.trim());
      } else if (skill) {
        await onSkillDelete(skill, listing, deleteConfirmValue.trim());
      }
    } catch {
      setDeleteError(t("apps.detail.deleteFailed"));
      setIsDeleting(false);
    }
  }

  async function savePublish() {
    const saved = app
      ? await onSubmitApp(app, appDraft)
      : skill
        ? await onSubmitSkill(skill, skillDraft)
        : false;

    if (saved) {
      setEditingTab(undefined);
    }
  }

  async function confirmDelist() {
    if (!listing || listing.status !== "listed") return;
    const delisted = await onDelist(listing);
    if (delisted) setIsDelistConfirming(false);
  }

  function resetDeleteState() {
    setIsDeleteConfirming(false);
    setDeleteConfirmValue("");
    setDeleteError("");
  }

  function cancelEditing() {
    setEditingTab(undefined);
    setAppInfoInput(appInfoInputFromApp(app));
    setAppResourceTypes(appResourceTypesFromApp(app));
    setSkillInfoInput(skillInfoInputFromSkill(skill));
    setAppDraft(app ? appPublishDraftFromProduct(app, listing) : emptyAppPublishDraft());
    setSkillDraft(skill ? skillPublishDraftFromProduct(skill, listing) : emptySkillPublishDraft());
    setIsDelistConfirming(false);
    resetDeleteState();
  }

  function selectTab(tab: AppsDetailTab) {
    cancelEditing();
    setIsHandoffMenuOpen(false);
    if (tabScrollRef.current) {
      tabScrollRef.current.scrollTop = 0;
      tabScrollRef.current.scrollLeft = 0;
    }
    setActiveTab(tab);
    setIsTargetedAccessMode(false);
  }

  function beginBasicEditing() {
    setIsHandoffMenuOpen(false);
    setAppInfoInput(appInfoInputFromApp(app));
    setAppResourceTypes(appResourceTypesFromApp(app));
    setEditingTab("basic");
  }

  async function copyAppHandoff(mode: AppsAppHandoffMode) {
    if (!app || !handoffReady || isGeneratingHandoff) {
      return;
    }

    setIsGeneratingHandoff(true);
    try {
      await onAppResources(app, mode);
      setIsHandoffMenuOpen(false);
    } finally {
      setIsGeneratingHandoff(false);
    }
  }

  function toggleAppResourceType(resourceType: AppsProvisionedResourceType) {
    if (!app || app.resources.some((resource) => resource.type === resourceType)) {
      return;
    }

    setAppResourceTypes((current) => current.includes(resourceType)
      ? current.filter((type) => type !== resourceType)
      : [...current, resourceType]);
  }

  function beginReviewEditing() {
    if (app) {
      setAppDraft({
        ...appPublishDraftFromProduct(app, listing),
        harnessSelfCheckConfirmed: false
      });
    }
    if (skill) {
      setSkillDraft(skillPublishDraftFromProduct(skill, listing));
    }
    setEditingTab("review");
  }

  const showTargetedAccessLayout = activeTab === "config" && isTargetedAccessMode;
  const isPublishing = marketSubmittingId === product.id;
  const publishSaveDisabled = app ? !appDraft.coverImageUrl.trim() : skill ? !skillDraft.coverImageUrl.trim() : false;
  const publishValidationHint = publishSaveDisabled ? t("apps.marketSubmit.coverRequired") : "";
  const canEditBasic = app ? canDeleteApp : Boolean(skill && canEditSkillInfo);
  const hasPendingAppResources = Boolean(app && appResourceTypes.some((resourceType) => !app.resources.some((resource) => resource.type === resourceType)));

  return (
    <ModalShell
      ariaLabel={t("apps.detail.aria", { name: product.name })}
      modalClassName={`profileModal assetReviewModal appsDetailModal${showTargetedAccessLayout ? " withAccessPicker" : ""}`}
      onClose={onClose}
      overlayClassName="profileModalOverlay assetReviewOverlay"
    >
        <button aria-label={t("apps.detail.close")} className="profileCloseButton" onClick={onClose} type="button">
          <X size={18} />
        </button>

        <div className="assetReviewHero">
          <AppsProductHeroIcon product={product} />
          <div>
            <p className="eyebrow">{t("apps.detail.eyebrow")}</p>
            <h2>{product.name}</h2>
            <div className="appsProductHeroMeta">
              <span>{product.kind}</span>
              <AppsAuthorAvatarGroup authors={product.authors ?? []} />
            </div>
          </div>
        </div>

        <div className={`assetReviewBody${showTargetedAccessLayout ? " isTargetedAccessMode" : ""}`}>
          <div className="assetReviewDetails">
            <div className="appReviewTabs appsDetailTabs" role="tablist">
              {tabs.map((tab) => (
                <button
                  aria-selected={activeTab === tab.key}
                  className={activeTab === tab.key ? "active" : ""}
                  key={tab.key}
                  onClick={() => selectTab(tab.key)}
                  role="tab"
                  type="button"
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className={`appsDetailTabPanel${activeTab === "basic" || activeTab === "review" ? " hasFooter" : ""}`}>
              <div
                className={`appsDetailTabScroll${activeTab === "config" ? " isSettingsTab" : activeTab === "history" ? " isHistoryTab" : ""}`}
                ref={tabScrollRef}
              >
                {activeTab === "basic" && (
                  <AppsProductBasicTab
                    app={app}
                    appInfoInput={appInfoInput}
                    canEditSkillInfo={canEditSkillInfo}
                    infoFormId={infoFormId}
                    isEditingInfo={editingTab === "basic"}
                    isSavingInfo={isSavingInfo}
                    listing={listing}
                    onInfoChange={setAppInfoInput}
                    onResourceToggle={toggleAppResourceType}
                    onSaveInfo={saveAppInfo}
                    onSaveSkillInfo={saveSkillInfo}
                    onSkillInfoChange={setSkillInfoInput}
                    product={product}
                    productionUrl={productionUrl}
                    progressSteps={progressSteps}
                    resourceTypes={appResourceTypes}
                    skill={skill}
                    skillInfoInput={skillInfoInput}
                  />
                )}

                {activeTab === "review" && app && (
                  <AppsAppPublishForm app={app} draft={appDraft} listing={listing} mode={editingTab === "review" ? "edit" : "view"} onChange={setAppDraft} />
                )}

                {activeTab === "config" && app && (
                  <AppsAppConfigTab app={app} catalog={catalog} onAccessUpdate={(input) => onAppAccessUpdate(app, input)} onCollaboratorsUpdate={(collaboratorUserIds) => onAppCollaboratorsUpdate(app, collaboratorUserIds)} onConfigUpdate={(input) => onAppConfigUpdate(app, input)} onSecretConfigure={(input) => onAppSecretConfigure(app, input)} onSecretDelete={(secret) => onAppSecretDelete(app, secret)} onTargetedModeChange={setIsTargetedAccessMode} />
                )}

                {activeTab === "security" && app && (
                  <AppsAppDataSecurity app={app} currentUser={currentUser} />
                )}

                {activeTab === "config" && skill && canManageAccess && (
                  <AppsSkillConfigTab catalog={catalog} onAccessUpdate={(input) => onSkillAccessUpdate(skill, input)} onCollaboratorsUpdate={(collaboratorUserIds) => onSkillCollaboratorsUpdate(skill, collaboratorUserIds)} onTargetedModeChange={setIsTargetedAccessMode} skill={skill} />
                )}

                {activeTab === "review" && skill && canPublishProduct && (
                  <AppsSkillPublishForm draft={skillDraft} listing={listing} mode={editingTab === "review" ? "edit" : "view"} onChange={setSkillDraft} skill={skill} />
                )}

                {activeTab === "review" && !app && !skill && (
                  <AppsDetailSection rows={marketListingRows(listing, t)} title={t("apps.detail.marketInfoTitle")} />
                )}

                {activeTab === "history" && (
                  <AppsHistoryPanel app={app} catalog={catalog} listing={listing} skill={skill} />
                )}

                {activeTab === "basic" && isDeleteConfirming && editingTab === "basic" && (
                  <section className="appsDetailDangerZone appsDetailDeleteEditor">
                    <form className="appsDeleteConfirmPanel" onSubmit={confirmDelete}>
                      <strong>{t("apps.detail.deleteConfirmTitle", { name: product.name })}</strong>
                      <p>{app ? t("apps.detail.deleteHelpApp") : t("apps.detail.deleteHelpSkill")}</p>
                      <code>{t("apps.detail.deleteExpected", { code: deleteExpectedValue })}</code>
                      <label>
                        <span>{app ? t("apps.detail.deleteConfirmLabelApp") : t("apps.detail.deleteConfirmLabelSkill")}</span>
                        <input
                          autoComplete="off"
                          autoFocus
                          disabled={isDeleting}
                          onChange={(event) => {
                            setDeleteConfirmValue(event.target.value);
                            setDeleteError("");
                          }}
                          value={deleteConfirmValue}
                        />
                      </label>
                      {deleteError && <div className="formMessage error">{deleteError}</div>}
                      <div className="appsDeleteConfirmActions">
                        <Button disabled={isDeleting} onClick={resetDeleteState} size="compact" variant="secondary">
                          {t("apps.detail.deleteCancel")}
                        </Button>
                        <Button disabled={!deleteConfirmMatches} iconBefore={<Trash2 size={15} />} isLoading={isDeleting} size="compact" type="submit" variant="danger">
                          {app ? t("apps.detail.deleteConfirmApp") : t("apps.detail.deleteConfirmSkill")}
                        </Button>
                      </div>
                    </form>
                  </section>
                )}
              </div>

              {activeTab === "basic" && (
                <footer className="appsDetailTabFooter">
                  <div className="appsTabUtilityActions">
                    {editingTab === "basic" ? (
                      ((app && canDeleteApp) || (skill && canDeleteSkill)) && !isDeleteConfirming && (
                        <Button iconBefore={<Trash2 size={15} />} onClick={() => setIsDeleteConfirming(true)} size="compact" variant="danger">
                          {app ? t("apps.detail.deleteApp") : t("apps.detail.deleteSkill")}
                        </Button>
                      )
                    ) : (
                      <>
                        {app && canDeleteApp && (
                          <div className="appsHandoffAction" ref={handoffMenuRef}>
                            <Button
                              aria-expanded={isHandoffMenuOpen}
                              aria-haspopup="menu"
                              aria-label={isGeneratingHandoff ? t("apps.resources.generatingHandoff") : handoffReady ? t("apps.resources.copyHandoff") : t("apps.resources.provisioningElapsed", { seconds: handoffElapsedSeconds })}
                              className={`appsCopyAgentButton${handoffReady ? "" : " isProvisioning"}`}
                              disabled={!handoffReady}
                              iconAfter={handoffReady ? <ChevronDown aria-hidden="true" size={14} /> : undefined}
                              iconBefore={handoffReady ? <Clipboard size={15} /> : <span className="appsCopyCountdown" aria-hidden="true">{handoffElapsedSeconds}s</span>}
                              isLoading={isGeneratingHandoff}
                              onClick={() => setIsHandoffMenuOpen((current) => !current)}
                              size="compact"
                              title={isGeneratingHandoff ? t("apps.resources.generatingHandoff") : handoffReady ? t("apps.resources.copyHandoff") : t("apps.resources.provisioningTitle")}
                              variant="primary"
                            >
                              {isGeneratingHandoff ? t("apps.resources.generatingHandoff") : handoffReady ? t("apps.resources.copyHandoff") : t("apps.resources.provisioning")}
                            </Button>
                            {isHandoffMenuOpen && (
                              <div aria-label={t("apps.handoff.menuAria")} className="appsHandoffMenu" role="menu">
                                <button disabled={isGeneratingHandoff} onClick={() => void copyAppHandoff("environment")} role="menuitem" type="button">
                                  <Clipboard aria-hidden="true" size={17} />
                                  <span>
                                    <strong>{t("apps.handoff.copyEnvironment")}</strong>
                                    <small>{t("apps.handoff.copyEnvironmentDetail")}</small>
                                  </span>
                                </button>
                                <button disabled={isGeneratingHandoff} onClick={() => void copyAppHandoff("source-collaboration")} role="menuitem" type="button">
                                  <Download aria-hidden="true" size={17} />
                                  <span>
                                    <strong>{t("apps.handoff.downloadCollaborate")}</strong>
                                    <small>{t("apps.handoff.downloadCollaborateDetail")}</small>
                                  </span>
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                        {skill && (
                          <>
                            <Button iconBefore={<Download size={15} />} onClick={() => onSkillDownload(skill)} size="compact" variant="secondary">
                              {t("apps.detail.downloadSkill")}
                            </Button>
                            <Button iconBefore={<Code2 size={15} />} onClick={() => onSkillInstallPrompt(skill)} size="compact" variant="secondary">
                              {t("apps.detail.copyInstallPrompt")}
                            </Button>
                          </>
                        )}
                        {!app && !skill && (
                          <ButtonLink href="#/market" iconBefore={<ExternalLink size={15} />} size="compact" variant="secondary">
                            {t("apps.detail.viewSkillHub")}
                          </ButtonLink>
                        )}
                      </>
                    )}
                  </div>
                  <div className="appsTabPrimaryActions">
                    {editingTab === "basic" ? (
                      <>
                        <Button disabled={isSavingInfo} onClick={cancelEditing} size="compact" variant="secondary">{t("apps.editor.cancel")}</Button>
                        <Button form={infoFormId} isLoading={isSavingInfo} size="compact" type="submit" variant="primary">{isSavingInfo ? (hasPendingAppResources ? t("apps.resources.provisioning") : t("apps.editor.saving")) : t("apps.editor.save")}</Button>
                      </>
                    ) : canEditBasic ? (
                      <Button iconBefore={<Pencil size={15} />} onClick={beginBasicEditing} size="compact" variant="secondary">
                        {t("apps.editor.edit")}
                      </Button>
                    ) : null}
                  </div>
                </footer>
              )}

              {activeTab === "review" && canPublishProduct && (app || skill) && (
                <footer className="appsDetailTabFooter">
                  <div className="appsTabUtilityActions">
                    {editingTab === "review" && publishSaveDisabled && <span className="appsTabFooterHint">{publishValidationHint}</span>}
                    {isDelistConfirming && <span className="appsTabFooterHint">{t("apps.marketDelist.confirmHint")}</span>}
                    {!editingTab && listing?.status === "listed" && !isDelistConfirming && (
                      <Button disabled={isPublishing} iconBefore={<EyeOff size={15} />} onClick={() => setIsDelistConfirming(true)} size="compact" variant="danger">
                        {t("apps.marketDelist.action")}
                      </Button>
                    )}
                  </div>
                  <div className="appsTabPrimaryActions">
                    {isDelistConfirming ? (
                      <>
                        <Button disabled={isPublishing} onClick={() => setIsDelistConfirming(false)} size="compact" variant="secondary">{t("apps.marketDelist.cancel")}</Button>
                        <Button iconBefore={<EyeOff size={15} />} isLoading={isPublishing} onClick={() => void confirmDelist()} size="compact" variant="danger">
                          {t("apps.marketDelist.confirm")}
                        </Button>
                      </>
                    ) : editingTab === "review" ? (
                      <>
                        <Button disabled={isPublishing} onClick={cancelEditing} size="compact" variant="secondary">{t("apps.editor.cancel")}</Button>
                        <Button disabled={publishSaveDisabled} isLoading={isPublishing} onClick={() => void savePublish()} size="compact" variant="primary">
                          {isPublishing ? t("apps.editor.saving") : listing?.status === "delisted" ? t("apps.marketDelist.resubmit") : t("apps.editor.save")}
                        </Button>
                      </>
                    ) : (
                      <Button iconBefore={listing?.status === "delisted" ? <Rocket size={15} /> : <Pencil size={15} />} onClick={beginReviewEditing} size="compact" variant="primary">
                        {listing?.status === "delisted" ? t("apps.marketDelist.resubmit") : t("apps.editor.edit")}
                      </Button>
                    )}
                  </div>
                </footer>
              )}
            </div>
          </div>
        </div>
    </ModalShell>
  );
}

function appsProductIcon(type: AppsProductItem["type"]) {
  return type === "app" ? <Boxes size={16} /> : <BookOpen size={16} />;
}

function AppsProductHeroIcon({ product }: { product: AppsProductItem }) {
  const coverImageUrl = product.coverImageUrl?.trim();
  const [imageFailed, setImageFailed] = useState(false);
  const hasImage = Boolean(coverImageUrl && !imageFailed);

  useEffect(() => {
    setImageFailed(false);
  }, [coverImageUrl]);

  return (
    <span className={`adminAssetTypeIcon ${product.type}${hasImage ? " uploaded" : ""}`}>
      {hasImage ? <img alt="" onError={() => setImageFailed(true)} src={coverImageUrl} /> : appsProductIcon(product.type)}
    </span>
  );
}

function appResourceTypesFromApp(app?: AppsApp): AppsProvisionedResourceType[] {
  return app?.resources.map((resource) => resource.type as AppsProvisionedResourceType) ?? [];
}
