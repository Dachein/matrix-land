import { SearchField } from "../../../../src/portal/components/SearchField";
import { PageHeading } from "../../../../src/portal/components/PageHeading";
import { AppsOwnerTransferInbox } from '../../../../src/portal/studio/components/AppsOwnership';
import { ArrowUpRight, BookOpen, Boxes, Cable, Plus, Search, ShieldCheck } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../../../src/portal/components/Button";
import { WorkspaceListbox } from "../../../../src/portal/components/WorkspaceListbox";
import { McpConnectionModal } from "../../../../src/portal/components/McpConnectionModal";
import { SegmentedControl } from "../../../../src/portal/components/SegmentedControl";
import { useI18n } from "../../../../src/portal/i18n";
import { AppsProductList } from "../../../../src/portal/studio/components/AppsProductList";
import { AppsMailDevelopmentGuide } from "../../../../src/portal/studio/components/AppsMailDevelopmentGuide";
import { AppsCopyNoticeModal } from "../../../../src/portal/studio/modals/AppsCopyNoticeModal";
import { useAppsWorkspace } from "../../../../src/portal/studio/useAppsWorkspace";
import type { AppsKindFilter, AppsStatusFilter } from "../../../../src/portal/studio/types";
import type { PortalCatalog } from "../../../../src/shared/types";
import "../styles/apps.css";

const CreateAppsAppModal = lazy(() => import("../../../../src/portal/studio/modals/CreateAppsAppModal").then((module) => ({ default: module.CreateAppsAppModal })));
const AppsProductDetailModal = lazy(() => import("../../../../src/portal/studio/modals/AppsProductDetailModal").then((module) => ({ default: module.AppsProductDetailModal })));

