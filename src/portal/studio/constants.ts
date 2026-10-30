import type { AppSensitiveDataType, AppsAppType, AppsVisibility } from "../../shared/types";
import { APPS_FIXED_RESOURCE_TYPES_BY_APP_TYPE } from "../../shared/appsResourceCatalog";
import type { CreateInput, AppsAccessMode } from "./types";

export const appTypeCatalog: Array<{ detail: string; label: string; value: AppsAppType }> = [
  { value: "static_page", label: "Static page", detail: "Frontend-only pages that start with Pages" },
  { value: "web", label: "Web app", detail: "Full apps that start with Worker and D1" },
  { value: "agent_app", label: "Agent app", detail: "Agent tools that start with Worker, D1, and MCP" },
  { value: "automation", label: "Automation", detail: "Scheduled work that starts with Worker and Cron" },
  { value: "container", label: "Advanced", detail: "Start with Worker and choose the initial resources" }
];

export const appTypeOptions = appTypeCatalog;

export const appsAccessTemplates: Array<{
  detail: string;
  label: string;
  requiresTargets?: boolean;
  value: AppsAccessMode;
  visibility: AppsVisibility;
}> = [
  { value: "public", label: "Public", detail: "Anyone with the link can view the page.", visibility: "public" },
  { value: "company", label: "Company-wide", detail: "Default option, visible inside the company space.", visibility: "org" },
  { value: "targeted", label: "Targeted", detail: "Shown only to selected departments or people.", visibility: "team", requiresTargets: true },
  { value: "private", label: "Private app", detail: "Visible only on your My APPS page.", visibility: "private" }
];

export const appsBooleanSelectOptions = [
  { label: "NO", value: "no" },
  { label: "YES", value: "yes" }
] as const;

export const initialCreateInput: CreateInput = {
  accessMode: "private",
  accessTargets: [],
  agentMcpEnabled: false,
  appCode: "",
  description: "",
  loginRequired: true,
  llmEnabled: false,
  name: "",
  resourceTypes: APPS_FIXED_RESOURCE_TYPES_BY_APP_TYPE.web,
  type: "web"
};

export const appsScopes = [
  "apps:apps:read",
  "apps:apps:write",
  "apps:deploy:production",
  "apps:apps:admin",
  "apps:skills:read",
  "apps:skills:write",
  "apps:skills:admin",
  "apps:mates:read",
  "apps:mates:write",
  "apps:mates:admin",
  "apps:secrets:write"
];

export const sensitiveDataOptions: Array<{ label: string; value: AppSensitiveDataType }> = [
  { label: "Customer information", value: "customer_information" },
  { label: "Transaction records", value: "transaction_records" },
  { label: "Employee information", value: "employee_information" },
  { label: "Financial information", value: "financial_information" },
  { label: "Internal materials", value: "internal_materials" },
  { label: "Public information only", value: "public_information" }
];
