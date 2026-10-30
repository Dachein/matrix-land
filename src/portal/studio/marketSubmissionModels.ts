import type { AppsApp, AppsSkill } from "../../shared/types";
import { normalizeMarketCategoryName } from "../../shared/marketCategories";
import {
  WORKSPACE_RELEASE_READINESS_REPORT_NAME,
  WORKSPACE_RELEASE_READINESS_REPORT_SCHEMA,
  workspaceHarnessReportUrl
} from "../../shared/harnessReport";
import type { AppsAppPublishDraft, AppsSkillPublishDraft } from "./types";
import { parseCommaList } from "./utils";

export type AppsMarketSubmission = {
  body: Record<string, unknown>;
  submitId: string;
};

export function buildAppsAppMarketSubmission(app: AppsApp, draft: AppsAppPublishDraft): AppsMarketSubmission {
  const tags = parseCommaList(draft.tags);
  const coverImageUrl = draft.coverImageUrl.trim();
  const category = normalizeMarketCategoryName(draft.category, "workflow");
  const accessMode = appsAppReviewAccessMode(app);
  const accessTargets: string[] = [];
  const harnessReportUrl = workspaceHarnessReportUrl(app.productionUrl);
  const reviewDraft = {
    accessMode,
    accessTargets,
    appType: app.type === "agent_app" ? "agent_chat" : "web",
    category,
    changelog: draft.changelog,
    coverImageUrl,
    dataRegion: draft.dataRegion,
    deploymentMethod: draft.deploymentMethod,
    deploymentProvider: draft.deploymentProvider,
    deploymentType: "serverless",
    description: draft.descriptionZh || draft.descriptionEn || app.description,
    descriptionEn: draft.descriptionEn,
    descriptionZh: draft.descriptionZh,
    harnessReportUrl,
    harnessSelfCheckConfirmed: draft.harnessSelfCheckConfirmed,
    loginRequired: app.loginRequired,
    launchUrl: app.productionUrl,
    model: draft.modelProvider,
    modelProvider: draft.modelProvider,
    nameEn: draft.nameEn,
    nameZh: draft.nameZh,
    outputNotes: draft.outputNotes,
    pageVisibility: app.visibility,
    permissionNotes: draft.permissionNotes,
    riskLevel: draft.riskLevel,
    riskReason: draft.riskReason,
    sensitiveDataTypes: draft.sensitiveDataTypes,
    subtitle: draft.subtitle,
    tags,
    usesWorkspaceAuth: app.loginRequired,
    version: draft.version
  };

  return {
    submitId: `app:${app.id}`,
    body: {
      targetType: "app",
      targetPlane: "apps",
      targetId: app.id,
      version: draft.version,
      versionId: app.lastDeployedAt ?? app.updatedAt,
      name: draft.nameZh || draft.nameEn || app.name,
      summary: draft.subtitle || app.description,
      description: draft.descriptionZh || draft.descriptionEn || app.description,
      category,
      tags: tags.length > 0 ? tags : ["apps", "app", app.type],
      coverImageUrl,
      riskLevel: draft.riskLevel,
      harnessReportUrl,
      harnessSelfCheckConfirmed: draft.harnessSelfCheckConfirmed,
      visibility: appsAppPublicationVisibility(app),
      config: {
        appId: app.id,
        reviewDraft,
        productionUrl: app.productionUrl,
        dataServiceId: app.dataServiceId,
        releaseReadiness: {
          reportName: WORKSPACE_RELEASE_READINESS_REPORT_NAME,
          reportUrl: harnessReportUrl,
          schemaVersion: WORKSPACE_RELEASE_READINESS_REPORT_SCHEMA,
          selfCheckConfirmed: draft.harnessSelfCheckConfirmed
        }
      },
      builderSnapshot: {
        ...app.manifest,
        reviewDraft
      }
    }
  };
}

export function buildAppsSkillMarketSubmission(skill: AppsSkill, draft: AppsSkillPublishDraft, options: { apiBase: string }): AppsMarketSubmission {
  const version = draft.version || skill.currentVersion || skill.versions[0]?.version || "1.0.0";
  const coverImageUrl = draft.coverImageUrl.trim();
  const category = normalizeMarketCategoryName(draft.category, "research");
  const description = draft.description || skill.description;
  const overviewMarkdown = draft.overviewMarkdown.trim() || buildSkillOverviewMarkdown(draft.name || skill.name, description, draft.installNotes);
  const encodedSkillId = encodeURIComponent(skill.id);
  const encodedVersion = encodeURIComponent(version);
  const reviewDraft = {
    category,
    coverImageUrl,
    description,
    installNotes: draft.installNotes,
    name: draft.name,
    overviewMarkdown,
    riskLevel: draft.riskLevel,
    riskReason: draft.riskReason,
    version
  };

  return {
    submitId: `skill:${skill.id}`,
    body: {
      targetType: "skill",
      targetPlane: "apps",
      targetId: skill.id,
      version,
      versionId: skill.currentVersionId ?? version,
      name: draft.name || skill.name,
      summary: description,
      description,
      overviewMarkdown,
      category,
      coverImageUrl,
      riskLevel: draft.riskLevel,
      artifactType: "package",
      artifactUrl: `${options.apiBase}/skills/${encodedSkillId}/versions/${encodedVersion}/download.zip`,
      config: {
        reviewDraft,
        skillId: skill.id,
        slug: skill.slug,
        overviewMarkdown,
        installPromptUrl: `${options.apiBase}/skills/${encodedSkillId}/versions/${encodedVersion}/install-prompt`
      },
      builderSnapshot: {
        kind: skill.kind,
        capabilities: skill.capabilities,
        reviewDraft,
        versions: skill.versions
      }
    }
  };
}

function appsAppReviewAccessMode(app: AppsApp): AppsAppPublishDraft["accessMode"] {
  return app.visibility === "team" || app.visibility === "private" ? "targeted" : "public";
}

function appsAppPublicationVisibility(app: AppsApp): "company" | "team" | "private" {
  if (app.visibility === "private") {
    return "private";
  }

  if (app.visibility === "team") {
    return "team";
  }

  return "company";
}

function buildSkillOverviewMarkdown(name: string, description: string, installNotes: string) {
  return [
    `# ${name}`,
    "",
    description,
    installNotes.trim() ? "" : undefined,
    installNotes.trim() ? "## Install and usage" : undefined,
    installNotes.trim() ? "" : undefined,
    installNotes.trim() || undefined
  ].filter(Boolean).join("\n");
}
