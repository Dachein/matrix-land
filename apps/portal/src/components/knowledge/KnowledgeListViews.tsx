import type { Controller } from "./knowledgePresentation";
import { useI18n } from "../../../../../src/portal/i18n";
import type { KnowledgeItem } from "../../../../../src/portal/knowledge/types";
import { PortalKnowledgeItemIcon, PortalKnowledgeAccessBadge } from "./knowledgePresentation";
import {
  knowledgeRelativePathLabel,
  kindLabel,
  formatBytes
} from "../../../../../src/portal/knowledge/utils";
import { RelativeTime } from "../../../../../src/portal/components/shared/time";
import { MoreHorizontal, Folder, BookOpen } from "lucide-react";
import { PortalRowsSkeleton } from "../PortalRecovery";
import type { PortalCatalog } from "../../../../../src/shared/types";
import type { PortalKnowledgeSection } from "../../routing/portalRoutes";
import { PortalKnowledgeMaintainers } from "./KnowledgeDetails";
import type { ReactNode, KeyboardEvent } from "react";

export function PortalKnowledgeUnifiedList({ controller }: { controller: Controller }) {
  const { locale, t } = useI18n();
  const children = controller.currentFolderId ? controller.visibleItems : controller.visibleRecentItems;

  function childRow(item: KnowledgeItem, recent = false) {
    return (
      <article
        className={`portal-knowledge-unified-row child${controller.selectedId === item.id ? " active" : ""}`}
        data-knowledge-item-id={item.id}
        key={`${recent ? "recent" : "child"}-${item.id}`}
        onContextMenu={(event) => controller.showItemMenu(item, event)}
        role="row"
      >
        <button
          className="portal-knowledge-unified-hit"
          onClick={() => controller.activateItem(item)}
          onKeyDown={(event) => openOnKeyboard(event, () => controller.activateItem(item))}
          type="button"
        >
          <span className="portal-knowledge-unified-name">
            <PortalKnowledgeItemIcon item={item} size={19} />
            <span><strong>{item.name}</strong>{recent && <small>{knowledgeRelativePathLabel(item)}</small>}</span>
          </span>
          {recent ? <PortalKnowledgeAccessBadge item={item} /> : <span>{kindLabel(item.kind, t)}</span>}
          <span><RelativeTime value={item.modifiedAt} /></span>
          <span>{item.kind === "folder" ? "–" : formatBytes(item.sizeBytes, locale)}</span>
        </button>
        <button aria-label={t("knowledge.contextMenuAria")} className="portal-knowledge-more" onClick={(event) => controller.showItemMenu(item, event)} type="button"><MoreHorizontal size={16} /></button>
      </article>
    );
  }

  return (
    <div aria-label={t("knowledge.tableAria")} className="portal-knowledge-unified-list" role="table">
      <div className={`portal-knowledge-unified-header${controller.currentFolderId ? "" : " root"}`} role="row">
        <span role="columnheader">{t("knowledge.columnName")}</span>
        <span role="columnheader">{t(controller.currentFolderId ? "knowledge.columnType" : "knowledge.columnRelationOrType")}</span>
        {controller.currentFolderId && <span role="columnheader">{t("knowledge.columnModified")}</span>}
        {controller.currentFolderId && <span role="columnheader">{t("knowledge.columnSize")}</span>}
      </div>
      {!controller.currentFolderId && controller.visibleRootItems.map((item) => (
        <div key={item.id}>
          <article className={`portal-knowledge-unified-row root${controller.selectedId === item.id ? " active" : ""}`} data-knowledge-item-id={item.id} onContextMenu={(event) => controller.showItemMenu(item, event)} role="row">
            <button className="portal-knowledge-unified-hit" onClick={() => controller.activateItem(item)} onKeyDown={(event) => openOnKeyboard(event, () => controller.activateItem(item))} type="button">
              <span className="portal-knowledge-unified-name">
                <Folder size={19} />
                <span><strong>{item.name}</strong><small>{item.description || t("knowledge.noDescription")}</small></span>
              </span>
              <PortalKnowledgeAccessBadge item={item} />
            </button>
            <button aria-label={t("knowledge.contextMenuAria")} className="portal-knowledge-more" onClick={(event) => controller.showItemMenu(item, event)} type="button"><MoreHorizontal size={16} /></button>
          </article>
        </div>
      ))}
      {!controller.currentFolderId && !controller.visibleRootItems.length && (
        controller.isLoading ? <PortalRowsSkeleton className="portal-knowledge-loading-skeleton" />
          : <div className="portal-knowledge-unified-empty">{t("knowledge.noSearchResults")}</div>
      )}
      {controller.currentFolderId && (
        controller.isLoading ? <PortalRowsSkeleton className="portal-knowledge-loading-skeleton" />
          : children.length ? children.map((item) => childRow(item))
            : <div className="portal-knowledge-unified-empty">{controller.query ? t("knowledge.noSearchResults") : t("knowledge.emptyFolder")}</div>
      )}
      {!controller.currentFolderId && (
        <>
          <div className="portal-knowledge-unified-group" role="row"><span role="cell">{t("knowledge.recentlyAccessed")}</span></div>
          {children.length > 0 && (
            <div className="portal-knowledge-unified-header recent" role="row">
              <span role="columnheader">{t("knowledge.columnName")}</span>
              <span role="columnheader">{t("knowledge.columnRelationOrType")}</span>
              <span role="columnheader">{t("knowledge.columnModified")}</span>
              <span role="columnheader">{t("knowledge.columnSize")}</span>
            </div>
          )}
          {children.length ? children.map((item) => childRow(item, true))
            : <div className="portal-knowledge-unified-empty">{t("knowledge.noRecentAccess")}</div>}
        </>
      )}
    </div>
  );
}

