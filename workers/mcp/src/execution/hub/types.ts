export type HubSubmissionTargetType = "app" | "skill";

export type AppsHubSubmissionSource = {
  artifactUrl?: string;
  builderSnapshot: Record<string, unknown>;
  defaultCategory: string;
  defaultDescription: string;
  defaultName: string;
  defaultSummary: string;
  defaultTags: string[];
  defaultVisibility: "org" | "team" | "private";
  verification: Record<string, unknown>;
  version?: string;
  versionId?: string;
};
