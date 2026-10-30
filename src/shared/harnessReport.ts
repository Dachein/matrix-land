export const WORKSPACE_HARNESS_REPORT_PATH = "/harness/report.html";
export const WORKSPACE_RELEASE_READINESS_REPORT_NAME = "Workspace Release Readiness Report";
export const WORKSPACE_RELEASE_READINESS_REPORT_NAME_ZH = "Workspace 发布就绪评估报告";
export const WORKSPACE_RELEASE_READINESS_REPORT_SCHEMA = "workspace.release-readiness-report/v1";

export function workspaceHarnessReportUrl(productionUrl: unknown) {
  const value = typeof productionUrl === "string" ? productionUrl.trim() : "";
  if (!value) return "";

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || !hostname.includes(".")) {
      return "";
    }

    url.pathname = WORKSPACE_HARNESS_REPORT_PATH;
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function isWorkspaceHarnessReportUrl(reportUrl: unknown, productionUrl: unknown) {
  const report = typeof reportUrl === "string" ? reportUrl.trim() : "";
  const expected = workspaceHarnessReportUrl(productionUrl);
  return Boolean(expected) && report === expected;
}

export function isReleaseReadinessReportRequired(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  return normalized === true || normalized === "1" || normalized === "true" || normalized === "on" || normalized === "enabled" || normalized === "required";
}
