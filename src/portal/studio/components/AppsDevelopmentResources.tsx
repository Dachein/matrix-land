import { Check, Clock3, Copy } from "lucide-react";
import { useState } from "react";
import { appsAppendableResourceTypes, type AppsProvisionedResourceType } from "../../../shared/appsResourceCatalog";
import type { AppsApp } from "../../../shared/types";
import { useI18n } from "../../i18n";
import type { AppsTFunction } from "../labels";
import type { AppsDevelopmentResourceItem, AppsProductItem, AppsSkillProjectStructureModel } from "../types";
import { copyText } from "../utils";
import { AppsCustomResourceSelector } from "./AppsCreateFormSections";

export function AppsDevelopmentResources({
  app,
  isEditing = false,
  items,
  onResourceToggle,
  productType,
  resourceTypes = [],
  skillStructure
}: {
  app?: AppsApp;
  isEditing?: boolean;
  items: AppsDevelopmentResourceItem[];
  onResourceToggle?: (resourceType: AppsProvisionedResourceType) => void;
  productType: AppsProductItem["type"];
  resourceTypes?: AppsProvisionedResourceType[];
  skillStructure?: AppsSkillProjectStructureModel;
}) {
  const { t } = useI18n();
  const [copiedResourceKey, setCopiedResourceKey] = useState("");

  if (skillStructure) {
    return <AppsSkillProjectStructure structure={skillStructure} t={t} />;
  }

  async function copyResourceDetail(key: string, value: string) {
    await copyText(value);
    setCopiedResourceKey(key);
    window.setTimeout(() => setCopiedResourceKey((current) => current === key ? "" : current), 1400);
  }

  return (
    <section className="assetDetailSection appsDevResourceSection">
      <div className="appsSectionHeader appsDevResourceHeader">
        <div>
          <h3>{t("apps.resources.title")}</h3>
          <p>{t("apps.resources.body")}</p>
        </div>
      </div>
      {app && isEditing && onResourceToggle && (
        <AppsCustomResourceSelector
          availableTypes={appsAppendableResourceTypes(app.type)}
          body={t("apps.editor.resourcesBody")}
          lockedTypes={app.resources.map((resource) => resource.type as AppsProvisionedResourceType)}
          onToggle={onResourceToggle}
          selectedTypes={resourceTypes}
          showRuntimeEntry={false}
          title={t("apps.editor.resourcesTitle")}
        />
      )}
      <div className="appsResourceInventory">
        {items.map((item) => {
          const itemKey = `${item.label}:${item.detail}`;
          const isCopied = copiedResourceKey === itemKey;

          return (
            <article className={`appsResourceInventoryItem ${item.state}`} key={itemKey}>
              <span aria-hidden="true" className={`appsResourceCheck ${item.state}`}>
                {item.state === "ready" ? <Check size={14} /> : <Clock3 size={13} />}
              </span>
              <div className="appsResourceIdentity">
                <strong>{item.label}</strong>
                <button
                  className="appsResourceCopyValue"
                  onClick={() => void copyResourceDetail(itemKey, item.copyValue ?? item.detail)}
                  title={isCopied ? t("apps.copy.copied") : t("apps.resources.copyTitle")}
                  type="button"
                >
                  <span>{item.detail}</span>
                  {isCopied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
                  <span aria-live="polite" className="visuallyHidden">{isCopied ? t("apps.copy.copied") : ""}</span>
                </button>
              </div>
              <div className="appsResourceMeta">
                <span className={`appsResourceStatus ${item.state}`}>{item.status}</span>
                {item.environment && <small>{item.environment}</small>}
              </div>
            </article>
          );
        })}
        {items.length === 0 && (
          <div className="emptyState">
            {productType === "app" ? t("apps.resources.emptyApp") : t("apps.resources.emptySkill")}
          </div>
        )}
      </div>
    </section>
  );
}

function AppsSkillProjectStructure({ structure, t }: { structure: AppsSkillProjectStructureModel; t: AppsTFunction }) {
  return (
    <section className="assetDetailSection appsSkillStructureSection">
      <div className="appsSectionHeader appsSkillStructureHeader">
        <div>
          <h3>{t("apps.skillStructure.title")}</h3>
          <p>{t("apps.skillStructure.body")}</p>
        </div>
      </div>

      <div className="appsSkillStructureSummary">
        <div>
          <span>{t("apps.skillStructure.currentVersion")}</span>
          <strong>{structure.currentVersionLabel}</strong>
        </div>
        <div>
          <span>{t("apps.skillStructure.fileCount")}</span>
          <strong>{structure.fileCount > 0 ? t("apps.skillStructure.fileCountValue", { count: structure.fileCount }) : "-"}</strong>
        </div>
        <div>
          <span>{t("apps.skillStructure.packageSize")}</span>
          <strong>{structure.totalSize > 0 ? formatBytes(structure.totalSize) : "-"}</strong>
        </div>
      </div>

      <div className="appsSkillStructureList">
        {structure.groups.map((group) => {
          const visibleFiles = group.files.slice(0, 6);
          const hiddenCount = Math.max(0, group.files.length - visibleFiles.length);

          return (
            <article className="appsSkillStructureGroup" key={group.path}>
              <div className="appsSkillStructureGroupHead">
                <div className="appsSkillStructureGroupIdentity">
                  <strong>{group.label}</strong>
                  <span>{t("apps.skillStructure.groupFileCount", { count: group.fileCount })}</span>
                </div>
                <small>{group.sizeBytes > 0 ? formatBytes(group.sizeBytes) : t("apps.skillStructure.unknownSize")}</small>
              </div>
              {visibleFiles.length > 0 && (
                <div className="appsSkillFileList">
                  {visibleFiles.map((file) => (
                    <div className="appsSkillFileRow" key={file.path}>
                      <span title={file.path}>{file.path}</span>
                      <small>{file.sizeBytes ? formatBytes(file.sizeBytes) : file.kind || "file"}</small>
                    </div>
                  ))}
                  {hiddenCount > 0 && <div className="appsSkillFileMore">{t("apps.skillStructure.moreFiles", { count: hiddenCount })}</div>}
                </div>
              )}
            </article>
          );
        })}
        {structure.groups.length === 0 && (
          <div className="emptyState">{t("apps.skillStructure.empty")}</div>
        )}
      </div>
    </section>
  );
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const precision = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}
