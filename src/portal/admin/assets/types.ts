import type { AppSensitiveDataType, AssetLifecycleStatus, PublicationListing, PortalApp } from "../../../shared/types";

export type Translate = (key: string, values?: Record<string, string | number>, fallback?: string) => string;

export type ManagedAssetType = "app" | "skill" | "mcp";
export type AssetRiskLevel = "low" | "medium" | "high";

export type AssetDetailRow = {
  download?: boolean | string;
  href?: string;
  label: string;
  value: string;
  wide?: boolean;
};

export type ManagedAsset = {
  id: string;
  type: ManagedAssetType;
  app?: PortalApp;
  listing?: PublicationListing;
  coverImageUrl?: string;
  marketCategory?: string;
  name: string;
  owner: string;
  category: string;
  description: string;
  status: AssetLifecycleStatus;
  risk: AssetRiskLevel;
  primaryMetric: string;
  secondaryMetric: string;
  metaRows: AssetDetailRow[];
  securityRows: AssetDetailRow[];
  reviewNotes?: string;
  updatedAt?: string;
};

export type AppReviewDraft = {
  appType: PortalApp["appType"];
  category: string;
  nameZh: string;
  nameEn: string;
  subtitle: string;
  descriptionZh: string;
  descriptionEn: string;
  description: string;
  launchUrl: string;
  callbackUrl: string;
  coverImageUrl: string;
  screenshots: string[];
  version: string;
  changelog: string;
  pageVisibility?: string;
  loginRequired?: boolean;
  accessMode: PortalApp["accessMode"];
  accessTargets: string[];
  usesWorkspaceAuth: boolean;
  deploymentType: PortalApp["deploymentType"];
  deploymentProvider: PortalApp["deploymentProvider"];
  deploymentMethod: PortalApp["deploymentMethod"];
  dataRegion: PortalApp["dataRegion"];
  model: string;
  modelProvider: string;
  dataTypes: string[];
  sensitiveDataTypes: AppSensitiveDataType[];
  knowledgeSources: string[];
  riskReason: string;
  permissionNotes: string;
  outputNotes: string;
};
