import type { AppSensitiveDataType, AppsApp, AppsSkill, PublicationListing } from "../../../shared/types";
import type { ReactNode } from "react";
import { MARKET_CATEGORIES, marketCategoryOptionLabel, normalizeMarketCategoryName } from "../../../shared/marketCategories";
import { WORKSPACE_RELEASE_READINESS_REPORT_NAME } from "../../../shared/harnessReport";
import { WorkspaceListbox } from "../../components/WorkspaceListbox";
import { SquareCoverImageField } from "../../components/SquareCoverImageField";
import { useI18n } from "../../i18n";
import { sensitiveDataOptions } from "../constants";
import { appsLoginLabel, appsMarketStatusLabel, appsRiskLabel, appsSensitiveDataLabel, appsVisibilityLabel } from "../labels";
import type { AppsAppPublishDraft, AppsSkillPublishDraft } from "../types";

const WORKSPACE_AI_CLOUD_PROVIDER = "workspace_ai_cloud";

export function AppsAppPublishForm({
  app,
  draft,
  listing,
  mode,
  onChange
}: {
  app: AppsApp;
  draft: AppsAppPublishDraft;
  listing?: PublicationListing;
  mode: "view" | "edit";
  onChange: (draft: AppsAppPublishDraft) => void;
}) {
  const { locale, t } = useI18n();
  const usesWorkspaceAiCloud = draft.deploymentProvider === WORKSPACE_AI_CLOUD_PROVIDER;
  const category = normalizeMarketCategoryName(draft.category, "workflow");
  const categoryOption = MARKET_CATEGORIES.find((item) => item.en === category);
  const categoryLabel = categoryOption ? marketCategoryOptionLabel(categoryOption, locale) : category;
  const deploymentProviderLabel = appDeploymentProviderOptions(t).find((option) => option.value === draft.deploymentProvider)?.label ?? draft.deploymentProvider;
  const deploymentMethodLabel = appDeploymentMethodOptions(t).find((option) => option.value === draft.deploymentMethod)?.label ?? draft.deploymentMethod;
  const dataRegionLabel = appDataRegionOptions(t).find((option) => option.value === draft.dataRegion)?.label ?? draft.dataRegion;

  if (mode === "view") {
    return (
      <>
        <section className="assetDetailSection appReviewSection">
          <h3>{t("apps.publish.basicInfo")}</h3>
          <div className="assetDetailGrid appsPublishReadOnlyGrid">
            <PublishReadOnlyItem label={t("apps.publish.version")} value={draft.version} />
            <PublishReadOnlyItem label={t("apps.publish.nameZh")} value={draft.nameZh || app.name} />
            <PublishReadOnlyItem label={t("apps.publish.nameEn")} value={draft.nameEn || app.name} />
            <PublishReadOnlyItem label={t("apps.publish.category")} value={categoryLabel} />
            <PublishReadOnlyItem label={t("apps.publish.subtitle")} value={draft.subtitle || app.description} wide />
            <PublishReadOnlyItem label={t("apps.publish.tags")} value={draft.tags} wide />
            <PublishReadOnlyItem label={t("apps.publish.descriptionZh")} value={draft.descriptionZh} wide />
            <PublishReadOnlyItem label={t("apps.publish.descriptionEn")} value={draft.descriptionEn} wide />
            <PublishReadOnlyItem label={t("apps.publish.changelog")} value={draft.changelog} wide />
            <PublishCoverPreview emptyLabel={t("apps.publish.coverEmpty")} label={t("apps.publish.coverImage")} value={draft.coverImageUrl} />
          </div>
        </section>

        <section className="assetDetailSection appReviewSection">
          <h3>{t("apps.publish.accessReviewTitle")}</h3>
          <div className="assetDetailGrid appsPublishReadOnlyGrid">
            <PublishReadOnlyItem label={t("apps.publish.reviewStatus")} value={appsMarketStatusLabel(listing?.status, t)} />
            <PublishReadOnlyItem label={t("apps.publish.riskLevel")} value={appsRiskLabel(draft.riskLevel, t)} />
            <PublishReadOnlyItem label={t("apps.publish.accessMode")} value={`${appsVisibilityLabel(app.visibility, t)} / ${appsLoginLabel(app.loginRequired, t)}`} />
            <PublishReadOnlyItem label={t("apps.config.workspaceAuth")} value={app.loginRequired ? t("apps.publish.authUse") : t("apps.publish.authNotUse")} />
            <PublishReadOnlyItem label={t("apps.publish.deploymentProvider")} value={deploymentProviderLabel} />
            {!usesWorkspaceAiCloud && <PublishReadOnlyItem label={t("apps.publish.deploymentMethod")} value={deploymentMethodLabel} />}
            {!usesWorkspaceAiCloud && <PublishReadOnlyItem label={t("apps.publish.dataRegion")} value={dataRegionLabel} />}
            <PublishReadOnlyItem label={t("apps.publish.modelProvider")} value={draft.modelProvider} />
            <PublishReadOnlyItem
              label={t("apps.publish.sensitiveData")}
              value={draft.sensitiveDataTypes.map((value) => appsSensitiveDataLabel(value, t)).join(", ")}
              wide
            />
            <PublishReadOnlyItem label={t("apps.publish.riskReason")} value={draft.riskReason} wide />
            <PublishReadOnlyItem label={t("apps.publish.permissionNotes")} value={draft.permissionNotes} wide />
            <PublishReadOnlyItem label={t("apps.publish.outputNotes")} value={draft.outputNotes} wide />
          </div>
        </section>

        <section className="assetDetailSection appReviewSection">
          <h3>{t("apps.publish.releaseReadinessTitle")}</h3>
          <div className="assetDetailGrid appsPublishReadOnlyGrid">
            <PublishReadOnlyItem label={t("apps.publish.harnessReportName")} value={WORKSPACE_RELEASE_READINESS_REPORT_NAME} />
            <PublishReadOnlyItem label={t("apps.publish.harnessSelfCheck")} value={draft.harnessSelfCheckConfirmed ? t("apps.publish.selfCheckConfirmed") : t("apps.publish.selfCheckNotConfirmed")} />
            <PublishReadOnlyItem label={t("apps.publish.harnessReportUrl")} wide>
              {draft.harnessReportUrl ? (
                <a href={draft.harnessReportUrl} rel="noreferrer" target="_blank">{draft.harnessReportUrl}</a>
              ) : <strong>-</strong>}
            </PublishReadOnlyItem>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <section className="assetDetailSection appReviewSection">
        <h3>{t("apps.publish.basicInfo")}</h3>
        <div className="appReviewGrid">
          <label>
            {t("apps.publish.nameZh")}
            <input onChange={(event) => updateAppPublishDraft(draft, onChange, "nameZh", event.target.value)} value={draft.nameZh} />
          </label>
          <label>
            {t("apps.publish.nameEn")}
            <input onChange={(event) => updateAppPublishDraft(draft, onChange, "nameEn", event.target.value)} value={draft.nameEn} />
          </label>
          <label className="wide">
            {t("apps.publish.subtitle")}
            <input onChange={(event) => updateAppPublishDraft(draft, onChange, "subtitle", event.target.value)} value={draft.subtitle} />
          </label>
          <label>
            {t("apps.publish.version")}
            <input onChange={(event) => updateAppPublishDraft(draft, onChange, "version", event.target.value)} value={draft.version} />
          </label>
          <label>
            {t("apps.publish.category")}
            <WorkspaceListbox
              ariaLabel={t("apps.publish.category")}
              noResultsLabel={t("common.noResults")}
              searchable
              searchPlaceholder={t("common.search")}
              value={normalizeMarketCategoryName(draft.category, "workflow")}
              onChange={(value) => updateAppPublishDraft(draft, onChange, "category", value)}
              options={MARKET_CATEGORIES.map((category) => ({
                label: marketCategoryOptionLabel(category, locale),
                searchText: `${category.key} ${category.en} ${category.zh}`,
                value: category.en
              }))}
            />
          </label>
          <label className="wide">
            {t("apps.publish.tags")}
            <input onChange={(event) => updateAppPublishDraft(draft, onChange, "tags", event.target.value)} placeholder={t("apps.publish.tagsPlaceholder")} value={draft.tags} />
          </label>
          <label className="wide">
            {t("apps.publish.descriptionZh")}
            <textarea onChange={(event) => updateAppPublishDraft(draft, onChange, "descriptionZh", event.target.value)} rows={3} value={draft.descriptionZh} />
          </label>
          <label className="wide">
            {t("apps.publish.descriptionEn")}
            <textarea onChange={(event) => updateAppPublishDraft(draft, onChange, "descriptionEn", event.target.value)} rows={3} value={draft.descriptionEn} />
          </label>
          <label className="wide">
            {t("apps.publish.changelog")}
            <textarea onChange={(event) => updateAppPublishDraft(draft, onChange, "changelog", event.target.value)} rows={2} value={draft.changelog} />
          </label>
          <SquareCoverImageField
            copy={{
              collapse: t("common.collapse"),
              empty: t("apps.publish.coverEmpty"),
              help: t("apps.publish.coverHelp"),
              invalidType: t("apps.publish.coverInvalidType"),
              manage: t("apps.publish.manageCover"),
              processing: t("apps.publish.coverProcessing"),
              readFailed: t("apps.publish.coverReadFailed"),
              replace: t("apps.publish.replaceCover"),
              required: t("apps.publish.required"),
              remove: t("common.remove"),
              tooLarge: t("apps.publish.coverTooLarge"),
              upload: t("apps.publish.uploadCover")
            }}
            label={t("apps.publish.coverImage")}
            onChange={(value) => updateAppPublishDraft(draft, onChange, "coverImageUrl", value)}
            value={draft.coverImageUrl}
          />
        </div>
      </section>

      <section className="assetDetailSection appReviewSection">
        <h3>{t("apps.publish.accessReviewTitle")}</h3>
        <div className="appReviewGrid">
          <label>
            {t("apps.publish.accessMode")}
            <input disabled value={`${appsVisibilityLabel(app.visibility, t)} / ${appsLoginLabel(app.loginRequired, t)}`} />
            <small>{t("apps.publish.accessInherited")}</small>
          </label>
          <label>
            {t("apps.config.workspaceAuth")}
            <input disabled value={app.loginRequired ? t("apps.publish.authUse") : t("apps.publish.authNotUse")} />
            <small>{t("apps.publish.accessInherited")}</small>
          </label>
          <label>
            {t("apps.publish.deploymentProvider")}
            <WorkspaceListbox<AppsAppPublishDraft["deploymentProvider"]>
              ariaLabel={t("apps.publish.deploymentProvider")}
              disabled
              noResultsLabel={t("common.noResults")}
              searchable="auto"
              searchPlaceholder={t("common.search")}
              value={draft.deploymentProvider}
              onChange={(value) => updateAppPublishDraft(draft, onChange, "deploymentProvider", value)}
              options={appDeploymentProviderOptions(t)}
            />
            <small>{t("apps.publish.deploymentProviderLocked")}</small>
          </label>
          {!usesWorkspaceAiCloud && (
            <>
              <label>
                {t("apps.publish.deploymentMethod")}
                <WorkspaceListbox<AppsAppPublishDraft["deploymentMethod"]>
                  ariaLabel={t("apps.publish.deploymentMethod")}
                  value={draft.deploymentMethod}
                  onChange={(value) => updateAppPublishDraft(draft, onChange, "deploymentMethod", value)}
                  options={appDeploymentMethodOptions(t)}
                />
              </label>
              <label>
                {t("apps.publish.dataRegion")}
                <WorkspaceListbox<AppsAppPublishDraft["dataRegion"]>
                  ariaLabel={t("apps.publish.dataRegion")}
                  value={draft.dataRegion}
                  onChange={(value) => updateAppPublishDraft(draft, onChange, "dataRegion", value)}
                  options={appDataRegionOptions(t)}
                />
              </label>
            </>
          )}
          <label>
            {t("apps.publish.modelProvider")}
            <input onChange={(event) => updateAppPublishDraft(draft, onChange, "modelProvider", event.target.value)} value={draft.modelProvider} />
          </label>
          <label>
            {t("apps.publish.riskLevel")}
            <WorkspaceListbox<AppsAppPublishDraft["riskLevel"]>
              ariaLabel={t("apps.publish.riskLevel")}
              value={draft.riskLevel}
              onChange={(value) => updateAppPublishDraft(draft, onChange, "riskLevel", value)}
              options={[
                { label: t("apps.publish.riskLow"), value: "low" },
                { label: t("apps.publish.riskMedium"), value: "medium" },
                { label: t("apps.publish.riskHigh"), value: "high" }
              ]}
            />
          </label>
          <div className="appReviewCheckboxGroup wide">
            <span>{t("apps.publish.sensitiveData")}</span>
            {sensitiveDataOptions.map((option) => (
              <label key={option.value}>
                <input checked={draft.sensitiveDataTypes.includes(option.value)} onChange={() => toggleAppSensitiveDraft(draft, onChange, option.value)} type="checkbox" />
                {appsSensitiveDataLabel(option.value, t)}
              </label>
            ))}
          </div>
          <label className="wide">
            {t("apps.publish.riskReason")}
            <textarea onChange={(event) => updateAppPublishDraft(draft, onChange, "riskReason", event.target.value)} rows={3} value={draft.riskReason} />
          </label>
          <label className="wide">
            {t("apps.publish.permissionNotes")}
            <textarea onChange={(event) => updateAppPublishDraft(draft, onChange, "permissionNotes", event.target.value)} rows={3} value={draft.permissionNotes} />
          </label>
          <label className="wide">
            {t("apps.publish.outputNotes")}
            <textarea onChange={(event) => updateAppPublishDraft(draft, onChange, "outputNotes", event.target.value)} rows={3} value={draft.outputNotes} />
          </label>
        </div>
      </section>

      <section className="assetDetailSection appReviewSection">
        <h3>{t("apps.publish.releaseReadinessTitle")}</h3>
        <div className="appReviewGrid">
          <label className="wide">
            {t("apps.publish.harnessReportUrl")}
            <input disabled value={draft.harnessReportUrl} />
            <small>{t("apps.publish.harnessReportHelp")}</small>
          </label>
          <div className="appReviewCheckboxGroup wide">
            <span>{t("apps.publish.harnessSelfCheck")}</span>
            <label>
              <input
                checked={draft.harnessSelfCheckConfirmed}
                onChange={(event) => updateAppPublishDraft(draft, onChange, "harnessSelfCheckConfirmed", event.target.checked)}
                type="checkbox"
              />
              {t("apps.publish.harnessSelfCheckLabel")}
            </label>
            <small>{t("apps.publish.harnessSelfCheckHelp")}</small>
          </div>
        </div>
      </section>
    </>
  );
}

export function AppsSkillPublishForm({
  draft,
  listing,
  mode,
  onChange,
  skill
}: {
  draft: AppsSkillPublishDraft;
  listing?: PublicationListing;
  mode: "view" | "edit";
  onChange: (draft: AppsSkillPublishDraft) => void;
  skill: AppsSkill;
}) {
  const { locale, t } = useI18n();
  const category = normalizeMarketCategoryName(draft.category, "research");
  const categoryOption = MARKET_CATEGORIES.find((item) => item.en === category);
  const categoryLabel = categoryOption ? marketCategoryOptionLabel(categoryOption, locale) : category;

  if (mode === "view") {
    return (
      <>
        <section className="assetDetailSection appReviewSection">
          <h3>{t("apps.publish.publishInfo")}</h3>
          <div className="assetDetailGrid appsPublishReadOnlyGrid">
            <PublishReadOnlyItem label={t("apps.publish.version")} value={draft.version} />
            <PublishReadOnlyItem label={t("apps.publish.name")} value={draft.name || skill.name} />
            <PublishReadOnlyItem label={t("apps.publish.category")} value={categoryLabel} wide />
            <PublishReadOnlyItem label={t("apps.publish.description")} value={draft.description || skill.description} wide />
            <PublishReadOnlyItem label={t("apps.publish.overviewMarkdown")} value={draft.overviewMarkdown} wide />
            <PublishCoverPreview emptyLabel={t("apps.publish.coverEmpty")} label={t("apps.publish.coverImage")} value={draft.coverImageUrl} />
            <PublishReadOnlyItem label={t("apps.publish.installNotes")} value={draft.installNotes} wide />
          </div>
        </section>

        <section className="assetDetailSection appReviewSection">
          <h3>{t("apps.publish.accessReviewTitle")}</h3>
          <div className="assetDetailGrid appsPublishReadOnlyGrid">
            <PublishReadOnlyItem label={t("apps.publish.reviewStatus")} value={appsMarketStatusLabel(listing?.status, t)} />
            <PublishReadOnlyItem label={t("apps.publish.riskLevel")} value={appsRiskLabel(draft.riskLevel, t)} />
            <PublishReadOnlyItem label={t("apps.publish.riskReason")} value={draft.riskReason} wide />
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <section className="assetDetailSection appReviewSection">
        <h3>{t("apps.publish.publishInfo")}</h3>
        <div className="appReviewGrid">
          <label>
            {t("apps.publish.name")}
            <input onChange={(event) => updateSkillPublishDraft(draft, onChange, "name", event.target.value)} value={draft.name} />
          </label>
          <label>
            {t("apps.publish.version")}
            <input onChange={(event) => updateSkillPublishDraft(draft, onChange, "version", event.target.value)} value={draft.version} />
          </label>
          <label>
            {t("apps.publish.category")}
            <WorkspaceListbox
              ariaLabel={t("apps.publish.category")}
              noResultsLabel={t("common.noResults")}
              searchable
              searchPlaceholder={t("common.search")}
              value={normalizeMarketCategoryName(draft.category, "research")}
              onChange={(value) => updateSkillPublishDraft(draft, onChange, "category", value)}
              options={MARKET_CATEGORIES.map((category) => ({
                label: marketCategoryOptionLabel(category, locale),
                searchText: `${category.key} ${category.en} ${category.zh}`,
                value: category.en
              }))}
            />
          </label>
          <label>
            {t("apps.publish.riskLevel")}
            <WorkspaceListbox<AppsSkillPublishDraft["riskLevel"]>
              ariaLabel={t("apps.publish.riskLevel")}
              value={draft.riskLevel}
              onChange={(value) => updateSkillPublishDraft(draft, onChange, "riskLevel", value)}
              options={[
                { label: t("apps.publish.riskLow"), value: "low" },
                { label: t("apps.publish.riskMedium"), value: "medium" },
                { label: t("apps.publish.riskHigh"), value: "high" }
              ]}
            />
          </label>
          <label className="wide">
            {t("apps.publish.description")}
            <textarea onChange={(event) => updateSkillPublishDraft(draft, onChange, "description", event.target.value)} rows={3} value={draft.description} />
          </label>
          <label className="wide">
            {t("apps.publish.overviewMarkdown")}
            <textarea onChange={(event) => updateSkillPublishDraft(draft, onChange, "overviewMarkdown", event.target.value)} rows={5} value={draft.overviewMarkdown} />
          </label>
          <SquareCoverImageField
            copy={{
              collapse: t("common.collapse"),
              empty: t("apps.publish.coverEmpty"),
              help: t("apps.publish.coverHelp"),
              invalidType: t("apps.publish.coverInvalidType"),
              manage: t("apps.publish.manageCover"),
              processing: t("apps.publish.coverProcessing"),
              readFailed: t("apps.publish.coverReadFailed"),
              replace: t("apps.publish.replaceCover"),
              required: t("apps.publish.required"),
              remove: t("common.remove"),
              tooLarge: t("apps.publish.coverTooLarge"),
              upload: t("apps.publish.uploadCover")
            }}
            label={t("apps.publish.coverImage")}
            onChange={(value) => updateSkillPublishDraft(draft, onChange, "coverImageUrl", value)}
            required={false}
            value={draft.coverImageUrl}
          />
          <label className="wide">
            {t("apps.publish.installNotes")}
            <textarea onChange={(event) => updateSkillPublishDraft(draft, onChange, "installNotes", event.target.value)} rows={3} value={draft.installNotes} />
          </label>
          <label className="wide">
            {t("apps.publish.riskReason")}
            <textarea onChange={(event) => updateSkillPublishDraft(draft, onChange, "riskReason", event.target.value)} rows={3} value={draft.riskReason} />
          </label>
        </div>
      </section>
    </>
  );
}

function updateAppPublishDraft<K extends keyof AppsAppPublishDraft>(
  draft: AppsAppPublishDraft,
  onChange: (draft: AppsAppPublishDraft) => void,
  key: K,
  value: AppsAppPublishDraft[K]
) {
  onChange({ ...draft, [key]: value });
}

function updateSkillPublishDraft<K extends keyof AppsSkillPublishDraft>(
  draft: AppsSkillPublishDraft,
  onChange: (draft: AppsSkillPublishDraft) => void,
  key: K,
  value: AppsSkillPublishDraft[K]
) {
  onChange({ ...draft, [key]: value });
}

function toggleAppSensitiveDraft(draft: AppsAppPublishDraft, onChange: (draft: AppsAppPublishDraft) => void, value: AppSensitiveDataType) {
  const exists = draft.sensitiveDataTypes.includes(value);
  const sensitiveDataTypes = exists
    ? draft.sensitiveDataTypes.filter((item) => item !== value)
    : [...draft.sensitiveDataTypes, value];

  onChange({ ...draft, sensitiveDataTypes });
}

function PublishReadOnlyItem({
  children,
  label,
  value,
  wide = false
}: {
  children?: ReactNode;
  label: string;
  value?: string;
  wide?: boolean;
}) {
  return (
    <div className={`assetDetailItem${wide ? " wide" : ""}`}>
      <span>{label}</span>
      {children ?? <strong>{value?.trim() || "-"}</strong>}
    </div>
  );
}

function PublishCoverPreview({ emptyLabel, label, value }: { emptyLabel: string; label: string; value: string }) {
  return (
    <PublishReadOnlyItem label={label} wide>
      {value.trim() ? <img alt="" className="appsPublishCoverPreview" height={96} src={value} width={96} /> : <strong>{emptyLabel}</strong>}
    </PublishReadOnlyItem>
  );
}

type PublishTranslator = ReturnType<typeof useI18n>["t"];

function appDeploymentProviderOptions(t: PublishTranslator): Array<{ label: string; value: AppsAppPublishDraft["deploymentProvider"] }> {
  return [
    { label: t("apps.publish.providerWorkspaceAiCloud"), value: WORKSPACE_AI_CLOUD_PROVIDER },
    { label: t("apps.publish.providerCloudflare"), value: "cloudflare" },
    { label: t("apps.publish.providerAws"), value: "aws" },
    { label: t("apps.publish.providerVercel"), value: "vercel" },
    { label: t("apps.publish.tencentCloud"), value: "tencent_cloud" },
    { label: t("apps.publish.aliyun"), value: "aliyun" },
    { label: t("apps.publish.providerReplit"), value: "replit" },
    { label: t("apps.publish.other"), value: "other" }
  ];
}

function appDeploymentMethodOptions(t: PublishTranslator): Array<{ label: string; value: AppsAppPublishDraft["deploymentMethod"] }> {
  return [
    { label: t("apps.publish.methodServerless"), value: "serverless" },
    { label: t("apps.publish.methodDocker"), value: "docker" },
    { label: t("apps.publish.methodVps"), value: "vps" }
  ];
}

function appDataRegionOptions(t: PublishTranslator): Array<{ label: string; value: AppsAppPublishDraft["dataRegion"] }> {
  return [
    { label: t("apps.publish.regionHongKong"), value: "hong_kong" },
    { label: t("apps.publish.regionMainland"), value: "mainland_china" },
    { label: t("apps.publish.regionSingapore"), value: "singapore" },
    { label: t("apps.publish.regionNorthAmerica"), value: "north_america" },
    { label: t("apps.publish.other"), value: "other" }
  ];
}