export function PortalKnowledgeList({
  catalog,
  controller,
  section,
  items
}: {
  catalog: PortalCatalog;
  controller: Controller;
  section: PortalKnowledgeSection;
  items?: KnowledgeItem[];
}) {
  const { locale, t } = useI18n();
  const showAccess = showsRootKnowledgeAccess(section, controller.currentFolderId);
  const showServiceSummary = section === "services" && !controller.currentFolderId;

  return (
    <div className="portal-knowledge-list" role="table" aria-label={t("knowledge.tableAria")}>
      <div className={`portal-knowledge-list-header ${showAccess ? "with-access" : ""}${showServiceSummary ? " service-summary" : ""}`} role="row">
        <span role="columnheader">{t("knowledge.columnName")}</span>
        {!showServiceSummary && <span role="columnheader">{showAccess ? t("knowledge.columnPublishStatus") : t("knowledge.columnType")}</span>}
        <span role="columnheader">{t("knowledge.columnModified")}</span>
        {!showServiceSummary && !showAccess && <span role="columnheader">{t("knowledge.columnSize")}</span>}
        {showServiceSummary
          ? <span role="columnheader">{t("knowledge.columnMaintenanceTeam")}</span>
          : showAccess
            ? <span role="columnheader">{t("knowledge.columnAccess")}</span>
            : null}
      </div>
      {(items ?? controller.visibleItems).map((item) => showServiceSummary ? (
        <article
          className={`portal-knowledge-row service-summary ${controller.selectedId === item.id ? "active" : ""}`}
          data-knowledge-item-id={item.id}
          key={item.id}
          onContextMenu={(event) => controller.showItemMenu(item, event)}
          role="row"
        >
          <button
            aria-expanded={controller.selectedId === item.id}
            className="portal-knowledge-row-hit"
            onClick={() => controller.activateItem(item)}
            onKeyDown={(event) => openOnKeyboard(event, () => controller.activateItem(item))}
            onPointerCancel={controller.clearLongPressTimer}
            onPointerDown={(event) => controller.beginItemLongPress(item, event)}
            onPointerMove={controller.clearLongPressTimer}
            onPointerUp={controller.clearLongPressTimer}
            type="button"
          >
            <span className="portal-knowledge-name-cell">
              <PortalKnowledgeItemIcon item={item} size={20} />
              <span>
                <strong>{item.name}</strong>
                <small className="portal-knowledge-service-description">{item.description || t("knowledge.noDescription")}</small>
              </span>
            </span>
            <span><RelativeTime value={item.modifiedAt} /></span>
          </button>
          <PortalKnowledgeMaintainers catalog={catalog} controller={controller} item={item} />
        </article>
      ) : (
        <article
          className={`portal-knowledge-row ${controller.selectedId === item.id ? "active" : ""} ${showAccess ? "with-access" : ""}`}
          data-knowledge-item-id={item.id}
          key={item.id}
          onContextMenu={(event) => controller.showItemMenu(item, event)}
        >
          <button
            className="portal-knowledge-row-hit"
            onClick={() => controller.activateItem(item)}
            onKeyDown={(event) => openOnKeyboard(event, () => controller.activateItem(item))}
            onPointerCancel={controller.clearLongPressTimer}
            onPointerDown={(event) => controller.beginItemLongPress(item, event)}
            onPointerMove={controller.clearLongPressTimer}
            onPointerUp={controller.clearLongPressTimer}
            type="button"
          >
            <span className="portal-knowledge-name-cell">
              <PortalKnowledgeItemIcon item={item} size={20} />
              <span>
                <span className="portal-knowledge-title-line">
                  <strong>{item.name}</strong>
                  {showsKnowledgeServiceMark(section, controller.currentFolderId, item) && <PortalKnowledgeServiceMark />}
                </span>
                {section !== "my" && <small>{knowledgeRelativePathLabel(item)}</small>}
              </span>
            </span>
            <span>{showAccess ? t(item.agentEnabled ? "knowledge.published" : "knowledge.unpublished") : kindLabel(item.kind, t)}</span>
            <span><RelativeTime value={item.modifiedAt} /></span>
            {!showAccess && <span>{item.kind === "folder" ? "-" : formatBytes(item.sizeBytes, locale)}</span>}
            {showAccess && <PortalKnowledgeAccessBadge item={item} />}
          </button>
          <button
            aria-label={t("knowledge.contextMenuAria")}
            className="portal-knowledge-more"
            onClick={(event) => controller.showItemMenu(item, event)}
            type="button"
          >
            <MoreHorizontal size={16} />
          </button>
        </article>
      ))}
    </div>
  );
}