export function PortalApps({ catalog, onRefresh }: { catalog: PortalCatalog; onRefresh: () => void }) {
  const { t } = useI18n();
  const controller = useAppsWorkspace({ catalog, onCatalogRefresh: onRefresh });
  const appsObjectCount = controller.apps.length + controller.skills.length;
  const mcpAction = (
    <Button iconBefore={<Cable size={16} />} onClick={controller.openMcpModal} size="compact" variant="secondary">
      {t("apps.mcp.agentConnector")}
    </Button>
  );
  const statusOptions: Array<{ label: string; value: AppsStatusFilter }> = [
    { label: t("apps.filter.allStatuses"), value: "all" },
    { label: t("apps.filter.published"), value: "published" },
    { label: t("apps.filter.private"), value: "private" },
    { label: t("apps.filter.listed"), value: "listed" },
    { label: t("apps.filter.pendingReview"), value: "pending_review" }
  ];

  return (
    <div className="portal-workspace-inner portal-apps-workspace">
      <section className="portal-page portal-apps-page" aria-labelledby="portal-apps-title">
        <PageHeading
          id="portal-apps-title"
          className="portal-apps-heading"
          title={t("portal.apps.title")}
          eyebrow={<><div className="portal-apps-kicker">
              <span aria-hidden="true" className="portal-apps-orbit-mark"><i /></span>
              <span>{t("portal.apps.kicker")}</span>
            </div></>}
          actions={<><div className="portal-apps-heading-actions">
            <span className="portal-apps-object-count">
              <b>{appsObjectCount.toString().padStart(2, "0")}</b>
              {t("portal.apps.objectCount")}
            </span>
            <PortalAppsCreateMenu
              onCreateApp={() => controller.setIsCreateOpen(true)}
              onSelectSkills={() => controller.setKindFilter("skills")}
            />
          </div></>}
        ><blockquote className="portal-apps-quote">
              <p>{t("portal.apps.subtitle")}</p>
              <cite>
                <a
                  aria-label={t("portal.apps.quoteSourceAria")}
                  href="https://www.youtube.com/watch?v=SlGRN8jh2RI"
                  rel="noreferrer"
                  target="_blank"
                >
                  {t("portal.apps.quoteSource")}
                  <ArrowUpRight aria-hidden="true" size={13} />
                </a>
              </cite>
            </blockquote></PageHeading>

        <div className="portal-apps-surface">
          <section className="portal-apps-controls">
            <SearchField
              className="portal-search-field portal-apps-search"
              label={t("apps.searchPlaceholder")}
              onChange={(event) => controller.setQuery(event.target.value)}
              placeholder={t("apps.searchPlaceholder")}
              value={controller.query}
            />
            <div className="portal-apps-filter-group">
              <SegmentedControl<AppsKindFilter>
                ariaLabel={t("apps.filter.all")}
                className="portal-apps-kind-filter"
                onChange={controller.setKindFilter}
                options={[
                  { label: t("apps.filter.all"), value: "all" },
                  { label: t("apps.filter.apps"), value: "apps" },
                  { label: t("apps.filter.skills"), value: "skills" }
                ]}
                value={controller.kindFilter}
              />
              <WorkspaceListbox<AppsStatusFilter>
                ariaLabel={t("apps.filter.allStatuses")}
                className="portal-apps-status-filter"
                iconBefore={<ShieldCheck size={14} />}
                noResultsLabel={t("common.noResults")}
                onChange={controller.setStatusFilter}
                options={statusOptions}
                value={controller.statusFilter}
                variant="filter"
              />
            </div>
          </section>

          {controller.message && <div className={`portal-apps-message ${controller.message.tone}`} role="status">{controller.message.text}</div>}
          {controller.matePreviewUrl && <div className="portal-apps-message success" role="status">
            <a href={controller.matePreviewUrl} rel="noreferrer" target="_blank">{t("apps.mate.openPreview")}</a>
          </div>}

          {controller.createdApp && <AppsMailDevelopmentGuide app={controller.createdApp} />}

          <AppsOwnerTransferInbox catalog={catalog} />
          <AppsProductList
            apps={controller.apps}
            catalog={catalog}
            kindFilter={controller.kindFilter}
            mcpAction={mcpAction}
            onAppDelete={controller.deleteAppProduct}
            onAppRefresh={controller.refreshApp}
            onAppUpdate={controller.updateAppInfo}
            onSkillDelete={controller.deleteSkillProduct}
            onSkillUpdate={controller.updateSkillInfo}
            query={controller.query}
            renderDetailModal={({ onAppDelete, onAppRefresh, onAppUpdate, onClose, onSkillDelete, onSkillUpdate, product }) => (
              <Suspense fallback={<span className="portal-route-loading" /> }>
                <AppsProductDetailModal
                  catalog={catalog}
                  currentUser={catalog.currentUser}
                  marketSubmittingId={controller.marketSubmittingId}
                  onAppAccessUpdate={controller.updateAppAccess}
                  onAppCollaboratorsUpdate={controller.updateAppCollaborators}
                  onAppConfigUpdate={controller.updateAppConfig}
                  onAppDelete={onAppDelete}
                  onAppProduction={(app) => void controller.publishApp(app)}
                  onAppRefresh={onAppRefresh}
                  onAppResources={(app, mode) => controller.copyAppResourcesToAgent(app, mode)}
                  onAppSecretConfigure={controller.configureAppSecret}
                  onAppSecretDelete={controller.deleteAppSecret}
                  onAppUpdate={onAppUpdate}
                  onClose={onClose}
                  onDelist={(listing) => controller.delistPublicationListing(listing)}
                  onSkillDelete={onSkillDelete}
                  onSkillDownload={(skill) => void controller.downloadSkillPackage(skill)}
                  onSkillInstallPrompt={(skill) => void controller.copySkillInstallPrompt(skill)}
                  onSkillAccessUpdate={controller.updateSkillAccess}
                  onSkillCollaboratorsUpdate={controller.updateSkillCollaborators}
                  onSkillUpdate={onSkillUpdate}
                  onSubmitApp={(app, draft) => controller.submitAppToMarket(app, draft)}
                  onSubmitSkill={(skill, draft) => controller.submitSkillToMarket(skill, draft)}
                  product={product}
                />
              </Suspense>
            )}
            skills={controller.skills}
            statusFilter={controller.statusFilter}
          />

          {controller.isCreateOpen && (
            <Suspense fallback={<span className="portal-route-loading" />}>
              <CreateAppsAppModal
                catalog={catalog}
                createInput={controller.createInput}
                onClose={() => {
                  if (!controller.submitting) controller.setIsCreateOpen(false);
                }}
                onSubmit={controller.createApp}
                setCreateInput={controller.setCreateInput}
                submitting={controller.submitting}
              />
            </Suspense>
          )}

          {controller.copyNotice && (
            <AppsCopyNoticeModal
              detail={controller.copyNotice.detail}
              onClose={() => controller.setCopyNotice(undefined)}
              title={controller.copyNotice.title}
            />
          )}

          {controller.isMcpOpen && (
            <McpConnectionModal
              connectionStatus={controller.mcpConnectionStatus}
              onClose={() => controller.setIsMcpOpen(false)}
              onRefresh={controller.refreshMcpConnectionStatus}
              statusMode={controller.mcpStatusMode}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function PortalAppsCreateMenu({
  onCreateApp,
  onSelectSkills
}: {
  onCreateApp: () => void;
  onSelectSkills: () => void;
}) {
  const { t } = useI18n();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ left: 16, top: 16, width: 340 });

  useLayoutEffect(() => {
    if (!isOpen) return undefined;

    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;

      const viewportPadding = 16;
      const width = Math.min(340, window.innerWidth - viewportPadding * 2);
      const left = Math.max(viewportPadding, Math.min(rect.right - width, window.innerWidth - width - viewportPadding));
      setPosition({ left, top: rect.bottom + 8, width });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchorRef.current?.contains(target) && !menuRef.current?.contains(target)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  return (
    <span className="portal-apps-new-control" ref={anchorRef}>
      <Button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        iconBefore={<Plus size={16} />}
        onClick={() => setIsOpen((current) => !current)}
        variant="primary"
      >
        {t("portal.apps.newApps")}
      </Button>
      {isOpen && typeof document !== "undefined" && createPortal(
        <div
          aria-label={t("portal.apps.newMenuAria")}
          className="portal-apps-create-menu"
          ref={menuRef}
          role="menu"
          style={position}
        >
          <button
            onClick={() => {
              setIsOpen(false);
              onCreateApp();
            }}
            role="menuitem"
            type="button"
          >
            <Boxes aria-hidden="true" size={17} />
            <span>
              <strong>{t("apps.createMenu.app")}</strong>
              <small>{t("apps.createMenu.appDetail")}</small>
            </span>
          </button>
          <button
            onClick={() => {
              setIsOpen(false);
              onSelectSkills();
            }}
            role="menuitem"
            type="button"
          >
            <BookOpen aria-hidden="true" size={17} />
            <span>
              <strong>{t("apps.createMenu.skill")}</strong>
              <small>{t("apps.createMenu.skillDetail")}</small>
            </span>
          </button>
        </div>,
        document.body
      )}
    </span>
  );
}
