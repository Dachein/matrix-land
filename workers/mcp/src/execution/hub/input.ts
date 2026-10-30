import { readString } from "../../http.ts";
import type { HubSubmissionTargetType } from "./types.ts";

export function normalizeHubRiskLevel(value: unknown): "low" | "medium" | "high" {
  const riskLevel = readString(value);
  return riskLevel === "high" || riskLevel === "medium" ? riskLevel : "low";
}

export function normalizeHubVisibility(value: unknown): "org" | "team" | "private" {
  const visibility = readString(value);
  return visibility === "team" || visibility === "private" ? visibility : "org";
}

export function normalizeHubArtifactType(value: unknown, targetType: HubSubmissionTargetType): "skill_md" | "app_config" | "document" | "package" {
  const artifactType = readString(value);
  if (artifactType === "skill_md" || artifactType === "app_config" || artifactType === "document" || artifactType === "package") {
    return artifactType;
  }
  return targetType === "app" ? "app_config" : "package";
}

export function hubVisibilityFromAppsVisibility(value: unknown): "org" | "team" | "private" {
  const visibility = readString(value);
  if (visibility === "private") {
    return "private";
  }
  if (visibility === "team") {
    return "team";
  }
  return "org";
}
