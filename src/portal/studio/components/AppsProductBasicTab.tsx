import type { FormEvent } from "react";
import { ExternalLink } from "lucide-react";
import type { AppsProvisionedResourceType } from "../../../shared/appsResourceCatalog";
import type { AppsApp, AppsSkill, PublicationListing } from "../../../shared/types";
import { useI18n } from "../../i18n";
import { ButtonLink } from "../../components/Button";
import { AppsDevelopmentResources } from "./AppsDevelopmentResources";
import { AppsMailDevelopmentGuide } from "./AppsMailDevelopmentGuide";
import { AppsAppInfoEditor, AppsDetailSection, AppsProductProgressRail, AppsSkillInfoEditor } from "./AppsDetailPanels";
import { appsDevelopmentResourceItems, appsProductBasicInfoRows, appsSkillProjectStructureModel } from "../productDetailModels";
import type { AppsAppInfoInput, AppsProductItem, AppsProductProgressStep, AppsSkillInfoInput } from "../types";

export function AppsProductBasicTab({
  app,
  appInfoInput,
  canEditSkillInfo,
  infoFormId,
  isEditingInfo,
  isSavingInfo,
  listing,
  onInfoChange,
  onResourceToggle,
  onSaveInfo,
  onSaveSkillInfo,
  onSkillInfoChange,
  product,
  productionUrl,
  progressSteps,
  resourceTypes,
  skill,
  skillInfoInput
}: {
  app?: AppsApp;
  appInfoInput: AppsAppInfoInput;
  canEditSkillInfo: boolean;
  infoFormId: string;
  isEditingInfo: boolean;
  isSavingInfo: boolean;
  listing?: PublicationListing;
  onInfoChange: (input: AppsAppInfoInput) => void;
  onResourceToggle?: (resourceType: AppsProvisionedResourceType) => void;
  onSaveInfo: (event: FormEvent<HTMLFormElement>) => void;
  onSaveSkillInfo: (event: FormEvent<HTMLFormElement>) => void;
  onSkillInfoChange: (input: AppsSkillInfoInput) => void;
  product: AppsProductItem;
  productionUrl?: string;
  progressSteps: AppsProductProgressStep[];
  resourceTypes?: AppsProvisionedResourceType[];
  skill?: AppsSkill;
  skillInfoInput: AppsSkillInfoInput;
}) {
  const { t } = useI18n();
  const resourceItems = skill ? [] : appsDevelopmentResourceItems(app, listing, t);
  const skillStructure = skill ? appsSkillProjectStructureModel(skill, t) : undefined;

  return (
    <>
      <section className="assetDetailSection appsBasicProgressSection">
        <h3>{t("apps.detail.statusTitle")}</h3>
        <AppsProductProgressRail layout="horizontal" steps={progressSteps} />
      </section>
      {app && isEditingInfo && (
        <AppsAppInfoEditor
          formId={infoFormId}
          input={appInfoInput}
          isSaving={isSavingInfo}
          onChange={onInfoChange}
          onSubmit={onSaveInfo}
        />
      )}
      {skill && isEditingInfo && canEditSkillInfo && (
        <AppsSkillInfoEditor
          formId={infoFormId}
          input={skillInfoInput}
          isSaving={isSavingInfo}
          onChange={onSkillInfoChange}
          onSubmit={onSaveSkillInfo}
        />
      )}
      {!isEditingInfo && (
        <AppsDetailSection
          renderRowAction={(row) => row.href && row.href === productionUrl ? (
            <ButtonLink href={row.href} iconBefore={<ExternalLink size={15} />} rel="noreferrer" size="compact" target="_blank" variant="secondary">
              {t("apps.detail.visitProduction")}
            </ButtonLink>
          ) : null}
          rows={appsProductBasicInfoRows(product, listing, t)}
          title={t("apps.detail.basicInfoTitle")}
          variant="basic"
        />
      )}
      <AppsDevelopmentResources
        app={app}
        items={resourceItems}
        isEditing={Boolean(app && isEditingInfo)}
        onResourceToggle={onResourceToggle}
        productType={product.type}
        resourceTypes={resourceTypes}
        skillStructure={skillStructure}
      />
      {app && !isEditingInfo && <AppsMailDevelopmentGuide app={app} />}
    </>
  );
}
