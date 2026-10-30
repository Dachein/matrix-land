import { knowledgeRootLabel, knowledgeDisplayPath } from "./knowledgePresentation";
import type { PortalCatalog } from "../../../../../src/shared/types";
import type { PortalKnowledgeSection } from "../../routing/portalRoutes";
import { useI18n } from "../../../../../src/portal/i18n";
import { useKnowledgeWorkspace } from "../../../../../src/portal/knowledge/useKnowledgeWorkspace";
import { useEffect } from "react";
import { Button } from "../../../../../src/portal/components/Button";
import { FolderPlus, Upload, Search, List, Grid2X2, X, ArrowLeft, FolderOpen } from "lucide-react";
import { SegmentedControl } from "../../../../../src/portal/components/SegmentedControl";
import { PortalKnowledgeUnifiedList, PortalKnowledgeEmpty, PortalKnowledgeGrid, PortalKnowledgeList } from "./KnowledgeListViews";
import { CopyForAgentButton } from "../../../../../src/portal/components/WorkspaceAgentHandoff";
import { knowledgeAgentHandoffText } from "../../../../../src/portal/knowledge/utils";
import { PortalRowsSkeleton } from "../PortalRecovery";
import { PortalUtilityRailPanel } from "../PortalUtilityRail";
import { PortalKnowledgeDetails } from "./KnowledgeDetails";
import { PortalKnowledgeContextMenu } from "./KnowledgeMenus";
import { PortalKnowledgeDialogs } from "./PortalKnowledgeDialogs";
import { PortalKnowledgeViewer } from "./KnowledgeViewer";
import { PortalKnowledgeHistory } from "./KnowledgeHistory";

