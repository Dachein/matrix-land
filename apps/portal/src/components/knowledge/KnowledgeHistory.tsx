import type { Controller } from "./knowledgePresentation";
import { useI18n } from "../../../../../src/portal/i18n";
import { ModalShell } from "../../../../../src/portal/components/ModalShell";
import { History, X, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../../../../../src/portal/components/Button";
import type { KnowledgeAuditCategory } from "../../../../../src/portal/knowledge/useKnowledgeWorkspace";
import { formatDate } from "../../../../../src/portal/knowledge/utils";
import { createPortal } from "react-dom";

export function PortalKnowledgeHistory({ controller }: { controller: Controller }) {
  const { locale, t } = useI18n();
  const target = controller.historyTarget;
  if (!target) return null;

  const modal = (
    <ModalShell
      ariaLabel={t("knowledge.historyTitle", { name: target.name })}
      header={(
        <div className="portal-knowledge-history-title">
          <History size={20} />
          <div>
            <strong>{t("knowledge.historyTitle", { name: target.name })}</strong>
            <span>{t("knowledge.auditCommittedNote")}</span>
          </div>
        </div>
      )}
      headerActions={(
        <Button aria-label={t("common.close")} iconBefore={<X size={17} />} onClick={controller.closeChangeHistory} variant="icon" />
      )}
      headerClassName="portal-knowledge-history-header"
      modalClassName="portal-knowledge-history"
      onClose={controller.closeChangeHistory}
      overlayClassName="portal-knowledge-history-layer"
    >
      <div className="portal-knowledge-history-scope">
        <div>
          <span>{t("knowledge.auditScope")}</span>
          <strong>{(controller.historyScope?.kind ?? target.kind) === "folder" ? t("knowledge.auditScopeFolder") : t("knowledge.auditScopeFile")}</strong>
          <code>{controller.historyScope?.path || target.path}</code>
        </div>
        <div>
          <span>{t("knowledge.auditObjectId")}</span>
          <code>{controller.historyScope?.objectId || target.id}</code>
        </div>
        <p>{(controller.historyScope?.includesDescendants ?? target.kind === "folder") ? t("knowledge.auditScopeFolderHint") : t("knowledge.auditScopeFileHint")}</p>
      </div>

      <form
        className="portal-knowledge-history-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void controller.searchChangeHistory();
        }}
      >
        <label className="portal-knowledge-history-search">
          <Search size={16} />
          <input
            aria-label={t("knowledge.auditSearchAria")}
            onChange={(event) => controller.setHistorySearch(event.target.value)}
            placeholder={t("knowledge.auditSearchPlaceholder")}
            type="search"
            value={controller.historySearch}
          />
        </label>
        <label className="portal-knowledge-history-category">
          <span>{t("knowledge.auditCategory")}</span>
          <select
            aria-label={t("knowledge.auditCategory")}
            disabled={controller.isHistoryLoading}
            onChange={(event) => void controller.changeHistoryCategory(event.target.value as KnowledgeAuditCategory)}
            value={controller.historyCategory}
          >
            <option value="all">{t("knowledge.auditCategory.all")}</option>
            <option value="create">{t("knowledge.auditCategory.create")}</option>
            <option value="edit">{t("knowledge.auditCategory.edit")}</option>
            <option value="structure">{t("knowledge.auditCategory.structure")}</option>
            <option value="lifecycle">{t("knowledge.auditCategory.lifecycle")}</option>
            <option value="import">{t("knowledge.auditCategory.import")}</option>
          </select>
        </label>
        <Button disabled={controller.isHistoryLoading} type="submit" variant="secondary">{t("knowledge.auditSearch")}</Button>
      </form>

      <div className="portal-knowledge-history-layout">
        <div className="portal-knowledge-history-list-pane">
          <nav aria-label={t("knowledge.history")} className="portal-knowledge-history-list">
            {controller.isHistoryLoading && controller.historyChanges.length === 0 && <p>{t("knowledge.loading")}</p>}
            {!controller.isHistoryLoading && controller.historyChanges.length === 0 && <p>{t("knowledge.historyEmpty")}</p>}
            {controller.historyChanges.map((change) => {
              const actorId = change.actor?.userId;
              const actorProfile = actorId ? controller.ownerProfiles.get(actorId) : undefined;
              const actorName = actorProfile?.name || actorId || change.actor?.type || "system";
              const actorEmail = change.actor?.email || actorProfile?.email;
              return (
                <button
                  className={controller.historyDetail?.change?.id === change.id ? "active" : ""}
                  key={change.id}
                  onClick={() => controller.selectHistoryChange(change.id)}
                  type="button"
                >
                  <strong>{knowledgeAuditActionLabel(change.operation, t)}</strong>
                  <span>{change.summary || t("knowledge.historyChange")}</span>
                  <small>{change.createdAt ? formatDate(change.createdAt, locale) : "-"}</small>
                  <small>{t("knowledge.auditExecutor")}: {actorName}{actorEmail ? ` <${actorEmail}>` : ""} · {change.sourceChannel || "api"} · {t("knowledge.auditObjectCount", { count: change.itemCount ?? 0 })}</small>
                </button>
              );
            })}
          </nav>
          <footer className="portal-knowledge-history-pagination">
            <Button
              aria-label={t("knowledge.auditPreviousPage")}
              disabled={controller.isHistoryLoading || controller.historyPage <= 1}
              iconBefore={<ChevronLeft size={16} />}
              onClick={() => void controller.previousHistoryPage()}
              variant="icon"
            />
            <span>{t("knowledge.auditPage", { page: controller.historyPage })}</span>
            <Button
              aria-label={t("knowledge.auditNextPage")}
              disabled={controller.isHistoryLoading || !controller.historyNextCursor}
              iconBefore={<ChevronRight size={16} />}
              onClick={() => void controller.nextHistoryPage()}
              variant="icon"
            />
          </footer>
        </div>
        <section className="portal-knowledge-history-detail">
          {controller.historyDetail?.change && (
            <header>
              <div>
                <span>{t("knowledge.auditRequest")}</span>
                <code>{controller.historyDetail.change.requestId || controller.historyDetail.change.id}</code>
                {(() => {
                  const actor = controller.historyDetail.change.actor;
                  const profile = actor?.userId ? controller.ownerProfiles.get(actor.userId) : undefined;
                  const email = actor?.email || profile?.email;
                  if (!email) return null;
                  return <small className="portal-knowledge-history-executor">{t("knowledge.auditExecutor")}: {email}</small>;
                })()}
              </div>
              <strong>{knowledgeAuditActionLabel(controller.historyDetail.change.operation, t)}</strong>
            </header>
          )}
          {controller.historyDetail?.items?.map((item) => (
            <article key={item.id}>
              <div className="portal-knowledge-history-object-heading">
                <strong>{knowledgeAuditActionLabel(item.action, t)}</strong>
                <span>{item.pathAfter || item.pathBefore || t("common.notAvailable")}</span>
              </div>
              <dl>
                <div><dt>{t("knowledge.auditObjectId")}</dt><dd><code>{item.objectId || "-"}</code></dd></div>
                <div><dt>{t("knowledge.auditPathBefore")}</dt><dd>{item.pathBefore || "∅"}</dd></div>
                <div><dt>{t("knowledge.auditPathAfter")}</dt><dd>{item.pathAfter || "∅"}</dd></div>
                <div><dt>{t("knowledge.auditVersion")}</dt><dd>{item.versionBeforeId || "∅"} → {item.versionAfterId || "∅"}</dd></div>
              </dl>
            </article>
          ))}
          {controller.historyDiff?.diff ? (
            <>
              <h3>{t("knowledge.diff")}</h3>
              <pre>{controller.historyDiff.diff}</pre>
              {controller.historyDiff.truncated && <p>{t("knowledge.diffTruncated")}</p>}
            </>
          ) : controller.historyDetail ? (
            <p className="portal-knowledge-history-diff-empty">{t("knowledge.diffUnavailable")}</p>
          ) : (
            <p>{t("knowledge.historySelect")}</p>
          )}
        </section>
      </div>
    </ModalShell>
  );

  return typeof document === "undefined" ? null : createPortal(modal, document.body);
}

function knowledgeAuditActionLabel(action: string | undefined, t: ReturnType<typeof useI18n>["t"]) {
  const normalized = action?.trim() || "change";
  const keys = {
    batch_edit: "knowledge.auditAction.batch_edit",
    change: "knowledge.auditAction.change",
    create: "knowledge.auditAction.create",
    delete: "knowledge.auditAction.delete",
    edit: "knowledge.auditAction.edit",
    folder_create: "knowledge.auditAction.folder_create",
    folder_delete: "knowledge.auditAction.delete",
    folder_move: "knowledge.auditAction.move",
    folder_rename: "knowledge.auditAction.rename",
    move: "knowledge.auditAction.move",
    rename: "knowledge.auditAction.rename",
    restore: "knowledge.auditAction.restore",
    restore_version: "knowledge.auditAction.restore_version",
    update: "knowledge.auditAction.update",
    zip_import: "knowledge.auditAction.zip_import"
  } as const;
  return t(keys[normalized as keyof typeof keys] ?? keys.change);
}