export function PortalKnowledgeGrid({
  catalog,
  controller,
  section,
  items
}: {
  catalog: PortalCatalog;
  controller: Controller;
  section: PortalKnowledgeSection;
  items?: KnowledgeItem[];
}) {
  const { locale, t } = useI18n();
  const showServiceSummary = section === "services" && !controller.currentFolderId;
  const showAccess = showsRootKnowledgeAccess(section, controller.currentFolderId);

  return (
    <div aria-label={t("knowledge.gridAria")} className="portal-knowledge-grid" data-knowledge-grid>
      {(items ?? controller.visibleItems).map((item) => (
        <article
          className={`portal-knowledge-tile ${controller.currentFolderId === item.id || controller.selectedId === item.id ? "active" : ""}${showServiceSummary ? " service-summary" : ""}`}
          data-knowledge-item-id={item.id}
          key={item.id}
          onContextMenu={(event) => controller.showItemMenu(item, event)}
        >
          <button
            className="portal-knowledge-tile-hit"
            onClick={() => controller.activateItem(item)}
            onKeyDown={(event) => openOnKeyboard(event, () => controller.activateItem(item))}
            onPointerCancel={controller.clearLongPressTimer}
            onPointerDown={(event) => controller.beginItemLongPress(item, event)}
            onPointerMove={controller.clearLongPressTimer}
            onPointerUp={controller.clearLongPressTimer}
            type="button"
          >
            <span className="portal-knowledge-tile-icon">{showAccess ? <BookOpen size={28} /> : <PortalKnowledgeItemIcon item={item} size={28} />}</span>
            <span className="portal-knowledge-title-line">
              <strong>{item.name}</strong>
              {showsKnowledgeServiceMark(section, controller.currentFolderId, item) && <PortalKnowledgeServiceMark />}
            </span>
            <span className={showServiceSummary ? "portal-knowledge-service-description" : ""}>{showServiceSummary ? item.description || t("knowledge.noDescription") : showAccess ? t(item.agentEnabled ? "knowledge.published" : "knowledge.unpublished") : item.kind === "folder" ? t("knowledge.folder") : formatBytes(item.sizeBytes, locale)}</span>
            {showAccess && <span className="portal-knowledge-card-owner">{t("knowledge.owner")}: {controller.ownerProfiles.get(item.ownerUserId)?.name || t("common.notAvailable")}</span>}
            {showAccess && item.description && <span className="portal-knowledge-card-description">{item.description}</span>}
            {!showServiceSummary && showAccess && <PortalKnowledgeAccessBadge item={item} />}
            <small><RelativeTime value={item.modifiedAt} /></small>
          </button>
          {showServiceSummary ? (
            <>
              <PortalKnowledgeMaintainers catalog={catalog} controller={controller} item={item} />
            </>
          ) : (
            <button aria-label={t("knowledge.contextMenuAria")} className="portal-knowledge-more" onClick={(event) => controller.showItemMenu(item, event)} type="button">
              <MoreHorizontal size={16} />
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

export function PortalKnowledgeEmpty({ icon, title }: { icon: ReactNode; title: string }) {
  return <div className="portal-knowledge-empty">{icon}<strong>{title}</strong></div>;
}

function showsRootKnowledgeAccess(section: PortalKnowledgeSection, currentFolderId: string) {
  return section === "my" && !currentFolderId;
}

function showsKnowledgeServiceMark(section: PortalKnowledgeSection, currentFolderId: string, item: KnowledgeItem) {
  return section === "my" && !currentFolderId && item.kind === "folder" && item.agentEnabled;
}

function PortalKnowledgeServiceMark() {
  const { t } = useI18n();
  const label = t("knowledge.published");

  return (
    <span aria-label={label} className="portal-knowledge-service-mark" title={label}>
      <BookOpen aria-hidden="true" size={14} />
    </span>
  );
}

function openOnKeyboard(event: KeyboardEvent<HTMLButtonElement>, open: () => void) {
  if (event.key === "Enter") {
    event.preventDefault();
    open();
  }
}