export function PortalKnowledgeWorkspace({
  catalog,
  onSectionChange,
  section
}: {
  catalog: PortalCatalog;
  onSectionChange: (section: PortalKnowledgeSection) => void;
  section: PortalKnowledgeSection;
}) {
  const { locale, t } = useI18n();
  const controller = useKnowledgeWorkspace({ catalog, onSectionChange, section });
  const canCreate = controller.canEditCurrentFolder && Boolean(controller.currentFolderId);
  const lowerItems = controller.visibleItems;
  const currentFolder = controller.currentFolder;
  const detailVisible = controller.detailsOpen;
  useEffect(() => {
    if (section !== "my") controller.setDetailsOpen(false);
  }, [section]);

  function closeDetails() {
    controller.setDetailsOpen(false);
    window.requestAnimationFrame(() => controller.explorerRef.current?.focus({ preventScroll: true }));
  }

  return (
    <div className="portal-knowledge-surface">
      <section
        aria-label={t("knowledge.workspaceAria")}
        className="portal-knowledge-browser"
        onKeyDown={controller.handleExplorerKeyDown}
        ref={controller.explorerRef}
        tabIndex={-1}
      >
        <header className="portal-knowledge-toolbar">
          <div className="portal-knowledge-toolbar-actions">
            {!controller.currentFolderId && (
              <Button iconBefore={<FolderPlus size={16} />} onClick={controller.openCreateKnowledgeBaseDialog} variant="primary">
                {t("knowledge.newKnowledgeBase")}
              </Button>
            )}
            {canCreate && (
              <>
                <Button iconBefore={<FolderPlus size={16} />} onClick={controller.openCreateFolderDialog} variant="secondary">
                  {t("knowledge.newFolder")}
                </Button>
                <Button iconBefore={<Upload size={16} />} isLoading={controller.isBusy} onClick={() => controller.uploadInputRef.current?.click()} variant="primary">
                  {t("knowledge.upload")}
                </Button>
              </>
            )}
            <input hidden multiple onChange={controller.uploadFiles} ref={controller.uploadInputRef} type="file" />
            <input hidden onChange={controller.uploadNewVersion} ref={controller.versionInputRef} type="file" />
          </div>

          <div className="portal-knowledge-toolbar-controls">
            <label className="portal-search-field">
              <Search size={16} />
              <input
                aria-label={t("knowledge.searchAria")}
                onChange={(event) => controller.setQuery(event.target.value)}
                placeholder={t("knowledge.searchPlaceholder")}
                type="search"
                value={controller.query}
              />
            </label>
            {section === "my" && !controller.currentFolderId && (
              <SegmentedControl
                ariaLabel={t("knowledge.relationFilterAria")}
                className="portal-knowledge-sections"
                onChange={controller.setRootRelation}
                options={[
                  { label: t("knowledge.relation.all"), value: "all" },
                  { label: t("knowledge.relation.mine"), value: "mine" },
                  { label: t("knowledge.relation.viewer"), value: "viewer" }
                ]}
                value={controller.rootRelation}
              />
            )}
            {section !== "my" && <SegmentedControl
              ariaLabel={t("knowledge.viewModeAria")}
              compact
              onChange={controller.setViewMode}
              options={[
                { ariaLabel: t("knowledge.listView"), icon: <List size={15} />, value: "list" },
                { ariaLabel: t("knowledge.gridView"), icon: <Grid2X2 size={15} />, value: "grid" }
              ]}
              value={controller.viewMode}
            />}
          </div>
        </header>

        {controller.message && (
          <div className="portal-knowledge-notice" role="status">
            <span>{controller.message}</span>
            <Button aria-label={t("common.close")} iconBefore={<X size={15} />} onClick={() => controller.setMessage("")} variant="icon" />
          </div>
        )}

        {section === "my" && (
          <div className="portal-knowledge-projects">
            {controller.currentFolderId && (
              <nav aria-label={t("knowledge.breadcrumbAria")} className="portal-knowledge-breadcrumbs">
                <button onClick={controller.openRoot} type="button">{knowledgeRootLabel(section, t)}</button>
                {controller.breadcrumbs.map((crumb) => (
                  <span key={crumb.path}>
                    <span aria-hidden="true">/</span>
                    <button onClick={() => controller.openBreadcrumb(crumb.path)} type="button">{crumb.label}</button>
                  </span>
                ))}
                {currentFolder && (
                  <div className="portal-knowledge-path-actions">
                    <CopyForAgentButton
                      actionLabel={t("knowledge.copyForAgent")}
                      handoffText={knowledgeAgentHandoffText(
                        currentFolder,
                        knowledgeDisplayPath(section, controller.breadcrumbs.map((crumb) => crumb.label), undefined, t),
                        locale
                      )}
                      variant="compact"
                    />
                    <Button className="portal-knowledge-back-button" iconBefore={<ArrowLeft aria-hidden="true" size={15} />} onClick={() => {
                      const parent = controller.breadcrumbs.at(-2);
                      if (parent) controller.openBreadcrumb(parent.path);
                      else controller.openRoot();
                    }} size="compact" variant="secondary">{t("common.back")}</Button>
                  </div>
                )}
              </nav>
            )}
            <PortalKnowledgeUnifiedList controller={controller} />
          </div>
        )}

        {section !== "my" && <div className="portal-knowledge-directory">

        {section !== "recent" && (
          <nav aria-label={t("knowledge.breadcrumbAria")} className="portal-knowledge-breadcrumbs">
            <button onClick={controller.openRoot} type="button">{knowledgeRootLabel(section, t)}</button>
            {controller.breadcrumbs.map((crumb) => (
              <span key={crumb.path}>
                <span aria-hidden="true">/</span>
                <button onClick={() => controller.openBreadcrumb(crumb.path)} type="button">{crumb.label}</button>
              </span>
            ))}
            {currentFolder && (
              <div className="portal-knowledge-path-actions">
                <Button
                  className="portal-knowledge-back-button"
                  iconBefore={<ArrowLeft aria-hidden="true" size={15} />}
                  onClick={() => {
                    const parent = controller.breadcrumbs.at(-2);
                    if (parent) controller.openBreadcrumb(parent.path);
                    else controller.openRoot();
                  }}
                  size="compact"
                  variant="secondary"
                >
                  {t("common.back")}
                </Button>
              </div>
            )}
          </nav>
        )}

        <div className="portal-knowledge-content">
          {controller.isLoading ? (
            <PortalRowsSkeleton className="portal-knowledge-loading-skeleton" />
          ) : lowerItems.length === 0 ? (
            <PortalKnowledgeEmpty
              icon={<FolderOpen size={30} />}
              title={controller.query ? t("knowledge.noSearchResults") : t("knowledge.emptyFolder")}
            />
          ) : controller.viewMode === "grid" ? (
            <PortalKnowledgeGrid
              catalog={catalog}
              controller={controller}
              section={section}
              items={lowerItems}
            />
          ) : (
            <PortalKnowledgeList
              catalog={catalog}
              controller={controller}
              section={section}
              items={lowerItems}
            />
          )}
        </div>
        </div>}
      </section>

      <PortalUtilityRailPanel dismissOnScrim={false} onClose={closeDetails} open={section === "my" && detailVisible && Boolean(controller.selectedItem)} variant="inline">
        <PortalKnowledgeDetails catalog={catalog} controller={controller} onClose={closeDetails} />
      </PortalUtilityRailPanel>

      {controller.contextMenu && (
        <PortalKnowledgeContextMenu controller={controller} />
      )}

      <PortalKnowledgeDialogs controller={controller} />

      {controller.viewerItem && (
        <PortalKnowledgeViewer controller={controller} />
      )}
      {controller.historyTarget && (
        <PortalKnowledgeHistory controller={controller} />
      )}
    </div>
  );
}
